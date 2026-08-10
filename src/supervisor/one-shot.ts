/**
 * Run one prompt against one vendor CLI and get its text back.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. Until this file, the only way to reach a
 * vendor was `SliceRunner`, and a `SliceRunner` needs a routing decision, an
 * attempt slot, a `WorktreeSession`, and a `CreatedWorktree` before it will
 * spawn anything. Every `Worker.spawn` call site in `src/` sat inside
 * `#runInWorktree`, which by construction always holds a live worktree. That
 * made a whole class of work unreachable: asking a model a question whose
 * answer is *text* rather than *a commit*.
 *
 * Two callers want exactly that. The cross-vendor review gate in `review.ts`
 * asks the other vendor to read a slice's work and report findings; a planner
 * asks a model to turn a goal into a plan. Neither produces a commit, neither
 * wants a branch, and neither should have to fabricate a `SliceRunInput` to be
 * allowed to speak to a CLI.
 *
 * IT IS READ-ONLY BY CONSTRUCTION, AND THAT IS THE POINT OF ROUTING IT THROUGH
 * `buildWorkerSpec`. The sanctioned spec builder maps `ownedPaths` onto each
 * vendor's lane grammar, so a synthetic slice with NO owned paths produces a
 * worker that may read its `cwd` and write nothing:
 *
 *   - Claude: `buildClaudeCommand` only emits `--allowedTools` when there is at
 *     least one `Edit`/`Write` rule to put in it, so an empty lane emits the
 *     flag not at all rather than emitting it empty. The worker still gets
 *     `--tools Glob,Grep,Read` (see `READ_ONLY_CLAUDE_TOOLS` below), which is
 *     what lets it read under `--permission-mode dontAsk`. MEASURED against
 *     claude 2.1.226: a review prompt with no owned paths read its target file
 *     through `Read` and returned findings, `is_error: false`,
 *     `terminal_reason: "completed"`.
 *   - Codex: `codexLaneProfile` emits `{":root"="read",":workspace_roots"={"."="read"}}`
 *     with no `"write"` entry at all. MEASURED against codex-cli 0.145.0: the
 *     same review ran, used shell to read the file, and exited 0.
 *
 * Building the spec by hand instead would mean re-deriving both lane grammars
 * outside the one function that is allowed to know them, which is how a
 * read-only reviewer quietly acquires write access.
 *
 * IT NEVER THROWS AND IT NEVER LEAKS A PROCESS. Both are obligations inherited
 * from its first caller: the review gate runs inside `#runInWorktree`, which is
 * documented total, and it runs while the user may already have pressed Ctrl-C.
 * A launch that fails, a completion that rejects, an event stream that breaks
 * mid-flight, and an abort are all values here rather than exceptions.
 */

import type {
  AnyWorker,
  Effort,
  Slice,
  SpawnedWorker,
  TokenUsage,
  Vendor,
  WorkerEvent,
  WorkerFailure,
  WorkerOutcome,
  WorkerSpec,
} from "../contracts.js";
import type { RoutedWorker } from "../routing/contracts.js";
import type { SpecBuildInput } from "./spec.js";
import { buildWorkerSpec } from "./spec.js";
import {
  ABORTED,
  COMPLETION_TIMEOUT,
  describeError,
  raceAbort,
  settle,
  settleWithin,
} from "./support.js";

/**
 * The environment a one-shot launch needs, aliased from the spec builder for
 * the same reason `LaunchEnv` is: if the builder ever demands a fourth
 * variable, this alias acquires it and every caller stops compiling.
 */
export type OneShotEnv = SpecBuildInput["env"];

/**
 * One prompt, one model, one answer.
 *
 * `cwd` is the directory the model may read. It is a plain path rather than a
 * `CreatedWorktree` precisely so a caller with no worktree — a planner reading
 * the user's checkout — can use this at all.
 *
 * `purpose` is prose, and it is not decoration: it becomes the `rationale` on
 * the synthetic routing decision, which is what makes a spec captured in a test
 * or a log say *why* a model was launched outside the ordinary slice path.
 */
