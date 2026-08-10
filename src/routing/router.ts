/**
 * The routing engine: one slice plus a judgement of how hard it is, in; one
 * `{vendor, model, effort}` plus the trace that produced it, out.
 *
 * The pipeline is decision #7's, in order — quota, exclusion, capability
 * filter, competence rank, difficulty, effort, cost — and vendor is not a
 * stage. Exclusion is an eligibility fact about an exact model that already
 * failed this slice, not a ranking input. Every configured model from every
 * configured vendor otherwise enters one pool and competes on the competence
 * scale in `./competence.ts`; nothing in this file may branch on `entry.vendor`
 * to prefer one, and the only places vendor is read at all are quota (which is
 * scoped to an account, so it has to be) and the identity of a model.
 *
 * The rules below are product decisions rather than implementation choices, and
 * every one of them is load-bearing:
 *
 * - Difficulty sets a *floor*, and the winner is the **lowest** scorer above
 *   it. Ranking without that inversion would route every slice to the best
 *   model on the machine and make the "cost" stage decorative.
 * - `xhigh` is unreachable unless a routed model already ran this slice and
 *   failed (decisions #9/#20). Effort is clamped downward only, from a base
 *   that can be `xhigh` solely on an escalated request, and
 *   `assertEffortEarned` re-checks the result rather than trusting the
 *   arithmetic. A routing failure, where no model ran, does not escalate.
 * - Quota is resolved **per model, not per vendor** (WO-010B). A CLI account
 *   meters some limits account-wide and others per model tier — a drained
 *   `seven_day_opus` bucket says nothing about Sonnet — so each pooled model
 *   asks `modelQuotaStatus` about itself. Reading only `QuotaSnapshot.status`
 *   made an Opus-only limit invisible to the router, which then routed a hard
 *   slice straight into the drained tier; reading a model-scoped window as
 *   vendor-wide exhaustion, which is what the code did before the WO-010A
 *   reshape, made a healthy Sonnet unreachable. Per-model is the only reading
 *   that is wrong in neither direction.
 * - The difficulty floor is waived **only with the user's explicit consent**,
 *   recorded as `BrigadierConfig.allowDegradedRouting`. When the ordinary
 *   pipeline yields nothing and the flag is off, `route` fails and says so; a
 *   user who left it off asked to be told brigadier could not route the slice,
 *   not to have it quietly run on something under the bar.
 * - When the flag is on, the last resort is a **salvage pool**: every model that
 *   passed the capability filter, resolves to a runnable effort, and was
 *   eliminated *only* for scoring below the difficulty floor. Highest competence
 *   wins — the one place in the engine where highest rather than lowest wins,
 *   because "cheapest adequate" has no adequate set left to range over once the
 *   floor is gone. Ties break on config order, like everywhere else.
 * - A quota-exhausted model is **never** in that pool. The waiver waives the
 *   floor and nothing else; capability, effort, and quota all still answer "can
 *   this model do the work at all", which no amount of consent changes.
 *
 * WO-010H removed the per-vendor `quotaFallbackModel` this stage used to be
 * built around, and the removal was a deletion rather than a rename because
 * per-model quota (WO-010B) had already taken both halves of its job away:
 *
 * - Its stated job now happens without it. Claude meters Opus separately, so a
 *   drained Opus tier leaves Sonnet in the pool, where Sonnet competes and wins
 *   on merit through the ordinary pipeline. No substitution is looked up, no
 *   consent is spent, and no floor is waived.
 * - Its remaining code path was provably dead. `parseConfig` required a
 *   fallback to name one of that vendor's *own* models, salvage only consulted a
 *   vendor once *every* one of its models was exhausted, and WO-010G made
 *   salvage re-check per-model quota — so the named fallback was always itself
 *   exhausted and always rejected.
 *
 * What was left of it was consent, and consent is what `allowDegradedRouting`
 * records. Everything the field could still reach — the drained half of the
 * salvage pool, the healthy/drained tie-break, the `usedQuotaFallback` flag —
 * went with it, and `RoutedWorker.waivedDifficultyFloor` now states the one
 * thing about a salvage run that is true and useful: the slice ran below the
 * bar its difficulty asked for.
 *
 * `route` is pure and synchronous: no clock, no filesystem, no subprocess. It
 * returns a failure rather than throwing for anything a caller could
 * legitimately hand it; it throws only for a structurally invalid request,
 * which is a bug in the caller and not a routing outcome.
 */

import type { BrigadierConfig } from "../config/contracts.js";
import { EFFORT_LADDER } from "../config/contracts.js";
import type {
  Capability,
  Effort,
  QuotaSnapshot,
  QuotaWindow,
  Vendor,
} from "../contracts.js";
import { modelQuotaStatus } from "../quota/contracts.js";
import {
  DIFFICULTY_FLOORS,
  matchCompetenceRule,
  scoreModelId,
} from "./competence.js";
import type {
  ExcludedModel,
  RoutingDecision,
  RoutingInput,
  RoutingRejection,
  RoutingRequest,
  SliceRequirements,
} from "./contracts.js";

/** One configured, permitted model, flattened out of the vendor grouping. */
interface PooledModel {
  readonly vendor: Vendor;
  readonly model: string;
  readonly effortCeiling: Effort;
  /**
   * Position in the flattened `config.vendors[].models`. Equal competence
   * scores break on this, so two models that tie resolve the same way on every
   * run and on every machine with the same config.
   */
  readonly order: number;
}

