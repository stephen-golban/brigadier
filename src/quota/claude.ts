import type { QuotaScope, QuotaSnapshot, QuotaWindow } from "../contracts.js";
import type {
  ClaudeQuotaOracle as ClaudeQuotaOracleContract,
  ClaudeQuotaWorkerEvent,
} from "./contracts.js";
import { deriveAccountStatus } from "./contracts.js";

type JsonObject = Record<string, unknown>;

type ClaudeSnapshot = QuotaSnapshot & { readonly vendor: "claude" };

/**
 * How cautious a reading is. A private copy of the ordering documented on
 * `deriveAccountStatus`, used only to settle two observations of the *same*
 * instant; see `ClaudeQuotaOracle.ingest`.
 */
const STATUS_CAUTION: Readonly<Record<QuotaSnapshot["status"], number>> =
  Object.freeze({
    exhausted: 3,
    warning: 2,
    unknown: 1,
    available: 0,
  });

const ACCOUNT_SCOPE: QuotaScope = Object.freeze({ kind: "account" });

const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10_080;

/**
 * The shape of every `rateLimitType` Claude Code 2.1.224 can emit.
 *
 * Extracted from the CLI's own compiled Zod enum, recorded in R-11 §3a:
 * `five_hour | seven_day | seven_day_opus | seven_day_sonnet |
 * seven_day_overage_included | overage`. The previous implementation matched
 * two of those six and dropped the other four into `kind: "unknown"` with a
 * null duration, which is how a model-scoped limit lost its identity.
 *
 * `five_hour` and `seven_day` are account-scoped by definition — the CLI calls
 * them "session limit" and "weekly limit", and R-11 §1b quotes Anthropic saying
 * switching models does not restore access once they are spent.
 *
 * `seven_day_overage_included` and `overage` are account-scoped too, and that is
 * a CONSERVATIVE DEFAULT UNDER GENUINE UNCERTAINTY — not a fact read off the
 * binary. Say so plainly, because an earlier revision of this comment claimed
 * otherwise and the claim did not survive review.
 *
 * What was claimed: that both belong to a *unified* response-header family
 * alongside `five_hour` and `seven_day` (`{"5h":"five_hour","7d":"seven_day",
 * "7d_oi":"seven_day_overage_included","overage":"overage"}` against
 * `anthropic-ratelimit-unified-<abbrev>-*`) which carries no model dimension.
 * Why that is not evidence: re-reading the 2.1.224 binary shows there is no
 * per-type unified header for *any* type — not for `5h`, `7d`, `7d_oi`,
 * `7d_opus`, or `7d_sonnet`. The observation therefore fails to distinguish
 * `seven_day_overage_included` from `seven_day_opus`, which everyone agrees is
 * model-scoped. It separates nothing, so it settles nothing.
 *
 * What points the other way: the CLI's own display label for
 * `seven_day_overage_included` reads "Fable 5 limit", which names a model
 * family. That is weak evidence rather than none — R-11 §3a shows those labels
 * are plan-dependent prose, and the same table relabels the Sonnet bucket to the
 * generic "weekly limit" on `pro` — but it is the only direct signal either way,
 * and it disagrees with the scope chosen here.
 *
 * Why account scope stays anyway: the two errors are not symmetric. Calling a
 * genuinely model-scoped bucket account-scoped over-restricts and can cost a
 * refused slice. Calling a genuinely account-scoped bucket model-scoped claims
 * every other model still runs on evidence brigadier does not have, and launches
 * a worker into a wall — the exact waste this unit exists to prevent. Under a
 * tie in evidence, take the error that wastes capacity over the error that
 * wastes a launch.
 *
 * What would settle it, for whoever picks this up: one observed
 * `rate_limit_event` carrying `rateLimitType: "seven_day_overage_included"` on
 * an account where a *different* model family is known to still run, or the
 * account usage payload's own `limits[].scope.model` field (quoted in R-11 §3a)
 * read for that bucket. Either is direct; nothing short of one of them is.
 *
 * `overage` sits on the same conservative footing with no display label pointing
 * the other way: "usage credit limit" names a purchased pool, not a model. It
 * also gets `kind: "unknown"` and a null duration on purpose. It meters a
 * purchased credit pool, and no window length for it is published or observable
 * — the only hint in the binary is an "overage-period-monthly" telemetry name,
 * which is not a commitment. Reporting a made-up 30-day window would be a
 * guarantee brigadier cannot honour.
 */
