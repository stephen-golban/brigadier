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
  UncommittedDiff,
  UncommittedDiffSpec,
  WorktreeEngine,
  WorktreeEngineOptions,
  WorktreeSession,
  WorktreeSessionSpec,
  WorktreeSpec,
} from "./contracts.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const REDACTION_MARKER = "[REDACTED]";
const ARTIFACT_LINE_PREFIXES = ["-", "+", " "] as const;

/**
 * The diff invocation, pinned against the reader's own git configuration.
 *
 * EVERY FLAG HERE EXISTS BECAUSE A USER'S `~/.gitconfig` CAN CHANGE THE ANSWER.
 * This patch is about to be shown to a model that will decide whether a slice
 * commits, and it is asserted byte-for-byte by this repository's tests; a
 * `diff.algorithm = histogram` or a `diff.external` in the operator's config
 * would silently change both. Command-line flags outrank every config file, so
 * each behaviour that has a config knob is stated here rather than inherited:
 * colour, external drivers, textconv, rename detection, the hunk algorithm, the
 * indent heuristic, the context width, the path prefixes, and submodules.
 *
 * `--binary` IS DELIBERATELY ABSENT. Without it a changed binary file renders
 * as one `Binary files a/x and b/x differ` line; with it, the whole file
 * arrives base64-encoded. A reviewer can do nothing with the second, and it is
 * the fastest way to spend the caller's entire character budget on one asset.
 */
const DIFF_ARGS = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--indent-heuristic",
  "--diff-algorithm=myers",
  "--unified=3",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--ignore-submodules=none",
  "--submodule=short",
] as const;

/**
 * `core.quotePath=false`, forced the one way a config file cannot outrank.
 *
 * Git reads `GIT_CONFIG_COUNT`-style variables after every config file, so this
 * wins over both the operator's global config and the repository's own. Left at
 * the default, a path with any non-ASCII byte reaches the reviewer as octal
 * escapes, which is both unreadable and — since the default is a config knob —
 * not the same text on two machines.
 */
const DIFF_CONFIG_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.quotePath",
  GIT_CONFIG_VALUE_0: "false",
};

/**
 * A unified diff's `index <old>..<new> <mode>` header line.
 *
 * THESE LINES ARE REMOVED FROM THE PATCH, and the reason is that they are the
 * only part of it that is neither reproducible nor useful here. The abbreviated
 * object ids they carry depend on how many objects the repository holds, so the
 * same change produces different text in a scratch repository and in a large
 * one — which would make an exact assertion impossible and tell a reviewer
 * nothing it can act on. The mode they repeat is already stated by the
 * `new file mode` / `deleted file mode` / `old mode` / `new mode` lines beside
 * them, which are kept.
 *
 * IT CANNOT MATCH FILE CONTENT. Every content line in a unified diff carries a
 * one-character prefix (` `, `+`, `-`), so a line beginning at column zero is a
 * header by construction, and this pattern is anchored at both ends.
 */
const DIFF_INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/;
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
  accumulatedHead: string;
  integrationMaterialized: boolean;
  refsReleased: boolean;
}

