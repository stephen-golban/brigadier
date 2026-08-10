import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  CommitResult,
  CommitSpec,
  CreatedWorktree,
  MergeResult,
  MergeSpec,
  WorktreeEngine,
  WorktreeEngineOptions,
  WorktreeSession,
  WorktreeSessionSpec,
  WorktreeSpec,
} from "./contracts.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const REDACTION_MARKER = "[REDACTED]";
const LFS_UNSUPPORTED_MESSAGE =
  "Git LFS is unsupported: remove filter=lfs attributes and unset filter.lfs.clean before using Brigadier";

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface GitOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string | Buffer;
  readonly allowedExitCodes?: readonly number[];
  readonly redactionValues?: readonly string[];
}

interface SessionState {
  readonly session: WorktreeSession;
  readonly dependencyPaths: readonly string[];
  readonly linkedSecretPaths: readonly string[];
  readonly consentToLinkSecrets: boolean;
  readonly explicitRedactionValues: readonly string[];
  redactionValues: readonly string[];
  readonly sliceHeads: Map<string, string>;
  readonly activeWorktrees: Set<CreatedWorktree>;
  integrationMaterialized: boolean;
  refsReleased: boolean;
}

interface WorktreeState {
  readonly sessionState: SessionState;
}

export class LinkedSecretCommitError extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super(`refusing to commit linked secret path(s): ${paths.join(", ")}`);
    this.name = "LinkedSecretCommitError";
    this.paths = paths;
  }
}

export class NoChangesToCommitError extends Error {
  constructor() {
    super("refusing to create an empty slice commit");
    this.name = "NoChangesToCommitError";
  }
}

class GitCommandError extends Error {
  constructor(
    args: readonly string[],
    result: GitResult,
    values: readonly string[],
  ) {
    const stderr = redactText(result.stderr.toString("utf8").trim(), values);
    const stdout = redactText(result.stdout.toString("utf8").trim(), values);
    const detail = stderr || stdout || "no diagnostic output";
    super(`git ${args[0] ?? "command"} failed (${result.exitCode}): ${detail}`);
    this.name = "GitCommandError";
  }
}

/** Git CLI implementation with bounded processes and no runtime dependencies. */
export class GitWorktreeEngine implements WorktreeEngine {
  readonly #commandTimeoutMs: number;
  readonly #sessions = new WeakMap<WorktreeSession, SessionState>();
  readonly #worktrees = new WeakMap<CreatedWorktree, WorktreeState>();