interface ScoredModel extends PooledModel {
  readonly score: number;
  readonly competence: string;
  /** False when no competence rule claimed the id — a last-resort candidate. */
  readonly ranked: boolean;
}

interface EffortResolution {
  /** Null when no rung at or below the base survives every clamp. */
  readonly effort: Effort | null;
  /** Each clamp that actually lowered the effort, in the order applied. */
  readonly clamps: readonly string[];
}

/** A completed run of the capability, competence, and effort stages. */
interface Selection {
  readonly candidate: ScoredModel;
  readonly effort: Effort;
  readonly floor: number;
  /** Candidates that cleared competence, best-value first. */
  readonly eligible: readonly ScoredModel[];
  readonly clamps: readonly string[];
}

/**
 * One model admitted to the waived-floor salvage pool, proven able to run the
 * slice at some effort: it passed the capability filter, resolved to a runnable
 * rung, was not removed by quota, and either scored below the difficulty floor
 * or had no rank with which brigadier could establish that it cleared it.
 */
interface SalvageCandidate {
  readonly entry: ScoredModel;
  readonly effort: Effort;
  readonly score: number;
  readonly clamps: readonly string[];
}

/** What one run of the capability/competence/effort pipeline produced. */
interface SelectionOutcome {
  /** Null when nothing survived all three stages. */
  readonly selection: Selection | null;
  /**
   * Models that passed capability and whose competence did not establish the
   * difficulty floor, each with the effort it would run at. This is the whole
   * salvage pool, and it is carried out of the pipeline rather than recomputed
   * because the pipeline is the only place that knows which models failed for
   * which reason.
   */
  readonly salvageable: readonly SalvageCandidate[];
}

const EFFORT_RANK: ReadonlyMap<Effort, number> = new Map(
  EFFORT_LADDER.map((effort, index) => [effort, index]),
);

type QuotaStatus = QuotaSnapshot["status"];

/**
 * One pooled model's quota reading, resolved against the newest snapshots for
 * its vendor, with the sentence that explains it.
 */
interface QuotaJudgement {
  readonly entry: PooledModel;
  readonly status: QuotaStatus;
  /**
   * Why, naming the vendor, the window kind, the scope, and — when the limit is
   * scoped to one tier — that tier's label. Built for every judgement rather
   * than only the exhausted ones so the warning line can use it too.
   */
  readonly cause: string;
}

/**
 * Routes one slice.
 *
 * Throws only on a structurally invalid request — a negative or non-integral
 * `minContextWindowTokens` is a caller bug, not a slice brigadier cannot route.
 * Everything else, including "there is no model on this machine that can do
 * this", comes back as `{ ok: false }` with the rejection trace attached.
 */
