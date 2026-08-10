/**
 * The supervisor unit's barrel — curated, for the same reason `plan` and
 * `routing` are.
 *
 * What belongs here is the set of entry points a caller composes a run out of,
 * plus the vocabulary needed to call them and to read what they return.
 * `brigadier run` is not one function: a composition root has to parse an
 * untrusted plan (`parsePlanDocument`), bridge its config into router facts
 * (`buildCapabilities`), prove its environment can launch anything
 * (`requireLaunchEnv`), build the thing that runs one slice
 * (`createSliceRunner`), and only then build the thing that runs the plan
 * (`createRunner`). All six are API, because a consumer that cannot reach one
 * of them cannot assemble the other five into anything that works.
 * `buildWorkerSpec` joins them: it is the documented bridge from a routing
 * decision to the frozen `WorkerSpec` every adapter launches, and it is what a
 * caller supplying its own `SliceRunner` needs.
 *
 * `PlanDocumentError` is exported with `parsePlanDocument` because its `issues`
 * array is the product of a failed parse, not decoration on it — a caller that
 * can only catch `Error` can render one joined sentence where the parser
 * collected the whole repair.
 *
 * THE REVIEW GATE IS API IN TWO PIECES, and they answer different needs.
 * `createCrossVendorReviewer` is the gate itself, which a consumer assembling
 * its own `SliceRunner` needs in order to keep the product's differentiating
 * behaviour rather than silently losing it. `runOneShotPrompt` is the primitive
 * underneath it: one prompt, one model, text back, no worktree and no commit.
 * That capability did not exist anywhere in this package before — every
 * `Worker.spawn` call site sat inside the slice runner and required a live
 * `CreatedWorktree` — and it is exported rather than hidden because the review
 * gate is not its only caller. `SliceReviewer` and the `SliceReview` vocabulary
 * come with them, since a caller supplying its own gate has to be able to spell
 * a verdict, and a caller reading a `RunReport` has to be able to read one.
 *
 * `spawnWorker` (`./one-shot.js`) and `parseFindings` (`./review.js`) are NOT
 * here. The first is the vendor-correlation guard the two spawn sites share;
 * the second is the tolerance of one build's reviewer-reply format, which must
 * stay free to change as the vendors' output does. Both are exported from their
 * modules so their own tests can drive them directly.
 *
 * The four constants are report vocabulary, not configuration. `ATTEMPT_LIMIT`
 * is the only thing that explains why `SliceResult.attempts` is never longer
 * than two, and `SLICE_FAILURE_KINDS` / `RUN_FAILURE_REASONS` /
 * `REVIEW_SKIP_REASONS` exist so a caller can iterate the failure taxonomy —
 * render a legend, build a counter — without a `switch` that silently
 * under-reports the day a member is added. Exporting them freezes nothing that
 * was not already frozen by the unions they mirror.
 *
 * WHAT IS DELIBERATELY NOT HERE, all of it exported from its own module and
 * none of it API:
 *
 * - `allocateAttemptSlots` and `runBounded` (`./orchestrator.js`) are the
 *   orchestrator's numbering scheme and its worker pool. The numbering is a
 *   contract with `GitWorktreeEngine`'s branch refs rather than with a
 *   consumer — slot N-1 for attempt N, advancing by `ATTEMPT_LIMIT` per slice —
 *   and exporting it would turn an implementation detail that must be free to
 *   change alongside the engine into a promise. They are exported from the
 *   module so the orchestrator's own tests can drive them directly.
 * - `DefaultSliceRunner` (`./slice.js`) is the class behind `createSliceRunner`.
 *   The factory is the supported construction; the class is named so the unit's
 *   tests can reach the `route` seam that exists only to assert the exact
 *   `RoutingRequest` an escalation builds.
 * - `interruptExitCode` and `interruptMessage` (`./contracts.js`) are how the
 *   CLI turns an abort reason into a process exit code and a sentence. The
 *   TYPES that reason is built from — `RunInterruption`, `InterruptSignal` —
 *   are exported above, because a consumer aborting `RunRequest.signal` needs
 *   to construct one for the report to name the signal. The two functions are
 *   not: 130 and 143 are a promise `brigadier`-the-executable makes to a shell,
 *   not one this package makes to a library consumer, and a consumer who wants
 *   that mapping is better served writing the two lines than inheriting a
 *   commitment to them.
 * - `CAPABILITY_TABLE`, `CapabilityRule`, and `matchCapabilityRule`
 *   (`./capabilities.js`) are the pattern-matching implementation behind
 *   `buildCapabilities`. This is NOT the `COMPETENCE_TABLE` case: that table is
 *   API because decision #7 rests on the *ranking* being data a user can open
 *   and argue with, and no function derives a better artifact from it. Here the
 *   derived artifact is strictly more useful than its source — `Capability[]`
 *   states this machine's configured models, their surviving effort rungs, and
 *   their context windows, where the table states regexes — so a consumer
 *   auditing what brigadier believes should read the answer, not the lookup.
 */

export { buildCapabilities } from "./capabilities.js";
export type {
  AttemptSlot,
  InterruptSignal,
  PlanDocument,
  RejectedSliceReview,
  ReviewerIdentity,
  ReviewFinding,
  ReviewSeverity,
  ReviewSkipReason,
  RunFailureReason,
  RunInterruption,
  RunReport,
  RunRequest,
  SliceAttempt,
  SliceDirective,
  SliceFailure,
  SliceFailureKind,
  SliceMergeRecord,
  SliceResult,
  SliceReview,
  SliceReviewer,
  SliceReviewRequest,
  SliceRunInput,
  SliceRunner,
  SupervisorPorts,
} from "./contracts.js";
export {
  ATTEMPT_LIMIT,
  REVIEW_SKIP_REASONS,
  RUN_FAILURE_REASONS,
  SLICE_FAILURE_KINDS,
} from "./contracts.js";
export type { OneShotEnv, OneShotRequest, OneShotResult } from "./one-shot.js";
export { runOneShotPrompt } from "./one-shot.js";
export type { RunnerDependencies, RunOrchestrator } from "./orchestrator.js";
export { createRunner } from "./orchestrator.js";
export { PlanDocumentError, parsePlanDocument } from "./plan-document.js";
export type { CrossVendorReviewerOptions } from "./review.js";
export { createCrossVendorReviewer } from "./review.js";
export type { LaunchEnv, SliceRunnerOptions } from "./slice.js";
export { createSliceRunner, requireLaunchEnv } from "./slice.js";
export type { SpecBuildInput } from "./spec.js";
export { buildWorkerSpec } from "./spec.js";
