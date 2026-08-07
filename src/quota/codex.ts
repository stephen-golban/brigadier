import type { QuotaSnapshot, QuotaWindow } from "../contracts.js";
import { consumeNdjson } from "../shared/ndjson.js";
import {
  collectBoundedText,
  type DetachedProcess,
  shutdownProcessGroup,
  spawnDetachedProcess,
  writeToProcess,
} from "../shared/process.js";
import type { CodexQuotaOracle as CodexQuotaOracleContract } from "./contracts.js";

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

export function normalizeCodexRateLimits(
  result: unknown,
  observedAtMs: number,
): QuotaSnapshot & { readonly vendor: "codex" } {
  const resultObject = asObject(result);
  const rateLimits = asObject(resultObject?.rateLimits);
  const windows = rateLimits === null ? [] : collectWindows(rateLimits);
  const rateLimitsHaveReachedType = hasProperty(
    rateLimits,
    "rateLimitReachedType",
  );
  const resultHasReachedType = hasProperty(
    resultObject,
    "rateLimitReachedType",
  );
  const reachedType = rateLimitsHaveReachedType
    ? rateLimits?.rateLimitReachedType
    : resultObject?.rateLimitReachedType;
  const hasReachedType = rateLimitsHaveReachedType || resultHasReachedType;

  return {
    vendor: "codex",
    status:
      hasReachedType && reachedType !== null
        ? "exhausted"
        : windows.length > 0
          ? "available"
          : "unknown",
    observedAtMs,
    windows,
    isUsingOverage: null,
  };
}

function collectWindows(rateLimits: JsonObject): QuotaWindow[] {
  const preferredKeys = ["primary", "secondary"] as const;
  const entries = preferredKeys
    .map((key) => [key, rateLimits[key]] as const)
    .filter((entry) => entry[1] !== undefined);

  return entries.flatMap(([key, value]) => {
    const window = normalizeWindow(key, value);
    return window === null ? [] : [window];
  });
}

function normalizeWindow(key: string, value: unknown): QuotaWindow | null {
  const object = asObject(value);
  if (object === null) {
    return null;
  }
  const usedPercent = finiteNumber(object.usedPercent);
  const durationMinutes = nonNegativeNumber(object.windowDurationMins);
  const resetsAtSeconds = nonNegativeNumber(object.resetsAt);
  if (
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
    durationMinutes,
    remainingFraction:
      usedPercent === null ? null : clamp(1 - usedPercent / 100, 0, 1),
    resetsAtMs: resetsAtSeconds === null ? null : resetsAtSeconds * 1_000,
  };
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