export function route(
  request: RoutingRequest,
  input: RoutingInput,
): RoutingDecision {
  validateRequirements(request.requires);

  const rejections: RoutingRejection[] = [];
  const rationale: string[] = [];

  const pool = buildPool(input.config);
  if (pool.length === 0) {
    return {
      ok: false,
      reason: "NO_CONFIGURED_MODELS",
      message:
        "no configured vendor lists a model; run `brigadier init` before routing work",
      rejected: [],
    };
  }
  rationale.push(
    `pool: ${pool.length} model(s) from ${input.config.vendors.length} configured vendor(s) — ${pool.map(describe).join(", ")}`,
  );

  const capabilities = indexCapabilities(input.capabilities);
  const observations = indexQuota(input.quota);

  const judgements = pool.map((entry) => judgeQuota(observations, entry));
  const drained = judgements.filter(
    (judgement) => judgement.status === "exhausted",
  );
  const warned = judgements.filter(
    (judgement) => judgement.status === "warning",
  );

  // A vendor is "exhausted" only when EVERY model it pooled is exhausted. That
  // is what keeps `ALL_VENDORS_EXHAUSTED`'s message honest, and it is what lets
  // a drop be explained as "this vendor has nothing left" rather than "this one
  // tier is out" — two sentences that stopped being the same one when quota
  // became per model. A vendor listing no models is not vacuously exhausted; it
  // never entered the pool and has nothing to report.
  const exhaustedVendors = new Set(
    input.config.vendors
      .filter((vendor) => {
        const owned = judgements.filter(
          (judgement) => judgement.entry.vendor === vendor.vendor,
        );
        return (
          owned.length > 0 &&
          owned.every((judgement) => judgement.status === "exhausted")
        );
      })
      .map((vendor) => vendor.vendor),
  );

  let quotaLine = `quota: ${describeQuotaStatuses(input.config, observations)}`;
  const quotaWorking: readonly PooledModel[] = judgements
    .filter((judgement) => judgement.status !== "exhausted")
    .map((judgement) => judgement.entry);

  if (drained.length > 0) {
    // An exhausted model leaves the pool outright. The two reasons differ in
    // what the user's next move is: a vendor with nothing left is a vendor to
    // wait on, while a single drained tier on a vendor that still has healthy
    // ones changed which model runs and nothing else.
    for (const judgement of drained) {
      rejections.push({
        vendor: judgement.entry.vendor,
        model: judgement.entry.model,
        stage: "quota",
        reason: exhaustedVendors.has(judgement.entry.vendor)
          ? `${judgement.cause}, and every model configured for ${judgement.entry.vendor} reports the same, so ${judgement.entry.vendor} has nothing left to run this slice`
          : `${judgement.cause}, so this model cannot run; ${judgement.entry.vendor}'s other configured model(s) are unaffected`,
      });
    }
    quotaLine += `; dropped ${drained.length} of ${pool.length} model(s) — ${drained.map(describeJudgement).join(", ")} (a model quota removed is out for this slice; routing continues over what is left)`;
  }
  rationale.push(quotaLine);
  if (warned.length > 0) {
    // A warning removes nothing. It is reported because a user reading a trace
    // after a slow or truncated run deserves to know the window was close, not
    // because it changed the routing.
    rationale.push(
      `quota warning: ${warned.map(describeJudgement).join(", ")} — kept in the pool, since a warning says a window is close, not that it is spent`,
    );
  }

  // Exclusion runs after quota, so a model that is both drained and excluded
  // receives the quota rejection only. Quota was the first fact that made it
  // unrunnable, and one pooled candidate must produce one rejection rather than
  // being double-counted. It still runs before competence ranking: a model
  // known to have failed this slice must never win a rank and only then be
  // discarded, and filtering here also keeps it out of the salvage pool that
  // `selectWorker` derives from its input.
  const working = excludeModels(quotaWorking, request.excluded, rejections);
  const excludedCount = quotaWorking.length - working.length;
  if (excludedCount > 0) {
    const excludedPairs = rejections
      .filter((rejection) => rejection.stage === "excluded")
      .map((rejection) => `${rejection.vendor}/${rejection.model}`)
      .join(", ");
    rationale.push(
      `exclusion: removed ${excludedCount} of ${quotaWorking.length} model(s) before competence ranking — ${excludedPairs}`,
    );
  }

  if (quotaWorking.length > 0 && working.length === 0) {
    return {
      ok: false,
      reason: "NO_CAPABLE_MODEL",
      message: `exclusion removed all ${excludedCount} model(s) available after quota for slice ${JSON.stringify(request.slice.id)}; no model remains to run it`,
      rejected: rejections,
    };
  }

  const outcome = selectWorker(working, request, capabilities, rejections);
  const selection = outcome.selection;
  if (selection !== null) {
    rationale.push(
      `capability: ${describeRequirementLine(request.requires)}; ${working.length - countStage(rejections, "capability")} of ${working.length} model(s) passed`,
    );
    rationale.push(describeCompetenceLine(request, selection));
    rationale.push(
      describeEffortLine(request, selection.effort, selection.clamps),
    );

    assertEffortEarned(selection.effort, request);
    return {
      ok: true,
      routed: {
        vendor: selection.candidate.vendor,
        model: selection.candidate.model,
        effort: selection.effort,
        rationale,
        waivedDifficultyFloor: false,
      },
    };
  }

  // Last resort. Nothing cleared the ordinary pipeline, so the difficulty floor
  // is waived — but only for a user who said in their config that they would
  // rather have the work done badly than not at all. The capability filter, the
  // effort clamp, and the quota stage are not waived: they answer "can this
  // model do the work at all", which no amount of consent changes.
  //
  // The gate is one boolean and nothing else. It used to be "some vendor whose
  // quota drained configured a substitution", which conflated three unrelated
  // questions — did quota take anything, did the user consent, and which model
  // did they name — and answered the consent one by inference from the other
  // two. It is now asked directly: a user with a healthy machine and a slice
  // nothing can reach gets the same waiver as a user whose Opus tier just
  // drained, because the situation they are in is the same one.
  if (input.config.allowDegradedRouting) {
    const salvage = outcome.salvageable;
    const chosen = chooseSalvage(salvage);
    if (chosen !== null) {
      rationale.push(
        `capability: ${describeRequirementLine(request.requires)}; ${describe(chosen.entry)} passed`,
      );
      rationale.push(describeWaivedCompetenceLine(request, chosen, salvage));
      rationale.push(describeEffortLine(request, chosen.effort, chosen.clamps));
      assertEffortEarned(chosen.effort, request);
      return {
        ok: true,
        routed: {
          vendor: chosen.entry.vendor,
          model: chosen.entry.model,
          effort: chosen.effort,
          rationale,
          // The one thing a salvage run has to admit: this slice ran on a model
          // its own difficulty said was not good enough for it.
          waivedDifficultyFloor: true,
        },
      };
    }
  }

  // `ALL_VENDORS_EXHAUSTED` is reserved for the case its message states: quota
  // emptied the pool. When a healthy model is still standing and merely failed
  // capability, competence, or effort, the honest answer is `NO_CAPABLE_MODEL`
  // — reporting exhaustion there would tell a user to wait for a quota window
  // that is not what stopped them. An empty `working` means every pooled model
  // is exhausted, which is exactly when every vendor holding a model is in
  // `exhaustedVendors`, so the message's "every configured vendor" stays true
  // under per-model metering as well.
  if (working.length === 0 && exhaustedVendors.size > 0) {
    return {
      ok: false,
      reason: "ALL_VENDORS_EXHAUSTED",
      message: `every configured vendor (${[...exhaustedVendors].join(", ")}) reports its quota exhausted, so no model is left to run this slice`,
      rejected: rejections,
    };
  }
  return {
    ok: false,
    reason: "NO_CAPABLE_MODEL",
    message: `no configured model can take slice ${JSON.stringify(request.slice.id)} at ${request.difficulty} difficulty; ${rejections.length} model(s) were eliminated`,
    rejected: rejections,
  };
}

