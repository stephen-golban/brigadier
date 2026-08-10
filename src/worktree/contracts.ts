/**
 * WO-003 owns these worktree contracts and may amend them freely within this
 * file. WO-003 must not add their members to the frozen `src/contracts.ts`.
 */

/** Mandatory policy for linked secret files and verbatim-value redaction. */
export interface LinkedSecretsPolicy {
  /** Repository-relative files that are never allowed into a Brigadier commit. */
  readonly linkedPaths: readonly string[];
  /** Separate, explicit consent to make the files visible in worker worktrees. */
  readonly consentToLink?: boolean;
  /**
   * Additional exact values to redact. Use this for formats the best-effort
   * raw/dotenv/JSON/YAML inventory cannot interpret reliably.
   */
  readonly redactionValues?: readonly string[];
}

/** Inputs used to capture one immutable scratch base for a Brigadier run. */
export interface WorktreeSessionSpec {
  readonly repositoryPath: string;
  readonly slug: string;
  /** Defaults to HEAD. The captured tree still comes from the current worktree. */
  readonly baseRef?: string;
  /** Gitignored dependency paths to seed into every isolated worktree. */
  readonly dependencyPaths?: readonly string[];
  readonly secrets: LinkedSecretsPolicy;
}

/** Opaque session value returned by the engine that created it. */
export interface WorktreeSession {
  readonly repositoryPath: string;
  readonly slug: string;
  readonly baseCommit: string;
  /** Retired with slice refs when the prefix-conflicting integration ref is materialized. */
  readonly baseBranch: string;
  readonly integrationBranch: string;
}

export interface WorktreeSpec {
  readonly session: WorktreeSession;
  /** A positive integer used to create `brigadier/<slug>/slice-N`. */
  readonly slice: number;
  /** Required for isolated worktrees and ignored for unsafe in-place work. */
  readonly path?: string;
  /**
   * Uses the source checkout directly. This exposes every file already visible
   * there, including dependencies and linked-secret files, regardless of the
   * isolated-worktree consent/seeding policy.
   */
  readonly unsafeInPlace?: boolean;
}

export interface CreatedWorktree {
  readonly repositoryPath: string;
  readonly path: string;
  readonly branch: string;
  readonly isolated: boolean;
  readonly session: WorktreeSession;
}

export interface CommitSpec {
  readonly worktree: CreatedWorktree;
  readonly message: string;
}

export interface CommitResult {
  readonly commit: string;
  readonly message: string;
}

export interface MergeSpec {
  readonly worktree: CreatedWorktree;
  readonly message?: string;
  /**
   * Defaults to true. Set false while reconciling an execution wave: the merge
   * advances the session's scratch base, so worktrees created for later waves
   * start from the accumulated result, without materializing the
   * prefix-conflicting integration branch yet.
   */
  readonly finalize?: boolean;
}

/**
 * `integrationBranch` always names the eventual final branch. A scratch merge
 * (`finalize: false`) returns that name before the ref itself is materialized.
 */
export type MergeResult =
  | {
      readonly status: "merged";
      readonly commit: string;
      readonly integrationBranch: string;
    }
  | {
      readonly status: "already-integrated";
      readonly commit: string;
      readonly integrationBranch: string;
    }
  | {
      /**
       * Before any scratch merge, a first merge cannot conflict provided
       * nothing outside the engine writes into its ref namespace: both heads
       * descend from `baseCommit`. After a `finalize: false` merge advances the
       * scratch base, another slice from the same wave may genuinely conflict
       * with it. The initial-merge property remains conditional rather than
       * enforced: `commit()` reads the slice ref's current head without
       * comparing it to the recorded head, so an external ref move can put the
       * slice commit on a foreign parent. A conflict leaves the prospective
       * head and every ref unchanged.
       */
      readonly status: "conflicted";
      readonly integrationBranch: string;
      readonly details: string;
    };

export interface WorktreeEngineOptions {
  /** Per-process bound. Defaults to 30 seconds. */
  readonly commandTimeoutMs?: number;
}