const ACCOUNT_WINDOW_SHAPES: Readonly<
  Record<
    string,
    { readonly kind: QuotaWindow["kind"]; readonly minutes: number | null }
  >
> = Object.freeze({
  five_hour: { kind: "rolling", minutes: FIVE_HOUR_MINUTES },
  seven_day: { kind: "weekly", minutes: SEVEN_DAY_MINUTES },
  seven_day_overage_included: { kind: "weekly", minutes: SEVEN_DAY_MINUTES },
  overage: { kind: "unknown", minutes: null },
});

/**
 * Model-scoped types are recognized by their prefix rather than by an
 * enumeration, so `seven_day_opus` yields `"opus"` and a `seven_day_haiku` that
 * ships next month yields `"haiku"` without a code change. The tail of the wire
 * token *is* the tier name; nothing is invented by lowercasing it.
 *
 * The four account-scoped tokens are matched first, which is what keeps
 * `seven_day_overage_included` from being mistaken for a model called
 * "overage_included".
 */
const MODEL_SCOPED_PREFIX = "seven_day_";

/** Retains Claude's live rate-limit observations, one slot per quota bucket. */
export class ClaudeQuotaOracle implements ClaudeQuotaOracleContract {
  readonly vendor = "claude" as const;

  /**
   * One entry per quota bucket, in first-observation order.
   *
   * The original implementation was `this.latest = event.snapshot` — a single
   * slot, last-writer-wins. Claude's buckets are independent and report
   * independently, so an `allowed` five-hour event arriving after a `rejected`
   * Opus event silently erased the exhaustion, and vice versa. A `Map` keyed by
   * bucket lets both coexist, and because re-setting an existing key does not
   * move it, the emitted window order stays stable across re-observations.
   *
   * The key is the vendor's own `rateLimitType`; see `bucketKey` for why the
   * normalized `(kind, scope)` pair it used to be was not an identity.
   */
  private readonly buckets = new Map<
    string,
    { readonly window: QuotaWindow; readonly observedAtMs: number }
  >();
  private readonly options: ClaudeQuotaOracleOptions;
  private latestObservedAtMs: number | null = null;
  private isUsingOverage: boolean | null = null;
  private disposed = false;

  constructor(options: ClaudeQuotaOracleOptions = {}) {
    this.options = options;
  }

  ingest(event: ClaudeQuotaWorkerEvent): void {
    if (this.disposed) {
      throw new Error("Claude quota oracle is disposed");
    }
    if (event.type !== "quota" || event.snapshot.vendor !== "claude") {
      throw new TypeError(
        "Claude quota oracle only accepts Claude quota events",
      );
    }

    const { observedAtMs } = event.snapshot;
    // Claude puts exactly one `rate_limit_info` on a `rate_limit_event`, so a
    // one-window snapshot is the shape this adapter's own normalizer produces
    // and its wire type identifies that single window unambiguously. A snapshot
    // carrying several windows did not come from one event, so the one type on
    // `raw` cannot be attributed to any particular window; those fall back to
    // the shape key rather than being collapsed together under a shared type.
    const wireType =
      event.snapshot.windows.length === 1 ? wireBucketId(event.raw) : null;
    for (const window of event.snapshot.windows) {
      const key = bucketKey(window, wireType);
      const current = this.buckets.get(key);
      // A strictly later reading always wins, however optimistic. Two readings
      // of the same instant that disagree are settled by caution rather than by
      // arrival order, so replaying the same two events in the other order
      // cannot produce a different snapshot. This mirrors the router's
      // `indexQuota`, and the strict `>` is load-bearing for the same reason.
      if (
        current === undefined ||
        observedAtMs > current.observedAtMs ||
        (observedAtMs === current.observedAtMs &&
          STATUS_CAUTION[window.status] > STATUS_CAUTION[current.window.status])
      ) {
        this.buckets.set(key, { window, observedAtMs });
      }
    }

    if (
      this.latestObservedAtMs === null ||
      observedAtMs >= this.latestObservedAtMs
    ) {
      this.latestObservedAtMs = observedAtMs;
      this.isUsingOverage = event.snapshot.isUsingOverage;
    }
  }

