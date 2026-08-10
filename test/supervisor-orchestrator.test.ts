/**
 * Tests for the run orchestrator.
 *
 * TWO RULES SHAPE EVERY FAKE IN THIS FILE.
 *
 * The first is that nothing here waits on a clock. Concurrency is proven with a
 * live-count that the fake runner increments on entry and decrements on exit,
 * and the assertion is that the observed maximum EQUALS `maxWorkers` exactly. A
 * timing-based concurrency test asserts that a machine was busy, which is not
 * the same claim and is flaky besides.
 *
 * The second is that no wait is unbounded. Every fake settles after a fixed
 * number of microtask hops, and every `run()` is awaited through `withinBound`,
 * which rejects with a message naming its own deadline. A test whose
 * broken-code behaviour is "waits forever" never reports and wedges the suite,
 * so the bound is asserted rather than assumed — see the first test below,
 * which proves `withinBound` actually fires.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrigadierConfig } from "../src/config/contracts.js";
import { CONFIG_VERSION, parseConfig } from "../src/config/contracts.js";
import type {
  Capability,
  QuotaSnapshot,
  Slice,
  Vendor,
} from "../src/contracts.js";
import type { AnyQuotaOracle } from "../src/quota/contracts.js";
import type { SliceDifficulty } from "../src/routing/contracts.js";
import { buildCapabilities } from "../src/supervisor/capabilities.js";
import type {
  PlanDocument,
  RunInterruption,
  RunReport,
  RunRequest,
  SliceResult,
  SliceRunInput,
  SliceRunner,
  SupervisorPorts,
} from "../src/supervisor/contracts.js";
import {
  allocateAttemptSlots,
  createRunner,
  runBounded,
} from "../src/supervisor/orchestrator.js";
import type {
  CommitResult,
  CommitSpec,
  CreatedWorktree,
  MergeResult,
  MergeSpec,
  WorktreeEngine,
  WorktreeSession,
  WorktreeSessionSpec,
  WorktreeSpec,
} from "../src/worktree/contracts.js";

/* ------------------------------ the bound -------------------------------- */

const TIMED_OUT = Symbol("timed-out");

/**
 * Awaits `promise`, rejecting if it has not settled within `ms`.
 *
 * The timer here is a safety net that turns a hang into a reported failure. It
 * is never the subject of an assertion about behaviour: no test in this file
 * concludes anything from how long something took.
 */
async function withinBound<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const settled = await Promise.race([promise, deadline]);
    if (settled === TIMED_OUT) {
      throw new Error(`operation did not settle within ${ms}ms`);
    }
    return settled;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Yields the event loop `hops` times without touching a timer. */
async function tick(hops: number): Promise<void> {
  for (let hop = 0; hop < hops; hop += 1) {
    await Promise.resolve();
  }
}

/* ------------------------------- fixtures -------------------------------- */

const REPOSITORY_PATH = "/repo/demo";
const SLUG = "demo";
const INTEGRATION_BRANCH = "brigadier/demo";
const NOW = 1_700_000_000_000;

function makeConfig(models: readonly string[]): BrigadierConfig {
  return parseConfig({
    version: CONFIG_VERSION,
    secretsConsent: true,
    allowDegradedRouting: false,
    vendors: [
      {
        vendor: "claude",
        executable: "/usr/local/bin/claude",
        version: "1.0.0",
        defaultModel: models[0] ?? "",
        models: models.map((id) => ({ id, effortCeiling: "high" })),
      },
    ],
  });
}

/** claude-opus-5 scores 100 and claude-sonnet-5 scores 74. */
const CONFIG = makeConfig(["claude-opus-5", "claude-sonnet-5"]);
const CAPABILITIES: readonly Capability[] = buildCapabilities(CONFIG);

/** Only haiku, which scores 40 and therefore clears no `hard` floor (90). */
const WEAK_CONFIG = makeConfig(["claude-haiku-4-5-20251001"]);
const WEAK_CAPABILITIES: readonly Capability[] = buildCapabilities(WEAK_CONFIG);

function slice(id: string, dependsOn: readonly string[] = []): Slice {
  return {
    id,
    title: `Slice ${id}`,
    prompt: `Do ${id}`,
    ownedPaths: [`src/${id}.ts`],
    dependsOn,
  };
}

function planDocument(
  slices: readonly Slice[],
  difficulty: SliceDifficulty = "routine",
): PlanDocument {
  return {
    plan: { id: "plan-1", goal: "ship it", slices },
    directives: slices.map((entry) => ({ sliceId: entry.id, difficulty })),
  };
}

function runRequest(document: PlanDocument, maxWorkers: number): RunRequest {
  return {
    document,
    repositoryPath: REPOSITORY_PATH,
    slug: SLUG,
    maxWorkers,
  };
}

const SESSION: WorktreeSession = {
  repositoryPath: REPOSITORY_PATH,
  slug: SLUG,
  baseCommit: "a".repeat(40),
  baseBranch: "brigadier/demo/base",
  integrationBranch: INTEGRATION_BRANCH,
};

/* ------------------------------ fake engine ------------------------------ */

interface FakeEngine {
  readonly engine: WorktreeEngine;
  /** Every port call in the order it happened. */
  readonly ops: readonly string[];
}

interface FakeEngineOptions {
  readonly prepareError?: string;
  /** Runs after `prepare` has started and before it returns its session. */
  readonly onPrepare?: () => void;
  /** Slice branches whose merge conflicts instead of merging. */
  readonly conflictBranches?: readonly string[];
  /** Slice branches whose merge throws. */
  readonly mergeThrows?: readonly string[];
  /** Slice branches whose removal throws. */
  readonly removeThrows?: readonly string[];
  /** When set, `release` throws with this message. */
  readonly releaseThrows?: string;
  /**
   * Runs before `remove` decides whether to throw. The real engine deletes the
   * worktree directory here, so a test that cares what is left on disk after a
   * run needs the fake to do the same.
   */
  readonly onRemove?: (worktree: CreatedWorktree) => Promise<void>;
}

function fakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const ops: string[] = [];
  const engine: WorktreeEngine = {
    prepare: async (spec: WorktreeSessionSpec): Promise<WorktreeSession> => {
      ops.push(
        `prepare ${spec.repositoryPath} ${spec.slug} consent=${String(spec.secrets.consentToLink)} linked=${spec.secrets.linkedPaths.length}`,
      );
      options.onPrepare?.();
      if (options.prepareError !== undefined) {
        throw new Error(options.prepareError);
      }
      return SESSION;
    },
    create: (_spec: WorktreeSpec): Promise<CreatedWorktree> => {
      ops.push("create");
      throw new Error("the orchestrator must not call create");
    },
    commit: (_spec: CommitSpec): Promise<CommitResult> => {
      ops.push("commit");
      throw new Error("the orchestrator must not call commit");
    },
    merge: async (spec: MergeSpec): Promise<MergeResult> => {
      ops.push(`merge ${spec.worktree.branch}`);
      if (options.mergeThrows?.includes(spec.worktree.branch) === true) {
        throw new Error(`merge exploded for ${spec.worktree.branch}`);
      }
      if (options.conflictBranches?.includes(spec.worktree.branch) === true) {
        return {
          status: "conflicted",
          integrationBranch: INTEGRATION_BRANCH,
          details: `CONFLICT in ${spec.worktree.branch}`,
        };
      }
      return {
        status: "merged",
        commit: `merge-of-${spec.worktree.branch}`,
        integrationBranch: INTEGRATION_BRANCH,
      };
    },
    redact: (_worktree: CreatedWorktree, artifact: string): string => artifact,
    remove: async (worktree: CreatedWorktree): Promise<void> => {
      ops.push(`remove ${worktree.branch}`);
      await options.onRemove?.(worktree);
      if (options.removeThrows?.includes(worktree.branch) === true) {
        throw new Error(`remove exploded for ${worktree.branch}`);
      }
    },
    release: async (session: WorktreeSession): Promise<void> => {
      ops.push(`release ${session.slug}`);
      if (options.releaseThrows !== undefined) {
        throw new Error(options.releaseThrows);
      }
    },
  };
  return { engine, ops };
}

/** An engine on which every call is a test failure waiting to be asserted. */
function forbiddenEngine(): FakeEngine {
  const ops: string[] = [];
  const refuse = (name: string) => (): never => {
    ops.push(name);
    throw new Error(`engine.${name} must not be called`);
  };
  const engine: WorktreeEngine = {
    prepare: refuse("prepare"),
    create: refuse("create"),
    commit: refuse("commit"),
    merge: refuse("merge"),
    redact: refuse("redact"),
    remove: refuse("remove"),
    release: refuse("release"),
  };
  return { engine, ops };
}

/* ------------------------------- fake ports ------------------------------ */

