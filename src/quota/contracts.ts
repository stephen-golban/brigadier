/**
 * The quota operation contract. It is local to this module and may change
 * freely within this file; its members deliberately stay out of the shared
 * `src/contracts.ts`, which is published to consumers.
 *
 * Decision: QuotaOracle ingests Claude's push-based quota WorkerEvents.
 * Keeping the latest live signal in the oracle gives the supervisor one
 * snapshot API for both vendors and keeps vendor-specific state and freshness
 * policy out of orchestration. Codex remains pull-based through a long-lived
 * `codex app-server --stdio` process. Claude's oracle owns no process; its
 * `dispose()` only closes the ingress and is therefore still idempotent.
 *
 * The two pure readers of the scoped window contract, `deriveAccountStatus`
 * and `modelQuotaStatus`, live here rather than in the shared
 * `src/contracts.ts` because they are policy over the contract, not part of
 * it, and they are deliberately absent from `src/quota/index.ts`: that
 * barrel is re-exported wholesale by `src/index.ts`, so exporting them would
 * enlarge the package's public surface, which `test/public-api.test.ts` pins as
 * an exact set. Callers inside the repository import them from this module.
 */

import type {
  QuotaSnapshot,
  QuotaWindow,
  Vendor,
  WorkerEvent,
} from "../contracts.js";

type QuotaStatus = QuotaSnapshot["status"];

/**
 * How cautious a reading is, most cautious first.
 *
 * Deliberately the same ordering as the router's `STATUS_CAUTION`
 * (`src/routing/router.ts`): `exhausted` beats `warning` beats `unknown` beats
 * `available`. Two tables that disagreed about which reading is worse would let
 * the same snapshot mean one thing to the oracle and another to the router. It
 * is duplicated rather than imported because the quota unit must not depend on
 * the routing unit — quota is upstream of routing, and the arrow may not point
 * back.
 */
const STATUS_CAUTION: Readonly<Record<QuotaStatus, number>> = Object.freeze({
  exhausted: 3,
  warning: 2,
  unknown: 1,
  available: 0,
});

/** The most cautious reading among `statuses`, or `"unknown"` when empty. */
function mostCautious(statuses: readonly QuotaStatus[]): QuotaStatus {
  let worst: QuotaStatus = "unknown";
  let seen = false;
  for (const status of statuses) {
    if (!seen || STATUS_CAUTION[status] > STATUS_CAUTION[worst]) {
      worst = status;
      seen = true;
    }
  }
  return worst;
}

/**
 * A vendor's status, read from its ACCOUNT-scoped windows alone.
 *
 * The whole point of scoping windows: a drained `seven_day_opus` bucket says
 * nothing about whether the account can run Sonnet, so it must not contribute
 * here. With no account-scoped window at all the answer is `"unknown"` rather
 * than `"available"` — brigadier has no evidence either way, and the router
 * already documents that absence of information is not evidence of exhaustion.
 */
export function deriveAccountStatus(
  windows: readonly QuotaWindow[],
): QuotaStatus {
  return mostCautious(
    windows
      .filter((window) => window.scope.kind === "account")
      .map((window) => window.status),
  );
}

/**
 * Words that name a vendor or a product family rather than a tier, and are
 * therefore never allowed to constrain a model.
 *
 * A label is the only part of a `QuotaWindow` that an adapter derives from data
 * it does not control, and a match here removes a model from routing. A label of
 * `"gpt"`, `"codex"`, or `"claude"` matches at a token boundary in half the
 * fleet at once, so one bucket's exhaustion would report every model of that
 * family dead. No per-tier bucket observed so far needs one of these as its
 * whole label — `seven_day_opus` yields `"opus"`, not `"claude"`.
 *
 * The refusal is not free, and the cost is worth naming: a vendor whose bucket
 * genuinely meters an entire family, and labels it accordingly, is
 * un-representable here, and silently so — a guarded label is indistinguishable
 * downstream from one that simply matched nothing. That trade is taken
 * deliberately. Being wrong in this direction costs one launch the vendor
 * refuses and the supervisor observes; being wrong in the other turns a string
 * off the wire into a fleet-wide kill switch.
 *
 * Unlike a label off the wire, this list changes only in a reviewed diff, which
 * is precisely the property the labels lack.
 */
const VENDOR_FAMILY_WORDS: ReadonlySet<string> = new Set([
  "anthropic",
  "claude",
  "codex",
  "gpt",
  "openai",
]);