  constructor(options: WorktreeEngineOptions = {}) {
    const timeout = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new RangeError("commandTimeoutMs must be a positive whole number");
    }
    this.#commandTimeoutMs = timeout;
  }

  async prepare(spec: WorktreeSessionSpec): Promise<WorktreeSession> {
    validateSlug(spec.slug);
    const requestedRepository = await realpath(resolve(spec.repositoryPath));
    const repositoryResult = await this.#git(["rev-parse", "--show-toplevel"], {
      cwd: requestedRepository,
    });
    const repositoryPath = await realpath(
      repositoryResult.stdout.toString("utf8").trim(),
    );
    if (repositoryPath !== requestedRepository) {
      throw new Error("repositoryPath must name the Git worktree root");
    }

    const dependencyPaths = normalizeUniquePaths(
      spec.dependencyPaths ?? [],
      "dependency",
    );
    const linkedSecretPaths = normalizeUniquePaths(
      spec.secrets.linkedPaths,
      "linked secret",
    );
    const overlap = await findOverlappingPaths(
      repositoryPath,
      dependencyPaths,
      linkedSecretPaths,
    );
    if (overlap.length > 0) {
      throw new Error(
        `paths cannot be both dependencies and linked secrets: ${overlap.join(", ")}`,
      );
    }

    const explicitRedactionValues = Object.freeze(
      [...(spec.secrets.redactionValues ?? [])].filter(
        (value) => value.length > 0,
      ),
    );
    const redactionValues = await collectRedactionValues(
      repositoryPath,
      linkedSecretPaths,
      explicitRedactionValues,
    );
    const baseRef = spec.baseRef ?? "HEAD";
    const head = await this.#revParse(
      repositoryPath,
      `${baseRef}^{commit}`,
      redactionValues,
    );
    const baseBranch = `brigadier/${spec.slug}/base`;
    const integrationBranch = `brigadier/${spec.slug}`;
    await this.#assertBranchDoesNotExist(
      repositoryPath,
      baseBranch,
      redactionValues,
    );
    await this.#assertBranchDoesNotExist(
      repositoryPath,
      integrationBranch,
      redactionValues,
    );
    const namespaceRefs = await this.#git(
      [
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${integrationBranch}/`,
      ],
      { cwd: repositoryPath, redactionValues },
    );
    if (namespaceRefs.stdout.length > 0) {
      throw new Error(
        `refusing to reuse existing branch namespace ${integrationBranch}`,
      );
    }

    const tree = await this.#stageSanitizedTree(
      repositoryPath,
      head,
      redactionValues,
      linkedSecretPaths,
    );

    const message = redactText(
      `brigadier: capture ${spec.slug} base`,
      redactionValues,
    );
    const baseCommit = await this.#commitTree(
      repositoryPath,
      tree,
      [head],
      message,
      redactionValues,
    );
    const zeroObjectId = "0".repeat(baseCommit.length);
    await this.#git(
      ["update-ref", `refs/heads/${baseBranch}`, baseCommit, zeroObjectId],
      { cwd: repositoryPath, redactionValues },
    );

    const session = Object.freeze({
      repositoryPath,
      slug: spec.slug,
      baseCommit,
      baseBranch,
      integrationBranch,
    }) satisfies WorktreeSession;
    this.#sessions.set(session, {
      session,
      dependencyPaths,
      linkedSecretPaths,
      consentToLinkSecrets: spec.secrets.consentToLink === true,
      explicitRedactionValues,
      redactionValues,
      sliceHeads: new Map(),
      activeWorktrees: new Set(),
      integrationMaterialized: false,
      refsReleased: false,
    });
    return session;
  }

  async create(spec: WorktreeSpec): Promise<CreatedWorktree> {
    const sessionState = this.#sessionState(spec.session);
    if (sessionState.refsReleased) {
      throw new Error("worktree session refs have already been released");
    }
    if (!Number.isSafeInteger(spec.slice) || spec.slice <= 0) {
      throw new RangeError("slice must be a positive whole number");
    }
    await this.#refreshRedactionValues(sessionState);
    const unsafeInPlace = spec.unsafeInPlace === true;
    const worktreePath = unsafeInPlace
      ? spec.session.repositoryPath
      : resolveRequiredWorktreePath(spec.path, spec.session.repositoryPath);
    if (!unsafeInPlace) {
      await assertAvailableWorktreePath(
        worktreePath,
        sessionState.redactionValues,
      );
    }

    const branch = `brigadier/${spec.session.slug}/slice-${spec.slice}`;
    const branchRef = `refs/heads/${branch}`;
    await this.#assertBranchDoesNotExist(
      spec.session.repositoryPath,
      branch,
      sessionState.redactionValues,
    );
    const zeroObjectId = "0".repeat(spec.session.baseCommit.length);
    await this.#git(
      ["update-ref", branchRef, spec.session.baseCommit, zeroObjectId],
      {
        cwd: spec.session.repositoryPath,
        redactionValues: sessionState.redactionValues,
      },
    );

    try {
      if (!unsafeInPlace) {
        await this.#git(["worktree", "add", "--quiet", worktreePath, branch], {
          cwd: spec.session.repositoryPath,
          redactionValues: sessionState.redactionValues,
        });
        await this.#seedWorktree(sessionState, worktreePath);
      }
    } catch (error) {
      try {
        if (!unsafeInPlace) {
          await this.#discardWorktree(
            spec.session.repositoryPath,
            worktreePath,
            sessionState,
          );
        }
      } finally {
        await this.#git(["update-ref", "-d", branchRef], {
          cwd: spec.session.repositoryPath,
          redactionValues: sessionState.redactionValues,
          allowedExitCodes: [0, 1],
        });
      }
      throw error;
    }

    const worktree = Object.freeze({
      repositoryPath: spec.session.repositoryPath,
      path: worktreePath,
      branch,
      isolated: !unsafeInPlace,
      session: spec.session,
    }) satisfies CreatedWorktree;
    this.#worktrees.set(worktree, { sessionState });
    sessionState.sliceHeads.set(branch, spec.session.baseCommit);
    sessionState.activeWorktrees.add(worktree);
    return worktree;
  }

  async commit(spec: CommitSpec): Promise<CommitResult> {
    const state = this.#worktreeState(spec.worktree);
    await this.#refreshRedactionValues(state.sessionState);
    const { redactionValues, linkedSecretPaths } = state.sessionState;
    if (state.sessionState.integrationMaterialized) {
      throw new Error("slice commits are closed after integration begins");
    }
    const branchRef = `refs/heads/${spec.worktree.branch}`;
    const parent = await this.#revParse(
      spec.worktree.repositoryPath,
      branchRef,
      redactionValues,
    );

    if (spec.worktree.isolated) {
      const checkedOutRef = await this.#git(
        ["symbolic-ref", "--quiet", "HEAD"],
        {
          cwd: spec.worktree.path,
          redactionValues,
          allowedExitCodes: [0, 1],
        },
      );
      if (
        checkedOutRef.exitCode !== 0 ||
        checkedOutRef.stdout.toString("utf8").trim() !== branchRef
      ) {
        throw new Error(
          `refusing to commit outside engine-created branch ${spec.worktree.branch}`,
        );
      }
      const stagedPaths = await this.#changedPaths(
        spec.worktree.path,
        parent,
        undefined,
        redactionValues,
      );
      this.#refuseLinkedSecrets(stagedPaths, linkedSecretPaths);
    }

    const result = await (async () => {
      const tree = await this.#stageSanitizedTree(
        spec.worktree.path,
        parent,
        redactionValues,
        linkedSecretPaths,
      );
      const parentTree = await this.#revParse(
        spec.worktree.repositoryPath,
        `${parent}^{tree}`,
        redactionValues,
      );
      if (tree === parentTree) {
        throw new NoChangesToCommitError();
      }
      const message = redactText(spec.message, redactionValues);
      const commit = await this.#commitTree(
        spec.worktree.repositoryPath,
        tree,
        [parent],
        message,
        redactionValues,
      );
      await this.#git(["update-ref", branchRef, commit, parent], {
        cwd: spec.worktree.repositoryPath,
        redactionValues,
      });
      state.sessionState.sliceHeads.set(spec.worktree.branch, commit);
      return { commit, message };
    })();

    if (spec.worktree.isolated) {
      await this.#git(["reset", "--mixed", "--quiet", result.commit], {
        cwd: spec.worktree.path,
        redactionValues,
      });
    }
    return result;
  }

  async merge(spec: MergeSpec): Promise<MergeResult> {
    const state = this.#worktreeState(spec.worktree);
    await this.#refreshRedactionValues(state.sessionState);
    const { session, redactionValues } = state.sessionState;
    const repositoryPath = session.repositoryPath;
    const integrationRef = `refs/heads/${session.integrationBranch}`;
    const integrationHead = await this.#materializeIntegrationBranch(
      state.sessionState,
    );
    const sliceHead = state.sessionState.sliceHeads.get(spec.worktree.branch);
    if (sliceHead === undefined) {
      throw new Error(`missing recorded head for ${spec.worktree.branch}`);
    }
    const ancestor = await this.#git(
      ["merge-base", "--is-ancestor", sliceHead, integrationHead],
      { cwd: repositoryPath, redactionValues, allowedExitCodes: [0, 1] },
    );
    if (ancestor.exitCode === 0) {
      return {
        status: "already-integrated",
        commit: integrationHead,
        integrationBranch: session.integrationBranch,
      };
    }

    const merge = await this.#git(
      ["merge-tree", "--write-tree", integrationHead, sliceHead],
      { cwd: repositoryPath, redactionValues, allowedExitCodes: [0, 1] },
    );
    if (merge.exitCode === 1) {
      const details = redactText(
        `${merge.stdout.toString("utf8")}\n${merge.stderr.toString("utf8")}`.trim(),
        redactionValues,
      );
      return {
        status: "conflicted",
        integrationBranch: session.integrationBranch,
        details,
      };
    }

    const tree = merge.stdout.toString("utf8").split("\n", 1)[0]?.trim() ?? "";
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new Error("git merge-tree did not return a valid tree object id");
    }
    const message = redactText(
      spec.message ??
        `brigadier: merge slice-${spec.worktree.branch.split("slice-").at(-1)}`,
      redactionValues,
    );
    const commit = await this.#commitTree(
      repositoryPath,
      tree,
      [integrationHead, sliceHead],
      message,
      redactionValues,
    );
    await this.#git(["update-ref", integrationRef, commit, integrationHead], {
      cwd: repositoryPath,
      redactionValues,
    });
    return {
      status: "merged",
      commit,
      integrationBranch: session.integrationBranch,
    };
  }

  redact(worktree: CreatedWorktree, artifact: string): string {
    const state = this.#worktreeState(worktree);
    // This synchronous API uses the inventory refreshed by the latest async
    // operation. commit(), where persistence happens, always re-reads files.
    return redactText(artifact, state.sessionState.redactionValues);
  }

  async remove(worktree: CreatedWorktree): Promise<void> {
    const state = this.#worktreeState(worktree);
    await this.#refreshRedactionValues(state.sessionState);
    if (worktree.isolated) {
      await this.#discardWorktree(
        worktree.repositoryPath,
        worktree.path,
        state.sessionState,
      );
      const registered = await this.#git(["worktree", "list", "--porcelain"], {
        cwd: worktree.repositoryPath,
        redactionValues: state.sessionState.redactionValues,
      });
      const registeredPaths = registered.stdout
        .toString("utf8")
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
      if (registeredPaths.includes(worktree.path)) {
        throw new Error(`failed to unregister worktree ${worktree.path}`);
      }
    }
    this.#worktrees.delete(worktree);
    state.sessionState.activeWorktrees.delete(worktree);
  }

  async release(session: WorktreeSession): Promise<void> {
    const state = this.#sessionState(session);
    if (state.activeWorktrees.size > 0) {
      throw new Error(
        `cannot release worktree session ${session.slug}: ${state.activeWorktrees.size} worktree(s) are still active`,
      );
    }
    if (state.integrationMaterialized || state.refsReleased) {
      return;
    }

    await this.#refreshRedactionValues(state);
    const expectedRefs = new Map<string, string>([
      [`refs/heads/${session.baseBranch}`, session.baseCommit],
      ...[...state.sliceHeads].map(
        ([branch, head]) => [`refs/heads/${branch}`, head] as const,
      ),
    ]);
    const survivingRefs: [string, string][] = [];
    for (const [ref, expectedHead] of expectedRefs) {
      const result = await this.#git(["show-ref", "--verify", "--quiet", ref], {
        cwd: session.repositoryPath,
        redactionValues: state.redactionValues,
        allowedExitCodes: [0, 1],
      });
      if (result.exitCode === 1) {
        continue;
      }
      const actualHead = await this.#revParse(
        session.repositoryPath,
        ref,
        state.redactionValues,
      );
      if (actualHead !== expectedHead) {
        throw new Error(`engine-created ref ${ref} moved unexpectedly`);
      }
      survivingRefs.push([ref, expectedHead]);
    }

    if (survivingRefs.length > 0) {
      const transaction = ["start"];
      for (const [ref, expectedHead] of survivingRefs) {
        transaction.push(`delete ${ref} ${expectedHead}`);
      }
      transaction.push("prepare", "commit", "");
      await this.#git(["update-ref", "--stdin"], {
        cwd: session.repositoryPath,
        input: transaction.join("\n"),
        redactionValues: state.redactionValues,
      });
    }
    state.refsReleased = true;
  }

  #sessionState(session: WorktreeSession): SessionState {
    const state = this.#sessions.get(session);
    if (state === undefined) {
      throw new Error("worktree session was not prepared by this engine");
    }
    return state;
  }

  #worktreeState(worktree: CreatedWorktree): WorktreeState {
    const state = this.#worktrees.get(worktree);
    if (state === undefined) {
      throw new Error(
        "worktree was not created by this engine or has already been removed",
      );
    }
    return state;
  }

  async #assertBranchDoesNotExist(
    repositoryPath: string,
    branch: string,
    redactionValues: readonly string[],
  ): Promise<void> {
    const result = await this.#git(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repositoryPath, redactionValues, allowedExitCodes: [0, 1] },
    );
    if (result.exitCode === 0) {
      throw new Error(`refusing to overwrite existing branch ${branch}`);
    }
  }

  async #materializeIntegrationBranch(state: SessionState): Promise<string> {
    const { session, redactionValues } = state;
    const integrationRef = `refs/heads/${session.integrationBranch}`;
    const existing = await this.#git(
      ["show-ref", "--verify", "--quiet", integrationRef],
      {
        cwd: session.repositoryPath,
        redactionValues,
        allowedExitCodes: [0, 1],
      },
    );
    if (existing.exitCode === 0) {
      state.integrationMaterialized = true;
      return await this.#revParse(
        session.repositoryPath,
        integrationRef,
        redactionValues,
      );
    }

    const baseRef = `refs/heads/${session.baseBranch}`;
    const baseHead = await this.#revParse(
      session.repositoryPath,
      baseRef,
      redactionValues,
    );
    if (baseHead !== session.baseCommit) {
      throw new Error(
        `scratch base branch ${session.baseBranch} moved unexpectedly`,
      );
    }
    for (const worktree of state.activeWorktrees) {
      if (!worktree.isolated) {
        continue;
      }
      const sliceHead = state.sliceHeads.get(worktree.branch);
      if (sliceHead !== undefined) {
        await this.#git(["update-ref", "--no-deref", "HEAD", sliceHead], {
          cwd: worktree.path,
          redactionValues,
        });
      }
    }

    const transaction = ["start", `delete ${baseRef} ${session.baseCommit}`];
    for (const [branch, head] of state.sliceHeads) {
      transaction.push(`delete refs/heads/${branch} ${head}`);
    }
    transaction.push("prepare", "commit", "");
    await this.#git(["update-ref", "--stdin"], {
      cwd: session.repositoryPath,
      input: transaction.join("\n"),
      redactionValues,
    });
    const zeroObjectId = "0".repeat(session.baseCommit.length);
    try {
      await this.#git(
        ["update-ref", integrationRef, session.baseCommit, zeroObjectId],
        { cwd: session.repositoryPath, redactionValues },
      );
    } catch (error) {
      const restore = ["start", `create ${baseRef} ${session.baseCommit}`];
      for (const [branch, head] of state.sliceHeads) {
        restore.push(`create refs/heads/${branch} ${head}`);
      }
      restore.push("prepare", "commit", "");
      await this.#git(["update-ref", "--stdin"], {
        cwd: session.repositoryPath,
        input: restore.join("\n"),
        redactionValues,
      });
      throw error;
    }
    state.integrationMaterialized = true;
    return session.baseCommit;
  }

  async #changedPaths(
    cwd: string,
    parent: string,
    env: Readonly<Record<string, string>> | undefined,
    redactionValues: readonly string[],
  ): Promise<readonly string[]> {
    const result = await this.#git(
      [
        "diff",
        "--cached",
        "--name-only",
        "--diff-filter=ACDMRTUXB",
        "-z",
        parent,
      ],
      { cwd, ...(env === undefined ? {} : { env }), redactionValues },
    );
    return splitNul(result.stdout);
  }

  #refuseLinkedSecrets(
    changedPaths: readonly string[],
    linkedSecretPaths: readonly string[],
  ): void {
    const forbidden = changedPaths.filter((path) =>
      linkedSecretPaths.some(
        (secretPath) =>
          path === secretPath || path.startsWith(`${secretPath}/`),
      ),
    );
    if (forbidden.length > 0) {
      throw new LinkedSecretCommitError(forbidden);
    }
  }

  async #stageSanitizedTree(
    cwd: string,
    parent: string,
    redactionValues: readonly string[],
    linkedSecretPaths: readonly string[],
  ): Promise<string> {
    await this.#assertLfsIsNotEnabled(cwd, redactionValues);
    return await this.#withTemporaryStagingStore(
      cwd,
      redactionValues,
      async ({ scratchEnv, realEnv }) => {
        // Git owns worktree conversion, modes, and gitlinks. Git objects are
        // quarantined here; side-storage filters such as Git LFS are refused.
        await this.#git(["read-tree", parent], {
          cwd,
          env: scratchEnv,
          redactionValues,
        });
        await this.#git(["add", "-A", "--", "."], {
          cwd,
          env: scratchEnv,
          redactionValues,
        });
        const changedPaths = await this.#changedPaths(
          cwd,
          parent,
          scratchEnv,
          redactionValues,
        );
        this.#refuseLinkedSecrets(changedPaths, linkedSecretPaths);

        const entries = parseStageEntries(
          (
            await this.#git(["ls-files", "--stage", "-z"], {
              cwd,
              env: scratchEnv,
              redactionValues,
            })
          ).stdout,
        );
        const destinations = new Map<string, string>();
        for (const path of entries.keys()) {
          const destination = redactText(path, redactionValues);
          const existing = destinations.get(destination);
          if (existing !== undefined && existing !== path) {
            throw new Error(
              `redaction makes multiple repository paths collide at ${destination}`,
            );
          }
          destinations.set(destination, path);
        }

        for (const [path, entry] of entries) {
          const destination = redactText(path, redactionValues);
          // Gitlinks carry an object id but no superproject blob content.
          const objectId =
            entry.mode === "160000"
              ? entry.objectId
              : await promoteGitBlob(
                  entry.objectId,
                  cwd,
                  scratchEnv,
                  realEnv,
                  redactionValues,
                  this.#commandTimeoutMs,
                );
          if (destination !== path) {
            await this.#git(["update-index", "--force-remove", "--", path], {
              cwd,
              env: scratchEnv,
              redactionValues,
            });
          }
          if (objectId !== entry.objectId || destination !== path) {
            await this.#git(
              [
                "update-index",
                "--add",
                "--cacheinfo",
                entry.mode,
                objectId,
                destination,
              ],
              { cwd, env: scratchEnv, redactionValues },
            );
          }
        }

        // Every blob now exists in the real ODB and every path is sanitized,
        // so tree creation can safely target the real store.
        const result = await this.#git(["write-tree"], {
          cwd,
          env: realEnv,
          redactionValues,
        });
        return result.stdout.toString("utf8").trim();
      },
    );
  }

  async #withTemporaryStagingStore<T>(
    cwd: string,
    redactionValues: readonly string[],
    operation: (store: {
      readonly scratchEnv: Readonly<Record<string, string>>;
      readonly realEnv: Readonly<Record<string, string>>;
    }) => Promise<T>,
  ): Promise<T> {
    const commonDirectoryPath = (
      await this.#git(["rev-parse", "--git-common-dir"], {
        cwd,
        redactionValues,
      })
    ).stdout
      .toString("utf8")
      .trim();
    const commonDirectory = await realpath(resolve(cwd, commonDirectoryPath));
    const realObjectDirectory = await realpath(
      join(commonDirectory, "objects"),
    );
    const directory = await mkdtemp(join(tmpdir(), "brigadier-staging-"));
    const scratchObjectDirectory = join(directory, "objects");
    const indexPath = join(directory, "index");
    try {
      await mkdir(scratchObjectDirectory);
      return await operation({
        scratchEnv: {
          GIT_INDEX_FILE: indexPath,
          GIT_OBJECT_DIRECTORY: scratchObjectDirectory,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: [
            realObjectDirectory,
            process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
          ]
            .filter(
              (path): path is string => path !== undefined && path.length > 0,
            )
            .join(delimiter),
        },
        realEnv: {
          GIT_INDEX_FILE: indexPath,
          GIT_OBJECT_DIRECTORY: realObjectDirectory,
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #refreshRedactionValues(state: SessionState): Promise<void> {
    const current = await collectRedactionValues(
      state.session.repositoryPath,
      state.linkedSecretPaths,
      state.explicitRedactionValues,
    );
    // Retain previously observed values after rotation: old values can remain
    // in worker output even after the source secret file has changed.
    state.redactionValues = normalizeRedactionValues([
      ...state.redactionValues,
      ...current,
    ]);
  }

  async #assertLfsIsNotEnabled(
    cwd: string,
    redactionValues: readonly string[],
  ): Promise<void> {
    const configuredCleanFilter = await this.#git(
      ["config", "--get-all", "filter.lfs.clean"],
      { cwd, redactionValues, allowedExitCodes: [0, 1] },
    );
    if (configuredCleanFilter.exitCode === 0) {
      throw new Error(LFS_UNSUPPORTED_MESSAGE);
    }

    const attributeFiles = splitNul(
      (
        await this.#git(
          [
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".gitattributes",
            ":(glob)**/.gitattributes",
          ],
          { cwd, redactionValues },
        )
      ).stdout,
    );
    for (const path of attributeFiles) {
      let contents: string;
      try {
        contents = await readFile(resolve(cwd, path), "utf8");
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }
        throw error;
      }
      if (declaresLfsFilter(contents)) {
        throw new Error(LFS_UNSUPPORTED_MESSAGE);
      }
    }
  }

  async #commitTree(
    repositoryPath: string,
    tree: string,
    parents: readonly string[],
    message: string,
    redactionValues: readonly string[],
  ): Promise<string> {
    const args = ["commit-tree", tree];
    for (const parent of parents) {
      args.push("-p", parent);
    }
    args.push("-F", "-");
    const result = await this.#git(args, {
      cwd: repositoryPath,
      input: message,
      redactionValues,
    });
    return result.stdout.toString("utf8").trim();
  }

  async #revParse(
    repositoryPath: string,
    ref: string,
    redactionValues: readonly string[],
  ): Promise<string> {
    const result = await this.#git(["rev-parse", "--verify", ref], {
      cwd: repositoryPath,
      redactionValues,
    });
    return result.stdout.toString("utf8").trim();
  }

  async #seedWorktree(
    state: SessionState,
    worktreePath: string,
  ): Promise<void> {
    for (const path of state.dependencyPaths) {
      await this.#revalidateLinkedSecretConsent(state);
      await seedDependency(state.session.repositoryPath, worktreePath, path);
    }
    if (state.consentToLinkSecrets) {
      for (const path of state.linkedSecretPaths) {
        await this.#revalidateLinkedSecretConsent(state);
        await seedSymlink(state.session.repositoryPath, worktreePath, path);
      }
    }
  }

  async #revalidateLinkedSecretConsent(state: SessionState): Promise<void> {
    const overlap = await findOverlappingPaths(
      state.session.repositoryPath,
      state.dependencyPaths,
      state.linkedSecretPaths,
    );
    if (overlap.length > 0) {
      throw new Error(
        `paths cannot be both dependencies and linked secrets: ${overlap.join(", ")}`,
      );
    }
  }

  async #discardWorktree(
    repositoryPath: string,
    worktreePath: string,
    state: SessionState,
  ): Promise<void> {
    const registeredPaths = await this.#registeredWorktreePaths(
      repositoryPath,
      state.redactionValues,
    );
    if (!registeredPaths.includes(worktreePath)) {
      return;
    }
    await this.#git(["worktree", "remove", "--force", worktreePath], {
      cwd: repositoryPath,
      redactionValues: state.redactionValues,
    });
    await this.#git(["worktree", "prune", "--expire", "now"], {
      cwd: repositoryPath,
      redactionValues: state.redactionValues,
    });
  }

  async #registeredWorktreePaths(
    repositoryPath: string,
    redactionValues: readonly string[],
  ): Promise<readonly string[]> {
    const result = await this.#git(["worktree", "list", "--porcelain"], {
      cwd: repositoryPath,
      redactionValues,
    });
    return result.stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  }

  async #git(args: readonly string[], options: GitOptions): Promise<GitResult> {
    const result = await runGit(args, options, this.#commandTimeoutMs);
    const allowed = options.allowedExitCodes ?? [0];
    if (!allowed.includes(result.exitCode)) {
      throw new GitCommandError(args, result, options.redactionValues ?? []);
    }
    return result;
  }
}

async function promoteGitBlob(
  objectId: string,
  cwd: string,
  sourceEnv: Readonly<Record<string, string>>,
  destinationEnv: Readonly<Record<string, string>>,
  redactionValues: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const source = spawn("git", ["cat-file", "blob", objectId], {
    cwd,
    detached: true,
    env: gitEnvironment(sourceEnv),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const destination = spawn("git", ["hash-object", "-w", "--stdin"], {
    cwd,
    detached: true,
    env: gitEnvironment(destinationEnv),
    stdio: ["pipe", "pipe", "pipe"],
  });
  source.stdin.end();

  const sourceError: Buffer[] = [];
  const destinationOutput: Buffer[] = [];
  const destinationError: Buffer[] = [];
  let diagnosticBytes = 0;
  let outputExceeded = false;
  let timedOut = false;
  const kill = () => {
    killProcess(source);
    killProcess(destination);
  };
  const collect = (target: Buffer[], chunk: Buffer) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > MAX_COMMAND_OUTPUT_BYTES) {
      outputExceeded = true;
      kill();
      return;
    }
    target.push(chunk);
  };
  source.stderr.on("data", (chunk: Buffer) => collect(sourceError, chunk));
  destination.stdout.on("data", (chunk: Buffer) =>
    collect(destinationOutput, chunk),
  );
  destination.stderr.on("data", (chunk: Buffer) =>
    collect(destinationError, chunk),
  );

  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  timer.unref();
  const transforms = redactionValues.map(
    (value) => new ByteReplacementTransform(Buffer.from(value)),
  );
  const pipe = pipeline([source.stdout, ...transforms, destination.stdin]).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    const [sourceExit, destinationExit, pipeError] = await Promise.all([
      waitForProcess(source),
      waitForProcess(destination),
      pipe,
    ]);
    if (timedOut) {
      throw new Error(`git blob promotion timed out after ${timeoutMs} ms`);
    }
    if (outputExceeded) {
      throw new Error("git blob promotion exceeded the output limit");
    }
    if (sourceExit !== 0) {
      throw gitStreamError(
        "cat-file",
        sourceExit,
        sourceError,
        redactionValues,
      );
    }
    if (destinationExit !== 0) {
      throw gitStreamError(
        "hash-object",
        destinationExit,
        destinationError,
        redactionValues,
      );
    }
    if (pipeError !== undefined) {
      throw pipeError;
    }
    const promoted = Buffer.concat(destinationOutput).toString("utf8").trim();
    if (!/^[0-9a-f]{40,64}$/.test(promoted)) {
      throw new Error("git hash-object did not return a valid object id");
    }
    return promoted;
  } finally {
    clearTimeout(timer);
    kill();
  }
}

class ByteReplacementTransform extends Transform {
  readonly #search: Buffer;
  #pending = Buffer.alloc(0);

  constructor(search: Buffer) {
    super();
    this.#search = search;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const source = Buffer.concat([this.#pending, chunk]);
      const cutoff = Math.max(0, source.length - (this.#search.length - 1));
      let cursor = 0;
      let match = source.indexOf(this.#search, cursor);
      while (match !== -1 && match < cutoff) {
        this.push(source.subarray(cursor, match));
        this.push(REDACTION_MARKER);
        cursor = match + this.#search.length;
        match = source.indexOf(this.#search, cursor);
      }
      if (cursor < cutoff) {
        this.push(source.subarray(cursor, cutoff));
        cursor = cutoff;
      }
      this.#pending = source.subarray(cursor);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.push(
        replaceBytes(
          this.#pending,
          this.#search,
          Buffer.from(REDACTION_MARKER),
        ),
      );
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function gitEnvironment(
  env: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function waitForProcess(
  child: ReturnType<typeof spawn>,
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code));
  });
}

function killProcess(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process may have exited between the check and this signal.
    }
  }
  child.kill("SIGKILL");
}

function gitStreamError(
  command: string,
  exitCode: number | null,
  stderr: readonly Buffer[],
  redactionValues: readonly string[],
): Error {
  const detail = redactText(
    Buffer.concat(stderr).toString("utf8").trim(),
    redactionValues,
  );
  return new Error(
    `git ${command} failed (${exitCode ?? "signal"}): ${detail || "no diagnostic output"}`,
  );
}

async function runGit(
  args: readonly string[],
  options: GitOptions,
  timeoutMs: number,
): Promise<GitResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      detached: true,
      env: gitEnvironment(options.env ?? {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const kill = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The process may have exited between the timeout and this signal.
        }
      }
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      kill();
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `git ${args[0] ?? "command"} timed out after ${timeoutMs} ms`,
          ),
        );
      }
    }, timeoutMs);
    timer.unref();

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        kill();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new Error(`git ${args[0] ?? "command"} exceeded the output limit`),
          );
        }
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === null) {
          reject(
            new Error(
              `git ${args[0] ?? "command"} terminated by ${signal ?? "unknown signal"}`,
            ),
          );
          return;
        }
        resolvePromise({
          exitCode: code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      }
    });
    child.stdin.on("error", () => {
      // A command may close stdin before consuming it; close/exit owns the result.
    });
    child.stdin.end(options.input);
  });
}

function validateSlug(slug: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new Error(
      "slug must contain only letters, digits, dots, underscores, and hyphens",
    );
  }
}

function normalizeUniquePaths(
  paths: readonly string[],
  label: string,
): readonly string[] {
  const normalized = paths.map((path) => normalizeRepositoryPath(path, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} paths must be unique`);
  }
  return Object.freeze(normalized);
}

