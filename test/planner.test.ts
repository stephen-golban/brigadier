import { describe, expect, test } from "bun:test";
import type { BrigadierConfig } from "../src/config/index.ts";
import type { AnyWorker, TokenUsage } from "../src/contracts.ts";
import { validatePlan } from "../src/plan/index.ts";
import type { PlannerOutcome } from "../src/planner/index.ts";
import { createModelPlanner } from "../src/planner/index.ts";
import { planPrompt } from "../src/planner/planner.ts";
import { parsePlannerReply } from "../src/planner/reply.ts";
import {
  type OneShotRequest,
  type OneShotResult,
  parsePlanDocument,
} from "../src/supervisor/index.ts";

/**
 * A worker adapter that fails the test if anything tries to launch it.
 *
 * The planner is read-only by construction because it goes through
 * `runOneShotPrompt`, and every test here replaces that call — so a `spawn`
 * reaching this object would mean the planner had grown a second, unreviewed
 * route to a subprocess.
 */
const WORKER: AnyWorker = {
  vendor: "claude",
  processCompletion: "signals-then-must-be-killed",
  spawn: (): never => {
    throw new Error("the planner must not spawn a worker of its own");
  },
};

const CONFIG: BrigadierConfig = {
  version: 3,
  vendors: [
    {
      vendor: "claude",
      executable: "/opt/homebrew/bin/claude",
      version: "2.0.14",
      defaultModel: "claude-opus-5",
      models: [{ id: "claude-opus-5", effortCeiling: "high" }],
    },
  ],
  secretsConsent: false,
  linkedSecretPaths: [],
  allowDegradedRouting: false,
};

const ENV = {
  HOME: "/Users/worker",
  PATH: "/usr/bin:/bin",
  USER: "worker",
} as const;

const NO_USAGE: TokenUsage = {
  input: { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 },
  output: { total: 0, reasoning: null },
};

/**
 * A scripted one-shot call that records every request and REFUSES A FOURTH.
 *
 * The refusal is the bound, and it is here so that a planner which grew a retry
 * loop fails this file instead of hanging it. A test that hangs on broken code
 * never reports and wedges the suite, which is worse than no test at all.
 */
class ScriptedPrompt {
  readonly requests: OneShotRequest[] = [];
  #answers: OneShotResult[];

  constructor(...answers: OneShotResult[]) {
    this.#answers = answers;
  }

  readonly run = (
    _worker: AnyWorker,
    request: OneShotRequest,
  ): Promise<OneShotResult> => {
    this.requests.push(request);
    if (this.requests.length > 3) {
      throw new Error(
        `the planner made ${this.requests.length} model calls; it is documented to make exactly one`,
      );
    }
    const answer = this.#answers[this.requests.length - 1] ?? this.#answers[0];
    if (answer === undefined) {
      throw new Error("no scripted answer");
    }
    return Promise.resolve(answer);
  };
}

function replied(text: string): OneShotResult {
  return { ok: true, text, usage: NO_USAGE };
}

const GOOD_PLAN = {
  status: "plan",
  plan: {
    id: "demo",
    goal: "prove the wiring",
    slices: [
      {
        id: "s1",
        title: "the bit",
        prompt: "do the bit",
        ownedPaths: ["src/one.ts"],
        difficulty: "standard",
      },
    ],
  },
};

const TWO_SLICE_PLAN = {
  status: "plan",
  plan: {
    id: "demo",
    goal: "prove the wiring",
    slices: [
      {
        id: "s1",
        title: "first",
        prompt: "do the first bit",
        ownedPaths: ["src/one.ts"],
        difficulty: "standard",
      },
      {
        id: "s2",
        title: "second",
        prompt: "do the second bit",
        ownedPaths: ["src/two.ts"],
        difficulty: "routine",
      },
    ],
  },
};

const DEPENDENT_PLAN = {
  status: "plan",
  plan: {
    id: "dependent-demo",
    goal: "prove dependency output survives every plan boundary",
    slices: [
      {
        id: "producer",
        title: "produce the helper",
        prompt: "write the helper",
        ownedPaths: ["src/helper.ts"],
        difficulty: "standard",
      },
      {
        id: "consumer",
        title: "consume the helper",
        prompt: "use the helper output",
        ownedPaths: ["src/consumer.ts"],
        dependsOn: ["producer"],
        difficulty: "standard",
      },
    ],
  },
};