/* ------------------------------- stage 0 -------------------------------- */

function buildPool(config: BrigadierConfig): readonly PooledModel[] {
  const pool: PooledModel[] = [];
  for (const vendor of config.vendors) {
    for (const model of vendor.models) {
      pool.push({
        vendor: vendor.vendor,
        model: model.id,
        effortCeiling: model.effortCeiling,
        order: pool.length,
      });
    }
  }
  return pool;
}

/* ---------------------------- exclusion stage --------------------------- */

function excludeModels(
  pool: readonly PooledModel[],
  excluded: readonly ExcludedModel[] | undefined,
  rejections: RoutingRejection[],
): readonly PooledModel[] {
  if (excluded === undefined || excluded.length === 0) {
    return pool;
  }

  const excludedKeys = new Set(
    excluded.map((entry) => keyOf(entry.vendor, entry.model)),
  );
  const survivors: PooledModel[] = [];
  for (const entry of pool) {
    if (!excludedKeys.has(keyOf(entry.vendor, entry.model))) {
      survivors.push(entry);
      continue;
    }
    rejections.push({
      vendor: entry.vendor,
      model: entry.model,
      stage: "excluded",
      reason: `${describe(entry)} already ran this slice and failed`,
    });
  }
  return survivors;
}

/* ------------------------------- stage 1 -------------------------------- */

/**
 * How cautious a reading is, most cautious first. Only used to settle two
 * readings of the *same* instant; a later reading always wins outright,
 * however optimistic it is.
 */
const STATUS_CAUTION: Readonly<Record<QuotaSnapshot["status"], number>> =
  Object.freeze({
    exhausted: 3,
    warning: 2,
    unknown: 1,
    available: 0,
  });

/** The most cautious of `statuses`, or `"unknown"` when there are none. */
function mostCautious(statuses: readonly QuotaStatus[]): QuotaStatus {
  let worst: QuotaStatus | null = null;
  for (const status of statuses) {
    if (worst === null || STATUS_CAUTION[status] > STATUS_CAUTION[worst]) {
      worst = status;
    }
  }
  return worst ?? "unknown";
}

/**
 * The newest snapshots per vendor — plural, because a tie has to stay a tie.
 *
 * Duplicates are resolved by `observedAtMs` rather than by array position: a
 * caller that concatenates a cached snapshot with a fresh one must not have the
 * stale reading win on ordering alone. A strictly later reading replaces
 * everything before it, however optimistic it is.
 *
 * Equal timestamps are settled by caution, never by which record was appended
 * last. Two readings of the same instant that disagree are a reason to be
 * careful, not a reason to trust whichever the caller happened to concatenate
 * second. Before quota was per model that could be done by keeping the single
 * more cautious snapshot; it cannot be any more, because "more cautious" is now
 * a question asked once per model and two snapshots of the same instant can
 * each be the pessimistic one for a different tier. So every snapshot tied at
 * the newest instant is kept, and each model takes the most cautious reading
 * across all of them. That is strictly the same answer the old rule gave for
 * account status, and it removes the last place array order could be read.
 */
function indexQuota(
  snapshots: readonly QuotaSnapshot[],
): ReadonlyMap<Vendor, readonly QuotaSnapshot[]> {
  const newest = new Map<Vendor, QuotaSnapshot[]>();
  for (const snapshot of snapshots) {
    const current = newest.get(snapshot.vendor);
    const currentAt = current?.[0]?.observedAtMs;
    if (current === undefined || currentAt === undefined) {
      newest.set(snapshot.vendor, [snapshot]);
      continue;
    }
    if (snapshot.observedAtMs > currentAt) {
      newest.set(snapshot.vendor, [snapshot]);
      continue;
    }
    if (snapshot.observedAtMs === currentAt) {
      current.push(snapshot);
    }
  }
  return newest;
}

/**
 * One pooled model's quota reading.
 *
 * The status is `modelQuotaStatus`'s answer floored by the snapshot's own
 * account status, and both halves are load-bearing:
 *
 * - `modelQuotaStatus` is the only thing that knows which windows constrain
 *   this model. It is imported rather than reimplemented so that the oracle and
 *   the router can never disagree about what `"opus"` claims.
 * - `snapshot.status` is folded in because it can carry an account-wide refusal
 *   that no window records. `normalizeCodexRateLimits` sets `status` to
 *   `"exhausted"` from a bare `rateLimitReachedType` when the payload carried
 *   no account-scoped window at all (`src/quota/codex.ts`), and a router that
 *   read windows alone would route straight into that refusal — the very defect
 *   this stage exists to prevent, reintroduced from the other side. Folding it
 *   in is a floor and not a double count: `mostCautious` is idempotent, and an
 *   account-scoped window already reaches `modelQuotaStatus` on its own.
 *
 * A vendor with no snapshot reads `"unknown"`, which the pipeline treats as
 * available. Absence of information is not evidence of exhaustion, and treating
 * it as exhaustion would make a quota probe that failed to run look exactly
 * like an account that ran out.
 */
