/**
 * The quota module's barrel, re-exported wholesale by `src/index.ts` and
 * therefore a package API surface, not a convenience import.
 *
 * `modelQuotaStatus` and `deriveAccountStatus` are deliberately NOT here, and
 * that is a settled decision rather than an open one. `modelQuotaStatus` answers
 * "which windows in this snapshot constrain this model", which is not the same
 * question as "can brigadier run this model" — the router floors its answer
 * with `QuotaSnapshot.status`, because `normalizeCodexRateLimits` can report an
 * account-wide refusal that no window records. Exporting the narrower function
 * under the broader name would hand consumers a pre-flight check that disagrees
 * with `route`'s own decision, and a wrong answer that looks authoritative is
 * worse than no answer. If a consumer ever needs the check, the thing to export
 * is the router's composed reading, not this half of it.
 */

export {
  ClaudeQuotaOracle,
  createClaudeQuotaOracle,
  normalizeClaudeRateLimitEvent,
} from "./claude.js";
export type { CodexQuotaOracleOptions } from "./codex.js";
export {
  CodexQuotaOracle,
  createCodexQuotaOracle,
  normalizeCodexRateLimits,
} from "./codex.js";
export type {
  AnyQuotaOracle,
  ClaudeQuotaOracle as ClaudeQuotaOracleContract,
  ClaudeQuotaWorkerEvent,
  CodexQuotaOracle as CodexQuotaOracleContract,
  QuotaOracle,
  QuotaWorkerEvent,
} from "./contracts.js";