const DEPENDENCY_GUIDANCE = [
  "- Use `dependsOn` only when a slice genuinely needs another slice's committed",
  "  output. List the prerequisite slice ids; that slice will start only after all",
  "  of them commit and their output has been accumulated.",
  "- Prefer independent slices whenever possible because they run concurrently.",
  "  Every dependency serializes work. Dependencies do not permit overlapping",
  "  `ownedPaths`; every dependency id must name another slice, and dependencies",
  "  must not form a cycle.",
].join("\n");

async function planWith(
  prompt: ScriptedPrompt,
  maxSlices = 1,
  config: BrigadierConfig = CONFIG,
): Promise<PlannerOutcome> {
  const planner = createModelPlanner({
    config,
    workerFor: () => WORKER,
    env: ENV,
    log: () => {},
    runPrompt: prompt.run,
  });
  return planner.plan({ task: "fix the parser", cwd: "/repo", maxSlices });
}

/* ------------------------------------------------------------------------ */
/* The deterministic reply parser                                            */
/* ------------------------------------------------------------------------ */

describe("parsePlannerReply", () => {
  test("reads a plan reply and hands the plan object through untouched", () => {
    const reply = parsePlannerReply(JSON.stringify(GOOD_PLAN));
    expect(reply.kind).toBe("plan");
    if (reply.kind !== "plan") {
      throw new Error("unreachable");
    }
    expect(reply.plan).toEqual(GOOD_PLAN.plan);
  });

  test("accepts a plan wrapped in a fenced block with prose around it", () => {
    const reply = parsePlannerReply(
      `Here is my plan.\n\n\`\`\`json\n${JSON.stringify(GOOD_PLAN)}\n\`\`\`\n\nLet me know.`,
    );
    expect(reply.kind).toBe("plan");
  });

  test("reads a needs_human reply and trims its questions", () => {
    const reply = parsePlannerReply(
      '{"status":"needs_human","questions":["  Which parser?  ","Ship it where?"]}',
    );
    expect(reply).toEqual({
      kind: "needs-human",
      questions: ["Which parser?", "Ship it where?"],
    });
  });

  test("the last readable object wins, so a worked example does not win", () => {
    const reply = parsePlannerReply(
      `The shape is {"status":"needs_human","questions":["an example"]} and my answer is ${JSON.stringify(GOOD_PLAN)}`,
    );
    expect(reply.kind).toBe("plan");
  });

  /**
   * THE DISTINCTION THIS WHOLE FILE EXISTS FOR. A model that produced garbage
   * has not thoughtfully declined to guess, and letting garbage wear the
   * `needs_human` badge would teach a user to answer questions nobody asked.
   */
  test("an unreadable reply is unreadable, never needs-human", () => {
    for (const text of [
      "I have decided not to answer.",
      "{}",
      '{"status":"maybe"}',
      '{"status":"plan"}',
      '{"status":"plan","plan":[]}',
      '{"status":"needs_human"}',
      '{"status":"needs_human","questions":[]}',
      '{"status":"needs_human","questions":"just one"}',
      '{"status":"needs_human","questions":[42]}',
      '{"status":"needs_human","questions":["   "]}',
    ]) {
      expect(parsePlannerReply(text).kind).toBe("unreadable");
    }
  });

  test("names the exact reason an unknown status was refused", () => {
    expect(parsePlannerReply('{"status":"ask"}')).toEqual({
      kind: "unreadable",
      reason:
        'the reply used an unknown status "ask"; the only two are "plan" and "needs_human"',
    });
  });

  test("names the exact reason an empty question list was refused", () => {
    expect(
      parsePlannerReply('{"status":"needs_human","questions":[]}'),
    ).toEqual({
      kind: "unreadable",
      reason:
        'the reply said "status":"needs_human" but asked no questions, so there is nothing for a human to answer',
    });
  });

  test("names the exact reason a reply with no answer object was refused", () => {
    expect(parsePlannerReply("no json here at all")).toEqual({
      kind: "unreadable",
      reason:
        'the reply contained no JSON object with a "status" of "plan" or "needs_human"',
    });
  });

  /**
   * A question is printed to a terminal as PROSE, unlike the plan, which is
   * re-serialized through `JSON.stringify` and has its control bytes escaped
   * for free. An ESC in a question is an ANSI escape sequence the model chose
   * and the user's terminal executes.
   */
  test("a question containing an escape byte is refused, not printed", () => {
    expect(
      parsePlannerReply(
        '{"status":"needs_human","questions":["pick one\\u001b[2Jgone"]}',
      ),
    ).toEqual({
      kind: "unreadable",
      reason:
        "questions[0] contains control character U+001B, which is not permitted in text brigadier prints to a terminal",
    });
  });

  test("more than twenty questions is a refusal, never a truncation", () => {
    const questions = Array.from({ length: 21 }, (_, i) => `question ${i}`);
    expect(
      parsePlannerReply(JSON.stringify({ status: "needs_human", questions })),
    ).toEqual({
      kind: "unreadable",
      reason:
        "the reply asked 21 questions; at most 20 are accepted, because a planner with more than that has not understood the task",
    });
  });

  test("an over-long question is a refusal, never a truncation", () => {
    expect(
      parsePlannerReply(
        JSON.stringify({
          status: "needs_human",
          questions: ["q".repeat(501)],
        }),
      ),
    ).toEqual({
      kind: "unreadable",
      reason: "questions[0] is 501 characters; at most 500 are accepted",
    });
  });

  test("terminates on a huge unterminated brace run", () => {
    // `matchingBrace` allows twice the maximum work of its advancing loop. A
    // lost increment exhausts that synchronous budget and throws promptly;
    // wall-clock races cannot interrupt a loop that never yields.
    expect(parsePlannerReply("{".repeat(200_000))).toEqual({
      kind: "unreadable",
      reason:
        'the reply contained no JSON object with a "status" of "plan" or "needs_human"',
    });
  });
});