function judgeQuota(
  observations: ReadonlyMap<Vendor, readonly QuotaSnapshot[]>,
  entry: PooledModel,
): QuotaJudgement {
  const snapshots = observations.get(entry.vendor) ?? [];
  const status = mostCautious(
    snapshots.flatMap((snapshot) => [
      snapshot.status,
      modelQuotaStatus(snapshot, entry.model),
    ]),
  );
  return { entry, status, cause: describeQuotaCause(snapshots, entry, status) };
}

/**
 * The sentence behind a judgement, naming the narrowest window that produced
 * it. A user whose Opus tier drained has to read "the \"opus\" model tier",
 * not "claude" — telling them their whole account is spent when Sonnet is
 * sitting there ready is the failure the reshape was done to end.
 *
 * The culprit window is identified by asking `modelQuotaStatus` about a
 * one-window snapshot rather than by re-testing the label here. The matching
 * rule — an account-scoped window constrains every model; otherwise the label
 * is trimmed and lowercased, constrains nobody when it is empty or a bare
 * vendor-family word such as `"gpt"` or `"claude"`, and otherwise must occur in
 * the model id delimited by non-alphanumerics or by the ends of the id — lives
 * in exactly one place, `modelQuotaStatus` in `src/quota/contracts.ts`.
 * Re-testing the label here would let the trace explain a decision by a
 * different rule than the one that made it, which is worse than no trace at
 * all. Restating the rule in prose has the same failure mode more quietly: this
 * paragraph went on describing the bare substring test for a release after
 * WO-010F replaced it with token boundaries and the vendor-family guard.
 *
 * That probe cannot speak about `"unknown"`, which is also what
 * `modelQuotaStatus` returns for a window that constrains nothing, so windows
 * reading `"unknown"` are never named as a culprit. Nothing is lost: the only
 * statuses this sentence is ever printed for are `"exhausted"` and `"warning"`.
 */
function describeQuotaCause(
  snapshots: readonly QuotaSnapshot[],
  entry: PooledModel,
  status: QuotaStatus,
): string {
  const culprits: QuotaWindow[] = [];
  for (const snapshot of snapshots) {
    for (const window of snapshot.windows) {
      if (
        window.status === status &&
        status !== "unknown" &&
        modelQuotaStatus({ ...snapshot, windows: [window] }, entry.model) ===
          status
      ) {
        culprits.push(window);
      }
    }
  }
  const scoped = culprits.find((window) => window.scope.kind === "model");
  if (scoped !== undefined && scoped.scope.kind === "model") {
    return `${entry.vendor} reports its ${describeWindowKind(scoped.kind)} window for the ${JSON.stringify(scoped.scope.label)} model tier ${status}`;
  }
  const account = culprits[0];
  if (account !== undefined) {
    return `${entry.vendor} reports its account-wide ${describeWindowKind(account.kind)} window ${status}`;
  }
  return `${entry.vendor} reports its account-wide quota ${status}`;
}

function describeWindowKind(kind: QuotaWindow["kind"]): string {
  return kind === "unknown" ? "quota" : kind;
}

function describeJudgement(judgement: QuotaJudgement): string {
  return `${describe(judgement.entry)} (${judgement.cause})`;
}

/**
 * The per-vendor account-scope summary. It reports what the *account* windows
 * said and nothing more; the per-model detail is the drop and warning lists
 * that follow it, because after the reshape those are the only lines that can
 * distinguish one tier from another.
 */
function describeQuotaStatuses(
  config: BrigadierConfig,
  observations: ReadonlyMap<Vendor, readonly QuotaSnapshot[]>,
): string {
  return config.vendors
    .map((vendor) => {
      const snapshots = observations.get(vendor.vendor);
      if (snapshots === undefined || snapshots.length === 0) {
        return `${vendor.vendor}=no snapshot (treated as available)`;
      }
      const status = mostCautious(snapshots.map((snapshot) => snapshot.status));
      if (status === "unknown") {
        return `${vendor.vendor}=no account-wide limit reported (treated as available)`;
      }
      if (status === "warning") {
        return `${vendor.vendor}=account-wide warning (kept in the pool)`;
      }
      return `${vendor.vendor}=account-wide ${status}`;
    })
    .join(", ");
}

/**
 * Picks the winner of the waived-floor salvage pool.
 *
 * The highest known competence score wins, and every ranked candidate precedes
 * every unranked one. This is the one place in the engine where the *highest*
 * score wins rather than the lowest, and it is deliberate. A
 * review read it as "the last-resort path reverses the cost rule" and asked for
 * the lowest scorer instead; that reading is wrong, and rejected on the record
 * (2026-08-07). The cost stage takes the *cheapest adequate* model, and
 * "adequate" means "at or above the difficulty floor". In salvage the floor has
 * been waived precisely because nothing was adequate, so there is no adequate
 * set for "cheapest adequate" to range over — applying the cost rule here would
 * not save money, it would hand every degraded slice to the weakest model on
 * the machine. When the floor is gone, "best available" is the only rule left
 * that means anything.
 *
 * Ties break on config order, as everywhere else, so the choice is reproducible
 * across runs and across machines holding the same config. There is no
 * healthy/drained tie-break any more: every candidate here passed the same
 * per-model quota check every pooled model passed, so they are all healthy and
 * the distinction has no subject.
 */
function chooseSalvage(
  candidates: readonly SalvageCandidate[],
): SalvageCandidate | null {
  const ordered = [...candidates].sort((left, right) => {
    if (left.entry.ranked !== right.entry.ranked) {
      return left.entry.ranked ? -1 : 1;
    }
    return left.score === right.score
      ? left.entry.order - right.entry.order
      : right.score - left.score;
  });
  return ordered[0] ?? null;
}

