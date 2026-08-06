import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
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
  readonly redactionValues: readonly string[];
  readonly sliceHeads: Map<string, string>;
  readonly activeWorktrees: Set<CreatedWorktree>;
  integrationMaterialized: boolean;
}

interface WorktreeState {
  readonly sessionState: SessionState;
  readonly worktree: CreatedWorktree;
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
  readonly exitCode: number;

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
    this.exitCode = result.exitCode;
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
    const overlap = dependencyPaths.filter((path) =>
      linkedSecretPaths.includes(path),
    );
    if (overlap.length > 0) {
      throw new Error(
        `paths cannot be both dependencies and linked secrets: ${overlap.join(", ")}`,
      );
    }

    const redactionValues = await collectRedactionValues(
      repositoryPath,
      linkedSecretPaths,
      spec.secrets.redactionValues ?? [],
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

    const tree = await this.#withTemporaryIndex(async (indexPath) => {
      const env = { GIT_INDEX_FILE: indexPath };
      await this.#git(["read-tree", head], {
        cwd: repositoryPath,
        env,
        redactionValues,
      });
      await this.#git(["add", "-A", "--", "."], {
        cwd: repositoryPath,
        env,
        redactionValues,
      });
      const indexedPaths = splitNul(
        (
          await this.#git(["ls-files", "-z"], {
            cwd: repositoryPath,
            env,
            redactionValues,
          })
        ).stdout,
      );
      this.#refuseLinkedSecrets(indexedPaths, linkedSecretPaths);
      await this.#redactIndexBlobs(
        repositoryPath,
        env,
        indexedPaths,
        redactionValues,
      );
      const result = await this.#git(["write-tree"], {
        cwd: repositoryPath,
        env,
        redactionValues,
      });
      return result.stdout.toString("utf8").trim();
    });

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
      redactionValues,
      sliceHeads: new Map(),
      activeWorktrees: new Set(),
      integrationMaterialized: false,
    });
    return session;
  }

  async create(spec: WorktreeSpec): Promise<CreatedWorktree> {
    const sessionState = this.#sessionState(spec.session);
    if (!Number.isSafeInteger(spec.slice) || spec.slice <= 0) {
      throw new RangeError("slice must be a positive whole number");
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

    const unsafeInPlace = spec.unsafeInPlace === true;
    const worktreePath = unsafeInPlace
      ? spec.session.repositoryPath
      : resolveRequiredWorktreePath(spec.path, spec.session.repositoryPath);
    try {
      if (!unsafeInPlace) {
        await this.#git(["worktree", "add", "--quiet", worktreePath, branch], {
          cwd: spec.session.repositoryPath,
          redactionValues: sessionState.redactionValues,
        });
        await this.#seedWorktree(sessionState, worktreePath);
      }
    } catch (error) {
      if (!unsafeInPlace) {
        await this.#discardWorktree(
          spec.session.repositoryPath,
          worktreePath,
          sessionState,
        );
      }
      await this.#git(["update-ref", "-d", branchRef], {
        cwd: spec.session.repositoryPath,
        redactionValues: sessionState.redactionValues,
        allowedExitCodes: [0, 1],
      });
      throw error;
    }

    const worktree = Object.freeze({
      repositoryPath: spec.session.repositoryPath,
      path: worktreePath,
      branch,
      isolated: !unsafeInPlace,
      session: spec.session,
    }) satisfies CreatedWorktree;
    this.#worktrees.set(worktree, { sessionState, worktree });
    sessionState.sliceHeads.set(branch, spec.session.baseCommit);
    sessionState.activeWorktrees.add(worktree);
    return worktree;
  }

  async commit(spec: CommitSpec): Promise<CommitResult> {
    const state = this.#worktreeState(spec.worktree);
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

    const result = await this.#withTemporaryIndex(async (indexPath) => {
      const env = { GIT_INDEX_FILE: indexPath };
      await this.#git(["read-tree", parent], {
        cwd: spec.worktree.path,
        env,
        redactionValues,
      });
      await this.#git(["add", "-A", "--", "."], {
        cwd: spec.worktree.path,
        env,
        redactionValues,
      });
      const changedPaths = await this.#changedPaths(
        spec.worktree.path,
        parent,
        env,
        redactionValues,
      );
      this.#refuseLinkedSecrets(changedPaths, linkedSecretPaths);
      await this.#redactIndexBlobs(
        spec.worktree.path,
        env,
        changedPaths,
        redactionValues,
      );
      const tree = (
        await this.#git(["write-tree"], {
          cwd: spec.worktree.path,
          env,
          redactionValues,
        })
      ).stdout
        .toString("utf8")
        .trim();
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
    });

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
    return redactText(artifact, state.sessionState.redactionValues);
  }

  async remove(worktree: CreatedWorktree): Promise<void> {
    const state = this.#worktreeState(worktree);
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

  async #redactIndexBlobs(
    cwd: string,
    env: Readonly<Record<string, string>>,
    paths: readonly string[],
    redactionValues: readonly string[],
  ): Promise<void> {
    if (redactionValues.length === 0) {
      return;
    }
    for (const path of paths) {
      const entry = await this.#git(["ls-files", "--stage", "-z", "--", path], {
        cwd,
        env,
        redactionValues,
      });
      const match = /^(\d+) ([0-9a-f]+) 0\t/.exec(
        entry.stdout.toString("utf8"),
      );
      if (match?.[1] === undefined || match[2] === undefined) {
        continue;
      }
      if (!match[1].startsWith("100") && match[1] !== "120000") {
        continue;
      }
      const original = (
        await this.#git(["cat-file", "blob", match[2]], {
          cwd,
          env,
          redactionValues,
        })
      ).stdout;
      const redacted = redactBuffer(original, redactionValues);
      if (redacted.equals(original)) {
        continue;
      }
      const objectId = (
        await this.#git(["hash-object", "-w", "--stdin"], {
          cwd,
          env,
          input: redacted,
          redactionValues,
        })
      ).stdout
        .toString("utf8")
        .trim();
      await this.#git(
        ["update-index", "--cacheinfo", match[1], objectId, path],
        {
          cwd,
          env,
          redactionValues,
        },
      );
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
      await seedDependency(
        state.session.repositoryPath,
        worktreePath,
        path,
        this.#commandTimeoutMs,
      );
    }
    if (state.consentToLinkSecrets) {
      for (const path of state.linkedSecretPaths) {
        await seedSymlink(state.session.repositoryPath, worktreePath, path);
      }
    }
  }

  async #discardWorktree(
    repositoryPath: string,
    worktreePath: string,
    state: SessionState,
  ): Promise<void> {
    await this.#git(["worktree", "remove", "--force", worktreePath], {
      cwd: repositoryPath,
      redactionValues: state.redactionValues,
      allowedExitCodes: [0, 128],
    });
    await rm(worktreePath, { recursive: true, force: true });
    await this.#git(["worktree", "prune", "--expire", "now"], {
      cwd: repositoryPath,
      redactionValues: state.redactionValues,
    });
  }

  async #withTemporaryIndex<T>(
    operation: (indexPath: string) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "brigadier-index-"));
    try {
      return await operation(join(directory, "index"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

async function runGit(
  args: readonly string[],
  options: GitOptions,
  timeoutMs: number,
): Promise<GitResult> {
  return await new Promise((resolvePromise, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn("git", args, {
      cwd: options.cwd,
      detached,
      env: {
        ...process.env,
        ...options.env,
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const kill = () => {
      if (detached && child.pid !== undefined) {
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
    values.push(...parseEnvValues(contents));
  }
  return Object.freeze(
    [...new Set(values)]
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length),
  );
}

function parseEnvValues(contents: string): readonly string[] {
  const values: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
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
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) {
      values.push(value);
    }
  }
  return values;
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

function redactBuffer(
  value: Buffer,
  redactionValues: readonly string[],
): Buffer {
  let redacted = value;
  for (const secret of redactionValues) {
    if (secret.length === 0) {
      continue;
    }
    redacted = replaceBytes(
      redacted,
      Buffer.from(secret),
      Buffer.from(REDACTION_MARKER),
    );
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
  timeoutMs: number,
): Promise<void> {
  const source = resolve(repositoryPath, path);
  const destination = resolve(worktreePath, path);
  const sourceStat = await lstat(source);
  if (await pathExists(destination)) {
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  if (process.platform === "darwin") {
    const copied = await runCopyOnWrite(source, destination, timeoutMs);
    if (copied) {
      return;
    }
    await rm(destination, { recursive: true, force: true });
  }
  await symlink(source, destination, sourceStat.isDirectory() ? "dir" : "file");
}

async function runCopyOnWrite(
  source: string,
  destination: string,
  timeoutMs: number,
): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const child = spawn("/bin/cp", ["-cR", source, destination], {
      stdio: "ignore",
    });
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        resolvePromise(false);
      }
    }, timeoutMs);
    timer.unref();
    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(false);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(code === 0);
      }
    });
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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