interface WorktreeState {
  readonly sessionState: SessionState;
  /**
   * The canonical path this worktree is registered under in `#isolatedByPath`,
   * or null when it is not registered at all (an `unsafeInPlace` worktree).
   *
   * Remembered rather than recomputed, because `remove()` resolves it AFTER the
   * directory is gone: a second `realpath` would fail there and quietly leave a
   * dead entry in the index, holding a removed worktree alive and answering a
   * later lookup with a handle the engine has already rejected.
   */
  readonly indexKey: string | null;
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
  /**
   * Canonical worktree path to the handle created there, for the isolated
   * worktrees only.
   *
   * IT IS A STRONG MAP BESIDE A WEAK ONE, AND BOTH ARE NEEDED. `#worktrees` is
   * weak so a handle a caller has dropped can be collected; this index is what
   * lets `diffUncommitted` find a handle from the only identifier its caller
   * has, and holding the handle strongly is what keeps the weak entry alive
   * until `remove()` retires both. Entries are added by `create()` and deleted
   * by `remove()`, so its size is the number of live isolated worktrees.
   *
   * `unsafeInPlace` WORKTREES ARE DELIBERATELY ABSENT. They all share one path
   * — the user's checkout — so a path lookup could not say which slice was
   * being asked about, and the uncommitted content there belongs to the user
   * and to every concurrent slice as much as to the one asking.
   */
  readonly #isolatedByPath = new Map<string, CreatedWorktree>();

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
      accumulatedHead: baseCommit,
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
    const sliceBase = sessionState.accumulatedHead;
    const zeroObjectId = "0".repeat(sliceBase.length);
    await this.#git(["update-ref", branchRef, sliceBase, zeroObjectId], {
      cwd: spec.session.repositoryPath,
      redactionValues: sessionState.redactionValues,
    });

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
    // Resolved now, while the directory certainly exists, and resolved on both
    // sides of the later lookup: on macOS a worktree under `/tmp` is really
    // under `/private/tmp`, so comparing an unresolved key against a resolved
    // query would miss every worktree this engine creates in the ordinary case.
    const indexKey = unsafeInPlace ? null : await canonicalPath(worktreePath);
    this.#worktrees.set(worktree, { sessionState, indexKey });
    if (indexKey !== null) {
      this.#isolatedByPath.set(indexKey, worktree);
    }
    sessionState.sliceHeads.set(branch, sliceBase);
    sessionState.activeWorktrees.add(worktree);
    return worktree;
  }

  async diffUncommitted(spec: UncommittedDiffSpec): Promise<UncommittedDiff> {
    if (!Number.isSafeInteger(spec.maxCharacters) || spec.maxCharacters <= 0) {
      throw new RangeError("maxCharacters must be a positive whole number");
    }
    const key = await canonicalPath(spec.worktreePath);
    const worktree = this.#isolatedByPath.get(key);
    if (worktree === undefined) {
      // Deliberately one message for "never created", "already removed" and
      // "created in place": all three mean this engine will not claim to know
      // what changed there, and distinguishing them would tell a caller more
      // about other slices' worktrees than it asked about its own.
      throw new Error(
        `no isolated worktree created by this engine is registered at ${key}`,
      );
    }
    const state = this.#worktreeState(worktree);
    await this.#refreshRedactionValues(state.sessionState);
    const { redactionValues, linkedSecretPaths } = state.sessionState;

    // The same refusal `commit()` makes, made here for the same reason: a
    // worktree that has been moved onto another branch would diff against a
    // parent that is not the one the eventual commit will use, so the reviewer
    // would be shown a change nobody is proposing.
    const branchRef = `refs/heads/${worktree.branch}`;
    const checkedOutRef = await this.#git(["symbolic-ref", "--quiet", "HEAD"], {
      cwd: worktree.path,
      redactionValues,
      allowedExitCodes: [0, 1],
    });
    if (
      checkedOutRef.exitCode !== 0 ||
      checkedOutRef.stdout.toString("utf8").trim() !== branchRef
    ) {
      throw new Error(
        `refusing to diff outside engine-created branch ${worktree.branch}`,
      );
    }
    const parent = await this.#revParse(
      worktree.repositoryPath,
      branchRef,
      redactionValues,
    );

    const patch = await this.#withSanitizedTree(
      worktree.path,
      parent,
      redactionValues,
      linkedSecretPaths,
      "scratch",
      async (tree, env) => {
        const result = await this.#git([...DIFF_ARGS, parent, tree, "--"], {
          cwd: worktree.path,
          env: { ...env, ...DIFF_CONFIG_ENV },
          redactionValues,
        });
        return result.stdout.toString("utf8");
      },
    );
    // Redacted a second time, over the assembled text, even though every blob
    // and every path in the tree above was already redacted byte-for-byte. The
    // two passes catch different things: the tree pass covers file content,
    // this one covers anything git itself put in the patch, and it covers a
    // secret that entered the inventory only after the parent commit was
    // written — whose old value is still sitting in the patch's `-` lines.
    return boundPatch(
      redactText(stripIndexLines(patch), redactionValues),
      spec.maxCharacters,
    );
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
    const finalize = spec.finalize !== false;
    const prospectiveRef = finalize
      ? `refs/heads/${session.integrationBranch}`
      : `refs/heads/${session.baseBranch}`;
    const prospectiveHead = finalize
      ? await this.#materializeIntegrationBranch(state.sessionState)
      : await this.#verifiedAccumulatedHead(state.sessionState);
    const sliceHead = state.sessionState.sliceHeads.get(spec.worktree.branch);
    if (sliceHead === undefined) {
      throw new Error(`missing recorded head for ${spec.worktree.branch}`);
    }
    const ancestor = await this.#git(
      ["merge-base", "--is-ancestor", sliceHead, prospectiveHead],
      { cwd: repositoryPath, redactionValues, allowedExitCodes: [0, 1] },
    );
    if (ancestor.exitCode === 0) {
      return {
        status: "already-integrated",
        commit: prospectiveHead,
        integrationBranch: session.integrationBranch,
      };
    }

    const merge = await this.#git(
      ["merge-tree", "--write-tree", prospectiveHead, sliceHead],
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
      [prospectiveHead, sliceHead],
      message,
      redactionValues,
    );
    await this.#git(["update-ref", prospectiveRef, commit, prospectiveHead], {
      cwd: repositoryPath,
      redactionValues,
    });
    if (!finalize) {
      state.sessionState.accumulatedHead = commit;
    }
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
    // Deleted with the handle rather than lazily: a stale entry would let
    // `diffUncommitted` resolve a path whose directory no longer exists, and
    // the failure would arrive from git as an unrecognisable cwd error instead
    // of this engine's own "not registered" refusal.
    if (state.indexKey !== null) {
      this.#isolatedByPath.delete(state.indexKey);
    }
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
      [`refs/heads/${session.baseBranch}`, state.accumulatedHead],
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
    const baseHead = await this.#verifiedAccumulatedHead(state);
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

    const transaction = ["start", `delete ${baseRef} ${baseHead}`];
    for (const [branch, head] of state.sliceHeads) {
      transaction.push(`delete refs/heads/${branch} ${head}`);
    }
    transaction.push("prepare", "commit", "");
    await this.#git(["update-ref", "--stdin"], {
      cwd: session.repositoryPath,
      input: transaction.join("\n"),
      redactionValues,
    });
    const zeroObjectId = "0".repeat(baseHead.length);
    try {
      await this.#git(["update-ref", integrationRef, baseHead, zeroObjectId], {
        cwd: session.repositoryPath,
        redactionValues,
      });
    } catch (error) {
      const restore = ["start", `create ${baseRef} ${baseHead}`];
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
    return baseHead;
  }

  async #verifiedAccumulatedHead(state: SessionState): Promise<string> {
    const { session, redactionValues } = state;
    const head = await this.#revParse(
      session.repositoryPath,
      `refs/heads/${session.baseBranch}`,
      redactionValues,
    );
    if (head !== state.accumulatedHead) {
      throw new Error(
        `scratch base branch ${session.baseBranch} moved unexpectedly`,
      );
    }
    return head;
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
    return await this.#withSanitizedTree(
      cwd,
      parent,
      redactionValues,
      linkedSecretPaths,
      "repository",
      async (tree) => tree,
    );
  }

  /**
   * Stage the working tree into a sanitized tree object and hand it to `use`.
   *
   * ONE PIPELINE, TWO DESTINATIONS, AND THAT IS THE WHOLE POINT OF THE
   * PARAMETER. `commit()` needs the tree and its blobs to survive in the
   * repository's object database, because a commit is about to point at them.
   * `diffUncommitted()` needs the identical tree and must leave nothing behind,
   * because the slice it describes may be rejected seconds later. Git object
   * ids are content hashes, so the two destinations produce the SAME ids from
   * the same working tree — which is what lets the diff promise it shows the
   * change `commit()` will record, rather than a second opinion about it.
   *
   * Writing the diff's objects into the real store instead would be simpler by
   * one parameter and would leave a rejected slice's blobs unreferenced in the
   * user's repository, once per rejection, forever.
   */
  async #withSanitizedTree<T>(
    cwd: string,
    parent: string,
    redactionValues: readonly string[],
    linkedSecretPaths: readonly string[],
    // Named `store` rather than `destination` because a local of that name
    // already exists in the loop below — it is the REDACTED PATH an entry is
    // staged at — and two different `destination`s in one function is exactly
    // how a reader (or a mutation test) ends up comparing a path to a store.
    store: "repository" | "scratch",
    use: (tree: string, env: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    await this.#assertLfsIsNotEnabled(cwd, redactionValues);
    return await this.#withTemporaryStagingStore(
      cwd,
      redactionValues,
      async ({ scratchEnv, realEnv }) => {
        const targetEnv = store === "repository" ? realEnv : scratchEnv;
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
                  targetEnv,
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

        // Every blob now exists in the destination store and every path is
        // sanitized, so tree creation can safely target it too.
        const result = await this.#git(["write-tree"], {
          cwd,
          env: targetEnv,
          redactionValues,
        });
        return await use(result.stdout.toString("utf8").trim(), targetEnv);
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
      // A value made only of line breaks is indistinguishable from the
      // structure of a line-oriented artifact. Treating it as a secret would
      // replace unrelated separators (and, in a diff, unrelated blank lines).
      .filter((value) => /[^\r\n]/.test(value))
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