interface FakePorts {
  readonly ports: SupervisorPorts;
  readonly log: readonly string[];
  nowCalls(): number;
}

function fakePorts(
  engine: WorktreeEngine,
  oracles: readonly AnyQuotaOracle[] = [],
): FakePorts {
  const log: string[] = [];
  let nowCalls = 0;
  return {
    ports: {
      engine,
      workerFor: (_vendor: Vendor) => null,
      oracles,
      now: () => {
        nowCalls += 1;
        return NOW;
      },
      log: (line: string) => {
        log.push(line);
      },
    },
    log,
    nowCalls: () => nowCalls,
  };
}

/* ------------------------------ fake runner ------------------------------ */

interface FakeRunner {
  readonly runner: SliceRunner;
  /** The highest number of slices ever in flight simultaneously. */
  maxLive(): number;
  /** Slice ids in the order their runs finished. */
  completions(): readonly string[];
  /** Every input the orchestrator handed over, in call order. */
  inputs(): readonly SliceRunInput[];
}

interface FakeRunnerOptions {
  readonly failing?: readonly string[];
  readonly throwing?: readonly string[];
  /** Microtask hops each slice takes, defaulting to 1. */
  readonly hops?: Readonly<Record<string, number>>;
  /**
   * Called with each slice id the instant its run begins, before the fake does
   * any work. It is how a cancellation test aborts from a point that is
   * provably inside the run rather than before it, without a timer and without
   * a real worker.
   */
  readonly onStart?: (sliceId: string) => void;
  /**
   * Cleanup this runner reports it could not finish, keyed by slice id. It is
   * how a test drives the half of `RunReport.cleanupFailures` that originates
   * below the orchestrator — a worker whose process group would not die, a
   * failed attempt's worktree that would not be removed.
   */
  readonly cleanupFailures?: Readonly<Record<string, readonly string[]>>;
}

function worktreeFor(input: SliceRunInput): CreatedWorktree {
  const slot = input.attemptSlots[0];
  if (slot === undefined) {
    throw new Error("the orchestrator allocated no attempt slots");
  }
  return {
    repositoryPath: input.session.repositoryPath,
    path: slot.worktreePath,
    branch: `brigadier/${input.session.slug}/slice-${slot.sliceNumber}`,
    isolated: true,
    session: input.session,
  };
}

function fakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  let live = 0;
  let maxLive = 0;
  const completions: string[] = [];
  const inputs: SliceRunInput[] = [];
  const runner: SliceRunner = {
    run: async (input: SliceRunInput): Promise<SliceResult> => {
      inputs.push(input);
      options.onStart?.(input.slice.id);
      live += 1;
      maxLive = Math.max(maxLive, live);
      try {
        await tick(options.hops?.[input.slice.id] ?? 1);
        completions.push(input.slice.id);
        const leaked = options.cleanupFailures?.[input.slice.id];
        if (options.throwing?.includes(input.slice.id) === true) {
          throw new Error(`runner exploded for ${input.slice.id}`);
        }
        if (options.failing?.includes(input.slice.id) === true) {
          return {
            sliceId: input.slice.id,
            ok: false,
            ...(leaked === undefined ? {} : { cleanupFailures: leaked }),
            branch: null,
            commit: null,
            worktree: null,
            attempts: [
              {
                attempt: 1,
                routed: null,
                outcome: null,
                commit: null,
                failure: {
                  kind: "NO_CHANGES",
                  message: `${input.slice.id} changed nothing`,
                },
                durationMs: 0,
              },
            ],
          };
        }
        const worktree = worktreeFor(input);
        return {
          sliceId: input.slice.id,
          ok: true,
          ...(leaked === undefined ? {} : { cleanupFailures: leaked }),
          branch: worktree.branch,
          commit: `commit-${input.slice.id}`,
          worktree,
          attempts: [
            {
              attempt: 1,
              routed: null,
              outcome: null,
              commit: `commit-${input.slice.id}`,
              failure: null,
              durationMs: 0,
            },
          ],
        };
      } finally {
        live -= 1;
      }
    },
  };
  return {
    runner,
    maxLive: () => maxLive,
    completions: () => completions,
    inputs: () => inputs,
  };
}

/* --------------------------------- driver -------------------------------- */

interface Harness {
  readonly report: RunReport;
  readonly ops: readonly string[];
  readonly log: readonly string[];
  nowCalls(): number;
  readonly runner: FakeRunner;
}

async function execute(
  request: RunRequest,
  engineFake: FakeEngine,
  runnerFake: FakeRunner,
  config: BrigadierConfig = CONFIG,
  capabilities: readonly Capability[] = CAPABILITIES,
  oracles: readonly AnyQuotaOracle[] = [],
): Promise<Harness> {
  const portsFake = fakePorts(engineFake.engine, oracles);
  const orchestrator = createRunner({
    ports: portsFake.ports,
    config,
    capabilities,
    sliceRunner: runnerFake.runner,
  });
  const report = await withinBound(orchestrator.run(request), 2000);
  return {
    report,
    ops: engineFake.ops,
    log: portsFake.log,
    nowCalls: portsFake.nowCalls,
    runner: runnerFake,
  };
}

/* ================================= tests ================================= */

describe("the bound itself", () => {
  test("withinBound rejects a promise that never settles, naming its deadline", async () => {
    await expect(
      withinBound(new Promise<never>(() => undefined), 25),
    ).rejects.toThrow("operation did not settle within 25ms");
  });

  test("withinBound returns the value when the promise settles", async () => {
    await expect(withinBound(Promise.resolve(7), 2000)).resolves.toBe(7);
  });
});

describe("attempt slot allocation", () => {
  test("allocates ATTEMPT_LIMIT distinct positive numbers per slice index", () => {
    expect(allocateAttemptSlots(REPOSITORY_PATH, SLUG, 0)).toEqual([
      { sliceNumber: 1, worktreePath: "/repo/demo-brigadier/demo/slice-1" },
      { sliceNumber: 2, worktreePath: "/repo/demo-brigadier/demo/slice-2" },
    ]);
    expect(allocateAttemptSlots(REPOSITORY_PATH, SLUG, 1)).toEqual([
      { sliceNumber: 3, worktreePath: "/repo/demo-brigadier/demo/slice-3" },
      { sliceNumber: 4, worktreePath: "/repo/demo-brigadier/demo/slice-4" },
    ]);
    expect(allocateAttemptSlots(REPOSITORY_PATH, SLUG, 7)).toEqual([
      { sliceNumber: 15, worktreePath: "/repo/demo-brigadier/demo/slice-15" },
      { sliceNumber: 16, worktreePath: "/repo/demo-brigadier/demo/slice-16" },
    ]);
  });

  test("every number across a whole run is distinct and positive", () => {
    const numbers: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      for (const slot of allocateAttemptSlots(REPOSITORY_PATH, SLUG, index)) {
        numbers.push(slot.sliceNumber);
      }
    }
    expect(numbers).toHaveLength(40);
    expect(new Set(numbers).size).toBe(40);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(40);
  });

  test("the worktree path is a sibling of the repository, never inside it", () => {
    const slot = allocateAttemptSlots(REPOSITORY_PATH, SLUG, 0)[0];
    expect(slot?.worktreePath.startsWith(`${REPOSITORY_PATH}/`)).toBe(false);
  });

  test("refuses a negative slice index", () => {
    expect(() => allocateAttemptSlots(REPOSITORY_PATH, SLUG, -1)).toThrow(
      "sliceIndex must be a non-negative safe integer",
    );
  });

  test("the orchestrator hands the runner exactly those slots", async () => {
    const harness = await execute(
      runRequest(planDocument([slice("a"), slice("b")]), 2),
      fakeEngine(),
      fakeRunner(),
    );
    const inputs = harness.runner.inputs();
    expect(inputs.map((input) => input.slice.id)).toEqual(["a", "b"]);
    expect(inputs[0]?.attemptSlots).toEqual([
      { sliceNumber: 1, worktreePath: "/repo/demo-brigadier/demo/slice-1" },
      { sliceNumber: 2, worktreePath: "/repo/demo-brigadier/demo/slice-2" },
    ]);
    expect(inputs[1]?.attemptSlots).toEqual([
      { sliceNumber: 3, worktreePath: "/repo/demo-brigadier/demo/slice-3" },
      { sliceNumber: 4, worktreePath: "/repo/demo-brigadier/demo/slice-4" },
    ]);
    expect(inputs[0]?.session).toBe(SESSION);
    expect(inputs[0]?.unsafeInPlace).toBe(false);
    expect(inputs[0]?.directive).toEqual({
      sliceId: "a",
      difficulty: "routine",
    });
  });
});

