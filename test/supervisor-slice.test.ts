import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { BrigadierConfig } from "../src/config/contracts.js";
import { CONFIG_VERSION } from "../src/config/contracts.js";
import type {
  CancelReason,
  ClaudeWorkerSpec,
  CodexWorkerSpec,
  LaunchedWorkerOutcome,
  QuotaSnapshot,
  Slice,
  SpawnedWorker,
  TokenUsage,
  Worker,
  WorkerEvent,
  WorkerSpec,
} from "../src/contracts.js";
import type {
  ClaudeQuotaOracle,
  ClaudeQuotaWorkerEvent,
  CodexQuotaOracle,
} from "../src/quota/contracts.js";
import type {
  RoutedWorker,
  RoutingDecision,
  RoutingInput,
  RoutingRequest,
} from "../src/routing/contracts.js";
import type { DetachedProcess } from "../src/shared/process.js";
import type {
  AttemptSlot,
  RunInterruption,
  SliceAttempt,
  SliceDirective,
  SliceResult,
  SliceRunInput,
  SupervisorPorts,
} from "../src/supervisor/contracts.js";
import {
  createSliceRunner,
  DefaultSliceRunner,
  type LaunchEnv,
  requireLaunchEnv,
} from "../src/supervisor/slice.js";
import { WorkerLifecycle } from "../src/worker/lifecycle.js";
import type {
  CommitResult,
  CommitSpec,
  CreatedWorktree,
  MergeResult,
  WorktreeEngine,
  WorktreeSession,
  WorktreeSpec,
} from "../src/worktree/contracts.js";
import { NoChangesToCommitError } from "../src/worktree/engine.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV: LaunchEnv = {
  HOME: "/Users/worker",
  PATH: "/opt/brigadier/bin:/usr/bin:/bin",
  USER: "worker",
};

const SLICE: Slice = {
  id: "slice-auth",
  title: "Implement authentication",
  prompt: "Implement the authentication flow and its focused tests.",
  ownedPaths: ["src/added.ts"],
  dependsOn: [],
};

const DIRECTIVE: SliceDirective = {
  sliceId: "slice-auth",
  difficulty: "hard",
};

const CONFIG: BrigadierConfig = {
  version: CONFIG_VERSION,
  vendors: [
    {
      vendor: "claude",
      executable: "/opt/claude/bin/claude",
      version: "2.1.224",
      defaultModel: "claude-opus-5",
      models: [
        { id: "claude-opus-5", effortCeiling: "xhigh" },
        { id: "claude-haiku-4", effortCeiling: "high" },
      ],
    },
    {
      vendor: "codex",
      executable: "/opt/codex/bin/codex",
      version: "0.145.0",
      defaultModel: "gpt-5.6-sol",
      models: [{ id: "gpt-5.6-sol", effortCeiling: "xhigh" }],
    },
  ],
  secretsConsent: true,
  allowDegradedRouting: false,
};

const ROUTING: RoutingInput = {
  config: CONFIG,
  capabilities: [],
  quota: [],
};

const OPUS: RoutedWorker = {
  vendor: "claude",
  model: "claude-opus-5",
  effort: "high",
  rationale: ["competence: 100"],
  waivedDifficultyFloor: false,
};

const HAIKU: RoutedWorker = {
  vendor: "claude",
  model: "claude-haiku-4",
  effort: "xhigh",
  rationale: ["competence: 40"],
  waivedDifficultyFloor: true,
};