/* ------------------------------------------------------------------------ */
/* The planner                                                               */
/* ------------------------------------------------------------------------ */

describe("createModelPlanner", () => {
  test("makes exactly one bounded, read-only model call", async () => {
    const prompt = new ScriptedPrompt(replied(JSON.stringify(GOOD_PLAN)));
    const outcome = await planWith(prompt);

    expect(outcome.kind).toBe("planned");
    expect(prompt.requests).toHaveLength(1);
    const request = prompt.requests[0];
    expect(request?.cwd).toBe("/repo");
    expect(request?.vendor).toBe("claude");
    expect(request?.model).toBe("claude-opus-5");
    expect(request?.effort).toBe("high");
    expect(request?.timeoutMs).toBe(900_000);
    expect(request?.maxTurns).toBe(40);
    expect(request?.purpose).toBe("planning a task description");
  });

  test("turns a plan reply into a document and a re-runnable plan file", async () => {
    const prompt = new ScriptedPrompt(replied(JSON.stringify(GOOD_PLAN)));
    const outcome = await planWith(prompt);

    if (outcome.kind !== "planned") {
      throw new Error(`expected planned, got ${outcome.kind}`);
    }
    expect(outcome.document.plan.id).toBe("demo");
    expect(outcome.document.plan.slices.map((slice) => slice.id)).toEqual([
      "s1",
    ]);
    expect(outcome.document.directives).toEqual([
      { sliceId: "s1", difficulty: "standard" },
    ]);
    expect(outcome.planner).toEqual({
      vendor: "claude",
      model: "claude-opus-5",
      effort: "high",
    });
    // The printed JSON is a plan file `--plan` accepts: `difficulty` is rejoined
    // onto each slice, where `PlanDocument` keeps it in a parallel array.
    expect(JSON.parse(outcome.json)).toEqual(GOOD_PLAN.plan);
  });

  /**
   * FAN-OUT IS EARNED. A refusal, not a truncation, and not a
   * silent acceptance. Truncating would delete work from a plan while reporting
   * success; accepting would spend worktrees the user did not authorize.
   */
  test("refuses a plan wider than the fan-out budget and says how to allow it", async () => {
    const prompt = new ScriptedPrompt(replied(JSON.stringify(TWO_SLICE_PLAN)));
    const outcome = await planWith(prompt, 1);

    expect(outcome).toEqual({
      kind: "failed",
      message:
        "brigadier run: the planner proposed 2 slices but the fan-out budget is 1; fan-out is earned, so pass --max-workers 2 to authorize it.",
    });
  });

  test("accepts the same plan once the budget is raised to match", async () => {
    const prompt = new ScriptedPrompt(replied(JSON.stringify(TWO_SLICE_PLAN)));
    const outcome = await planWith(prompt, 2);

    if (outcome.kind !== "planned") {
      throw new Error(`expected planned, got ${outcome.kind}`);
    }
    expect(outcome.document.plan.slices).toHaveLength(2);
  });

  test("preserves a prompted dependency through parsing, plan-file round trip, and validation", async () => {
    const prompt = new ScriptedPrompt(replied(JSON.stringify(DEPENDENT_PLAN)));
    const outcome = await planWith(prompt, 2);

    expect(prompt.requests[0]?.prompt).toContain(DEPENDENCY_GUIDANCE);
    if (outcome.kind !== "planned") {
      throw new Error(`expected planned, got ${outcome.kind}`);
    }
    expect(
      outcome.document.plan.slices.map((slice) => ({
        id: slice.id,
        dependsOn: [...slice.dependsOn],
      })),
    ).toEqual([
      { id: "producer", dependsOn: [] },
      { id: "consumer", dependsOn: ["producer"] },
    ]);

    const reparsed = parsePlanDocument(JSON.parse(outcome.json));
    expect(reparsed.plan.slices[1]?.dependsOn).toEqual(["producer"]);
    expect(validatePlan(reparsed.plan)).toEqual({
      ok: true,
      waves: [["producer"], ["consumer"]],
      normalizedPaths: new Map([
        ["producer", ["src/helper.ts"]],
        ["consumer", ["src/consumer.ts"]],
      ]),
    });
  });

  test("passes a needs_human reply through as the first-class outcome", async () => {
    const prompt = new ScriptedPrompt(
      replied('{"status":"needs_human","questions":["Which parser?"]}'),
    );
    const outcome = await planWith(prompt);

    expect(outcome).toEqual({
      kind: "needs-human",
      questions: ["Which parser?"],
      planner: { vendor: "claude", model: "claude-opus-5", effort: "high" },
    });
  });

  test("an unreadable reply fails; it does not become needs-human", async () => {
    const prompt = new ScriptedPrompt(replied("I would rather not."));
    const outcome = await planWith(prompt);

    expect(outcome).toEqual({
      kind: "failed",
      message:
        'brigadier run: the claude/claude-opus-5 planner replied with something this build could not read: the reply contained no JSON object with a "status" of "plan" or "needs_human"',
    });
  });

  /**
   * THE BOUNDARY, ASSERTED. The planner's only route to a `PlanDocument` is
   * `parsePlanDocument`, so a plan the shape gate rejects never becomes one —
   * and the message is the shape gate's own issue list, not a second opinion.
   */
  test("a plan the shape gate rejects never becomes a document", async () => {
    const prompt = new ScriptedPrompt(
      replied(
        JSON.stringify({
          status: "plan",
          plan: {
            id: "demo",
            goal: "g",
            slices: [
              {
                id: "s1",
                title: "t",
                prompt: "p",
                ownedPaths: ["src/one.ts"],
              },
            ],
          },
        }),
      ),
    );
    const outcome = await planWith(prompt);

    expect(outcome).toEqual({
      kind: "failed",
      message:
        "brigadier run: the claude/claude-opus-5 planner produced a plan this build rejects (1 issue(s)): slices[0].difficulty is required and must be one of routine, standard, hard — a plan that does not say how hard a slice is has not been planned",
    });
  });

  test("a failed model call is reported as the planner's failure", async () => {
    const prompt = new ScriptedPrompt({
      ok: false,
      failure: {
        kind: "QUOTA_EXHAUSTED",
        message: "the weekly opus window is spent",
        retryable: false,
        statusCode: null,
      },
    });
    const outcome = await planWith(prompt);

    expect(outcome).toEqual({
      kind: "failed",
      message:
        "brigadier run: the claude/claude-opus-5 planner failed with QUOTA_EXHAUSTED: the weekly opus window is spent",
    });
  });

  test("reports a vendor with no adapter rather than planning without one", async () => {
    const planner = createModelPlanner({
      config: CONFIG,
      workerFor: () => null,
      env: ENV,
      log: () => {},
      runPrompt: () => {
        throw new Error("must not be reached");
      },
    });
    const outcome = await planner.plan({
      task: "fix the parser",
      cwd: "/repo",
      maxSlices: 1,
    });

    expect(outcome).toEqual({
      kind: "failed",
      message:
        'brigadier run: no worker adapter is configured for vendor "claude", so the task could not be planned.',
    });
  });

  /**
   * `xhigh` IS EARNED BY AN OBSERVED GATE FAILURE. Planning
   * happens before any gate exists to fail, so it can never have earned it.
   */
  test("caps the planner's effort at high even when the ceiling is xhigh", async () => {
    const prompt = new ScriptedPrompt(replied(JSON.stringify(GOOD_PLAN)));
    await planWith(prompt, 1, {
      ...CONFIG,
      vendors: [
        {
          vendor: "claude",
          executable: "/opt/homebrew/bin/claude",
          version: "2.0.14",
          defaultModel: "claude-opus-5",
          models: [{ id: "claude-opus-5", effortCeiling: "xhigh" }],
        },
      ],
    });

    expect(prompt.requests[0]?.effort).toBe("high");
  });
});

