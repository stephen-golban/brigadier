/**
 * The routing engine: one slice plus a judgement of how hard it is, in; one
 * `{vendor, model, effort}` plus the trace that produced it, out.
 *
 * The pipeline is decision #7's, in order — quota, capability filter,
 * competence rank, difficulty, effort, cost — and vendor is not a stage. Every
 * configured model from every configured vendor enters one pool and competes on
 * the competence scale in `./competence.ts`; nothing in this file may branch on
 * `entry.vendor` to prefer one, and the only places vendor is read at all are
 * quota (which is per-account, so it has to be) and the identity of the result.
 *
 * Three rules here are product decisions rather than implementation choices,
 * and all three are load-bearing:
 *
 * - Difficulty sets a *floor*, and the winner is the **lowest** scorer above
 *   it. Ranking without that inversion would route every slice to the best
 *   model on the machine and make the "cost" stage decorative.
 * - `xhigh` is unreachable unless the slice already failed a gate (decisions
 *   #9/#20). Effort is clamped downward only, from a base that can be `xhigh`
 *   solely on an escalated request, and `assertEffortEarned` re-checks the
 *   result rather than trusting the arithmetic.
 * - A configured `quotaFallbackModel` is a **last resort, never a preemption**
 *   (owner ruling, 2026-08-07). An exhausted vendor's models leave the pool and
 *   the whole pipeline runs over what is left; only when *that* yields nothing
 *   is a fallback consulted. The earlier shape let a drained vendor's downgrade
 *   take the slice the moment its quota ran out, so `claude` running dry could
 *   route a `hard` slice to `claude-haiku-5` (score 40, floor 90) while a
 *   healthy `gpt-5.6-sol` (score 96) sat idle. While the ordinary pipeline
 *   yields anything at all, healthy capacity takes the slice and no fallback is
 *   even looked up.
 * - The last resort is a **salvage pool, not a fallback lookup**. Waiving the
 *   floor only for the exhausted vendors' fallbacks re-created the preemption
 *   bug in a narrower corner: with nothing clearing a `hard` floor of 90, a
 *   healthy `gpt-5.6-terra` (score 70) lost to a drained vendor's configured
 *   `claude-haiku-5` (score 40), because only the fallback was allowed through
 *   the waived floor. So when the ordinary pipeline yields nothing, the waiver
 *   applies to the union: every exhausted vendor's usable fallback *and* every
 *   healthy model that passed capability and was rejected only for scoring
 *   below the floor. Highest score wins, and a healthy vendor breaks a tie —
 *   so a drained vendor's substitution can still take a salvage slice when it
 *   outranks everything healthy, which is the case the user configured it for.
 *
 * Salvage stays locked unless at least one exhausted vendor has a fallback
 * configured. That is what keeps decision #21's `null` meaningful: a user who
 * configured no substitution asked to be told brigadier could not route the
 * slice, not to have it quietly run on something under the floor.
 *
 * `route` is pure and synchronous: no clock, no filesystem, no subprocess. It
 * returns a failure rather than throwing for anything a caller could
 * legitimately hand it; it throws only for a structurally invalid request,
 * which is a bug in the caller and not a routing outcome.
 */

import type { BrigadierConfig, VendorConfig } from "../config/contracts.js";
import { EFFORT_LADDER } from "../config/contracts.js";
import type {
  Capability,
  Effort,
  QuotaSnapshot,
  Vendor,
} from "../contracts.js";
import {
  DIFFICULTY_FLOORS,
  matchCompetenceRule,
  scoreModelId,
} from "./competence.js";
import type {
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
  readonly base: Effort;
  readonly floor: number;
  /** Candidates that cleared competence, best-value first. */
  readonly eligible: readonly ScoredModel[];
  /** True when only unranked models were left to choose from. */
  readonly usedUnranked: boolean;
  readonly clamps: readonly string[];
}

/**
 * One model admitted to the waived-floor salvage pool, proven able to run the
 * slice at some effort. Either an exhausted vendor's configured fallback or a
 * healthy model the difficulty floor rejected; `healthy` is the only thing that
 * distinguishes them, and it decides `usedQuotaFallback`.
 */