const SOL: RoutedWorker = {
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

const OK_OUTCOME: LaunchedWorkerOutcome = {
  ok: true,
  output: "done",
  usage: USAGE,
  durationMs: 1234,
  exitCode: 0,
  signal: null,
};

const FAILED_OUTCOME: LaunchedWorkerOutcome = {
  ok: false,
  output: "",
  usage: USAGE,
  durationMs: 99,
  exitCode: 1,
  signal: null,
  failure: {
    kind: "API_ERROR",
    message: "upstream returned 503",
    retryable: true,
    statusCode: 503,
  },
};

const CANCELLED_OUTCOME: LaunchedWorkerOutcome = {
  ok: false,
  output: "",
  usage: USAGE,
  durationMs: 0,
  exitCode: null,
  signal: null,
  failure: {
    kind: "CANCELLED",
    message: "fake worker cancellation completed",
    retryable: false,
    statusCode: null,
  },
};

/**
 * A failure the vendor itself calls permanent. `retryable: false` is the whole
 * point: bad credentials are the operator's, not the model's, so a second model
 * cannot fix them.
 */
const AUTH_FAILED_OUTCOME: LaunchedWorkerOutcome = {
  ok: false,
  output: "",
  usage: USAGE,
  durationMs: 42,
  exitCode: 1,
  signal: null,
  failure: {
    kind: "AUTH_FAILURE",
    message: "OAuth token expired",
    retryable: false,
    statusCode: 401,
  },
};

function quotaSnapshot(vendor: "claude" | "codex"): QuotaSnapshot {
  return {
    vendor,
    status: "available",
    observedAtMs: 1_700_000_000_000,
    windows: [],
    isUsingOverage: null,
  };
}

const CLAUDE_QUOTA_EVENT: ClaudeQuotaWorkerEvent = {
  type: "quota",
  raw: { vendor: "claude" },
  snapshot: {
    vendor: "claude",
    status: "available",
    observedAtMs: 1_700_000_000_000,
    windows: [],
    isUsingOverage: null,
  },
};

const CODEX_QUOTA_EVENT: WorkerEvent = {
  type: "quota",
  raw: { vendor: "codex" },
  snapshot: quotaSnapshot("codex"),
};

const MESSAGE_EVENT: WorkerEvent = {
  type: "message",
  raw: { text: "working" },
  text: "working",
};

// ---------------------------------------------------------------------------
// Temp world
// ---------------------------------------------------------------------------

const temporaries: string[] = [];

afterAll(async () => {
  for (const directory of temporaries) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface World {
  readonly root: string;
  readonly session: WorktreeSession;
  readonly slots: readonly [AttemptSlot, AttemptSlot];
}

async function makeWorld(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "brigadier-slice-"));
  temporaries.push(root);
  const session: WorktreeSession = {
    repositoryPath: join(root, "repo"),
    slug: "wo-011",
    baseCommit: "0".repeat(40),
    baseBranch: "brigadier/wo-011/base",
    integrationBranch: "brigadier/wo-011/integration",
  };
  await mkdir(session.repositoryPath, { recursive: true });
  return {
    root,
    session,
    slots: [
      { sliceNumber: 7, worktreePath: join(root, "wt", "slice-7") },
      { sliceNumber: 8, worktreePath: join(root, "wt", "slice-8") },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fakes. Every one of them is bounded: no promise here waits on wall-clock and
// no iterable here is infinite, so broken code produces a failing test rather
// than a suite that never reports.
// ---------------------------------------------------------------------------

class FakeEngine implements WorktreeEngine {
  readonly creates: WorktreeSpec[] = [];
  readonly commits: CommitSpec[] = [];
  readonly removes: CreatedWorktree[] = [];
  createError: Error | null = null;
  commitError: Error | null = null;
  removeError: Error | null = null;
  onCommit: (() => void) | null = null;
  /** Fires after the worktree exists and before the runner can spawn into it. */
  onCreate: (() => void) | null = null;
  #commits = 0;

  prepare(): Promise<WorktreeSession> {
    return Promise.reject(
      new Error("the slice runner must never call engine.prepare"),
    );
  }

  async create(spec: WorktreeSpec): Promise<CreatedWorktree> {
    this.creates.push(spec);
    if (this.createError !== null) {
      throw this.createError;
    }
    const path =
      spec.unsafeInPlace === true
        ? spec.session.repositoryPath
        : (spec.path ?? spec.session.repositoryPath);
    await mkdir(path, { recursive: true });
    this.onCreate?.();
    return {
      repositoryPath: spec.session.repositoryPath,
      path,
      branch: `brigadier/${spec.session.slug}/slice-${spec.slice}`,
      isolated: spec.unsafeInPlace !== true,
      session: spec.session,
    };
  }

  async commit(spec: CommitSpec): Promise<CommitResult> {
    this.commits.push(spec);
    this.onCommit?.();
    if (this.commitError !== null) {
      throw this.commitError;
    }
    this.#commits += 1;
    return { commit: `commit-${this.#commits}`, message: spec.message };
  }

  merge(): Promise<MergeResult> {
    return Promise.reject(
      new Error("the slice runner must never call engine.merge"),
    );
  }

  redact(_worktree: CreatedWorktree, artifact: string): string {
    return artifact;
  }

  async remove(worktree: CreatedWorktree): Promise<void> {
    this.removes.push(worktree);
    if (this.removeError !== null) {
      throw this.removeError;
    }
    await rm(worktree.path, { recursive: true, force: true });
  }

  /**
   * Retiring the session's refs is the orchestrator's step 8, never the
   * runner's, so reaching it from here is a defect worth failing on. It is a
   * required member of `WorktreeEngine`, which is why the rejection is the
   * implementation rather than the method being absent.
   */
  release(): Promise<void> {
    return Promise.reject(
      new Error("the slice runner must never call engine.release"),
    );
  }
}

interface SpawnScript {
  readonly events?: readonly WorkerEvent[];
  readonly outcome?: LaunchedWorkerOutcome;
  /** Resolve `completion` only once `events` has been consumed to exhaustion. */
  readonly completionAfterDrain?: boolean;
  readonly completionError?: Error;
  readonly spawnError?: Error;
  readonly onSpawn?: (spec: WorkerSpec) => Promise<void>;
  /**
   * Runs after `events[index]` has been yielded, so a test can abort the run
   * from a point that is provably inside the runner's wait rather than before
   * it. NOTHING HERE EVER BLOCKS: the generator still finishes, so a runner
   * that ignores the signal completes normally and the test fails on an
   * assertion instead of hanging the suite.
   */
  readonly onEvent?: (index: number) => void;
  /** Makes `cancel` reject, so the runner's own failure note can be asserted. */
  readonly cancelError?: Error;
}

interface FakeAdapter<V extends "claude" | "codex"> {
  readonly worker: Worker<V>;
  readonly specs: readonly WorkerSpec[];
  drainedCount(): number;
  /** Every `cancel` reason, in call order. Empty when nothing was cancelled. */
  cancels(): readonly CancelReason[];
}

function launch(
  script: SpawnScript,
  onDrained: () => void,
  onCancel: (reason: CancelReason) => void,
): SpawnedWorker {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: AsyncIterable<WorkerEvent> = {
    [Symbol.asyncIterator]: async function* iterate() {
      for (const [index, event] of (script.events ?? []).entries()) {
        yield event;
        script.onEvent?.(index);
      }
      onDrained();
      release();
    },
  };
  const started =
    script.completionAfterDrain === true ? gate : Promise.resolve();
  const completion = started.then((): LaunchedWorkerOutcome => {
    if (script.completionError !== undefined) {
      throw script.completionError;
    }
    return script.outcome ?? OK_OUTCOME;
  });
  return {
    pid: 4242,
    events,
    completion,
    cancel: (reason: CancelReason) => {
      onCancel(reason);
      return script.cancelError === undefined
        ? Promise.resolve()
        : Promise.reject(script.cancelError);
    },
  };
}

function scriptFor(
  scripts: readonly SpawnScript[],
  index: number,
): SpawnScript {
  const script = scripts[index];
  if (script === undefined) {
    throw new Error(
      `the fake adapter has no script for spawn ${index + 1}; it was given ${scripts.length}`,
    );
  }
  return script;
}

function claudeAdapter(scripts: readonly SpawnScript[]): FakeAdapter<"claude"> {
  const specs: ClaudeWorkerSpec[] = [];
  const cancels: CancelReason[] = [];
  let drained = 0;
  return {
    specs,
    drainedCount: () => drained,
    cancels: () => cancels,
    worker: {
      vendor: "claude",
      processCompletion: "signals-then-must-be-killed",
      spawn: async (spec: ClaudeWorkerSpec): Promise<SpawnedWorker> => {
        const script = scriptFor(scripts, specs.length);
        specs.push(spec);
        if (script.spawnError !== undefined) {
          throw script.spawnError;
        }
        await script.onSpawn?.(spec);
        return launch(
          script,
          () => {
            drained += 1;
          },
          (reason) => {
            cancels.push(reason);
          },
        );
      },
    },
  };
}

function codexAdapter(scripts: readonly SpawnScript[]): FakeAdapter<"codex"> {
  const specs: CodexWorkerSpec[] = [];
  const cancels: CancelReason[] = [];
  let drained = 0;
  return {
    specs,
    drainedCount: () => drained,
    cancels: () => cancels,
    worker: {
      vendor: "codex",
      processCompletion: "self-exits",
      spawn: async (spec: CodexWorkerSpec): Promise<SpawnedWorker> => {
        const script = scriptFor(scripts, specs.length);
        specs.push(spec);
        if (script.spawnError !== undefined) {
          throw script.spawnError;
        }
        await script.onSpawn?.(spec);
        return launch(
          script,
          () => {
            drained += 1;
          },
          (reason) => {
            cancels.push(reason);
          },
        );
      },
    },
  };
}

interface ShutdownThrowingAdapter extends FakeAdapter<"claude"> {
  completion(): Promise<LaunchedWorkerOutcome>;
  shutdownCalls(): number;
}

/**
 * Uses the real lifecycle seam from both production adapters. Its injected
 * shutdown throws exactly as `shutdownProcessGroup` does after a surviving
 * SIGKILL, so `cancel` resolves only after completion settles UNKNOWN_FAILURE.
 */
function shutdownThrowingAdapter(
  controller: AbortController,
): ShutdownThrowingAdapter {
  const specs: ClaudeWorkerSpec[] = [];
  const cancels: CancelReason[] = [];
  let drained = 0;
  let shutdowns = 0;
  let launchedCompletion: Promise<LaunchedWorkerOutcome> | null = null;
  return {
    specs,
    drainedCount: () => drained,
    cancels: () => cancels,
    shutdownCalls: () => shutdowns,
    completion: () => {
      if (launchedCompletion === null) {
        throw new Error("the shutdown-throwing adapter has not spawned");
      }
      return launchedCompletion;
    },
    worker: {
      vendor: "claude",
      processCompletion: "signals-then-must-be-killed",
      spawn: async (spec: ClaudeWorkerSpec): Promise<SpawnedWorker> => {
        specs.push(spec);
        const processHandle = {
          pid: 4242,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        } as unknown as DetachedProcess;
        const lifecycle = new WorkerLifecycle({
          processHandle,
          idleTimeoutMs: 60_000,
          timeoutMs: null,
          cancellationOutcome: (reason) => ({
            ok: false,
            output: "",
            usage: USAGE,
            durationMs: 0,
            exitCode: null,
            signal: null,
            failure: {
              kind: "CANCELLED",
              message: reason.message ?? "worker cancelled",
              retryable: false,
              statusCode: null,
            },
          }),
          unexpectedFailureOutcome: (error) => ({
            ok: false,
            output: "",
            usage: USAGE,
            durationMs: 0,
            exitCode: null,
            signal: null,
            failure: {
              kind: "UNKNOWN_FAILURE",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
              statusCode: null,
            },
          }),
          shutdown: async () => {
            shutdowns += 1;
            throw new Error("process group 4242 survived SIGKILL");
          },
        });
        launchedCompletion = lifecycle.completion;
        return {
          pid: 4242,
          events: {
            [Symbol.asyncIterator]: async function* iterate() {
              yield MESSAGE_EVENT;
              controller.abort(SIGINT_REASON);
              drained += 1;
            },
          },
          completion: lifecycle.completion,
          cancel: async (reason) => {
            cancels.push(reason);
            await lifecycle.cancel(reason);
          },
        };
      },
    },
  };
}

interface FakeClaudeOracle {
  readonly oracle: ClaudeQuotaOracle;
  readonly ingested: readonly ClaudeQuotaWorkerEvent[];
}

function claudeOracleFake(ingestError?: Error): FakeClaudeOracle {
  const ingested: ClaudeQuotaWorkerEvent[] = [];
  return {
    ingested,
    oracle: {
      vendor: "claude",
      snapshot: () =>
        Promise.resolve({ ...quotaSnapshot("claude"), vendor: "claude" }),
      dispose: () => Promise.resolve(),
      ingest: (event: ClaudeQuotaWorkerEvent) => {
        ingested.push(event);
        if (ingestError !== undefined) {
          throw ingestError;
        }
      },
    },
  };
}

const CODEX_ORACLE: CodexQuotaOracle = {
  vendor: "codex",
  snapshot: () =>
    Promise.resolve({ ...quotaSnapshot("codex"), vendor: "codex" }),
  dispose: () => Promise.resolve(),
};

interface Harness {
  readonly ports: SupervisorPorts;
  readonly engine: FakeEngine;
  readonly logs: readonly string[];
  readonly routeRequests: RoutingRequest[];
}

/** Keeps each adapter correlated with its own vendor, exactly as `AnyWorker` does. */
interface WorkerMap {
  readonly claude?: Worker<"claude">;
  readonly codex?: Worker<"codex">;
}

interface HarnessOptions {
  readonly engine?: FakeEngine;
  readonly workers?: WorkerMap;
  readonly oracles?: readonly (ClaudeQuotaOracle | CodexQuotaOracle)[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const engine = options.engine ?? new FakeEngine();
  const logs: string[] = [];
  const routeRequests: RoutingRequest[] = [];
  return {
    engine,
    logs,
    routeRequests,
    ports: {
      engine,
      workerFor: (vendor) => options.workers?.[vendor] ?? null,
      oracles: options.oracles ?? [],
      // A deterministic clock: every call advances by exactly 5 ms, so an
      // attempt that calls it twice reports exactly 5 ms.
      now: makeClock(),
      log: (line) => {
        logs.push(line);
      },
    },
  };
}

function makeClock(): () => number {
  let value = 1_000_000;
  return () => {
    value += 5;
    return value;
  };
}

/** Route stub that also records the exact request it was handed. */
function stubRoute(
  decisions: readonly RoutingDecision[],
  sink: RoutingRequest[],
): (request: RoutingRequest, input: RoutingInput) => RoutingDecision {
  return (request) => {
    sink.push(request);
    const decision = decisions[sink.length - 1];
    if (decision === undefined) {
      throw new Error(
        `the route stub has no decision for call ${sink.length}; it was given ${decisions.length}`,
      );
    }
    return decision;
  };
}

function routedTo(routed: RoutedWorker): RoutingDecision {
  return { ok: true, routed };
}

const ROUTING_MISS: RoutingDecision = {
  ok: false,
  reason: "NO_CAPABLE_MODEL",
  message: "no configured model clears the hard floor for slice-auth",
  rejected: [
    {
      vendor: "claude",
      model: "claude-haiku-4",
      stage: "competence",
      reason: "scored 40, below the hard floor of 90",
    },
  ],
};

/**
 * Bound every run. A runner that awaits `completion` before draining `events`
 * would otherwise hang the whole suite instead of failing one test.
 */
async function withBound<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, bound]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** The single-attempt slot list, without an `!` and without a silent fallback. */
function firstSlot(world: World): readonly [AttemptSlot] {
  return [world.slots[0]];
}

function attemptAt(result: SliceResult, index: number): SliceAttempt {
  const attempt = result.attempts[index];
  if (attempt === undefined) {
    throw new Error(
      `expected at least ${index + 1} attempt(s), saw ${result.attempts.length}`,
    );
  }
  return attempt;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Routing and escalation
// ---------------------------------------------------------------------------

describe("DefaultSliceRunner routing", () => {
  test("attempt 2 excludes attempt 1's exact (vendor, model) pair and escalates", async () => {
    const world = await makeWorld();
    const harness = makeHarness({
      workers: {
        claude: claudeAdapter([
          { outcome: FAILED_OUTCOME },
          { outcome: OK_OUTCOME },
        ]).worker,
      },
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(harness.routeRequests.length).toBe(2);
    const first = harness.routeRequests[0];
    const second = harness.routeRequests[1];
    expect(first?.excluded).toBeUndefined();
    expect(first?.escalated).toBeUndefined();
    expect(first?.difficulty).toBe("hard");
    expect(second?.excluded).toEqual([
      { vendor: "claude", model: "claude-opus-5" },
    ]);
    expect(second?.escalated).toBe(true);
  });

  test("the real router sends attempt 2 to a different model than attempt 1", async () => {
    const world = await makeWorld();
    const claude = claudeAdapter([{ outcome: OK_OUTCOME }]);
    const codex = codexAdapter([{ outcome: FAILED_OUTCOME }]);
    const harness = makeHarness({
      workers: { claude: claude.worker, codex: codex.worker },
    });
    // No `route` override: this drives the real router end to end.
    const runner = new DefaultSliceRunner({ ports: harness.ports, env: ENV });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(attemptAt(result, 0).routed?.vendor).toBe("codex");
    expect(attemptAt(result, 0).routed?.model).toBe("gpt-5.6-sol");
    expect(attemptAt(result, 1).routed?.vendor).toBe("claude");
    expect(attemptAt(result, 1).routed?.model).toBe("claude-opus-5");
    expect(attemptAt(result, 1).routed?.effort).toBe("xhigh");
  });

  test("a routing failure carries reason, message and rejected intact", async () => {
    const world = await makeWorld();
    const harness = makeHarness();
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([ROUTING_MISS, ROUTING_MISS], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(false);
    expect(result.branch).toBe(null);
    expect(result.worktree).toBe(null);
    expect(result.commit).toBe(null);
    expect(result.attempts.length).toBe(2);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "ROUTING_FAILED",
      message: "no configured model clears the hard floor for slice-auth",
      reason: "NO_CAPABLE_MODEL",
      rejected: [
        {
          vendor: "claude",
          model: "claude-haiku-4",
          stage: "competence",
          reason: "scored 40, below the hard floor of 90",
        },
      ],
    });
    expect(attemptAt(result, 0).routed).toBe(null);
    expect(harness.engine.creates.length).toBe(0);
  });

  test("a route that throws becomes a ROUTING_FAILED record, not a rejection", async () => {
    const world = await makeWorld();
    const harness = makeHarness();
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: () => {
        throw new RangeError("minContextWindowTokens must be a whole number");
      },
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(false);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "ROUTING_FAILED",
      message:
        "routing request for slice slice-auth was rejected: minContextWindowTokens must be a whole number",
      reason: "NO_CAPABLE_MODEL",
      rejected: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Attempt slots
// ---------------------------------------------------------------------------

describe("DefaultSliceRunner attempt slots", () => {
  test("attempt 2 uses slot 1's sliceNumber and worktreePath", async () => {
    const world = await makeWorld();
    const harness = makeHarness({
      workers: {
        claude: claudeAdapter([
          { outcome: FAILED_OUTCOME },
          { outcome: FAILED_OUTCOME },
        ]).worker,
      },
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(
      harness.engine.creates.map((spec) => ({
        slice: spec.slice,
        path: spec.path,
        unsafeInPlace: spec.unsafeInPlace,
      })),
    ).toEqual([
      {
        slice: 7,
        path: join(world.root, "wt", "slice-7"),
        unsafeInPlace: false,
      },
      {
        slice: 8,
        path: join(world.root, "wt", "slice-8"),
        unsafeInPlace: false,
      },
    ]);
    expect(result.branch).toBe("brigadier/wo-011/slice-8");
  });

  test("attempt slots reject empty and three-slot tuples", () => {
    const common = {
      slice: SLICE,
      directive: DIRECTIVE,
      session: {
        repositoryPath: "/repo/demo",
        slug: "wo-011",
        baseCommit: "0000000000000000000000000000000000000000",
        baseBranch: "brigadier/wo-011/base",
        integrationBranch: "brigadier/wo-011/integration",
      },
      routing: ROUTING,
      unsafeInPlace: false,
    } as const;
    const threeSlots = [
      { sliceNumber: 1, worktreePath: "/worktrees/slice-1" },
      { sliceNumber: 2, worktreePath: "/worktrees/slice-2" },
      { sliceNumber: 3, worktreePath: "/worktrees/slice-3" },
    ] as const;

    // @ts-expect-error at least one attempt slot is required
    const empty: SliceRunInput = { ...common, attemptSlots: [] };
    // @ts-expect-error no more than two attempt slots are permitted
    const three: SliceRunInput = { ...common, attemptSlots: threeSlots };

    expect(Array.from(empty.attemptSlots).length).toBe(0);
    expect(Array.from(three.attemptSlots).length).toBe(3);
  });

  test("a worktree that cannot be created reports WORKTREE_FAILED with a null branch", async () => {
    const world = await makeWorld();
    const engine = new FakeEngine();
    engine.createError = new Error(
      "refusing to overwrite existing branch brigadier/wo-011/slice-7",
    );
    const harness = makeHarness({ engine });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(false);
    expect(result.branch).toBe(null);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      message: `could not create worktree for slice slice-auth attempt 1 at ${join(world.root, "wt", "slice-7")}: refusing to overwrite existing branch brigadier/wo-011/slice-7`,
    });
    expect(engine.removes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

describe("DefaultSliceRunner retry policy", () => {
  /**
   * `WorkerFailure.retryable` is the vendor's own verdict. `AUTH_FAILURE`
   * carries `false` because the cause is the operator's credentials, and no
   * second model has different credentials — so the second slot must not be
   * spent producing the same answer more slowly.
   */
  test("a non-retryable worker failure ends the slice after exactly one attempt", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{ outcome: AUTH_FAILED_OUTCOME }]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      // Two decisions are available on purpose: if a second attempt happened,
      // it would succeed here, so the assertion below is about the runner's
      // choice and not about running out of routes.
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        // Both slots offered; only the first may be used.
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(harness.routeRequests.length).toBe(1);
    expect(adapter.specs.length).toBe(1);
    expect(harness.engine.creates.length).toBe(1);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKER_FAILED",
      message:
        "slice slice-auth attempt 1: claude/claude-opus-5 failed with AUTH_FAILURE: OAuth token expired",
      failure: {
        kind: "AUTH_FAILURE",
        message: "OAuth token expired",
        retryable: false,
        statusCode: 401,
      },
    });
    expect(
      harness.logs.includes(
        "slice slice-auth attempt 1: not retrying a failure the worker reported as permanent",
      ),
    ).toBe(true);
  });

  /** The contrast: `retryable: true` still buys the second attempt. */
  test("a retryable worker failure still spends the second attempt", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([
      { outcome: FAILED_OUTCOME },
      { outcome: OK_OUTCOME },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(result.attempts.length).toBe(2);
    expect(adapter.specs.length).toBe(2);
  });

  /**
   * `excluded` means "this exact model already failed this exact slice". A
   * worktree that could not be created failed before any worker existed, so
   * naming the model there is a false claim AND it burns the slice's only
   * retry on a model the failure never implicated.
   */
  test("a failure before any worker ran leaves the model out of excluded", async () => {
    const world = await makeWorld();
    const engine = new FakeEngine();
    engine.createError = new Error(
      "refusing to overwrite existing branch brigadier/wo-011/slice-7",
    );
    const adapter = claudeAdapter([{ outcome: OK_OUTCOME }]);
    const harness = makeHarness({
      engine,
      workers: { claude: adapter.worker },
    });
    const decisions = [routedTo(OPUS), routedTo(OPUS)];
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: (request) => {
        harness.routeRequests.push(request);
        // Attempt 2 gets a working engine, so the SAME model can be handed
        // back and can actually finish the slice.
        if (harness.routeRequests.length === 2) {
          engine.createError = null;
        }
        const decision = decisions[harness.routeRequests.length - 1];
        if (decision === undefined) {
          throw new Error(
            `the route stub has no decision for call ${harness.routeRequests.length}`,
          );
        }
        return decision;
      },
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(result.attempts.length).toBe(2);
    expect(harness.routeRequests.length).toBe(2);
    // The whole point: attempt 2 is escalated but excludes nothing, because
    // claude-opus-5 was never actually tried.
    expect(harness.routeRequests[1]?.excluded).toBeUndefined();
    expect(harness.routeRequests[1]?.escalated).toBe(true);
    expect(attemptAt(result, 1).routed?.model).toBe("claude-opus-5");
  });

  /** And the converse: a model that really ran and failed is still excluded. */
  test("a model that actually ran and failed is excluded from the next attempt", async () => {
    const world = await makeWorld();
    const harness = makeHarness({
      workers: {
        claude: claudeAdapter([
          { outcome: FAILED_OUTCOME },
          { outcome: OK_OUTCOME },
        ]).worker,
      },
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
    });

    await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(harness.routeRequests[1]?.excluded).toEqual([
      { vendor: "claude", model: "claude-opus-5" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Owned-path pre-creation
// ---------------------------------------------------------------------------

describe("DefaultSliceRunner owned-path pre-creation", () => {
  test("missing owned paths exist at spawn and untouched placeholders are gone before commit", async () => {
    const world = await makeWorld();
    const worktree = join(world.root, "wt", "slice-7");
    const slice: Slice = {
      ...SLICE,
      ownedPaths: [
        "src/added.ts",
        "docs/deep/notes.md",
        "src/already-empty.ts",
      ],
    };
    // A file that already exists and is empty must survive: it is not ours to
    // delete, and `wx` is what tells the two apart.
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src", "already-empty.ts"), "");

    const spawnState: Record<string, boolean> = {};
    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          spawnState["src/added.ts"] = await exists(
            join(spec.cwd, "src", "added.ts"),
          );
          spawnState["docs/deep/notes.md"] = await exists(
            join(spec.cwd, "docs", "deep", "notes.md"),
          );
          // The worker edits one owned file and never touches the other.
          await writeFile(
            join(spec.cwd, "src", "added.ts"),
            "export const added = true;\n",
          );
        },
      },
    ]);
    const engine = new FakeEngine();
    // Sampled synchronously inside `commit`, so this asserts the ORDERING —
    // that the untouched placeholder was gone before the commit was taken, not
    // merely that it is gone by the time the run returns.
    const atCommit: Record<string, boolean> = {};
    engine.onCommit = () => {
      atCommit["src/added.ts"] = existsSync(join(worktree, "src", "added.ts"));
      atCommit["docs/deep/notes.md"] = existsSync(
        join(worktree, "docs", "deep", "notes.md"),
      );
      atCommit["src/already-empty.ts"] = existsSync(
        join(worktree, "src", "already-empty.ts"),
      );
    };
    const harness = makeHarness({
      engine,
      workers: { claude: adapter.worker },
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(spawnState).toEqual({
      "src/added.ts": true,
      "docs/deep/notes.md": true,
    });
    expect(atCommit).toEqual({
      "src/added.ts": true,
      "docs/deep/notes.md": false,
      "src/already-empty.ts": true,
    });
    // The successful worktree is left live, so its files can be inspected.
    expect(await readFile(join(worktree, "src", "added.ts"), "utf8")).toBe(
      "export const added = true;\n",
    );
    expect(await exists(join(worktree, "docs", "deep", "notes.md"))).toBe(
      false,
    );
    expect(await exists(join(worktree, "src", "already-empty.ts"))).toBe(true);
  });

  test("an owned path escaping the worktree root is refused before anything is created", async () => {
    const world = await makeWorld();
    const worktree = join(world.root, "wt", "slice-7");
    const adapter = claudeAdapter([]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: { ...SLICE, ownedPaths: ["src/ok.ts", "../escape.ts"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(false);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      message: `refusing to pre-create owned path "../escape.ts": it resolves to ${join(world.root, "wt", "escape.ts")}, outside worktree root ${worktree}`,
    });
    expect(adapter.specs.length).toBe(0);
    expect(await exists(join(world.root, "wt", "escape.ts"))).toBe(false);
    // The refusal happens before any file is created, so the safe sibling path
    // is not left behind either.
    expect(await exists(join(worktree, "src", "ok.ts"))).toBe(false);
    expect(harness.engine.removes.length).toBe(1);
  });

  /**
   * The lexical proof — `resolve` plus `relative` — never touches a disk, so a
   * symlinked directory component passes it and the placeholder is then written
   * wherever the link points. Real repositories contain symlinked directories,
   * so this needs no adversary: it is brigadier writing into a shared location
   * while believing the worker is isolated, which is the one guarantee the
   * worktree design exists to make.
   */
  test("an owned path under a symlinked directory is refused and nothing is written outside", async () => {
    const world = await makeWorld();
    const worktree = join(world.root, "wt", "slice-7");
    const outside = join(world.root, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(worktree, { recursive: true });
    // The ordinary shape: a directory inside the worktree is a link elsewhere.
    await symlink(outside, join(worktree, "src"), "dir");
    const realOutside = await realpath(outside);
    const realWorktree = await realpath(worktree);

    const adapter = claudeAdapter([]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: { ...SLICE, ownedPaths: ["docs/safe.md", "src/c.ts"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(false);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      message: `refusing to pre-create owned path "src/c.ts": an existing path component is a symbolic link leading to ${join(realOutside, "c.ts")}, outside worktree root ${realWorktree}`,
    });
    // The file the lexical check would have allowed does not exist.
    expect(await exists(join(outside, "c.ts"))).toBe(false);
    expect(await exists(join(realOutside, "c.ts"))).toBe(false);
    // Refused before any write, so the earlier safe path is not left behind.
    expect(await exists(join(worktree, "docs", "safe.md"))).toBe(false);
    expect(adapter.specs.length).toBe(0);
  });

  /**
   * The containment proof compares real paths against the REAL root, which
   * matters because on macOS the root is normally reached through a symlink
   * (`/var -> /private/var`, `/tmp -> /private/tmp`). Comparing a realpath'd
   * target against a lexical root would refuse every legitimate owned path on
   * the platform brigadier runs on.
   */
  test("a worktree root reached through a symlink still pre-creates its owned paths", async () => {
    const world = await makeWorld();
    const real = join(world.root, "real-wt");
    const linked = join(world.root, "linked-wt");
    await mkdir(real, { recursive: true });
    await symlink(real, linked, "dir");

    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          await writeFile(
            join(spec.cwd, "src", "added.ts"),
            "export const added = true;\n",
          );
        },
      },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: [{ sliceNumber: 7, worktreePath: linked }],
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(attemptAt(result, 0).failure).toBe(null);
    expect(await readFile(join(real, "src", "added.ts"), "utf8")).toBe(
      "export const added = true;\n",
    );
  });

  /**
   * Containment, not link-freedom, is the property. A link that lands back
   * inside the worktree is an ordinary repository layout and must still work.
   */
  test("a symlinked directory that stays inside the worktree is allowed", async () => {
    const world = await makeWorld();
    const worktree = join(world.root, "wt", "slice-7");
    await mkdir(join(worktree, "packages", "core"), { recursive: true });
    await symlink(
      join(worktree, "packages", "core"),
      join(worktree, "src"),
      "dir",
    );

    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          await writeFile(
            join(spec.cwd, "src", "added.ts"),
            "export const added = true;\n",
          );
        },
      },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(adapter.specs.length).toBe(1);
    expect(
      await readFile(join(worktree, "packages", "core", "added.ts"), "utf8"),
    ).toBe("export const added = true;\n");
  });

  test("an absolute owned path is refused", async () => {
    const world = await makeWorld();
    const worktree = join(world.root, "wt", "slice-7");
    const adapter = claudeAdapter([]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: { ...SLICE, ownedPaths: ["/etc/passwd"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      message: `refusing to pre-create owned path "/etc/passwd": it is absolute and does not belong to worktree root ${worktree}`,
    });
    expect(adapter.specs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Spawn, drain, quota
// ---------------------------------------------------------------------------

describe("DefaultSliceRunner worker lifecycle", () => {
  test("the event stream is drained to exhaustion", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([
      { events: [MESSAGE_EVENT, MESSAGE_EVENT, CLAUDE_QUOTA_EVENT] },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(adapter.drainedCount()).toBe(1);
  });

  test("draining runs concurrently with completion rather than after it", async () => {
    const world = await makeWorld();
    // This adapter's completion resolves ONLY once its events are exhausted. A
    // runner that awaited `completion` first would wait forever; the bound turns
    // that into a failing test instead of a hung suite.
    const adapter = claudeAdapter([
      {
        events: [MESSAGE_EVENT, CLAUDE_QUOTA_EVENT],
        completionAfterDrain: true,
      },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run: the drain and completion must be awaited concurrently",
    );

    expect(result.ok).toBe(true);
    expect(adapter.drainedCount()).toBe(1);
  });

  test("a claude quota event reaches ingest and a codex quota event does not", async () => {
    const world = await makeWorld();
    const oracle = claudeOracleFake();
    const adapter = claudeAdapter([
      { events: [CODEX_QUOTA_EVENT, MESSAGE_EVENT, CLAUDE_QUOTA_EVENT] },
    ]);
    const harness = makeHarness({
      workers: { claude: adapter.worker },
      oracles: [CODEX_ORACLE, oracle.oracle],
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(oracle.ingested.length).toBe(1);
    expect(oracle.ingested[0]?.snapshot.vendor).toBe("claude");
    expect(oracle.ingested[0]).toBe(CLAUDE_QUOTA_EVENT);
  });

  test("an oracle that throws neither stalls the drain nor fails the slice", async () => {
    const world = await makeWorld();
    const oracle = claudeOracleFake(new Error("oracle exploded"));
    const adapter = claudeAdapter([
      {
        events: [CLAUDE_QUOTA_EVENT, MESSAGE_EVENT],
        completionAfterDrain: true,
      },
    ]);
    const harness = makeHarness({
      workers: { claude: adapter.worker },
      oracles: [oracle.oracle],
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(adapter.drainedCount()).toBe(1);
    expect(
      harness.logs.some((line) =>
        line.includes(
          "ignored a failure from the claude quota oracle: oracle exploded",
        ),
      ),
    ).toBe(true);
  });

  test("a failed worker outcome becomes WORKER_FAILED carrying the WorkerFailure", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{ outcome: FAILED_OUTCOME }]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKER_FAILED",
      message:
        "slice slice-auth attempt 1: claude/claude-opus-5 failed with API_ERROR: upstream returned 503",
      failure: {
        kind: "API_ERROR",
        message: "upstream returned 503",
        retryable: true,
        statusCode: 503,
      },
    });
    expect(attemptAt(result, 0).outcome).toBe(FAILED_OUTCOME);
    expect(harness.engine.commits.length).toBe(0);
  });

  test("an unconfigured vendor becomes WORKER_FAILED naming it, without throwing", async () => {
    const world = await makeWorld();
    const harness = makeHarness({ workers: {} });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(SOL)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKER_FAILED",
      message: 'no worker adapter is configured for vendor "codex"',
      failure: {
        kind: "LAUNCH_FAILURE",
        message: 'no worker adapter is configured for vendor "codex"',
        retryable: false,
        statusCode: null,
      },
    });
  });

  test("a rejected completion becomes WORKER_FAILED rather than a rejected run", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([
      { completionError: new Error("adapter lost the child") },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKER_FAILED",
      message:
        "slice slice-auth attempt 1: claude/claude-opus-5 completion rejected: adapter lost the child",
      failure: {
        kind: "UNKNOWN_FAILURE",
        message: "adapter lost the child",
        retryable: false,
        statusCode: null,
      },
    });
  });

  test("the spec handed to the adapter is built for the routed model in the created worktree", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{}]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    const spec = adapter.specs[0];
    expect(spec?.vendor).toBe("claude");
    expect(spec?.model).toBe("claude-opus-5");
    expect(spec?.effort).toBe("high");
    expect(spec?.cwd).toBe(join(world.root, "wt", "slice-7"));
    expect(spec?.environment.HOME).toBe("/Users/worker");
    expect(spec?.environment.PATH).toBe("/opt/brigadier/bin:/usr/bin:/bin");
    expect(spec?.environment.USER).toBe("worker");
  });
});

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

describe("DefaultSliceRunner commit", () => {
  test("an empty diff becomes NO_CHANGES rather than a false success", async () => {
    const world = await makeWorld();
    const engine = new FakeEngine();
    engine.commitError = new NoChangesToCommitError();
    const adapter = claudeAdapter([{}, {}]);
    const harness = makeHarness({
      engine,
      workers: { claude: adapter.worker },
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(false);
    expect(result.commit).toBe(null);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "NO_CHANGES",
      message: `slice slice-auth attempt 1: claude/claude-opus-5 exited cleanly but changed no file in ${join(world.root, "wt", "slice-7")}`,
    });
    expect(attemptAt(result, 1).failure).toEqual({
      kind: "NO_CHANGES",
      message: `slice slice-auth attempt 2: claude/claude-haiku-4 exited cleanly but changed no file in ${join(world.root, "wt", "slice-8")}`,
    });
  });

  test("any other commit error becomes COMMIT_FAILED naming the branch", async () => {
    const world = await makeWorld();
    const engine = new FakeEngine();
    engine.commitError = new Error(
      "refusing to commit linked secret path(s): .env",
    );
    const adapter = claudeAdapter([{}]);
    const harness = makeHarness({
      engine,
      workers: { claude: adapter.worker },
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(attemptAt(result, 0).failure).toEqual({
      kind: "COMMIT_FAILED",
      message:
        "could not commit slice slice-auth attempt 1 on brigadier/wo-011/slice-7: refusing to commit linked secret path(s): .env",
    });
  });

  test("the commit message names the slice, attempt, model and effort", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{}]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(result.commit).toBe("commit-1");
    expect(harness.engine.commits[0]?.message).toBe(
      "slice-auth: Implement authentication\n\nattempt 1 on claude/claude-opus-5 at high effort\n",
    );
  });
});

// ---------------------------------------------------------------------------
// Worktree ownership and cleanup
// ---------------------------------------------------------------------------

describe("DefaultSliceRunner worktree ownership", () => {
  test("a successful slice returns a live worktree that was never removed", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{}]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    if (!result.ok) {
      throw new Error("expected a successful slice");
    }
    expect(result.branch).toBe("brigadier/wo-011/slice-7");
    expect(result.commit).toBe("commit-1");
    expect(result.worktree.path).toBe(join(world.root, "wt", "slice-7"));
    expect(result.worktree.branch).toBe("brigadier/wo-011/slice-7");
    expect(result.worktree.isolated).toBe(true);
    expect(harness.engine.removes.length).toBe(0);
    expect(await exists(join(world.root, "wt", "slice-7"))).toBe(true);
    expect(result.attempts.length).toBe(1);
    expect(attemptAt(result, 0).commit).toBe("commit-1");
    expect(attemptAt(result, 0).failure).toBe(null);
  });

  test("a failed slice returns a null worktree and removes every attempt's worktree", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([
      { outcome: FAILED_OUTCOME },
      { outcome: FAILED_OUTCOME },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(false);
    expect(result.worktree).toBe(null);
    expect(result.commit).toBe(null);
    expect(harness.engine.removes.map((worktree) => worktree.branch)).toEqual([
      "brigadier/wo-011/slice-7",
      "brigadier/wo-011/slice-8",
    ]);
    expect(await exists(join(world.root, "wt", "slice-7"))).toBe(false);
    expect(await exists(join(world.root, "wt", "slice-8"))).toBe(false);
  });

  test("a failing remove is reported alongside the original failure, never instead of it", async () => {
    const world = await makeWorld();
    const engine = new FakeEngine();
    engine.removeError = new Error("git worktree remove: directory is busy");
    const adapter = claudeAdapter([{ outcome: FAILED_OUTCOME }]);
    const harness = makeHarness({
      engine,
      workers: { claude: adapter.worker },
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKER_FAILED",
      message: `slice slice-auth attempt 1: claude/claude-opus-5 failed with API_ERROR: upstream returned 503; cleanup of worktree ${join(world.root, "wt", "slice-7")} also failed: git worktree remove: directory is busy`,
      failure: {
        kind: "API_ERROR",
        message: "upstream returned 503",
        retryable: true,
        statusCode: 503,
      },
    });
    // The same leak, structurally, so the run's summary can name the directory
    // that survived instead of reporting a clean cleanup.
    expect(result.cleanupFailures).toEqual([
      `slice slice-auth attempt 1: cleanup of worktree ${join(world.root, "wt", "slice-7")} also failed: git worktree remove: directory is busy`,
    ]);
  });

  test("durations come from ports.now, never from the wall clock", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{}]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = createSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    // The injected clock advances 5 ms per read and the attempt reads it twice.
    expect(attemptAt(result, 0).durationMs).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Launch environment
// ---------------------------------------------------------------------------

describe("requireLaunchEnv", () => {
  test("keeps HOME, PATH, and USER and passes the rest through", () => {
    const env = requireLaunchEnv({
      HOME: "/Users/worker",
      PATH: "/usr/bin",
      USER: "worker",
      TERM: "dumb",
    });
    expect(env.HOME).toBe("/Users/worker");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.USER).toBe("worker");
    expect(env.TERM).toBe("dumb");
  });

  test("refuses an environment with no HOME", () => {
    expect(() =>
      requireLaunchEnv({ PATH: "/usr/bin", USER: "worker" }),
    ).toThrow("cannot launch a worker: HOME is missing from the environment");
  });

  test("refuses an environment with an empty PATH", () => {
    expect(() =>
      requireLaunchEnv({ HOME: "/Users/worker", PATH: "", USER: "worker" }),
    ).toThrow("cannot launch a worker: PATH is missing from the environment");
  });

  test("refuses an environment with a missing or empty USER", () => {
    expect(() =>
      requireLaunchEnv({ HOME: "/Users/worker", PATH: "/usr/bin" }),
    ).toThrow("cannot launch a worker: USER is missing from the environment");
    expect(() =>
      requireLaunchEnv({ HOME: "/Users/worker", PATH: "/usr/bin", USER: "" }),
    ).toThrow("cannot launch a worker: USER is missing from the environment");
  });
});

// ---------------------------------------------------------------------------
// Cancellation
//
// NOT ONE OF THESE TESTS SENDS A SIGNAL. They abort an `AbortController`
// directly, which is the whole reason `runCli` takes an `AbortSignal` rather
// than installing handlers of its own: a test that killed the test process
// would prove nothing repeatable and would take the suite with it.
//
// AND NOT ONE OF THEM CAN HANG. Every fake worker here finishes on its own —
// finite events, a completion that resolves — so a runner that ignored the
// signal entirely would commit and return `ok: true`, and each test would fail
// on an assertion in milliseconds instead of waiting forever for a cancellation
// that is never coming. `withBound` is the second net, not the first.
// ---------------------------------------------------------------------------

/** The abort reason `src/cli.ts` raises for Ctrl-C. */
const SIGINT_REASON: RunInterruption = { kind: "interrupt", signal: "SIGINT" };
const SIGTERM_REASON: RunInterruption = {
  kind: "interrupt",
  signal: "SIGTERM",
};

describe("cancellation", () => {
  test("an abort while the worker runs terminates its process group with the exact shutdown reason", async () => {
    const world = await makeWorld();
    const controller = new AbortController();
    const adapter = claudeAdapter([
      {
        events: [MESSAGE_EVENT],
        // Fired from inside the runner's own wait: the drain is already being
        // consumed and the abort listener is already installed.
        onEvent: () => {
          controller.abort(SIGINT_REASON);
        },
        completionAfterDrain: true,
        outcome: CANCELLED_OUTCOME,
      },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        // TWO slots, so "no retry after an interrupt" is a real claim rather
        // than an artefact of there being nowhere to retry to.
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
        signal: controller.signal,
      }),
      2000,
      "run",
    );

    // The process group, killed exactly once, with exactly this reason.
    expect(adapter.cancels()).toEqual([
      { kind: "shutdown", message: "brigadier received SIGINT" },
    ]);
    expect(adapter.specs).toHaveLength(1);

    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.commit).toBe(null);
    expect(result.worktree).toBe(null);
    expect(result.branch).toBe("brigadier/wo-011/slice-7");
    expect(result.attempts).toHaveLength(1);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKER_FAILED",
      message:
        "slice slice-auth attempt 1: claude/claude-opus-5 was terminated: brigadier received SIGINT",
      failure: {
        kind: "CANCELLED",
        message:
          "slice slice-auth attempt 1: claude/claude-opus-5 was terminated: brigadier received SIGINT",
        retryable: false,
        statusCode: null,
      },
    });

    // Nothing was committed, and the worktree is gone.
    expect(harness.engine.commits).toHaveLength(0);
    expect(harness.engine.removes.map((worktree) => worktree.branch)).toEqual([
      "brigadier/wo-011/slice-7",
    ]);
    expect(await exists(join(world.root, "wt", "slice-7"))).toBe(false);
  });

  test("SIGTERM names itself in the reason the worker is cancelled with", async () => {
    const world = await makeWorld();
    const controller = new AbortController();
    const adapter = claudeAdapter([
      {
        events: [MESSAGE_EVENT],
        onEvent: () => {
          controller.abort(SIGTERM_REASON);
        },
        completionAfterDrain: true,
        outcome: CANCELLED_OUTCOME,
      },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
        signal: controller.signal,
      }),
      2000,
      "run",
    );

    expect(adapter.cancels()).toEqual([
      { kind: "shutdown", message: "brigadier received SIGTERM" },
    ]);
  });

  test("an abort with no reason still cancels, in words that claim nothing", async () => {
    const world = await makeWorld();
    const controller = new AbortController();
    const adapter = claudeAdapter([
      {
        events: [MESSAGE_EVENT],
        onEvent: () => {
          controller.abort();
        },
        completionAfterDrain: true,
        outcome: CANCELLED_OUTCOME,
      },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
        signal: controller.signal,
      }),
      2000,
      "run",
    );

    expect(adapter.cancels()).toEqual([
      { kind: "shutdown", message: "brigadier was interrupted" },
    ]);
    expect(result.cancelled).toBe(true);
  });

  test("an abort already in hand spends no worktree, no spawn, and no ref", async () => {
    const world = await makeWorld();
    const controller = new AbortController();
    controller.abort(SIGINT_REASON);
    const adapter = claudeAdapter([]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
        signal: controller.signal,
      }),
      2000,
      "run",
    );

    expect(harness.engine.creates).toHaveLength(0);
    expect(adapter.specs).toHaveLength(0);
    expect(adapter.cancels()).toHaveLength(0);
    expect(harness.routeRequests).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.branch).toBe(null);
    expect(result.attempts).toHaveLength(1);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKER_FAILED",
      message:
        "slice slice-auth attempt 1 was cancelled before it was routed: brigadier received SIGINT",
      failure: {
        kind: "CANCELLED",
        message:
          "slice slice-auth attempt 1 was cancelled before it was routed: brigadier received SIGINT",
        retryable: false,
        statusCode: null,
      },
    });
  });

  test("an abort between the worktree and the spawn starts no worker and still removes the worktree", async () => {
    const world = await makeWorld();
    const controller = new AbortController();
    const engine = new FakeEngine();
    engine.onCreate = () => {
      controller.abort(SIGINT_REASON);
    };
    const adapter = claudeAdapter([]);
    const harness = makeHarness({
      engine,
      workers: { claude: adapter.worker },
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: world.slots,
        routing: ROUTING,
        unsafeInPlace: false,
        signal: controller.signal,
      }),
      2000,
      "run",
    );

    expect(engine.creates).toHaveLength(1);
    expect(adapter.specs).toHaveLength(0);
    expect(result.cancelled).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(attemptAt(result, 0).failure?.message).toBe(
      "slice slice-auth attempt 1 was cancelled before a claude/claude-opus-5 worker was spawned: brigadier received SIGINT",
    );
    expect(engine.removes.map((worktree) => worktree.branch)).toEqual([
      "brigadier/wo-011/slice-7",
    ]);
    expect(await exists(join(world.root, "wt", "slice-7"))).toBe(false);
  });

  test("a shutdown throw that resolves cancel reports the pid as possibly still running", async () => {
    const world = await makeWorld();
    const controller = new AbortController();
    const adapter = shutdownThrowingAdapter(controller);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
        signal: controller.signal,
      }),
      2000,
      "shutdown-throw run",
    );

    expect(adapter.cancels()).toEqual([
      { kind: "shutdown", message: "brigadier received SIGINT" },
    ]);
    expect(adapter.shutdownCalls()).toBe(1);
    expect(
      await withBound(adapter.completion(), 100, "shutdown-throw completion"),
    ).toEqual({
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
    });
    expect(result.cancelled).toBe(true);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKER_FAILED",
      message:
        "slice slice-auth attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running — termination was not confirmed because completion settled with UNKNOWN_FAILURE: process group 4242 survived SIGKILL: brigadier received SIGINT",
      failure: {
        kind: "CANCELLED",
        message:
          "slice slice-auth attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running — termination was not confirmed because completion settled with UNKNOWN_FAILURE: process group 4242 survived SIGKILL: brigadier received SIGINT",
        retryable: false,
        statusCode: null,
      },
    });
    expect(result.cleanupFailures).toEqual([
      "slice slice-auth attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running — termination was not confirmed because completion settled with UNKNOWN_FAILURE: process group 4242 survived SIGKILL",
    ]);
    expect(harness.logs).toEqual([
      "slice slice-auth attempt 1: routed to claude/claude-opus-5 at high effort",
      "slice slice-auth attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running — termination was not confirmed because completion settled with UNKNOWN_FAILURE: process group 4242 survived SIGKILL",
    ]);
  });

  test("a resolved cancel cannot hang on an adapter whose completion never settles", async () => {
    const world = await makeWorld();
    const controller = new AbortController();
    const cancels: CancelReason[] = [];
    const completion = new Promise<LaunchedWorkerOutcome>(() => {});
    const worker: Worker<"claude"> = {
      vendor: "claude",
      processCompletion: "signals-then-must-be-killed",
      spawn: async () => ({
        pid: 4242,
        events: {
          [Symbol.asyncIterator]: async function* iterate() {
            yield MESSAGE_EVENT;
            controller.abort(SIGINT_REASON);
          },
        },
        completion,
        cancel: async (reason) => {
          cancels.push(reason);
        },
      }),
    };
    const harness = makeHarness({ workers: { claude: worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
        signal: controller.signal,
      }),
      1000,
      "never-settling completion run",
    );

    expect(cancels).toEqual([
      { kind: "shutdown", message: "brigadier received SIGINT" },
    ]);
    expect(result.cancelled).toBe(true);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKER_FAILED",
      message:
        "slice slice-auth attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running — termination was not confirmed because completion did not settle within 100 ms: brigadier received SIGINT",
      failure: {
        kind: "CANCELLED",
        message:
          "slice slice-auth attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running — termination was not confirmed because completion did not settle within 100 ms: brigadier received SIGINT",
        retryable: false,
        statusCode: null,
      },
    });
    expect(result.cleanupFailures).toEqual([
      "slice slice-auth attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running — termination was not confirmed because completion did not settle within 100 ms",
    ]);
  });

  test("a cancel that rejects is reported beside the cancellation, never instead of it", async () => {
    const world = await makeWorld();
    const controller = new AbortController();
    const adapter = claudeAdapter([
      {
        events: [MESSAGE_EVENT],
        onEvent: () => {
          controller.abort(SIGINT_REASON);
        },
        completionAfterDrain: true,
        cancelError: new Error("process group 4242 survived SIGKILL"),
      },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
        signal: controller.signal,
      }),
      2000,
      "run",
    );

    expect(result.cancelled).toBe(true);
    expect(attemptAt(result, 0).failure?.message).toBe(
      "slice slice-auth attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running — terminating its process group failed: process group 4242 survived SIGKILL: brigadier received SIGINT",
    );
    // AND STRUCTURALLY, not only in prose. The run's summary has to decide
    // whether it may say "workers were cancelled", and it cannot make that
    // decision by reading a failure message. This is the field it reads.
    expect(result.cleanupFailures).toEqual([
      "slice slice-auth attempt 1: the claude/claude-opus-5 worker (pid 4242) may still be running — terminating its process group failed: process group 4242 survived SIGKILL",
    ]);
  });

  test("a cancel that worked leaves no cleanup failure behind", async () => {
    const world = await makeWorld();
    const controller = new AbortController();
    const adapter = claudeAdapter([
      {
        events: [MESSAGE_EVENT],
        onEvent: () => {
          controller.abort(SIGINT_REASON);
        },
        completionAfterDrain: true,
        outcome: CANCELLED_OUTCOME,
      },
    ]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
        signal: controller.signal,
      }),
      2000,
      "run",
    );

    expect(result.cancelled).toBe(true);
    expect(attemptAt(result, 0).failure?.message).toBe(
      "slice slice-auth attempt 1: claude/claude-opus-5 was terminated: brigadier received SIGINT",
    );
    expect(result.cleanupFailures).toBeUndefined();
    expect(harness.logs).toEqual([
      "slice slice-auth attempt 1: routed to claude/claude-opus-5 at high effort",
      "slice slice-auth attempt 1: cancelled claude/claude-opus-5 (pid 4242)",
    ]);
  });

  test("a run with no signal behaves exactly as it always did", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{ events: [MESSAGE_EVENT] }]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: SLICE,
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      2000,
      "run",
    );

    expect(result.ok).toBe(true);
    expect(result.cancelled).toBeUndefined();
    expect(adapter.cancels()).toHaveLength(0);
  });
});
