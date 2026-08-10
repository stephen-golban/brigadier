import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
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
  ReviewFinding,
  RunInterruption,
  SliceAttempt,
  SliceDirective,
  SliceResult,
  SliceReview,
  SliceReviewer,
  SliceReviewRequest,
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

// ---------------------------------------------------------------------------
// Review gate fakes. None of them spawns anything, none reads a clock, and none
// waits on wall time: a gate that could hang would wedge the whole suite rather
// than fail one test.
// ---------------------------------------------------------------------------

interface FakeReviewer extends SliceReviewer {
  /** Every request the runner handed the gate, in call order. */
  requests(): readonly SliceReviewRequest[];
}

/**
 * A gate that returns canned verdicts, one per call.
 *
 * `durationMs: 0` throughout, and deliberately so: these fakes never read
 * `ports.now`, which is what lets a test assert an ATTEMPT's duration against
 * an absolute number without that number encoding how many times the gate
 * happened to look at the clock.
 */
function fakeReviewer(verdicts: readonly SliceReview[]): FakeReviewer {
  const seen: SliceReviewRequest[] = [];
  return {
    requests: () => seen,
    review: (request: SliceReviewRequest): Promise<SliceReview> => {
      seen.push(request);
      const verdict = verdicts[seen.length - 1];
      if (verdict === undefined) {
        throw new Error(
          `the fake reviewer has no verdict for review ${seen.length}; it was given ${verdicts.length}`,
        );
      }
      return Promise.resolve(verdict);
    },
  };
}

const REVIEWER: ReviewerIdentityFixture = {
  vendor: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
};

type ReviewerIdentityFixture = Extract<
  SliceReview,
  { readonly verdict: "approved" }
>["reviewer"];

const BLOCKING_FINDING: ReviewFinding = {
  severity: "blocking",
  path: "src/added.ts",
  line: 12,
  summary: "the loop runs one past the end of the array",
};

const CONCERN_FINDING: ReviewFinding = {
  severity: "concern",
  path: "src/added.ts",
  line: 30,
  summary: "this branch looks unreachable",
};

const APPROVED: SliceReview = {
  verdict: "approved",
  reviewer: REVIEWER,
  findings: [],
  durationMs: 0,
};

const REJECTED: SliceReview = {
  verdict: "rejected",
  reviewer: REVIEWER,
  findings: [BLOCKING_FINDING],
  durationMs: 0,
};

const SKIPPED: SliceReview = {
  verdict: "skipped",
  reviewer: null,
  reason: "NO_OTHER_VENDOR",
  message: "no other vendor is configured",
  durationMs: 0,
};

/** A gate that always skips, for tests whose subject is not the gate. */
function skippingReviewer(): SliceReviewer {
  return { review: (): Promise<SliceReview> => Promise.resolve(SKIPPED) };
}

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
        "slice slice-auth attempt 1: not retrying a failure a second attempt cannot change",
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

  /**
   * THE TWO HALVES OF THE `WORKTREE_FAILED` RETRY RULE, ASSERTED TOGETHER.
   *
   * A containment refusal is decided by the plan's owned paths and by a symlink
   * in the user's repository. Neither of those changes when the retry moves to
   * a different slot, so the second attempt re-derives the identical refusal —
   * one slot spent, one duplicate failure in the report that reads like
   * flakiness. This half asserts exactly one attempt, one routing ask, and one
   * worktree ever created.
   *
   * The next test is the other half, and it is why this one cannot be satisfied
   * by simply making every `WORKTREE_FAILED` terminal: a worktree that could
   * not be CREATED really may succeed in a different slot, because the slot is
   * a different path and a different branch. A fix that kills that retry would
   * pass the test above and regress the escalation.
   */
  test("a containment refusal ends the slice after exactly one attempt", async () => {
    const world = await makeWorld();
    const outside = join(world.root, "outside");
    mkdirSync(outside, { recursive: true });
    const engine = new FakeEngine();
    // The real paths the refusal message names, captured while the worktree is
    // still on disk: the refused attempt tears it down before `run` returns, and
    // on macOS the temp root sits under `/var`, reached through a symlink.
    const realWorktrees: string[] = [];
    // Planted in EVERY worktree the engine creates, which is the condition the
    // deterministic marker claims: the second slot is no cleaner than the first.
    engine.onCreate = () => {
      const spec = engine.creates[engine.creates.length - 1];
      if (spec === undefined) {
        throw new Error("onCreate fired with no recorded create");
      }
      const path = spec.path ?? spec.session.repositoryPath;
      mkdirSync(join(path, "src"), { recursive: true });
      if (!existsSync(join(path, "src", "link"))) {
        symlinkSync(outside, join(path, "src", "link"));
      }
      realWorktrees.push(realpathSync(path));
    };
    const harness = makeHarness({ engine });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      // Two decisions on purpose: a second attempt is available and would
      // route cleanly, so the assertion below is about the runner's choice.
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
    });

    const result = await withBound(
      runner.run({
        slice: { ...SLICE, ownedPaths: ["src/link/victim.ts"] },
        directive: DIRECTIVE,
        session: world.session,
        // BOTH slots offered. Only the first may be spent.
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
    expect(engine.creates.length).toBe(1);
    expect(engine.creates[0]?.path).toBe(world.slots[0].worktreePath);
    const realVictim = await realpath(outside);
    expect(realWorktrees.length).toBe(1);
    const realWorktree = realWorktrees[0];
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      deterministic: true,
      message: `slice slice-auth attempt 1: refusing to grant owned path "src/link/victim.ts": an existing path component is a symbolic link leading to ${join(realVictim, "victim.ts")}, outside worktree root ${realWorktree}`,
    });
    expect(harness.logs).toContain(
      "slice slice-auth attempt 1: not retrying a failure a second attempt cannot change",
    );
  });

  /** The other half: a creation failure is NOT deterministic and still retries. */
  test("a worktree that could not be created still spends the second slot", async () => {
    const world = await makeWorld();
    const engine = new FakeEngine();
    engine.createError = new Error(
      "refusing to overwrite existing branch brigadier/wo-011/slice-7",
    );
    const harness = makeHarness({ engine });
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
    expect(result.attempts.length).toBe(2);
    expect(harness.routeRequests.length).toBe(2);
    expect(engine.creates.length).toBe(2);
    expect(engine.creates[0]?.path).toBe(world.slots[0].worktreePath);
    expect(engine.creates[1]?.path).toBe(world.slots[1].worktreePath);
    // No marker on either failure: nothing here proved the condition follows
    // the slice into its next slot.
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      message: `could not create worktree for slice slice-auth attempt 1 at ${world.slots[0].worktreePath}: refusing to overwrite existing branch brigadier/wo-011/slice-7`,
    });
    expect(attemptAt(result, 1).failure).toEqual({
      kind: "WORKTREE_FAILED",
      message: `could not create worktree for slice slice-auth attempt 2 at ${world.slots[1].worktreePath}: refusing to overwrite existing branch brigadier/wo-011/slice-7`,
    });
  });
});

