import type { QuotaSnapshot, QuotaWindow } from "../contracts.js";
import type {
  ClaudeQuotaOracle as ClaudeQuotaOracleContract,
  ClaudeQuotaWorkerEvent,
} from "./contracts.js";

type JsonObject = Record<string, unknown>;

/** Retains Claude's latest live rate-limit observation from worker events. */
export class ClaudeQuotaOracle implements ClaudeQuotaOracleContract {
  readonly vendor = "claude" as const;

  private latest: (QuotaSnapshot & { readonly vendor: "claude" }) | null = null;
  private disposed = false;

  ingest(event: ClaudeQuotaWorkerEvent): void {
    if (this.disposed) {
      throw new Error("Claude quota oracle is disposed");
    }
    if (event.type !== "quota" || event.snapshot.vendor !== "claude") {
      throw new TypeError(
        "Claude quota oracle only accepts Claude quota events",
      );
    }
    this.latest = event.snapshot;
  }

  async snapshot(): Promise<QuotaSnapshot & { readonly vendor: "claude" }> {
    return (
      this.latest ?? {
        vendor: "claude",
        status: "unknown",
        observedAtMs: Date.now(),
        windows: [],
        isUsingOverage: null,
      }
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export function createClaudeQuotaOracle(): ClaudeQuotaOracle {
  return new ClaudeQuotaOracle();
}

/** Normalizes the raw payload retained on a Claude quota WorkerEvent. */
export function normalizeClaudeRateLimitEvent(
  raw: unknown,
  observedAtMs: number,
): (QuotaSnapshot & { readonly vendor: "claude" }) | null {
  const event = asObject(raw);
  if (event?.type !== "rate_limit_event") {
    return null;
  }
  const info = asObject(event.rate_limit_info);
  if (info === null) {
    return null;
  }

  return {
    vendor: "claude",
    status: normalizeStatus(info.status),
    observedAtMs,
    windows: [normalizeWindow(info)],
    isUsingOverage:
      typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null,
  };
}

function normalizeStatus(value: unknown): QuotaSnapshot["status"] {
  switch (value) {
    case "allowed":
      return "available";
    case "allowed_warning":
      return "warning";
    case "rejected":
      return "exhausted";
    default:
      return "unknown";
  }
}

function normalizeWindow(info: JsonObject): QuotaWindow {
  const rateLimitType = info.rateLimitType;
  const resetsAt = info.resetsAt;
  const resetSeconds =
    typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt >= 0
      ? resetsAt
      : null;

  return {
    kind:
      rateLimitType === "seven_day"
        ? "weekly"
        : rateLimitType === "five_hour"
          ? "rolling"
          : "unknown",
    durationMinutes:
      rateLimitType === "five_hour"
        ? 300
        : rateLimitType === "seven_day"
          ? 10_080
          : null,
    remainingFraction: null,
    resetsAtMs: resetSeconds === null ? null : resetSeconds * 1_000,
  };
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}
