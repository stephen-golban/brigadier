import type { Effort, Vendor } from "../contracts.js";
import type { PlanDocument } from "../supervisor/index.js";

/** Who was asked to plan. Reported so a run says which model wrote its plan. */
export interface PlannerIdentity {
  readonly vendor: Vendor;
  readonly model: string;
  readonly effort: Effort;
}

/** One request to turn a task description into a plan. */
export interface PlannerRequest {
  /** The user's words, verbatim. Never rewritten before the model sees them. */
  readonly task: string;
  /** The repository the planner may READ. Nothing under it is writable. */
  readonly cwd: string;
  /**
   * The fan-out budget: the largest number of slices this plan may contain.
   *
   * Decision #8 — fan-out is earned. This is 1 unless the user raised it with
   * `--max-workers`, and it is enforced deterministically after the model
   * answers rather than merely requested in the prompt.
   */
  readonly maxSlices: number;
  readonly signal?: AbortSignal;
}

/**
 * What a planning attempt produced.
 *
 * `needs-human` is a FIRST-CLASS OUTCOME, not an error arm. Decision #10 says
 * brigadier refuses to guess on a genuinely ambiguous task: it spawns nothing,
 * creates nothing, and hands back questions. A user holding questions has not
 * had a run fail, which is why this is a separate member from `failed` and why
 * the CLI gives it its own exit code.
 */
export type PlannerOutcome =
  | {
      readonly kind: "planned";
      /**
       * Produced by `parsePlanDocument` and by nothing else. See the boundary
       * ruling in `planner.ts`.
       */
      readonly document: PlanDocument;
      /**
       * The accepted plan, re-serialized as JSON, for printing and for saving.
       * A user whose planned run fails can write this to a file and re-run it
       * with `--plan`, which is the only way a model-authored plan becomes an
       * artifact a human can edit.
       */
      readonly json: string;
      readonly planner: PlannerIdentity;
    }
  | {
      readonly kind: "needs-human";
      /** Non-empty, control-character-free, and bounded. */
      readonly questions: readonly string[];
      readonly planner: PlannerIdentity;
    }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The seam `brigadier run "<task>"` is built on.
 *
 * An interface rather than a bare function so a test can hand the CLI a planner
 * that answers from a literal, with no subprocess, no model, and no network —
 * the same way `RunHarness` already replaces the worktree engine and the slice
 * runner.
 */
export interface Planner {
  plan(request: PlannerRequest): Promise<PlannerOutcome>;
}