/**
 * A path with every symbolic link resolved, or its lexically resolved form when
 * nothing is there to resolve.
 *
 * The fallback is narrow on purpose: only a genuinely absent path takes it, and
 * it exists so that `diffUncommitted("/nowhere")` fails this engine's own
 * "not registered" refusal instead of surfacing a raw ENOENT from `realpath`.
 * Any other filesystem error — a component that is a file, a symlink loop —
 * still propagates, because a path that exists and cannot be resolved is not a
 * path this engine may quietly guess about.
 */
async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (isMissingFileError(error)) {
      return resolved;
    }
    throw error;
  }
}

/** Drop the `index <old>..<new>` header lines. See `DIFF_INDEX_LINE`. */
function stripIndexLines(patch: string): string {
  if (patch === "") {
    return "";
  }
  return patch
    .split("\n")
    .filter((line) => !DIFF_INDEX_LINE.test(line))
    .join("\n");
}

/**
 * Cut a patch to the caller's bound and say so inside the text.
 *
 * IT CUTS AT A LINE BOUNDARY WHEN IT CAN. A patch severed mid-line reads as a
 * change that was never proposed — half a condition, an unterminated string —
 * and a reader has no way to tell that from the real thing. When the window
 * holds no newline at all (one enormous minified line), it cuts at the limit
 * and steps back off a lone surrogate, because splitting a surrogate pair
 * produces a replacement character rather than a shorter string.
 */
