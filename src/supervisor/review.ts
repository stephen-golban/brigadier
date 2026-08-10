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
 * WHAT IT COSTS, STATED PLAINLY. Before the commit there is no diff and the
 * engine offers no way to compute one: `commit` is what turns the working tree
 * into an object a `git diff` could name. So the reviewer is pointed at the
 * slice's OWNED PATHS in the live worktree and reads their post-state. That is
 * not the same artifact as a diff — it cannot see what a line USED to say — and
 * for a slice that edits a large existing file the reviewer reads the whole
 * file rather than the changed hunk. It is accepted because the alternative was
 * spawning `git` from the slice runner, whose one filesystem access is a
 * read-only `realpath` and whose isolation story depends on staying that way.
 *
 * A SECOND COST: this runs before `engine.commit` can discover that the worker
 * changed nothing, so a slice heading for `NO_CHANGES` still pays for one
 * reviewer run. There is no cheap way to know in advance without inventing a
 * second opinion about "did anything change" that could disagree with the
 * engine's, which would be worse than the wasted launch.
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
      message: `slice ${sliceId} was built by ${request.builder.vendor} and no other vendor is configured, so no cross-vendor review was possible`,
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
      message: `slice ${sliceId} could not be reviewed: no worker adapter is configured for vendor "${other.vendor}"`,
      durationMs: elapsed(),
    };
  }

  options.ports.log(
    `slice ${sliceId} attempt ${request.attempt}: reviewing ${request.builder.vendor}/${request.builder.model}'s work with ${reviewer.vendor}/${reviewer.model} at ${reviewer.effort} effort`,
  );

  const answer = await runOneShotPrompt(worker, {
    id: `${sliceId}-review-${request.attempt}`,
    vendor: reviewer.vendor,
    model: reviewer.model,
    effort: reviewer.effort,
    prompt: reviewPrompt(request),
    cwd: request.worktreePath,
    env: options.env,
    purpose: `cross-vendor review of slice ${sliceId}`,
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
      message: `slice ${sliceId} was not reviewed: the ${reviewer.vendor}/${reviewer.model} reviewer failed with ${answer.failure.kind}: ${answer.failure.message}`,
      durationMs: elapsed(),
    };
  }

  const findings = parseFindings(answer.text);
  if (findings === null) {
    return {
      verdict: "skipped",
      reviewer,
      reason: "UNREADABLE_RESPONSE",
      message: `slice ${sliceId} was not reviewed: the ${reviewer.vendor}/${reviewer.model} reviewer replied without a findings block this build could parse`,
      durationMs: elapsed(),
    };
  }

  return adjudicate(findings, reviewer, elapsed());
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
 *   - AN INCOMPLETE SLICE FROM A WRONG ONE. The reviewer sees the owned paths'
 *     post-state, not the diff, so "this function was already here and is fine"
 *     and "this function was just written and is fine" look the same to it.
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
 * EFFORT IS CAPPED AT `high`, WHATEVER THE CEILING SAYS. Decision #20 makes
 * `xhigh` an escalation earned by an observed gate failure, and a reviewer is
 * the thing that observes it — it can never itself have earned the rung. A
 * model whose ceiling is `medium` reviews at `medium`.
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
 * IT NAMES THE OWNED PATHS BECAUSE THERE IS NO DIFF. See the module header: the
 * gate runs before the commit, so the reviewer is told which files this task
 * was allowed to change and asked to read them. It is also told what the task
 * WAS, because "is this code correct" is unanswerable without "correct for
 * what".
 *
 * IT ASKS FOR THE VERDICT AS JSON ON THE LAST LINE because the alternative is
 * parsing prose, and a gate that guesses at whether a paragraph was an approval
 * is worse than one that says it could not read the answer.
 */
function reviewPrompt(request: SliceReviewRequest): string {
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
    "# What to do",
    "",
    "Read those files in the current directory and judge whether the code is",
    "correct for the task above. Look for logic errors, off-by-one errors,",
    "inverted conditions, mishandled or swallowed errors, unhandled cases,",
    "resource leaks, and code that does not do what the task asked.",
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
  for (let index = 0; index < scanned.length; index += 1) {
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
  for (let index = start; index < text.length; index += 1) {
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