/* --------------------------- stages 2, 3, and 4 -------------------------- */

/**
 * Runs the capability filter, the competence rank against the difficulty floor,
 * and the effort clamp, in that order, over one pool.
 *
 * Rejections are written into the caller's sink rather than returned, so a
 * caller that runs this over a reduced pool still ends up with one flat,
 * ordered account of every model the run eliminated.
 */
function selectWorker(
  pool: readonly PooledModel[],
  request: RoutingRequest,
  capabilities: ReadonlyMap<string, Capability>,
  rejections: RoutingRejection[],
): SelectionOutcome {
  const demands = demandsCapability(request.requires);
  const survivors: PooledModel[] = [];
  for (const entry of pool) {
    const capability = capabilities.get(keyOf(entry.vendor, entry.model));
    const failure = judgeCapability(
      entry,
      capability,
      request.requires,
      demands,
    );
    if (failure === null) {
      survivors.push(entry);
    } else {
      rejections.push({
        vendor: entry.vendor,
        model: entry.model,
        stage: "capability",
        reason: failure,
      });
    }
  }
  if (survivors.length === 0) {
    return { selection: null, salvageable: [] };
  }

  const floor = DIFFICULTY_FLOORS[request.difficulty];
  const scored = survivors.map(scoreModel);
  const ranked = scored.filter((entry) => entry.ranked);
  const unranked = scored.filter((entry) => !entry.ranked);

  // Cost stage: among everything that clears the bar, the cheapest wins.
  // Sorting ascending is the whole of decision #7's "cost" — reverse it and
  // brigadier routes a README fix to its most expensive model.
  const clearing = ranked
    .filter((entry) => entry.score >= floor)
    .sort((left, right) =>
      left.score === right.score
        ? left.order - right.order
        : left.score - right.score,
    );
  const belowFloor = ranked.filter((entry) => entry.score < floor);
  for (const below of belowFloor) {
    rejections.push({
      vendor: below.vendor,
      model: below.model,
      stage: "competence",
      reason: `competence score ${below.score} is below the ${request.difficulty} floor of ${floor}`,
    });
  }
  // RULING FOR DECISION #26: an unranked model is not proven weaker than the
  // floor, but neither is it proven to clear the floor. It therefore cannot be
  // an ordinary eligible candidate. It enters the same consented salvage pool
  // as a ranked model below the floor; `waivedDifficultyFloor: true` then means
  // precisely that brigadier did not establish the requested floor, rather than
  // claiming the unknown model has an objectively sub-floor score.
  for (const held of unranked) {
    rejections.push({
      vendor: held.vendor,
      model: held.model,
      stage: "competence",
      reason: `no competence rule ranks this model, so brigadier cannot establish that it clears the ${request.difficulty} floor of ${floor}`,
    });
  }
  const salvageable = collectSalvageable(
    [...belowFloor, ...unranked],
    request,
    capabilities,
  );

  const eligible: readonly ScoredModel[] = clearing;
  if (eligible.length === 0) {
    return { selection: null, salvageable };
  }

  const base = baseEffort(request);
  for (const candidate of eligible) {
    const capability = capabilities.get(
      keyOf(candidate.vendor, candidate.model),
    );
    const resolved = resolveEffort(
      base,
      candidate.effortCeiling,
      capability?.supportedEfforts ?? null,
    );
    if (resolved.effort === null) {
      rejections.push({
        vendor: candidate.vendor,
        model: candidate.model,
        stage: "effort",
        reason: `no effort at or below "${base}" survives its ceiling "${candidate.effortCeiling}" and its supported efforts (${capability?.supportedEfforts.join(", ") || "none reported"})`,
      });
      continue;
    }
    return {
      selection: {
        candidate,
        effort: resolved.effort,
        floor,
        eligible,
        clamps: resolved.clamps,
      },
      salvageable: [],
    };
  }
  return { selection: null, salvageable };
}

/**
 * The salvage pool: models that passed the capability filter, did not establish
 * the difficulty floor, and can still resolve to a runnable effort.
 *
 * Every model here already survived the quota stage, because `selectWorker`
 * only ever runs over models quota left standing. That is what makes the pool
 * safe to route into at all: the floor is the one rule salvage waives, and a
 * model quota removed is gone for reasons the waiver has nothing to say about.
 * Capability and effort are not waived either — they answer "can this model do
 * the work at all" — which is why a model with no runnable rung is dropped here
 * rather than carried into the pool and skipped later.
 */
function collectSalvageable(
  notClearing: readonly ScoredModel[],
  request: RoutingRequest,
  capabilities: ReadonlyMap<string, Capability>,
): readonly SalvageCandidate[] {
  const candidates: SalvageCandidate[] = [];
  for (const entry of notClearing) {
    const capability = capabilities.get(keyOf(entry.vendor, entry.model));
    const resolved = resolveEffort(
      baseEffort(request),
      entry.effortCeiling,
      capability?.supportedEfforts ?? null,
    );
    if (resolved.effort === null) {
      continue;
    }
    candidates.push({
      entry,
      effort: resolved.effort,
      score: entry.score,
      clamps: resolved.clamps,
    });
  }
  return candidates;
}