/** What to diff, and how much of the answer the caller is willing to hold. */
export interface UncommittedDiffSpec {
  /**
   * An isolated worktree this engine created and has not removed, named by its
   * path rather than by its `CreatedWorktree` handle.
   *
   * THE PATH IS THE KEY BECAUSE THE ONLY CALLER HAS NOTHING ELSE. The
   * cross-vendor review gate is handed a `SliceReviewRequest`, which carries
   * `worktreePath` and no handle, and the gate is constructed once per run
   * rather than once per slice. A handle-taking method would be unreachable
   * from the one place that needs it.
   *
   * IT IS STILL NOT A PATH THIS ENGINE TRUSTS. The path is canonicalized
   * through `realpath` and must match — exactly — the canonical path of a
   * worktree this engine created and still holds. Everything the diff is then
   * computed from (the branch, its head, the session's redaction inventory)
   * comes from that registered worktree, never from the argument, and the
   * checked-out `HEAD` is re-proven to be the engine-created branch before
   * anything is read. An unregistered path is refused rather than diffed.
   */
  readonly worktreePath: string;
  /**
   * Hard bound, in characters, on the patch text. A positive whole number;
   * anything else is a `RangeError`.
   *
   * The bound belongs to the caller because only the caller knows who is going
   * to read the answer. Truncation is never silent: see `UncommittedDiff`.
   */
  readonly maxCharacters: number;
}

/**
 * The uncommitted change in one isolated worktree, as a unified diff.
 *
 * WHAT MAKES IT THE SAME CHANGE `commit()` WILL RECORD, which is the only
 * property that makes this worth showing anyone. The patch is produced from the
 * identical sanitizing pipeline `commit()` runs — same parent, same `read-tree`
 * plus `add -A`, same linked-secret refusal, same byte-level redaction of every
 * blob and every path — and git object ids are content hashes, so the tree this
 * patch describes is bit-identical to the tree `commit()` writes from the same
 * working tree. The one thing it cannot promise is that nobody edits a file in
 * between; a diff is a statement about the moment it was taken.
 *
 * ITS OBJECTS DO NOT LAND IN THE USER'S REPOSITORY. The sanitized blobs and the
 * tree are written to the temporary object store the staging pass already
 * creates and deletes, rather than to the real one. A slice whose review
 * rejects it therefore leaves nothing behind — which is the difference between
 * a gate that can say no and a gate that litters the user's object database
 * every time it does.
 *
 * `patch` IS EMPTY EXACTLY WHEN `commit()` WOULD REFUSE with
 * `NoChangesToCommitError`. Both compare the same two trees, so "the diff is
 * empty" and "there is nothing to commit" are the same fact rather than two
 * opinions that could disagree.
 */
export interface UncommittedDiff {
  /**
   * The unified diff, already redacted, already bounded, and — when it was
   * bounded — already carrying its own truncation notice as its last line.
   *
   * THE NOTICE IS PART OF THE TEXT ON PURPOSE. A truncated diff handed to a
   * reader that was not told it was truncated is a reader who believes they saw
   * the whole change; making the notice a field the caller may forget to render
   * is how that happens. `truncated` and `totalCharacters` are for the report,
   * not for making the text honest — the text is already honest.
   *
   * Consequently the length may exceed `maxCharacters` by the length of that
   * one notice line, and only by that.
   */
  readonly patch: string;
  readonly truncated: boolean;
  /** The full length before truncation. Equal to `patch.length` when it is not. */
  readonly totalCharacters: number;
}

/**
 * Git-backed isolation and integration. Implementations never push and only
 * write commits to the `brigadier/<slug>/**` refs they create.
 *
 * Redaction replaces inventoried exact, verbatim secret values. It also catches
 * the same complete multiline value when a unified diff has inserted its
 * one-character content prefix after each internal newline. It does not redact
 * component lines independently, or detect encoded, transformed, truncated,
 * derived, or values hidden in unsupported file syntax. Values made only of
 * line breaks are ignored because they are indistinguishable from artifact
 * structure. Supply explicit redactionValues for values that cannot be
 * inventoried reliably.
 */
