/**
 * THE PLANNER, AND WHERE THE LLM BOUNDARY GOES.
 *
 * Everything in `brigadier` up to this file is a deterministic function of its
 * inputs. The supervisor routes, schedules, spawns, gates and merges without
 * ever asking a model what it should do — models do the *work*, and the
 * supervisor decides what work there is. `brigadier run "<task>"` is the first
 * feature that cannot be built that way: turning a sentence into a set of file
 * ownership claims requires reading a repository and exercising judgement, and
 * no amount of parsing gets you there.
 *
 * THE RULING: THE MODEL PROPOSES, THE DETERMINISTIC VALIDATOR DISPOSES.
 *
 * The model is placed UPSTREAM of the existing untrusted-input boundary rather
 * than downstream of it. Concretely, and this is the whole design:
 *
 *   1. The model's reply is text. It is read by `parsePlannerReply`
 *      (`./reply.ts`), which decides only which of three shapes it is and
 *      validates nothing about a plan's contents.
 *   2. The candidate plan is then handed to `parsePlanDocument` — the SAME
 *      function, unmodified, that `brigadier run --plan <file>` sends a
 *      hand-written file through. It is the module documented as "the
 *      untrusted-input boundary", and it does not know or care that a model
 *      wrote this one.
 *   3. The resulting `PlanDocument` goes to the orchestrator, which calls
 *      `validatePlan` (`src/plan/validate.ts`) as step 1 of every run, before
 *      it prepares a session, creates a worktree, or writes a ref.
 *
 * SO THE SAFETY PROPERTY IS EXACTLY THIS: a model-authored plan and a
 * human-authored plan are indistinguishable by the time anything acts on them.
 * There is no planner-only code path into the supervisor, no `PlanDocument`
 * constructed by hand anywhere in this unit, and no second copy of any rule.
 * Nothing the model emits can make brigadier do something it would not do for a
 * file on disk containing the same bytes.
 *
 * HOW I KNOW THE MODEL CANNOT WEAKEN `validatePlan`:
 *
 *   - This unit never calls `validatePlan`, so it cannot call it with different
 *     arguments, cannot inspect its verdict, and above all cannot swallow it.
 *     The only call site remains the orchestrator's.
 *   - This unit's only route to a `PlanDocument` is `parsePlanDocument`. The
 *     type is not constructible here by any other means: `PlannerOutcome`
 *     carries `PlanDocument`, and the single expression that produces one is in
 *     `planFromReply` below.
 *   - `validatePlan` runs before `engine.prepare`, so a plan it rejects costs
 *     zero worktrees and zero refs. A hostile or merely confused plan is
 *     therefore refused with the same blast radius as a typo in a plan file.
 *
 * WHAT THE MODEL GENUINELY DECIDES, stated plainly so nobody mistakes the above
 * for a claim that the model is harmless: it decides how many slices there are
 * (up to a budget this file enforces), which files each one owns, what each
 * worker is told to do, how hard each slice is — which sets the competence floor
 * a model must clear to be allowed to run it — and whether the task is
 * answerable at all. Those are real decisions with real consequences. The claim
 * is narrower and is the only one worth making: the model cannot make brigadier
 * ACCEPT a plan shape it would otherwise refuse.
 *
 * THE ONE COST OF ROUTING EVERYTHING THROUGH THE ONE GATE, named rather than
 * fixed. When `validatePlan` rejects a model's plan, the user gets exit 3 and a
 * `PLAN_INVALID` failure for a plan they did not write and cannot edit — where a
 * `--plan` user would simply fix their file. That is why `PlannerOutcome`
 * carries `json` and why the CLI prints the plan BEFORE running it: the rejected
 * plan is on screen, and saving it to a file turns a dead end into exactly the
 * artifact the `--plan` user already had. Adding a second, planner-local copy of
 * the validation to produce a nicer message was the alternative, and it was
 * refused: two implementations of one rule is how a plan becomes legal or
 * illegal depending on which check happened to run.
 *
 * IT IS READ-ONLY BY CONSTRUCTION. The model is launched through
 * `runOneShotPrompt`, which builds its spec with no owned paths and therefore no
 * writable lane in either vendor's grammar. The planner reads the user's
 * checkout to find real file names; it cannot change a byte of it.
 */

