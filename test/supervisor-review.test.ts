/**
 * The cross-vendor review gate and the one-shot prompt primitive underneath it.
 *
 * EVERY TEST HERE IS BOUNDED. `runOneShotPrompt` drains an event stream and
 * awaits a completion, which is exactly the shape that hangs rather than fails
 * when it is wrong, so every run in this file is raced against a timer and the
 * timer is asserted. A test that wedged the suite on broken code would be worth
 * less than no test at all.
 */

import { describe, expect, test } from "bun:test";
import type { BrigadierConfig } from "../src/config/contracts.js";
import { CONFIG_VERSION } from "../src/config/contracts.js";
import type {
  ClaudeWorkerSpec,
  CodexWorkerSpec,
  LaunchedWorkerOutcome,
  Slice,
  SpawnedWorker,
  TokenUsage,
  Vendor,
  Worker,
  WorkerEvent,
  WorkerSpec,
} from "../src/contracts.js";
import type { RoutedWorker, RoutingInput } from "../src/routing/contracts.js";
import type {
  SliceReview,
  SliceReviewRequest,
  SupervisorPorts,
} from "../src/supervisor/contracts.js";
import type { OneShotRequest } from "../src/supervisor/one-shot.js";
import { runOneShotPrompt } from "../src/supervisor/one-shot.js";
import {
  createCrossVendorReviewer,
  parseFindings,
} from "../src/supervisor/review.js";
import type { LaunchEnv } from "../src/supervisor/slice.js";
import { buildClaudeCommand } from "../src/worker/claude.js";
import { buildCodexCommand } from "../src/worker/codex.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Every promise in this file must settle well inside this. It is generous on
 * purpose — several worktrees build concurrently on this machine and wall-clock
 * bounds fail under load — while still being finite, which is the property that
 * matters: a deadlock reports as a failed assertion rather than a hung suite.
 */
const SETTLE_BOUND_MS = 5_000;

const ENV: LaunchEnv = {
  HOME: "/Users/worker",
  PATH: "/opt/brigadier/bin:/usr/bin:/bin",
  USER: "worker",
};

const SLICE: Slice = {
  id: "slice-auth",
  title: "Implement authentication",
  prompt: "Implement the authentication flow and its focused tests.",
  ownedPaths: ["src/auth.ts", "test/auth.test.ts"],
  dependsOn: [],
};

const BOTH_VENDORS: BrigadierConfig = {
  version: CONFIG_VERSION,
  vendors: [
    {
      vendor: "claude",
      executable: "/opt/claude/bin/claude",
      version: "2.1.226",
      defaultModel: "claude-opus-5",
      models: [{ id: "claude-opus-5", effortCeiling: "xhigh" }],
    },
    {
      vendor: "codex",
      executable: "/opt/codex/bin/codex",
      version: "0.145.0",
      defaultModel: "gpt-5.6-sol",
      models: [{ id: "gpt-5.6-sol", effortCeiling: "high" }],
    },
  ],
  secretsConsent: true,
  linkedSecretPaths: [],
  allowDegradedRouting: false,
};

const CLAUDE_ONLY: BrigadierConfig = {
  ...BOTH_VENDORS,
  vendors: [BOTH_VENDORS.vendors[0] as BrigadierConfig["vendors"][number]],
};

const MEDIUM_CEILING: BrigadierConfig = {
  ...BOTH_VENDORS,
  vendors: [
    BOTH_VENDORS.vendors[0] as BrigadierConfig["vendors"][number],
    {
      vendor: "codex",
      executable: "/opt/codex/bin/codex",
      version: "0.145.0",
      defaultModel: "gpt-5.6-terra",
      models: [{ id: "gpt-5.6-terra", effortCeiling: "medium" }],
    },
  ],
};

const CLAUDE_BUILDER: RoutedWorker = {
  vendor: "claude",
  model: "claude-opus-5",
  effort: "high",
  rationale: ["competence: 100"],
  waivedDifficultyFloor: false,
};

const CODEX_BUILDER: RoutedWorker = {
  vendor: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
  rationale: ["competence: 96"],
  waivedDifficultyFloor: false,
};

