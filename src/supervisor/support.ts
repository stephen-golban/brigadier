/**
 * The small total helpers the supervisor's impure stages share.
 *
 * Every function here has the same shape of obligation: it is called on a path
 * that is already committed to producing a recorded result rather than an
 * exception, so none of them may throw and none of them may leave a listener or
 * a timer behind. They lived as private functions inside `slice.ts` until a
 * second impure stage — the one-shot prompt runner in `one-shot.ts` — needed
 * exactly the same three guarantees. Copying `raceAbort` in particular would
 * have been the wrong trade: its correctness rests on a `finally` that removes
 * a listener from a signal shared by an entire run, and a second copy is a
 * second place for that to be forgotten.
 */

/**
 * What `raceAbort` resolves when the signal wins.
 *
 * A unique symbol rather than a sentinel value so a caller cannot confuse it
 * with anything the raced work could legitimately produce.
 */
import type { WorkerEvent } from "../contracts.js";
import type {
  AnyQuotaOracle,
  ClaudeQuotaOracle,
  ClaudeQuotaWorkerEvent,
  QuotaWorkerEvent,
} from "../quota/contracts.js";

export const ABORTED = Symbol("aborted");

/** What `settleWithin` resolves when the bound expires first. */
export const COMPLETION_TIMEOUT = Symbol("completion timeout");

/**
 * `work`'s value, or `ABORTED` the moment the signal fires — whichever is first.
 *
 * THE LISTENER IS REMOVED IN A `finally`, AND THAT IS NOT TIDINESS. One signal
 * is shared by every slice in the run, so a listener left behind by each
 * finished slice accumulates on a single `AbortSignal` for the whole run; Node
 * warns at eleven and the leak is real regardless.
 *
 * `work` is not cancelled when the abort wins — nothing here could cancel it —
 * so every caller must hand in a promise that cannot reject. An abandoned
 * promise that rejects has no `await` left to catch it and becomes an unhandled
 * rejection at some unrelated later moment.
 */
export async function raceAbort<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
): Promise<T | typeof ABORTED> {
  if (signal === undefined) {
    return work;
  }
  if (signal.aborted) {
    return ABORTED;
  }
  let onAbort: (() => void) | null = null;
  const interrupted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = (): void => {
      resolve(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    if (onAbort !== null) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** Turns a rejection into a value, so a caller can await it without a `catch`. */
export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * `settle`, but giving up after `timeoutMs`.
 *
 * The timer is cleared in a `finally` for the same class of reason `raceAbort`
 * removes its listener: a pending `setTimeout` keeps an event loop alive, and a
 * supervisor that will not exit after its last slice is a defect the user
 * experiences as a hang.
 */
export async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<Settled<T> | typeof COMPLETION_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof COMPLETION_TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(COMPLETION_TIMEOUT);
    }, timeoutMs);
  });
  try {
    return await Promise.race([settle(promise), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** The message of an `Error`, or the value itself rendered as a string. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Feed one worker event to Claude's push-based quota oracle, if there is one.
 *
 * SHARED BECAUSE QUOTA IS SPENT BY EVERY LAUNCH, NOT ONLY BY BUILDERS. The
 * slice runner's drain has always done this for the worker that writes the
 * code; the review gate spawns a second worker per attempt, and its rate-limit
 * events meter the same account. An oracle that saw only half the launches
 * would tell the router a vendor had headroom it had already spent.
 *
 * A throwing oracle is contained rather than propagated: it is telemetry, and
 * losing a run's outcome to it — or stalling a drain, which is worse — is never
 * the right trade.
 */
export function ingestQuotaEvent(
  oracles: readonly AnyQuotaOracle[],
  event: WorkerEvent,
  log: (line: string) => void,
): void {
  if (event.type !== "quota" || !isClaudeQuotaEvent(event)) {
    return;
  }
  const oracle = claudeOracle(oracles);
  if (oracle === null) {
    return;
  }
  try {
    oracle.ingest(event);
  } catch (error) {
    log(
      `ignored a failure from the claude quota oracle: ${describeError(error)}`,
    );
  }
}

function isClaudeQuotaEvent(
  event: QuotaWorkerEvent,
): event is ClaudeQuotaWorkerEvent {
  return event.snapshot.vendor === "claude";
}

function claudeOracle(
  oracles: readonly AnyQuotaOracle[],
): ClaudeQuotaOracle | null {
  for (const oracle of oracles) {
    // Only Claude's oracle is push-based. `typeof` guards a hand-rolled oracle
    // that claims the vendor without implementing the push half.
    if (oracle.vendor === "claude" && typeof oracle.ingest === "function") {
      return oracle;
    }
  }
  return null;
}
