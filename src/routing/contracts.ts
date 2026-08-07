/**
 * The routing vocabulary. WO-009A owns this file and may amend it freely; it
 * must not add its members to the frozen `src/contracts.ts`.
 *
 * Decision #7 fixes the pipeline as `capability filter → competence rank →
 * difficulty → effort → cost`, and fixes what may enter it. **Vendor is never
 * an input.** There is deliberately no `preferVendor`, no `vendorHint`, and no
 * per-task vendor table anywhere in these types: the candidate pool is every
 * configured model from every configured vendor competing on one scale, and the
 * only way to move a model up that scale is to edit the competence matrix,
 * where the change is visible in a diff. A router written by one vendor's model
 * drifts toward that vendor unless the ranking is data; this shape is what
 * keeps it data.
 *
 * The pipeline is also pure. Everything it needs — config, capabilities, quota
 * — arrives in `RoutingInput`, so routing decisions are reproducible from a
 * literal and testable without a subprocess, a network call, or a clock.
 */

import type { BrigadierConfig } from "../config/contracts.js";
import type {
  Capability,
  Effort,
  QuotaSnapshot,
  Slice,
  Vendor,
} from "../contracts.js";

/**
 * How hard the planner judged this slice. Not a vendor or model hint.
 *
 * These three words are the planner's entire influence over which model runs a
 * slice. A planner that wants a specific model has to say why the work is hard,
 * which is a claim a reviewer can check against the slice.
 */
export type SliceDifficulty = "routine" | "standard" | "hard";

/**
 * Capabilities a slice actually needs. Absent/false means "does not require
 * it" — never "prefers not to have it". A requirement removes models; it never
 * ranks them.
 */
export interface SliceRequirements {
  readonly imageInput?: boolean;
  readonly webSearch?: boolean;
  readonly structuredOutput?: boolean;
  readonly minContextWindowTokens?: number;
}

export interface RoutingRequest {
  readonly slice: Slice;
  readonly difficulty: SliceDifficulty;
  readonly requires?: SliceRequirements;
  /**
   * True only when this slice already ran and failed its gate. This is the ONLY
   * thing that can unlock `xhigh` (decisions #9/#20): above `high`, models take
   * longer, burn more tokens, hallucinate more, and do worse work, so the top
   * rung is earned by an observed failure and never predicted from a planner's
   * opinion of the work.
   */
  readonly escalated?: boolean;
}

/**
 * Everything the pipeline reads. All three are snapshots supplied by the
 * caller: the router never loads config, probes a capability, or asks a vendor
 * about quota, because a routing decision that reaches the outside world cannot
 * be replayed from a test literal.
 */
export interface RoutingInput {
  readonly config: BrigadierConfig;
  readonly capabilities: readonly Capability[];
  readonly quota: readonly QuotaSnapshot[];
}

export interface RoutedWorker {
  readonly vendor: Vendor;
  readonly model: string;
  readonly effort: Effort;
  /**
   * Ordered, human-readable trace of why. One line per pipeline stage, naming
   * the concrete values that decided it — the scores, the floor, the base
   * effort, the clamp that applied, whether quota removed a vendor. The
   * supervisor prints this, and it is the only way a user can tell a routing
   * bug from a routing decision they disagree with.
   */
  readonly rationale: readonly string[];
  /**
   * True only when the winner came from a vendor reporting exhausted quota, via
   * that vendor's configured `quotaFallbackModel`, on the last-resort path
   * where the difficulty floor was waived.
   *
   * It is a statement about *where the slice ran*, not about how good the model
   * is. It does not mean the model is weaker than the slice asked for: a user
   * whose only vendor is drained and who configured their strongest model as
   * its own substitution gets that model, above the floor, with this flag set.
   * Nor does a waived floor imply this flag: when the floor is waived, healthy
   * models the floor had rejected compete in the same salvage pool, and a
   * healthy winner leaves this `false` because its work ran on quota brigadier
   * believes is there.
   *
   * What a caller can rely on: `true` means the run is leaning on the user's
   * configured substitution for an account that just said it had nothing left,
   * so retrying the same slice will keep landing there until quota returns.
   */
  readonly usedQuotaFallback: boolean;
}

export type RoutingFailureReason =
  /** No vendor in the config lists a model. `brigadier init` was never run. */
  | "NO_CONFIGURED_MODELS"
  /** Models exist, but none survived the capability, competence, or effort stages. */
  | "NO_CAPABLE_MODEL"
  /** Every model was removed by quota exhaustion, and no fallback was usable. */
  | "ALL_VENDORS_EXHAUSTED";

export type RoutingDecision =
  | { readonly ok: true; readonly routed: RoutedWorker }
  | {
      readonly ok: false;
      readonly reason: RoutingFailureReason;
      readonly message: string;
      /** Every model considered and the stage that eliminated it. */
      readonly rejected: readonly RoutingRejection[];
    };

/**
 * One eliminated model. Carried on failure only, where "brigadier could not
 * route this" is useless without "and here is what it looked at": the stage
 * names which rule removed the model, and the reason names the concrete values
 * that rule compared.
 */
export interface RoutingRejection {
  readonly vendor: Vendor;
  readonly model: string;
  readonly stage: "quota" | "capability" | "competence" | "effort";
  readonly reason: string;
}
