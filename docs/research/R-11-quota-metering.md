# R-11 — Is AI-coding-CLI quota metered per account or per model tier?

Researched 2026-08-07 against `main` @ `427a96a`. All external sources were read on
2026-08-07; all local probes were run on 2026-08-07.

**Amended 2026-08-07, after WO-010 acted on this document.** §1–§3 are the findings as
researched; where they describe brigadier's own code they now say so in the past tense, against
`427a96a`. §4 is the verdict as it was written then. **§5 is the only section that describes the
present** — what shipped, what was rejected, and what is still open.

## The question

At `427a96a`, `brigadier` let a user configure, per vendor, "when this vendor's quota drains,
fall back to model X" — a field named `quotaFallbackModel`. The router consumed it as a
last-resort salvage path when a vendor reported `status: "exhausted"`. **That field no longer
exists**; §5 records what replaced it and why.

The feature rested on an unverified premise: **that a vendor can be out of quota for one model
while another of its models still runs.** If quota is purely per account, the fallback names a
model that will fail to launch, and the field is a lie the router tells the user.

A second problem sat underneath the first. `QuotaSnapshot` — then frozen and dimensionless —
carried exactly one per-vendor `status` and a list of `QuotaWindow` whose only discriminator was
`kind: "rolling" | "weekly" | "unknown"`. There was no per-model dimension anywhere in the
contract, so even where tiered metering is real, brigadier could not represent it.

**Short answer: tiered metering is real on both vendors, but not in the shape a per-vendor
fallback model assumes.** Details below.

---

## 1. Claude Code / Anthropic — separate Opus metering

**Status: VERIFIED.** There is a distinct model-scoped allowance, and hitting it leaves other
models usable.

### 1a. The published plan documentation

> "Max plans also have two weekly usage limits: one that applies across all models and another
> for Sonnet models only."
> — [What is the Max plan?](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)

> "Pro plans also have a weekly usage limit that applies across all models."
> — [What is the Pro plan?](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan)

> "Weekly limits: Check when your plan's weekly usage limit resets for Opus only and all other
> models."
> — [Usage limit best practices](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)

The two support articles name *different* models for the model-scoped bucket (Sonnet vs Opus).
That is a documentation inconsistency, not a contradiction about structure: both state that a
plan carries an **all-models** weekly bucket plus at least one **single-model-family** weekly
bucket. Section 3a resolves which buckets actually exist on the wire — the answer is that both
`seven_day_opus` and `seven_day_sonnet` are real, so each article is describing a different real
bucket.

### 1b. What happens when the model-scoped limit is hit

This is the sentence the whole feature turns on, from Anthropic's Claude Code documentation:

> "These windows are shared across all models, so switching models with `/model` doesn't restore
> access, though it does keep the developer working after the model-specific 'You've hit your
> Opus limit' message."
> — [Manage costs effectively](https://docs.claude.com/en/docs/claude-code/costs)

Read precisely, that establishes two distinct regimes:

| Bucket exhausted | Switching model helps? |
| --- | --- |
| Model-scoped (the "You've hit your Opus limit" message) | **Yes** — "it does keep the developer working" |
| Account-wide session / weekly window | **No** — "switching models with `/model` doesn't restore access" |

So: hitting the Opus allowance leaves Sonnet and Haiku usable. Hitting the five-hour session
window or the all-models weekly window leaves nothing usable, and a fallback model is futile.

### 1c. Not to be confused with `--fallback-model`

Claude Code has its own `--fallback-model` flag and `fallbackModel` setting
([Model configuration](https://docs.claude.com/en/docs/claude-code/model-config)). Those are for
**availability** — an overloaded or unavailable model, and safety-classifier re-runs — not for
quota. Anthropic's quota remediation is the manual `/model` switch quoted above. Nothing
brigadier does about quota duplicates that vendor flag, and setting one does not substitute for
the other.

---

## 2. Codex / OpenAI — are the windows account-wide or per model?

**Status: VERIFIED, and the answer is bad for the obvious configuration.**

### 2a. Sol, Terra, and Luna share one bucket

The Codex pricing page publishes a per-plan table of "Local Messages\* / 5h" with one row per
model. For ChatGPT Plus, verbatim:

| Model | Local Messages\* / 5h |
| --- | --- |
| GPT-5.6 Sol | 10–100 |
| GPT-5.6 Terra | 25–200 |
| GPT-5.6 Luna | 250–2,000 |
| GPT-5.5 | 15–80 |
| GPT-5.4 | 20–100 |
| GPT-5.4 mini | 60–350 |

> "\*The usage limits for local messages and cloud chats share a five-hour window. Additional
> weekly limits may apply."

> "Switch to a smaller model for routine tasks. Using GPT-5.6 Terra or GPT-5.6 Luna can extend
> your local-message usage limits, depending on the model you switch from."

> "If you are approaching usage limits, you can also switch to a smaller model to make your
> usage limits last longer."

— [Codex pricing](https://developers.openai.com/codex/pricing)

Those numbers are **burn rates against one shared budget**, not separate per-model allowances.
The tell is the word *extend*: a cheaper model buys more messages out of the same pot, and the
advice is framed as "make your limits last **longer**" — i.e. act before exhaustion, not after.
Nothing on the page says a smaller model restores access once the window is spent.

**Consequence: naming `gpt-5.6-terra` as the fallback for an exhausted Codex account cannot
work.** Terra draws from the same bucket Sol just drained. That was the single most likely
fallback a brigadier user would have configured, and it was a no-op.

### 2b. But per-model buckets do exist in the protocol

Probing the local CLI (codex-cli 0.145.0), with no model turn started and therefore no billing:

```
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"clientInfo":{...}}}
{"jsonrpc":"2.0","method":"initialized","params":{}}
{"jsonrpc":"2.0","id":1,"method":"account/rateLimits/read"}
```

The response (observed 2026-08-07, this machine's account, reformatted):

```json
{"id":1,"result":{
  "rateLimits":{"limitId":"codex","limitName":null,
    "primary":{"usedPercent":72,"windowDurationMins":10080,"resetsAt":1786548345},
    "secondary":null,
    "credits":{"hasCredits":false,"unlimited":false,"balance":"0"},
    "individualLimit":null,"spendControlReached":false,
    "planType":"prolite","rateLimitReachedType":null},
  "rateLimitsByLimitId":{
    "codex_bengalfox":{"limitId":"codex_bengalfox","limitName":"GPT-5.3-Codex-Spark",
      "primary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":1786720479},
      "secondary":null,"credits":null,"individualLimit":null,
      "spendControlReached":null,"planType":"prolite","rateLimitReachedType":null},
    "codex":{"limitId":"codex","limitName":null,
      "primary":{"usedPercent":72,"windowDurationMins":10080,"resetsAt":1786548345},
      ...}},
  "rateLimitResetCredits":{"availableCount":0,"credits":[]}}}
```

Two things are established by that payload:

1. `account/rateLimits/read` returns a **map of independent buckets** keyed by `limitId`, each
   with its own `usedPercent`, its own window, its own `resetsAt`, and its own
   `rateLimitReachedType`. It is not a single account-wide number.
2. At least one bucket is **explicitly model-named**: `limitName: "GPT-5.3-Codex-Spark"`. On
   this account it sat at `usedPercent: 0` while the general `codex` bucket sat at
   `usedPercent: 72`, with a *different* reset time. That is a live, observed instance of "one
   model has quota while the account's general bucket is 72% drained".

So Codex's model is: a general bucket that Sol/Terra/Luna all share, plus zero or more
separately-metered models that get their own `limitId`. Falling back *within* the shared family
is useless; falling back *to* a separately-metered model works.

---

## 3. What each CLI actually reports, and what brigadier discarded

**Status: VERIFIED.** Both adapters discarded a per-model dimension that the vendor supplies. The
wire evidence below is the research and still holds; the paragraphs describing brigadier's own
adapters describe `427a96a` and have since been fixed — see §5.

### 3a. Claude — `src/quota/claude.ts`

`normalizeClaudeRateLimitEvent` reads Claude Code's `rate_limit_event`. The exact wire schema,
extracted from the Claude Code binary itself (`/Users/stephen/.local/share/claude/versions/2.1.224`,
v2.1.224 — the CLI's own compiled Zod schema, verbatim):

```js
Te({status:xr(["allowed","allowed_warning","rejected"]),
    resetsAt:lt().int().optional(),
    rateLimitType:xr(["five_hour","seven_day","seven_day_opus","seven_day_sonnet",
                      "seven_day_overage_included","overage"]).optional(),
    utilization:lt().optional(),
    overageStatus:..., overageResetsAt:..., overageDisabledReason:...,
    isUsingOverage:..., overageInUse:..., surpassedThreshold:...,
    rateLimitGraceActive:...})
```

and the CLI's own label table for those values, verbatim:

```js
Z2t={five_hour:"session limit", seven_day:"weekly limit",
     seven_day_opus:"Opus limit", seven_day_sonnet:"Sonnet limit",
     seven_day_overage_included:"Fable 5 limit", overage:"usage credit limit"}
```

**`rateLimitType` *is* the per-model dimension.** Three of its six members name a model family
(Opus, Sonnet, Fable 5). The CLI's `/usage` renderer confirms the grouping — it prints
"Current session", "Current week (all models)", and, on `max`/`team`, "Current week (Sonnet
only)".

> **Correction note (WO-010F).** The sentence above counts `seven_day_overage_included` as a
> model-family member, on the strength of its "Fable 5 limit" display label. The implementation
> disagrees: `src/quota/claude.ts` hard-codes that type **account**-scoped.
>
> The conflict is recorded rather than resolved, because neither side has direct evidence. The
> justification originally offered for account scope — that `seven_day_overage_included` belongs
> to a "unified header family" alongside `five_hour`/`seven_day` — does not hold: re-reading the
> 2.1.224 binary shows **there is no per-type unified header for any type**, not for `5h`, `7d`,
> `7d_oi`, `7d_opus`, or `7d_sonnet`. That observation therefore fails to separate
> `seven_day_overage_included` from `seven_day_opus`, which both sides agree is model-scoped, so
> it settles nothing. Against that, the display label is the only direct signal either way, and
> §3a itself shows those labels are plan-dependent prose.
>
> **Ruling: the account scope stays**, as the conservative default under genuine uncertainty. The
> two errors are not symmetric — over-restricting wastes capacity, under-restricting launches a
> worker into a wall, and stopping wasted launches is this unit's whole purpose. This paragraph's
> claim stands as the *unverified* reading it always was; item 3 of "What remains unverified"
> already records the second weekly bucket's scoping as open, with Anthropic's own support
> articles disagreeing.
>
> What would settle it: one observed `rate_limit_event` carrying
> `rateLimitType: "seven_day_overage_included"` on an account where a different model family is
> known to still run, or this section's own `limits[].scope.model` field read for that bucket.
> Nothing short of one of those is direct.

At `427a96a` brigadier threw all of it away. `normalizeWindow` mapped only
`seven_day → "weekly"` and `five_hour → "rolling"`; `seven_day_opus`, `seven_day_sonnet`,
`seven_day_overage_included`, and `overage` all fell through to `kind: "unknown"` with
`durationMinutes: null`. The model identity survived nowhere in the resulting `QuotaSnapshot`.

Three consequences, in ascending severity:

- **`utilization` was dropped too.** The event carries it; `normalizeWindow` hardcoded
  `remainingFraction: null`. Not a model-dimension issue, but a free signal being discarded.
- **A model-scoped rejection was reported as vendor-wide exhaustion.** `normalizeStatus` mapped
  `status: "rejected"` to `"exhausted"` regardless of `rateLimitType`. An Opus-only limit made
  brigadier believe all of Claude was dead.
- **The oracle was last-writer-wins across independent buckets.** `ClaudeQuotaOracle.ingest`
  stored `this.latest = event.snapshot`, and each event carries exactly one `rate_limit_info`.
  Claude's buckets are independent and report independently, so an `allowed` five-hour event
  arriving after a `rejected` Opus event silently erased the exhaustion, and vice versa. One slot
  cannot hold N independent buckets.

There is also a richer source brigadier is not using. The same binary parses an account usage
payload whose `limits` array carries an explicit scope object, verbatim:

```js
limits: Me.array(Me.object({kind:..., group:..., percent:..., resets_at:...,
  scope: Me.object({model:   Me.object({display_name:...}).nullish(),
                    surface: Me.object({display_name:...}).nullish()}).nullish()}))
```

Anthropic's own internal model is therefore *a list of buckets, each with an optional model
scope* — which is exactly the shape `QuotaSnapshot` lacks. The same structure surfaces to
third parties as `rate_limits.model_scoped` in the statusline payload.

### 3b. Codex — `src/quota/codex.ts`

`normalizeCodexRateLimits` read `result.rateLimits` only — the aggregate `codex` bucket — and
from it only `primary` and `secondary`. **`result.rateLimitsByLimitId` was never touched.** The
per-model `codex_bengalfox` / `"GPT-5.3-Codex-Spark"` bucket observed in §2b was dropped on
the floor, along with its independent `usedPercent`, window, and `rateLimitReachedType`.

Also unread — then, and **still unread today**: `credits` (`hasCredits` / `balance`),
`individualLimit`, `spendControlReached`, and `planType`. `credits` in particular is a real
"you can keep working" signal — "ChatGPT Plus and Pro users who reach their usage limit can
purchase additional credits to continue working"
([Codex pricing](https://developers.openai.com/codex/pricing)) — and brigadier will declare the
vendor exhausted while credits remain.

For the record, the adapter handled the *observed* payload correctly on its own terms:
`primary.windowDurationMins: 10080` maps to `kind: "weekly"`, and
`rateLimitReachedType: null` present-but-null yields `status: "available"`. The defect was
scope, not arithmetic.

---

## 4. Verdict and recommendation, as written 2026-08-07

*Preserved as the call that was made, not as a live instruction. §5 records what became of each
step; two of them were not taken.*

### Verdict: **reshape it.** Do not delete it, and do not keep it as-is.

Deleting is wrong. The premise the field rests on is **true for Claude**, verified in §1b from
Anthropic's own documentation: a model-scoped "You've hit your Opus limit" does keep the
developer working on another model. For a tool whose whole reason to exist is running Opus-heavy
work until the Opus allowance runs out, that is not a corner case — it is the primary quota
event. A brigadier that drops to Haiku on an Opus limit is doing exactly the right thing.

Keeping it as-is is also wrong, and this is the blunt part: **the field was correct by accident
in one case and actively harmful in the other, and brigadier could not distinguish them.**

- Claude hits `seven_day_opus` → adapter reports vendor-wide `exhausted` → router fires the
  fallback → the fallback model launches and works. Right answer, wrong reasoning.
- Claude hits `five_hour` or `seven_day` → adapter reports the *same* vendor-wide `exhausted` →
  router fires the same fallback → the worker launches into a wall. brigadier burns a worktree,
  a process spawn, and the user's patience to rediscover a limit it was already told about.
- Codex hits its shared bucket → the natural `gpt-5.6-sol → gpt-5.6-terra` fallback is a no-op,
  because §2a shows they share the bucket. Same wasted launch.

The distinguishing information exists on the wire, in both vendors, and both adapters discard
it. That is a fixable defect, not a doomed feature.

One mitigating fact worth stating: brigadier did **not** manufacture this hazard. Decision #21
meant `init` proposed `null` and never invented a same-vendor downgrade — the field was opt-in
and user-typed, so the blast radius was limited to users who deliberately set it. That bought
time; it did not make the field honest.

### The reshape, as proposed

`src/contracts.ts` was frozen and expected to stay byte-unchanged, so this was written as a
proposal for a future unfreeze rather than a change to make then.

1. **Give `QuotaWindow` a scope and its own status.** Something like
   `scope: { kind: "account" } | { kind: "model"; label: string }` plus a per-window
   `status`. This mirrors what both vendors already send: Anthropic's `limits[].scope.model`
   and OpenAI's `rateLimitsByLimitId[].limitName`. No invention required — it is a transcription.
2. **Make `QuotaSnapshot.status` derived, not stored.** A vendor is `exhausted` only when an
   **account-scoped** window is exhausted. A model-scoped exhaustion is not vendor death.
3. **Make the oracles accumulate rather than overwrite.** `ClaudeQuotaOracle` must keep one slot
   per `rateLimitType`, not one slot total; `CodexQuotaOracle` must read `rateLimitsByLimitId`
   rather than only the aggregate.
4. **Then the router rule becomes decidable.** Fire the configured fallback only when the
   exhausted window is model-scoped *and* the fallback model is not inside that same scope. Under
   an account-scoped exhaustion, refuse the slice with a clear reason instead of launching a
   worker that cannot run — which is precisely what `RoutingDecision.rejected` exists to explain.
   — **Not taken.** Steps 1–3 made the whole fallback mechanism redundant; see §5.
5. **Optionally, and separately: stop discarding the fractions.** Claude's `utilization` and
   Codex's `credits` are both already parsed off the wire and both already thrown away. —
   **Half taken:** `utilization` is now read, `credits` is not.

---

## 5. What shipped, and what is still open

Added after the fact so the document is not silently rewritten into a description of the present.
§1–§4 are the research and the call made on it; this section is the disposition, verified against
the tree at the time of writing.

### Shipped (WO-010)

- **Window scope and per-window status.** `QuotaScope` (`src/contracts.ts:239`) and
  `QuotaWindow`'s `scope` and `status` (`src/contracts.ts:243`) exist, and `QuotaSnapshot.status`
  is now documented as deriving from account-scoped windows alone (`src/contracts.ts:253`). This
  spent the `src/contracts.ts` freeze — once, deliberately, and only in the quota types; the
  file's own header comment records the amendment and its justification.
- **Two readers over that contract.** `deriveAccountStatus` (`src/quota/contracts.ts:70`) and
  `modelQuotaStatus` (`src/quota/contracts.ts:142`) live outside the frozen file because they are
  policy, not contract. The router resolves quota **per model**, asking `modelQuotaStatus` about
  each pooled model (`src/routing/router.ts:472`) and flooring the answer with the snapshot's own
  account status. A drained Opus tier no longer removes Sonnet.
- **Both oracles accumulate instead of overwriting.** `ClaudeQuotaOracle` keeps one slot per
  bucket (`src/quota/claude.ts:128`), keyed by the vendor's own `rateLimitType` read off the raw
  event (`src/quota/claude.ts:257`). Keying on the *normalized* `(kind, scope)` pair was tried
  first and was not an identity: `seven_day` and `seven_day_overage_included` normalize alike, so
  the two collided. The Codex adapter now reads `rateLimitsByLimitId` beside the aggregate
  (`src/quota/codex.ts:286`).
- **Claude's `utilization` is no longer discarded** (`src/quota/claude.ts:388`). It is read as a
  fraction in `[0, 1]`, which §3a's binary thresholds establish; reading it as a percentage would
  have inverted it.
- **Codex model labels derive from `limitId` alone** (`src/quota/codex.ts:437`), never from the
  display prose `limitName`, and `modelQuotaStatus` matches them at token boundaries behind a
  guard that refuses bare vendor-family words such as `"gpt"` or `"claude"`
  (`src/quota/contracts.ts:95`). **The cost, stated plainly: every `limitId` observed so far is an
  opaque codename, so Codex model-scoped windows currently constrain no model at all.** They are
  emitted and carry their evidence; nothing matches them. That is the deliberate direction —
  under-matching costs one launch the vendor refuses, over-matching turns vendor prose into a
  fleet-wide kill switch.

### Rejected

- **The per-vendor fallback model itself.** Step 4 above proposed teaching the router when to fire
  `quotaFallbackModel`. The field was deleted instead, and the proposal with it. Per-model quota
  took both halves of its job: the substitution half now happens through the ordinary pipeline,
  because a drained tier no longer removes the healthy models that then compete on merit; and the
  salvage half was dead code, because a fallback had to name one of its own vendor's models and
  was therefore itself drained whenever that vendor was. What was left was **consent**, now
  recorded as the top-level boolean `BrigadierConfig.allowDegradedRouting`
  (`src/config/contracts.ts:96`), defaulting to `false` (`src/init/propose.ts:173`). The routing
  result's `usedQuotaFallback` became `waivedDifficultyFloor` (`src/routing/contracts.ts:114`),
  which states the one thing about a salvage run that is true and useful: the slice ran below the
  bar its own difficulty asked for. `CONFIG_VERSION` is now `2` (`src/config/contracts.ts:32`).

### Still open

1. **The shared-family scope gap.** §2a found that Sol, Terra, and Luna share one bucket while
   Spark is metered independently. `QuotaScope` is two-way — the account, or one model — and
   cannot say "this window meters *these three* models". Codex's shared bucket is therefore filed
   as account-scoped, so its exhaustion condemns a separately-metered model such as Spark, which
   §2b observed still had quota. A family scope, or a label permitted to name several tiers, is
   the shape that would close it.
2. **Opaque `limitId` values.** Unverified item 5 below is load-bearing rather than a curiosity:
   because no observed `limitId` is a model name, the Codex model dimension is read, normalized,
   and then matches nothing. The fix is a hand-curated `limitId → model` table in a reviewed diff
   — the `COMPETENCE_TABLE` shape — not a runtime guess.
3. **Label provenance on `QuotaScope`.** A label derived from a wire identifier
   (`seven_day_opus → "opus"`) and one derived from vendor prose are matched by the same rule
   today, and only the guard list keeps prose from acting as a kill switch. Carrying the
   provenance would let identifier-derived tokens match at token boundaries while prose-derived
   labels match only on full equality. That needs another amendment to the frozen contract.
4. **`seven_day_overage_included` remains account-scoped under genuine uncertainty**
   (`src/quota/claude.ts:95`). The correction note in §3a is the standing record of that ruling
   and is still accurate; nothing has been observed since that would settle it either way.
5. **Codex's `credits`, `individualLimit`, `spendControlReached`, and `planType` are still
   unread** (§3b).

---

## What remains unverified

1. **The strict entailment "`seven_day_opus` rejected ⇒ a Sonnet run launches."** §1b's
   documentation sentence is strong and direct, but it describes an interactive `/model` switch,
   not a fresh non-interactive `claude -p --model sonnet` process. Not observed.
   *Settles it:* drain an Opus weekly allowance, then launch a headless Sonnet run and record
   the exit code.
2. **Whether `rateLimitType: "seven_day_opus"` actually reaches brigadier's channel.** The schema
   in §3a is defined inside the CLI's SDK message union and described as "Rate limit event
   emitted when rate limit info changes", which strongly implies it is emitted on
   `--output-format stream-json`. But no such event was captured on the wire here — doing so
   requires a billable turn *and* an account near a model-scoped limit.
   *Settles it:* capture stream-json from a session that crosses an Opus threshold.
3. **Which model the Max plan's second weekly bucket currently applies to.** Anthropic's two
   support articles disagree (Sonnet-only vs Opus-only). Both `seven_day_opus` and
   `seven_day_sonnet` exist in the CLI vocabulary, and the CLI's `jju()` helper shows the Sonnet
   bucket is relabelled to the generic "weekly limit" on `pro` and `enterprise`, so the answer is
   plan-dependent. The exact per-plan mapping is not documented anywhere I could find.
   *Does not affect the verdict* — the reshape reads the scope off the wire rather than assuming
   which model is scoped.
4. **Whether Sol and Terra are guaranteed to keep sharing a bucket.** §2a is today's pricing
   table, not a stability commitment. OpenAI has already shipped one model with its own
   `limitId`, so the partition is clearly something they vary per model.
   *Settles it:* nothing, permanently — which is itself the argument for reading `limitId` at
   runtime instead of hardcoding a family assumption.
5. **Whether `limitId` values are enumerable in advance.** `codex_bengalfox` is an opaque
   codename; `limitName` was human-readable on this account but is `null` for the general bucket.
   Any mapping from a brigadier model id to a `limitId` would have to be discovered at runtime.
   *Still open, and now load-bearing:* §5, "Still open" item 2.
6. **Everything about plans other than the two observed.** The Codex probe ran on a `prolite`
   account; the Claude evidence is documentation plus binary inspection, not a live drained
   account. Team, Enterprise, and API-key configurations were not probed.
7. **All numeric limits.** No figure in this document is estimated. Every number quoted is either
   from the vendor's published table (§2a) or from the observed probe payload (§2b), and both are
   snapshots dated 2026-08-07.

## Sources

Read 2026-08-07:

- [What is the Max plan? — Claude Help Center](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)
- [What is the Pro plan? — Claude Help Center](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan)
- [Usage limit best practices — Claude Help Center](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)
- [Manage costs effectively — Claude Code docs](https://docs.claude.com/en/docs/claude-code/costs)
- [Model configuration — Claude Code docs](https://docs.claude.com/en/docs/claude-code/model-config)
- [Codex pricing — OpenAI Developers](https://developers.openai.com/codex/pricing)

Local probes, run 2026-08-07:

- Claude Code v2.1.224 binary, `/Users/stephen/.local/share/claude/versions/2.1.224`
  (schema and label-table extraction; `claude --version` was the only invocation, no model turn).
- codex-cli 0.145.0, `codex app-server --stdio`, method `account/rateLimits/read`
  (JSON-RPC handshake only, no model turn, no billing).