describe("plan validation", () => {
  test("an invalid plan fails as PLAN_INVALID and touches no port", async () => {
    const engine = forbiddenEngine();
    const runner = fakeRunner();
    const harness = await execute(
      runRequest(planDocument([]), 2),
      engine,
      runner,
    );
    expect(harness.report.ok).toBe(false);
    expect(harness.report.failure).toEqual({
      reason: "PLAN_INVALID",
      message: "plan plan-1 cannot be scheduled: EMPTY_PLAN",
    });
    expect(harness.report.planIssues).toEqual([
      {
        code: "EMPTY_PLAN",
        message: "a plan must contain at least one slice",
        sliceIds: [],
        paths: [],
      },
    ]);
    expect(harness.report.slices).toEqual([]);
    expect(harness.report.merges).toEqual([]);
    expect(harness.report.integrationBranch).toBeNull();
    expect(harness.report.durationMs).toBe(0);
    expect(harness.ops).toEqual([]);
    expect(harness.runner.inputs()).toEqual([]);
  });

  test("every plan issue reaches the report, not just the first", async () => {
    const document = planDocument([
      { ...slice("a"), ownedPaths: ["src/shared.ts"] },
      { ...slice("b"), ownedPaths: ["src/shared.ts"] },
      { ...slice("c"), dependsOn: ["nope"] },
    ]);
    const harness = await execute(
      runRequest(document, 2),
      forbiddenEngine(),
      fakeRunner(),
    );
    expect(harness.report.planIssues.map((issue) => issue.code)).toEqual([
      "PATH_CONFLICT",
      "UNKNOWN_DEPENDENCY",
      "DEPENDENCIES_UNSUPPORTED",
    ]);
    expect(harness.report.failure?.message).toBe(
      "plan plan-1 cannot be scheduled: PATH_CONFLICT, UNKNOWN_DEPENDENCY, DEPENDENCIES_UNSUPPORTED",
    );
  });
});

describe("unsafe in-place concurrency", () => {
  test("unsafeInPlace with two workers is refused before any port is touched", async () => {
    const engine = forbiddenEngine();
    const runner = fakeRunner();
    const portTouches: string[] = [];
    const ports = new Proxy(fakePorts(engine.engine).ports, {
      get: (target, property, receiver) => {
        portTouches.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
    const orchestrator = createRunner({
      ports,
      config: CONFIG,
      capabilities: CAPABILITIES,
      sliceRunner: runner.runner,
    });
    const request: RunRequest = {
      ...runRequest(planDocument([slice("a")]), 2),
      unsafeInPlace: true,
    };

    const report = await withinBound(orchestrator.run(request), 2000);

    expect(report).toEqual({
      ok: false,
      slug: "demo",
      dryRun: false,
      interrupted: false,
      cleanupFailures: [],
      integrationBranch: null,
      slices: [],
      merges: [],
      planIssues: [],
      failure: {
        reason: "PLAN_INVALID",
        message:
          "unsafeInPlace=true cannot be combined with maxWorkers=2; isolated worktrees are what make concurrent slices safe",
      },
      durationMs: 0,
    });
    expect(portTouches).toEqual([]);
    expect(engine.ops).toEqual([]);
    expect(runner.inputs()).toEqual([]);
  });

  test("unsafeInPlace with one worker is permitted", async () => {
    const request: RunRequest = {
      ...runRequest(planDocument([slice("a")]), 1),
      unsafeInPlace: true,
    };
    const harness = await execute(request, fakeEngine(), fakeRunner());

    expect(harness.report.ok).toBe(true);
    expect(harness.report.failure).toBeNull();
    expect(harness.report.planIssues).toEqual([]);
    expect(
      harness.runner.inputs().map((input) => ({
        sliceId: input.slice.id,
        unsafeInPlace: input.unsafeInPlace,
      })),
    ).toEqual([{ sliceId: "a", unsafeInPlace: true }]);
  });
});

describe("directive coverage", () => {
  test("a missing directive is PLAN_INVALID naming the slice", async () => {
    const slices = [slice("a"), slice("b")];
    const document: PlanDocument = {
      plan: { id: "plan-1", goal: "ship it", slices },
      directives: [{ sliceId: "a", difficulty: "routine" }],
    };
    const harness = await execute(
      runRequest(document, 2),
      forbiddenEngine(),
      fakeRunner(),
    );
    expect(harness.report.failure).toEqual({
      reason: "PLAN_INVALID",
      message:
        "plan document directives must cover the plan's slices exactly: missing directives for: b",
    });
    expect(harness.ops).toEqual([]);
  });

  test("an unexpected directive is PLAN_INVALID naming the stray id", async () => {
    const slices = [slice("a")];
    const document: PlanDocument = {
      plan: { id: "plan-1", goal: "ship it", slices },
      directives: [
        { sliceId: "a", difficulty: "routine" },
        { sliceId: "ghost", difficulty: "hard" },
      ],
    };
    const harness = await execute(
      runRequest(document, 2),
      forbiddenEngine(),
      fakeRunner(),
    );
    expect(harness.report.failure).toEqual({
      reason: "PLAN_INVALID",
      message:
        "plan document directives must cover the plan's slices exactly: unexpected directives for: ghost",
    });
  });

  test("a duplicated directive is PLAN_INVALID naming the repeated id", async () => {
    const slices = [slice("a")];
    const document: PlanDocument = {
      plan: { id: "plan-1", goal: "ship it", slices },
      directives: [
        { sliceId: "a", difficulty: "routine" },
        { sliceId: "a", difficulty: "hard" },
      ],
    };
    const harness = await execute(
      runRequest(document, 2),
      forbiddenEngine(),
      fakeRunner(),
    );
    expect(harness.report.failure).toEqual({
      reason: "PLAN_INVALID",
      message:
        "plan document directives must cover the plan's slices exactly: duplicate directives for: a",
    });
  });
});

describe("pre-flight routing", () => {
  test("an unroutable slice fails the run before any side effect exists", async () => {
    const engine = forbiddenEngine();
    const runner = fakeRunner();
    const harness = await execute(
      runRequest(planDocument([slice("a"), slice("b")], "hard"), 2),
      engine,
      runner,
      WEAK_CONFIG,
      WEAK_CAPABILITIES,
    );

    expect(harness.report.ok).toBe(false);
    expect(harness.report.failure?.reason).toBe("PREFLIGHT_ROUTING_FAILED");
    expect(harness.report.integrationBranch).toBeNull();
    expect(harness.report.merges).toEqual([]);

    // Nothing was prepared, created, spawned, or merged.
    expect(harness.ops).toEqual([]);
    expect(harness.runner.inputs()).toEqual([]);

    // Every slice is reported, and each carries the router's own diagnosis.
    expect(harness.report.slices.map((result) => result.sliceId)).toEqual([
      "a",
      "b",
    ]);
    const first = harness.report.slices[0];
    expect(first?.ok).toBe(false);
    expect(first?.attempts).toHaveLength(1);
    const failure = first?.attempts[0]?.failure;
    expect(failure?.kind).toBe("ROUTING_FAILED");
    if (failure?.kind !== "ROUTING_FAILED") {
      throw new Error("expected a ROUTING_FAILED failure");
    }
    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-haiku-4-5-20251001",
        stage: "competence",
        reason: "competence score 40 is below the hard floor of 90",
      },
    ]);
    expect(failure.message).toBe(
      'no configured model can take slice "a" at hard difficulty; 1 model(s) were eliminated',
    );
    // Both slices are named, in plan order, each carrying the router's own text.
    expect(harness.report.failure?.message).toBe(
      'slice a could not be routed: no configured model can take slice "a" at hard difficulty; 1 model(s) were eliminated; slice b could not be routed: no configured model can take slice "b" at hard difficulty; 1 model(s) were eliminated',
    );
  });

  test("routing happens for every slice before the first is spawned", async () => {
    // Slice `b` is unroutable at `hard`; `a` routes fine at `routine`. If the
    // orchestrator routed lazily, `a` would already have been handed to the
    // runner by the time `b` failed.
    const slices = [slice("a"), slice("b")];
    const document: PlanDocument = {
      plan: { id: "plan-1", goal: "ship it", slices },
      directives: [
        { sliceId: "a", difficulty: "routine" },
        { sliceId: "b", difficulty: "hard" },
      ],
    };
    const harness = await execute(
      runRequest(document, 2),
      forbiddenEngine(),
      fakeRunner(),
      WEAK_CONFIG,
      WEAK_CAPABILITIES,
    );
    expect(harness.report.failure?.reason).toBe("PREFLIGHT_ROUTING_FAILED");
    expect(harness.report.failure?.message).toBe(
      'slice b could not be routed: no configured model can take slice "b" at hard difficulty; 1 model(s) were eliminated',
    );
    expect(harness.runner.inputs()).toEqual([]);
    expect(harness.ops).toEqual([]);
    // `a` routed successfully and says so.
    expect(harness.report.slices[0]?.attempts[0]?.routed?.model).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(harness.report.slices[1]?.attempts[0]?.routed).toBeNull();
  });
});

