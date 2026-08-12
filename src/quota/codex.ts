import type { QuotaScope, QuotaSnapshot, QuotaWindow } from "../contracts.js";
import { consumeNdjson } from "../shared/ndjson.js";
import {
  collectBoundedText,
  type DetachedProcess,
  shutdownProcessGroup,
  spawnDetachedProcess,
  writeToProcess,
} from "../shared/process.js";
import type { CodexQuotaOracle as CodexQuotaOracleContract } from "./contracts.js";
import { deriveAccountStatus } from "./contracts.js";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  readonly resolve: (response: JsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_STDERR_BYTES = 64 * 1_024;

export interface CodexQuotaOracleOptions {
  readonly executable?: string;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

function spawnAppServer(
  options: CodexQuotaOracleOptions,
): Promise<DetachedProcess> {
  return spawnDetachedProcess(
    options.executable ?? "codex",
    ["app-server", "--stdio"],
    {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.environment === undefined
        ? {}
        : { env: { ...options.environment } }),
    },
  );
}

type AppServerProcess = DetachedProcess;

/** One long-lived Codex JSON-RPC app-server quota source. */
export class CodexQuotaOracle implements CodexQuotaOracleContract {
  readonly vendor = "codex" as const;

  private readonly options: CodexQuotaOracleOptions;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private processHandle: AppServerProcess | null = null;
  private processStartTask: Promise<AppServerProcess> | null = null;
  private readerTask: Promise<void> | null = null;
  private stderrTask: Promise<string> | null = null;
  private shutdownTask: Promise<void> | null = null;
  private permanentFailure: Error | null = null;
  private disposed = false;
  private disposeTask: Promise<void> | null = null;

  constructor(options: CodexQuotaOracleOptions = {}) {
    this.options = options;
  }

  /** Exposed for lifecycle observability; null until the first snapshot. */
  get pid(): number | null {
    return this.processHandle?.pid ?? null;
  }

  async snapshot(): Promise<QuotaSnapshot & { readonly vendor: "codex" }> {
    if (this.disposed) {
      throw new Error("Codex quota oracle is disposed");
    }

    const response = await this.request("account/rateLimits/read");
    if ("error" in response) {
      throw new Error(
        `Codex quota RPC failed: ${describeRpcError(response.error)}`,
      );
    }
    return normalizeCodexRateLimits(
      response.result,
      this.options.now?.() ?? Date.now(),
    );
  }

  dispose(): Promise<void> {
    if (this.disposeTask !== null) {
      return this.disposeTask;
    }
    this.disposed = true;
    this.disposeTask = this.disposeOwnedProcess();
    return this.disposeTask;
  }

  private async request(method: string): Promise<JsonObject> {
    if (this.permanentFailure !== null) {
      throw this.permanentFailure;
    }
    const processHandle = await this.ensureProcess();
    const id = this.nextRequestId++;
    const timeoutMs = requestTimeoutMs(this.options.requestTimeoutMs);
    const response = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failProcess(
          new Error(`Codex quota request timed out after ${timeoutMs} ms`),
          processHandle,
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    void writeToProcess(
      processHandle.stdin,
      `${JSON.stringify({ jsonrpc: "2.0", id, method })}\n`,
    ).catch((error: unknown) => {
      this.failProcess(
        new Error("Failed to write to Codex quota app-server", {
          cause: error,
        }),
        processHandle,
      );
    });
    return response;
  }

  private async ensureProcess(): Promise<AppServerProcess> {
    if (this.processHandle !== null) {
      return this.processHandle;
    }
    if (this.processStartTask !== null) {
      return this.processStartTask;
    }
    if (this.disposed) {
      throw new Error("Codex quota oracle is disposed");
    }
    if (this.permanentFailure !== null) {
      throw this.permanentFailure;
    }

    this.processStartTask = spawnAppServer(this.options).then(
      async (processHandle) => {
        if (this.disposed) {
          this.processHandle = processHandle;
          await this.beginShutdown(processHandle);
          throw new Error("Codex quota oracle is disposed");
        }
        this.processHandle = processHandle;
        this.stderrTask = collectBoundedText(
          processHandle.stderr,
          MAX_STDERR_BYTES,
        ).catch(() => "");
        this.readerTask = consumeNdjson(
          processHandle.stdout,
          (record) => {
            this.receive(record);
          },
          {
            parseErrorContext: "Codex app-server emitted invalid JSON",
            validate: requireJsonObject,
          },
        ).then(
          () => {
            this.failProcess(
              new Error("Codex quota app-server closed stdout"),
              processHandle,
            );
          },
          (error: unknown) => {
            this.failProcess(
              asError(error, "Codex quota response reader failed"),
              processHandle,
            );
          },
        );
        return processHandle;
      },
    );
    try {
      return await this.processStartTask;
    } finally {
      this.processStartTask = null;
    }
  }

  private receive(response: JsonObject): void {
    const id = response.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      return;
    }
    const request = this.pending.get(id);
    if (request === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(request.timer);
    request.resolve(response);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private async disposeOwnedProcess(): Promise<void> {
    const startedProcess = await this.processStartTask?.catch(() => null);
    const processHandle = this.processHandle ?? startedProcess ?? null;
    if (processHandle === null) {
      if (this.shutdownTask !== null) {
        await this.shutdownTask;
      }
      return;
    }

    this.rejectPending(new Error("Codex quota oracle was disposed"));
    processHandle.stdin.end();
    await this.beginShutdown(processHandle);
    processHandle.stdin.destroy();
    processHandle.stdout.destroy();
    processHandle.stderr.destroy();
    await Promise.all([
      settleTask(this.readerTask),
      settleTask(this.stderrTask),
    ]);
  }

  private failProcess(error: Error, processHandle: AppServerProcess): void {
    if (this.processHandle !== processHandle || this.disposed) {
      return;
    }
    this.permanentFailure ??= error;
    this.rejectPending(this.permanentFailure);
    processHandle.stdin.end();
    void this.beginShutdown(processHandle).catch(() => {});
  }

  private beginShutdown(processHandle: AppServerProcess): Promise<void> {
    this.shutdownTask ??= shutdownProcessGroup(processHandle.pid);
    return this.shutdownTask;
  }
}

export function createCodexQuotaOracle(
  options: CodexQuotaOracleOptions = {},
): CodexQuotaOracle {
  return new CodexQuotaOracle(options);
}

/**
 * The `limitId` of the general bucket every Codex tier shares.
 *
 * Sol, Terra, and Luna draw from one allowance at different burn rates, and
 * that allowance was observed reported under `limitId: "codex"` with
 * `limitName: null`. Used only as a fallback identity
 * for the aggregate `result.rateLimits` object, which carried no `limitId` in
 * some payloads.
 */
const GENERAL_LIMIT_ID = "codex";

const ACCOUNT_SCOPE: QuotaScope = Object.freeze({ kind: "account" });

/**
 * Reads both quota surfaces the Codex app-server returns.
 *
 * `result.rateLimits` is the aggregate the adapter has always read. It is the
 * shared Sol/Terra/Luna bucket, so it is account-scoped. `rateLimitsByLimitId`
 * repeats that aggregate under the general `codex` id and may contain other
 * buckets under opaque codenames. Only the general bucket has a scope brigadier
 * can map without guessing, so other ids are ignored.
 */
export function normalizeCodexRateLimits(
  result: unknown,
  observedAtMs: number,
): QuotaSnapshot & { readonly vendor: "codex" } {
  const resultObject = asObject(result);
  const aggregate = asObject(resultObject?.rateLimits);
  const byLimitId = asObject(resultObject?.rateLimitsByLimitId);

  const aggregateId = stringValue(aggregate?.limitId) ?? GENERAL_LIMIT_ID;
  // The aggregate is normally repeated inside the map under its own id. Reading
  // both without this guard would emit each of its windows twice.
  const seen = new Set<string>();
  const windows: QuotaWindow[] = [];

  if (aggregate !== null) {
    seen.add(aggregateId);
    windows.push(
      ...collectWindows(
        aggregate,
        ACCOUNT_SCOPE,
        effectiveReachedType(aggregate, resultObject),
      ),
    );
  }

  for (const [limitId, value] of Object.entries(byLimitId ?? {})) {
    if (seen.has(limitId) || limitId !== GENERAL_LIMIT_ID) {
      continue;
    }
    seen.add(limitId);
    const bucket = asObject(value);
    if (bucket === null) {
      continue;
    }
    windows.push(
      ...collectWindows(bucket, ACCOUNT_SCOPE, bucket.rateLimitReachedType),
    );
  }

  // The status is never manufactured past the windows.
  //
  // This used to read `derived === "unknown" && accountReached ? "exhausted" :
  // derived`, which invented a vendor-wide `exhausted` with an EMPTY `windows`
  // array. That contradicts `QuotaSnapshot.status`'s own contract in the frozen
  // `src/contracts.ts` — the status is documented as deriving from
  // account-scoped windows, and there were none — and it is not a harmless
  // inconsistency: the router floors every per-model reading with
  // `snapshot.status`, so `{ rateLimits: { rateLimitReachedType: "primary" } }`
  // turned one configured model into `ALL_VENDORS_EXHAUSTED` with nothing in the
  // snapshot able to explain why.
  //
  // The evidence is real, so it is recorded rather than discarded — downgrading
  // to `unknown` would throw away a positive refusal, which is the same class of
  // defect as dropping a partial window. It is recorded as a WINDOW, so status
  // and windows agree and the trace can name its cause.
  //
  // `collectWindows` already synthesizes that window for any bucket it is given,
  // so this backstop is reachable only when there is no aggregate object to give
  // it: a top-level `rateLimitReachedType` beside a missing `rateLimits`.
  if (
    isReached(effectiveReachedType(aggregate, resultObject)) &&
    !windows.some(
      (window) =>
        window.scope.kind === "account" && window.status === "exhausted",
    )
  ) {
    windows.push(refusalWindow(ACCOUNT_SCOPE));
  }

  return {
    vendor: "codex",
    status: deriveAccountStatus(windows),
    observedAtMs,
    windows,
    isUsingOverage: null,
  };
}

/**
 * A window that records one fact and claims nothing else: this bucket was
 * refused.
 *
 * Every number is null because the vendor supplied none. That is the honest
 * encoding — `durationMinutes: null` and `resetsAtMs: null` already mean
 * "unknown" throughout this contract, and inventing a duration or a reset
 * instant here would be a guarantee brigadier cannot honour. `kind: "unknown"`
 * for the same reason: with no window payload there is nothing to say whether
 * the refused allowance was rolling or weekly.
 */
function refusalWindow(scope: QuotaScope): QuotaWindow {
  return {
    kind: "unknown",
    scope,
    status: "exhausted",
    durationMinutes: null,
    remainingFraction: null,
    resetsAtMs: null,
  };
}

/**
 * Whether a `rateLimitReachedType` is a positive refusal.
 *
 * `null` is the vendor's "not reached"; `undefined` is the field being absent.
 * Anything else — including a value this build has never seen — is a refusal,
 * because a payload that names a limit type at all is asserting one was hit.
 */
function isReached(reachedType: unknown): boolean {
  return reachedType !== null && reachedType !== undefined;
}

function effectiveReachedType(
  aggregate: JsonObject | null,
  resultObject: JsonObject | null,
): unknown {
  return hasProperty(aggregate, "rateLimitReachedType")
    ? aggregate?.rateLimitReachedType
    : resultObject?.rateLimitReachedType;
}

/**
 * Every window one bucket asserts something about.
 *
 * A key is collected when the bucket carries an object under it OR when
 * `rateLimitReachedType` names it. The second half is what stops a partial
 * bucket from losing evidence: `{"primary": null, "rateLimitReachedType":
 * "primary"}` is a statement *about* the primary window, and skipping the key
 * because its numbers are absent discarded the only thing the payload asserted.
 */
function collectWindows(
  bucket: JsonObject,
  scope: QuotaScope,
  reachedType: unknown,
): QuotaWindow[] {
  const preferredKeys = ["primary", "secondary"] as const;
  const keys = preferredKeys.filter(
    (key) => bucket[key] !== undefined || reachedType === key,
  );

  const windows = keys.flatMap((key) => {
    const window = normalizeWindow(key, bucket[key], scope, reachedType);
    return window === null ? [] : [window];
  });

  // The invariant this function owes its callers: a bucket the vendor refused
  // always yields at least one exhausted window, so no reader ever has to
  // reconstruct a refusal from a status that has no window behind it.
  //
  // Reachable only when the refusal names neither `primary` nor `secondary` — a
  // `rateLimitReachedType` value this build has never seen — on a bucket that
  // carries no window objects either. Every other refusal is already attached to
  // a window above.
  if (
    isReached(reachedType) &&
    !windows.some((window) => window.status === "exhausted")
  ) {
    return [...windows, refusalWindow(scope)];
  }
  return windows;
}

/**
 * `rateLimitReachedType` names which of a bucket's windows was refused, so only
 * that window is exhausted. A non-null value naming neither window exhausts both
 * windows of that bucket: the account was demonstrably refused and brigadier
 * cannot tell which allowance did it, so the conservative reading is that the
 * bucket is spent.
 */
function normalizeWindow(
  key: "primary" | "secondary",
  value: unknown,
  scope: QuotaScope,
  reachedType: unknown,
): QuotaWindow | null {
  const object = asObject(value);
  const usedPercent = object === null ? null : finiteNumber(object.usedPercent);
  const durationMinutes =
    object === null ? null : nonNegativeNumber(object.windowDurationMins);
  const resetsAtSeconds =
    object === null ? null : nonNegativeNumber(object.resetsAt);

  const reached =
    isReached(reachedType) &&
    (reachedType === key ||
      (reachedType !== "primary" && reachedType !== "secondary"));

  // An empty, absent, or unparseable window is dropped only when nothing was
  // asserted about it. A reached limit IS an assertion and outranks the absence
  // of numbers: missing numbers mean unknown numbers, never absent evidence.
  //
  // This emptiness check used to run first, before `reached` was even computed,
  // and before `object === null` was tolerated at all. A bucket reporting
  // `{"limitName": "GPT-5.3-Codex-Spark", "primary": null,
  // "rateLimitReachedType": "primary"}` therefore produced no window, an
  // `unknown` snapshot, and a demonstrably refused model reading back as
  // available — the wasted launch this whole unit exists to prevent.
  if (
    !reached &&
    usedPercent === null &&
    durationMinutes === null &&
    resetsAtSeconds === null
  ) {
    return null;
  }

  return {
    kind:
      key === "secondary" || durationMinutes === 10_080
        ? "weekly"
        : durationMinutes === null
          ? "unknown"
          : "rolling",
    scope,
    status: reached ? "exhausted" : "available",
    durationMinutes,
    remainingFraction:
      usedPercent === null ? null : clamp(1 - usedPercent / 100, 0, 1),
    resetsAtMs: resetsAtSeconds === null ? null : resetsAtSeconds * 1_000,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function requireJsonObject(value: unknown): JsonObject {
  const object = asObject(value);
  if (object === null) {
    throw new Error("Codex app-server emitted a non-object JSON-RPC record");
  }
  return object;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function hasProperty(object: JsonObject | null, property: string): boolean {
  return object !== null && Object.hasOwn(object, property);
}

function describeRpcError(value: unknown): string {
  const error = asObject(value);
  const code = error?.code;
  const message = error?.message;
  return `${typeof code === "number" ? code : "unknown"} ${
    typeof message === "string" ? message : "Unknown error"
  }`;
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function requestTimeoutMs(configured: number | undefined): number {
  const timeoutMs = configured ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("requestTimeoutMs must be a positive whole number");
  }
  return timeoutMs;
}

async function settleTask(task: Promise<unknown> | null): Promise<void> {
  if (task === null) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