function declaresLfsFilter(contents: string): boolean {
  return contents.split(/\r?\n/).some((line) => {
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      return false;
    }
    return trimmed
      .split(/[\t ]+/)
      .slice(1)
      .some((attribute) => attribute === "filter=lfs");
  });
}

function normalizeRepositoryPath(path: string, label: string): string {
  if (path.length === 0 || isAbsolute(path) || path.includes("\\")) {
    throw new Error(
      `${label} path must be a non-empty repository-relative POSIX path`,
    );
  }
  const normalized = posix.normalize(path);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`${label} path escapes the repository`);
  }
  return normalized.replace(/^\.\//, "");
}

async function findOverlappingPaths(
  repositoryPath: string,
  dependencyPaths: readonly string[],
  linkedSecretPaths: readonly string[],
): Promise<readonly string[]> {
  const secrets = await Promise.all(
    linkedSecretPaths.map(async (path) => ({
      path,
      resolved: await resolveThroughExistingAncestor(
        resolve(repositoryPath, path),
      ),
    })),
  );
  const overlap: string[] = [];
  for (const path of dependencyPaths) {
    const dependency = {
      path,
      resolved: await resolveDependencyTarget(
        resolve(repositoryPath, path),
        path,
      ),
    };
    for (const secret of secrets) {
      if (
        pathsContainEachOther(dependency.path, secret.path, posix.sep) ||
        pathsContainEachOther(dependency.resolved, secret.resolved, sep)
      ) {
        overlap.push(`${dependency.path} ↔ ${secret.path}`);
      }
    }
    await inspectDependencyTree(
      repositoryPath,
      resolve(repositoryPath, path),
      path,
      path,
      secrets,
      new Set(),
      overlap,
    );
  }
  return [...new Set(overlap)];
}

