/**
 * The competence matrix — the auditable data decision #7 rests on.
 *
 * This table used to live in `src/init/propose.ts`, where `init` used it to
 * order the models it offers a user. That was the wrong home: the router is the
 * component whose correctness depends on the ranking being data rather than
 * judgement, and `init` is a reader of it. A Claude-authored router drifts
 * toward Claude unless the matrix is a table someone can open, diff, and argue
 * with, so the engine owns it and everything that scores a model id — `init`
 * included — goes through `scoreModelId` instead of keeping its own copy.
 */

import type { SliceDifficulty } from "./contracts.js";

/** A model-id pattern with the competence tier brigadier has observed for it. */
export interface CompetenceRule {
  readonly pattern: RegExp;
  readonly score: number;
  readonly rationale: string;
}

export const UNRANKED_SCORE = 0;
export const UNRANKED_RATIONALE =
  "not in brigadier's competence table; offered because the probe found it, ranked below the tiers brigadier has exercised";

/**
 * Ranks by demonstrated competence, not by vendor. Two models from different
 * vendors compete on the same scale, which is what keeps decision #7 honest:
 * the proposal never says "use vendor V", only "this model outranks that one".
 *
 * Frozen at the array *and* at every rule, not merely `readonly`. `readonly` is
 * erased at build time, and this table is exported through the package barrel
 * and read live by the router on every call, so a consumer holding the same
 * reference could re-score a model between two identical `route` calls and get
 * two different answers. That would break two promises at once: `route` is
 * documented as pure, and decision #7 rests on the ranking being data that
 * changes only in a diff someone can review. `Object.freeze` is what makes both
 * true at runtime. Freezing the array alone is not enough — a frozen array
 * still hands out mutable members — so each rule is frozen individually.
 */
export const COMPETENCE_TABLE: readonly CompetenceRule[] = Object.freeze([
  Object.freeze({
    pattern: /opus/i,
    score: 100,
    rationale:
      "deepest Anthropic reasoning tier: architecture and ambiguous specs",
  }),
  Object.freeze({
    pattern: /gpt-5\.6-sol/i,
    score: 96,
    rationale:
      "deepest Codex reasoning tier: cross-cutting refactors and subtle debugging",
  }),
  Object.freeze({
    pattern: /sonnet/i,
    score: 74,
    rationale: "balanced Anthropic tier: well-specified multi-file edits",
  }),
  Object.freeze({
    pattern: /gpt-5\.6-terra/i,
    score: 70,
    rationale:
      "fast Codex tier: mechanical volume, scaffolding, and boilerplate",
  }),
  Object.freeze({
    pattern: /haiku/i,
    score: 40,
    rationale: "smallest Anthropic tier: lookups and single-file transcription",
  }),
]);

/**
 * The minimum competence score a slice of each difficulty demands.
 *
 * The floor is a bar to clear, not a target to maximize. The router picks the
 * *lowest* scorer above the floor, so these numbers are the only thing standing
 * between a routine rename and the most expensive model on the machine. They
 * are cut to fall between the tiers in `COMPETENCE_TABLE` rather than on them:
 * 90 admits the two deepest tiers, 60 admits the balanced tiers as well, and 0
 * admits anything ranked at all.
 *
 * Frozen for the same reason as `COMPETENCE_TABLE`: the router reads this
 * object on every call, so an exported mutable floor would let a consumer turn
 * a `hard` slice into a `routine` one without touching the repository.
 */
export const DIFFICULTY_FLOORS = Object.freeze({
  hard: 90,
  standard: 60,
  routine: 0,
} as const satisfies Record<SliceDifficulty, number>);

/**
 * The rule that claims a model id, or null when brigadier has never exercised
 * a model matching it.
 *
 * Callers that need to distinguish "ranked at the bottom" from "not ranked at
 * all" must use this rather than comparing a score against `UNRANKED_SCORE`:
 * the router treats an unranked model as a last resort, and a future table row
 * scored at zero would otherwise silently join that class.
 */
export function matchCompetenceRule(modelId: string): CompetenceRule | null {
  return COMPETENCE_TABLE.find((entry) => entry.pattern.test(modelId)) ?? null;
}

/**
 * Scores one model id. The single scoring path shared by `init`'s proposal
 * ordering and the router's competence stage, so the ranking a user is shown at
 * setup is the ranking the router later applies.
 */
export function scoreModelId(modelId: string): {
  score: number;
  rationale: string;
} {
  const rule = matchCompetenceRule(modelId);
  return {
    score: rule?.score ?? UNRANKED_SCORE,
    rationale: rule?.rationale ?? UNRANKED_RATIONALE,
  };
}