/**
 * Scores through `scoreModelId`, the one path `init` also uses, so the ranking
 * a user was shown at setup is the ranking that routes their work. The separate
 * `matchCompetenceRule` call answers a different question — "is this model in
 * the table at all?" — which a score alone cannot, since a future table row
 * scored at zero would otherwise be mistaken for an unknown model.
 */
function scoreModel(entry: PooledModel): ScoredModel {
  const { score, rationale } = scoreModelId(entry.model);
  return {
    ...entry,
    score,
    competence: rationale,
    ranked: matchCompetenceRule(entry.model) !== null,
  };
}

/* ------------------------------- stage 2 -------------------------------- */

/**
 * Indexes capability records by `(vendor, model)`. The colon cannot make two
 * different pairs collide because `Vendor` is a closed union of ids that
 * contain no colon, so the split point is unambiguous however a vendor names
 * its models.
 */
function keyOf(vendor: Vendor, model: string): string {
  return `${vendor}:${model}`;
}

/**
 * First entry wins on a duplicate `(vendor, model)` pair. Capability data is
 * static, so a duplicate is a table bug rather than a freshness question, and
 * picking the first keeps the winner visible at the top of the list.
 */
function indexCapabilities(
  capabilities: readonly Capability[],
): ReadonlyMap<string, Capability> {
  const index = new Map<string, Capability>();
  for (const capability of capabilities) {
    const key = keyOf(capability.vendor, capability.model);
    if (!index.has(key)) {
      index.set(key, capability);
    }
  }
  return index;
}

/**
 * True when the slice asks for anything a capability record could refuse. A
 * `minContextWindowTokens` of zero is satisfied by every window that exists, so
 * it is not a demand — treating it as one would reject models for a floor no
 * model can fail.
 */
function demandsCapability(requires: SliceRequirements | undefined): boolean {
  if (requires === undefined) {
    return false;
  }
  return (
    requires.imageInput === true ||
    requires.webSearch === true ||
    requires.structuredOutput === true ||
    (requires.minContextWindowTokens !== undefined &&
      requires.minContextWindowTokens > 0)
  );
}

/**
 * Judges one model against the slice's requirements. Returns null when the
 * model passes, or the reason it did not.
 *
 * A model with no capability record is NOT discarded. Capability data is not
 * persisted in config today, so an empty capability list must not make the
 * router refuse to route anything at all. The rule is narrow: an unrecorded
 * model passes only when the slice demands nothing, because "brigadier has no
 * record" is an honest answer to "does this model read images?" and that answer
 * is not yes.
 */
function judgeCapability(
  entry: PooledModel,
  capability: Capability | undefined,
  requires: SliceRequirements | undefined,
  demands: boolean,
): string | null {
  if (capability === undefined) {
    if (!demands) {
      return null;
    }
    return `brigadier has no capability record for ${describe(entry)}, and this slice requires ${describeRequirements(requires)}`;
  }
  if (requires === undefined) {
    return null;
  }
  if (requires.imageInput === true && !capability.supportsImageInput) {
    return `${describe(entry)} does not support image input`;
  }
  if (requires.webSearch === true && !capability.supportsWebSearch) {
    return `${describe(entry)} does not support web search`;
  }
  if (
    requires.structuredOutput === true &&
    !capability.supportsStructuredOutput
  ) {
    return `${describe(entry)} does not support structured output`;
  }
  const minimum = requires.minContextWindowTokens;
  if (minimum !== undefined && minimum > 0) {
    if (capability.contextWindowTokens === null) {
      // An unknown window is a rejection, not a pass with an apology. A record
      // whose window is null is the same answer as no record at all — "we do
      // not know" — and the branch above already rules that "brigadier has no
      // record" is not a yes when the slice demands something. This one used to
      // admit the model with a note, which meant a slice that declared it needs
      // 150k tokens could be handed to a model brigadier cannot show has them;
      // the slice then fails deep inside a worker instead of at the gate that
      // exists to catch it. Requirements remove models, and an unprovable
      // requirement is an unmet one.
      return `${describe(entry)} reports an unknown context window, so brigadier cannot establish that it meets the required ${minimum} tokens`;
    }
    if (capability.contextWindowTokens < minimum) {
      return `${describe(entry)} has a ${capability.contextWindowTokens}-token context window, below the required ${minimum}`;
    }
  }
  return null;
}

