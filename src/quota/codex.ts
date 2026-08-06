import type { QuotaSnapshot, QuotaWindow } from "../contracts.js";
import { consumeNdjson } from "../shared/ndjson.js";
import type { CodexQuotaOracle as CodexQuotaOracleContract } from "./contracts.js";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  readonly resolve: (response: JsonObject) => void;
  readonly reject: (error: Error) => void;
}

export interface CodexQuotaOracleOptions {
  readonly executable?: string;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
}

function spawnAppServer(options: CodexQuotaOracleOptions) {
  return Bun.spawn([options.executable ?? "codex", "app-server", "--stdio"], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    detached: true,
    ...(options.environment === undefined ? {} : { env: options.environment }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

type AppServerProcess = ReturnType<typeof spawnAppServer>;

/** One long-lived Codex JSON-RPC app-server quota source. */
export class CodexQuotaOracle implements CodexQuotaOracleContract {
  readonly vendor = "codex" as const;

  private readonly options: CodexQuotaOracleOptions;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private processHandle: AppServerProcess | null = null;
  private readerTask: Promise<void> | null = null;
  private stderrTask: Promise<string> | null = null;
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
    const processHandle = this.ensureProcess();
    const id = this.nextRequestId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    try {
      processHandle.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method })}\n`,
      );
      processHandle.stdin.flush();
    } catch (error) {
      this.pending.delete(id);
      throw new Error("Failed to write to Codex quota app-server", {
        cause: error,
      });
    }
    return response;
  }

  private ensureProcess(): AppServerProcess {
    if (this.processHandle !== null) {
      return this.processHandle;
    }
    if (this.disposed) {
      throw new Error("Codex quota oracle is disposed");
    }

    const processHandle = spawnAppServer(this.options);
    this.processHandle = processHandle;
    this.stderrTask = new Response(processHandle.stderr).text();
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
        this.rejectPending(new Error("Codex quota app-server closed stdout"));
      },
      (error: unknown) => {
        this.rejectPending(
          asError(error, "Codex quota response reader failed"),
        );
      },
    );
    return processHandle;
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
    request.resolve(response);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }

  private async disposeOwnedProcess(): Promise<void> {
    const processHandle = this.processHandle;
    if (processHandle === null) {
      return;
    }

    this.rejectPending(new Error("Codex quota oracle was disposed"));
    processHandle.stdin.end();
    signalProcessGroup(processHandle.pid, "SIGTERM");
    await processHandle.exited;
    await this.readerTask;
    await this.stderrTask;
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

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = asObject(error)?.code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}
