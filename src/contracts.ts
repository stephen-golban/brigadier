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
 * cached input as a subset. A null reasoning count means the vendor did not
 * report the bucket; zero means it explicitly reported no reasoning tokens.
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
    readonly reasoning: number | null;
  };
}

/** A sandbox posture that cannot silently degrade to unsandboxed execution. */
export interface EnforcedSandbox {
  readonly enabled: true;
  readonly failIfUnavailable: true;
  readonly filesystem: {
    readonly workspaceAccess: "read" | "edit";
    /**
     * Neutral path globs that an adapter maps to effective edit controls.
     * Claude must emit `Edit(glob)` rules; its accepted `Write(glob)` rules are
     * not consulted and therefore cannot enforce worker lanes.
     */
    readonly editablePaths: readonly string[];
  };
  readonly network: {
    /** An empty list denies network access rather than inheriting a default. */
    readonly allowedDomains: readonly [];
  };
}

/** Controls which ambient instruction files may enter an isolated worker. */
export interface InstructionFilePolicy {
  readonly user: "include" | "exclude";
  readonly project: "include" | "exclude";
}

interface WorkerSpecBase {
  readonly id: string;
  readonly executable: string;
  readonly model: string;
  readonly effort: Effort;
  /** Adapters must send the prompt through stdin, never as positional argv. */
  readonly prompt: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly sandbox: EnforcedSandbox;
  readonly instructionFiles: InstructionFilePolicy;
  readonly timeoutMs: number | null;
  readonly maxTurns: number | null;
}

/**
 * Claude-only launch controls. Raw argv is intentionally absent: in particular,
 * adapters cannot expose `--system-prompt`, `--safe-mode`, or `--bare` through
 * this contract.
 */
export interface ClaudeWorkerSpec extends WorkerSpecBase {
  readonly vendor: "claude";
  readonly maxBudgetUsd: number | null;
  readonly excludeDynamicSystemPromptSections: true;
  /** The adapter maps this to `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. */
  readonly autoMemory: "disabled";
  readonly tools: readonly string[];
  readonly extraDirectories: readonly string[];
  readonly mcp: {
    readonly configFiles: readonly string[];
    readonly strict: true;
  };
}

/** Codex cannot accept a USD budget because it reports no enforceable cost. */
export interface CodexWorkerSpec extends WorkerSpecBase {
  readonly vendor: "codex";
  readonly maxBudgetUsd?: never;
}

/** Everything an adapter needs to launch one headless worker process. */
export type WorkerSpec = ClaudeWorkerSpec | CodexWorkerSpec;

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

/**
 * Retry categories emitted by Claude's system/api_retry event. Adapters consume
 * these events as telemetry; the vendor CLI already owns the retry loop.
 */
export type ApiRetryError =
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "billing_error"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

interface WorkerEventBase {
  /** The untouched vendor event. Adapters must never reconstruct this value. */
  readonly raw: unknown;
}

/** Vendor-neutral events with a lossless escape hatch for every wire payload. */
export type WorkerEvent =
  | (WorkerEventBase & {
      readonly type: "started";
      /** Claude session id or Codex thread id. This event may never arrive. */
      readonly sessionId: string;
    })
  | (WorkerEventBase & {
      readonly type: "message";
      readonly text: string;
    })
  | (WorkerEventBase & {
      readonly type: "tool";
      readonly id: string | null;
      readonly name: string;
      readonly phase: "started" | "updated" | "completed";
      readonly input: unknown | null;
      readonly output: unknown | null;
    })
  | (WorkerEventBase & {
      readonly type: "file_change";
      readonly changes: readonly {
        readonly path: string;
        readonly kind: "created" | "modified" | "deleted" | "unknown";
      }[];
    })
  | (WorkerEventBase & {
      readonly type: "notice";
      readonly level: "info" | "warning" | "error";
      readonly message: string;
    })
  | (WorkerEventBase & {
      readonly type: "api_retry";
      readonly attempt: number;
      readonly maxRetries: number;
      readonly retryDelayMs: number;
      readonly statusCode: number | null;
      readonly error: ApiRetryError;
    })
  | (WorkerEventBase & {
      readonly type: "quota";
      readonly snapshot: QuotaSnapshot;
    })
  | (WorkerEventBase & {
      readonly type: "other";
      readonly description: string;
    });

interface WorkerOutcomeBase {
  readonly output: string;
  readonly usage: TokenUsage;
  /** Absent for vendors, such as Codex, that do not report cost. */
  readonly costUsd?: number;
  readonly durationMs: number;
  /** Null when the process never launched or was terminated by a signal. */
  readonly exitCode: number | null;
  /** The terminating OS signal, or null when no signal was observed. */
  readonly signal: string | null;
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

export type CancelReason =
  | { readonly kind: "requested"; readonly message: string | null }
  | { readonly kind: "timeout"; readonly message: string | null }
  | { readonly kind: "shutdown"; readonly message: string | null }
  | { readonly kind: "dependency_failed"; readonly message: string | null };

/** Observable process termination behavior, declared by each adapter. */
export type ProcessCompletionBehavior =
  | "self-exits"
  | "signals-then-must-be-killed"
  | "does-neither";

/** The three independent channels produced by one worker spawn. */
export interface SpawnedWorker {
  readonly pid: number;
  /** Session/thread identity, if any, arrives through this stream. */
  readonly events: AsyncIterable<WorkerEvent>;
  /** Resolves from adapter completion logic, not necessarily process exit. */
  readonly completion: Promise<WorkerOutcome>;
  /** Must terminate the entire process group, including descendants. */
  cancel(reason: CancelReason): Promise<void>;
}

/**
 * Shared worker abstraction. Steering and Claude's bidirectional control
 * replies remain adapter-specific obligations.
 */
export interface Worker<V extends Vendor = Vendor> {
  readonly vendor: V;
  /** Claude does not signal completion or self-exit; Codex exec self-exits. */
  readonly processCompletion: V extends "claude"
    ? "does-neither"
    : "self-exits";
  spawn(
    spec: Extract<WorkerSpec, { readonly vendor: V }>,
  ): Promise<SpawnedWorker>;
}

/** A vendor quota source whose process or connection may be long-lived. */
export interface QuotaOracle<V extends Vendor = Vendor> {
  readonly vendor: V;
  snapshot(): Promise<QuotaSnapshot & { readonly vendor: V }>;
  /** Closes open pipes and waits for owned resources to terminate. */
  dispose(): Promise<void>;
}

export interface WorktreeSpec {
  readonly repositoryPath: string;
  readonly baseRef: string;
  readonly branch: string;
}

export interface CreatedWorktree {
  readonly path: string;
  readonly branch: string;
}

/** Creates and removes isolated working directories for worker cwd values. */
export interface WorktreeEngine {
  create(spec: WorktreeSpec): Promise<CreatedWorktree>;
  remove(worktree: CreatedWorktree): Promise<void>;
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