const USAGE: TokenUsage = {
  input: { total: 100, uncached: 100, cacheRead: 0, cacheWrite: 0 },
  output: { total: 10, reasoning: null },
};

function outcomeWith(text: string): LaunchedWorkerOutcome {
  return {
    ok: true,
    output: text,
    usage: USAGE,
    durationMs: 1234,
    exitCode: 0,
    signal: null,
  };
}

const QUOTA_FAILURE: LaunchedWorkerOutcome = {
  ok: false,
  output: "",
  usage: USAGE,
  durationMs: 12,
  exitCode: 1,
  signal: null,
  failure: {
    kind: "QUOTA_EXHAUSTED",
    message: "the weekly window is drained",
    retryable: false,
    statusCode: 429,
  },
};

function routingFor(config: BrigadierConfig): RoutingInput {
  return { config, capabilities: [], quota: [] };
}

function requestFor(
  config: BrigadierConfig,
  builder: RoutedWorker,
): SliceReviewRequest {
  return {
    slice: SLICE,
    attempt: 1,
    worktreePath: "/tmp/brigadier/slice-7",
    builder,
    routing: routingFor(config),
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface SpawnScript {
  readonly events?: readonly WorkerEvent[];
  readonly outcome?: LaunchedWorkerOutcome;
  /** Resolve `completion` only after `events` has been drained to exhaustion. */
  readonly completionAfterDrain?: boolean;
  readonly spawnError?: Error;
  readonly onEvent?: (index: number) => void;
}

interface FakeAdapter {
  readonly worker: Worker<"claude"> | Worker<"codex">;
  readonly specs: readonly WorkerSpec[];
  cancels(): number;
  drained(): boolean;
}

function fakeAdapter<V extends Vendor>(
  vendor: V,
  script: SpawnScript = {},
): FakeAdapter {
  const specs: WorkerSpec[] = [];
  let cancels = 0;
  let drained = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spawn = async (spec: WorkerSpec): Promise<SpawnedWorker> => {
    specs.push(spec);
    if (script.spawnError !== undefined) {
      throw script.spawnError;
    }
    const events: AsyncIterable<WorkerEvent> = {
      [Symbol.asyncIterator]: async function* iterate() {
        for (const [index, event] of (script.events ?? []).entries()) {
          yield event;
          script.onEvent?.(index);
        }
        drained = true;
        release();
      },
    };
    const started =
      script.completionAfterDrain === true ? gate : Promise.resolve();
    return {
      pid: 4242,
      events,
      completion: started.then(
        (): LaunchedWorkerOutcome => script.outcome ?? outcomeWith("done"),
      ),
      cancel: async () => {
        cancels += 1;
      },
    };
  };
  return {
    specs,
    cancels: () => cancels,
    drained: () => drained,
    // The cast is confined to the fake: `Worker<V>` correlates `spawn`'s
    // parameter with the vendor, and a fake that accepts the union cannot state
    // that correlation without one.
    worker: {
      vendor,
      processCompletion:
        vendor === "claude" ? "signals-then-must-be-killed" : "self-exits",
      spawn,
    } as unknown as Worker<"claude"> | Worker<"codex">,
  };
}

interface Harness {
  readonly ports: SupervisorPorts;
  readonly logs: readonly string[];
}

function makeHarness(
  workers: Partial<Record<Vendor, FakeAdapter>>,
  clockStep = 5,
): Harness {
  const logs: string[] = [];
  let clock = 1_000_000;
  return {
    logs,
    ports: {
      engine: {} as SupervisorPorts["engine"],
      workerFor: (vendor) => workers[vendor]?.worker ?? null,
      oracles: [],
      now: () => {
        clock += clockStep;
        return clock;
      },
      log: (line) => {
        logs.push(line);
      },
    },
  };
}

async function withBound<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${SETTLE_BOUND_MS} ms`));
    }, SETTLE_BOUND_MS);
  });
  try {
    return await Promise.race([work, bound]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function oneShot(overrides: Partial<OneShotRequest> = {}): OneShotRequest {
  return {
    id: "probe-1",
    vendor: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    prompt: "Read README.md and summarize it.",
    cwd: "/tmp/brigadier/slice-7",
    env: ENV,
    purpose: "a one-shot probe",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The one-shot prompt primitive
// ---------------------------------------------------------------------------

describe("runOneShotPrompt", () => {
  test("returns the worker's text and usage", async () => {
    const codex = fakeAdapter("codex", { outcome: outcomeWith("the answer") });

    const result = await withBound(
      runOneShotPrompt(codex.worker, oneShot()),
      "one-shot",
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.text : "").toBe("the answer");
    expect(result.ok ? result.usage.input.total : -1).toBe(100);
  });

  test("drains the event stream before completion can resolve", async () => {
    // THE DEADLOCK GUARD. This adapter refuses to resolve `completion` until
    // `events` has been consumed to exhaustion, which is exactly how a real
    // adapter behaves when nobody is reading the child's stdout. An
    // implementation that awaited completion first would never settle, and the
    // bound above is what turns that into a failed assertion instead of a
    // wedged suite.
    const codex = fakeAdapter("codex", {
      completionAfterDrain: true,
      events: [
        { type: "message", text: "reading", raw: {} },
        { type: "message", text: "done", raw: {} },
      ],
      outcome: outcomeWith("finished"),
    });
    const seen: WorkerEvent[] = [];

    const result = await withBound(
      runOneShotPrompt(
        codex.worker,
        oneShot({
          onEvent: (event) => {
            seen.push(event);
          },
        }),
      ),
      "one-shot",
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.text : "").toBe("finished");
    expect(codex.drained()).toBe(true);
    expect(seen.length).toBe(2);
  });

  test("an onEvent that throws cannot stop the drain", async () => {
    const codex = fakeAdapter("codex", {
      completionAfterDrain: true,
      events: [{ type: "message", text: "one", raw: {} }],
      outcome: outcomeWith("finished"),
    });

    const result = await withBound(
      runOneShotPrompt(
        codex.worker,
        oneShot({
          onEvent: () => {
            throw new Error("the caller's telemetry sink is broken");
          },
        }),
      ),
      "one-shot",
    );

    // A sink that stopped the drain would re-create the stall the drain exists
    // to prevent, and this promise would never settle.
    expect(result.ok).toBe(true);
    expect(codex.drained()).toBe(true);
  });

  test("a failed worker outcome comes back as its own failure", async () => {
    const codex = fakeAdapter("codex", { outcome: QUOTA_FAILURE });

    const result = await withBound(
      runOneShotPrompt(codex.worker, oneShot()),
      "one-shot",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.kind).toBe("QUOTA_EXHAUSTED");
    expect(result.ok ? "" : result.failure.message).toBe(
      "the weekly window is drained",
    );
  });

  test("a spawn that throws becomes a LAUNCH_FAILURE rather than a rejection", async () => {
    const codex = fakeAdapter("codex", {
      spawnError: new Error("codex is not installed"),
    });

    const result = await withBound(
      runOneShotPrompt(codex.worker, oneShot()),
      "one-shot",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.kind).toBe("LAUNCH_FAILURE");
    expect(result.ok ? "" : result.failure.message).toBe(
      "could not spawn a codex worker for a one-shot probe: codex is not installed",
    );
  });

  test("an adapter of the wrong vendor is refused rather than cast away", async () => {
    const claude = fakeAdapter("claude");

    const result = await withBound(
      runOneShotPrompt(claude.worker, oneShot({ vendor: "codex" })),
      "one-shot",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.kind).toBe("LAUNCH_FAILURE");
    expect(result.ok ? "" : result.failure.message).toBe(
      "could not spawn a codex worker for a one-shot probe: vendor mismatch: a claude adapter cannot launch a codex spec",
    );
  });

  test("an already-aborted signal spawns nothing at all", async () => {
    const codex = fakeAdapter("codex");
    const controller = new AbortController();
    controller.abort();

    const result = await withBound(
      runOneShotPrompt(codex.worker, oneShot({ signal: controller.signal })),
      "one-shot",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.kind).toBe("CANCELLED");
    expect(codex.specs).toEqual([]);
  });

  test("an abort mid-run cancels the worker's process group", async () => {
    const controller = new AbortController();
    const codex = fakeAdapter("codex", {
      // Never resolves on its own, so only the abort can end this run. The
      // bound is what stops a runner that ignores the signal from hanging.
      completionAfterDrain: true,
      events: [{ type: "message", text: "working", raw: {} }],
      onEvent: () => {
        controller.abort();
      },
    });

    const result = await withBound(
      runOneShotPrompt(codex.worker, oneShot({ signal: controller.signal })),
      "one-shot",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.kind).toBe("CANCELLED");
    expect(codex.cancels()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The read-only lane
// ---------------------------------------------------------------------------

describe("runOneShotPrompt builds a read-only lane", () => {
  test("a Claude one-shot gets no editable path, no Edit or Write, and no --allowedTools", async () => {
    const claude = fakeAdapter("claude");

    await withBound(
      runOneShotPrompt(
        claude.worker,
        oneShot({ vendor: "claude", model: "claude-opus-5" }),
      ),
      "one-shot",
    );

    const spec = claude.specs[0] as ClaudeWorkerSpec | undefined;
    expect(spec?.vendor).toBe("claude");
    expect(spec?.sandbox.filesystem.editablePaths).toEqual([]);
    expect(spec?.tools).toEqual(["Glob", "Grep", "Read"]);
    expect(spec?.cwd).toBe("/tmp/brigadier/slice-7");

    // MEASURED AGAINST THE REAL COMMAND BUILDER, not assumed. With no owned
    // path there is no `Edit`/`Write` rule to put in `--allowedTools`, and
    // `buildClaudeCommand` omits the flag entirely rather than emitting it
    // empty — which is what makes an empty lane a well-formed command line
    // instead of a malformed one. Verified against claude 2.1.226, where this
    // exact shape read a file through `Read` and returned findings.
    const command = buildClaudeCommand(spec as ClaudeWorkerSpec, "claude");
    expect(command).not.toContain("--allowedTools");
    expect(command).toContain("--tools");
    expect(command[command.indexOf("--tools") + 1]).toBe("Glob,Grep,Read");
  });

  test("a Codex one-shot gets a lane profile with no write entry at all", async () => {
    const codex = fakeAdapter("codex");

    await withBound(runOneShotPrompt(codex.worker, oneShot()), "one-shot");

    const spec = codex.specs[0] as CodexWorkerSpec | undefined;
    expect(spec?.vendor).toBe("codex");
    expect(spec?.sandbox.filesystem.editablePaths).toEqual([]);

    // The lane arrives as ONE argv element (`-c` then `key=value`), so it is
    // found by prefix rather than by an exact-match index. An index lookup on
    // the bare key silently returns -1 and reads the wrong element, which is
    // how this assertion passed against nothing on its first draft.
    const command = buildCodexCommand(spec as CodexWorkerSpec, "codex");
    const profile = command.find((argument) =>
      argument.startsWith("permissions.brigadier_lane="),
    );
    expect(profile).toBe(
      'permissions.brigadier_lane={filesystem={":root"="read",":workspace_roots"={"."="read"}},network={enabled=false}}',
    );
    // No `"write"` entry anywhere in the profile: that single word is the
    // difference between a reviewer and a second builder.
    expect(profile).not.toContain('="write"');
  });

  test("the prompt reaches the spec and the bounds are applied", async () => {
    const codex = fakeAdapter("codex");

    await withBound(
      runOneShotPrompt(
        codex.worker,
        oneShot({
          prompt: "the exact question",
          maxTurns: 40,
          timeoutMs: 900_000,
        }),
      ),
      "one-shot",
    );

    const spec = codex.specs[0];
    expect(spec?.maxTurns).toBe(40);
    expect(spec?.timeoutMs).toBe(900_000);
    expect(spec?.id).toBe("probe-1");
    // The lane sentence still leads, because a read-only worker being told it
    // may edit nothing is true and worth saying.
    expect(spec?.prompt).toBe(
      "You may edit no files. This is a read-only task.\n\nthe exact question",
    );
  });
});

// ---------------------------------------------------------------------------
// Parsing a reviewer's reply
// ---------------------------------------------------------------------------

describe("parseFindings", () => {
  test("reads a bare object on its own line", () => {
    expect(
      parseFindings(
        'Here is my review.\n{"findings":[{"severity":"blocking","path":"a.ts","line":3,"summary":"off by one"}]}',
      ),
    ).toEqual([
      {
        severity: "blocking",
        path: "a.ts",
        line: 3,
        summary: "off by one",
      },
    ]);
  });

  test("reads an object inside a fenced block", () => {
    // MEASURED: claude 2.1.226 wrapped its answer in a ```json fence even
    // though the prompt asked for a bare object. A parser that only accepted
    // the bare form would have reported every Claude review as unreadable.
    const reply = [
      "I reviewed the file.",
      "",
      "```json",
      '{"findings":[{"severity":"concern","path":"b.ts","line":9,"summary":"unclear"}]}',
      "```",
    ].join("\n");
    expect(parseFindings(reply)).toEqual([
      { severity: "concern", path: "b.ts", line: 9, summary: "unclear" },
    ]);
  });

  test("an empty findings array is a clean review, not an unreadable one", () => {
    expect(parseFindings('all good\n{"findings":[]}')).toEqual([]);
  });

  test("the last matching object wins", () => {
    // A reviewer that echoes the required shape before answering emits two
    // parseable objects. The answer is the later one.
    const reply = [
      'I will reply as {"findings":[{"severity":"blocking","path":"x","line":1,"summary":"example"}]}.',
      "",
      '{"findings":[]}',
    ].join("\n");
    expect(parseFindings(reply)).toEqual([]);
  });

  test("a brace inside a string does not confuse the scan", () => {
    expect(
      parseFindings(
        '{"findings":[{"severity":"blocking","path":"a.ts","line":1,"summary":"the literal {\\"x\\": 1} is wrong"}]}',
      ),
    ).toEqual([
      {
        severity: "blocking",
        path: "a.ts",
        line: 1,
        summary: 'the literal {"x": 1} is wrong',
      },
    ]);
  });

  test("a missing path or line becomes null rather than an invention", () => {
    expect(
      parseFindings(
        '{"findings":[{"severity":"concern","summary":"general"}]}',
      ),
    ).toEqual([
      { severity: "concern", path: null, line: null, summary: "general" },
    ]);
  });

  test("an unrecognised severity makes the whole reply unreadable", () => {
    // Neither mapped up nor mapped down. Mapping `critical` onto `blocking`
    // would be brigadier deciding a slice failed on a word the contract never
    // offered; mapping it onto `concern` would silently discard a real defect.
    expect(
      parseFindings(
        '{"findings":[{"severity":"critical","path":"a.ts","line":1,"summary":"bad"}]}',
      ),
    ).toBe(null);
  });

  test("a findings entry with no summary makes the whole reply unreadable", () => {
    expect(
      parseFindings('{"findings":[{"severity":"blocking","path":"a.ts"}]}'),
    ).toBe(null);
  });

  test("a reply with no findings block at all is unreadable", () => {
    expect(parseFindings("The code looks fine to me.")).toBe(null);
    expect(parseFindings('{"verdict":"ok"}')).toBe(null);
    expect(parseFindings('{"findings":"none"}')).toBe(null);
    expect(parseFindings("")).toBe(null);
  });

  test("severity matching tolerates case and surrounding space", () => {
    expect(
      parseFindings(
        '{"findings":[{"severity":" Blocking ","path":null,"line":null,"summary":" trimmed "}]}',
      ),
    ).toEqual([
      { severity: "blocking", path: null, line: null, summary: "trimmed" },
    ]);
  });

  test("terminates on a large adversarial reply", async () => {
    // A parser that backtracked would take superlinear time on this input. The
    // bound is asserted rather than assumed: a scan that did not terminate
    // would fail here rather than wedge the suite.
    const noise = `${"{".repeat(20_000)}\n`;
    const reply = `${noise}{"findings":[]}`;
    await withBound(
      Promise.resolve().then(() => {
        expect(parseFindings(reply)).toEqual([]);
      }),
      "parse",
    );
  });
});