async function inspectDependencyTree(
  repositoryPath: string,
  absolutePath: string,
  displayPath: string,
  dependencyPath: string,
  secrets: readonly { readonly path: string; readonly resolved: string }[],
  visitedDirectories: Set<string>,
  overlap: string[],
): Promise<void> {
  let pathStat: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStat = await lstat(absolutePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }

  let traversalPath = absolutePath;
  if (pathStat.isSymbolicLink()) {
    traversalPath = await resolveDependencyTarget(absolutePath, displayPath);
    if (
      traversalPath !== repositoryPath &&
      !isWithin(repositoryPath, traversalPath)
    ) {
      throw new Error(`dependency symlink escapes repository: ${displayPath}`);
    }
    for (const secret of secrets) {
      if (pathsContainEachOther(traversalPath, secret.resolved, sep)) {
        overlap.push(
          `${dependencyPath} descendant ${displayPath} ↔ ${secret.path}`,
        );
      }
    }
    try {
      pathStat = await lstat(traversalPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
  }
  if (!pathStat.isDirectory()) {
    return;
  }

  const resolvedDirectory = await resolveDependencyTarget(
    traversalPath,
    displayPath,
  );
  if (
    resolvedDirectory !== repositoryPath &&
    !isWithin(repositoryPath, resolvedDirectory)
  ) {
    throw new Error(`dependency path escapes repository: ${displayPath}`);
  }
  if (visitedDirectories.has(resolvedDirectory)) {
    return;
  }
  visitedDirectories.add(resolvedDirectory);
  const children = await readdir(resolvedDirectory);
  for (const child of children) {
    await inspectDependencyTree(
      repositoryPath,
      join(resolvedDirectory, child),
      posix.join(displayPath, child),
      dependencyPath,
      secrets,
      visitedDirectories,
      overlap,
    );
  }
}

async function resolveDependencyTarget(
  path: string,
  displayPath: string,
): Promise<string> {
  try {
    return await resolveThroughExistingAncestor(path);
  } catch (error) {
    if (isFileSystemError(error, "ELOOP")) {
      throw new Error(`dependency symlink loop at ${displayPath}`);
    }
    throw error;
  }
}

function pathsContainEachOther(
  left: string,
  right: string,
  separator: string,
): boolean {
  return (
    left === right ||
    left.startsWith(`${right}${separator}`) ||
    right.startsWith(`${left}${separator}`)
  );
}

async function resolveThroughExistingAncestor(path: string): Promise<string> {
  let cursor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...suffix.toReversed());
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      suffix.push(relative(parent, cursor));
      cursor = parent;
    }
  }
}