export interface OneShotRequest {
  /** Becomes `WorkerSpec.id`; use something a log reader can correlate. */
  readonly id: string;
  readonly vendor: Vendor;
  readonly model: string;
  readonly effort: Effort;
  /** Sent on stdin by every adapter, never as positional argv. */
  readonly prompt: string;
  /** The only directory the launched worker may read. Nothing is writable. */
  readonly cwd: string;
  readonly env: OneShotEnv;
  readonly purpose: string;
  /** Total runtime bound. Omit for the spec builder's default; null disables. */
  readonly timeoutMs?: number | null;
  /** Must stay above `IDLE_TIMEOUT_BOUNDARY_MS`; omit for the default. */
  readonly idleTimeoutMs?: number;
  /**
   * Caps assistant turns where the vendor enforces one. A one-shot ask that has
   * started iterating has misunderstood its job, and an unbounded one spends
   * the user's quota until the total timeout.
   */
  readonly maxTurns?: number | null;
  /**
   * Called for every event the worker emits, so a caller can feed a quota
   * oracle without owning the drain. A throw from it is swallowed: losing the
   * answer to a telemetry failure would be the worse trade, and stopping the
   * drain would re-create the stall the drain exists to prevent.
   */
  readonly onEvent?: (event: WorkerEvent) => void;
  readonly signal?: AbortSignal;
}

/**
 * The answer, or why there is none.
 *
 * There is deliberately no duration on either arm. Timing belongs to the
 * caller's injected clock — `SupervisorPorts.now` — and a duration measured
 * inside this function would be a second, unmockable source of the numbers a
 * `RunReport` states.
 */
export type OneShotResult =
  | {
      readonly ok: true;
      /** The worker's final text. May be empty; that is not an error here. */
      readonly text: string;
      readonly usage: TokenUsage;
    }
  | {
      readonly ok: false;
      readonly failure: WorkerFailure;
      /** Present only when cancellation could not confirm process exit. */
      readonly cleanupFailure?: string;
    };

const CANCELLATION_COMPLETION_BOUND_MS = 100;

/**
 * Claude's read-only tool set.
 *
 * `Edit` and `Write` are absent because there is nothing to edit or write:
 * with no owned paths there is no lane rule that would permit either, so
 * granting the tools would only produce a worker that tries and is refused.
 * `Bash` is absent for the reason `spec.ts` gives at length — Claude's lane is
 * enforced by tool rules rather than an OS sandbox, so `Bash` would widen a
 * read-only worker to the whole filesystem.
 *
 * This asymmetry with Codex is real and worth naming: a Codex one-shot CAN run
 * shell commands inside its read-only sandbox, so it can run `git diff` while a
 * Claude one-shot cannot. Any prompt sent through this function must therefore
 * be answerable by reading files alone.
 */
const READ_ONLY_CLAUDE_TOOLS = ["Glob", "Grep", "Read"] as const;

/**
 * The synthetic slice that makes the lane empty.
 *
 * `ownedPaths: []` is the whole mechanism; everything else is labelling that
 * shows up in a captured spec.
 */
function readOnlySlice(request: OneShotRequest): Slice {
  return {
    id: request.id,
    title: request.purpose,
    prompt: request.prompt,
    ownedPaths: [],
    dependsOn: [],
  };
}

function syntheticRouting(request: OneShotRequest): RoutedWorker {
  return {
    vendor: request.vendor,
    model: request.model,
    effort: request.effort,
    rationale: [`one-shot: ${request.purpose}`],
    // Nothing was waived: a one-shot ask has no difficulty floor to clear,
    // because it is not a slice and never entered the competence pipeline.
    waivedDifficultyFloor: false,
  };
}

/**
 * Ask one model one question. Never rejects.
 *
 * The adapter is passed in rather than resolved here so this stays a function
 * of its arguments: a caller holding `SupervisorPorts.workerFor` resolves the
 * vendor, and a test hands in a fake with no registry involved.
 */