import type { BrigadierConfig, VendorConfig } from "../config/index.js";
import type { AnyWorker, Effort, Vendor } from "../contracts.js";
import type {
  OneShotEnv,
  OneShotRequest,
  OneShotResult,
  PlanDocument,
} from "../supervisor/index.js";
import {
  PlanDocumentError,
  parsePlanDocument,
  runOneShotPrompt,
} from "../supervisor/index.js";
import type {
  Planner,
  PlannerIdentity,
  PlannerOutcome,
  PlannerRequest,
} from "./contracts.js";
import { parsePlannerReply } from "./reply.js";

/**
 * Planning is a bounded read of a repository, not a coding session. The two
 * bounds mirror the review gate's for the same reasons: fifteen minutes is far
 * more than a plan needs, and a planner that has taken forty turns has stopped
 * planning and started exploring.
 */
const PLAN_TIMEOUT_MS = 900_000;
const PLAN_MAX_TURNS = 40;

/**
 * How `createModelPlanner` reaches a model.
 *
 * `runPrompt` exists so this unit's tests drive the REAL planner — its prompt,
 * its budget enforcement, its parsing, its `needs_human` handling — against a
 * scripted answer, with no subprocess and no model. It defaults to the shipped
 * primitive, so production wiring passes nothing.
 */
export interface ModelPlannerOptions {
  readonly config: BrigadierConfig;
  readonly workerFor: (vendor: Vendor) => AnyWorker | null;
  readonly env: OneShotEnv;
  readonly log: (line: string) => void;
  readonly runPrompt?: (
    worker: AnyWorker,
    request: OneShotRequest,
  ) => Promise<OneShotResult>;
}

/** The real planner: ask a model, then refuse everything the gates refuse. */
export function createModelPlanner(options: ModelPlannerOptions): Planner {
  return {
    plan: (request: PlannerRequest): Promise<PlannerOutcome> =>
      planTask(options, request),
  };
}