function boundPatch(patch: string, maxCharacters: number): UncommittedDiff {
  const totalCharacters = patch.length;
  if (totalCharacters <= maxCharacters) {
    return { patch, truncated: false, totalCharacters };
  }
  const lastNewline = patch.lastIndexOf("\n", maxCharacters - 1);
  let cut = maxCharacters;
  if (lastNewline > 0) {
    cut = lastNewline + 1;
  } else if (isHighSurrogate(patch.charCodeAt(cut - 1))) {
    cut -= 1;
  }
  const kept = patch.slice(0, cut);
  const separator = kept.endsWith("\n") ? "" : "\n";
  return {
    patch: `${kept}${separator}[brigadier: this diff was truncated; ${cut} of ${totalCharacters} characters shown]\n`,
    truncated: true,
    totalCharacters,
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Replace verbatim secrets, including the exact line-oriented form Git emits.
 *
 * A multiline value in a deleted diff line is no longer contiguous: Git puts
 * `-` after every internal newline (`first\n-second`). Added and context lines
 * have the same shape with `+` and space. The matcher below still requires the
 * complete value in order; no component line is ever redacted on its own.
 *
 * `onScan` is deliberately injectable so the termination test can count
 * searches and throw at a fixed operation budget instead of relying on time.
 */
export function redactText(
  value: string,
  redactionValues: readonly string[],
  onScan?: () => void,
): string {
  let redacted = value;
  for (const secret of redactionValues) {
    // Empty and line-break-only values cannot be secrets in a line-oriented
    // artifact without also being its structure. This guard also makes every
    // search below non-empty, so its cursor must advance after every match.
    if (!/[^\r\n]/.test(secret)) {
      continue;
    }
    redacted = replaceLiteral(redacted, secret, REDACTION_MARKER, onScan);
    if (!secret.includes("\n")) {
      continue;
    }
    redacted = replaceArtifactSplitLiteral(
      redacted,
      secret,
      REDACTION_MARKER,
      onScan,
    );
  }
  return redacted;
}

function replaceArtifactSplitLiteral(
  source: string,
  secret: string,
  replacement: string,
  onScan?: () => void,
): string {
  const lines = secret.split("\n");
  const insertedPrefixCount = lines.length - 1 - (lines.at(-1) === "" ? 1 : 0);
  if (insertedPrefixCount <= 0) {
    return source;
  }

  // The first line may be empty, but the anchor never is. A non-empty anchor
  // is the progress invariant that rules out indexOf("") pinning at `length`.
  const firstLine = lines[0] ?? "";
  const anchor = firstLine === "" ? "\n" : firstLine;
  const chunks: string[] = [];
  let outputCursor = 0;
  let searchCursor = 0;
  while (searchCursor <= source.length) {
    onScan?.();
    const candidate = source.indexOf(anchor, searchCursor);
    if (candidate === -1) {
      break;
    }
    const end = artifactSplitMatchEnd(source, candidate, lines, onScan);
    if (end === null) {
      searchCursor = candidate + 1;
      continue;
    }
    chunks.push(source.slice(outputCursor, candidate), replacement);
    outputCursor = end;
    searchCursor = end;
  }
  if (chunks.length === 0) {
    return source;
  }
  chunks.push(source.slice(outputCursor));
  return chunks.join("");
}

function artifactSplitMatchEnd(
  source: string,
  start: number,
  lines: readonly string[],
  onScan?: () => void,
): number | null {
  const firstLine = lines[0] ?? "";
  let cursor = start + firstLine.length;
  for (let index = 1; index < lines.length; index += 1) {
    onScan?.();
    if (source[cursor] !== "\n") {
      return null;
    }
    cursor += 1;
    const line = lines[index] ?? "";
    const isTerminalNewline = index === lines.length - 1 && line === "";
    if (isTerminalNewline) {
      return cursor;
    }
    if (
      !(ARTIFACT_LINE_PREFIXES as readonly string[]).includes(
        source[cursor] ?? "",
      )
    ) {
      return null;
    }
    cursor += 1;
    if (!source.startsWith(line, cursor)) {
      return null;
    }
    cursor += line.length;
  }
  return cursor;
}

function replaceLiteral(
  source: string,
  search: string,
  replacement: string,
  onScan?: () => void,
): string {
  if (search.length === 0) {
    return source;
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor <= source.length) {
    onScan?.();
    const match = source.indexOf(search, cursor);
    if (match === -1) {
      chunks.push(source.slice(cursor));
      break;
    }
    chunks.push(source.slice(cursor, match), replacement);
    cursor = match + search.length;
  }
  return chunks.join("");
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