export interface WorktreeEngine {
  prepare(spec: WorktreeSessionSpec): Promise<WorktreeSession>;
  create(spec: WorktreeSpec): Promise<CreatedWorktree>;
  commit(spec: CommitSpec): Promise<CommitResult>;
  /**
   * The uncommitted change in one isolated worktree, as the diff `commit()`
   * would record. Throws when it cannot be produced.
   *
   * IT IS OPTIONAL ON THIS INTERFACE AND MANDATORY IN THE PRODUCT, and the
   * asymmetry is deliberate rather than an oversight. `WorktreeEngine` is
   * public API that consumers and test doubles implement; adding a required
   * member breaks every existing implementation, including three fakes in this
   * repository's own suite that exist precisely so the supervisor can be tested
   * without git. `GitWorktreeEngine` — the only engine `brigadier run` ever
   * constructs — always provides it, so the shipped gate always gets a diff.
   *
   * A caller that finds it absent must degrade VISIBLY. The review gate does:
   * it says so in the reviewer's prompt and on the run log, and reviews file
   * contents instead. That is the same fail-open trade the gate already makes
   * for a missing second vendor, and it obeys the same rule — a degraded gate
   * must never render as a passing one.
   *
   * IT REFUSES RATHER THAN GUESSES, in four cases, each of which would
   * otherwise produce a diff of something that is not this slice's work:
   *
   *   1. a path no worktree of this engine is registered at;
   *   2. a worktree created with `unsafeInPlace`, where the working tree is the
   *      user's own checkout and its uncommitted content includes the user's
   *      edits and every concurrent slice's — attributing that to one slice
   *      would be worse than showing no diff at all;
   *   3. a worktree whose `HEAD` is no longer the branch this engine created
   *      for it, which is the same refusal `commit()` makes;
   *   4. a tree containing a linked secret path, which `commit()` also refuses.
   */
  diffUncommitted?(spec: UncommittedDiffSpec): Promise<UncommittedDiff>;
  /**
   * With `finalize: false`, advances the scratch base used by subsequent
   * `create()` calls. The default materializes and advances the final
   * integration branch, after which no more slice worktrees may commit.
   */
  merge(spec: MergeSpec): Promise<MergeResult>;
  redact(worktree: CreatedWorktree, artifact: string): string;
  remove(worktree: CreatedWorktree): Promise<void>;
  /**
   * Retires every ref this engine created for `session` that has not already
   * been retired: the scratch base branch and every surviving slice branch.
   *
   * THE ACTIVE-WORKTREE CHECK COMES FIRST, AND THAT ORDER IS OBSERVABLE. If any
   * worktree created from this session is still active, this THROWS — including
   * on a run whose integration branch is already materialized and which
   * therefore has no ref left to retire. So "call it after a merge" is not
   * enough; it must be called after every `remove()`, and there is no ordering
   * in which calling it earlier is safe. Deleting a ref that a live worktree has
   * checked out would leave that worktree on a dangling HEAD, which is why the
   * check is unconditional rather than skipped when there is nothing to do.
   *
   * With no worktree active it is a no-op once the integration branch has been
   * materialized. At that point the base and slice refs are already gone, and
   * the slice commits survive only as parents of merge commits on
   * `brigadier/<slug>`, which brigadier must never delete.
   *
   * Idempotent. Never touches the user's branches and never deletes the
   * integration branch.
   *
   * OWNERSHIP IS INFERRED, NOT PROVEN, and the guarantee is exactly this: a ref
   * is deleted only when its NAME is one this engine created for `session` AND
   * its current object id still EQUALS the id this engine recorded for it. A ref
   * that moved fails the second test and throws `engine-created ref ... moved
   * unexpectedly` rather than being deleted, which is the property that makes a
   * concurrently advanced branch safe. It is not authorship: a ref somebody else
   * deleted and recreated at the same commit is indistinguishable from this
   * engine's own and would be deleted.
   */
  release(session: WorktreeSession): Promise<void>;
}
