/**
 * The cross-vendor review gate and the one-shot prompt primitive underneath it.
 *
 * EVERY TEST HERE IS BOUNDED. `runOneShotPrompt` drains an event stream and
 * awaits a completion, so its asynchronous runs are raced against an asserted
 * timer. The synchronous reply parser instead enforces an input-proportional
 * step budget inside its scan, because a timer cannot preempt a synchronous
 * loop. A test that wedged the suite on broken code would be worth less than no
 * test at all.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { shutdownProcessGroup } from "../src/shared/process.js";
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
import { DefaultSliceRunner } from "../src/supervisor/slice.js";
import { buildClaudeCommand } from "../src/worker/claude.js";
import { buildCodexCommand } from "../src/worker/codex.js";
import type {
  CreatedWorktree,
  UncommittedDiff,
  UncommittedDiffSpec,
} from "../src/worktree/contracts.js";

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

const UNKNOWN_SHUTDOWN_OUTCOME: LaunchedWorkerOutcome = {
  ok: false,
  output: "",
  usage: USAGE,
  durationMs: 0,
  exitCode: null,
  signal: null,
  failure: {
    kind: "UNKNOWN_FAILURE",
    message: "process group 4242 survived SIGKILL",
    retryable: false,
    statusCode: null,
  },
};

function routingFor(config: BrigadierConfig): RoutingInput {
  return { config, capabilities: [], quota: [] };
}

function requestFor(
  config: BrigadierConfig,
  builder: RoutedWorker,
): SliceReviewRequest {
  const worktree: CreatedWorktree = {
    repositoryPath: "/tmp/repository",
    path: "/tmp/brigadier/slice-7",
    branch: "brigadier/review/slice-7",
    isolated: true,
    session: {
      repositoryPath: "/tmp/repository",
      slug: "review",
      baseCommit: "0".repeat(40),
      baseBranch: "brigadier/review/base",
      integrationBranch: "brigadier/review/integration",
    },
  };
  return {
    slice: SLICE,
    attempt: 1,
    worktree,
    worktreePath: worktree.path,
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

/**
 * A `WorktreeEngine` that answers `diffUncommitted` and nothing else.
 *
 * `diff` is what the engine returns; a thrown value is what it rejects with;
 * `null` models an engine that does not implement the method at all, which is
 * the shape of every other fake `WorktreeEngine` in this suite and of any
 * consumer-supplied one.
 */
interface FakeEngine {
  readonly engine: SupervisorPorts["engine"];
  readonly specs: readonly UncommittedDiffSpec[];
}

function fakeEngine(
  answer: UncommittedDiff | Error | null,
  redactionValues: readonly string[] = [],
): FakeEngine {
  const specs: UncommittedDiffSpec[] = [];
  const redact = (_worktree: CreatedWorktree, artifact: string): string => {
    let redacted = artifact;
    for (const value of redactionValues) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
    return redacted;
  };
  if (answer === null) {
    return {
      engine: { redact } as SupervisorPorts["engine"],
      specs,
    };
  }
  return {
    specs,
    engine: {
      redact,
      diffUncommitted: async (spec: UncommittedDiffSpec) => {
        specs.push(spec);
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
    } as unknown as SupervisorPorts["engine"],
  };
}

function plainDiff(patch: string): UncommittedDiff {
  return {
    paths: patch === "" ? [] : ["src/auth.ts", "test/auth.test.ts"],
    patch,
    truncated: false,
    totalCharacters: patch.length,
  };
}

const DEFAULT_PATCH = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1 +1 @@",
  "-export const verified = false;",
  "+export const verified = true;",
  "",
].join("\n");

interface Harness {
  readonly ports: SupervisorPorts;
  readonly logs: readonly string[];
  readonly logCalls: readonly {
    readonly line: string;
    readonly level: "normal" | "verbose" | undefined;
  }[];
}