export async function runOneShotPrompt(
  worker: AnyWorker,
  request: OneShotRequest,
): Promise<OneShotResult> {
  let spec: WorkerSpec;
  try {
    spec = readOnlySpec(request);
  } catch (error) {
    return launchFailed(
      `could not build a read-only ${request.vendor}/${request.model} spec: ${describeError(error)}`,
    );
  }

  if (request.signal?.aborted === true) {
    return {
      ok: false,
      failure: {
        kind: "CANCELLED",
        message: `${request.purpose} was cancelled before a ${request.vendor}/${request.model} worker was spawned`,
        retryable: false,
        statusCode: null,
      },
    };
  }

  let spawned: SpawnedWorker;
  try {
    spawned = await spawnWorker(worker, spec);
  } catch (error) {
    return launchFailed(
      `could not spawn a ${request.vendor} worker for ${request.purpose}: ${describeError(error)}`,
    );
  }

  // THE SAME DEADLOCK `#runInWorktree` DOCUMENTS, AND THE SAME SHAPE THAT
  // AVOIDS IT. An adapter's `events` iterable is a producer with nowhere to put
  // its next value until somebody pulls it, and an adapter that stops reading
  // the child's stdout stops the child. Awaiting `completion` first, with
  // nothing consuming `events`, can therefore wait forever. Both start here and
  // are awaited together, and neither rejects, so `Promise.all` cannot abandon
  // one of them half-run.
  const drain = drainEvents(spawned.events, request.onEvent);
  const completion: Promise<WorkerOutcome> = spawned.completion;
  const running = Promise.all([drain, settle(completion)]);
  const raced = await raceAbort(request.signal, running);

  if (raced === ABORTED) {
    const message = `${request.purpose} was cancelled while ${request.vendor}/${request.model} was running`;
    // Awaited rather than fired and forgotten, for the same reason the slice
    // runner awaits it: the caller may be about to remove the directory this
    // worker is reading, and a live process in a removed directory is how a
    // `git worktree remove` fails.
    const note = await cancelQuietly(spawned, message);
    const cleanupFailure =
      note === null
        ? null
        : `the ${request.vendor}/${request.model} worker (pid ${spawned.pid ?? "none"}) may still be running — ${note}`;
    return {
      ok: false,
      failure: {
        kind: "CANCELLED",
        message:
          cleanupFailure === null ? message : `${message}; ${cleanupFailure}`,
        retryable: false,
        statusCode: null,
      },
      ...(cleanupFailure === null ? {} : { cleanupFailure }),
    };
  }

  const [, completed] = raced;
  if (!completed.ok) {
    // Out of contract: `completion` is documented to resolve with a
    // `WorkerOutcome`. Recorded rather than rethrown.
    return {
      ok: false,
      failure: {
        kind: "UNKNOWN_FAILURE",
        message: `${request.vendor}/${request.model} completion rejected during ${request.purpose}: ${describeError(completed.error)}`,
        retryable: false,
        statusCode: null,
      },
    };
  }

  const outcome = completed.value;
  if (!outcome.ok) {
    return { ok: false, failure: outcome.failure };
  }
  return { ok: true, text: outcome.output, usage: outcome.usage };
}

function readOnlySpec(request: OneShotRequest): WorkerSpec {
  const spec = buildWorkerSpec({
    slice: readOnlySlice(request),
    routed: syntheticRouting(request),
    worktreePath: request.cwd,
    env: request.env,
    ...(request.idleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: request.idleTimeoutMs }),
    ...(request.timeoutMs === undefined
      ? {}
      : { timeoutMs: request.timeoutMs }),
    ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
  });
  // Narrowing Claude's tool list is the one thing the shared builder cannot do
  // for us: it grants the coding set because every other caller is a coding
  // slice. The lane is already empty either way — this removes the two tools
  // that would have nothing to act on rather than adding any permission.
  return spec.vendor === "claude"
    ? { ...spec, tools: READ_ONLY_CLAUDE_TOOLS }
    : spec;
}

