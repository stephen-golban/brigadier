# The cross-vendor review gate

One model builds a slice; when the other vendor is available, one of its models
reads what was built and says whether it is correct before the work is allowed
to commit. If that review cannot run, the explicit fail-open policy below
applies.

That composition is brigadier's differentiator: it builds with one vendor and
adversarially reviews with the other inside a single task. Anthropic's
[system card](https://www-cdn.anthropic.com/8b8380204f74670be75e81c820ca8dda846ab289.pdf)
reports measurable favoritism in previous Claude models toward transcripts they
were told came from Claude. Brigadier therefore crosses the vendor line for the
adversarial review instead of asking the builder's vendor to judge its own work.

This document is the honest version. If you read only one section, read
[What it does not catch](#what-it-does-not-catch) and
[It fails open, except on cancellation](#it-fails-open-except-on-cancellation).

## Where it runs

The gate runs after the builder finishes and **before** the commit. That
placement is deliberate:

- A post-commit rejection is not representable. A failed slice carries no
  commit, so rejecting after the fact would mean either weakening that invariant
  or leaving a rejected commit on a branch the run may still merge.
- There is no way to un-commit. The engine can prepare, create, commit, merge,
  redact, remove and release; nothing rolls a slice ref back.
- The retry is the point. A rejected attempt takes the ordinary failure path,
  which already removes the worktree, puts the failing model on an exclusion
  list, and re-routes the second attempt to a different model.

## What the reviewer is shown

The **exact unified diff the commit would record** — produced through the
identical sanitizing pipeline the commit runs, with the same parent, the same
staging, the same linked-secret refusal, and the same byte-level redaction of
every blob and every path. Its objects are written to a temporary store, so a
rejected slice leaves nothing behind in your object database.

The task text, allowed paths, and the rest of the reviewer prompt pass through
the same redactor before launch. Returned finding paths and summaries are
redacted before they enter the review artifact or run report.

Alongside the diff, the reviewer is given the slice's task text ("is this
correct" is unanswerable without "correct for what") and the list of paths the
slice was allowed to change, which it may read in full — three lines of context
rarely settle whether a change is correct.

It is asked for logic errors, off-by-one errors, inverted conditions, mishandled
or swallowed errors, unhandled cases, resource leaks, and code that does not do
what the task asked. Style, naming, formatting, comment wording and preference
are explicitly out of scope.

The prompt is framed as a correctness review rather than an attack. That is
operational, not stylistic: "try to break this" is rejected outright by OpenAI's
safety classifier, which would turn every Codex review into a refusal and —
because the gate fails open — into a silently skipped gate on every Claude-built
slice.

### Why the diff, and not the files

The first shipped version of this gate showed the reviewer the post-state of the
slice's owned paths. Driven against the compiled binary, it correctly rejected a
defect a builder had just written, and let through three separate defects planted
in pre-existing code — one of them an inverted condition contradicting a doc
comment one line above it. The Claude reviewer that did notice one graded it
non-blocking and said why: *"this is pre-existing code unrelated to the task."*

The reviewers were not failing. They were scoping their review to the
deliverable and could not see what the deliverable was. The diff closed that gap.

### Bounds

- At most **98,304 characters** of diff (96 × 1024), roughly 24k tokens — a
  character count, not a byte count, so a non-ASCII diff of that length is
  larger than 96 KiB on disk. A reviewer handed a 400 KiB patch does not read
  it more slowly, it reads it less carefully.
- A truncated diff carries its **truncation notice inside the patch text**, so a
  reviewer cannot believe it saw the whole change. The run log says so too.
- Binary files render as one `Binary files … differ` line rather than base64.
- Fifteen minutes and forty turns. A reviewer that has taken forty turns has
  stopped reviewing and started exploring.

### When there is no diff

`--unsafe-in-place` runs get no diff: the working tree is your own checkout, and
its uncommitted content belongs to you and to every concurrent slice as much as
to this one. Attributing that to one slice would be worse than showing nothing.

In that case the reviewer falls back to reading the owned paths' current
contents, under a weaker scope rule — and the degradation is stated in the
reviewer's own prompt and on the run log, never assumed.

## The scope rule

Stated by brigadier rather than left to the reviewer, because without it each
vendor invented its own answer and the two invented different ones.

> Judge the lines this diff adds or changes, in the context of the files they
> land in. Code this diff does not touch is in scope **only when the changed
> code depends on it** — calls it, reads its result, or extends it — so that
> this change itself misbehaves when it runs. Grade that like any other defect.
>
> Anything else you notice in code this task did not change is outside this
> verdict, however wrong it looks. Report it as a **concern** so a human sees
> it, and never as blocking.

The middle rung is real: "the new code calls a broken helper" is a defect *in*
the change, because it will misbehave when it runs.

The outer rung is capped at `concern` for a mechanical reason rather than a
philosophical one. A rejection costs the slice its single escalation and re-runs
the same slice prompt on another model, which produces the same diff and meets
the same objection — and the offending code may not even be inside the slice's
owned paths, so no attempt is permitted to fix it. Blocking there converts a
correct slice into a failed one and buys nothing.

### The middle rung has a measured cost

Driven against the compiled binary on a slice whose new function was asked to
call an existing helper with an inverted condition — and forbidden to modify
that helper — **both vendors blocked, in both directions**:
`claude/claude-opus-5` rejected `codex/gpt-5.6-terra`'s attempt ("the fix must
land in `billableTotal`, which this task was forbidden to modify"), the retry
re-routed to `claude/claude-sonnet-5`, and `codex/gpt-5.6-sol` rejected that one
too. The slice spent both attempts and failed.

That is the intended outcome. The code really would return a wrong total, and
committing it because no attempt was permitted to fix it would be brigadier
shipping known-wrong behaviour to keep a slice green. But it means a plan can
contain a slice that cannot pass this gate at any effort, and such a report has
to be read as *re-slice this*, not as *the models failed*.

## What it does not catch

- **A pre-existing defect in a file a slice touches will not stop the commit.**
  At best it appears as a non-blocking concern.
- **Nothing outside the diff and its surrounding files is examined.** This gate
  reviews the change; it does not audit the codebase.
- **It does not run your tests, your linter, or your build.** A slice can pass
  it and still be wrong.

## The adjudication rule

The gate blocks on `blocking` findings and on nothing else. That is the whole
rule. The judgement about whether a defect is real belongs to the reviewer,
which has read the code, rather than to a heuristic here, which has read a JSON
object.

Two severities rather than five, because only one distinction changes what
brigadier does. A richer scale would be vocabulary the reviewer spends effort on
and nothing reads.

It does **not** block on every finding. Roughly one finding in ten is a false
positive in this project's experience; a gate that blocked on all of them would
reject most slices, cost each one its escalation, and be switched off by the
first user who met it. A gate nobody runs catches nothing.

### What adjudication cannot tell apart

Each of these is a real limit, not a hypothetical.

- **A true blocking defect from a confident hallucination.** There is no
  independent evidence and nothing is run; a severity label is taken at face
  value. A reviewer that invents a defect and marks it blocking costs the slice
  a full re-route.
- **A clean slice from a reviewer that did not look.** `{"findings":[]}` from a
  model that read the whole diff and `{"findings":[]}` from one that skimmed it
  are byte-identical. There is no proof-of-work check. The report prints the
  reviewer's model and elapsed time precisely so a human can form their own view.
- **Correctness from taste.** The prompt forbids style findings; nothing
  enforces it. A reviewer that marks a naming preference blocking fails the
  slice.

Severity words outside `blocking` and `concern` are never guessed at. A reply
using `critical` or `nit` is reported as unreadable rather than mapped onto a
neighbour — mapping up would let a naming preference fail a slice, mapping down
would let a real defect through silently, and both would be brigadier inventing
a verdict nobody chose. One unreadable entry voids the whole reply, because the
entry it discarded might have been the blocking one.

## Who reviews

The other configured vendor's **default model** — the one you told
`brigadier init` you wanted from that vendor — rather than a routing decision.
Routing ranks models against a *slice's* difficulty, and a review is not the
slice; "who should read this" is a different question.

Reviewer effort is capped at `high` whatever the configured ceiling says.
`xhigh` is an escalation earned by a model that actually ran and failed, and the
reviewer is not a slice attempt, so it can never itself have earned the rung. A
model whose ceiling is `medium` reviews at `medium`.

## It fails open, except on cancellation

If the review cannot happen, the slice **commits anyway** and the skip is
reported with its reason.

| Reason | Meaning |
| --- | --- |
| `NO_OTHER_VENDOR` | only one vendor is configured. The ordinary state of a single-vendor install |
| `NO_ADAPTER` | the other vendor is configured but no adapter resolved for it |
| `REVIEWER_FAILED` | the reviewer's own worker failed — quota, auth, a crash. It says nothing about the slice |
| `UNREADABLE_RESPONSE` | the reviewer answered, but with no findings block this build could parse |

Cancellation is different. The review record carries `CANCELLED`, but the slice
runner treats it as a cancelled, non-retryable attempt, removes the worktree, and
does not commit the unreviewed change.

Failing closed was the alternative and it was refused: `brigadier init` produces
a single-vendor config whenever it finds one CLI, and one vendor's outage — or
one missing install — would then fail every slice of every run for reasons that
have nothing to do with the user's code.

**The price, stated plainly: on a single-vendor install, nothing adversarially
reviews anything.** A slice that otherwise succeeds commits with
`review: not run (NO_OTHER_VENDOR)` on its line.

The obligation that comes with failing open is that a skipped gate must be
impossible to mistake for a passing one. That is why the verdict has three arms
rather than being a boolean, why the report prints the gate's outcome on
successful slices too, and why a skip always prints its reason.

## A cost that remains

The gate runs before the commit step can discover that the worker changed
nothing, so a slice heading for `NO_CHANGES` still pays for one reviewer run.
The reviewer is told the change is empty rather than being handed a diff that
does not exist.

## Reading the verdict in a report

```text
      attempt 1  codex/gpt-5.6-terra effort=high  REVIEW_REJECTED: …
        review: rejected by claude/claude-opus-5 effort=high in 41200ms
          blocking src/csv.ts:31: a field containing a quote is emitted unescaped
      attempt 2  claude/claude-sonnet-5 effort=high  ok 8f3c9a2
        review: approved by codex/gpt-5.6-sol effort=high in 38400ms
          concern src/csv.ts:12: writeCsv allocates the whole table before writing
```

A skip looks like this, and is never rendered as an approval:

```text
        review: not run (NO_OTHER_VENDOR) — slice writer was built by claude and no other vendor is configured, so no cross-vendor review was possible
```

Silence under an attempt means the attempt never reached the gate — routing
failed, the worktree failed, or the worker itself did.

The `path` and `line` on a finding are the **reviewer's claim**, not brigadier's
measurement. Nothing here verifies that the file exists or that the line number
is real.
