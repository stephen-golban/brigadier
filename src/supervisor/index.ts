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
 * The three constants are report vocabulary, not configuration. `ATTEMPT_LIMIT`
 * is the only thing that explains why `SliceResult.attempts` is never longer
 * than two, and `SLICE_FAILURE_KINDS` / `RUN_FAILURE_REASONS` exist so a caller
 * can iterate the failure taxonomy — render a legend, build a counter — without
 * a `switch` that silently under-reports the day a member is added. Exporting
 * them freezes nothing that was not already frozen by the unions they mirror.
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
  PlanDocument,
  RunFailureReason,
  RunReport,
  RunRequest,
  SliceAttempt,
  SliceDirective,
  SliceFailure,
  SliceFailureKind,
  SliceMergeRecord,
  SliceResult,
  SliceRunInput,
  SliceRunner,
  SupervisorPorts,
} from "./contracts.js";
export {
  ATTEMPT_LIMIT,
  RUN_FAILURE_REASONS,
  SLICE_FAILURE_KINDS,
} from "./contracts.js";
export type { RunnerDependencies, RunOrchestrator } from "./orchestrator.js";
export { createRunner } from "./orchestrator.js";
export { PlanDocumentError, parsePlanDocument } from "./plan-document.js";
export type { LaunchEnv, SliceRunnerOptions } from "./slice.js";
export { createSliceRunner, requireLaunchEnv } from "./slice.js";
export type { SpecBuildInput } from "./spec.js";
export { buildWorkerSpec } from "./spec.js";