function resolveRequiredWorktreePath(
  path: string | undefined,
  repositoryPath: string,
): string {
  if (path === undefined) {
    throw new Error("path is required unless unsafeInPlace is true");
  }
  const resolved = resolve(path);
  if (resolved === repositoryPath || isWithin(repositoryPath, resolved)) {
    throw new Error(
      "isolated worktree path must be outside the source repository",
    );
  }
  return resolved;
}

async function assertAvailableWorktreePath(
  path: string,
  redactionValues: readonly string[],
): Promise<void> {
  let pathStat: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStat = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }
  if (!pathStat.isDirectory() || (await readdir(path)).length > 0) {
    throw new Error(
      `isolated worktree path already exists and is not an empty directory: ${redactText(path, redactionValues)}`,
    );
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

async function collectRedactionValues(
  repositoryPath: string,
  linkedSecretPaths: readonly string[],
  explicitValues: readonly string[],
): Promise<readonly string[]> {
  const values = explicitValues.filter((value) => value.length > 0);
  for (const path of linkedSecretPaths) {
    const source = resolve(repositoryPath, path);
    let contents: string;
    try {
      contents = await readFile(source, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
    values.push(...parseSecretValues(contents));
  }
  return normalizeRedactionValues(values);
}

function normalizeRedactionValues(
  values: readonly string[],
): readonly string[] {
  return Object.freeze(
    [...new Set(values)]
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length),
  );
}

/**
 * Best-effort inventory for exact, verbatim values in raw-token, dotenv,
 * JSON, and common YAML scalar files. This is deliberately not advertised as
 * semantic secret detection: custom encodings, YAML features outside this
 * small lexer, and encoded/transformed/truncated values require callers to
 * supply explicit redactionValues and cannot be guaranteed automatically.
 */
function parseSecretValues(contents: string): readonly string[] {
  const trimmedContents = contents.trim();
  const values: string[] = [];
  if (trimmedContents.length > 0) {
    values.push(trimmedContents);
  }

  try {
    collectJsonStringValues(JSON.parse(contents), values);
  } catch {
    // Non-JSON files continue through the dotenv/YAML lexical inventory.
  }

  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length)
      : trimmed;
    const equals = assignment.indexOf("=");
    if (equals < 1) {
      continue;
    }
    let value = assignment.slice(equals + 1).trim();
    const quote = value.startsWith('"')
      ? '"'
      : value.startsWith("'")
        ? "'"
        : undefined;
    if (quote !== undefined && !value.slice(1).includes(quote)) {
      const continuation: string[] = [value.slice(1)];
      while (index + 1 < lines.length) {
        index += 1;
        const next = lines[index] ?? "";
        const closing = next.indexOf(quote);
        if (closing >= 0) {
          continuation.push(next.slice(0, closing));
          value = continuation.join("\n");
          break;
        }
        continuation.push(next);
      }
    } else if (
      quote !== undefined &&
      value.length >= 2 &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) {
      values.push(value);
    }
  }

  values.push(...parseYamlScalarValues(lines));
  return values;
}

