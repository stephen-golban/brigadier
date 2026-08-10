/**
 * FROZEN SHARED CORE (WO-000e).
 *
 * This contract is shared by WO-001, WO-002, and WO-003. Amend it only through
 * a deliberate decision agreed by all three units, never as a side effect of
 * one unit's implementation. It owns the vendor, effort, and failure
 * vocabulary; token usage; worker spec and environment types; the event and
 * outcome unions; spawn and worker types; and the adapter registry.
 *
 * AMENDED ONCE, IN WO-010, AND ONLY IN THE QUOTA TYPES.
 *
 * The freeze held byte-identical from WO-000e through nineteen work orders. It
 * was spent deliberately here because `QuotaWindow` could not represent a fact
 * both vendors put on the wire: quota is metered per *model tier* as well as
 * per account. R-11 (`docs/research/R-11-quota-metering.md`) verified that
 * Claude's `rateLimitType` enumerates `seven_day_opus` and `seven_day_sonnet`
 * beside the account-wide `five_hour` and `seven_day`, and that OpenAI returns
 * `rateLimitsByLimitId` — a map of independent buckets, one of which was
 * observed model-named and at 0% while the account bucket sat at 72%.
 *
 * Without a scope on the window, an Opus-only limit had to be reported as
 * vendor-wide exhaustion, which told brigadier the whole Claude account was
 * dead while Sonnet and Haiku were still running. That is a correctness defect
 * in the type, not in a caller, so it could only be fixed here.
 *
 * The amendment adds `QuotaScope`, gives `QuotaWindow` a `scope` and its own
 * `status`, and re-documents `QuotaSnapshot.status` as account-derived. Nothing
 * else in this file changed: not the worker contract, not the event union, not
 * the effort ladder, not `Capability`. The freeze is spent, not eroded.
 */

/**
 * Completion taxonomy defined by the action required from the supervisor:
 *
 * - `self-exits`: the supervisor must wait for the process to exit on its own
 *   and use OS exit as the completion signal.
 * - `signals-then-must-be-killed`: the process emits a detectable terminal
 *   marker in its stream, then keeps running; the supervisor must detect that
 *   marker and kill the process group.
 */
export type ProcessCompletionBehavior =
  | "self-exits"
  | "signals-then-must-be-killed";

/** Runtime metadata used to enumerate and probe installed worker adapters. */
export interface AdapterDeclaration<V extends string> {
  readonly vendor: V;
  readonly executable: string;
  readonly processCompletion: ProcessCompletionBehavior;
}

/**
 * The installed-adapter probe iterates this table. Adding a vendor extends the
 * table and derived union without reshaping the shared worker contract.
 */
export const ADAPTER_DECLARATIONS = [
  {
    vendor: "claude",
    executable: "claude",
    processCompletion: "signals-then-must-be-killed",
  },
  {
    vendor: "codex",
    executable: "codex",
    processCompletion: "self-exits",
  },
] as const satisfies readonly AdapterDeclaration<string>[];

/** Vendors with supported worker adapters. */
export type Vendor = (typeof ADAPTER_DECLARATIONS)[number]["vendor"];

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
     * Claude must emit both an `Edit(glob)` and a `Write(glob)` rule per path:
     * measured against claude 2.1.226 under `--permission-mode dontAsk`, an
     * in-lane `Write` created a file that did not exist and an out-of-lane one
     * was denied and left nothing on disk, so both rule kinds are consulted and
     * both enforce worker lanes.
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

/** Environment values required for every non-TTY worker launch. */
export type WorkerEnvironment = Readonly<Record<string, string>> & {
  readonly SHELL: "/bin/sh";
};

/** Claude-specific environment guarantees derived directly from the map. */
export type ClaudeWorkerEnvironment = WorkerEnvironment & {
  readonly CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1";
};

/** An idle timeout validated to be strictly above Claude's 600-second stall boundary. */
declare const idleTimeoutMsBrand: unique symbol;
export type IdleTimeoutMs = number & {
  readonly [idleTimeoutMsBrand]: "IdleTimeoutMs";
};

export const IDLE_TIMEOUT_BOUNDARY_MS = 600_000;

/**
 * Default idle timeout for worker specs. Keep this strictly above 600 seconds
 * so a healthy silent Claude run is not mistaken for completion or a stall.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = createIdleTimeoutMs(900_000);

/**
 * The only sanctioned constructor for an idle timeout used in a worker spec.
 * Because a cast can smuggle a sub-boundary value past the brand, WO-001
 * adapters must re-validate this value at the spawn boundary.
 */