function launchFailed(message: string): OneShotResult {
  return {
    ok: false,
    failure: {
      kind: "LAUNCH_FAILURE",
      message,
      retryable: false,
      statusCode: null,
    },
  };
}

/**
 * Consume the event stream to exhaustion, forwarding each event to the caller.
 *
 * Never rejects, for the same reason the slice runner's drain does not: losing
 * the worker's answer to a telemetry failure is strictly the worse trade.
 */
async function drainEvents(
  events: AsyncIterable<WorkerEvent>,
  onEvent: ((event: WorkerEvent) => void) | undefined,
): Promise<void> {
  try {
    for await (const event of events) {
      if (onEvent === undefined) {
        continue;
      }
      try {
        onEvent(event);
      } catch {
        // A caller's telemetry sink must not be able to stop the drain and
        // re-create the stall the drain exists to prevent.
      }
    }
  } catch {
    // An iterable that breaks mid-stream ends the drain; `completion` still
    // carries the outcome, which is the value this function exists to protect.
  }
}

/**
 * Terminate the worker's process group, reporting rather than throwing.
 *
 * Returns null when the cancellation went through, and the reason it could not
 * be confirmed otherwise. The caller folds that into its own failure message,
 * because a worker that survived is a fact the user has to be told.
 */
async function cancelQuietly(
  spawned: SpawnedWorker,
  message: string,
): Promise<string | null> {
  try {
    await spawned.cancel({ kind: "shutdown", message });
  } catch (error) {
    return `terminating its process group failed: ${describeError(error)}`;
  }

  const completion: Promise<WorkerOutcome> = spawned.completion;
  const completed = await settleWithin(
    completion,
    CANCELLATION_COMPLETION_BOUND_MS,
  );
  if (completed === COMPLETION_TIMEOUT) {
    return `termination was not confirmed because completion did not settle within ${CANCELLATION_COMPLETION_BOUND_MS} ms`;
  }
  // TypeScript widens an imported unique-symbol sentinel in this module even
  // after the equality guard above. The runtime union has only the sentinel
  // and this settled record, so the narrowing is stated once here.
  const settlement = completed as
    | { readonly ok: true; readonly value: WorkerOutcome }
    | { readonly ok: false; readonly error: unknown };
  if (settlement.ok === false) {
    const rejected = settlement as {
      readonly ok: false;
      readonly error: unknown;
    };
    return `termination was not confirmed because completion rejected: ${describeError(rejected.error)}`;
  }
  const outcome = (
    settlement as { readonly ok: true; readonly value: WorkerOutcome }
  ).value;
  if (outcome.ok === false) {
    const failure = (outcome as Extract<WorkerOutcome, { readonly ok: false }>)
      .failure;
    return failure.kind === "CANCELLED"
      ? null
      : `termination was not confirmed because completion settled with ${failure.kind}: ${failure.message}`;
  }
  return "termination was not confirmed because completion settled successfully";
}

/**
 * Launch a spec on an adapter without a type assertion.
 *
 * `workerFor` is typed `(vendor: Vendor) => AnyWorker | null`, which does not
 * correlate the vendor asked for with the adapter returned, so a mismatch is
 * representable and has to be handled rather than cast away. Both call sites —
 * the slice runner and this module — catch the throw and turn it into a
 * `LAUNCH_FAILURE`.
 */
export async function spawnWorker(
  worker: AnyWorker,
  spec: WorkerSpec,
): Promise<SpawnedWorker> {
  if (worker.vendor === "claude") {
    if (spec.vendor !== "claude") {
      throw new Error(
        `vendor mismatch: a claude adapter cannot launch a ${spec.vendor} spec`,
      );
    }
    return worker.spawn(spec);
  }
  if (spec.vendor !== "codex") {
    throw new Error(
      `vendor mismatch: a codex adapter cannot launch a ${spec.vendor} spec`,
    );
  }
  return worker.spawn(spec);
}