function collectJsonStringValues(value: unknown, values: string[]): void {
  if (typeof value === "string") {
    if (value.length > 0) {
      values.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonStringValues(item, values);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectJsonStringValues(item, values);
    }
  }
}

function parseYamlScalarValues(lines: readonly string[]): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^(\s*)[^#:\s][^:]*:\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    const indentation = match[1].length;
    let value = match[2];
    if (value === "|" || value === ">") {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? "";
        const nextIndentation = /^\s*/.exec(next)?.[0].length ?? 0;
        if (next.trim().length > 0 && nextIndentation <= indentation) {
          break;
        }
        index += 1;
        block.push(next.slice(Math.min(next.length, indentation + 2)));
      }
      while (block.at(-1) === "") {
        block.pop();
      }
      value = value === "|" ? block.join("\n") : block.join(" ");
    } else {
      value = stripMatchingQuotes(value.replace(/\s+#.*$/, "").trim());
    }
    if (value.length > 0) {
      values.push(value);
    }
  }
  return values;
}

function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function redactText(value: string, redactionValues: readonly string[]): string {
  let redacted = value;
  for (const secret of redactionValues) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join(REDACTION_MARKER);
    }
  }
  return redacted;
}

function replaceBytes(
  source: Buffer,
  search: Buffer,
  replacement: Buffer,
): Buffer {
  const chunks: Buffer[] = [];
  let cursor = 0;
  let match = source.indexOf(search, cursor);
  if (match === -1) {
    return source;
  }
  while (match !== -1) {
    chunks.push(source.subarray(cursor, match), replacement);
    cursor = match + search.length;
    match = source.indexOf(search, cursor);
  }
  chunks.push(source.subarray(cursor));
  return Buffer.concat(chunks);
}

