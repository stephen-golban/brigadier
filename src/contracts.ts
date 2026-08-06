/** Vendors with supported worker adapters. */
export type Vendor = "claude" | "codex";

/** Deliberately narrower than the effort values accepted by vendor CLIs. */
export type Effort = "medium" | "high" | "xhigh";

/** The exhaustive, vendor-normalized failure taxonomy. */
export const FAILURE_KINDS = [
  "QUOTA_EXHAUSTED",
  "BUDGET_EXCEEDED",
  "API_ERROR",
  "AUTH_FAILURE",
  "TURN_LIMIT",
  "PERMISSION_DENIED",
  "CANCELLED",
  "REFUSED",
  "SCHEMA_FAILURE",
  "BAD_MODEL",
  "THROTTLED",
  "TRANSIENT",
  "LAUNCH_FAILURE",
  "ARGV_BUG",
  "UNKNOWN_FAILURE",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface WorkerFailure {
  readonly kind: FailureKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly statusCode: number | null;
}

/**
 * Normalized token accounting.
 *
 * `input.total` always includes every input token. `input.uncached`,
 * `input.cacheRead`, and `input.cacheWrite` make vendor accounting explicit:
 * Claude reports these as separate buckets, while Codex reports `total` with
 * cached input as a subset.
 */
export interface TokenUsage {
  readonly input: {
    readonly total: number;
    readonly uncached: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly output: {
    readonly total: number;
    readonly reasoning: number;
  };
}

/** Everything an adapter needs to launch one headless worker process. */
export interface WorkerSpec {
  readonly id: string;
  readonly vendor: Vendor;
  readonly executable: string;
  readonly model: string;
  readonly effort: Effort;
  readonly prompt: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly permissionMode: "read-only" | "workspace-write";
  readonly timeoutMs: number | null;
  readonly maxTurns: number | null;
  readonly maxBudgetUsd: number | null;
}

export interface QuotaWindow {
  readonly kind: "rolling" | "weekly" | "unknown";
  readonly durationMinutes: number | null;
  readonly remainingFraction: number | null;
  readonly resetsAtMs: number | null;
}

/** A point-in-time, vendor-normalized view of account quota. */
export interface QuotaSnapshot {
  readonly vendor: Vendor;
  readonly status: "available" | "warning" | "exhausted" | "unknown";
  readonly observedAtMs: number;
  readonly windows: readonly QuotaWindow[];
  readonly isUsingOverage: boolean | null;
}

/** Events deliberately limited to the streaming surface available from Claude. */
export type WorkerEvent =
  | {
      readonly type: "started";
      readonly sessionId: string;
    }
  | {
      readonly type: "message";
      readonly text: string;
    }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly phase: "started" | "completed";
      readonly input: unknown | null;
      readonly output: unknown | null;
    }
  | {
      readonly type: "notice";
      readonly level: "info" | "warning" | "error";
      readonly message: string;
    }
  | {
      readonly type: "quota";
      readonly snapshot: QuotaSnapshot;
    };

interface WorkerOutcomeBase {
  readonly output: string;
  readonly usage: TokenUsage;
  /** Absent for vendors, such as Codex, that do not report cost. */
  readonly costUsd?: number;
  readonly durationMs: number;
  /** Claude session id or Codex thread id; null when launch fails before one exists. */
  readonly sessionId: string | null;
  /** Null when the process never launched or was terminated by a signal. */
  readonly exitCode: number | null;
}

export type WorkerOutcome = WorkerOutcomeBase &
  (
    | {
        readonly ok: true;
        readonly failure?: never;
      }
    | {
        readonly ok: false;
        readonly failure: WorkerFailure;
      }
  );

/**
 * Shared worker abstraction. It is intentionally one-shot: steering, forking,
 * live diffs, and direct quota reads remain optional Codex-adapter extensions.
 */
export interface Worker {
  readonly vendor: Vendor;
  run(
    spec: WorkerSpec,
    onEvent?: (event: WorkerEvent) => void,
  ): Promise<WorkerOutcome>;
}

/** One independently executable unit with exclusive ownership of its file set. */
export interface Slice {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly ownedPaths: readonly string[];
  readonly dependsOn: readonly string[];
}

/** A dependency-aware set of work slices. */
export interface Plan {
  readonly id: string;
  readonly goal: string;
  readonly slices: readonly Slice[];
}

/** Static capabilities for a specific vendor/model pair. */
export interface Capability {
  readonly vendor: Vendor;
  readonly model: string;
  readonly supportedEfforts: readonly Effort[];
  readonly supportsImageInput: boolean;
  readonly supportsWebSearch: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
}
