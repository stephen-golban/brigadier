/**
 * WO-003 owns these worktree contracts and may amend them freely within this
 * file. WO-003 must not add their members to the frozen `src/contracts.ts`.
 */

export interface WorktreeSpec {
  readonly repositoryPath: string;
  readonly baseRef: string;
  readonly branch: string;
}

export interface CreatedWorktree {
  readonly path: string;
  readonly branch: string;
}

/** Creates and removes isolated working directories for worker cwd values. */
export interface WorktreeEngine {
  create(spec: WorktreeSpec): Promise<CreatedWorktree>;
  remove(worktree: CreatedWorktree): Promise<void>;
}
