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
   * True only when this slice is running on a model that scored *below* the
   * floor its own difficulty sets — the last-resort path, reachable only for a
   * user who set `allowDegradedRouting` in their config.
   *
   * This is a statement about *how good the model is for this work*, and it is
   * the only claim of that shape the router can honestly make. It replaces
   * `usedQuotaFallback`, which claimed something about *where the slice ran* —
   * "the winner is an exhausted account's configured substitution" — that
   * per-model quota metering (WO-010B) made unreachable and WO-010H deleted.
   * A user whose Opus limit ran out and whose slice went to Sonnet is not
   * running on quota brigadier believes is spent, and the old flag was already
   * documented as false for them; there is now no case where it would have been
   * true, so the flag that survives is the one with a subject.
   *
   * What a caller can rely on: `true` means the work is being done by a model
   * the difficulty rule would normally have rejected, so a bad result is a
   * predictable outcome rather than a surprise, and the fix is more capacity or
   * a smaller slice rather than a retry. `false` means the winner cleared its
   * floor on merit — including every case where quota removed a stronger
   * sibling and a healthy weaker model won the ordinary pipeline outright.
   *
   * It says nothing about quota. A slice can waive the floor on a machine with
   * no quota pressure at all, simply because nothing configured is strong
   * enough for the work.
   */
  readonly waivedDifficultyFloor: boolean;
}

export type RoutingFailureReason =
  /** No vendor in the config lists a model. `brigadier init` was never run. */
  | "NO_CONFIGURED_MODELS"
  /** Models exist, but none survived the capability, competence, or effort stages. */
  | "NO_CAPABLE_MODEL"
  /** Quota exhaustion removed every model of every configured vendor. */
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