interface SalvageCandidate {
  readonly entry: PooledModel;
  readonly effort: Effort;
  readonly score: number;
  readonly clamps: readonly string[];
  /** False when this model's own vendor is the one reporting exhaustion. */
  readonly healthy: boolean;
}

/** What one run of the capability/competence/effort pipeline produced. */
interface SelectionOutcome {
  /** Null when nothing survived all three stages. */
  readonly selection: Selection | null;
  /**
   * Healthy models that passed capability and were eliminated *only* for
   * scoring below the difficulty floor, each with the effort it would run at.
   * These are the healthy half of the salvage pool, and they are carried out of
   * the pipeline rather than recomputed because the pipeline is the only place
   * that knows which models failed for which reason.
   */
  readonly salvageable: readonly SalvageCandidate[];
}

const EFFORT_RANK: ReadonlyMap<Effort, number> = new Map(
  EFFORT_LADDER.map((effort, index) => [effort, index]),
);

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
  const statuses = indexQuota(input.quota);

  const exhausted = input.config.vendors.filter(
    (vendor) => statuses.get(vendor.vendor) === "exhausted",
  );
  const exhaustedVendors = new Set(exhausted.map((vendor) => vendor.vendor));

  let quotaLine = `quota: ${describeQuotaStatuses(input.config, statuses)}`;
  let working: readonly PooledModel[] = pool;

  if (exhaustedVendors.size > 0) {
    // An exhausted vendor leaves the pool outright, fallback or not. The
    // rejection reason is written now but only ever surfaces on failure, and a
    // failure can only happen after every fallback was found unusable, so
    // `describeFallbackFailure` is accurate everywhere it can be read.
    for (const entry of pool) {
      if (exhaustedVendors.has(entry.vendor)) {
        rejections.push({
          vendor: entry.vendor,
          model: entry.model,
          stage: "quota",
          reason: `${entry.vendor} reports its quota exhausted and ${describeFallbackFailure(input.config, entry.vendor)}`,
        });
      }
    }
    working = pool.filter((entry) => !exhaustedVendors.has(entry.vendor));
    quotaLine += `; dropped ${pool.length - working.length} model(s) from ${[...exhaustedVendors].join(", ")} (quota exhausted; a configured fallback is a last resort, consulted only if no healthy model can take the slice)`;
  }
  rationale.push(quotaLine);

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
        usedQuotaFallback: false,
      },
    };
  }

  // Last resort. Nothing cleared the ordinary pipeline, so the difficulty floor
  // is waived — and waived for everything at once, not only for the exhausted
  // vendors' substitutions. Waiving it for the fallbacks alone is what let a
  // score-40 model on a drained account beat a healthy score-70 one. The
  // capability filter and the effort clamp are not waived: they answer "can
  // this model do the work at all", which no amount of consent changes.
  //
  // The gate is a *configured* fallback, not a usable one. Configuring a
  // substitution is the user's consent to degrade rather than fail, and that
  // consent is what unlocks the waiver; whether their chosen model turns out to
  // be the best salvage available is a separate question, settled below.
  const salvageUnlocked = exhausted.some(
    (vendor) => vendor.quotaFallbackModel !== null,
  );
  if (salvageUnlocked) {
    const drained = collectUsableFallbacks(
      exhausted,
      pool,
      request,
      capabilities,
      rejections,
    );
    const salvage = [...drained, ...outcome.salvageable];
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
          // True only when the winner sits on the drained account. A healthy
          // model that won the salvage pool ran on quota brigadier believes is
          // there, so calling it a quota fallback would be a lie to every
          // caller that branches on this flag.
          usedQuotaFallback: !chosen.healthy,
        },
      };
    }
  }

  // `ALL_VENDORS_EXHAUSTED` is reserved for the case its message states: quota
  // emptied the pool. When a healthy vendor is still standing and merely failed
  // capability, competence, or effort, the honest answer is `NO_CAPABLE_MODEL`
  // — reporting exhaustion there would tell a user to wait for a quota window
  // that is not what stopped them.
  if (working.length === 0 && exhaustedVendors.size > 0) {
    return {
      ok: false,
      reason: "ALL_VENDORS_EXHAUSTED",
      message: `every configured vendor (${[...exhaustedVendors].join(", ")}) reports its quota exhausted, and none has a usable quota fallback configured`,
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

/**
 * Latest snapshot per vendor. Duplicates are resolved by `observedAtMs` rather
 * than by array position: a caller that concatenates a cached snapshot with a
 * fresh one must not have the stale reading win on ordering alone.
 *
 * Equal timestamps are settled by caution, never by which record was appended
 * last. Two readings of the same instant that disagree are a reason to be
 * careful, not a reason to trust whichever the caller happened to concatenate
 * second: `exhausted` beats `warning` beats `unknown` beats `available`. The
 * strict `>` is load-bearing — with `>=`, the same two snapshots in the other
 * order produced a different routing decision from identical information.
 */
function indexQuota(
  snapshots: readonly QuotaSnapshot[],
): ReadonlyMap<Vendor, QuotaSnapshot["status"]> {
  const latest = new Map<Vendor, QuotaSnapshot>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.vendor);
    if (current === undefined || snapshot.observedAtMs > current.observedAtMs) {
      latest.set(snapshot.vendor, snapshot);
      continue;
    }
    if (
      snapshot.observedAtMs === current.observedAtMs &&
      STATUS_CAUTION[snapshot.status] > STATUS_CAUTION[current.status]
    ) {
      latest.set(snapshot.vendor, snapshot);
    }
  }
  return new Map(
    [...latest].map(([vendor, snapshot]) => [vendor, snapshot.status]),
  );
}