const TOKEN_CHARACTER = /[a-z0-9]/;

/**
 * Whether a label carries any alphabetic identity at all. A label with none
 * constrains nothing, for the same reason the list above exists.
 *
 * A tier is named, never numbered. Every tier token either vendor has shipped —
 * `opus`, `sonnet`, `haiku`, `sol`, `terra`, `codex`, `spark`, `4o` — carries
 * letters. A label made only of digits and punctuation can therefore only be a
 * version or date segment, and version segments are shared across the fleet
 * rather than owned by one tier: `-` and `.` are both delimiters here, so
 * `gpt-5.6-sol` tokenizes as `gpt`/`5`/`6`/`sol` and a label of `"5"` claims it,
 * along with `gpt-5.3-codex-spark` and `claude-sonnet-5`. `"4-6"` would likewise
 * claim `claude-opus-4-6` and `claude-haiku-4-6` together. A match removes a
 * model from routing, so a label whose match set is "every model of this
 * generation" is a bogus `ALL_VENDORS_EXHAUSTED` waiting for a vendor to start
 * keying buckets by version. Nothing observed emits one today — real Codex
 * `limitId`s are opaque codenames — so this closes a latent hole, not a live
 * one.
 *
 * The rule stops at "no letters at all" on purpose. `gpt-4o` and
 * `claude-opus-4-6` show that genuine tiers contain digits, so `"4o"` and
 * `"opus-4-6"` must stay matchable; only a label with nothing but digits and
 * punctuation is refused. Note this is ASCII-only, which is the same alphabet
 * `TOKEN_CHARACTER` matches — a label of non-ASCII letters could not match a
 * token in any model id either vendor ships, so refusing it costs nothing.
 */
const ALPHABETIC = /[a-z]/;

/**
 * Whether a specific model can run, given a snapshot.
 *
 * An exhausted account-scoped window exhausts every model. An exhausted
 * model-scoped window exhausts only models whose id matches its label — trimmed
 * and lowercased first, then matched at TOKEN BOUNDARIES rather than anywhere
 * in the id, and only if the guard list above lets it match at all. `"opus"`
 * claims `claude-opus-4-6` because the occurrence is delimited by `-` on both
 * sides, and does not claim a hypothetical `claude-opusx`.
 *
 * This used to be a bare substring test, justified as "the same technique
 * `COMPETENCE_TABLE` already applies to model ids". The technique is the same;
 * the trust model is not, and that is the part that matters. `COMPETENCE_TABLE`
 * holds hand-curated regexes that change only in a diff someone reviewed. These
 * labels arrive off a vendor's wire, unreviewed, on every snapshot. Handing
 * unreviewed input to a matcher whose true answer removes a model from routing
 * needs the tighter rule, and it needs the guard list above on top of it.
 *
 * What the rule still cannot catch: a label that is a genuine token of an
 * unrelated model id. A label like `"spark"` claims every model with a `spark`
 * segment whether or not the bucket meters it. Token boundaries, the guard
 * list, and the alphabetic-identity rule narrow the blast radius; they cannot
 * make an unreviewed string trustworthy. The structural fix — labels carrying
 * their provenance, so identifier-derived tokens and vendor prose can be
 * matched under different rules — needs a `QuotaScope` change, which is a
 * breaking change to the published `src/contracts.ts`.
 *
 * A label that matches nothing is not an error and is not a failure to map: it
 * simply constrains no model. Codex hands out opaque bucket codenames
 * (`codex_bengalfox` was one observed in the wild) that brigadier refuses to
 * guess a model for, and the honest consequence of not guessing is a window
 * that restricts nobody. The alternative — treating an unmappable but admittedly
 * model-scoped bucket as account-scoped — would reintroduce the exact defect
 * this function exists to remove.
 *
 * An empty label is answered twice over, and deliberately so. `constrains`
 * refuses it because an empty needle identifies no tier; `containsToken`
 * refuses it because its own loop cannot terminate on one. Those are two
 * different obligations that happen to share an input, so neither guard is
 * redundant with the other and the order they run in is not load-bearing. That
 * independence is the fix: relying on the caller to keep the callee out of an
 * infinite loop is what made a guard-reorder a hang.
 */