function describeRequirements(requires: SliceRequirements | undefined): string {
  const parts: string[] = [];
  if (requires?.imageInput === true) {
    parts.push("image input");
  }
  if (requires?.webSearch === true) {
    parts.push("web search");
  }
  if (requires?.structuredOutput === true) {
    parts.push("structured output");
  }
  const minimum = requires?.minContextWindowTokens;
  if (minimum !== undefined && minimum > 0) {
    parts.push(`a context window of at least ${minimum} tokens`);
  }
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

function validateRequirements(requires: SliceRequirements | undefined): void {
  const minimum = requires?.minContextWindowTokens;
  if (minimum === undefined) {
    return;
  }
  if (!Number.isSafeInteger(minimum) || minimum < 0) {
    throw new RangeError(
      `minContextWindowTokens must be a non-negative whole number, received ${JSON.stringify(minimum)}`,
    );
  }
}

/* ------------------------------- stage 4 -------------------------------- */

/**
 * Decisions #9/#20 in one function. `xhigh` is reachable only through
 * `escalated`, which the supervisor sets after a routed model runs the slice
 * and fails — never after a routing failure and never from difficulty, however
 * hard the planner judged the work.
 */
function baseEffort(request: RoutingRequest): Effort {
  if (request.escalated === true) {
    return "xhigh";
  }
  return request.difficulty === "routine" ? "medium" : "high";
}

function rankOf(effort: Effort): number {
  const rank = EFFORT_RANK.get(effort);
  if (rank === undefined) {
    throw new RangeError(`unknown effort ${JSON.stringify(effort)}`);
  }
  return rank;
}

/**
 * Walks down `EFFORT_LADDER` to the highest rung at or below the base that both
 * the user's ceiling and the model's own ladder permit. Clamps only ever lower:
 * there is no path through this function that returns a rung above `base`, so a
 * ceiling can never become a floor.
 */
function resolveEffort(
  base: Effort,
  ceiling: Effort,
  supported: readonly Effort[] | null,
): EffortResolution {
  const clamps: string[] = [];
  let limit = rankOf(base);
  const ceilingRank = rankOf(ceiling);
  if (ceilingRank < limit) {
    limit = ceilingRank;
    clamps.push(`the configured effort ceiling "${ceiling}"`);
  }
  if (supported === null) {
    return { effort: EFFORT_LADDER[limit] ?? null, clamps };
  }
  for (let index = limit; index >= 0; index -= 1) {
    const rung = EFFORT_LADDER[index];
    if (rung !== undefined && supported.includes(rung)) {
      if (index < limit) {
        clamps.push(
          `the model's supported efforts (${supported.join(", ") || "none reported"})`,
        );
      }
      return { effort: rung, clamps };
    }
  }
  return { effort: null, clamps };
}

/**
 * The promise decisions #9/#20 make, re-checked against the value actually
 * being returned. The clamp arithmetic already guarantees it; this catches the
 * day someone adds a rung, a special case, or a "just this once" override.
 */
function assertEffortEarned(effort: Effort, request: RoutingRequest): void {
  if (effort === "xhigh" && request.escalated !== true) {
    throw new Error(
      `routing invariant violated: xhigh was selected for slice ${JSON.stringify(request.slice.id)} without evidence that a routed model already ran it and failed`,
    );
  }
}

/* ------------------------------- stage 5 -------------------------------- */

function describe(entry: PooledModel): string {
  return `${entry.vendor}/${entry.model}`;
}

function countStage(
  rejections: readonly RoutingRejection[],
  stage: RoutingRejection["stage"],
): number {
  return rejections.filter((rejection) => rejection.stage === stage).length;
}

function describeRequirementLine(
  requires: SliceRequirements | undefined,
): string {
  return `slice requires ${describeRequirements(requires)}`;
}

function describeCompetenceLine(
  request: RoutingRequest,
  selection: Selection,
): string {
  const scores = selection.eligible
    .map((entry) => `${describe(entry)}=${entry.score}`)
    .join(", ");
  return `competence: ${request.difficulty} difficulty sets a floor of ${selection.floor}; eligible ${scores}; picked ${describe(selection.candidate)} — ${selection.candidate.competence} (lowest score clearing the floor wins, so the slice costs no more than it has to)`;
}

/**
 * The one trace line that has to admit brigadier gave the user less than they
 * asked for.
 *
 * It names the floor that was waived, the setting that authorized waiving it,
 * the whole salvage pool it chose from, and the score of the model that took
 * the slice anyway. A user reading a trace after a bad result must be able to
 * see at a glance that a `hard` slice ran on a model the `hard` floor would
 * normally have rejected, and that it happened because they asked for degraded
 * routing rather than because a rule went wrong.
 *
 * It no longer reports whether the winner's vendor was healthy or drained,
 * because after WO-010H there is no drained candidate to distinguish it from:
 * every model in this pool passed the quota stage.
 */
function describeWaivedCompetenceLine(
  request: RoutingRequest,
  chosen: SalvageCandidate,
  salvage: readonly SalvageCandidate[],
): string {
  const floor = DIFFICULTY_FLOORS[request.difficulty];
  const considered = [...salvage]
    .sort((left, right) => left.entry.order - right.entry.order)
    .map((candidate) =>
      candidate.entry.ranked
        ? `${describe(candidate.entry)}=${candidate.score}`
        : `${describe(candidate.entry)}=unranked`,
    )
    .join(", ");
  const choice = chosen.entry.ranked
    ? `picked ${describe(chosen.entry)} at an actual competence score of ${chosen.score} (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; ties break on config order)`
    : `picked ${describe(chosen.entry)} with no competence rank (ranked scores win over unranked models once the floor is waived; unranked ties break on config order)`;
  return `competence: the ${request.difficulty} difficulty floor of ${floor} was WAIVED because allowDegradedRouting is enabled — no model could take this slice under the ordinary rules, so the salvage pool was consulted: ${considered}; ${choice}`;
}

function describeEffortLine(
  request: RoutingRequest,
  effort: Effort,
  clamps: readonly string[],
): string {
  const base = baseEffort(request);
  const origin =
    request.escalated === true
      ? "escalation after a routed model ran the slice and failed"
      : `${request.difficulty} difficulty`;
  const clamped =
    clamps.length === 0
      ? "no clamp applied"
      : `clamped down by ${clamps.join(" then ")}`;
  return `effort: base "${base}" from ${origin}; ${clamped}; final "${effort}"`;
}