// ---------------------------------------------------------------------------
// Choosing the reviewer, and adjudicating what it says
// ---------------------------------------------------------------------------

describe("createCrossVendorReviewer", () => {
  async function review(
    config: BrigadierConfig,
    builder: RoutedWorker,
    workers: Partial<Record<Vendor, FakeAdapter>>,
  ): Promise<{ readonly review: SliceReview; readonly harness: Harness }> {
    const harness = makeHarness(workers);
    const reviewer = createCrossVendorReviewer({
      ports: harness.ports,
      env: ENV,
    });
    const result = await withBound(
      reviewer.review(requestFor(config, builder)),
      "review",
    );
    return { review: result, harness };
  }

  test("a Claude-built slice is reviewed by Codex", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    const { review: verdict } = await review(BOTH_VENDORS, CLAUDE_BUILDER, {
      codex,
    });

    expect(verdict.verdict).toBe("approved");
    expect(verdict.reviewer?.vendor).toBe("codex");
    expect(verdict.reviewer?.model).toBe("gpt-5.6-sol");
    expect(codex.specs.length).toBe(1);
  });

  test("a Codex-built slice is reviewed by Claude", async () => {
    // THE OTHER DIRECTION, AND IT IS NOT SYMMETRY FOR ITS OWN SAKE. A gate that
    // only ever ran one vendor against the other would leave half the product's
    // claim untested, and the two vendors take different lane grammars and
    // different tool lists to get there.
    const claude = fakeAdapter("claude", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    const { review: verdict } = await review(BOTH_VENDORS, CODEX_BUILDER, {
      claude,
    });

    expect(verdict.verdict).toBe("approved");
    expect(verdict.reviewer?.vendor).toBe("claude");
    expect(verdict.reviewer?.model).toBe("claude-opus-5");
    expect(claude.specs.length).toBe(1);
  });

  test("a blocking finding rejects the slice and keeps every finding", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith(
        '{"findings":[{"severity":"concern","path":"a.ts","line":1,"summary":"unclear name"},{"severity":"blocking","path":"src/auth.ts","line":42,"summary":"the token is never verified"}]}',
      ),
    });

    const { review: verdict } = await review(BOTH_VENDORS, CLAUDE_BUILDER, {
      codex,
    });

    expect(verdict.verdict).toBe("rejected");
    expect(verdict.verdict === "rejected" ? verdict.findings : []).toEqual([
      { severity: "concern", path: "a.ts", line: 1, summary: "unclear name" },
      {
        severity: "blocking",
        path: "src/auth.ts",
        line: 42,
        summary: "the token is never verified",
      },
    ]);
  });

  test("concerns alone approve the slice", async () => {
    // ONE FINDING IN TEN IS A FALSE POSITIVE HERE, so a gate that blocked on
    // every finding would reject nearly everything and be turned off. The
    // reviewer separates confidence from interest and only the first blocks.
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith(
        '{"findings":[{"severity":"concern","path":"a.ts","line":1,"summary":"worth a look"}]}',
      ),
    });

    const { review: verdict } = await review(BOTH_VENDORS, CLAUDE_BUILDER, {
      codex,
    });

    expect(verdict.verdict).toBe("approved");
    expect(verdict.verdict === "approved" ? verdict.findings.length : 0).toBe(
      1,
    );
  });

  test("a single-vendor install skips with NO_OTHER_VENDOR and names no reviewer", async () => {
    const { review: verdict } = await review(CLAUDE_ONLY, CLAUDE_BUILDER, {});

    expect(verdict.verdict).toBe("skipped");
    expect(verdict.verdict === "skipped" ? verdict.reason : null).toBe(
      "NO_OTHER_VENDOR",
    );
    expect(verdict.reviewer).toBe(null);
    expect(verdict.verdict === "skipped" ? verdict.message : "").toBe(
      "slice slice-auth was built by claude and no other vendor is configured, so no cross-vendor review was possible",
    );
  });

  test("a configured vendor with no adapter skips with NO_ADAPTER", async () => {
    const { review: verdict } = await review(BOTH_VENDORS, CLAUDE_BUILDER, {});

    expect(verdict.verdict).toBe("skipped");
    expect(verdict.verdict === "skipped" ? verdict.reason : null).toBe(
      "NO_ADAPTER",
    );
    // The reviewer is still named: the config says who SHOULD have reviewed it,
    // and that is the fact an operator needs to fix the install.
    expect(verdict.reviewer?.vendor).toBe("codex");
  });

  test("a reviewer whose own worker failed skips with REVIEWER_FAILED", async () => {
    const codex = fakeAdapter("codex", { outcome: QUOTA_FAILURE });

    const { review: verdict } = await review(BOTH_VENDORS, CLAUDE_BUILDER, {
      codex,
    });

    // FAIL-OPEN, AND BLAMED CORRECTLY. A reviewer out of quota has formed no
    // opinion about anybody's code; reporting this as a rejection would send a
    // user hunting a bug that does not exist.
    expect(verdict.verdict).toBe("skipped");
    expect(verdict.verdict === "skipped" ? verdict.reason : null).toBe(
      "REVIEWER_FAILED",
    );
    expect(verdict.verdict === "skipped" ? verdict.message : "").toBe(
      "slice slice-auth was not reviewed: the codex/gpt-5.6-sol reviewer failed with QUOTA_EXHAUSTED: the weekly window is drained",
    );
  });

  test("an unparseable reply skips with UNREADABLE_RESPONSE rather than approving", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith("Looks fine to me, ship it."),
    });

    const { review: verdict } = await review(BOTH_VENDORS, CLAUDE_BUILDER, {
      codex,
    });

    // The dangerous reading of this reply is "approved". It is not: nothing
    // here can tell an approval from a reviewer that misunderstood the task.
    expect(verdict.verdict).toBe("skipped");
    expect(verdict.verdict === "skipped" ? verdict.reason : null).toBe(
      "UNREADABLE_RESPONSE",
    );
  });

  test("the reviewer's effort is capped at high even when its ceiling is xhigh", async () => {
    // Decision #20: `xhigh` is earned by an observed gate failure, and the gate
    // is the thing that observes one — it can never itself have earned the rung.
    const claude = fakeAdapter("claude", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    const { review: verdict } = await review(BOTH_VENDORS, CODEX_BUILDER, {
      claude,
    });

    expect(verdict.reviewer?.effort).toBe("high");
    expect(claude.specs[0]?.effort).toBe("high");
  });

  test("a medium-ceiling reviewer reviews at medium", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    const { review: verdict } = await review(MEDIUM_CEILING, CLAUDE_BUILDER, {
      codex,
    });

    expect(verdict.reviewer?.model).toBe("gpt-5.6-terra");
    expect(verdict.reviewer?.effort).toBe("medium");
  });

  test("the prompt names the task, the owned paths, and both severities", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    await review(BOTH_VENDORS, CLAUDE_BUILDER, { codex });

    const prompt = codex.specs[0]?.prompt ?? "";
    expect(prompt).toContain(
      "# The task they were given (slice-auth: Implement authentication)",
    );
    expect(prompt).toContain(
      "Implement the authentication flow and its focused tests.",
    );
    // There is no diff before the commit, so the owned paths are how the
    // reviewer is told what to read.
    expect(prompt).toContain("- src/auth.ts\n- test/auth.test.ts");
    expect(prompt).toContain('{"findings":[]}');
    // A CORRECTNESS REVIEW, NEVER AN ATTACK. An adversarial framing is rejected
    // outright by OpenAI's classifier, which would turn every Codex review into
    // a refusal and — because the gate fails open — into a silently skipped
    // gate on every Claude-built slice.
    expect(prompt).toContain(
      "You are reviewing a code change for correctness.",
    );
    expect(prompt).not.toContain("break");
    expect(prompt).not.toContain("attack");
  });

  test("the reviewer reads the builder's uncommitted worktree", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    await review(BOTH_VENDORS, CLAUDE_BUILDER, { codex });

    expect(codex.specs[0]?.cwd).toBe("/tmp/brigadier/slice-7");
    expect(codex.specs[0]?.sandbox.filesystem.editablePaths).toEqual([]);
  });
});