/**
 * A vendor with no snapshot is available. Absence of information is not
 * evidence of exhaustion, and treating it as exhaustion would make a quota
 * probe that failed to run look exactly like an account that ran out.
 */
function describeQuotaStatuses(
  config: BrigadierConfig,
  statuses: ReadonlyMap<Vendor, QuotaSnapshot["status"]>,
): string {
  return config.vendors
    .map((vendor) => {
      const status = statuses.get(vendor.vendor);
      if (status === undefined) {
        return `${vendor.vendor}=no snapshot (treated as available)`;
      }
      if (status === "unknown") {
        return `${vendor.vendor}=unknown (treated as available)`;
      }
      if (status === "warning") {
        return `${vendor.vendor}=warning (kept in the pool)`;
      }
      return `${vendor.vendor}=${status}`;
    })
    .join(", ");
}

/**
 * The drained half of the salvage pool: each exhausted vendor's configured
 * `quotaFallbackModel`, proven usable.
 *
 * Every fallback that fails writes a rejection naming the stage that actually
 * eliminated it. The contract on `RoutingDecision.rejected` promises "every
 * model considered and the stage that eliminated it", and this path used to
 * discard capability and effort failures with a bare `continue` — so the only
 * trace of a fallback that could not take the slice was the generic quota line,
 * which says a fallback exists but not what was wrong with it. "Why didn't
 * brigadier use the fallback I configured?" is exactly the question this trace
 * is printed to answer.
 */