describe("dry run", () => {
  test("routes everything and touches no port at all", async () => {
    const engine = forbiddenEngine();
    const runner = fakeRunner();
    const request: RunRequest = {
      ...runRequest(planDocument([slice("a"), slice("b")]), 2),
      dryRun: true,
    };
    const harness = await execute(request, engine, runner);

    expect(harness.report.ok).toBe(true);
    expect(harness.report.dryRun).toBe(true);
    expect(harness.report.failure).toBeNull();
    expect(harness.report.integrationBranch).toBeNull();
    expect(harness.report.merges).toEqual([]);
    expect(harness.ops).toEqual([]);
    expect(harness.runner.inputs()).toEqual([]);

    expect(harness.report.slices).toHaveLength(2);
    for (const [index, id] of ["a", "b"].entries()) {
      const result = harness.report.slices[index];
      expect(result?.sliceId).toBe(id);
      expect(result?.ok).toBe(false);
      expect(result?.branch).toBeNull();
      expect(result?.commit).toBeNull();
      expect(result?.worktree).toBeNull();
      expect(result?.attempts).toHaveLength(1);
      const attempt = result?.attempts[0];
      expect(attempt?.attempt).toBe(1);
      expect(attempt?.outcome).toBeNull();
      expect(attempt?.commit).toBeNull();
      expect(attempt?.failure).toBeNull();
      expect(attempt?.durationMs).toBe(0);
      // `routine` sets a floor of 0 and the router picks the LOWEST scorer
      // above it, so the balanced tier wins over the deepest one.
      expect(attempt?.routed?.vendor).toBe("claude");
      expect(attempt?.routed?.model).toBe("claude-sonnet-5");
      expect(attempt?.routed?.effort).toBe("medium");
      expect(attempt?.routed?.waivedDifficultyFloor).toBe(false);
    }
  });

  test("a hard slice dry-routes to the deepest tier", async () => {
    const request: RunRequest = {
      ...runRequest(planDocument([slice("a")], "hard"), 2),
      dryRun: true,
    };
    const harness = await execute(request, forbiddenEngine(), fakeRunner());
    expect(harness.report.slices[0]?.attempts[0]?.routed?.model).toBe(
      "claude-opus-5",
    );
  });
});

describe("session preparation", () => {
  test("a prepare failure is PREPARE_FAILED and nothing runs", async () => {
    const engine = fakeEngine({ prepareError: "scratch base already exists" });
    const runner = fakeRunner();
    const harness = await execute(
      runRequest(planDocument([slice("a")]), 2),
      engine,
      runner,
    );
    expect(harness.report.ok).toBe(false);
    expect(harness.report.failure).toEqual({
      reason: "PREPARE_FAILED",
      message: "scratch base already exists",
    });
    expect(harness.report.integrationBranch).toBeNull();
    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
    ]);
    expect(harness.runner.inputs()).toEqual([]);
    // The routing that already happened is still reported.
    expect(harness.report.slices[0]?.attempts[0]?.routed?.model).toBe(
      "claude-sonnet-5",
    );
  });

  test("the secrets policy comes from the config's consent flag", async () => {
    const engine = fakeEngine({ prepareError: "stop here" });
    await execute(
      runRequest(planDocument([slice("a")]), 2),
      engine,
      fakeRunner(),
      makeConfig(["claude-sonnet-5"]),
      buildCapabilities(makeConfig(["claude-sonnet-5"])),
    );
    expect(engine.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
    ]);
  });
});

/**
 * Counts how many tasks are live simultaneously, using a counter rather than a
 * clock. Every task settles after a bounded number of microtask hops.
 */
function countingPool(hopsByItem: Readonly<Record<string, number>>) {
  let live = 0;
  let maxLive = 0;
  const completions: string[] = [];
  return {
    maxLive: () => maxLive,
    completions: () => completions,
    task: async (item: string): Promise<string> => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      try {
        await tick(hopsByItem[item] ?? 1);
        completions.push(item);
        return `done-${item}`;
      } finally {
        live -= 1;
      }
    },
  };
}

