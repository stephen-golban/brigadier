# Routing methodology

Brigadier routes a slice by applying static policy to the models configured on
the machine. It does not learn a preference from previous runs, ask either
vendor to rank its models, or infer a preferred vendor from the task text. The
reason for publishing the policy is the risk it is meant to control: *a
Claude-authored router drifts toward Claude unless the matrix is auditable
data*. A reader should be able to disagree with every score without first
trusting the model that wrote the router.

This document describes the implementation, including places where it differs
from the shorter recorded design. Source references point to the policy a
reader should inspect in a diff.

## The implemented decision procedure

The recorded decision names five stages:

```text
capability filter -> competence rank -> difficulty -> effort -> cost
```

The implementation has two preceding eligibility stages and implements the
last four stages more tightly together. Its actual procedure is:

1. Build one pool, in configuration order, from every configured model
   ([`src/routing/router.ts:203`](../src/routing/router.ts#L203) and
   [`src/routing/router.ts:396`](../src/routing/router.ts#L396)).
2. Apply quota per model. An exhausted model leaves the pool; a warning or an
   unknown reading does not
   ([`src/routing/router.ts:220`](../src/routing/router.ts#L220) and
   [`src/routing/router.ts:249`](../src/routing/router.ts#L249)).
3. Exclude an exact `(vendor, model)` pair that already failed this slice
   ([`src/routing/router.ts:287`](../src/routing/router.ts#L287)). This is retry
   history, not a preference.
4. Filter on required image input, web search, structured output, command
   execution, and minimum context window. A missing capability record passes
   only when the slice asks for none of those things
   ([`src/routing/contracts.ts:44`](../src/routing/contracts.ts#L44) and
   [`src/routing/router.ts:909`](../src/routing/router.ts#L909)).
5. Match each survivor's model ID against the competence table and split ranked
   from unranked models. Ranked models at or above the difficulty floor can enter
   ordinary eligibility. Ranked models below it and every unranked model are held
   for consented salvage
   ([`src/routing/router.ts:713`](../src/routing/router.ts#L713) and
   [`src/routing/router.ts:735`](../src/routing/router.ts#L735)).
6. Sort ranked models that clear the floor by ascending competence score, with
   configuration order breaking ties. That ascending sort is the entire cost
   policy ([`src/routing/router.ts:719`](../src/routing/router.ts#L719)). It
   reads no price, token rate, or latency estimate; it assumes the lower-scored
   adequate tier is the cheaper choice.
7. In that order, resolve the first candidate to the highest supported effort
   no higher than the request's base effort or the configured ceiling
   ([`src/routing/router.ts:760`](../src/routing/router.ts#L760) and
   [`src/routing/router.ts:1029`](../src/routing/router.ts#L1029)). If a
   candidate has no runnable effort, continue to the next candidate.
8. If ordinary selection fails and degraded routing is allowed, consider ranked
   below-floor and unranked models that survived quota, exclusion, capability,
   and effort. Ranked candidates precede unranked candidates; within the ranked
   set the highest score wins, and configuration order breaks ties and orders
   unranked candidates
   ([`src/routing/router.ts:345`](../src/routing/router.ts#L345) and
   [`src/routing/router.ts:656`](../src/routing/router.ts#L656)).

This differs from the five-stage summary in two checkable ways. Quota and retry
exclusion run before capability. In the code, cost ordering is computed before
effort is tested candidate by candidate, rather than effort being computed and
then a separate cost stage running. The result is equivalent to discarding
models with no runnable effort and then choosing the cheapest survivor, but
there is no independent final cost calculation.

Every successful route returns a human-readable rationale containing the pool,
quota result, any exclusions, capability result, scores and floor, effort base,
and clamps ([`src/routing/contracts.ts:100`](../src/routing/contracts.ts#L100)).
Failures return the stage and concrete reason for each rejection.

## The competence table

The table is an ordered list of case-insensitive regular expressions. The first
matching expression supplies a score and rationale; an unmatched ID receives
score `0` plus an explicit unranked rationale
([`src/routing/competence.ts:22`](../src/routing/competence.ts#L22) and
[`src/routing/competence.ts:101`](../src/routing/competence.ts#L101)). The table
and its rows are frozen at runtime, so routing policy cannot be mutated through
the exported objects between calls.

These scores are curated policy judgements, not benchmark results or learned
weights. The source calls them demonstrated or observed competence, but it
contains no benchmark data, sample size, calibration procedure, or provenance
for the numeric gaps. A score is therefore useful only as an ordering value in
combination with the published floors. Changing a pattern, score, rationale, or
order requires a source diff; nothing updates the table from runtime outcomes.

The complete table is in
[`src/routing/competence.ts:41`](../src/routing/competence.ts#L41):

| Match pattern | Score | Rationale stored in the table |
| --- | ---: | --- |
| `/opus/i` | 100 | deepest Anthropic reasoning tier: architecture and ambiguous specs |
| `/gpt-5\.6-sol/i` | 96 | deepest Codex reasoning tier: cross-cutting refactors and subtle debugging |
| `/sonnet/i` | 74 | balanced Anthropic tier: well-specified multi-file edits |
| `/gpt-5\.6-terra/i` | 70 | fast Codex tier: mechanical volume, scaffolding, and boilerplate |
| `/haiku/i` | 40 | smallest Anthropic tier: lookups and single-file transcription |

The expressions match model IDs, not display names. They are substring regexes,
not token-boundary rules. Because the list is ordered, a future ID matching more
than one row receives the first row's score.

Discovery and competence are separate policies. Codex enumerates its catalog at
runtime, while Claude has a static discovery list because its CLI exposes no
non-billable model enumeration command
([`src/discovery/table.ts:1`](../src/discovery/table.ts#L1)). The current Claude
discovery list contains `claude-fable-5`, but the competence table has no
`fable` rule ([`src/discovery/table.ts:40`](../src/discovery/table.ts#L40)). It is
therefore unranked even though discovery can offer it.

An unranked model is not proven weaker than a difficulty floor, but it is
not proven to clear it either. It is therefore excluded from ordinary eligibility
and enters the same consented salvage pool as a ranked model below the floor
([`src/routing/router.ts:714`](../src/routing/router.ts#L714) and
[`src/routing/router.ts:735`](../src/routing/router.ts#L735)). Without
`allowDegradedRouting`, an unranked model cannot take the slice.

## Difficulty floors and cost inversion

Difficulty is a minimum score for ranked models, not a request to maximize the
score. The three floors live beside the competence table in
[`src/routing/competence.ts:86`](../src/routing/competence.ts#L86):

| Difficulty | Minimum score | Current ranked tiers admitted |
| --- | ---: | --- |
| `hard` | 90 | Opus (`100`), Sol (`96`) |
| `standard` | 60 | Opus (`100`), Sol (`96`), Sonnet (`74`), Terra (`70`) |
| `routine` | 0 | all five ranked rows, including Haiku (`40`) |

Among ranked models above the floor, the **lowest** score wins. With the current
table, absent other filters, that means Sol for `hard`, Terra for `standard`,
and Haiku for `routine`. This inversion is deliberate: choosing the highest
score would send every eligible slice to the strongest installed model and
make the cost policy decorative. “Cheapest” here means “lowest competence tier
that the policy declares adequate,” not a measured currency amount.

The floors are numerically coupled to the current table. A future ranked model
scored `85` is automatically rejected from every `hard` slice because `85` is
below `90`, even if the row's author intended it as a strong general-purpose model.
The rejection trace will report the comparison, but the router cannot detect
that the relationship became stale. Keeping floors and scores in the same file
makes that coupling reviewable; it does not remove the maintenance hazard.

## Effort and retry

Brigadier's effort ladder is exactly `medium | high | xhigh`, ordered from low
to high in
[`src/config/contracts.ts:55`](../src/config/contracts.ts#L55). The default
configured ceiling is `high`
([`src/config/contracts.ts:66`](../src/config/contracts.ts#L66)). On an initial
attempt, a `routine` slice starts at `medium`; `standard` and `hard` start at
`high`. No initial difficulty predicts `xhigh`
([`src/routing/router.ts:1008`](../src/routing/router.ts#L1008)).

The recorded rationale for reserving `xhigh` is that above `high` models take
longer, use more tokens, hallucinate more, and produce worse work. The source
records that as a product rationale, not as a measured result
([`src/routing/contracts.ts:74`](../src/routing/contracts.ts#L74)). No evidence
for those comparative claims is shipped with the router.

After a worker actually runs and the attempt fails, the supervisor records that
exact model as excluded and marks the next request `escalated`
([`src/supervisor/slice.ts:340`](../src/supervisor/slice.ts#L340) and
[`src/supervisor/slice.ts:578`](../src/supervisor/slice.ts#L578)). Exclusion
forces routing to another eligible model; under the ascending table this is
normally the next model up. It is exact identity-based history, so capability,
quota, and the floor can make the actual next choice differ from a simple
adjacent row.

The statement “retry escalates the model, not the effort” is not literally true
of the current code. Retry does both: it excludes the failed model **and** sets
the base effort to `xhigh`. The configured effort ceiling remains a real cap, as
does the model's reported support. A `high` ceiling clamps an escalated request
back to `high`; only a model permitted and reported to support `xhigh` can run at
`xhigh` ([`src/routing/router.ts:1029`](../src/routing/router.ts#L1029)). The
router also asserts before returning that `xhigh` was earned by an escalated
request ([`src/routing/router.ts:1063`](../src/routing/router.ts#L1063)).

The supervisor now earns that flag from evidence rather than the attempt number.
It adds a model to `excluded` only when a worker process actually ran, and sets
`escalated` only when that list is non-empty. A routing failure, worktree-creation
failure, or pre-spawn cancellation may consume or stop an attempt, but cannot by
itself unlock `xhigh`.

## Degraded routing

`allowDegradedRouting` defaults to `false`
([`src/config/contracts.ts:111`](../src/config/contracts.ts#L111) and
[`src/init/propose.ts:176`](../src/init/propose.ts#L176)). Ordinary
routing admits only ranked models that establish the requested difficulty floor.

With consent, the salvage pool contains both kinds of model that brigadier
could not prove meet the requested floor:

- ranked models scored below the requested floor; and
- unranked models with no competence score to compare with the floor.

Every salvage candidate must also have survived quota and retry exclusion,
passed the slice's capability requirements, and have a runnable effort under
both the configured ceiling and reported support.

The ranked salvage winner is the **highest** score, not the lowest. This does not
contradict cheapest-adequate selection. Ordinary routing has an adequate set
and minimizes within it. Salvage exists because that set is empty, so minimizing
would select the weakest known-inadequate model. The rationale names the waived
floor, setting, candidates, scores, and winner
([`src/routing/router.ts:1100`](../src/routing/router.ts#L1100)).

Every successful salvage route records `waivedDifficultyFloor: true`. For a
ranked winner this records a known below-floor score. For an unranked winner it
does not claim an unranked model has a sub-floor score; it records that brigadier
did not establish the requested floor. Ranked candidates precede all unranked
candidates, ranked candidates are ordered by descending score, and ties or
unranked-only choices preserve configuration order
([`src/routing/router.ts:345`](../src/routing/router.ts#L345) and
[`src/routing/router.ts:656`](../src/routing/router.ts#L656)).

Consent waives only the floor. It cannot revive a quota-exhausted or excluded
model, manufacture a missing capability, or create a supported effort.

## Quota and its limitations

Quota is an eligibility input, not a ranking preference. The router evaluates
each model against the newest snapshot for its vendor and removes exhausted
models before the rest of the pipeline. A warning stays in the pool. No snapshot
or no account-wide limit is treated as available, because absence of evidence
is not exhaustion ([`src/routing/router.ts:526`](../src/routing/router.ts#L526)).
A model removed by quota cannot enter degraded salvage.

The current implementation has no “drained vendor downgrade.” If every model of
a vendor is exhausted, that vendor has no candidate left. If only one tier is
exhausted, healthy sibling tiers remain and compete normally. Therefore a
healthy model always beats a drained one in the limited sense that the drained
model is not a candidate at all; there is no fallback tie-break or substitution
([`src/routing/router.ts:49`](../src/routing/router.ts#L49)).

The vendors expose different quota shapes:

- Claude can report model-scoped weekly buckets. For example, an Opus limit can
  remove Opus while leaving Sonnet and Haiku usable. The adapter derives a tier
  label from wire values such as `seven_day_opus`
  ([`src/quota/claude.ts:99`](../src/quota/claude.ts#L99)).
- Codex's known general bucket is account-scoped and shared by Sol, Terra, and
  Luna ([`src/quota/codex.ts:256`](../src/quota/codex.ts#L256)). When it is
  exhausted, changing from Sol to Terra does not restore capacity; a `sol ->
  terra` fallback would be a no-op. Other opaque Codex bucket IDs are currently
  ignored because the adapter cannot map them without guessing
  ([`src/quota/codex.ts:269`](../src/quota/codex.ts#L269)).

Model-scoped labels are matched case-insensitively at alphanumeric token
boundaries against model IDs. Empty labels, labels with no letters, and bare
vendor-family words such as `claude`, `codex`, or `gpt` are refused
([`src/quota/contracts.ts:183`](../src/quota/contracts.ts#L183)). These guards
reduce false matches; they do not make unreviewed wire data trustworthy. A
genuine token belonging to an unrelated model can still match, and a true match
can remove that model from routing
([`src/quota/contracts.ts:158`](../src/quota/contracts.ts#L158)). If false
matches remove the whole configured pool, the visible failure can be a spurious
`ALL_VENDORS_EXHAUSTED` while capacity is actually healthy.

This risk has a different trust model from competence scoring. Competence
regexes are curated source data changed in a reviewed diff. Quota labels arrive
from a vendor on every snapshot. A stronger design would replace inference from
labels with a hand-curated mapping from stable wire limit identifiers to the
models they constrain (a `limitId -> model` table, with the equivalent raw
identifier for vendors that use another field). That mapping would itself be
auditable data. It is not implemented today.

## Vendor is not a ranking input

Vendor is not an input to competence rank, difficulty, effort, or cost. A reader
can verify this at the scoring boundary: `scoreModelId` accepts only a model ID
([`src/routing/competence.ts:110`](../src/routing/competence.ts#L110)), and the
cost sort compares only score and configuration order
([`src/routing/router.ts:721`](../src/routing/router.ts#L721)). There is no
`preferVendor`, vendor hint, or task-to-vendor table in `RoutingRequest`
([`src/routing/contracts.ts:68`](../src/routing/contracts.ts#L68)). Moving a
model up or down requires an auditable change to the competence table.

The unqualified statement “vendor is never an input” is nevertheless broader
than the code. Vendor is part of model identity and is used to join configured
models to capability and quota records; quota is necessarily vendor-scoped
([`src/routing/router.ts:10`](../src/routing/router.ts#L10)). Those uses can
remove a model but do not award preference points. The enforceable invariant is
therefore: **vendor is never a ranking or cost preference; it is eligibility
and identity metadata.** That narrower statement is what the implementation
currently proves.