/* ------------------------------------------------------------------------ */
/* The prompt                                                                */
/* ------------------------------------------------------------------------ */

describe("planPrompt", () => {
  test("carries the task verbatim and never rewrites it", () => {
    const prompt = planPrompt({
      task: "make the NDJSON reader tolerate a trailing comma",
      cwd: "/repo",
      maxSlices: 1,
    });
    expect(prompt).toContain(
      "make the NDJSON reader tolerate a trailing comma",
    );
  });

  test("demands exactly one slice at the default budget", () => {
    const prompt = planPrompt({ task: "t", cwd: "/repo", maxSlices: 1 });
    expect(prompt).toContain("You must return EXACTLY ONE slice.");
    expect(prompt).not.toContain("You may return at most");
  });

  test("states the raised budget as a cap and still prefers one slice", () => {
    const prompt = planPrompt({ task: "t", cwd: "/repo", maxSlices: 4 });
    expect(prompt).toContain("You may return at most 4 slices, and you should");
    expect(prompt).toContain("return ONE unless the work genuinely splits");
  });

  test("states the exact dependency contract and its concurrency cost", () => {
    const prompt = planPrompt({ task: "t", cwd: "/repo", maxSlices: 4 });
    expect(prompt).toContain(DEPENDENCY_GUIDANCE);
  });

  /**
   * Every rule below is one `validatePlan` or `parsePlanDocument` enforces. A
   * rule the model is never told is a rule it breaks, and a broken rule costs a
   * whole planning launch.
   */
  test("teaches the rules the gates enforce", () => {
    const prompt = planPrompt({ task: "t", cwd: "/repo", maxSlices: 1 });
    for (const rule of [
      "Paths must be literal. No `*`, `?`, or `[`",
      "No absolute paths, no `..` segments, no backslashes",
      "No two slices may claim the same path",
      "every dependency id must name another slice",
      "must not form a cycle",
      "`routine`, `standard`, or `hard`",
    ]) {
      expect(prompt).toContain(rule);
    }
  });

  test("offers both reply shapes and no third one", () => {
    const prompt = planPrompt({ task: "t", cwd: "/repo", maxSlices: 1 });
    expect(prompt).toContain('{"status":"plan","plan":{');
    expect(prompt).toContain(
      '{"status":"needs_human","questions":["the first question","the second question"]}',
    );
  });
});