describe("bounded concurrency", () => {
  test("a cap of two over five items never exceeds two live, and reaches two", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const pool = countingPool({ a: 4, b: 3, c: 2, d: 5, e: 1 });
    const results = await withinBound(runBounded(items, 2, pool.task), 2000);
    // The observed live-count maximum, never elapsed time.
    expect(pool.maxLive()).toBe(2);
    expect(pool.completions()).toHaveLength(5);
    expect(results).toEqual(["done-a", "done-b", "done-c", "done-d", "done-e"]);
  });

  test("a cap of one serializes completely", async () => {
    const pool = countingPool({ a: 3, b: 2, c: 1 });
    await withinBound(runBounded(["a", "b", "c"], 1, pool.task), 2000);
    expect(pool.maxLive()).toBe(1);
    // Serialized, so completion order is input order despite the hop counts.
    expect(pool.completions()).toEqual(["a", "b", "c"]);
  });

  test("a cap larger than the item count runs every item at once", async () => {
    const pool = countingPool({});
    await withinBound(runBounded(["a", "b", "c"], 9, pool.task), 2000);
    expect(pool.maxLive()).toBe(3);
  });

  test("results keep input order even when completion order differs", async () => {
    const pool = countingPool({ a: 5, b: 3, c: 1 });
    const results = await withinBound(
      runBounded(["a", "b", "c"], 3, pool.task),
      2000,
    );
    expect(pool.completions()).toEqual(["c", "b", "a"]);
    expect(results).toEqual(["done-a", "done-b", "done-c"]);
  });

  test("an empty item list settles without running anything", async () => {
    const pool = countingPool({});
    const results = await withinBound(runBounded([], 3, pool.task), 2000);
    expect(results).toEqual([]);
    expect(pool.maxLive()).toBe(0);
  });

  test("the orchestrator throttles four independent slices to two live", async () => {
    const slices = [slice("a"), slice("b"), slice("c"), slice("d")];
    const runner = fakeRunner({ hops: { a: 4, b: 3, c: 2, d: 1 } });
    const harness = await execute(
      runRequest(planDocument(slices), 2),
      fakeEngine(),
      runner,
    );

    expect(harness.report.ok).toBe(true);
    expect(harness.report.failure).toBeNull();
    expect(harness.report.planIssues).toEqual([]);
    expect(harness.runner.maxLive()).toBe(2);
    expect(harness.runner.inputs().map((input) => input.slice.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(harness.report.slices.map((result) => result.sliceId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("the orchestrator runs a whole independent wave concurrently", async () => {
    const slices = [slice("a"), slice("b"), slice("c"), slice("d"), slice("e")];
    const runner = fakeRunner({ hops: { a: 4, b: 3, c: 2, d: 5, e: 1 } });
    const harness = await execute(
      runRequest(planDocument(slices), 5),
      fakeEngine(),
      runner,
    );
    expect(harness.report.ok).toBe(true);
    expect(harness.runner.maxLive()).toBe(5);
    expect(harness.runner.inputs().map((input) => input.slice.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("the orchestrator refuses later waves before touching a port", async () => {
    const slices = [
      slice("a"),
      slice("b"),
      slice("c", ["a", "b"]),
      slice("d", ["a", "b"]),
    ];
    const runner = fakeRunner({ hops: { a: 6, b: 1, c: 1, d: 1 } });
    const harness = await execute(
      runRequest(planDocument(slices), 2),
      forbiddenEngine(),
      runner,
    );
    expect(harness.report.ok).toBe(false);
    expect(harness.report.failure).toEqual({
      reason: "PLAN_INVALID",
      message:
        "plan plan-1 cannot be scheduled: DEPENDENCIES_UNSUPPORTED, DEPENDENCIES_UNSUPPORTED",
    });
    expect(harness.report.planIssues.map((issue) => issue.sliceIds)).toEqual([
      ["c"],
      ["d"],
    ]);
    expect(harness.runner.maxLive()).toBe(0);
    expect(harness.runner.completions()).toEqual([]);
    expect(harness.ops).toEqual([]);
  });
});

describe("wave failure", () => {
  test("a failed slice does not stop later items in its independent wave", async () => {
    const slices = [slice("a"), slice("b"), slice("c")];
    const runner = fakeRunner({ failing: ["a"] });
    const engine = fakeEngine();
    const harness = await execute(
      runRequest(planDocument(slices), 2),
      engine,
      runner,
    );

    expect(harness.runner.inputs().map((input) => input.slice.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(harness.report.ok).toBe(false);
    expect(harness.report.failure).toEqual({
      reason: "SLICE_FAILED",
      message: "1 slice(s) did not complete: a",
    });
    expect(harness.report.slices.map((result) => result.sliceId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(harness.report.slices[0]?.attempts).toHaveLength(1);
    expect(harness.report.slices[1]?.attempts).toHaveLength(1);
    expect(harness.report.slices[2]?.attempts).toHaveLength(1);
    expect(harness.report.merges.map((merge) => merge.sliceId)).toEqual([
      "b",
      "c",
    ]);
    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "merge brigadier/demo/slice-3",
      "merge brigadier/demo/slice-5",
      "remove brigadier/demo/slice-3",
      "remove brigadier/demo/slice-5",
      "release demo",
    ]);
    expect(
      harness.log.filter((line) => line.startsWith("wave stopped:")),
    ).toEqual([]);
  });

  test("siblings in the failing independent wave still finish", async () => {
    const slices = [slice("a"), slice("b"), slice("c")];
    const runner = fakeRunner({ failing: ["a"] });
    const harness = await execute(
      runRequest(planDocument(slices), 2),
      fakeEngine(),
      runner,
    );
    expect([...harness.runner.completions()].sort()).toEqual(["a", "b", "c"]);
    expect(harness.report.slices[1]?.ok).toBe(true);
    expect(harness.report.slices[2]?.ok).toBe(true);
  });

  test("a surviving slice is still merged and still removed after a sibling failed", async () => {
    const slices = [slice("a"), slice("b")];
    const runner = fakeRunner({ failing: ["a"] });
    const engine = fakeEngine();
    const harness = await execute(
      runRequest(planDocument(slices), 2),
      engine,
      runner,
    );
    expect(harness.report.ok).toBe(false);
    expect(harness.report.failure?.reason).toBe("SLICE_FAILED");
    expect(harness.report.integrationBranch).toBe(INTEGRATION_BRANCH);
    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "merge brigadier/demo/slice-3",
      "remove brigadier/demo/slice-3",
      "release demo",
    ]);
  });

  test("a runner that throws is recorded rather than taking down its siblings", async () => {
    const slices = [slice("a"), slice("b")];
    const runner = fakeRunner({ throwing: ["a"] });
    const engine = fakeEngine();
    const harness = await execute(
      runRequest(planDocument(slices), 2),
      engine,
      runner,
    );
    expect(harness.report.ok).toBe(false);
    const failure = harness.report.slices[0]?.attempts[0]?.failure;
    expect(failure?.kind).toBe("WORKER_FAILED");
    expect(failure?.message).toBe(
      "slice runner threw for a: runner exploded for a",
    );
    expect(harness.report.slices[1]?.ok).toBe(true);
    // The surviving sibling is still merged and still cleaned up.
    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "merge brigadier/demo/slice-3",
      "remove brigadier/demo/slice-3",
      "release demo",
    ]);
  });
});

describe("reconciliation", () => {
  test("merges in sliceNumber order, not completion order and not wave order", async () => {
    // Plan order c, a, b gives sliceNumbers c=1, a=3, b=5. The wave arrives
    // dependency-sorted as a, b, c, and the hop counts make them COMPLETE as
    // c, b, a. Only sliceNumber ordering yields c, a, b.
    const slices = [slice("c"), slice("a"), slice("b")];
    const runner = fakeRunner({ hops: { a: 5, b: 3, c: 1 } });
    const engine = fakeEngine();
    const harness = await execute(
      runRequest(planDocument(slices), 3),
      engine,
      runner,
    );

    expect(harness.runner.inputs().map((input) => input.slice.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(harness.runner.completions()).toEqual(["c", "b", "a"]);
    expect(harness.report.merges.map((record) => record.sliceId)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "merge brigadier/demo/slice-1",
      "merge brigadier/demo/slice-3",
      "merge brigadier/demo/slice-5",
      "remove brigadier/demo/slice-1",
      "remove brigadier/demo/slice-3",
      "remove brigadier/demo/slice-5",
      "release demo",
    ]);
  });

  test("records every MergeResult and takes the branch from the engine", async () => {
    const slices = [slice("a"), slice("b")];
    const harness = await execute(
      runRequest(planDocument(slices), 2),
      fakeEngine(),
      fakeRunner(),
    );
    expect(harness.report.ok).toBe(true);
    expect(harness.report.failure).toBeNull();
    expect(harness.report.integrationBranch).toBe(INTEGRATION_BRANCH);
    expect(harness.report.merges).toEqual([
      {
        sliceId: "a",
        result: {
          status: "merged",
          commit: "merge-of-brigadier/demo/slice-1",
          integrationBranch: INTEGRATION_BRANCH,
        },
      },
      {
        sliceId: "b",
        result: {
          status: "merged",
          commit: "merge-of-brigadier/demo/slice-3",
          integrationBranch: INTEGRATION_BRANCH,
        },
      },
    ]);
  });

  test("a conflict fails the run but the remaining slices still merge", async () => {
    const slices = [slice("a"), slice("b"), slice("c")];
    const engine = fakeEngine({
      conflictBranches: ["brigadier/demo/slice-3"],
    });
    const harness = await execute(
      runRequest(planDocument(slices), 3),
      engine,
      fakeRunner(),
    );

    expect(harness.report.ok).toBe(false);
    expect(harness.report.failure).toEqual({
      reason: "MERGE_CONFLICT",
      message: "slice b conflicts with the integration branch",
    });
    expect(harness.report.merges.map((record) => record.sliceId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(harness.report.merges.map((record) => record.result.status)).toEqual(
      ["merged", "conflicted", "merged"],
    );
    expect(harness.report.merges[1]?.result).toEqual({
      status: "conflicted",
      integrationBranch: INTEGRATION_BRANCH,
      details: "CONFLICT in brigadier/demo/slice-3",
    });
    expect(harness.report.integrationBranch).toBe(INTEGRATION_BRANCH);
    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "merge brigadier/demo/slice-1",
      "merge brigadier/demo/slice-3",
      "merge brigadier/demo/slice-5",
      "remove brigadier/demo/slice-1",
      "remove brigadier/demo/slice-3",
      "remove brigadier/demo/slice-5",
      "release demo",
    ]);
  });

  test("a slice failure outranks a merge conflict in the run's reason", async () => {
    const slices = [slice("a"), slice("b"), slice("c")];
    const engine = fakeEngine({
      conflictBranches: ["brigadier/demo/slice-3"],
    });
    const harness = await execute(
      runRequest(planDocument(slices), 3),
      engine,
      fakeRunner({ failing: ["c"] }),
    );
    expect(harness.report.failure).toEqual({
      reason: "SLICE_FAILED",
      message: "1 slice(s) did not complete: c",
    });
    // The conflict is still fully visible in the merges.
    expect(harness.report.merges.map((record) => record.result.status)).toEqual(
      ["merged", "conflicted"],
    );
  });

  test("a merge that throws is reported and the rest still merge and clean up", async () => {
    const slices = [slice("a"), slice("b")];
    const engine = fakeEngine({ mergeThrows: ["brigadier/demo/slice-1"] });
    const harness = await execute(
      runRequest(planDocument(slices), 2),
      engine,
      fakeRunner(),
    );
    expect(harness.report.ok).toBe(false);
    expect(harness.report.failure).toEqual({
      reason: "MERGE_CONFLICT",
      message: "merge a: error merge exploded for brigadier/demo/slice-1",
    });
    expect(harness.report.merges.map((record) => record.sliceId)).toEqual([
      "b",
    ]);
    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "merge brigadier/demo/slice-1",
      "merge brigadier/demo/slice-3",
      "remove brigadier/demo/slice-1",
      "remove brigadier/demo/slice-3",
      "release demo",
    ]);
  });
});

describe("cleanup", () => {
  test("surviving worktrees are removed only after every merge", async () => {
    const slices = [slice("a"), slice("b"), slice("c")];
    const engine = fakeEngine();
    const harness = await execute(
      runRequest(planDocument(slices), 3),
      engine,
      fakeRunner(),
    );
    const firstRemove = harness.ops.findIndex((op) => op.startsWith("remove "));
    const lastMerge = harness.ops.reduce(
      (last, op, index) => (op.startsWith("merge ") ? index : last),
      -1,
    );
    expect(lastMerge).toBe(3);
    expect(firstRemove).toBe(4);
  });

  test("one failing removal does not skip the rest, and is logged", async () => {
    const slices = [slice("a"), slice("b"), slice("c")];
    const engine = fakeEngine({ removeThrows: ["brigadier/demo/slice-1"] });
    const harness = await execute(
      runRequest(planDocument(slices), 3),
      engine,
      fakeRunner(),
    );
    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "merge brigadier/demo/slice-1",
      "merge brigadier/demo/slice-3",
      "merge brigadier/demo/slice-5",
      "remove brigadier/demo/slice-1",
      "remove brigadier/demo/slice-3",
      "remove brigadier/demo/slice-5",
      "release demo",
    ]);
    expect(harness.log).toContain(
      "cleanup a: remove exploded for brigadier/demo/slice-1",
    );
    // A directory left behind does not invalidate merges that landed.
    expect(harness.report.ok).toBe(true);
  });

  test("removal still happens when every merge conflicts", async () => {
    const slices = [slice("a"), slice("b")];
    const engine = fakeEngine({
      conflictBranches: ["brigadier/demo/slice-1", "brigadier/demo/slice-3"],
    });
    const harness = await execute(
      runRequest(planDocument(slices), 2),
      engine,
      fakeRunner(),
    );
    expect(harness.report.failure?.reason).toBe("MERGE_CONFLICT");
    expect(harness.ops.filter((op) => op.startsWith("remove "))).toEqual([
      "remove brigadier/demo/slice-1",
      "remove brigadier/demo/slice-3",
    ]);
  });
});

/* -------------------------------- quota ---------------------------------- */

function exhaustedSnapshot(): QuotaSnapshot & { readonly vendor: "claude" } {
  return {
    vendor: "claude",
    status: "exhausted",
    observedAtMs: NOW,
    windows: [
      {
        kind: "weekly",
        scope: { kind: "account" },
        status: "exhausted",
        durationMinutes: 10_080,
        remainingFraction: 0,
        resetsAtMs: null,
      },
    ],
    isUsingOverage: null,
  };
}

function claudeOracle(
  snapshot: () => Promise<QuotaSnapshot & { readonly vendor: "claude" }>,
): AnyQuotaOracle {
  return {
    vendor: "claude",
    snapshot,
    dispose: async (): Promise<void> => undefined,
    ingest: () => undefined,
  };
}

describe("quota", () => {
  test("a snapshot reaches the router and can fail the pre-flight", async () => {
    const engine = forbiddenEngine();
    const harness = await execute(
      runRequest(planDocument([slice("a")]), 1),
      engine,
      fakeRunner(),
      CONFIG,
      CAPABILITIES,
      [claudeOracle(async () => exhaustedSnapshot())],
    );
    expect(harness.report.failure?.reason).toBe("PREFLIGHT_ROUTING_FAILED");
    const failure = harness.report.slices[0]?.attempts[0]?.failure;
    if (failure?.kind !== "ROUTING_FAILED") {
      throw new Error("expected a ROUTING_FAILED failure");
    }
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.rejected.map((entry) => entry.stage)).toEqual([
      "quota",
      "quota",
    ]);
    expect(harness.ops).toEqual([]);
  });

  test("an oracle that fails is logged and the run continues without it", async () => {
    const harness = await execute(
      runRequest(planDocument([slice("a")]), 1),
      fakeEngine(),
      fakeRunner(),
      CONFIG,
      CAPABILITIES,
      [
        claudeOracle(async () => {
          throw new Error("credentials unreadable");
        }),
      ],
    );
    expect(harness.log[0]).toBe(
      "quota claude: unavailable (credentials unreadable)",
    );
    expect(harness.report.ok).toBe(true);
    expect(harness.report.slices[0]?.ok).toBe(true);
  });
});

describe("the report", () => {
  test("a clean run reports every field with an absolute value", async () => {
    const harness = await execute(
      runRequest(planDocument([slice("a")]), 1),
      fakeEngine(),
      fakeRunner(),
    );
    expect(harness.report).toEqual({
      ok: true,
      slug: "demo",
      dryRun: false,
      interrupted: false,
      cleanupFailures: [],
      integrationBranch: INTEGRATION_BRANCH,
      slices: [
        {
          sliceId: "a",
          ok: true,
          branch: "brigadier/demo/slice-1",
          commit: "commit-a",
          worktree: {
            repositoryPath: REPOSITORY_PATH,
            path: "/repo/demo-brigadier/demo/slice-1",
            branch: "brigadier/demo/slice-1",
            isolated: true,
            session: SESSION,
          },
          attempts: [
            {
              attempt: 1,
              routed: null,
              outcome: null,
              commit: "commit-a",
              failure: null,
              durationMs: 0,
            },
          ],
        },
      ],
      merges: [
        {
          sliceId: "a",
          result: {
            status: "merged",
            commit: "merge-of-brigadier/demo/slice-1",
            integrationBranch: INTEGRATION_BRANCH,
          },
        },
      ],
      planIssues: [],
      failure: null,
      durationMs: 0,
    });
  });

  test("the log narrates the run in order", async () => {
    const harness = await execute(
      runRequest(planDocument([slice("a"), slice("b")]), 2),
      fakeEngine(),
      fakeRunner(),
    );
    expect(harness.log).toEqual([
      "run demo: 2 slice(s) in 1 wave(s)",
      "slice a: ok brigadier/demo/slice-1 commit-a",
      "slice b: ok brigadier/demo/slice-3 commit-b",
      "merge a: merged",
      "merge b: merged",
    ]);
  });
});

/* ------------------------------ cancellation ----------------------------- */

/**
 * NOT ONE OF THESE TESTS SENDS A SIGNAL, and not one of them can hang.
 *
 * The abort is raised from inside the fake runner's first slice, which is a
 * point provably inside the run, reached without a timer. Every other fake
 * still settles on its own after its fixed hop count, so an orchestrator that
 * ignored the signal entirely would finish the whole plan and fail these tests
 * on their counts — in milliseconds, and with a diff that names what it ran.
 */
const SIGINT_REASON: RunInterruption = { kind: "interrupt", signal: "SIGINT" };

/** A request carrying a signal, since `runRequest` deliberately has no defaults. */
function interruptibleRequest(
  document: PlanDocument,
  maxWorkers: number,
  signal: AbortSignal,
): RunRequest {
  return { ...runRequest(document, maxWorkers), signal };
}

describe("cancellation", () => {
  test("an abort mid-wave starts no further slice and reports the rest cancelled", async () => {
    const controller = new AbortController();
    const runner = fakeRunner({
      onStart: (sliceId) => {
        if (sliceId === "a") {
          controller.abort(SIGINT_REASON);
        }
      },
    });
    const engine = fakeEngine();
    const harness = await execute(
      interruptibleRequest(
        planDocument([slice("a"), slice("b"), slice("c")]),
        1,
        controller.signal,
      ),
      engine,
      runner,
    );

    // Exactly one slice was ever handed to the runner.
    expect(harness.runner.inputs().map((input) => input.slice.id)).toEqual([
      "a",
    ]);
    expect(harness.report.interrupted).toBe(true);

    // `a` finished before the abort took effect and keeps its commit.
    expect(harness.report.slices[0]?.ok).toBe(true);
    // `b` and `c` were never started, and say so without claiming a failure.
    for (const index of [1, 2]) {
      const result = harness.report.slices[index];
      expect(result?.ok).toBe(false);
      expect(result?.cancelled).toBe(true);
      expect(result?.attempts).toEqual([]);
      expect(result?.branch).toBeNull();
      expect(result?.worktree).toBeNull();
    }
    expect(harness.report.failure).toEqual({
      reason: "SLICE_FAILED",
      message: "2 slice(s) cancelled by brigadier received SIGINT: b, c",
    });
  });

  test("an interrupted run still merges what landed, removes every worktree, and releases the refs", async () => {
    const controller = new AbortController();
    const runner = fakeRunner({
      onStart: (sliceId) => {
        if (sliceId === "a") {
          controller.abort(SIGINT_REASON);
        }
      },
    });
    const engine = fakeEngine();
    await execute(
      interruptibleRequest(
        planDocument([slice("a"), slice("b")]),
        1,
        controller.signal,
      ),
      engine,
      runner,
    );

    expect(engine.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "merge brigadier/demo/slice-1",
      "remove brigadier/demo/slice-1",
      "release demo",
    ]);
  });

  test("the run's signal is what each slice run input carries", async () => {
    const controller = new AbortController();
    const runner = fakeRunner();
    const harness = await execute(
      interruptibleRequest(planDocument([slice("a")]), 1, controller.signal),
      fakeEngine(),
      runner,
    );
    expect(harness.runner.inputs()).toHaveLength(1);
    expect(harness.runner.inputs()[0]?.signal).toBe(controller.signal);
  });

  test("a run given no signal hands none down and reports interrupted false", async () => {
    const harness = await execute(
      runRequest(planDocument([slice("a")]), 1),
      fakeEngine(),
      fakeRunner(),
    );
    expect(harness.runner.inputs()[0]?.signal).toBeUndefined();
    expect(harness.report.interrupted).toBe(false);
  });

  /**
   * A later wave cannot currently exist: `validatePlan` refuses any slice
   * declaring `dependsOn` with `DEPENDENCIES_UNSUPPORTED`, so every schedulable
   * plan is exactly one wave. The wave-level guard is still reachable when an
   * abort lands during `prepare`; the test below proves that first wave never
   * starts. The per-slice guard above covers an abort after a wave has started.
   */

  test("an abort during prepare starts no slice and reports every slice cancelled", async () => {
    const controller = new AbortController();
    const engine = fakeEngine({
      onPrepare: () => {
        controller.abort(SIGINT_REASON);
      },
    });
    const harness = await execute(
      interruptibleRequest(
        planDocument([slice("a"), slice("b")]),
        2,
        controller.signal,
      ),
      engine,
      fakeRunner(),
    );

    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "release demo",
    ]);
    expect(harness.runner.inputs()).toEqual([]);
    // Start, two routing brackets per slice, and finish: entering the wave
    // would add one `now()` call for each slice before its per-slice guard.
    expect(harness.nowCalls()).toBe(6);
    expect(harness.report).toEqual({
      ok: false,
      slug: "demo",
      dryRun: false,
      interrupted: true,
      cleanupFailures: [],
      integrationBranch: null,
      slices: [
        {
          sliceId: "a",
          ok: false,
          cancelled: true,
          branch: null,
          commit: null,
          worktree: null,
          attempts: [],
        },
        {
          sliceId: "b",
          ok: false,
          cancelled: true,
          branch: null,
          commit: null,
          worktree: null,
          attempts: [],
        },
      ],
      merges: [],
      planIssues: [],
      failure: {
        reason: "SLICE_FAILED",
        message: "2 slice(s) cancelled by brigadier received SIGINT: a, b",
      },
      durationMs: 0,
    });
  });

  test("cancelled slices are counted apart from slices that failed on their own", async () => {
    const controller = new AbortController();
    const runner = fakeRunner({
      failing: ["a"],
      onStart: (sliceId) => {
        if (sliceId === "a") {
          controller.abort(SIGINT_REASON);
        }
      },
    });
    const harness = await execute(
      interruptibleRequest(
        planDocument([slice("a"), slice("b"), slice("c")]),
        1,
        controller.signal,
      ),
      fakeEngine(),
      runner,
    );

    expect(harness.report.slices[0]?.cancelled).toBeUndefined();
    expect(harness.report.slices[1]?.cancelled).toBe(true);
    expect(harness.report.slices[2]?.cancelled).toBe(true);
    expect(harness.report.failure).toEqual({
      reason: "SLICE_FAILED",
      message:
        "1 slice(s) did not complete: a; 2 slice(s) cancelled by brigadier received SIGINT: b, c",
    });
  });

  test("an abort landing before prepare writes no ref at all", async () => {
    const controller = new AbortController();
    controller.abort(SIGINT_REASON);
    const engine = forbiddenEngine();
    const harness = await execute(
      interruptibleRequest(
        planDocument([slice("a"), slice("b")]),
        2,
        controller.signal,
      ),
      engine,
      fakeRunner(),
    );

    expect(harness.ops).toEqual([]);
    expect(harness.runner.inputs()).toEqual([]);
    expect(harness.report.interrupted).toBe(true);
    expect(harness.report.integrationBranch).toBeNull();
    expect(harness.report.failure).toEqual({
      reason: "SLICE_FAILED",
      message:
        "run interrupted before any ref was written: brigadier received SIGINT",
    });
    // The pre-flight routing already done is kept rather than discarded.
    for (const index of [0, 1]) {
      const result = harness.report.slices[index];
      expect(result?.cancelled).toBe(true);
      expect(result?.attempts).toHaveLength(1);
      expect(result?.attempts[0]?.routed?.model).toBe("claude-sonnet-5");
      expect(result?.attempts[0]?.failure).toBeNull();
    }
  });
});

