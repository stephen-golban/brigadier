/**
 * THE CROSS-VENDOR REVIEW GATE.
 *
 * One model builds a slice; a model from the OTHER vendor reads what it built
 * and says whether it is correct. That composition is the product's whole
 * differentiator: every comparable tool lets a user pick a vendor per task, and
 * none of them builds with one vendor and reviews with another inside a single
 * task. The reason to bother is documented self-preferential bias — a model
 * asked to judge its own output prefers it — so the second opinion has to come
 * from a different vendor to be worth its cost.
 *
 * WHERE IT RUNS, AND WHY THERE. The gate is called from `#runInWorktree` after
 * the builder's `WorkerOutcome` came back successful and BEFORE
 * `engine.commit`. The alternative was after the commit, where the diff would
 * simply be `parent..commit` and this module would not have to think about how
 * to show the reviewer anything. Three facts ruled that out:
 *
 *   1. A post-commit rejection is not representable. `SliceResult`'s `ok: false`
 *      arm asserts `commit: null`, and its comment states outright that "a slice
 *      that committed and then failed is not a thing this unit can produce".
 *      Rejecting after the commit would mean either weakening that invariant or
 *      leaving a rejected commit on a branch the orchestrator may still merge.
 *   2. There is no way to un-commit. The engine's entire surface is `prepare`,
 *      `create`, `commit`, `merge`, `redact`, `remove`, `release` — nothing
 *      rolls a slice ref back, so a rejected post-commit slice would leak a ref
 *      the run has no way to retire cleanly.
 *   3. The retry is the point. A rejected attempt has to take the ORDINARY
 *      failure path, because that path already removes the worktree, puts the
 *      failing model on `excluded`, and re-routes attempt 2 with
 *      `escalated: true`. Pre-commit rejection reaches all of that for free;
 *      post-commit rejection would need a parallel unwind of each step.
 *
 * THE REVIEWER IS SHOWN THE CHANGE, NOT THE FILES. This is the thing the first
 * shipped version of the gate got wrong, and the failure was measured rather
 * than theorised: driven against the compiled binary, the gate correctly
 * rejected a defect a builder had just written, and let through three separate
 * defects planted in pre-existing code — one of them an inverted condition
 * contradicting a doc comment one line above it. The Claude reviewer that did
 * notice one graded it a non-blocking concern and said exactly why: "this is
 * pre-existing code unrelated to the task". The reviewers were not failing.
 * They were scoping their review to the deliverable, and they could not see
 * what the deliverable was, because they were handed the post-state of the
 * slice's owned paths and had to guess which parts were new.
 *
 * `WorktreeEngine.diffUncommitted` closed that gap. It produces the uncommitted
 * change in the worker's worktree as a unified diff, through the identical
 * sanitizing pipeline `commit` runs, so what the reviewer reads is what the
 * commit will record rather than an approximation of it — and its objects are
 * written to a temporary store, so a rejected slice leaves nothing behind.
 *
 * THE SCOPE POLICY, DECIDED HERE RATHER THAN LEFT TO THE REVIEWER. With no diff
 * each vendor invented its own answer to "may I report a defect in code this
 * task did not write", and the two invented different ones. The prompt below
 * now states it: judge the lines the diff adds or changes, treat a pre-existing
 * defect the change DEPENDS ON as in scope, and grade everything else in those
 * files as a `concern` at most, never as blocking.
 *
 * The middle rung is there because "the new code calls a broken helper" is a
 * defect IN the change: it will misbehave when it runs, and the builder could
 * have fixed it. The outer rung is capped at `concern` for a reason that is
 * mechanical rather than philosophical: a rejection costs the slice its single
 * escalation and re-runs the SAME slice prompt on another model, which will
 * produce the same diff and meet the same objection — and the offending code
 * may not even be inside the slice's owned paths, so no attempt of this slice
 * is permitted to fix it. Blocking there converts a correct slice into a failed
 * one and buys nothing. Reported as a concern it still reaches the run report,
 * where a human can act on it.
 *
 * THE MIDDLE RUNG HAS A MEASURED COST, AND IT IS NOT THE OUTER RUNG'S. Driven
 * against the compiled binary on a slice whose new function was asked to call
 * an existing helper with an inverted condition — and forbidden to modify that
 * helper — BOTH vendors blocked, in both directions: claude/claude-opus-5
 * rejected codex/gpt-5.6-terra's attempt ("the fix must land in billableTotal,
 * which this task was forbidden to modify"), the retry re-routed to
 * claude/claude-sonnet-5, and codex/gpt-5.6-sol rejected that one too. The
 * slice spent both attempts and failed.
 *
 * That is the intended outcome rather than a regression: the code really would
 * return a wrong total, and committing it because no attempt was permitted to
 * fix it would be brigadier shipping known-wrong behaviour to keep a slice
 * green. But it means a plan can contain a slice that cannot pass this gate at
 * any effort, and the report has to be read as "re-slice this" rather than as
 * "the models failed". The outer rung is capped at `concern` precisely so that
 * this failure mode is reachable ONLY when the change itself misbehaves.
 *
 * WHAT THE GATE THEREFORE DOES NOT CATCH, stated so the README can say it: a
 * pre-existing defect in a file a slice touches is not blocked, and at best
 * appears as a non-blocking concern. Nothing outside the diff and its
 * surrounding files is looked at at all. This gate reviews the change; it does
 * not audit the codebase, and it does not run the tests, the linter or the
 * build.
 *
 * WHEN THERE IS NO DIFF, THE DEGRADATION IS VISIBLE. `diffUncommitted` is
 * optional on `WorktreeEngine` and refuses outright for an `unsafeInPlace`
 * worktree, whose uncommitted content belongs to the user and to every
 * concurrent slice as much as to this one. Either way the prompt says so, the
 * run log says so, and the reviewer falls back to reading the owned paths — the
 * pre-diff behaviour, now named rather than assumed.
 *
 * A COST THAT REMAINS: this runs before `engine.commit` can discover that the worker
 * changed nothing, so a slice heading for `NO_CHANGES` still pays for one
 * reviewer run. That is now knowable in advance rather than unknowable — an
 * empty patch and `NoChangesToCommitError` compare the same two trees, so they
 * are one fact rather than two opinions that could disagree — but acting on it
 * would need a skip reason `ReviewSkipReason` does not have, and inventing a
 * verdict for it here would be worse than the wasted launch. The reviewer is
 * told the change is empty instead.
 *
 * IT FAILS OPEN, AND THAT IS A PRODUCT DECISION RATHER THAN AN OVERSIGHT. A
 * reviewer that cannot be chosen, cannot be launched, or answers unreadably
 * yields `verdict: "skipped"` and the slice commits. Fail-closed would turn one
 * vendor's outage — or a single-vendor install, which `brigadier init` produces
 * whenever it finds only one CLI — into a run where every slice fails for a
 * reason that has nothing to do with the user's code. The price is that a
 * skipped gate must be impossible to mistake for a passing one, which is why
 * `SliceReview` has three arms and why the report prints the skip reason.
 */