  /**
   * The accumulated buckets, minus any the vendor has already declared expired.
   *
   * Ageing is deliberately driven by the vendor's own `resetsAt` and by nothing
   * else. A window whose declared reset instant has passed is no longer evidence
   * about the present, and keeping it would pin a vendor `exhausted` for the
   * whole life of a long-running supervisor after one five-hour rejection.
   * Windows with no reset time are kept indefinitely: Claude emits a
   * `rate_limit_event` only when rate-limit info *changes*, so silence means
   * "unchanged", not "stale", and inventing an expiry for them would discard a
   * live signal on a timer brigadier made up.
   */
  async snapshot(): Promise<ClaudeSnapshot> {
    const now = this.options.now?.() ?? Date.now();
    const windows = [...this.buckets.values()]
      .filter(
        (entry) =>
          entry.window.resetsAtMs === null || entry.window.resetsAtMs > now,
      )
      .map((entry) => entry.window);

    return {
      vendor: "claude",
      status: deriveAccountStatus(windows),
      observedAtMs: this.latestObservedAtMs ?? now,
      windows,
      isUsingOverage: this.isUsingOverage,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

interface ClaudeQuotaOracleOptions {
  /** Injectable clock; the oracle reads it only to age expired windows out. */
  readonly now?: () => number;
}

export function createClaudeQuotaOracle(
  options: ClaudeQuotaOracleOptions = {},
): ClaudeQuotaOracle {
  return new ClaudeQuotaOracle(options);
}

/**
 * Keys one quota bucket by the vendor's own bucket identity.
 *
 * This used to key on the *normalized* `(kind, scope)` pair, and that was not an
 * identity. `ACCOUNT_WINDOW_SHAPES` maps both `seven_day` and
 * `seven_day_overage_included` to `kind: "weekly"` with account scope, so the
 * two collided: ingesting a rejected `seven_day` and then an allowed
 * `seven_day_overage_included` made the exhausted seven-day bucket *disappear*
 * and the snapshot report `available`. That is the same overwrite WO-010 removed
 * for model-scoped buckets, left in place for two account-scoped ones — the
 * normalization is deliberately many-to-one, so anything derived from it is
 * many-to-one too.
 *
 * `rateLimitType` is the vendor's own bucket key, and two different wire types
 * are two different buckets even when they normalize to the same shape. Prefer
 * it whenever it can be read. The `type|` / `shape|` prefixes keep the two
 * namespaces from colliding: a fallback shape key can never equal a wire-type
 * key, so a bucket observed once with a readable type and once without is at
 * worst reported twice, never silently merged with a different bucket.
 *
 * The fallback components come from closed vocabularies — three window kinds,
 * and labels that are lowercase `[a-z0-9_]` tier tokens off the wire — so `|`
 * cannot appear inside either.
 */
function bucketKey(window: QuotaWindow, rateLimitType: string | null): string {
  if (rateLimitType !== null) {
    return `type|${rateLimitType}`;
  }
  return window.scope.kind === "account"
    ? `shape|${window.kind}|account`
    : `shape|${window.kind}|model|${window.scope.label}`;
}

/**
 * The `rateLimitType` on a raw Claude `rate_limit_event`, or null.
 *
 * Read straight off the untouched vendor payload the `WorkerEvent` contract
 * already carries, because the normalized `QuotaWindow` has nowhere to put it:
 * `src/contracts.ts` is frozen and its `QuotaScope` is deliberately a normalized
 * tier token, not a vendor bucket id. Returning null for anything unreadable is
 * what makes the shape fallback in `bucketKey` reachable.
 */
function wireBucketId(raw: unknown): string | null {
  const event = asObject(raw);
  if (event?.type !== "rate_limit_event") {
    return null;
  }
  const info = asObject(event.rate_limit_info);
  const rateLimitType = info === null ? null : info.rateLimitType;
  return typeof rateLimitType === "string" && rateLimitType.length > 0
    ? rateLimitType
    : null;
}

/** Normalizes the raw payload retained on a Claude quota WorkerEvent. */
export function normalizeClaudeRateLimitEvent(
  raw: unknown,
  observedAtMs: number,
): ClaudeSnapshot | null {
  const event = asObject(raw);
  if (event?.type !== "rate_limit_event") {
    return null;
  }
  const info = asObject(event.rate_limit_info);
  if (info === null) {
    return null;
  }

  const windows = [normalizeWindow(info)];
  return {
    vendor: "claude",
    // Account-derived, never the raw `status`. A `rejected` on a model-scoped
    // bucket used to be reported as vendor-wide exhaustion, which told the
    // router the whole Claude account was dead while Sonnet and Haiku still ran.
    // An event that carries only a model-scoped window now yields `"unknown"`
    // here, because it says nothing at all about the account.
    status: deriveAccountStatus(windows),
    observedAtMs,
    windows,
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
  const rateLimitType =
    typeof info.rateLimitType === "string" ? info.rateLimitType : null;
  const resetsAt = info.resetsAt;
  const resetSeconds =
    typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt >= 0
      ? resetsAt
      : null;

  const shape = describeRateLimitType(rateLimitType);
  return {
    kind: shape.kind,
    scope: shape.scope,
    status: normalizeStatus(info.status),
    durationMinutes: shape.minutes,
    remainingFraction: normalizeRemainingFraction(info.utilization),
    resetsAtMs: resetSeconds === null ? null : resetSeconds * 1_000,
  };
}

function describeRateLimitType(rateLimitType: string | null): {
  readonly kind: QuotaWindow["kind"];
  readonly scope: QuotaScope;
  readonly minutes: number | null;
} {
  const accountShape =
    rateLimitType === null ? undefined : ACCOUNT_WINDOW_SHAPES[rateLimitType];
  if (accountShape !== undefined) {
    return { ...accountShape, scope: ACCOUNT_SCOPE };
  }

  if (rateLimitType?.startsWith(MODEL_SCOPED_PREFIX)) {
    const label = rateLimitType.slice(MODEL_SCOPED_PREFIX.length).toLowerCase();
    if (label.length > 0) {
      return {
        kind: "weekly",
        scope: { kind: "model", label },
        minutes: SEVEN_DAY_MINUTES,
      };
    }
  }

  // A missing or unrecognized type falls back to account scope on purpose. It
  // is the conservative reading — it can only over-report exhaustion, never
  // under-report it — and it is the only safe one, because a token brigadier
  // cannot parse yields no tier label to match a model against.
  return { kind: "unknown", scope: ACCOUNT_SCOPE, minutes: null };
}

/**
 * Claude reports `utilization` as a fraction in `[0, 1]`, not a percentage.
 *
 * Verified against the 2.1.224 binary rather than assumed: its warning
 * thresholds compare `utilization` against `0.9` for the five-hour window and
 * `0.75 / 0.5 / 0.25` for the weekly one. Reading the field as a percentage
 * would have turned a half-spent window into a 99.5%-remaining one. Values
 * outside the range are clamped rather than trusted.
 */
function normalizeRemainingFraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, 1 - value));
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}