describe("releasing the session's refs", () => {
  test("release runs after every remove, even when a remove throws", async () => {
    const engine = fakeEngine({
      removeThrows: ["brigadier/demo/slice-1"],
    });
    const harness = await execute(
      runRequest(planDocument([slice("a"), slice("b")]), 2),
      engine,
      fakeRunner(),
    );

    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "merge brigadier/demo/slice-1",
      "merge brigadier/demo/slice-3",
      "remove brigadier/demo/slice-1",
      "remove brigadier/demo/slice-3",
      "release demo",
    ]);
    expect(harness.report.ok).toBe(true);
  });

  test("a release that throws is logged and leaves the run's verdict alone", async () => {
    const engine = fakeEngine({
      releaseThrows: "refusing to retire refs while a worktree is active",
    });
    const harness = await execute(
      runRequest(planDocument([slice("a")]), 1),
      engine,
      fakeRunner(),
    );

    expect(harness.log).toContain(
      "release demo: refusing to retire refs while a worktree is active",
    );
    // The run itself succeeded, and a failure to tidy up does not undo that.
    expect(harness.report.ok).toBe(true);
    expect(harness.report.failure).toBeNull();
    expect(harness.report.integrationBranch).toBe(INTEGRATION_BRANCH);
  });

  test("release is not called when prepare never produced a session", async () => {
    const engine = fakeEngine({ prepareError: "no repository here" });
    const harness = await execute(
      runRequest(planDocument([slice("a")]), 1),
      engine,
      fakeRunner(),
    );
    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
    ]);
    expect(harness.report.failure?.reason).toBe("PREPARE_FAILED");
  });

  /**
   * THE ONLY CASE `release` EXISTS FOR, AND THE ONE EVERY OTHER TEST IN THIS
   * FILE MISSES. `release` is a no-op once an integration branch has been
   * materialized, so in every run that merged something it is called and does
   * nothing — which means those tests would keep passing if the call were
   * deleted for exactly the runs that need it. A run where nothing merged is
   * the run that strands `brigadier/demo/base` and every slice ref, and it is
   * the run that cannot be re-attempted afterwards because `create` refuses a
   * branch that already exists.
   */
  test("the refs are released when nothing merged at all", async () => {
    const engine = fakeEngine();
    const harness = await execute(
      runRequest(planDocument([slice("a"), slice("b")]), 2),
      engine,
      fakeRunner({ failing: ["a", "b"] }),
    );

    // NOT ONE `merge` ENTRY, which is what makes this the counterfactual: with
    // no integration branch, `release` is the only thing that retires the base
    // and slice refs. There is no `remove` either, and that is correct rather
    // than missing — the orchestrator removes SURVIVORS, a run with none has
    // none, and each failed attempt's worktree was the runner's to remove.
    expect(harness.ops).toEqual([
      "prepare /repo/demo demo consent=true linked=0",
      "release demo",
    ]);
    expect(harness.report.ok).toBe(false);
    expect(harness.report.integrationBranch).toBeNull();
    expect(harness.report.merges).toEqual([]);
    expect(harness.report.cleanupFailures).toEqual([]);
    expect(harness.report.failure).toEqual({
      reason: "SLICE_FAILED",
      message: "2 slice(s) did not complete: a, b",
    });
  });
});