import type { VendorConfig } from "../config/contracts.js";
import type { Effort, Vendor } from "../contracts.js";
import type { UncommittedDiff } from "../worktree/contracts.js";
import type {
  ReviewerIdentity,
  ReviewFinding,
  ReviewSeverity,
  SliceReview,
  SliceReviewer,
  SliceReviewRequest,
  SupervisorPorts,
} from "./contracts.js";
import type { OneShotEnv } from "./one-shot.js";
import { runOneShotPrompt } from "./one-shot.js";
import { describeError } from "./support.js";

/**
 * A review is a bounded read, not a coding session. Fifteen minutes is far more
 * than the measured runs needed and still stops a confused reviewer from
 * holding one of `maxWorkers` slots for the hour a coding slice is allowed.
 */
const REVIEW_TIMEOUT_MS = 900_000;

/**
 * A reviewer that has taken forty turns has stopped reviewing and started
 * exploring. The bound exists so that behaviour costs a turn limit rather than
 * the full timeout.
 */
const REVIEW_MAX_TURNS = 40;

/**
 * The two tokens a reviewer may use, matched case-insensitively after trimming.
 *
 * NOTHING ELSE IS GUESSED AT. A response using `critical` or `nit` is not
 * quietly mapped onto one of these: mapping up would let a naming preference
 * fail a slice, mapping down would let a real defect through silently, and both
 * would be brigadier inventing a verdict nobody chose. Such a response is
 * reported as `UNREADABLE_RESPONSE` instead, which is visible in the run report
 * and — because the gate fails open — lets the slice through with the fact
 * recorded rather than hidden.
 */