// ---------------------------------------------------------------------------
// Owned-path creation
// ---------------------------------------------------------------------------

describe("DefaultSliceRunner owned-path creation", () => {
  /**
   * THE RUNNER CREATES NOTHING IN THE WORKTREE, AND THAT IS THE FIX.
   *
   * It used to pre-create every owned path as an empty placeholder, because a
   * Claude worker was believed unable to create a file, and then delete the
   * ones still empty before the commit so untouched placeholders never reached
   * it. That cost a slice whose job is to add a legitimately EMPTY file — an
   * empty barrel, a deliberately blank fixture — its entire deliverable, and
   * size alone cannot tell that file apart from an untouched placeholder.
   *
   * `Write(glob)` is enforced exactly as `Edit(glob)` is (measured against
   * claude 2.1.226), so the worker creates its own files and every file in the
   * worktree is by construction one the worker made. This test is the old bug
   * stated as a requirement: it fails against the placeholder code, where
   * `src/empty.ts` is unlinked before `commit` is ever called.
   */
  test("an empty file the worker creates survives to the commit and after it", async () => {
    const world = await makeWorld();
    const worktree = join(world.root, "wt", "slice-7");
    const slice: Slice = {
      ...SLICE,
      ownedPaths: ["src/empty.ts", "src/added.ts"],
    };

    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          // Exactly what the Write tool does for a path that does not exist:
          // make the parent, then write the file.
          await mkdir(join(spec.cwd, "src"), { recursive: true });
          await writeFile(join(spec.cwd, "src", "empty.ts"), "");
          await writeFile(
            join(spec.cwd, "src", "added.ts"),
            "export const added = true;\n",
          );
        },
      },
    ]);
    const engine = new FakeEngine();
    // Sampled synchronously inside `commit`, so this asserts the ORDERING —
    // that the empty file was still there when the commit was taken, not merely
    // that it is there once the run has returned.
    const atCommit: Record<string, boolean> = {};
    engine.onCommit = () => {
      atCommit["src/empty.ts"] = existsSync(join(worktree, "src", "empty.ts"));
      atCommit["src/added.ts"] = existsSync(join(worktree, "src", "added.ts"));
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
    expect(atCommit).toEqual({
      "src/empty.ts": true,
      "src/added.ts": true,
    });
    // The successful worktree is left live, so its files can be read back.
    expect(await readFile(join(worktree, "src", "empty.ts"), "utf8")).toBe("");
    expect(await readFile(join(worktree, "src", "added.ts"), "utf8")).toBe(
      "export const added = true;\n",
    );
  });

  /**
   * The other half of the same change: with nothing pre-created, an owned path
   * the worker never writes simply does not exist. It is not a file that has to
   * be cleaned up before the commit, which is why there is no cleanup left.
   */
  test("an owned path the worker never writes never exists at all", async () => {
    const world = await makeWorld();
    const worktree = join(world.root, "wt", "slice-7");
    const slice: Slice = {
      ...SLICE,
      ownedPaths: ["src/added.ts", "docs/deep/notes.md"],
    };

    const seenAtSpawn: Record<string, boolean> = {};
    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          seenAtSpawn["src/added.ts"] = existsSync(
            join(spec.cwd, "src", "added.ts"),
          );
          seenAtSpawn["docs/deep/notes.md"] = existsSync(
            join(spec.cwd, "docs", "deep", "notes.md"),
          );
          await mkdir(join(spec.cwd, "src"), { recursive: true });
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
    // Nothing is pre-created, so the worker sees an empty lane rather than two
    // zero-byte files it did not write.
    expect(seenAtSpawn).toEqual({
      "src/added.ts": false,
      "docs/deep/notes.md": false,
    });
    expect(await exists(join(worktree, "docs", "deep", "notes.md"))).toBe(
      false,
    );
    expect(await exists(join(worktree, "docs", "deep"))).toBe(false);
  });

  /**
   * An owned path that could rewrite the vendor's lane grammar is still refused,
   * and now `buildWorkerSpec` is the only thing standing there — the placeholder
   * planner used to reject a few of these on its way past. The refusal is a
   * `LAUNCH_FAILURE`, and no worker is spawned.
   */
  test("a lane-hostile owned path is refused before any worker is spawned", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: {
          ...SLICE,
          ownedPaths: ["src/ok.ts", "owned),Edit(package.json"],
        },
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
      kind: "WORKER_FAILED",
      message:
        'could not build a worker spec for claude/claude-opus-5: refusing to build a worker spec for slice "slice-auth": owned path "owned),Edit(package.json" contains U+0028, U+0029, U+002C, which can alter a vendor\'s lane grammar',
      failure: {
        kind: "LAUNCH_FAILURE",
        message:
          'could not build a worker spec for claude/claude-opus-5: refusing to build a worker spec for slice "slice-auth": owned path "owned),Edit(package.json" contains U+0028, U+0029, U+002C, which can alter a vendor\'s lane grammar',
        retryable: false,
        statusCode: null,
      },
    });
    expect(adapter.specs.length).toBe(0);
    expect(harness.engine.removes.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Worktree containment
//
// The property under test: no worker is ever handed a lane rule for a path that
// does not really land inside its own worktree. Isolation is the only thing the
// worktree design buys, and a write that leaves the worktree is both
// unrecoverable and INVISIBLE — `git status` inside the worktree sees nothing,
// so the slice is reported as NO_CHANGES while a file outside the repository
// has already been overwritten.
//
// This block exists as its own section because the last version of this check
// lived inside the function that pre-created owned paths as empty placeholders.
// When that subsystem was deleted the containment proof went with it, the whole
// suite stayed green, and only the compiled binary found the hole. Containment
// is stated here as a requirement in its own right so that deleting the guard
// fails a test that names it.
// ---------------------------------------------------------------------------

describe("DefaultSliceRunner worktree containment", () => {
  /**
   * THE REGRESSION. A repository can legitimately contain a committed symlinked
   * directory — `src -> ../shared/src` is an ordinary layout — and `git
   * checkout` reproduces that symlink inside every worktree. An owned path
   * underneath it passes every lexical test there is: it is relative, it has no
   * `..`, it has no glob and no control character. `resolve` and `relative`
   * never touch a disk, so only `realpath` can see where it actually leads.
   *
   * Without the guard this run spawns a worker, the worker's in-lane `Write`
   * lands outside the repository, and the slice is reported as `NO_CHANGES`.
   */
  test("an owned path leading through a symlinked directory is refused before any worker is spawned", async () => {
    const world = await makeWorld();
    const outside = join(world.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "victim.ts"), "ORIGINAL SECRET CONTENT\n");

    const worktree = world.slots[0].worktreePath;
    const engine = new FakeEngine();
    // Exactly what checking out a committed symlink into a fresh worktree does,
    // fired after the worktree exists and before the runner can spawn into it.
    // The root's real path is sampled here because the failed attempt removes
    // the worktree, and the message under test names that real path.
    let realWorktree = "";
    engine.onCreate = () => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      symlinkSync(outside, join(worktree, "src", "link"), "dir");
      realWorktree = realpathSync(worktree);
    };

    // Scripted to do exactly what a lane-scoped worker does with the path it was
    // granted. If the guard is ever removed this runs, and the assertions below
    // fail on the overwritten bytes rather than on a message.
    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          await writeFile(
            join(spec.cwd, "src", "link", "victim.ts"),
            "OVERWRITTEN BY THE WORKER\n",
          );
        },
      },
    ]);
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
        slice: { ...SLICE, ownedPaths: ["src/link/victim.ts"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      5000,
      "run",
    );

    // The real path the message must name. Resolved from the filesystem rather
    // than assembled lexically, because the temp root itself sits under
    // `/var/folders`, which is reached through the `/var -> /private/var`
    // symlink on macOS.
    const realVictim = await realpath(join(outside, "victim.ts"));
    expect(realWorktree).toBe(
      join(await realpath(world.root), "wt", "slice-7"),
    );

    // Asserted first because it is the whole point: the file outside the
    // worktree is untouched, byte for byte, and nothing was created beside it.
    expect(await readFile(join(outside, "victim.ts"), "utf8")).toBe(
      "ORIGINAL SECRET CONTENT\n",
    );
    expect((await readdir(outside)).sort()).toEqual(["victim.ts"]);
    // No subprocess ever existed, so nothing was ever told it could write there.
    expect(adapter.specs.length).toBe(0);
    expect(result.ok).toBe(false);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      deterministic: true,
      message: `slice slice-auth attempt 1: refusing to grant owned path "src/link/victim.ts": an existing path component is a symbolic link leading to ${realVictim}, outside worktree root ${realWorktree}`,
    });
    // The refused attempt still tears its worktree down.
    expect(harness.engine.removes.length).toBe(1);
  });

  /**
   * THE CASE THAT BREAKS THE FIX WHILE THE SUITE STAYS GREEN. On macOS `/tmp`
   * is a symlink to `/private/tmp` and `/var` to `/private/var`, so a worktree
   * root reached THROUGH a symlink is the ordinary case, not an edge case.
   *
   * A guard that resolves the child but compares it against an unresolved root
   * computes `relative("/tmp/x/slice-7", "/private/tmp/x/slice-7/src/added.ts")`
   * — which starts with `..` — and reports an escape for every legitimate path
   * on the platform brigadier runs on. This test drives a root whose parent is a
   * symlink and requires an ordinary owned path to PASS.
   */
  test("a worktree root reached through a symlink still contains an ordinary owned path", async () => {
    const world = await makeWorld();
    const realParent = join(world.root, "real-worktrees");
    await mkdir(join(realParent, "slice-7"), { recursive: true });
    const linkedParent = join(world.root, "linked-worktrees");
    await symlink(realParent, linkedParent, "dir");
    const worktree = join(linkedParent, "slice-7");

    // The premise of the test, asserted rather than assumed: this root really is
    // reached through a symlink, so a lexical root comparison really would fail.
    expect(await realpath(worktree)).toBe(
      join(await realpath(realParent), "slice-7"),
    );
    expect(await realpath(worktree)).not.toBe(worktree);

    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          await mkdir(join(spec.cwd, "src"), { recursive: true });
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
        slice: { ...SLICE, ownedPaths: ["src/added.ts"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: [{ sliceNumber: 7, worktreePath: worktree }],
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      5000,
      "run",
    );

    expect(attemptAt(result, 0).failure).toBe(null);
    expect(result.ok).toBe(true);
    expect(result.commit).toBe("commit-1");
    // It really did spawn, into the linked path it was given.
    expect(adapter.specs.length).toBe(1);
    expect(await readFile(join(worktree, "src", "added.ts"), "utf8")).toBe(
      "export const added = true;\n",
    );
  });

  /**
   * A symlink is not itself a violation; leaving the worktree is. A worktree
   * whose `src` is a symlink to another directory INSIDE the same worktree
   * resolves to a path still under the root, so the slice runs.
   */
  test("a symlinked directory that stays inside the worktree is allowed", async () => {
    const world = await makeWorld();
    const worktree = world.slots[0].worktreePath;
    const engine = new FakeEngine();
    engine.onCreate = () => {
      mkdirSync(join(worktree, "actual"), { recursive: true });
      symlinkSync(join(worktree, "actual"), join(worktree, "src"), "dir");
    };

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
        slice: { ...SLICE, ownedPaths: ["src/added.ts"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      5000,
      "run",
    );

    expect(attemptAt(result, 0).failure).toBe(null);
    expect(result.ok).toBe(true);
    expect(adapter.specs.length).toBe(1);
    // Written through the symlink, landing in the real directory beside it.
    expect(await readFile(join(worktree, "actual", "added.ts"), "utf8")).toBe(
      "export const added = true;\n",
    );
  });

  /**
   * A DANGLING SYMBOLIC LINK IS NOT A MISSING FILE, AND CONFUSING THE TWO LETS
   * A WRITE LEAVE THE WORKTREE.
   *
   * `realpath` answers ENOENT for two completely different situations: a name
   * that is genuinely absent, and a name that EXISTS as a symbolic link whose
   * target is absent. The containment walk treats ENOENT as "not created yet"
   * and steps past it, which is right for the first and catastrophic for the
   * second — it rejoins the link's name lexically, as though it were an
   * ordinary directory entry the worker will create inside an already-proven
   * parent, and reports a path that looks contained.
   *
   * It is not contained. A write to a dangling link FOLLOWS the link and
   * creates the file at its target, so when the owned path IS the dangling
   * link, the worker's in-lane `Write` lands outside the repository entirely
   * and `git status` inside the worktree reports nothing. This test scripts a
   * worker that does exactly that, so with the guard removed it fails on the
   * escaped bytes rather than on a message.
   */
  test("an owned path that is itself a dangling symlink is refused before any worker is spawned", async () => {
    const world = await makeWorld();
    const outside = join(world.root, "outside");
    await mkdir(outside, { recursive: true });
    // Deliberately NOT created: that absence is the whole point. The link
    // exists, its target does not, and `realpath` cannot tell you which.
    const danglingTarget = join(outside, "not-created.ts");

    const worktree = world.slots[0].worktreePath;
    const ownedPath = join(worktree, "src", "link.ts");
    const engine = new FakeEngine();
    engine.onCreate = () => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      symlinkSync(danglingTarget, ownedPath, "file");
    };

    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          await writeFile(
            join(spec.cwd, "src", "link.ts"),
            "OVERWRITTEN BY THE WORKER\n",
          );
        },
      },
    ]);
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
        slice: { ...SLICE, ownedPaths: ["src/link.ts"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      5000,
      "run",
    );

    // Asserted first because it is the breach: nothing was created outside the
    // worktree, at the link's target or anywhere beside it.
    expect(await readdir(outside)).toEqual([]);
    expect(existsSync(danglingTarget)).toBe(false);
    // No subprocess ever existed, so the user's quota was never spent on a lane
    // that could only have written somewhere it was never allowed to.
    expect(adapter.specs.length).toBe(0);
    expect(result.ok).toBe(false);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      deterministic: true,
      message: `slice slice-auth attempt 1: refusing to grant owned path "src/link.ts": the real path of ${ownedPath} could not be resolved: path component ${ownedPath} is a symbolic link to ${danglingTarget}, whose target could not be resolved`,
    });
    expect(harness.engine.removes.length).toBe(1);
  });

  /**
   * The same confusion one component higher up, where it costs quota rather
   * than containment.
   *
   * With the dangling link in the MIDDLE of the owned path, a worker writing
   * there gets `EEXIST` from a recursive `mkdir` — it does not follow the link
   * to create the target — and then `ENOENT` from the write, so nothing lands
   * outside. What it costs instead is a real vendor subprocess, the user's paid
   * quota, and a lane that could not possibly have worked. Before the
   * placeholder subsystem was deleted, the recursive `mkdir` that pre-created
   * owned paths hit this link and failed the slice BEFORE any worker launched;
   * that pre-spawn refusal is what regressed.
   *
   * The deeper reason to refuse is that this function's job is to PROVE
   * containment, and through an unresolvable link it can prove nothing. A
   * validation that cannot establish its property must refuse, not pass.
   */
  test("an owned path leading through a dangling symlink is refused before any worker is spawned", async () => {
    const world = await makeWorld();
    const outside = join(world.root, "outside");
    await mkdir(outside, { recursive: true });
    const danglingTarget = join(outside, "not-created");

    const worktree = world.slots[0].worktreePath;
    const linkPath = join(worktree, "src", "link");
    const engine = new FakeEngine();
    engine.onCreate = () => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      symlinkSync(danglingTarget, linkPath, "dir");
    };

    const spawnAttempts: string[] = [];
    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          spawnAttempts.push(spec.cwd);
          await writeFile(
            join(spec.cwd, "src", "link", "victim.ts"),
            "OVERWRITTEN BY THE WORKER\n",
          );
        },
      },
    ]);
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
        slice: { ...SLICE, ownedPaths: ["src/link/victim.ts"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      5000,
      "run",
    );

    // The spawn count IS the property under test here, since the worker's write
    // would have failed on its own. Nothing was spawned, so nothing was spent.
    expect(adapter.specs.length).toBe(0);
    expect(spawnAttempts).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
    expect(result.ok).toBe(false);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      deterministic: true,
      message: `slice slice-auth attempt 1: refusing to grant owned path "src/link/victim.ts": the real path of ${join(worktree, "src", "link", "victim.ts")} could not be resolved: path component ${linkPath} is a symbolic link to ${danglingTarget}, whose target could not be resolved`,
    });
    expect(harness.engine.removes.length).toBe(1);
  });

  /**
   * THE CASE A CARELESS FIX BREAKS. Owned paths are normally absent when this
   * check runs — the worker creates its own files, parent directories and all —
   * so a guard that stopped the walk at every ENOENT rather than only at an
   * ENOENT that hides an existing component would refuse every ordinary slice
   * in the product.
   *
   * Stated separately from the read-only test below because it is a different
   * requirement: not merely that nothing is created, but that a deeply absent
   * path is ACCEPTED and the worker really does spawn.
   */
  test("an owned path whose parent directories do not exist is still accepted", async () => {
    const world = await makeWorld();
    const worktree = world.slots[0].worktreePath;

    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          // Nothing above this existed at the moment containment was proven.
          expect(existsSync(join(spec.cwd, "src"))).toBe(false);
          await mkdir(join(spec.cwd, "src", "deep", "nested"), {
            recursive: true,
          });
          await writeFile(
            join(spec.cwd, "src", "deep", "nested", "added.ts"),
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
        slice: { ...SLICE, ownedPaths: ["src/deep/nested/added.ts"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      5000,
      "run",
    );

    expect(attemptAt(result, 0).failure).toBe(null);
    expect(result.ok).toBe(true);
    expect(result.commit).toBe("commit-1");
    expect(adapter.specs.length).toBe(1);
    expect(
      await readFile(
        join(worktree, "src", "deep", "nested", "added.ts"),
        "utf8",
      ),
    ).toBe("export const added = true;\n");
  });

  /**
   * THE PROOF IS READ-ONLY, AND A MISSING PATH IS NOT A VIOLATION.
   *
   * Both halves matter. Owned paths are normally absent at this moment — the
   * worker creates its own files — so a guard that treated "does not exist" as
   * an escape would refuse every ordinary slice, and a guard that resolved a
   * missing path by creating it would resurrect the placeholder subsystem this
   * unit deleted. The worker reads the worktree the instant it is spawned and
   * finds it exactly as the engine left it: empty.
   */
  test("the containment proof creates no file and no directory", async () => {
    const world = await makeWorld();
    const worktree = world.slots[0].worktreePath;
    const worktreeAtSpawn: string[][] = [];

    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          worktreeAtSpawn.push((await readdir(spec.cwd)).sort());
          await mkdir(join(spec.cwd, "src"), { recursive: true });
          await writeFile(join(spec.cwd, "src", "added.ts"), "ok\n");
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
        slice: {
          ...SLICE,
          ownedPaths: ["src/added.ts", "docs/very/deep/notes.md"],
        },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      5000,
      "run",
    );

    expect(result.ok).toBe(true);
    // The guard ran between `create` and `spawn` and left nothing behind: not
    // the owned files, not the `docs/very/deep` chain it had to walk up.
    expect(worktreeAtSpawn).toEqual([[]]);
    expect(await exists(join(worktree, "docs"))).toBe(false);
  });

  /**
   * An absolute owned path is refused by name here too. `validatePlan` rejects
   * it three modules away, but this is the code that is about to declare the
   * path writable, so it is the code that has to be able to prove the claim.
   */
  test("an absolute owned path is refused by name", async () => {
    const world = await makeWorld();
    const worktree = world.slots[0].worktreePath;
    const adapter = claudeAdapter([]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
    });

    const result = await withBound(
      runner.run({
        slice: { ...SLICE, ownedPaths: ["/etc/hosts"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      5000,
      "run",
    );

    expect(result.ok).toBe(false);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      deterministic: true,
      message: `slice slice-auth attempt 1: refusing to grant owned path "/etc/hosts": it is absolute and does not belong to worktree root ${worktree}`,
    });
    expect(adapter.specs.length).toBe(0);
  });

  /**
   * THE REGRESSION FOR THE SECOND HALF OF THE SAME HOLE. `resolve` collapses
   * `..` LEXICALLY, before any filesystem call, so `src/link/../victim.ts`
   * becomes `<root>/src/victim.ts` and the `link` component is erased. Every
   * check downstream then agrees the path is contained — because it is asking
   * about a path the operating system will never follow. The OS resolving
   * `link/..` walks to the parent of the symlink's TARGET, not back to the
   * root, so the write lands outside the worktree exactly as it does through a
   * plain symlinked directory.
   *
   * `validatePlan` rejects `..` three modules away, so a plan cannot carry one;
   * this is reachable through `createSliceRunner(...).run(...)` directly, and
   * the guard's own contract is that it restates rather than trusts. It already
   * restates the empty, NUL and absolute checks. This test states the missing
   * one.
   *
   * Driven through the runner rather than against the helper, because the point
   * is not that a predicate returns false — it is that no subprocess is ever
   * told it may write there.
   */
  test("an owned path with a .. segment stepping out through a symlink is refused before any worker is spawned", async () => {
    const world = await makeWorld();
    const outside = join(world.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "victim.ts"), "ORIGINAL SECRET CONTENT\n");

    const worktree = world.slots[0].worktreePath;
    const engine = new FakeEngine();
    // `src/link` points at a directory outside the worktree, so the OS reading
    // `src/link/..` lands in `outside`'s parent — `world.root` — and the file
    // written beside it is `world.root/outside/victim.ts`.
    engine.onCreate = () => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      symlinkSync(
        join(outside, "nested"),
        join(worktree, "src", "link"),
        "dir",
      );
      mkdirSync(join(outside, "nested"), { recursive: true });
    };

    // Scripted to do exactly what a lane-scoped worker does with the path it
    // was granted. With the guard removed this runs, and the assertions below
    // fail on the overwritten bytes rather than on a message.
    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          // Concatenated, NOT `join`ed. `join` collapses `..` lexically exactly
          // as `resolve` does, so joining here would write to `src/victim.ts`
          // and quietly stage a version of this test that cannot fail. The
          // whole defect is that the string handed to the OS keeps its `..`.
          await writeFile(
            `${spec.cwd}/src/link/../victim.ts`,
            "OVERWRITTEN BY THE WORKER\n",
          );
        },
      },
    ]);
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
        slice: { ...SLICE, ownedPaths: ["src/link/../victim.ts"] },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      5000,
      "run",
    );

    // Asserted first because it is the whole point: the file outside the
    // worktree is untouched, byte for byte.
    expect(await readFile(join(outside, "victim.ts"), "utf8")).toBe(
      "ORIGINAL SECRET CONTENT\n",
    );
    // No subprocess ever existed, so nothing was ever told it could write there.
    expect(adapter.specs.length).toBe(0);
    expect(result.ok).toBe(false);
    expect(attemptAt(result, 0).failure).toEqual({
      kind: "WORKTREE_FAILED",
      deterministic: true,
      message: `slice slice-auth attempt 1: refusing to grant owned path "src/link/../victim.ts": it contains a ".." segment, which may leave worktree root ${worktree} through a symbolic link`,
    });
    // The refused attempt still tears its worktree down.
    expect(harness.engine.removes.length).toBe(1);
  });

  /**
   * THE CASE THAT BREAKS THE FIX WHILE THE SUITE STAYS GREEN. `..` is refused
   * as a path SEGMENT, never as a substring. `..hidden.ts` is an ordinary
   * dotfile and `a..b.ts` an ordinary name — a guard that reached for
   * `includes("..")` would refuse both and fail closed on real repositories,
   * with every traversal test still passing.
   */
  test("owned paths whose filenames merely contain .. are allowed", async () => {
    const world = await makeWorld();
    const worktree = world.slots[0].worktreePath;

    const adapter = claudeAdapter([
      {
        onSpawn: async (spec) => {
          await mkdir(join(spec.cwd, "src"), { recursive: true });
          await writeFile(
            join(spec.cwd, "src", "a..b.ts"),
            "export const a = 1;\n",
          );
          await writeFile(
            join(spec.cwd, "src", "..hidden.ts"),
            "export const h = 2;\n",
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
        slice: {
          ...SLICE,
          ownedPaths: [
            "src/a..b.ts",
            "src/..hidden.ts",
            "docs/..deep../notes.md",
          ],
        },
        directive: DIRECTIVE,
        session: world.session,
        attemptSlots: firstSlot(world),
        routing: ROUTING,
        unsafeInPlace: false,
      }),
      5000,
      "run",
    );

    expect(attemptAt(result, 0).failure).toBe(null);
    expect(result.ok).toBe(true);
    expect(result.commit).toBe("commit-1");
    expect(adapter.specs.length).toBe(1);
    expect(await readFile(join(worktree, "src", "a..b.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );
    expect(await readFile(join(worktree, "src", "..hidden.ts"), "utf8")).toBe(
      "export const h = 2;\n",
    );
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
      // The gate is injected as one that never touches the clock, so the number
      // below measures the attempt rather than the gate's bookkeeping.
      review: skippingReviewer(),
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

    // The injected clock advances 5 ms per read. The attempt reads it at its
    // start and its end, and `#reviewQuietly` reads it once more so a reviewer
    // that throws can still be given a duration.
    expect(attemptAt(result, 0).durationMs).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// The cross-vendor review gate
//
// Every test here drives the gate through the injected `review` seam rather
// than through two real vendors, so each verdict — including the ones a healthy
// machine almost never produces — is reachable from a literal. The gate's own
// logic (which vendor reviews, what the prompt says, how a reply is parsed and
// adjudicated) is tested against the real implementation in
// `test/supervisor-review.test.ts`.
// ---------------------------------------------------------------------------

describe("DefaultSliceRunner review gate", () => {
  test("a rejected review fails the slice as REVIEW_REJECTED and never commits", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{ outcome: OK_OUTCOME }]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
      review: fakeReviewer([REJECTED]),
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
    expect(result.commit).toBe(null);
    // THE LOAD-BEARING ASSERTION. A gate that rejected after committing would
    // leave a ref on a branch the orchestrator may still merge, and no method
    // on the engine can take it back. `commit` must never have been called.
    expect(harness.engine.commits).toEqual([]);
    const failure = attemptAt(result, 0).failure;
    expect(failure?.kind).toBe("REVIEW_REJECTED");
    expect(failure?.message).toBe(
      "slice slice-auth attempt 1: codex/gpt-5.6-sol found 1 blocking issue(s) in claude/claude-opus-5's work: src/added.ts:12: the loop runs one past the end of the array",
    );
  });

  test("the review runs before the commit, with the worktree still uncommitted", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{ outcome: OK_OUTCOME }]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    // Records what the engine had done by the time the gate was asked. A gate
    // that ran after the commit would see one commit here instead of none.
    const commitsAtReview: number[] = [];
    const seen: SliceReviewRequest[] = [];
    const spy: SliceReviewer = {
      review: (request: SliceReviewRequest): Promise<SliceReview> => {
        seen.push(request);
        commitsAtReview.push(harness.engine.commits.length);
        return Promise.resolve(APPROVED);
      },
    };
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
      review: spy,
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
    expect(commitsAtReview).toEqual([0]);
    expect(harness.engine.commits.length).toBe(1);
    // The gate is handed the live worktree the builder just wrote into, the
    // builder's identity, and the attempt number — everything a reviewer needs
    // and nothing it does not.
    expect(seen.length).toBe(1);
    expect(seen[0]?.worktreePath).toBe(join(world.root, "wt", "slice-7"));
    expect(seen[0]?.attempt).toBe(1);
    expect(seen[0]?.builder.vendor).toBe("claude");
    expect(seen[0]?.builder.model).toBe("claude-opus-5");
    expect(seen[0]?.slice.id).toBe("slice-auth");
  });

  test("a rejection excludes the builder's exact pair and escalates attempt 2", async () => {
    const world = await makeWorld();
    const claude = claudeAdapter([
      { outcome: OK_OUTCOME },
      { outcome: OK_OUTCOME },
    ]);
    const harness = makeHarness({ workers: { claude: claude.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
      review: fakeReviewer([REJECTED, APPROVED]),
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

    // DECISION #24, REACHED FOR THE FIRST TIME. Every previous route to a
    // second attempt came from a worker that did not finish. This one comes
    // from work that finished and was judged wrong, which is the case the
    // escalation was designed for and which nothing could produce until the
    // gate existed.
    expect(result.ok).toBe(true);
    expect(result.attempts.length).toBe(2);
    expect(harness.routeRequests.length).toBe(2);
    expect(harness.routeRequests[1]?.excluded).toEqual([
      { vendor: "claude", model: "claude-opus-5" },
    ]);
    expect(harness.routeRequests[1]?.escalated).toBe(true);
    expect(attemptAt(result, 0).failure?.kind).toBe("REVIEW_REJECTED");
    expect(attemptAt(result, 1).failure).toBe(null);
    expect(attemptAt(result, 1).review?.verdict).toBe("approved");
  });

  test("two rejections end the slice with both verdicts on the record", async () => {
    const world = await makeWorld();
    const claude = claudeAdapter([
      { outcome: OK_OUTCOME },
      { outcome: OK_OUTCOME },
    ]);
    const harness = makeHarness({ workers: { claude: claude.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute(
        [routedTo(OPUS), routedTo(HAIKU)],
        harness.routeRequests,
      ),
      review: fakeReviewer([REJECTED, REJECTED]),
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
    expect(result.attempts.length).toBe(2);
    expect(harness.engine.commits).toEqual([]);
    expect(attemptAt(result, 0).failure?.kind).toBe("REVIEW_REJECTED");
    expect(attemptAt(result, 1).failure?.kind).toBe("REVIEW_REJECTED");
    // Both worktrees were torn down: a rejected attempt takes the ordinary
    // failure path, which is the entire reason the gate sits where it does.
    expect(harness.engine.removes.length).toBe(2);
  });

  test("an approved review commits and rides on the attempt record", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{ outcome: OK_OUTCOME }]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const approvedWithConcern: SliceReview = {
      verdict: "approved",
      reviewer: REVIEWER,
      findings: [CONCERN_FINDING],
      durationMs: 0,
    };
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
      review: fakeReviewer([approvedWithConcern]),
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
    const review = attemptAt(result, 0).review;
    expect(review?.verdict).toBe("approved");
    // The concern survives the approval. It did not stop the commit and it is
    // still the most useful thing the reviewer said.
    expect(review?.verdict === "approved" ? review.findings : []).toEqual([
      CONCERN_FINDING,
    ]);
    expect(harness.logs).toContain(
      "slice slice-auth attempt 1: review approved by codex/gpt-5.6-sol (0 blocking, 1 concern(s)) in 0ms",
    );
  });

  test("a skipped review still commits and is never recorded as an approval", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{ outcome: OK_OUTCOME }]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
      review: fakeReviewer([SKIPPED]),
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

    // FAIL-OPEN, AND VISIBLY SO. The slice commits, because a gate that could
    // not run says nothing about the code — but the record says `skipped` with
    // its reason, so nothing downstream can report this as a reviewed slice.
    expect(result.ok).toBe(true);
    const review = attemptAt(result, 0).review;
    expect(review?.verdict).toBe("skipped");
    expect(review?.verdict === "skipped" ? review.reason : null).toBe(
      "NO_OTHER_VENDOR",
    );
  });

  test("the gate is not consulted when the worker itself failed", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{ outcome: AUTH_FAILED_OUTCOME }]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const reviewer = fakeReviewer([]);
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
      review: reviewer,
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
    expect(attemptAt(result, 0).failure?.kind).toBe("WORKER_FAILED");
    // There is no work to judge, so the gate is never asked. The fake would
    // throw if it were, since it was given no verdicts at all.
    expect(reviewer.requests()).toEqual([]);
    expect(attemptAt(result, 0).review).toBe(null);
  });

  test("a reviewer that throws is contained, and the slice still commits", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{ outcome: OK_OUTCOME }]);
    const harness = makeHarness({ workers: { claude: adapter.worker } });
    const exploding: SliceReviewer = {
      review: (): Promise<SliceReview> => {
        throw new Error("the gate itself is broken");
      },
    };
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
      review: exploding,
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

    // A broken gate must not be reported as a broken builder. Without the
    // containment in `#reviewQuietly` this throw reaches `#runAttempt`'s outer
    // catch and the slice fails as WORKER_FAILED — blaming a worker that
    // succeeded and discarding a diff that may well have been correct.
    expect(result.ok).toBe(true);
    const review = attemptAt(result, 0).review;
    expect(review?.verdict).toBe("skipped");
    expect(review?.verdict === "skipped" ? review.reason : null).toBe(
      "REVIEWER_FAILED",
    );
    expect(review?.verdict === "skipped" ? review.message : "").toBe(
      "slice slice-auth attempt 1 was not reviewed: the reviewer threw instead of reporting: the gate itself is broken",
    );
  });

  test("a cleanup note appended to a rejection keeps its findings", async () => {
    const world = await makeWorld();
    const adapter = claudeAdapter([{ outcome: OK_OUTCOME }]);
    const engine = new FakeEngine();
    engine.removeError = new Error("directory is busy");
    const harness = makeHarness({
      engine,
      workers: { claude: adapter.worker },
    });
    const runner = new DefaultSliceRunner({
      ports: harness.ports,
      env: ENV,
      route: stubRoute([routedTo(OPUS)], harness.routeRequests),
      review: fakeReviewer([REJECTED]),
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

    // `appendNote` rebuilds the failure member by member. A REVIEW_REJECTED arm
    // that forgot to copy `review` would leave a user with a rejection whose
    // diagnosis had been thrown away because tidying up also went wrong.
    const failure = attemptAt(result, 0).failure;
    expect(failure?.kind).toBe("REVIEW_REJECTED");
    expect(
      failure?.kind === "REVIEW_REJECTED" ? failure.review.findings : [],
    ).toEqual([BLOCKING_FINDING]);
    expect(failure?.message).toContain("cleanup of worktree");
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