function collectUsableFallbacks(
  exhausted: readonly VendorConfig[],
  pool: readonly PooledModel[],
  request: RoutingRequest,
  capabilities: ReadonlyMap<string, Capability>,
  rejections: RoutingRejection[],
): readonly SalvageCandidate[] {
  const usable: SalvageCandidate[] = [];
  const demands = demandsCapability(request.requires);
  for (const vendor of exhausted) {
    const fallbackId = vendor.quotaFallbackModel;
    if (fallbackId === null) {
      continue;
    }
    const entry = pool.find(
      (pooled) =>
        pooled.vendor === vendor.vendor && pooled.model === fallbackId,
    );
    if (entry === undefined) {
      // A fallback naming a model the vendor does not list cannot be acted on.
      // `parseConfig` rejects that pairing, so this is unreachable for a config
      // that came through the parser — but `route` takes a `BrigadierConfig`
      // from any caller, and the alternative to a rejection here is the fallback
      // vanishing from the trace with no explanation at all.
      rejections.push({
        vendor: vendor.vendor,
        model: fallbackId,
        stage: "quota",
        reason: `${vendor.vendor} configures ${JSON.stringify(fallbackId)} as its quota fallback, but that model is not among its configured models`,
      });
      continue;
    }
    const capability = capabilities.get(keyOf(entry.vendor, entry.model));
    const failure = judgeCapability(
      entry,
      capability,
      request.requires,
      demands,
    );
    if (failure !== null) {
      rejections.push({
        vendor: entry.vendor,
        model: entry.model,
        stage: "capability",
        reason: `as ${entry.vendor}'s configured quota fallback, ${failure}`,
      });
      continue;
    }
    const base = baseEffort(request);
    const resolved = resolveEffort(
      base,
      entry.effortCeiling,
      capability?.supportedEfforts ?? null,
    );
    if (resolved.effort === null) {
      rejections.push({
        vendor: entry.vendor,
        model: entry.model,
        stage: "effort",
        reason: `as ${entry.vendor}'s configured quota fallback, no effort at or below "${base}" survives its ceiling "${entry.effortCeiling}" and its supported efforts (${capability?.supportedEfforts.join(", ") || "none reported"})`,
      });
      continue;
    }
    usable.push({
      entry,
      effort: resolved.effort,
      score: scoreModelId(entry.model).score,
      clamps: resolved.clamps,
      healthy: false,
    });
  }
  return usable;
}

/**
 * Picks the winner of the waived-floor salvage pool.
 *
 * The highest competence score wins. This is the one place in the engine where
 * the *highest* score wins rather than the lowest, and it is deliberate. A
 * review read it as "the fallback path reverses the cost rule" and asked for
 * the lowest scorer instead; that reading is wrong, and rejected on the record
 * (2026-08-07). The cost stage takes the *cheapest adequate* model, and
 * "adequate" means "at or above the difficulty floor". In salvage the floor has
 * been waived precisely because nothing was adequate, so there is no adequate
 * set for "cheapest adequate" to range over — applying the cost rule here would
 * not save money, it would hand every degraded slice to the weakest model on
 * the machine. When the floor is gone, "best available" is the only rule left
 * that means anything.
 *
 * Ties prefer a healthy vendor over a drained one: two models of equal
 * competence are not equal if one of them is on an account that just reported
 * no quota. Remaining ties break on config order, as everywhere else, so the
 * choice is reproducible across runs and machines.
 */
function chooseSalvage(
  candidates: readonly SalvageCandidate[],
): SalvageCandidate | null {
  const ordered = [...candidates].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    if (left.healthy !== right.healthy) {
      return left.healthy ? -1 : 1;
    }
    return left.entry.order - right.entry.order;
  });
  return ordered[0] ?? null;
}

function describeFallbackFailure(
  config: BrigadierConfig,
  vendor: Vendor,
): string {
  const configured = config.vendors.find((entry) => entry.vendor === vendor);
  const fallback = configured?.quotaFallbackModel ?? null;
  if (fallback === null) {
    return "no quota fallback model is configured for it";
  }
  return `its configured fallback ${JSON.stringify(fallback)} cannot take this slice`;
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
  const salvageable = collectHealthySalvage(belowFloor, request, capabilities);

  let eligible: readonly ScoredModel[] = clearing;
  let usedUnranked = false;
  if (clearing.length === 0) {
    // An unranked model is a model brigadier has never exercised. It is a last
    // resort, not a cheap option: promoting it whenever it is the lowest score
    // would send every routine slice to whatever the vendor shipped this week.
    eligible = [...unranked].sort((left, right) => left.order - right.order);
    usedUnranked = eligible.length > 0;
  } else {
    for (const held of unranked) {
      rejections.push({
        vendor: held.vendor,
        model: held.model,
        stage: "competence",
        reason: `no competence rule ranks this model, and ${clearing.length} ranked model(s) clear the ${request.difficulty} floor of ${floor}`,
      });
    }
  }
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
        base,
        floor,
        eligible,
        usedUnranked,
        clamps: resolved.clamps,
      },
      salvageable: [],
    };
  }
  return { selection: null, salvageable };
}