const SEVERITIES: ReadonlyMap<string, ReviewSeverity> = new Map([
  ["blocking", "blocking"],
  ["concern", "concern"],
]);

/**
 * How much of a reviewer's reply is scanned for its findings block, and how
 * many candidate objects are tried inside it.
 *
 * BOTH BOUNDS EXIST SO THE PARSER CANNOT BE MADE SLOW BY ITS INPUT. The scan
 * takes the TAIL of the reply because the contract asks for the JSON last, and
 * a reviewer that also pasted the file it reviewed would otherwise push the
 * answer past the window from the wrong end.
 */
const MAX_SCAN_CHARS = 64 * 1024;
const MAX_CANDIDATES = 200;
const SCAN_STEP_BUDGET_FACTOR = 2;

/**
 * How much of the change the reviewer is shown, in characters.
 *
 * 96 KiB is roughly 24k tokens — an eighth of the smallest context window any
 * configured reviewer has, and already more diff than a careful reading
 * survives. The bound is not really about the context window: it is about
 * attention and about cost. A reviewer handed a 400 KiB patch does not read it
 * more slowly, it reads it less carefully, and the run pays input tokens for
 * every byte either way.
 *
 * A slice that produces more than this has outgrown the review rather than the
 * limit — the playbook sizes a slice at fifteen to twenty files — so the honest
 * response is to show the first 96 KiB and SAY that it was cut, which
 * `UncommittedDiff` guarantees by putting the notice inside the text. Both the
 * reviewer and the run log learn about it; nothing is quietly dropped.
 */
const MAX_DIFF_CHARACTERS = 96 * 1024;

/**
 * What the reviewer is shown as "the change".
 *
 * Three arms rather than a nullable patch, for the same reason `SliceReview`
 * has three: an empty change and an unavailable diff are different facts, and a
 * prompt that rendered them alike would tell a reviewer that a worker wrote
 * nothing when the truth is that brigadier could not look.
 */
type ReviewedChange =
  | { readonly kind: "diff"; readonly patch: string }
  | { readonly kind: "empty" }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * No config is taken here on purpose. Which vendors exist is a property of the
 * RUN, and every request already carries the `RoutingInput` the run was built
 * from, so a reviewer pinned to a config captured at construction could
 * disagree with the routing decision it is reviewing.
 */
export interface CrossVendorReviewerOptions {
  readonly ports: SupervisorPorts;
  readonly env: OneShotEnv;
}

/**
 * The real gate: pick the other vendor, ask it to review, adjudicate the answer.
 */
export function createCrossVendorReviewer(
  options: CrossVendorReviewerOptions,
): SliceReviewer {
  return {
    review: (request: SliceReviewRequest): Promise<SliceReview> =>
      reviewSlice(options, request),
  };
}