function makeHarness(
  workers: Partial<Record<Vendor, FakeAdapter>>,
  engine: SupervisorPorts["engine"] = fakeEngine(
    plainDiff(DEFAULT_PATCH),
  ).engine,
  clockStep = 5,
): Harness {
  const logs: string[] = [];
  const logCalls: {
    line: string;
    level: "normal" | "verbose" | undefined;
  }[] = [];
  let clock = 1_000_000;
  return {
    logs,
    logCalls,
    ports: {
      engine,
      workerFor: (vendor) => workers[vendor]?.worker ?? null,
      oracles: [],
      now: () => {
        clock += clockStep;
        return clock;
      },
      log: (line, level) => {
        logs.push(line);
        logCalls.push({ line, level });
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

async function waitForFileContents(path: string): Promise<string> {
  const deadline = performance.now() + SETTLE_BOUND_MS;
  while (true) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    if (performance.now() >= deadline) {
      throw new Error(`creation of ${path} did not settle`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

async function waitForProcessToExit(pid: number, label: string): Promise<void> {
  const deadline = performance.now() + SETTLE_BOUND_MS;
  while (isProcessAlive(pid)) {
    if (performance.now() >= deadline) {
      throw new Error(`${label} did not exit within ${SETTLE_BOUND_MS} ms`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

  test("a resolved cancel reports an UNKNOWN_FAILURE completion with the pid", async () => {
    const controller = new AbortController();
    const codex = fakeAdapter("codex", {
      completionAfterDrain: true,
      outcome: UNKNOWN_SHUTDOWN_OUTCOME,
      events: [{ type: "message", text: "working", raw: {} }],
      onEvent: () => {
        controller.abort();
      },
    });

    const result = await withBound(
      runOneShotPrompt(codex.worker, oneShot({ signal: controller.signal })),
      "unconfirmed one-shot cancellation",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.message).toBe(
      "a one-shot probe was cancelled while codex/gpt-5.6-sol was running; the codex/gpt-5.6-sol worker (pid 4242) may still be running — termination was not confirmed because completion settled with UNKNOWN_FAILURE: process group 4242 survived SIGKILL",
    );
    expect(result.ok ? undefined : result.cleanupFailure).toBe(
      "the codex/gpt-5.6-sol worker (pid 4242) may still be running — termination was not confirmed because completion settled with UNKNOWN_FAILURE: process group 4242 survived SIGKILL",
    );
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
        source: "model",
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
      {
        source: "model",
        severity: "concern",
        path: "b.ts",
        line: 9,
        summary: "unclear",
      },
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
        source: "model",
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
      {
        source: "model",
        severity: "concern",
        path: null,
        line: null,
        summary: "general",
      },
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
      {
        source: "model",
        severity: "blocking",
        path: null,
        line: null,
        summary: "trimmed",
      },
    ]);
  });

  test("terminates on a large adversarial reply", () => {
    // `matchingBrace` allows twice the maximum work of its advancing loop. A
    // lost increment exhausts that synchronous budget and throws promptly;
    // wall-clock races cannot interrupt a loop that never yields.
    const noise = `${"{".repeat(20_000)}\n`;
    const reply = `${noise}{"findings":[]}`;
    expect(parseFindings(reply)).toEqual([]);
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
    engine?: SupervisorPorts["engine"],
  ): Promise<{ readonly review: SliceReview; readonly harness: Harness }> {
    const harness = makeHarness(workers, engine);
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
      {
        source: "model",
        severity: "concern",
        path: "a.ts",
        line: 1,
        summary: "unclear name",
      },
      {
        source: "model",
        severity: "blocking",
        path: "src/auth.ts",
        line: 42,
        summary: "the token is never verified",
      },
    ]);
  });

  test("a blocking deterministic gate rejects before launching the model reviewer", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });
    const engine = fakeEngine({
      paths: ["src/auth.ts", "test/auth.test.ts", "outside.ts"],
      patch: DEFAULT_PATCH,
      truncated: false,
      totalCharacters: DEFAULT_PATCH.length,
    });

    const { review: verdict } = await review(
      BOTH_VENDORS,
      CLAUDE_BUILDER,
      { codex },
      engine.engine,
    );

    expect(verdict.verdict).toBe("rejected");
    expect(codex.specs).toEqual([]);
    expect(verdict.reviewer).toEqual({
      vendor: "deterministic",
      model: "gates",
      effort: null,
    });
    expect(
      verdict.verdict === "rejected" ? verdict.findings : [],
    ).toContainEqual({
      source: "gate",
      gate: "paths_owned",
      severity: "blocking",
      path: "outside.ts",
      line: null,
      summary:
        'Path "outside.ts" is outside the slice\'s declared owned paths.',
    });
  });

  test("aborting a configured test gate terminates its child and reports the gate as skipped", async () => {
    const root = await mkdtemp(join(tmpdir(), "brigadier-gate-abort-"));
    const readyPath = join(root, "gate.pid");
    const controller = new AbortController();
    let childPid: number | null = null;
    try {
      const codex = fakeAdapter("codex", {
        outcome: outcomeWith('{"findings":[]}'),
      });
      const engine = fakeEngine(plainDiff(DEFAULT_PATCH), [SLICE.id]);
      const harness = makeHarness({ codex }, engine.engine);
      const reviewer = createCrossVendorReviewer({
        ports: harness.ports,
        env: ENV,
      });
      const baseRequest = requestFor(BOTH_VENDORS, CLAUDE_BUILDER);
      const reviewPromise = reviewer.review({
        ...baseRequest,
        worktree: {
          ...baseRequest.worktree,
          path: root,
        },
        worktreePath: root,
        testCommand: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
        ],
        signal: controller.signal,
      });

      childPid = Number(
        await withBound(
          waitForFileContents(readyPath),
          "configured test gate startup",
        ),
      );
      expect(Number.isInteger(childPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);

      controller.abort();
      const verdict = await withBound(
        reviewPromise,
        "aborted test gate review",
      );
      const testGate = verdict.gates?.find(
        (gate) => gate.name === "tests_pass",
      );
      expect(verdict.verdict).toBe("skipped");
      expect(verdict.verdict === "skipped" ? verdict.reason : null).toBe(
        "CANCELLED",
      );
      expect(verdict.verdict === "skipped" ? verdict.message : "").toContain(
        "[REDACTED]",
      );
      expect(
        verdict.verdict === "skipped" ? verdict.cleanupFailure : undefined,
      ).toBeUndefined();
      expect(codex.specs).toEqual([]);
      expect(testGate?.status).toBe("skipped");
      expect(testGate?.status === "skipped" ? testGate.reason : null).toBe(
        "The gate could not run: The gate command was aborted.",
      );
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      controller.abort();
      if (childPid !== null && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      if (existsSync(root)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("a failed abort-time gate shutdown reports the surviving process without changing cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "brigadier-gate-leak-"));
    const readyPath = join(root, "gate.pid");
    const controller = new AbortController();
    const cleanupSecret = "private-shutdown-detail";
    const shutdownPids: number[] = [];
    let childPid: number | null = null;
    try {
      const codex = fakeAdapter("codex", {
        outcome: outcomeWith('{"findings":[]}'),
      });
      const engine = fakeEngine(plainDiff(DEFAULT_PATCH), [
        SLICE.id,
        cleanupSecret,
      ]);
      const harness = makeHarness({ codex }, engine.engine);
      const reviewer = createCrossVendorReviewer({
        ports: harness.ports,
        env: ENV,
        shutdownGateProcessGroup: async (pid) => {
          shutdownPids.push(pid);
          // Kill the fixture for real, then deterministically exercise the
          // supported rejection path without leaving a process behind in CI.
          await shutdownProcessGroup(pid);
          throw new Error(cleanupSecret);
        },
      });
      const baseRequest = requestFor(BOTH_VENDORS, CLAUDE_BUILDER);
      const reviewPromise = reviewer.review({
        ...baseRequest,
        worktree: { ...baseRequest.worktree, path: root },
        worktreePath: root,
        testCommand: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
        ],
        signal: controller.signal,
      });

      childPid = Number(
        await withBound(
          waitForFileContents(readyPath),
          "configured leaking test gate startup",
        ),
      );
      controller.abort();

      const verdict = await withBound(
        reviewPromise,
        "test gate review with failed shutdown",
      );
      expect(verdict.verdict).toBe("skipped");
      expect(verdict.verdict === "skipped" ? verdict.reason : null).toBe(
        "CANCELLED",
      );
      expect(
        verdict.verdict === "skipped" ? verdict.cleanupFailure : null,
      ).toBe(
        `slice [REDACTED] attempt 1: the configured tests_pass gate process group (pid ${childPid}) may still be running — [REDACTED]`,
      );
      expect(shutdownPids).toEqual([childPid]);
      expect(codex.specs).toEqual([]);
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      controller.abort();
      if (childPid !== null && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an abort during a configured gate cancels the slice and never commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "brigadier-slice-gate-abort-"));
    const readyPath = join(root, "gate.pid");
    const controller = new AbortController();
    let gatePid: number | null = null;
    let commits = 0;
    const session = {
      repositoryPath: root,
      slug: "gate-abort",
      baseCommit: "0".repeat(40),
      baseBranch: "brigadier/gate-abort/base",
      integrationBranch: "brigadier/gate-abort/integration",
    };
    const engine: SupervisorPorts["engine"] = {
      prepare: async () => session,
      create: async (spec) => {
        const path = spec.path ?? root;
        await mkdir(path, { recursive: true });
        return {
          repositoryPath: root,
          path,
          branch: "brigadier/gate-abort/slice-1",
          isolated: true,
          session,
        };
      },
      commit: async (spec) => {
        commits += 1;
        return { commit: "commit-that-must-not-exist", message: spec.message };
      },
      diffUncommitted: async () => plainDiff(DEFAULT_PATCH),
      merge: async () => {
        throw new Error("the slice runner must not merge");
      },
      redact: (_worktree, artifact) => artifact,
      remove: async () => undefined,
      release: async () => undefined,
    };
    const claude = fakeAdapter("claude", { outcome: outcomeWith("done") });
    const harness = makeHarness({ claude }, engine);
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: () => ({ ok: true, routed: CLAUDE_BUILDER }),
    });

    try {
      const resultPromise = runner.run({
        slice: SLICE,
        directive: { sliceId: SLICE.id, difficulty: "standard" },
        session,
        attemptSlots: [{ sliceNumber: 1, worktreePath: root }],
        routing: routingFor(CLAUDE_ONLY),
        unsafeInPlace: false,
        testCommand: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
        ],
        signal: controller.signal,
      });

      gatePid = Number(
        await withBound(
          waitForFileContents(readyPath),
          "slice test gate startup",
        ),
      );
      expect(isProcessAlive(gatePid)).toBe(true);
      controller.abort();

      const result = await withBound(resultPromise, "cancelled slice");
      expect(result.ok).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.commit).toBe(null);
      expect(result.attempts[0]?.review?.verdict).toBe("skipped");
      expect(
        result.attempts[0]?.review?.verdict === "skipped"
          ? result.attempts[0].review.reason
          : null,
      ).toBe("CANCELLED");
      expect(commits).toBe(0);
      expect(isProcessAlive(gatePid)).toBe(false);
    } finally {
      controller.abort();
      if (gatePid !== null && isProcessAlive(gatePid)) {
        process.kill(gatePid, "SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a successful test gate reaps background descendants without changing its verdict", async () => {
    const root = await mkdtemp(join(tmpdir(), "brigadier-gate-descendant-"));
    const readyPath = join(root, "descendant.pid");
    let descendantPid: number | null = null;
    try {
      const engine = fakeEngine(plainDiff(DEFAULT_PATCH));
      const harness = makeHarness({}, engine.engine);
      const reviewer = createCrossVendorReviewer({
        ports: harness.ports,
        env: ENV,
      });
      const baseRequest = requestFor(CLAUDE_ONLY, CLAUDE_BUILDER);
      const verdict = await withBound(
        reviewer.review({
          ...baseRequest,
          worktree: { ...baseRequest.worktree, path: root },
          worktreePath: root,
          testCommand: [
            process.execPath,
            "-e",
            `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, String(child.pid)); child.unref();`,
          ],
        }),
        "successful test gate review",
      );

      descendantPid = Number(await waitForFileContents(readyPath));
      expect(verdict.verdict).toBe("skipped");
      expect(verdict.verdict === "skipped" ? verdict.reason : null).toBe(
        "NO_OTHER_VENDOR",
      );
      expect(
        verdict.gates?.find((gate) => gate.name === "tests_pass")?.status,
      ).toBe("passed");
      await waitForProcessToExit(descendantPid, "background gate descendant");
      expect(isProcessAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid !== null && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a paths_touched concern alone still launches the model reviewer", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });
    const engine = fakeEngine({
      paths: ["src/auth.ts"],
      patch: DEFAULT_PATCH,
      truncated: false,
      totalCharacters: DEFAULT_PATCH.length,
    });

    const { review: verdict } = await review(
      BOTH_VENDORS,
      CLAUDE_BUILDER,
      { codex },
      engine.engine,
    );

    expect(verdict.verdict).toBe("approved");
    expect(codex.specs.length).toBe(1);
    expect(
      verdict.verdict === "approved" ? verdict.findings : [],
    ).toContainEqual({
      source: "gate",
      gate: "paths_touched",
      severity: "concern",
      path: "test/auth.test.ts",
      line: null,
      summary: 'Owned path "test/auth.test.ts" was not changed.',
    });
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

  test("redacts task metadata before it reaches the reviewer", async () => {
    const secret = "sk-live-outbound-4815162342";
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });
    const engine = fakeEngine(
      {
        paths: [`src/${secret}.ts`],
        patch: DEFAULT_PATCH,
        truncated: false,
        totalCharacters: DEFAULT_PATCH.length,
      },
      [secret],
    );
    const harness = makeHarness({ codex }, engine.engine);
    const reviewer = createCrossVendorReviewer({
      ports: harness.ports,
      env: ENV,
    });
    const request = requestFor(BOTH_VENDORS, CLAUDE_BUILDER);

    await withBound(
      reviewer.review({
        ...request,
        slice: {
          id: `slice-${secret}`,
          title: `Implement ${secret}`,
          prompt: `Use ${secret} in the authentication flow.`,
          ownedPaths: [`src/${secret}.ts`],
          dependsOn: [],
        },
      }),
      "redacted outbound review",
    );

    const prompt = codex.specs[0]?.prompt ?? "";
    expect(prompt).not.toContain(secret);
    expect(prompt).toContain(
      "# The task they were given (slice-[REDACTED]: Implement [REDACTED])",
    );
    expect(prompt).toContain("Use [REDACTED] in the authentication flow.");
    expect(prompt).toContain("- src/[REDACTED].ts");
    const logArtifact = harness.logs.join("\n");
    expect(logArtifact).not.toContain(secret);
    expect(logArtifact).toContain(
      "slice slice-[REDACTED] attempt 1: reviewing claude/claude-opus-5's work with codex/gpt-5.6-sol at high effort",
    );
  });

  test("redacts reviewer-returned paths and summaries in the review artifact", async () => {
    const secret = "sk-live-inbound-10815";
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith(
        `{"findings":[{"severity":"blocking","path":"config/${secret}.ts","line":17,"summary":"hard-coded ${secret}"}]}`,
      ),
    });
    const engine = fakeEngine(plainDiff(DEFAULT_PATCH), [secret]);
    const harness = makeHarness({ codex }, engine.engine);
    const reviewer = createCrossVendorReviewer({
      ports: harness.ports,
      env: ENV,
    });

    const verdict = await withBound(
      reviewer.review(requestFor(BOTH_VENDORS, CLAUDE_BUILDER)),
      "redacted inbound review",
    );

    const artifact = JSON.stringify(verdict);
    expect(artifact).not.toContain(secret);
    expect(verdict.verdict === "rejected" ? verdict.findings : []).toEqual([
      {
        source: "model",
        severity: "blocking",
        path: "config/[REDACTED].ts",
        line: 17,
        summary: "hard-coded [REDACTED]",
      },
    ]);
  });

  test("redacts gate-returned paths and summaries before SliceReview", async () => {
    const secret = "sk-live-gate-815";
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });
    const engine = fakeEngine(
      {
        paths: ["src/auth.ts", "test/auth.test.ts", `outside/${secret}.ts`],
        patch: DEFAULT_PATCH,
        truncated: false,
        totalCharacters: DEFAULT_PATCH.length,
      },
      [secret],
    );

    const { review: verdict } = await review(
      BOTH_VENDORS,
      CLAUDE_BUILDER,
      { codex },
      engine.engine,
    );

    const artifact = JSON.stringify(verdict);
    expect(artifact).not.toContain(secret);
    expect(artifact).toContain("outside/[REDACTED].ts");
    expect(codex.specs).toEqual([]);
  });

  test("the reviewer reads the builder's uncommitted worktree", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    await review(BOTH_VENDORS, CLAUDE_BUILDER, { codex });

    expect(codex.specs[0]?.cwd).toBe("/tmp/brigadier/slice-7");
    expect(codex.specs[0]?.sandbox.filesystem.editablePaths).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The change, and the scope of the verdict on it
  // -------------------------------------------------------------------------

  test("the prompt carries the diff of the change and asks for the diff of this worktree", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });
    const engine = fakeEngine(plainDiff(DEFAULT_PATCH));

    await review(BOTH_VENDORS, CLAUDE_BUILDER, { codex }, engine.engine);

    // The diff is asked for by the path the gate was handed, under the gate's
    // own bound — not the engine's, and not an unbounded read.
    expect(engine.specs).toEqual([
      { worktreePath: "/tmp/brigadier/slice-7", maxCharacters: 98304 },
    ]);
    const prompt = codex.specs[0]?.prompt ?? "";
    expect(prompt).toContain(
      [
        "# The change they made",
        "",
        "The unified diff below is exactly what will be committed if you approve",
        "it. Nothing outside it is part of this change.",
        "",
        "```diff",
        DEFAULT_PATCH,
        "```",
      ].join("\n"),
    );
  });

  test("the prompt states the scope rule: depended-on code counts, everything else is a concern", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    await review(BOTH_VENDORS, CLAUDE_BUILDER, { codex });

    // THE POLICY IS BRIGADIER'S, NOT THE REVIEWER'S. Left unstated, the two
    // vendors invented different answers to "may I report a defect in code this
    // task did not write" — which is how three planted defects passed a gate
    // that had correctly rejected a defect the builder itself authored.
    const prompt = codex.specs[0]?.prompt ?? "";
    expect(prompt).toContain(
      [
        "Code this diff does not touch is in scope only when the changed code",
        "depends on it — calls it, reads its result, or extends it — so that this",
        "change itself misbehaves when it runs. Grade that like any other defect.",
      ].join("\n"),
    );
    expect(prompt).toContain(
      [
        "Anything else you notice in code this task did not change is outside this",
        'verdict, however wrong it looks. Report it with severity "concern" so a',
        'human sees it, and never with severity "blocking": this task was not asked',
        "to fix it, those lines may belong to another task, and re-running this",
        "task would produce the same diff and meet the same objection.",
      ].join("\n"),
    );
  });

  test("a diff containing a code fence is fenced with a longer one", async () => {
    // A slice that edits markdown produces a patch full of ``` lines. Wrapped
    // in three backticks, the block ends at the first of them and the rest of
    // the change reads as prose — with the reviewer's instructions inside it.
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });
    const patch = ["+```ts", "+const a = 1;", "+```", ""].join("\n");

    await review(
      BOTH_VENDORS,
      CLAUDE_BUILDER,
      { codex },
      fakeEngine(plainDiff(patch)).engine,
    );

    expect(codex.specs[0]?.prompt ?? "").toContain(
      ["````diff", patch, "````"].join("\n"),
    );
  });

  test("an empty change is rejected by diff_non_empty before model review", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    const { review: verdict } = await review(
      BOTH_VENDORS,
      CLAUDE_BUILDER,
      { codex },
      fakeEngine(plainDiff("")).engine,
    );

    expect(verdict.verdict).toBe("rejected");
    expect(codex.specs).toEqual([]);
    expect(
      verdict.verdict === "rejected" ? verdict.findings : [],
    ).toContainEqual({
      source: "gate",
      gate: "diff_non_empty",
      severity: "blocking",
      path: "src/auth.ts",
      line: null,
      summary: "The slice produced no diff.",
    });
  });

  test("a truncated diff is announced to the reviewer and on the run log", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });
    // The notice the engine puts inside the patch, reproduced here as the
    // engine produces it: a truncated diff must arrive already self-describing.
    const patch = `${DEFAULT_PATCH}[brigadier: this diff was truncated; 176 of 900 characters shown]\n`;

    const { harness } = await review(
      BOTH_VENDORS,
      CLAUDE_BUILDER,
      { codex },
      fakeEngine({
        paths: ["src/auth.ts"],
        patch,
        truncated: true,
        totalCharacters: 900,
      }).engine,
    );

    expect(codex.specs[0]?.prompt ?? "").toContain(
      "[brigadier: this diff was truncated; 176 of 900 characters shown]",
    );
    expect(harness.logs).toContain(
      "slice slice-auth attempt 1: the diff shown to the reviewer was truncated to 98304 of 900 characters",
    );
  });

  test("tags reviewer narration verbose and review degradation normal", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });
    const { harness } = await review(
      BOTH_VENDORS,
      CLAUDE_BUILDER,
      { codex },
      fakeEngine({
        paths: ["src/auth.ts"],
        patch: DEFAULT_PATCH,
        truncated: true,
        totalCharacters: 900,
      }).engine,
    );

    expect(
      harness.logCalls.find((call) => call.line.includes(": reviewing "))
        ?.level,
    ).toBe("verbose");
    expect(
      harness.logCalls.find((call) =>
        call.line.includes("the diff shown to the reviewer was truncated"),
      )?.level,
    ).toBe("normal");
  });

  test("an engine that cannot diff degrades visibly rather than silently", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    const { review: verdict, harness } = await review(
      BOTH_VENDORS,
      CLAUDE_BUILDER,
      { codex },
      fakeEngine(null).engine,
    );

    // FAIL-OPEN, BUT NEVER SILENTLY. The gate still runs — a missing diff must
    // not turn every `--unsafe-in-place` run into an unreviewed commit — and
    // both the reviewer and the operator are told the review is the weaker one.
    expect(verdict.verdict).toBe("approved");
    expect(verdict.gates?.slice(0, 3)).toEqual([
      {
        name: "paths_owned",
        severity: "blocking",
        status: "skipped",
        reason:
          "The changed-path list is unavailable: this run's worktree engine cannot produce one",
        findings: [],
      },
      {
        name: "paths_touched",
        severity: "concern",
        status: "skipped",
        reason:
          "The changed-path list is unavailable: this run's worktree engine cannot produce one",
        findings: [],
      },
      {
        name: "diff_non_empty",
        severity: "blocking",
        status: "skipped",
        reason:
          "The changed-path list is unavailable: this run's worktree engine cannot produce one",
        findings: [],
      },
    ]);
    expect(harness.logs).toContain(
      "slice slice-auth attempt 1: no diff of the change is available (this run's worktree engine cannot produce one), so the reviewer is reading whole files instead",
    );
    const prompt = codex.specs[0]?.prompt ?? "";
    expect(prompt).toContain(
      [
        "No diff of this change could be produced (this run's worktree engine cannot produce one), so it is not",
        "shown here. Read the files listed above in the current directory and judge",
        "their current contents instead.",
      ].join("\n"),
    );
    expect(prompt).toContain(
      [
        'You cannot see which lines this task wrote, so use severity "blocking"',
        "only for code the task above asked for. Anything that looks pre-existing",
        'belongs under severity "concern".',
      ].join("\n"),
    );
  });

  test("an engine that refuses to diff reports its own reason", async () => {
    const codex = fakeAdapter("codex", {
      outcome: outcomeWith('{"findings":[]}'),
    });

    const { harness } = await review(
      BOTH_VENDORS,
      CLAUDE_BUILDER,
      { codex },
      fakeEngine(
        new Error(
          "no isolated worktree created by this engine is registered at /tmp/brigadier/slice-7",
        ),
      ).engine,
    );

    expect(harness.logs).toContain(
      "slice slice-auth attempt 1: no diff of the change is available (no isolated worktree created by this engine is registered at /tmp/brigadier/slice-7), so the reviewer is reading whole files instead",
    );
  });

  test("a single-vendor review still computes the diff for deterministic gates", async () => {
    const engine = fakeEngine(plainDiff(DEFAULT_PATCH));

    const { review: verdict } = await review(
      CLAUDE_ONLY,
      CLAUDE_BUILDER,
      {},
      engine.engine,
    );

    expect(verdict.verdict).toBe("skipped");
    expect(engine.specs.length).toBe(1);
  });

  test("passing gates do not manufacture a review when no model can review", async () => {
    // DETERMINISTIC PASS IS NOT CROSS-VENDOR REVIEW. A single-vendor install
    // must remain visibly unreviewed rather than borrowing an approval from
    // checks that cannot substitute for the missing second opinion.
    const engine = fakeEngine(plainDiff(DEFAULT_PATCH));

    const { review: verdict } = await review(
      CLAUDE_ONLY,
      CLAUDE_BUILDER,
      {},
      engine.engine,
    );

    expect(verdict.verdict).toBe("skipped");
    expect(verdict.verdict === "skipped" ? verdict.reason : null).toBe(
      "NO_OTHER_VENDOR",
    );
    expect(
      verdict.gates?.map(({ name, status }) => ({ name, status })),
    ).toEqual([
      { name: "paths_owned", status: "passed" },
      { name: "paths_touched", status: "passed" },
      { name: "diff_non_empty", status: "passed" },
      { name: "tests_pass", status: "skipped" },
    ]);
  });
});