/**
 * Cleanup that failed is on the report, not merely in the log.
 *
 * A log line is a stream nobody can query. The renderer has to be able to say
 * "a worker may still be running" instead of "workers were cancelled", and it
 * can only do that from a field.
 */
describe("cleanup failures", () => {
  test("a failed remove and a failed release are both carried, in order", async () => {
    const engine = fakeEngine({
      removeThrows: ["brigadier/demo/slice-1"],
      releaseThrows: "refusing to retire refs while a worktree is active",
    });
    const harness = await execute(
      runRequest(planDocument([slice("a")]), 1),
      engine,
      fakeRunner(),
    );

    expect(harness.report.cleanupFailures).toEqual([
      "cleanup a: remove exploded for brigadier/demo/slice-1",
      "release demo: refusing to retire refs while a worktree is active",
    ]);
    // The run's own verdict is untouched by a failure to tidy up.
    expect(harness.report.ok).toBe(true);
    expect(harness.report.failure).toBeNull();
  });

  test("cleanup the runner could not finish is carried beside the orchestrator's own", async () => {
    const engine = fakeEngine({ releaseThrows: "refs are pinned" });
    const harness = await execute(
      runRequest(planDocument([slice("a")]), 1),
      engine,
      fakeRunner({
        failing: ["a"],
        cleanupFailures: {
          a: [
            "slice a attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running",
          ],
        },
      }),
    );

    expect(harness.report.cleanupFailures).toEqual([
      "slice a attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running",
      "release demo: refs are pinned",
    ]);
  });

  test("a slice that leaked on attempt 1 and then succeeded still reports the leak", async () => {
    const harness = await execute(
      runRequest(planDocument([slice("a")]), 1),
      fakeEngine(),
      fakeRunner({
        cleanupFailures: { a: ["slice a attempt 1: worktree survived"] },
      }),
    );

    expect(harness.report.slices[0]?.ok).toBe(true);
    expect(harness.report.cleanupFailures).toEqual([
      "slice a attempt 1: worktree survived",
    ]);
  });

  test("an ordinary run reports no cleanup failures at all", async () => {
    const harness = await execute(
      runRequest(planDocument([slice("a"), slice("b")]), 2),
      fakeEngine(),
      fakeRunner(),
    );
    expect(harness.report.cleanupFailures).toEqual([]);
  });
});