async function reviewSlice(
  options: CrossVendorReviewerOptions,
  request: SliceReviewRequest,
): Promise<SliceReview> {
  const startedAt = options.ports.now();
  const elapsed = (): number => options.ports.now() - startedAt;
  const sliceId = request.slice.id;
  const redact = (artifact: string): string =>
    options.ports.engine.redact(request.worktree, artifact);

  // The config carried by the run's own `RoutingInput` rather than the one this
  // reviewer was constructed with: a caller may legitimately run two plans
  // against different configs through one composition root, and the vendors
  // that exist for THIS slice are the ones its routing input names.
  const vendors = request.routing.config.vendors;
  const other = otherVendor(request.builder.vendor, vendors);
  if (other === null) {
    return {
      verdict: "skipped",
      reviewer: null,
      reason: "NO_OTHER_VENDOR",
      message: redact(
        `slice ${sliceId} was built by ${request.builder.vendor} and no other vendor is configured, so no cross-vendor review was possible`,
      ),
      durationMs: elapsed(),
    };
  }

  const reviewer = reviewerIdentity(other);
  const worker = options.ports.workerFor(other.vendor);
  if (worker === null) {
    return {
      verdict: "skipped",
      reviewer,
      reason: "NO_ADAPTER",
      message: redact(
        `slice ${sliceId} could not be reviewed: no worker adapter is configured for vendor "${other.vendor}"`,
      ),
      durationMs: elapsed(),
    };
  }

  options.ports.log(
    redact(
      `slice ${sliceId} attempt ${request.attempt}: reviewing ${request.builder.vendor}/${request.builder.model}'s work with ${reviewer.vendor}/${reviewer.model} at ${reviewer.effort} effort`,
    ),
    "verbose",
  );

  // Taken AFTER the two skip checks above: a run with one vendor configured
  // spawns no reviewer, and computing a diff nobody will read would charge
  // every slice of a single-vendor install for a gate that cannot happen.
  const change = await readChange(options, request);

  const answer = await runOneShotPrompt(worker, {
    id: redact(`${sliceId}-review-${request.attempt}`),
    vendor: reviewer.vendor,
    model: reviewer.model,
    effort: reviewer.effort,
    prompt: redact(reviewPrompt(request, change)),
    cwd: request.worktreePath,
    env: options.env,
    purpose: redact(`cross-vendor review of slice ${sliceId}`),
    timeoutMs: REVIEW_TIMEOUT_MS,
    maxTurns: REVIEW_MAX_TURNS,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  if (!answer.ok) {
    const cancelled = answer.failure.kind === "CANCELLED";
    return {
      verdict: "skipped",
      reviewer,
      reason: cancelled ? "CANCELLED" : "REVIEWER_FAILED",
      // The reviewer's failure is reported as the reviewer's, never as the
      // slice's: a reviewer that ran out of quota has formed no opinion about
      // anybody's code, and a message that blurred the two would send a user
      // looking for a bug that is not there.
      message: redact(
        `slice ${sliceId} was not reviewed: the ${reviewer.vendor}/${reviewer.model} reviewer failed with ${answer.failure.kind}: ${answer.failure.message}`,
      ),
      ...(answer.cleanupFailure === undefined
        ? {}
        : { cleanupFailure: redact(answer.cleanupFailure) }),
      durationMs: elapsed(),
    };
  }

  const findings = parseFindings(answer.text);
  if (findings === null) {
    return {
      verdict: "skipped",
      reviewer,
      reason: "UNREADABLE_RESPONSE",
      message: redact(
        `slice ${sliceId} was not reviewed: the ${reviewer.vendor}/${reviewer.model} reviewer replied without a findings block this build could parse`,
      ),
      durationMs: elapsed(),
    };
  }

  return adjudicate(
    findings.map((finding) => ({
      ...finding,
      path: finding.path === null ? null : redact(finding.path),
      summary: redact(finding.summary),
    })),
    reviewer,
    elapsed(),
  );
}

/**
 * THE ADJUDICATOR.
 *
 * It blocks on `blocking` findings and on nothing else. That is the entire
 * rule, and its simplicity is deliberate: the judgement about whether a defect
 * is real belongs to the reviewer, which has read the code, rather than to a
 * heuristic here, which has read a JSON object.
 *
 * WHY NOT "BLOCK ON ANY FINDING". Roughly one finding in ten is a false
 * positive in this project's experience. A gate that blocked on all of them
 * would reject most slices, cost each one its single escalation, and be turned
 * off by the first user who met it — a gate nobody runs catches nothing. Asking
 * the reviewer to separate "I am confident this is wrong" from "a human should
 * look at this" moves the call to where the context is and leaves the concerns
 * on the report either way.
 *
 * WHAT IT CANNOT TELL APART, and every one of these is a real limit rather than
 * a hypothetical:
 *
 *   - A TRUE BLOCKING DEFECT FROM A CONFIDENT HALLUCINATION. It has no
 *     independent evidence and runs nothing; it reads a severity label at face
 *     value. A reviewer that invents a defect and marks it blocking costs the
 *     slice a full re-route, and nothing here can catch that.
 *   - A CLEAN SLICE FROM A REVIEWER THAT DID NOT LOOK. `{"findings":[]}` from a
 *     model that read every file and `{"findings":[]}` from one that read
 *     nothing are byte-identical. There is no proof-of-work check.
 *   - CORRECTNESS FROM TASTE. The prompt asks for correctness only and forbids
 *     style, but nothing enforces it; a reviewer that marks a naming preference
 *     blocking will fail the slice.
 *   - AN INCOMPLETE CHANGE FROM A WRONG ONE. The reviewer sees the exact
 *     sanitized diff `commit()` would record, but this adjudicator sees only
 *     the findings it returned. It has no independent proof that an omitted
 *     requirement is absent rather than intentionally outside the change.
 *
 * What it CAN tell apart, and this is the half that made a three-armed verdict
 * necessary: a review that happened from one that did not. A failed, cancelled
 * or unreadable review never reaches this function at all.
 */
function adjudicate(
  findings: readonly ReviewFinding[],
  reviewer: ReviewerIdentity,
  durationMs: number,
): SliceReview {
  const blocking = findings.filter(
    (finding) => finding.severity === "blocking",
  );
  if (blocking.length === 0) {
    return { verdict: "approved", reviewer, findings, durationMs };
  }
  return { verdict: "rejected", reviewer, findings, durationMs };
}

/**
 * The configured vendor that is not the builder's, or null when there is none.
 *
 * Returns the FIRST such vendor rather than a chosen one because `Vendor` has
 * exactly two members today; a third would make this an arbitrary pick and is
 * the moment to give the user a say. Stated here so that day is not silent.
 */
function otherVendor(
  builder: Vendor,
  vendors: readonly VendorConfig[],
): VendorConfig | null {
  return vendors.find((candidate) => candidate.vendor !== builder) ?? null;
}

/**
 * The reviewer's model and effort.
 *
 * The vendor's `defaultModel` is used rather than a routing decision, and the
 * reason is that routing answers a different question: `route` ranks models by
 * competence against a slice's DIFFICULTY, and a review is not the slice. The
 * default model is the one the user told `brigadier init` they wanted from this
 * vendor, which is exactly the right answer to "who should read this".
 *
 * EFFORT IS CAPPED AT `high`, WHATEVER THE CEILING SAYS. Decision #20 reserves
 * `xhigh` for a slice worker re-routed after a prior routed model ran and
 * failed. A reviewer is not that re-routed slice worker, so it never receives
 * the rung. A model whose ceiling is `medium` reviews at `medium`.
 */
function reviewerIdentity(vendor: VendorConfig): ReviewerIdentity {
  const permitted = vendor.models.find(
    (model) => model.id === vendor.defaultModel,
  );
  return {
    vendor: vendor.vendor,
    model: vendor.defaultModel,
    effort: cappedEffort(permitted?.effortCeiling),
  };
}

function cappedEffort(ceiling: Effort | undefined): Effort {
  // `undefined` means the default model is not in the permitted list, which
  // `parseConfig` rejects — so reaching it means a hand-built config. The
  // lowest rung is the honest answer to a ceiling nobody recorded.
  return ceiling === "high" || ceiling === "xhigh" ? "high" : "medium";
}

/**
 * The change this attempt made, or the reason there is no diff of it.
 *
 * IT NEVER THROWS AND IT NEVER SKIPS THE REVIEW. A diff is what makes the
 * review good, not what makes it possible: a gate that refused to run without
 * one would turn every `--unsafe-in-place` run, and every consumer supplying
 * its own engine, into a slice that commits unreviewed. So a failure here
 * degrades to the pre-diff behaviour and says so twice — on the run log, which
 * the CLI prints and the MCP surface captures, and inside the reviewer's own
 * prompt, which is the only place that can stop the reviewer believing it saw
 * a change it was never shown.
 */
async function readChange(
  options: CrossVendorReviewerOptions,
  request: SliceReviewRequest,
): Promise<ReviewedChange> {
  const redact = (artifact: string): string =>
    options.ports.engine.redact(request.worktree, artifact);
  const where = redact(`slice ${request.slice.id} attempt ${request.attempt}`);
  const { engine } = options.ports;
  if (engine.diffUncommitted === undefined) {
    const reason = "this run's worktree engine cannot produce one";
    options.ports.log(
      `${where}: no diff of the change is available (${reason}), so the reviewer is reading whole files instead`,
      "normal",
    );
    return { kind: "unavailable", reason };
  }

  let diff: UncommittedDiff;
  try {
    diff = await engine.diffUncommitted({
      worktreePath: request.worktreePath,
      maxCharacters: MAX_DIFF_CHARACTERS,
    });
  } catch (error) {
    const reason = redact(describeError(error));
    options.ports.log(
      `${where}: no diff of the change is available (${reason}), so the reviewer is reading whole files instead`,
      "normal",
    );
    return { kind: "unavailable", reason };
  }

  if (diff.truncated) {
    // On the log as well as inside the patch, because the two reach different
    // people: the notice inside the patch is for the reviewer, and this line is
    // for the operator reading why a large slice was approved thinly.
    options.ports.log(
      `${where}: the diff shown to the reviewer was truncated to ${MAX_DIFF_CHARACTERS} of ${diff.totalCharacters} characters`,
      "normal",
    );
  }
  return diff.patch === ""
    ? { kind: "empty" }
    : { kind: "diff", patch: diff.patch };
}

/**
 * A fenced block that the patch cannot escape from.
 *
 * A diff of a markdown file contains fences of its own, and a three-backtick
 * wrapper around one ends at the patch's first ``` — after which the rest of
 * the change reads as prose and the reviewer's instructions read as part of the
 * diff. The fence is therefore one backtick longer than the longest run in the
 * content, which is the rule CommonMark itself uses.
 */
function fenced(language: string, content: string): string {
  let longest = 0;
  let run = 0;
  for (const character of content) {
    run = character === "`" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

/**
 * THE PROMPT, AND WHY IT IS WORDED THIS WAY.
 *
 * IT IS A CORRECTNESS REVIEW, NOT AN ATTACK, AND THE DIFFERENCE IS OPERATIONAL
 * RATHER THAN STYLISTIC. A prompt framed as "try to break this" or "find
 * everything wrong with this code" is rejected outright by OpenAI's safety
 * classifier, which would turn every Codex review into a `REFUSED` outcome and
 * — because the gate fails open — into a silently skipped gate on every
 * Claude-built slice. The framing below is the product's, not merely this
 * repository's tooling, so it has to hold for every user's slice.
 *
 * IT SHOWS THE DIFF AND NAMES THE OWNED PATHS, and the two do different jobs.
 * The diff is what the review is ABOUT; the owned paths are what the reviewer
 * may read to judge it, because three lines of context rarely settle whether a
 * change is correct. It is also told what the task WAS, because "is this code
 * correct" is unanswerable without "correct for what".
 *
 * IT STATES THE SCOPE RULE RATHER THAN LEAVING IT TO THE MODEL. See the module
 * header for the measured failure that made this necessary and for why the
 * outer rung is capped at `concern`.
 *
 * IT ASKS FOR THE VERDICT AS JSON ON THE LAST LINE because the alternative is
 * parsing prose, and a gate that guesses at whether a paragraph was an approval
 * is worse than one that says it could not read the answer.
 */
function reviewPrompt(
  request: SliceReviewRequest,
  change: ReviewedChange,
): string {
  const ownedPaths =
    request.slice.ownedPaths.length === 0
      ? "(this task declared no owned paths)"
      : request.slice.ownedPaths.map((path) => `- ${path}`).join("\n");
  return [
    "You are reviewing a code change for correctness. Another engineer has just",
    "finished the task below in this working tree, and their work has not been",
    "committed yet. Your review decides whether it is committed.",
    "",
    `# The task they were given (${request.slice.id}: ${request.slice.title})`,
    "",
    request.slice.prompt,
    "",
    "# Files this task was allowed to change",
    "",
    ownedPaths,
    "",
    "# The change they made",
    "",
    ...describeChange(change),
    "",
    "# What to review, and what to leave alone",
    "",
    ...scopeRule(change),
    "",
    "Look for logic errors, off-by-one errors, inverted conditions, mishandled",
    "or swallowed errors, unhandled cases, resource leaks, and code that does",
    "not do what the task asked.",
    "",
    "Do not report style, naming, formatting, comment wording, or preference",
    "issues. They are out of scope for this review.",
    "",
    "# How to report",
    "",
    'Use severity "blocking" only when you are confident the code is wrong and',
    "would misbehave when it runs. If you are unsure, or the point is worth a",
    'human reading but should not stop the commit, use severity "concern".',
    "",
    "End your reply with a single JSON object on its own line, in exactly this",
    "shape and using only these two severity values:",
    "",
    '{"findings":[{"severity":"blocking","path":"src/example.ts","line":42,"summary":"one sentence"}]}',
    "",
    'If you find nothing wrong, end with exactly: {"findings":[]}',
  ].join("\n");
}

/** The "# The change they made" section, one line per array element. */
function describeChange(change: ReviewedChange): readonly string[] {
  if (change.kind === "diff") {
    return [
      "The unified diff below is exactly what will be committed if you approve",
      "it. Nothing outside it is part of this change.",
      "",
      fenced("diff", change.patch),
    ];
  }
  if (change.kind === "empty") {
    return [
      "This task changed no file at all: the diff of its work is empty, so",
      "there is nothing here that would be committed.",
    ];
  }
  return [
    `No diff of this change could be produced (${change.reason}), so it is not`,
    "shown here. Read the files listed above in the current directory and judge",
    "their current contents instead.",
  ];
}

/**
 * The scope rule, in the reviewer's own words.
 *
 * WITHOUT A DIFF IT IS A WEAKER RULE, AND IT SAYS SO. A reviewer looking at
 * whole files cannot tell what this task wrote, so the best instruction
 * available is "block only on what the task asked for" — which is a judgement
 * rather than an observation, and it is exactly the ambiguity the diff removes.
 */
function scopeRule(change: ReviewedChange): readonly string[] {
  if (change.kind === "unavailable") {
    return [
      "Judge whether the code in those files is correct for the task above.",
      "",
      'You cannot see which lines this task wrote, so use severity "blocking"',
      "only for code the task above asked for. Anything that looks pre-existing",
      'belongs under severity "concern".',
    ];
  }
  return [
    "Judge the lines this diff adds or changes, in the context of the files",
    "they land in. Read those files in the current directory as well: three",
    "lines of context is rarely enough to tell whether a change is correct.",
    "",
    "Code this diff does not touch is in scope only when the changed code",
    "depends on it — calls it, reads its result, or extends it — so that this",
    "change itself misbehaves when it runs. Grade that like any other defect.",
    "",
    "Anything else you notice in code this task did not change is outside this",
    'verdict, however wrong it looks. Report it with severity "concern" so a',
    'human sees it, and never with severity "blocking": this task was not asked',
    "to fix it, those lines may belong to another task, and re-running this",
    "task would produce the same diff and meet the same objection.",
  ];
}

/**
 * The findings the reviewer reported, or null when its reply cannot be read.
 *
 * TOLERANT ABOUT PACKAGING, STRICT ABOUT CONTENT. Measured replies wrap the
 * object in a ```json fence (claude 2.1.226) or emit it bare as the final
 * message (codex-cli 0.145.0), and both are accepted, as is any amount of prose
 * around it. What is not accepted is a findings entry this code would have to
 * guess about — an unrecognised severity, a missing summary — because a guess
 * there is a verdict nobody chose.
 *
 * THE LAST MATCHING OBJECT WINS. A reviewer that shows the required shape as an
 * example before answering emits two parseable objects, and the answer is the
 * later one.
 *
 * IT ALWAYS TERMINATES. The tail of the reply is scanned once for candidate
 * `{` positions, at most `MAX_CANDIDATES` of them are tried, and each attempt
 * walks forward at most to the end of the window. There is no backtracking and
 * no regular expression that could catastrophically backtrack.
 */
export function parseFindings(text: string): readonly ReviewFinding[] | null {
  const scanned =
    text.length > MAX_SCAN_CHARS ? text.slice(-MAX_SCAN_CHARS) : text;
  const starts: number[] = [];
  let scanSteps = 0;
  const scanStepBudget = scanned.length * SCAN_STEP_BUDGET_FACTOR;
  for (let index = 0; index < scanned.length; index += 1) {
    scanSteps += 1;
    if (scanSteps > scanStepBudget) {
      // Keep this independent from matchingBrace's budget: losing this loop's
      // own increment must fail synchronously before candidate parsing starts.
      throw new Error(
        `parseFindings exceeded its ${scanStepBudget}-step candidate-scan budget`,
      );
    }
    if (scanned[index] === "{") {
      starts.push(index);
    }
  }
  // The last candidates, in source order, so the winner below is the latest
  // object in the reply rather than the latest one this loop happened to try.
  const candidates = starts.slice(-MAX_CANDIDATES);

  let found: readonly ReviewFinding[] | null = null;
  for (const start of candidates) {
    const end = matchingBrace(scanned, start);
    if (end === null) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(scanned.slice(start, end + 1));
    } catch {
      continue;
    }
    const findings = readFindings(parsed);
    if (findings !== null) {
      found = findings;
    }
  }
  return found;
}

/**
 * The index of the `}` closing the `{` at `start`, or null when there is none.
 *
 * String state is tracked because a brace inside a JSON string is not a brace,
 * and an escape is tracked because `"\\"` ends a string while `"\""` does not.
 * Getting either wrong would make the scan pair the wrong braces and hand
 * `JSON.parse` a substring that happens to be valid JSON of the wrong extent.
 */
function matchingBrace(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let steps = 0;
  const stepBudget = (text.length - start) * SCAN_STEP_BUDGET_FACTOR;
  for (let index = start; index < text.length; index += 1) {
    steps += 1;
    if (steps > stepBudget) {
      // A timer cannot preempt a synchronous parser loop. This defensive,
      // input-proportional budget is twice the most iterations the advancing
      // loop can make, so real input cannot exhaust it while a lost increment
      // fails promptly instead of wedging the supervisor.
      throw new Error(
        `matchingBrace exceeded its ${stepBudget}-step budget while parsing review output`,
      );
    }
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

/** The `findings` array of a parsed object, or null when it is not one. */
function readFindings(value: unknown): readonly ReviewFinding[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (!("findings" in value)) {
    return null;
  }
  const raw = (value as { readonly findings: unknown }).findings;
  if (!Array.isArray(raw)) {
    return null;
  }
  const findings: ReviewFinding[] = [];
  for (const entry of raw) {
    const finding = readFinding(entry);
    if (finding === null) {
      // ONE UNREADABLE ENTRY VOIDS THE WHOLE REPLY, and the cost is named
      // rather than hidden: a review with four good findings and one malformed
      // one is reported as unreadable, and the gate lets the slice through. The
      // alternative was dropping the entry, which silently discards whatever it
      // said — and the thing it said might have been the blocking one.
      return null;
    }
    findings.push(finding);
  }
  return findings;
}

function readFinding(value: unknown): ReviewFinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const rawSeverity = record.severity;
  if (typeof rawSeverity !== "string") {
    return null;
  }
  const severity = SEVERITIES.get(rawSeverity.trim().toLowerCase());
  if (severity === undefined) {
    return null;
  }
  const summary = record.summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    return null;
  }
  return {
    severity,
    path:
      typeof record.path === "string" && record.path !== ""
        ? record.path
        : null,
    line:
      typeof record.line === "number" &&
      Number.isSafeInteger(record.line) &&
      record.line > 0
        ? record.line
        : null,
    summary: summary.trim(),
  };
}