async function planTask(
  options: ModelPlannerOptions,
  request: PlannerRequest,
): Promise<PlannerOutcome> {
  const vendor = options.config.vendors[0];
  if (vendor === undefined) {
    return {
      kind: "failed",
      message:
        "brigadier run: no vendor is configured, so there is no model to plan with. Run `brigadier init` to scan this machine for worker CLIs.",
    };
  }

  const planner = plannerIdentity(vendor);
  const worker = options.workerFor(planner.vendor);
  if (worker === null) {
    return {
      kind: "failed",
      message: `brigadier run: no worker adapter is configured for vendor "${planner.vendor}", so the task could not be planned.`,
    };
  }

  options.log(
    `planning with ${planner.vendor}/${planner.model} at ${planner.effort} effort, budget ${request.maxSlices} slice(s)`,
  );

  const runPrompt = options.runPrompt ?? runOneShotPrompt;
  const answer = await runPrompt(worker, {
    id: "brigadier-plan",
    vendor: planner.vendor,
    model: planner.model,
    effort: planner.effort,
    prompt: planPrompt(request),
    cwd: request.cwd,
    env: options.env,
    purpose: "planning a task description",
    timeoutMs: PLAN_TIMEOUT_MS,
    maxTurns: PLAN_MAX_TURNS,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  if (!answer.ok) {
    return {
      kind: "failed",
      message: `brigadier run: the ${planner.vendor}/${planner.model} planner failed with ${answer.failure.kind}: ${answer.failure.message}`,
    };
  }

  const reply = parsePlannerReply(answer.text);
  if (reply.kind === "unreadable") {
    return {
      kind: "failed",
      message: `brigadier run: the ${planner.vendor}/${planner.model} planner replied with something this build could not read: ${reply.reason}`,
    };
  }
  if (reply.kind === "needs-human") {
    return { kind: "needs-human", questions: reply.questions, planner };
  }
  return planFromReply(reply.plan, request, planner);
}

/**
 * The candidate plan, through the one gate this unit is allowed to use.
 *
 * THE BUDGET IS ENFORCED HERE AND NOWHERE ELSE, and it is enforced as a REFUSAL
 * rather than a truncation. Decision #8 makes fan-out earned: the user said how
 * many workers they were willing to spend, and a planner that returned more
 * slices than that has answered a different question. Silently running the extra
 * slices would spend worktrees the user did not authorize; silently dropping
 * them would delete work from a plan while reporting success. Neither is a call
 * brigadier is entitled to make, so the run does not start and the user is told
 * exactly what to pass to allow it.
 *
 * There is no re-ask. One planning attempt is one model launch, and a retry loop
 * would double the cost of every confused reply while making the command's
 * runtime a function of the model's mood.
 */
function planFromReply(
  candidate: unknown,
  request: PlannerRequest,
  planner: PlannerIdentity,
): PlannerOutcome {
  let document: PlanDocument;
  try {
    document = parsePlanDocument(candidate);
  } catch (error) {
    if (error instanceof PlanDocumentError) {
      return {
        kind: "failed",
        message: `brigadier run: the ${planner.vendor}/${planner.model} planner produced a plan this build rejects (${error.issues.length} issue(s)): ${error.issues.join("; ")}`,
      };
    }
    return {
      kind: "failed",
      message: `brigadier run: the planner's plan could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const slices = document.plan.slices.length;
  if (slices > request.maxSlices) {
    return {
      kind: "failed",
      message: `brigadier run: the planner proposed ${slices} slices but the fan-out budget is ${request.maxSlices}; fan-out is earned, so pass --max-workers ${slices} to authorize it.`,
    };
  }

  // `JSON.stringify` rather than the model's own bytes, and that is deliberate:
  // every string here survived `parsePlanDocument`, and re-serializing escapes
  // any control byte inside one, so printing this cannot emit an ANSI escape
  // sequence the model chose into the user's terminal.
  return {
    kind: "planned",
    document,
    json: JSON.stringify(planDocumentAsFile(document), null, 2),
    planner,
  };
}

/**
 * The accepted plan in the on-disk shape, so the printed JSON is a file
 * `--plan` would accept.
 *
 * `PlanDocument` splits each slice's `difficulty` into the parallel
 * `directives` array — that split is `parsePlanDocument`'s job — so writing
 * `document.plan` straight out would emit a plan file that the parser then
 * rejects for a missing `difficulty`. The directives are documented to be one
 * per slice in slice order, which is what makes the rejoin below exact.
 */
function planDocumentAsFile(document: PlanDocument): unknown {
  return {
    id: document.plan.id,
    goal: document.plan.goal,
    slices: document.plan.slices.map((slice, index) => {
      const directive = document.directives[index];
      return {
        id: slice.id,
        title: slice.title,
        prompt: slice.prompt,
        ownedPaths: [...slice.ownedPaths],
        ...(slice.dependsOn.length === 0
          ? {}
          : { dependsOn: [...slice.dependsOn] }),
        ...(directive === undefined
          ? {}
          : { difficulty: directive.difficulty }),
        ...(directive?.requires === undefined
          ? {}
          : { requires: directive.requires }),
      };
    }),
  };
}

/**
 * Which model plans.
 *
 * THE FIRST CONFIGURED VENDOR'S DEFAULT MODEL, for the reason the review gate
 * gives about its own reviewer: `route` ranks models against a SLICE's
 * difficulty, and planning is not a slice — there is no plan yet to be
 * difficult. The default model is the one the user told `brigadier init` they
 * wanted from that vendor, which is the right answer to "who should read this
 * repository and think about it".
 *
 * The first vendor rather than a chosen one because decision #19 forbids vendor
 * from being a routing input, so there is no principled ordering to apply; the
 * order is discovery's. Stated here so the day a user wants to pick is not
 * silent.
 *
 * EFFORT IS CAPPED AT `high`, WHATEVER THE CEILING SAYS. Decision #20 makes
 * `xhigh` an escalation earned by an observed gate failure. Planning happens
 * before any gate exists to fail, so it can never have earned the rung.
 */
function plannerIdentity(vendor: VendorConfig): PlannerIdentity {
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
 * THE PROMPT.
 *
 * IT TEACHES EVERY RULE THE GATES ENFORCE, and that is not redundancy with the
 * gates — it is the only thing that makes the gates cheap. A rule the model is
 * never told is a rule it breaks, and a broken rule costs a whole planning
 * launch. Teaching them here and enforcing them there is the correct division:
 * the prompt raises the hit rate, the gates guarantee the outcome, and if the
 * two ever disagree the gate wins by construction because the prompt has no
 * enforcement power at all.
 *
 * IT DEFAULTS TO ONE SLICE. Decision #8: fan-out is earned. The budget sentence
 * is stated as a hard cap AND as a default of one, because a model told only
 * "at most 4" reliably returns 4.
 *
 * IT RESERVES `dependsOn` FOR REAL CONTENT DEPENDENCIES. A dependent slice
 * starts only after its prerequisites commit and their output is accumulated,
 * which makes the relationship real but serializes work that could otherwise
 * run concurrently. The prompt also teaches the graph rules `validatePlan`
 * enforces and makes clear that dependencies never relax exclusive ownership.
 *
 * IT ASKS FOR ONE JSON OBJECT LAST, for the reason the review gate does: parsing
 * prose to decide whether a paragraph was a plan or a question is worse than
 * saying the reply could not be read.
 */
export function planPrompt(request: PlannerRequest): string {
  const budget =
    request.maxSlices <= 1
      ? [
          "You must return EXACTLY ONE slice. This task has a fan-out budget of",
          "one worker, so the whole job goes to a single worker.",
        ]
      : [
          `You may return at most ${request.maxSlices} slices, and you should`,
          "return ONE unless the work genuinely splits into parts that touch",
          "completely different files. Returning more slices than the work",
          "partitions into is worse than returning one: two workers that need",
          "the same file cannot both have it, and the plan will be rejected.",
        ];

  return [
    "You are planning a software task. You are NOT doing the task: you will not",
    "write any code, and you cannot write to this directory. Read the",
    "repository in the current working directory and decide what work the",
    "request below actually requires, in terms of real files that exist here.",
    "",
    "# The request",
    "",
    request.task,
    "",
    "# What a plan is",
    "",
    "A plan is a set of slices. Each slice is one unit of work handed to one",
    "worker, running alone in its own copy of this repository, with EXCLUSIVE",
    "ownership of a set of files. A worker sees only the request text you write",
    "for it, so each slice's prompt must be self-contained: name the files, the",
    "interfaces, and the definition of done.",
    "",
    ...budget,
    "",
    "# Rules every slice must obey",
    "",
    "- `ownedPaths` is a non-empty list of repository-relative POSIX paths.",
    "  A path may be a file or a directory, and the worker may change anything",
    "  under a directory it owns.",
    "- Paths must be literal. No `*`, `?`, or `[` — wildcards are rejected.",
    "- No absolute paths, no `..` segments, no backslashes, and none of the",
    "  characters `(`, `)`, `,`, `\"`, or `'`.",
    "- No two slices may claim the same path, and no slice's path may be inside",
    "  a directory another slice claims. Overlapping ownership is rejected.",
    "- Use `dependsOn` only when a slice genuinely needs another slice's committed",
    "  output. List the prerequisite slice ids; that slice will start only after all",
    "  of them commit and their output has been accumulated.",
    "- Prefer independent slices whenever possible because they run concurrently.",
    "  Every dependency serializes work. Dependencies do not permit overlapping",
    "  `ownedPaths`; every dependency id must name another slice, and dependencies",
    "  must not form a cycle.",
    "- `difficulty` is required on every slice and is exactly one of",
    "  `routine`, `standard`, or `hard`. It decides how capable a model must be",
    "  to be allowed to run the slice, so answer honestly.",
    "- Slice `id` and the plan `id` must be short and made of letters, digits,",
    "  dots, underscores and hyphens, starting with a letter or digit. They name",
    "  git branches.",
    "",
    "# If you cannot plan this",
    "",
    "If the request is genuinely ambiguous — if two reasonable readings of it",
    "would produce materially different work, and picking one would mean",
    "guessing at something the requester alone can settle — do NOT guess and do",
    "NOT plan. Ask instead. Ask only about things that change what gets built;",
    "do not ask about details you can settle yourself by reading the repository,",
    "and do not ask for permission to proceed.",
    "",
    "# How to reply",
    "",
    "End your reply with a single JSON object on its own line, in exactly one",
    "of these two shapes.",
    "",
    "To plan the work:",
    "",
    '{"status":"plan","plan":{"id":"short-id","goal":"one sentence","slices":[{"id":"s1","title":"short title","prompt":"the full self-contained instruction for the worker","ownedPaths":["src/example.ts"],"difficulty":"standard"}]}}',
    "",
    "To ask instead:",
    "",
    '{"status":"needs_human","questions":["the first question","the second question"]}',
  ].join("\n");
}