/* --------------------------- scaffold removal ---------------------------- */

/**
 * The two directories a run's worktree paths are built under.
 *
 * `allocateAttemptSlots` composes `<repo>-brigadier/<slug>/slice-N`, so every
 * run creates two directories above the worktrees themselves. The engine
 * removes each worktree and nothing removed those two, which left an empty
 * `<repo>-brigadier/<slug>/` beside the user's repository after every run —
 * successful, failed, and interrupted alike.
 *
 * THESE TESTS TOUCH A REAL FILESYSTEM ON PURPOSE. The claim is about what is on
 * disk when the run returns, and every other test in this file runs against
 * `/repo/demo`, a path that has never existed. A fake that recorded an intent to
 * remove would prove the orchestrator meant to, which is exactly what the
 * previous version of this file already proved about worktrees while the
 * scaffold sat there.
 */
const scaffoldTemporaries: string[] = [];

afterAll(async () => {
  for (const directory of scaffoldTemporaries) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface Scaffold {
  /** The `mkdtemp` root. Nothing this suite writes lives outside it. */
  readonly root: string;
  readonly repositoryPath: string;
  /** `<repo>-brigadier`, the directory shared by every slug. */
  readonly parent: string;
  /** `<repo>-brigadier/<slug>`, this run's own. */
  readonly slugDirectory: string;
  /** The worktree path the orchestrator will allocate for slice index 0. */
  readonly firstWorktree: string;
}

async function makeScaffold(): Promise<Scaffold> {
  const root = await mkdtemp(join(tmpdir(), "brigadier-scaffold-"));
  scaffoldTemporaries.push(root);
  const repositoryPath = join(root, "demo");
  await mkdir(repositoryPath, { recursive: true });
  const parent = join(root, "demo-brigadier");
  const slugDirectory = join(parent, SLUG);
  return {
    root,
    repositoryPath,
    parent,
    slugDirectory,
    firstWorktree: join(slugDirectory, "slice-1"),
  };
}

function scaffoldRequest(
  scaffold: Scaffold,
  slices: readonly Slice[],
): RunRequest {
  return {
    document: planDocument(slices),
    repositoryPath: scaffold.repositoryPath,
    slug: SLUG,
    maxWorkers: 1,
  };
}

/** An engine whose `remove` really deletes the worktree, as the real one does. */
function diskEngine(): FakeEngine {
  return fakeEngine({
    onRemove: async (worktree: CreatedWorktree): Promise<void> => {
      await rm(worktree.path, { recursive: true, force: true });
    },
  });
}

describe("scaffold removal", () => {
  test("an empty scaffold is gone from disk when the run returns", async () => {
    const scaffold = await makeScaffold();
    await mkdir(scaffold.firstWorktree, { recursive: true });

    const harness = await execute(
      scaffoldRequest(scaffold, [slice("a")]),
      diskEngine(),
      fakeRunner(),
    );

    expect(harness.report.ok).toBe(true);
    expect(harness.report.cleanupFailures).toEqual([]);
    expect(existsSync(scaffold.firstWorktree)).toBe(false);
    expect(existsSync(scaffold.slugDirectory)).toBe(false);
    expect(existsSync(scaffold.parent)).toBe(false);
    // The exact remaining listing, not merely "the scaffold is absent": a
    // removal that walked one directory too far would take `demo` with it.
    expect((await readdir(scaffold.root)).sort()).toEqual(["demo"]);
    expect((await readdir(scaffold.repositoryPath)).sort()).toEqual([]);
  });

  /**
   * THE LOAD-BEARING HALF, AND THE REASON THE REMOVAL IS `rmdir` AND NEVER `rm
   * -r`. `rmdir` fails with ENOTEMPTY when anything remains, and that failure IS
   * the safety property: it is what guarantees brigadier cannot delete a user's
   * files by walking a path it computed. A recursive delete would pass the test
   * above and destroy the file below.
   */
  test("a scaffold directory holding anything else survives untouched", async () => {
    const scaffold = await makeScaffold();
    await mkdir(scaffold.firstWorktree, { recursive: true });
    const bystander = join(scaffold.slugDirectory, "notes.txt");
    await writeFile(bystander, "DO NOT DELETE ME\n");

    const harness = await execute(
      scaffoldRequest(scaffold, [slice("a")]),
      diskEngine(),
      fakeRunner(),
    );

    // Asserted first because it is the whole point: the file is there, byte for
    // byte, and its directory is still standing.
    expect(await readFile(bystander, "utf8")).toBe("DO NOT DELETE ME\n");
    expect((await readdir(scaffold.slugDirectory)).sort()).toEqual([
      "notes.txt",
    ]);
    expect((await readdir(scaffold.parent)).sort()).toEqual([SLUG]);
    expect((await readdir(scaffold.root)).sort()).toEqual([
      "demo",
      "demo-brigadier",
    ]);
    // ENOTEMPTY is the expected answer here, not a failure to report.
    expect(harness.report.cleanupFailures).toEqual([]);
    expect(harness.report.ok).toBe(true);
  });

  test("the shared parent survives while another slug still owns a directory", async () => {
    const scaffold = await makeScaffold();
    await mkdir(scaffold.firstWorktree, { recursive: true });
    const otherRun = join(scaffold.parent, "other-run");
    await mkdir(join(otherRun, "slice-1"), { recursive: true });

    const harness = await execute(
      scaffoldRequest(scaffold, [slice("a")]),
      diskEngine(),
      fakeRunner(),
    );

    expect(existsSync(scaffold.slugDirectory)).toBe(false);
    expect((await readdir(scaffold.parent)).sort()).toEqual(["other-run"]);
    expect((await readdir(otherRun)).sort()).toEqual(["slice-1"]);
    expect(harness.report.cleanupFailures).toEqual([]);
  });

  test("a failed run leaves no scaffold behind either", async () => {
    const scaffold = await makeScaffold();
    // A failing slice returns no worktree handle, so its own runner removed the
    // directory; only the scaffold above it is left to deal with.
    await mkdir(scaffold.slugDirectory, { recursive: true });

    const harness = await execute(
      scaffoldRequest(scaffold, [slice("a")]),
      diskEngine(),
      fakeRunner({ failing: ["a"] }),
    );

    expect(harness.report.ok).toBe(false);
    expect(existsSync(scaffold.slugDirectory)).toBe(false);
    expect(existsSync(scaffold.parent)).toBe(false);
    expect((await readdir(scaffold.root)).sort()).toEqual(["demo"]);
    expect(harness.report.cleanupFailures).toEqual([]);
  });

  test("an interrupted run leaves no scaffold behind either", async () => {
    const scaffold = await makeScaffold();
    await mkdir(scaffold.firstWorktree, { recursive: true });
    const controller = new AbortController();

    const harness = await execute(
      {
        ...scaffoldRequest(scaffold, [slice("a")]),
        signal: controller.signal,
      },
      diskEngine(),
      fakeRunner({
        onStart: () => {
          controller.abort(new Error("SIGINT"));
        },
      }),
    );

    expect(harness.report.interrupted).toBe(true);
    expect(existsSync(scaffold.slugDirectory)).toBe(false);
    expect(existsSync(scaffold.parent)).toBe(false);
    expect((await readdir(scaffold.root)).sort()).toEqual(["demo"]);
    expect(harness.report.cleanupFailures).toEqual([]);
  });

  /** `--unsafe-in-place` creates no scaffold at all; there is nothing to remove. */
  test("a run that never created a scaffold reports nothing to clean up", async () => {
    const scaffold = await makeScaffold();

    const harness = await execute(
      { ...scaffoldRequest(scaffold, [slice("a")]), unsafeInPlace: true },
      diskEngine(),
      fakeRunner(),
    );

    expect(harness.report.ok).toBe(true);
    expect(harness.report.cleanupFailures).toEqual([]);
    expect(existsSync(scaffold.parent)).toBe(false);
    expect((await readdir(scaffold.root)).sort()).toEqual(["demo"]);
  });
});
