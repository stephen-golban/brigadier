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
      /** The integration ref is unchanged when this result is returned. */
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
}