/**
 * The healthy half of the salvage pool: models that passed the capability
 * filter, were eliminated only by the difficulty floor, and can still resolve
 * to a runnable effort.
 *
 * The floor is the one rule salvage waives, so these models are eligible again
 * the moment the waiver applies. Capability and effort are not waived — they
 * answer "can this model do the work at all" — which is why a model with no
 * runnable rung is dropped here rather than carried into the pool and skipped
 * later.
 */
function collectHealthySalvage(
  belowFloor: readonly ScoredModel[],
  request: RoutingRequest,
  capabilities: ReadonlyMap<string, Capability>,
): readonly SalvageCandidate[] {
  const candidates: SalvageCandidate[] = [];
  for (const entry of belowFloor) {
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
      healthy: true,
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
 * `escalated`, which the supervisor sets after a slice has failed its gate —
 * never from difficulty, however hard the planner judged the work.
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
      `routing invariant violated: xhigh was selected for slice ${JSON.stringify(request.slice.id)}, which has not failed a gate`,
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
  const basis = selection.usedUnranked
    ? "no ranked model cleared the floor, so unranked candidates were admitted in config order"
    : "lowest score clearing the floor wins, so the slice costs no more than it has to";
  return `competence: ${request.difficulty} difficulty sets a floor of ${selection.floor}; eligible ${scores}; picked ${describe(selection.candidate)} — ${selection.candidate.competence} (${basis})`;
}

/**
 * The one trace line that has to admit brigadier gave the user less than they
 * asked for.
 *
 * It names the floor that was waived, the whole salvage pool it chose from, the
 * score of the model that took the slice anyway, and whether that model's
 * vendor was healthy or drained. A user reading a trace after a bad result must
 * be able to see at a glance that a `hard` slice ran on a model the `hard`
 * floor would normally have rejected, why brigadier did that instead of
 * failing, and whether the work went onto an account that had already reported
 * no quota.
 */
function describeWaivedCompetenceLine(
  request: RoutingRequest,
  chosen: SalvageCandidate,
  salvage: readonly SalvageCandidate[],
): string {
  const floor = DIFFICULTY_FLOORS[request.difficulty];
  const considered = [...salvage]
    .sort((left, right) => left.entry.order - right.entry.order)
    .map(
      (candidate) =>
        `${describe(candidate.entry)}=${candidate.score} (${describeHealth(candidate)})`,
    )
    .join(", ");
  const origin = chosen.healthy
    ? `it is on a healthy vendor and was eliminated only by the floor`
    : `it is exhausted vendor ${chosen.entry.vendor}'s configured quota fallback`;
  return `competence: the ${request.difficulty} difficulty floor of ${floor} was WAIVED — no model could take this slice under the ordinary rules, so the salvage pool was consulted: ${considered}; picked ${describe(chosen.entry)} at an actual competence score of ${chosen.score}, ${describeHealth(chosen)}, because ${origin} (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; a healthy vendor breaks a tie)`;
}

function describeHealth(candidate: SalvageCandidate): string {
  return candidate.healthy ? "healthy" : "quota-drained";
}

function describeEffortLine(
  request: RoutingRequest,
  effort: Effort,
  clamps: readonly string[],
): string {
  const base = baseEffort(request);
  const origin =
    request.escalated === true
      ? "escalation after a failed gate"
      : `${request.difficulty} difficulty`;
  const clamped =
    clamps.length === 0
      ? "no clamp applied"
      : `clamped down by ${clamps.join(" then ")}`;
  return `effort: base "${base}" from ${origin}; ${clamped}; final "${effort}"`;
}