function parseStageEntries(
  value: Buffer,
): ReadonlyMap<string, { readonly mode: string; readonly objectId: string }> {
  const entries = new Map<
    string,
    { readonly mode: string; readonly objectId: string }
  >();
  for (const record of splitNul(value)) {
    const match = /^(\d+) ([0-9a-f]+) 0\t([\s\S]+)$/.exec(record);
    if (
      match?.[1] !== undefined &&
      match[2] !== undefined &&
      match[3] !== undefined
    ) {
      entries.set(match[3], { mode: match[1], objectId: match[2] });
    }
  }
  return entries;
}

function splitNul(value: Buffer): readonly string[] {
  return value
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

async function seedDependency(
  repositoryPath: string,
  worktreePath: string,
  path: string,
): Promise<void> {
  const source = resolve(repositoryPath, path);
  const destination = resolve(worktreePath, path);
  if (await pathExists(destination)) {
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  // Dereferencing while copying makes the seed a snapshot: the isolated
  // worktree cannot follow later mutations in the source dependency tree.
  await cp(source, destination, {
    dereference: true,
    errorOnExist: true,
    force: false,
    recursive: true,
  });
}

async function seedSymlink(
  repositoryPath: string,
  worktreePath: string,
  path: string,
): Promise<void> {
  const source = resolve(repositoryPath, path);
  const destination = resolve(worktreePath, path);
  const sourceStat = await lstat(source);
  if (await pathExists(destination)) {
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await symlink(source, destination, sourceStat.isDirectory() ? "dir" : "file");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return isFileSystemError(error, "ENOENT");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
