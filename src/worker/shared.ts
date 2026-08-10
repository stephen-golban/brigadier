import type {
  CancelReason,
  FailedLaunchedWorkerOutcome,
  FailureKind,
  LaunchedWorkerOutcome,
  TokenUsage,
  WorkerFailure,
  WorkerSpec,
} from "../contracts.ts";
import type { DetachedProcess } from "../shared/process.ts";
import { writeAndEnd } from "../shared/process.ts";

export const EMPTY_USAGE: TokenUsage = {
  input: { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 },
  output: { total: 0, reasoning: null },
};

type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

export function describeRaw(raw: unknown): string {
  if (isObject(raw) && typeof raw.type === "string") {
    return raw.type;
  }
  return "unrecognized vendor payload";
}

export function cancellationFailure(reason: CancelReason): WorkerFailure {
  return {
    kind: "CANCELLED",
    message: reason.message ?? cancellationMessage(reason.kind),
    retryable: reason.kind === "timeout" || reason.kind === "dependency_failed",
    statusCode: null,
  };
}

export function failureOutcome(
  failure: WorkerFailure,
  startedAtMs: number,
  processHandle: DetachedProcess,
  output = "",
  usage: TokenUsage = EMPTY_USAGE,
): FailedLaunchedWorkerOutcome {
  return {
    ok: false,
    output,
    usage,
    durationMs: elapsedMs(startedAtMs),
    exitCode: processHandle.exitCode,
    signal: processHandle.signalCode,
    failure: failure as WorkerFailure & {
      readonly kind: Exclude<FailureKind, "LAUNCH_FAILURE">;
    },
  };
}

export function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Math.round(performance.now() - startedAtMs));
}

export function workerEnvironment(spec: WorkerSpec): Record<string, string> {
  return { ...spec.environment, SHELL: "/bin/sh" };
}

export async function writePromptAndClose(
  sink: DetachedProcess["stdin"],
  prompt: string,
): Promise<void> {
  // Both adapters are one-shot. Closing stdin avoids adopting Claude's
  // bidirectional control protocol, which is outside the frozen Worker API.
  await writeAndEnd(sink, prompt);
}

export function parseEmbeddedError(message: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(message);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function classifyHttpFailure(
  statusCode: number | null,
  message: string,
): WorkerFailure & {
  readonly kind: Exclude<FailureKind, "LAUNCH_FAILURE">;
} {
  const lowerMessage = message.toLowerCase();
  if (
    statusCode === 404 ||
    lowerMessage.includes("model_not_found") ||
    lowerMessage.includes("model is not supported") ||
    lowerMessage.includes("selected model")
  ) {
    return failure("BAD_MODEL", message, false, statusCode);
  }
  if (statusCode === 401) {
    return failure("AUTH_FAILURE", message, false, statusCode);
  }
  if (statusCode === 403) {
    return failure("PERMISSION_DENIED", message, false, statusCode);
  }
  if (statusCode === 429) {
    return failure("THROTTLED", message, true, statusCode);
  }
  if (statusCode !== null && statusCode >= 500) {
    return failure("TRANSIENT", message, true, statusCode);
  }
  return failure("API_ERROR", message, false, statusCode);
}

export function failure(
  kind: Exclude<FailureKind, "LAUNCH_FAILURE">,
  message: string,
  retryable: boolean,
  statusCode: number | null,
): WorkerFailure & { readonly kind: Exclude<FailureKind, "LAUNCH_FAILURE"> } {
  return { kind, message, retryable, statusCode };
}

export function exitFailure(
  vendor: "claude" | "codex",
  exitCode: number | null,
  stderr: string,
): WorkerFailure & { readonly kind: Exclude<FailureKind, "LAUNCH_FAILURE"> } {
  const message = stderr.trim() || `${vendor} exited with code ${exitCode}`;
  if (vendor === "codex" && exitCode === 2) {
    return failure("ARGV_BUG", message, false, null);
  }
  if (vendor === "claude" && exitCode === 1) {
    return failure("ARGV_BUG", message, false, null);
  }
  return failure("UNKNOWN_FAILURE", message, false, null);
}

export function successfulOutcome(
  fields: Omit<Extract<LaunchedWorkerOutcome, { readonly ok: true }>, "ok">,
): LaunchedWorkerOutcome {
  return { ok: true, ...fields };
}

function cancellationMessage(kind: CancelReason["kind"]): string {
  switch (kind) {
    case "requested":
      return "worker cancellation requested";
    case "timeout":
      return "worker timed out";
    case "shutdown":
      return "worker cancelled during shutdown";
    case "dependency_failed":
      return "worker dependency failed";
  }
}