export function modelQuotaStatus(
  snapshot: QuotaSnapshot,
  modelId: string,
): QuotaStatus {
  const id = modelId.toLowerCase();
  return mostCautious(
    snapshot.windows
      .filter((window) => constrains(window, id))
      .map((window) => window.status),
  );
}

function constrains(window: QuotaWindow, lowercaseModelId: string): boolean {
  if (window.scope.kind === "account") {
    return true;
  }
  const label = window.scope.label.trim().toLowerCase();
  // The one place labels off the wire are vetted. `ALPHABETIC` subsumes the
  // empty label, which is refused here for the reason it always was — under the
  // old substring test an empty needle was found in every id — and NOT for
  // termination. `containsToken` now answers the empty label itself; see its
  // comment before assuming either guard makes the other redundant.
  if (!ALPHABETIC.test(label) || VENDOR_FAMILY_WORDS.has(label)) {
    return false;
  }
  return containsToken(lowercaseModelId, label);
}

/**
 * Whether `label` occurs in `modelId` delimited by non-alphanumeric characters
 * or by the ends of the string.
 *
 * Every occurrence is checked, not just the first: a label can appear once
 * mid-token and once on a boundary, and only the second is a match. The
 * delimiter class is "not `[a-z0-9]`", so `-`, `.`, `_`, and the string ends all
 * count — which is exactly the punctuation both vendors use to separate family,
 * version, and tier inside a model id.
 *
 * An empty label names no token and therefore matches nothing. THAT GUARD IS
 * LOAD-BEARING FOR TERMINATION, NOT MERELY FOR CORRECTNESS, AND IT IS NOT
 * REDUNDANT WITH `constrains`. The scan advances by `indexOf(label, at + 1)`,
 * and `String.prototype.indexOf("")` clamps to the string's length instead of
 * returning `-1`; an empty needle that never lands on a boundary therefore
 * parks on the final index and spins forever. `containsToken("gpt-5.6-sol","")`
 * did exactly that. Delete the guard below as "already handled by the caller"
 * and brigadier hangs — no stack trace, no diagnostic, just a supervisor
 * wedged mid-run with its subprocesses still alive. A precondition enforced
 * only by a distant caller is precisely what produced that defect, so the check
 * lives here, in the function whose loop depends on it.
 *
 * Exported for the test that proves this termination property directly. It is
 * absent from `src/quota/index.ts`, so it is not package API — see that file.
 *
 * This is a boundary matcher and nothing more: `containsToken("gpt-5.6-sol","5")`
 * is `true` and is meant to be. Refusing labels with no alphabetic identity is
 * policy about which labels deserve to be matched at all, and it lives in
 * `constrains` with the other vetting.
 */
export function containsToken(modelId: string, label: string): boolean {
  if (label.length === 0) {
    return false;
  }
  let at = modelId.indexOf(label);
  while (at >= 0) {
    if (
      !isTokenCharacterAt(modelId, at - 1) &&
      !isTokenCharacterAt(modelId, at + label.length)
    ) {
      return true;
    }
    at = modelId.indexOf(label, at + 1);
  }
  return false;
}

/** Out-of-range indices read as a boundary, which is what the ends of an id are. */
function isTokenCharacterAt(text: string, index: number): boolean {
  const character = text.charAt(index);
  return character !== "" && TOKEN_CHARACTER.test(character);
}

export type QuotaWorkerEvent = Extract<WorkerEvent, { readonly type: "quota" }>;

export type ClaudeQuotaWorkerEvent = QuotaWorkerEvent & {
  readonly snapshot: QuotaSnapshot & { readonly vendor: "claude" };
};

/** A vendor quota source whose process or connection may be long-lived. */
export interface QuotaOracle<V extends Vendor = Vendor> {
  readonly vendor: V;
  snapshot(): Promise<QuotaSnapshot & { readonly vendor: V }>;
  /** Closes open pipes and waits for owned resources to terminate. */
  dispose(): Promise<void>;
}

/** Pull-based Codex quota source backed by one app-server process. */
export type CodexQuotaOracle = QuotaOracle<"codex">;

/** Push-based Claude quota source retaining the latest worker observation. */
export interface ClaudeQuotaOracle extends QuotaOracle<"claude"> {
  ingest(event: ClaudeQuotaWorkerEvent): void;
}

/** A heterogeneous quota source that preserves vendor/snapshot correlation. */
export type AnyQuotaOracle = CodexQuotaOracle | ClaudeQuotaOracle;