export function createIdleTimeoutMs(value: number): IdleTimeoutMs {
  if (!Number.isSafeInteger(value) || value <= IDLE_TIMEOUT_BOUNDARY_MS) {
    throw new RangeError(
      `idle timeout must be a whole number above ${IDLE_TIMEOUT_BOUNDARY_MS} ms`,
    );
  }
  return value as IdleTimeoutMs;
}

interface WorkerSpecBase {
  readonly id: string;
  readonly model: string;
  readonly effort: Effort;
  /** Adapters must send the prompt through stdin, never as positional argv. */
  readonly prompt: string;
  readonly cwd: string;
  readonly environment: WorkerEnvironment;
  readonly sandbox: EnforcedSandbox;
  readonly instructionFiles: InstructionFilePolicy;
  /** Idle timeout, distinct from the total runtime limit in `timeoutMs`. */
  readonly idleTimeoutMs: IdleTimeoutMs;
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
  readonly environment: ClaudeWorkerEnvironment;
  readonly maxBudgetUsd: number | null;
  readonly excludeDynamicSystemPromptSections: true;
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

/**
 * What a quota window meters: the whole account, or one model tier.
 *
 * `label` is a normalized tier token such as `"opus"` or `"sonnet"`, never the
 * vendor's display prose. The vendors ship display strings ("Opus limit") whose
 * wording is plan-dependent and therefore useless as a matching key; the token
 * is derived from the stable wire identifier instead.
 */
export type QuotaScope =
  | { readonly kind: "account" }
  | { readonly kind: "model"; readonly label: string };

export interface QuotaWindow {
  readonly kind: "rolling" | "weekly" | "unknown";
  readonly scope: QuotaScope;
  readonly status: "available" | "warning" | "exhausted" | "unknown";
  readonly durationMinutes: number | null;
  readonly remainingFraction: number | null;
  readonly resetsAtMs: number | null;
}

/** A point-in-time, vendor-normalized view of account quota. */
export interface QuotaSnapshot {
  readonly vendor: Vendor;
  /**
   * Derived from ACCOUNT-scoped windows only. A drained model-scoped window must
   * never make the whole vendor look exhausted — that is the defect this reshape
   * exists to fix.
   */
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

export type SuccessfulWorkerOutcome = WorkerOutcomeBase & {
  readonly ok: true;
  readonly failure?: never;
};

export type FailedLaunchedWorkerOutcome = WorkerOutcomeBase & {
  readonly ok: false;
  readonly failure: WorkerFailure & {
    readonly kind: Exclude<FailureKind, "LAUNCH_FAILURE">;
  };
};

export type LaunchFailureWorkerOutcome = WorkerOutcomeBase & {
  readonly ok: false;
  readonly exitCode: null;
  readonly signal: null;
  readonly failure: WorkerFailure & { readonly kind: "LAUNCH_FAILURE" };
};

export type LaunchedWorkerOutcome =
  | SuccessfulWorkerOutcome
  | FailedLaunchedWorkerOutcome;

export type WorkerOutcome = LaunchedWorkerOutcome | LaunchFailureWorkerOutcome;

export type CancelReason =
  | { readonly kind: "requested"; readonly message: string | null }
  | { readonly kind: "timeout"; readonly message: string | null }
  | { readonly kind: "shutdown"; readonly message: string | null }
  | { readonly kind: "dependency_failed"; readonly message: string | null };

interface SpawnedWorkerBase {
  /** Session/thread identity, if any, arrives through this stream. */
  readonly events: AsyncIterable<WorkerEvent>;
  /** Must terminate the entire process group, including descendants. */
  cancel(reason: CancelReason): Promise<void>;
}

/**
 * The three channels produced by one worker spawn, coupled so launch state and
 * completion outcome cannot contradict one another.
 */
export type SpawnedWorker = SpawnedWorkerBase &
  (
    | {
        readonly pid: number;
        /** Resolves from adapter completion logic, not necessarily process exit. */
        readonly completion: Promise<LaunchedWorkerOutcome>;
      }
    | {
        readonly pid: null;
        readonly completion: Promise<LaunchFailureWorkerOutcome>;
      }
  );

/**
 * Shared worker abstraction. Steering and Claude's bidirectional control
 * replies remain adapter-specific obligations.
 */
export interface Worker<V extends Vendor = Vendor> {
  readonly vendor: V;
  readonly processCompletion: Extract<
    (typeof ADAPTER_DECLARATIONS)[number],
    { readonly vendor: V }
  >["processCompletion"];
  /** Launch failures resolve through `completion` with a null `pid`. */
  spawn(
    spec: Extract<WorkerSpec, { readonly vendor: V }>,
  ): Promise<SpawnedWorker>;
}

/** A heterogeneous worker union that preserves vendor/behavior correlation. */
export type AnyWorker = { [V in Vendor]: Worker<V> }[Vendor];

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
