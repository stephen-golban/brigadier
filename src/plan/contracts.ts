/**
 * WO-009B owns the plan-validation vocabulary. It remains separate from the
 * frozen worker contracts because planning can evolve without widening the
 * launch protocol shared by every adapter.
 */

export type PlanIssueCode =
  | "EMPTY_PLAN"
  | "DUPLICATE_SLICE_ID"
  | "NO_OWNED_PATHS"
  | "INVALID_PATH"
  | "GLOB_PATH"
  | "PATH_CONFLICT"
  | "UNKNOWN_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "DEPENDENCY_CYCLE";

/** One independently actionable reason a proposed plan cannot be scheduled. */
export interface PlanIssue {
  readonly code: PlanIssueCode;
  readonly message: string;
  /** Every implicated id is retained so a conflict never blames one claimant. */
  readonly sliceIds: readonly string[];
  /** Worktree-relative, normalized paths are included only for path issues. */
  readonly paths: readonly string[];
}

export type PlanValidation =
  | {
      readonly ok: true;
      /**
       * Every member of a wave has all dependencies satisfied by prior waves.
       * Waves describe structure, not a concurrency limit. Fan-out remains an
       * explicit supervisor decision because `RunRequest.maxWorkers` is
       * required rather than supplied by a library default.
       */
      readonly waves: readonly (readonly string[])[];
      /** The scheduler and sandbox consume the same canonical path spellings. */
      readonly normalizedPaths: ReadonlyMap<string, readonly string[]>;
    }
  | {
      readonly ok: false;
      /** All detected defects are returned together to avoid repair/retry loops. */
      readonly issues: readonly PlanIssue[];
    };
