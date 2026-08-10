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
}

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
       * Provided nothing outside the engine writes into the
       * `brigadier/<slug>/**` ref namespace while a run is live, a conflict is
       * only reachable after an earlier merge materialized the integration
       * branch: on the first merge its head is `baseCommit`, and every slice
       * head descends from that commit. This invariant is not enforced;
       * `commit()` reads the slice ref's current head without verifying it
       * against the recorded head, so an external ref move can make the first
       * merge conflict. A conflict leaves the existing integration ref
       * unchanged and retires no ref.
       */
      readonly status: "conflicted";
      readonly integrationBranch: string;
      readonly details: string;
    };

export interface WorktreeEngineOptions {
  /** Per-process bound. Defaults to 30 seconds. */
  readonly commandTimeoutMs?: number;
}

/**
 * Git-backed isolation and integration. Implementations never push and only
 * write commits to the `brigadier/<slug>/**` refs they create.
 *
 * Redaction replaces inventoried exact, verbatim secret values. Inventory is
 * best-effort; it cannot detect encoded, transformed, truncated, derived, or
 * values hidden in unsupported file syntax. Supply explicit redactionValues
 * for values that cannot be inventoried reliably.
 */
export interface WorktreeEngine {
  prepare(spec: WorktreeSessionSpec): Promise<WorktreeSession>;
  create(spec: WorktreeSpec): Promise<CreatedWorktree>;
  commit(spec: CommitSpec): Promise<CommitResult>;
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
