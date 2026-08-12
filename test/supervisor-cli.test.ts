import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrigadierConfig } from "../src/config/index.ts";
import { resolveConfigPath, writeConfig } from "../src/config/index.ts";
import type {
  AnyWorker,
  ClaudeWorkerSpec,
  SpawnedWorker,
  Worker,
} from "../src/contracts.ts";
import type {
  InputStream,
  OutputStream,
  RunHarness,
} from "../src/init/index.ts";
import {
  buildRunDependencies,
  createInterruptGate,
  runCli,
} from "../src/init/index.ts";
import type { McpRunControl } from "../src/mcp/server.ts";
import type {
  Planner,
  PlannerOutcome,
  PlannerRequest,
} from "../src/planner/index.ts";
import type {
  SliceResult,
  SliceRunInput,
  SliceRunner,
} from "../src/supervisor/index.ts";
import {
  parsePlanDocument,
  requireLaunchEnv,
} from "../src/supervisor/index.ts";
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
} from "../src/worktree/index.ts";

/**
 * A config naming models that exist in both `CAPABILITY_TABLE` and
 * `COMPETENCE_TABLE`, so the routing every assertion below depends on is the
 * real router's answer rather than a fixture's.
 *
 * The three scores are 100 (opus), 74 (sonnet), and 70 (terra) against
 * difficulty floors of 90 (hard) and 0 (routine). A `hard` slice therefore has
 * exactly one eligible model and a `routine` slice picks the cheapest of the
 * three — two absolute, independently checkable outcomes.
 */
const CONFIG: BrigadierConfig = {
  version: 3,
  vendors: [
    {
      vendor: "claude",
      executable: "/opt/homebrew/bin/claude",
      version: "2.0.14",
      defaultModel: "claude-opus-5",
      models: [
        { id: "claude-opus-5", effortCeiling: "high" },
        { id: "claude-sonnet-5", effortCeiling: "high" },
      ],
    },
    {
      vendor: "codex",
      executable: "/opt/homebrew/bin/codex",
      version: "0.145.0",
      defaultModel: "gpt-5.6-terra",
      models: [{ id: "gpt-5.6-terra", effortCeiling: "high" }],
    },
  ],
  secretsConsent: false,
  linkedSecretPaths: [],
  allowDegradedRouting: false,
};

const PLAN = {
  id: "demo-plan",
  goal: "prove the wiring",
  slices: [
    {
      id: "s1",
      title: "the hard bit",
      prompt: "do the hard bit",
      ownedPaths: ["src/hard.ts"],
      difficulty: "hard",
    },
    {
      id: "s2",
      title: "the routine bit",
      prompt: "do the routine bit",
      ownedPaths: ["src/routine.ts"],
      difficulty: "routine",
    },
  ],
};

const FAKE_SESSION: WorktreeSession = {
  repositoryPath: "/repo",
  slug: "demo-plan",
  baseCommit: "0000000000000000000000000000000000000000",
  baseBranch: "brigadier/demo-plan/base",
  integrationBranch: "brigadier/demo-plan/integration",
};

/**
 * A `WorktreeEngine` that records every call and touches no git.
 *
 * `prepare` returns one fixed session so two runs of the same plan produce
 * byte-identical recordings, which is what makes "`--plan <file>` and
 * `--plan -` produce the same request" checkable by deep equality.
 */
class RecordingEngine implements WorktreeEngine {
  readonly prepared: WorktreeSessionSpec[] = [];
  readonly created: WorktreeSpec[] = [];
  readonly committed: CommitSpec[] = [];
  readonly merges: MergeSpec[] = [];
  readonly removed: CreatedWorktree[] = [];
  readonly released: WorktreeSession[] = [];
  /** Set to make `remove` / `release` fail, which is a cleanup failure. */
  removeError: Error | null = null;
  releaseError: Error | null = null;
  #worktreeRoot: string;

  constructor(worktreeRoot = "/fake-worktrees") {
    this.#worktreeRoot = worktreeRoot;
  }

  prepare(spec: WorktreeSessionSpec): Promise<WorktreeSession> {
    this.prepared.push(spec);
    return Promise.resolve({ ...FAKE_SESSION, slug: spec.slug });
  }

  create(spec: WorktreeSpec): Promise<CreatedWorktree> {
    this.created.push(spec);
    return Promise.resolve({
      repositoryPath: spec.session.repositoryPath,
      path: spec.path ?? join(this.#worktreeRoot, `slice-${spec.slice}`),
      branch: `brigadier/${spec.session.slug}/slice-${spec.slice}`,
      isolated: spec.unsafeInPlace !== true,
      session: spec.session,
    });
  }

  commit(spec: CommitSpec): Promise<CommitResult> {
    this.committed.push(spec);
    return Promise.resolve({ commit: "c0ffee0", message: spec.message });
  }

  merge(spec: MergeSpec): Promise<MergeResult> {
    this.merges.push(spec);
    return Promise.resolve({
      status: "merged",
      commit: `merged-${spec.worktree.branch}`,
      integrationBranch: spec.worktree.session.integrationBranch,
    });
  }

  redact(_worktree: CreatedWorktree, artifact: string): string {
    return artifact;
  }

  remove(worktree: CreatedWorktree): Promise<void> {
    this.removed.push(worktree);
    return this.removeError === null
      ? Promise.resolve()
      : Promise.reject(this.removeError);
  }

  /**
   * The orchestrator's last cleanup step: retiring the session's refs. Recorded
   * rather than performed, and able to fail on demand, because the sentence the
   * report prints about an interrupt is a claim about exactly this call.
   */
  release(session: WorktreeSession): Promise<void> {
    this.released.push(session);
    return this.releaseError === null
      ? Promise.resolve()
      : Promise.reject(this.releaseError);
  }
}

/** Records what the orchestrator hands each slice, and answers as scripted. */
class RecordingSliceRunner implements SliceRunner {
  readonly inputs: SliceRunInput[] = [];
  #answer: (input: SliceRunInput) => Promise<SliceResult>;
  #inFlight = 0;
  maxInFlight = 0;

  constructor(answer: (input: SliceRunInput) => Promise<SliceResult>) {
    this.#answer = answer;
  }

  async run(input: SliceRunInput): Promise<SliceResult> {
    this.inputs.push(input);
    this.#inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    try {
      // One real turn of the event loop, so a pool that starts two slices at
      // once is observably different from one that starts them in sequence.
      // Bounded by construction: a fixed timer, never a condition.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await this.#answer(input);
    } finally {
      this.#inFlight -= 1;
    }
  }
}

function succeed(input: SliceRunInput): Promise<SliceResult> {
  const slot = input.attemptSlots[0];
  const branch = `brigadier/${input.session.slug}/slice-${slot?.sliceNumber ?? 0}`;
  return Promise.resolve({
    sliceId: input.slice.id,
    ok: true,
    branch,
    commit: `commit-${input.slice.id}`,
    worktree: {
      repositoryPath: input.session.repositoryPath,
      path: slot?.worktreePath ?? "/fake-worktrees/slice",
      branch,
      isolated: true,
      session: input.session,
    },
    attempts: [
      {
        attempt: 1,
        routed: {
          vendor: "claude",
          model: "claude-opus-5",
          effort: "high",
          rationale: ["fixture"],
          waivedDifficultyFloor: false,
        },
        outcome: null,
        commit: `commit-${input.slice.id}`,
        // A real approval, so the CLI's report rendering of a passing gate is
        // exercised by the ordinary success fixture rather than only by the
        // tests written for the gate.
        review: {
          verdict: "approved",
          reviewer: {
            vendor: "codex",
            model: "gpt-5.6-terra",
            effort: "high",
          },
          findings: [],
          durationMs: 0,
        },
        failure: null,
        durationMs: 0,
      },
    ],
  });
}

function failWorker(input: SliceRunInput): Promise<SliceResult> {
  return Promise.resolve({
    sliceId: input.slice.id,
    ok: false,
    branch: null,
    commit: null,
    worktree: null,
    attempts: [
      {
        attempt: 1,
        routed: {
          vendor: "codex",
          model: "gpt-5.6-terra",
          effort: "medium",
          rationale: ["fixture"],
          waivedDifficultyFloor: false,
        },
        outcome: null,
        commit: null,
        // The worker never finished, so the gate was never reached.
        review: null,
        failure: {
          kind: "WORKER_FAILED",
          message: `slice ${input.slice.id} attempt 1 failed on purpose`,
          failure: {
            kind: "UNKNOWN_FAILURE",
            message: "failed on purpose",
            retryable: false,
            statusCode: null,
          },
        },
        durationMs: 0,
      },
    ],
  });
}

/**
 * A planner that answers from a literal and records what it was asked.
 *
 * No test in this file may spawn a real model: the CLI's exit codes would then
 * be a function of somebody's quota and of a network. The planner's own prompt,
 * budget rule and reply parsing are proven in `test/planner.test.ts`, one seam
 * lower, against the real `createModelPlanner`.
 */
class RecordingPlanner implements Planner {
  readonly requests: PlannerRequest[] = [];
  #outcome: PlannerOutcome;

  constructor(outcome: PlannerOutcome) {
    this.#outcome = outcome;
  }

  plan(request: PlannerRequest): Promise<PlannerOutcome> {
    this.requests.push(request);
    return Promise.resolve(this.#outcome);
  }
}

/**
 * A successful planning outcome carrying the same plan the `--plan` tests use.
 *
 * Built through `parsePlanDocument` rather than as an object literal, because
 * that is the ONLY way the product builds one: a fixture that hand-assembled a
 * `PlanDocument` could carry a shape the real planner can never produce, and
 * every assertion resting on it would be measuring the fixture.
 */
function plannedOutcome(): PlannerOutcome {
  return {
    kind: "planned",
    document: parsePlanDocument(PLAN),
    json: JSON.stringify(PLAN, null, 2),
    planner: { vendor: "claude", model: "claude-opus-5", effort: "high" },
  };
}

interface Invocation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly engine: RecordingEngine;
  readonly runner: RecordingSliceRunner | null;
}

interface InvokeOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly scratchHome: string;
  readonly stdin?: string;
  readonly config?: BrigadierConfig | null;
  readonly runner?: RecordingSliceRunner | null;
  /** Replaces the model that turns a task description into a plan. */
  readonly planner?: Planner;
  /** Replaces only the adapter below the production model planner. */
  readonly plannerWorkerFor?: RunHarness["plannerWorkerFor"];
  /** Replaces the stdio MCP server, which would otherwise block on stdin. */
  readonly mcpServer?: (control?: McpRunControl) => Promise<number>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Drives cancellation the way `src/cli.ts` does, minus the signal handler.
   * No test in this file sends a real signal: doing so would kill the test
   * runner and prove nothing repeatable.
   */
  readonly signal?: AbortSignal;
  /** The seam `src/cli.ts` uses to arm its interrupt gate. */
  readonly onCancellable?: () => void;
  /** Mutates the recording engine before the CLI runs, to fail cleanup. */
  readonly breakEngine?: (engine: RecordingEngine) => void;
}

async function invoke(options: InvokeOptions): Promise<Invocation> {
  const scratchHome = options.scratchHome;
  const config = options.config === undefined ? CONFIG : options.config;
  if (config !== null) {
    await writeConfig(
      resolveConfigPath({ BRIGADIER_HOME: scratchHome }),
      config,
    );
  }
  const engine = new RecordingEngine();
  options.breakEngine?.(engine);
  const runner =
    options.runner === undefined
      ? new RecordingSliceRunner(succeed)
      : options.runner;
  const harness: RunHarness = {
    engine,
    // A constant clock: every duration the report prints is then exactly 0ms.
    now: () => 1_700_000_000_000,
    ...(runner === null ? {} : { sliceRunner: runner }),
    ...(options.planner === undefined ? {} : { planner: options.planner }),
    ...(options.plannerWorkerFor === undefined
      ? {}
      : { plannerWorkerFor: options.plannerWorkerFor }),
  };
  const stdout = collector();
  const stderr = collector();
  const code = await runCli({
    argv: options.argv,
    version: "0.0.0",
    env: options.env ?? {
      BRIGADIER_HOME: scratchHome,
      HOME: scratchHome,
      PATH: "/usr/bin:/bin",
      USER: "worker",
    },
    stdout,
    stderr,
    cwd: options.cwd,
    harness,
    ...(options.stdin === undefined
      ? {}
      : { stdin: scriptedInput(options.stdin) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.mcpServer === undefined
      ? {}
      : { mcpServer: options.mcpServer }),
    ...(options.onCancellable === undefined
      ? {}
      : { onCancellable: options.onCancellable }),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), engine, runner };
}

async function settleWithin<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    work.then((value) => ({ kind: "settled" as const, value })),
    new Promise<{ readonly kind: "timed-out" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timed-out" }), 20_000);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  expect(raced.kind).toBe("settled");
  if (raced.kind === "timed-out") {
    throw new Error(`${label} did not settle within 20000 ms`);
  }
  return raced.value;
}

function fakePlanningWorker(specs: ClaudeWorkerSpec[]): Worker<"claude"> {
  const oneSlicePlan = { ...PLAN, slices: [PLAN.slices[0]] };
  return {
    vendor: "claude",
    processCompletion: "signals-then-must-be-killed",
    spawn: (spec: ClaudeWorkerSpec): Promise<SpawnedWorker> => {
      specs.push(spec);
      return Promise.resolve({
        pid: 4242,
        events: {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.resolve({ done: true as const, value: undefined }),
          }),
        },
        completion: Promise.resolve({
          ok: true,
          output: JSON.stringify({ status: "plan", plan: oneSlicePlan }),
          usage: {
            input: { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 },
            output: { total: 0, reasoning: null },
          },
          durationMs: 0,
          exitCode: 0,
          signal: null,
        }),
        cancel: () => Promise.resolve(),
      });
    },
  };
}

async function withScratchHome(
  body: (paths: {
    scratchHome: string;
    cwd: string;
    plan: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "brigadier-run-"));
  try {
    const scratchHome = join(root, "home");
    const cwd = join(root, "repo");
    await mkdir(scratchHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const plan = join(cwd, "plan.json");
    await writeFile(plan, `${JSON.stringify(PLAN, null, 2)}\n`);
    await body({ scratchHome, cwd, plan });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function collector(): OutputStream & { text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

/** Everything about a slice's input that the plan source determines. */
function footprint(inputs: readonly SliceRunInput[]): unknown {
  return inputs.map((input) => ({
    slice: input.slice,
    directive: input.directive,
    session: input.session,
    attemptSlots: input.attemptSlots,
    unsafeInPlace: input.unsafeInPlace,
    config: input.routing.config,
    capabilities: input.routing.capabilities,
  }));
}

function scriptedInput(text: string): InputStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
}

describe("brigadier run: the plan source", () => {
  test("--plan <file> and --plan - build the identical run", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const fromFile = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
      });
      const fromStdin = await invoke({
        argv: ["run", "--plan", "-"],
        cwd,
        scratchHome,
        stdin: JSON.stringify(PLAN),
      });

      expect(fromFile.code).toBe(0);
      expect(fromStdin.code).toBe(0);
      expect(fromFile.stdout).toBe(fromStdin.stdout);

      // The whole request, observed where it lands: the session spec carries
      // `repositoryPath` and `slug`, and each `SliceRunInput` carries the parsed
      // document, the pre-allocated slots, and `unsafeInPlace`.
      expect(fromFile.engine.prepared).toEqual(fromStdin.engine.prepared);
      expect(fromFile.engine.prepared).toEqual([
        {
          repositoryPath: cwd,
          slug: "demo-plan",
          secrets: { linkedPaths: [], consentToLink: false },
        },
      ]);
      // Compared through a projection rather than by raw deep equality: the
      // routing input each slice receives carries a live quota snapshot whose
      // `observedAtMs` is a wall-clock reading, and two runs are milliseconds
      // apart. Everything the plan source could possibly influence is here.
      expect(footprint(fromFile.runner?.inputs ?? [])).toEqual(
        footprint(fromStdin.runner?.inputs ?? []),
      );

      const inputs = fromFile.runner?.inputs ?? [];
      expect(inputs.map((input) => input.slice.id)).toEqual(["s1", "s2"]);
      expect(inputs.map((input) => input.directive.difficulty)).toEqual([
        "hard",
        "routine",
      ]);
      expect(inputs[0]?.slice.ownedPaths).toEqual(["src/hard.ts"]);
      expect(inputs[0]?.unsafeInPlace).toBe(false);
      expect(inputs[0]?.attemptSlots.map((slot) => slot.sliceNumber)).toEqual([
        1, 2,
      ]);
      expect(inputs[1]?.attemptSlots.map((slot) => slot.sliceNumber)).toEqual([
        3, 4,
      ]);
    });
  });

  test("a malformed plan reports every issue, not just the first", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const malformed = join(cwd, "broken.json");
      await writeFile(
        malformed,
        JSON.stringify({
          id: "",
          goal: "no goal",
          slices: [
            {
              id: "s1",
              title: "",
              prompt: "do it",
              ownedPaths: [],
              difficulty: "impossible",
            },
          ],
        }),
      );

      const result = await invoke({
        argv: ["run", "--plan", malformed],
        cwd,
        scratchHome,
      });

      expect(result.code).toBe(1);
      // Four issues, every one of them, in the parser's own order. A CLI that
      // reported `error.message` alone would print them joined into one
      // sentence; a CLI that reported `issues[0]` would print one.
      expect(result.stderr).toContain(
        `brigadier run: ${malformed} is not a valid plan document (4 issue(s)):`,
      );
      expect(result.stderr).toContain("  plan id must be a non-empty string\n");
      expect(result.stderr).toContain(
        "  slices[0].title must be a non-empty string\n",
      );
      expect(result.stderr).toContain(
        "  slices[0].ownedPaths must not be empty\n",
      );
      expect(result.stderr).toContain(
        '  slices[0]: difficulty "impossible" is not one of routine, standard, hard\n',
      );
      expect(result.engine.prepared).toEqual([]);
    });
  });

  test("an unreadable plan file exits 1 and creates nothing", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const missing = join(cwd, "absent.json");
      const result = await invoke({
        argv: ["run", "--plan", missing],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `brigadier run: could not read the plan file ${missing}:`,
      );
      expect(result.engine.prepared).toEqual([]);
    });
  });

  test("a plan file that is not JSON exits 1 naming the file", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const garbage = join(cwd, "garbage.json");
      await writeFile(garbage, "{not json");
      const result = await invoke({
        argv: ["run", "--plan", garbage],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `brigadier run: ${garbage} is not valid JSON:`,
      );
    });
  });
});

describe("brigadier run: options", () => {
  test("--max-workers defaults to exactly 1", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const runner = new RecordingSliceRunner(succeed);
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        runner,
      });
      expect(result.code).toBe(0);
      // Both slices are in one dependency wave, so a pool of 2 would show 2.
      expect(runner.inputs).toHaveLength(2);
      expect(runner.maxInFlight).toBe(1);
    });
  });

  test("--max-workers 2 raises the bound to exactly 2", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const runner = new RecordingSliceRunner(succeed);
      const result = await invoke({
        argv: ["run", "--plan", plan, "--max-workers", "2"],
        cwd,
        scratchHome,
        runner,
      });
      expect(result.code).toBe(0);
      expect(runner.maxInFlight).toBe(2);
    });
  });

  test("--max-workers rejects a non-positive-integer value with exit 2", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      for (const value of ["0", "-1", "2.5", "two", "1e3"]) {
        const result = await invoke({
          argv: ["run", "--plan", plan, "--max-workers", value],
          cwd,
          scratchHome,
        });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(
          `brigadier run: --max-workers must be a positive whole number, received ${JSON.stringify(value)}`,
        );
      }
    });
  });

  test("--slug overrides the derived slug and is checked before any ref", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const named = await invoke({
        argv: ["run", "--plan", plan, "--slug", "wo-011"],
        cwd,
        scratchHome,
      });
      expect(named.code).toBe(0);
      expect(named.engine.prepared[0]?.slug).toBe("wo-011");

      const rejected = await invoke({
        argv: ["run", "--plan", plan, "--slug", "../escape"],
        cwd,
        scratchHome,
      });
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain(
        'brigadier run: --slug "../escape" is not branch-safe',
      );
      expect(rejected.engine.prepared).toEqual([]);
    });
  });

  test("--unsafe-in-place reaches the slice input", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const runner = new RecordingSliceRunner(succeed);
      const result = await invoke({
        argv: ["run", "--plan", plan, "--unsafe-in-place"],
        cwd,
        scratchHome,
        runner,
      });
      expect(result.code).toBe(0);
      expect(runner.inputs.map((input) => input.unsafeInPlace)).toEqual([
        true,
        true,
      ]);
    });
  });

  test("an unknown option exits 2 and creates nothing", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const result = await invoke({
        argv: ["run", "--plan", plan, "--nope"],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('brigadier run: unknown option "--nope"');
      expect(result.stderr).toContain("Usage: brigadier <command> [options]");
      expect(result.engine.prepared).toEqual([]);
    });
  });

  /**
   * `run` with nothing at all is still a usage error, but it can no longer say
   * that `--plan` is required: a task description is now an equally valid way
   * to run, and a message naming only one of the two forms would send a user
   * looking for a plan file they were never supposed to need.
   */
  test("run with neither a task nor a plan exits 2 and names both forms", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const result = await invoke({ argv: ["run"], cwd, scratchHome });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        'brigadier run: nothing to run; pass a task description as a single quoted argument, or a plan JSON file with `--plan <file>` ("-" reads it from stdin)',
      );
    });
  });

  test("run --help prints usage and exits 0 without reading a plan", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      for (const flag of ["--help", "-h"]) {
        const result = await invoke({ argv: ["run", flag], cwd, scratchHome });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Options for run:");
        expect(result.stdout).toContain(
          "--plan <file>    the plan JSON to run",
        );
      }
    });
  });

  /**
   * The exit-code table is an interface a CI step branches on, so it has to
   * name the precondition the code actually enforces. `requireLaunchEnv`
   * demands HOME, PATH and USER; the table used to promise only the first two,
   * which told an operator debugging a USER-less environment to look anywhere
   * but at the real cause.
   */
  test("the exit-code table names every variable requireLaunchEnv demands", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const result = await invoke({
        argv: ["run", "--help"],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "  1  brigadier could not start the run: no config, an unreadable or invalid\n     plan file, an environment with no HOME, PATH, or USER, or a planner that\n     could not produce a plan",
      );
      // The code the sentence describes.
      expect(() =>
        requireLaunchEnv({ HOME: "/Users/worker", PATH: "/usr/bin" }),
      ).toThrow("cannot launch a worker: USER is missing from the environment");
    });
  });
});

describe("brigadier run: the task positional", () => {
  test("the default CLI planner bridge resolves a configured worker adapter", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const specs: ClaudeWorkerSpec[] = [];
      const worker = fakePlanningWorker(specs);
      const result = await settleWithin(
        invoke({
          argv: ["run", "fix the parser"],
          cwd,
          scratchHome,
          plannerWorkerFor: (vendor) => (vendor === "claude" ? worker : null),
        }),
        "production planner bridge",
      );

      expect(result.code).toBe(0);
      expect(
        specs.map((spec) => ({
          id: spec.id,
          vendor: spec.vendor,
          model: spec.model,
          effort: spec.effort,
          cwd: spec.cwd,
          timeoutMs: spec.timeoutMs,
          maxTurns: spec.maxTurns,
          editablePaths: spec.sandbox.filesystem.editablePaths,
        })),
      ).toEqual([
        {
          id: "brigadier-plan",
          vendor: "claude",
          model: "claude-opus-5",
          effort: "high",
          cwd,
          timeoutMs: 900_000,
          maxTurns: 40,
          editablePaths: [],
        },
      ]);
      expect(result.runner?.inputs.map((input) => input.slice.id)).toEqual([
        "s1",
      ]);
      expect(result.engine.prepared.length).toBe(1);
    });
  });

  test("a bare task description is planned and then run", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const planner = new RecordingPlanner(plannedOutcome());
      const result = await invoke({
        argv: ["run", "fix the parser"],
        cwd,
        scratchHome,
        planner,
      });

      expect(result.code).toBe(0);
      // The user's words reach the planner verbatim, and the default fan-out
      // budget is exactly one slice.
      expect(planner.requests).toHaveLength(1);
      expect(planner.requests[0]?.task).toBe("fix the parser");
      expect(planner.requests[0]?.cwd).toBe(cwd);
      expect(planner.requests[0]?.maxSlices).toBe(1);
      // The plan is printed before the run, as a file `--plan` would accept.
      expect(result.stdout).toContain(
        "\nplanned by claude/claude-opus-5 at high effort:\n",
      );
      expect(result.stdout).toContain('"id": "demo-plan"');
      // And the planned slices are the ones that actually ran.
      expect(result.runner?.inputs.map((input) => input.slice.id)).toEqual([
        "s1",
        "s2",
      ]);
      expect(result.engine.prepared).toHaveLength(1);
    });
  });

  test("--max-workers raises the planner's fan-out budget", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const planner = new RecordingPlanner(plannedOutcome());
      const result = await invoke({
        argv: ["run", "--max-workers", "3", "fix the parser"],
        cwd,
        scratchHome,
        planner,
      });

      expect(result.code).toBe(0);
      expect(planner.requests[0]?.maxSlices).toBe(3);
    });
  });

  /**
   * THE REFUSAL TO GUESS, AND THE HALF OF IT THAT IS A PROMISE RATHER THAN A
   * MESSAGE.
   *
   * The questions are the visible part. The invisible part — that brigadier
   * spawned nothing and created nothing — is the part a user cannot check and
   * has to be able to trust, so every creation channel the recording engine has
   * is asserted empty here rather than spot-checked.
   */
  test("an ambiguous task returns questions, exits 4, and creates nothing", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const planner = new RecordingPlanner({
        kind: "needs-human",
        questions: ["Which parser?", "Should the fix change the wire format?"],
        planner: { vendor: "claude", model: "claude-opus-5", effort: "high" },
      });
      const result = await invoke({
        argv: ["run", "make it faster"],
        cwd,
        scratchHome,
        planner,
      });

      expect(result.code).toBe(4);
      expect(result.stdout).toContain(
        "\nbrigadier run: the planner model ran, but this task is ambiguous enough that producing a plan would mean guessing. No slice worker, worktree, ref, or commit was created.\n\nAnswer these and run it again:\n  1. Which parser?\n  2. Should the fix change the wire format?\n",
      );
      // The machine-readable last line the host-side skill re-invokes from.
      expect(result.stdout).toContain(
        '{"status":"needs_human","questions":["Which parser?","Should the fix change the wire format?"]}\n',
      );

      // Nothing. Every channel, named one at a time.
      expect(result.engine.prepared).toEqual([]);
      expect(result.engine.created).toEqual([]);
      expect(result.engine.committed).toEqual([]);
      expect(result.engine.merges).toEqual([]);
      expect(result.engine.removed).toEqual([]);
      expect(result.engine.released).toEqual([]);
      expect(result.runner?.inputs).toEqual([]);
      expect(await readdir(cwd)).toEqual(["plan.json"]);
    });
  });

  test("a planner that could not produce a plan exits 1 and creates nothing", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const planner = new RecordingPlanner({
        kind: "failed",
        message: "brigadier run: the planner ran out of quota",
      });
      const result = await invoke({
        argv: ["run", "fix the parser"],
        cwd,
        scratchHome,
        planner,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "brigadier run: the planner ran out of quota\n",
      );
      expect(result.engine.prepared).toEqual([]);
      expect(result.runner?.inputs).toEqual([]);
    });
  });

  test("--dry-run plans, reports the routing, and creates nothing", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const planner = new RecordingPlanner(plannedOutcome());
      const result = await invoke({
        argv: ["run", "--dry-run", "fix the parser"],
        cwd,
        scratchHome,
        planner,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "\nplanned by claude/claude-opus-5 at high effort:\n",
      );
      expect(result.stdout).toContain(
        "\ndry run demo-plan: 2 slice(s) in 0ms\n",
      );
      expect(result.engine.prepared).toEqual([]);
      expect(result.engine.created).toEqual([]);
      expect(result.runner?.inputs).toEqual([]);
      expect(await readdir(cwd)).toEqual(["plan.json"]);
    });
  });

  test("redacts inventoried secrets from planner input and printed output", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const plannerSecret = "planner-path-secret-9c2f";
      await writeFile(join(cwd, ".env"), `API_TOKEN=${plannerSecret}\n`);
      const planWithSecret = {
        id: "secret-plan",
        goal: `keep ${plannerSecret} out of artifacts`,
        slices: [
          {
            id: "s1",
            title: "protect the planner path",
            prompt: `remove ${plannerSecret} from planner output`,
            ownedPaths: ["src/planner-path.ts"],
            difficulty: "hard",
          },
        ],
      };
      const planner = new RecordingPlanner({
        kind: "planned",
        document: parsePlanDocument(planWithSecret),
        json: JSON.stringify(planWithSecret, null, 2),
        planner: {
          vendor: "claude",
          model: "claude-opus-5",
          effort: "high",
        },
      });
      const result = await invoke({
        argv: ["run", "--dry-run", `fix ${plannerSecret}`],
        cwd,
        scratchHome,
        planner,
        config: { ...CONFIG, linkedSecretPaths: [".env"] },
      });

      expect(result.code).toBe(0);
      expect(planner.requests[0]?.task).toBe("fix [REDACTED]");
      expect(result.stdout.indexOf(plannerSecret)).toBe(-1);

      const plannedPrefix =
        "\nplanned by claude/claude-opus-5 at high effort:\n";
      const plannedStart = result.stdout.indexOf(plannedPrefix);
      const plannedEnd = result.stdout.indexOf("\nrun secret-plan:");
      expect(plannedStart).toBeGreaterThanOrEqual(0);
      expect(plannedEnd).toBeGreaterThan(plannedStart);
      expect(result.stdout.slice(plannedStart, plannedEnd + 1)).toBe(
        `${plannedPrefix}${JSON.stringify(
          {
            ...planWithSecret,
            goal: "keep [REDACTED] out of artifacts",
            slices: [
              {
                ...planWithSecret.slices[0],
                prompt: "remove [REDACTED] from planner output",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      expect(result.engine.prepared).toEqual([]);
      expect(result.engine.created).toEqual([]);
      expect(result.runner?.inputs).toEqual([]);
      expect((await readdir(cwd)).sort()).toEqual([".env", "plan.json"]);
    });
  });

  test("a task and --plan together are refused without planning anything", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const planner = new RecordingPlanner(plannedOutcome());
      const result = await invoke({
        argv: ["run", "--plan", plan, "fix the parser"],
        cwd,
        scratchHome,
        planner,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "brigadier run: pass a task description or --plan <file>, not both; --plan runs a plan that already exists and a task description asks brigadier to write one",
      );
      expect(planner.requests).toEqual([]);
      expect(result.engine.prepared).toEqual([]);
    });
  });

  /**
   * `brigadier run fix the parser` without quotes. Joining the words would
   * accept a command whose shell quoting is wrong and silently plan whatever
   * survived the shell.
   */
  test("a second positional is refused rather than joined", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const planner = new RecordingPlanner(plannedOutcome());
      const result = await invoke({
        argv: ["run", "fix", "the parser"],
        cwd,
        scratchHome,
        planner,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        'brigadier run: only one task description is accepted, and a second one "the parser" was given; quote the whole task as a single argument',
      );
      expect(planner.requests).toEqual([]);
    });
  });

  test("a whitespace-only task is refused", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const planner = new RecordingPlanner(plannedOutcome());
      const result = await invoke({
        argv: ["run", "   "],
        cwd,
        scratchHome,
        planner,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "brigadier run: the task description is empty\n",
      );
      expect(planner.requests).toEqual([]);
    });
  });
});

describe("brigadier: the install and mcp subcommands", () => {
  test("install is dispatched and writes its host files", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const result = await invoke({
        argv: ["install", "claude-code"],
        cwd,
        scratchHome,
        env: {
          BRIGADIER_HOME: scratchHome,
          HOME: scratchHome,
          PATH: "/usr/bin:/bin",
          USER: "worker",
        },
      });
      expect(result.code).toBe(0);
      // The manifest `runInstall` records what it wrote in.
      expect(await readdir(scratchHome)).toContain("surfaces.json");
    });
  });

  test("install reports its own usage errors with exit 2", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const result = await invoke({
        argv: ["install", "not-a-host"],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(2);
    });
  });

  test("a bare mcp dispatches to the server", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      let served = 0;
      const result = await invoke({
        argv: ["mcp"],
        cwd,
        scratchHome,
        mcpServer: () => {
          served += 1;
          return Promise.resolve(0);
        },
      });
      expect(result.code).toBe(0);
      expect(served).toBe(1);
    });
  });

  test("mcp hands the interrupt signal and arming seam to the server", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const controller = new AbortController();
      const armings: string[] = [];
      let receivedSignal: AbortSignal | undefined;
      const result = await invoke({
        argv: ["mcp"],
        cwd,
        scratchHome,
        signal: controller.signal,
        onCancellable: () => {
          armings.push("armed");
        },
        mcpServer: (control) => {
          receivedSignal = control?.signal;
          control?.onCancellable?.();
          return Promise.resolve(0);
        },
      });
      expect(result.code).toBe(0);
      expect(receivedSignal).toBe(controller.signal);
      expect(armings).toEqual(["armed"]);
    });
  });

  /**
   * `mcp` takes no options, and a stray one is refused HERE rather than passed
   * on: `runMcpServer` blocks on the real stdin until the client closes it, so
   * a flag that reached it would look to the user like a hang.
   *
   * The server is injected rather than real for that same reason. If the guard
   * below were deleted, this test must FAIL — it must not hang waiting on a
   * stdin nobody is going to close.
   */
  test("mcp refuses a stray argument instead of starting the server", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      let served = 0;
      const result = await invoke({
        argv: ["mcp", "--port", "3000"],
        cwd,
        scratchHome,
        mcpServer: () => {
          served += 1;
          return Promise.resolve(0);
        },
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        'brigadier mcp: unexpected argument "--port"; the MCP server takes no options\n',
      );
      expect(served).toBe(0);
    });
  });

  test("mcp --help prints usage and exits 0", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const result = await invoke({
        argv: ["mcp", "--help"],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("  mcp                  serve brigadier");
    });
  });

  test("usage names run's two forms and every command", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const result = await invoke({
        argv: ["run", "--help"],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        '  brigadier run "<task description>"   plan the task, then run the plan\n  brigadier run --plan <file>          run a plan that already exists\n',
      );
      expect(result.stdout).toContain(
        "  4  the planner model ran but found the task too ambiguous to plan, so\n     brigadier refused to guess and printed the questions it needs answered.\n     No slice worker, worktree, ref, or commit was created. This is not a\n     failed slice run: answer the questions and run it again\n",
      );
    });
  });
});

describe("brigadier run: --dry-run", () => {
  test("creates nothing and prints the real routed model for every slice", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const runner = new RecordingSliceRunner(succeed);
      const result = await invoke({
        argv: ["run", "--plan", plan, "--dry-run"],
        cwd,
        scratchHome,
        runner,
      });

      expect(result.code).toBe(0);
      // Nothing was prepared, created, committed, merged, or removed, and no
      // slice was handed to a runner.
      expect(result.engine.prepared).toEqual([]);
      expect(result.engine.created).toEqual([]);
      expect(result.engine.committed).toEqual([]);
      expect(result.engine.merges).toEqual([]);
      expect(result.engine.removed).toEqual([]);
      expect(runner.inputs).toEqual([]);
      expect(await readdir(cwd)).toEqual(["plan.json"]);

      // The routing is the real router's, and both answers are absolute: the
      // hard slice has exactly one model above the 90 floor, and the routine
      // slice takes the cheapest of the three.
      expect(result.stdout).toContain(
        "\ndry run demo-plan: 2 slice(s) in 0ms\n",
      );
      expect(result.stdout).toContain(
        "  s1  would run\n      attempt 1  claude/claude-opus-5 effort=high  routed\n",
      );
      expect(result.stdout).toContain(
        "  s2  would run\n      attempt 1  codex/gpt-5.6-terra effort=medium  routed\n",
      );
      expect(result.stdout).toContain(
        "  integration branch: (none: a dry run writes no ref)\n",
      );
      expect(result.stdout).toContain("  merges: (none)\n");
    });
  });

  test("prints every rejected model when a slice cannot be routed", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      // Only the two models below the `hard` floor of 90 are configured, so the
      // hard slice has nothing to route to and the rejection list is the whole
      // diagnosis.
      const weakOnly: BrigadierConfig = {
        ...CONFIG,
        vendors: [
          {
            vendor: "claude",
            executable: "/opt/homebrew/bin/claude",
            version: "2.0.14",
            defaultModel: "claude-sonnet-5",
            models: [{ id: "claude-sonnet-5", effortCeiling: "high" }],
          },
          {
            vendor: "codex",
            executable: "/opt/homebrew/bin/codex",
            version: "0.145.0",
            defaultModel: "gpt-5.6-terra",
            models: [{ id: "gpt-5.6-terra", effortCeiling: "high" }],
          },
        ],
      };
      const hardOnly = join(cwd, "hard.json");
      await writeFile(
        hardOnly,
        JSON.stringify({ ...PLAN, slices: [PLAN.slices[0]] }),
      );

      const result = await invoke({
        argv: ["run", "--plan", hardOnly, "--dry-run"],
        cwd,
        scratchHome,
        config: weakOnly,
      });

      expect(result.code).toBe(3);
      expect(result.stdout).toContain(
        '  s1  failed  ROUTING_FAILED\n      attempt 1  unrouted  ROUTING_FAILED: no configured model can take slice "s1" at hard difficulty; 2 model(s) were eliminated\n',
      );
      expect(result.stdout).toContain(
        "        rejected claude/claude-sonnet-5 [competence]: competence score 74 is below the hard floor of 90\n",
      );
      expect(result.stdout).toContain(
        "        rejected codex/gpt-5.6-terra [competence]: competence score 70 is below the hard floor of 90\n",
      );
      expect(result.stdout).toContain(
        '  run failed: PREFLIGHT_ROUTING_FAILED — slice s1 could not be routed: no configured model can take slice "s1" at hard difficulty; 2 model(s) were eliminated\n',
      );
      expect(result.engine.prepared).toEqual([]);
    });
  });
});

describe("brigadier run: exit codes", () => {
  test("exits 0 and reports every merge on a successful run", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("\nrun demo-plan: 2 slice(s) in 0ms\n");
      expect(result.stdout).toContain(
        "  s1  ok  brigadier/demo-plan/slice-1  commit-s1\n      attempt 1  claude/claude-opus-5 effort=high  ok commit-s1\n",
      );
      expect(result.stdout).toContain(
        "  integration branch: brigadier/demo-plan/integration\n",
      );
      expect(result.stdout).toContain(
        "  merges:\n    s1: merged merged-brigadier/demo-plan/slice-1\n    s2: merged merged-brigadier/demo-plan/slice-3\n",
      );
      expect(result.stdout).not.toContain("run failed:");
      expect(result.engine.merges).toHaveLength(2);
      expect(result.engine.removed).toHaveLength(2);
    });
  });

  test("exits 3 when a slice fails, and still reports the run", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const runner = new RecordingSliceRunner((input) =>
        input.slice.id === "s1" ? succeed(input) : failWorker(input),
      );
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        runner,
      });

      expect(result.code).toBe(3);
      expect(result.stdout).toContain(
        "  s2  failed  WORKER_FAILED\n      attempt 1  codex/gpt-5.6-terra effort=medium  WORKER_FAILED: slice s2 attempt 1 failed on purpose\n",
      );
      expect(result.stdout).toContain(
        "  run failed: SLICE_FAILED — 1 slice(s) did not complete: s2\n",
      );
      // The half that worked is still merged and still reported.
      expect(result.stdout).toContain(
        "  merges:\n    s1: merged merged-brigadier/demo-plan/slice-1\n",
      );
    });
  });

  test("exits 1 with an actionable message when no config exists", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        config: null,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        `brigadier run: no brigadier config was found at ${resolveConfigPath({ BRIGADIER_HOME: scratchHome })}. Run \`brigadier init\` to scan this machine for worker CLIs and write one.\n`,
      );
      expect(result.engine.prepared).toEqual([]);
    });
  });

  test("exits 1 with a different message when the config cannot be trusted", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      await Bun.write(path, '{"version": 2, "vendors": "nope"}\n');
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        config: null,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `brigadier run: the config at ${path} cannot be used:`,
      );
      expect(result.stderr).toContain("Re-run `brigadier init` to rebuild it.");
    });
  });

  test("exits 1 rather than throwing when the environment has no HOME", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        env: {
          BRIGADIER_HOME: scratchHome,
          PATH: "/usr/bin:/bin",
          USER: "worker",
        },
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        "brigadier run: cannot launch a worker: HOME is missing from the environment\n",
      );
      expect(result.engine.prepared).toEqual([]);
    });
  });

  test("exits 1 rather than throwing when the environment has no PATH", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        env: {
          BRIGADIER_HOME: scratchHome,
          HOME: scratchHome,
          USER: "worker",
        },
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        "brigadier run: cannot launch a worker: PATH is missing from the environment\n",
      );
    });
  });

  test("exits 1 rather than throwing when the environment has no USER", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        env: {
          BRIGADIER_HOME: scratchHome,
          HOME: scratchHome,
          PATH: "/usr/bin:/bin",
        },
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        "brigadier run: cannot launch a worker: USER is missing from the environment\n",
      );
      expect(result.engine.prepared).toEqual([]);
    });
  });
});

describe("the composition root", () => {
  const LAUNCH_ENV = {
    HOME: "/example/tester",
    PATH: "/usr/bin:/bin",
    USER: "tester",
  };

  /**
   * The adapter records its executable as an own property. `private` is a
   * compile-time visibility rule and not a runtime one, and this is read
   * deliberately: the claim under test is about the value the composition root
   * passed to the constructor, and the adapter exposes no accessor for it. The
   * end-to-end proof that the same value reaches a real `spawn` is the test
   * below this block.
   */
  function recordedExecutable(worker: AnyWorker | null): unknown {
    return (worker as unknown as { readonly executable: unknown } | null)
      ?.executable;
  }

  test("binds each adapter to the executable the config recorded", () => {
    const dependencies = buildRunDependencies({
      config: CONFIG,
      env: LAUNCH_ENV,
      log: () => {},
      harness: { engine: new RecordingEngine(), now: () => 0 },
    });

    const claude = dependencies.ports.workerFor("claude");
    const codex = dependencies.ports.workerFor("codex");
    expect(claude?.vendor).toBe("claude");
    expect(codex?.vendor).toBe("codex");
    expect(recordedExecutable(claude)).toBe("/opt/homebrew/bin/claude");
    expect(recordedExecutable(codex)).toBe("/opt/homebrew/bin/codex");
  });

  test("returns null for a vendor the config does not list", () => {
    const claudeOnly: BrigadierConfig = {
      ...CONFIG,
      vendors: CONFIG.vendors.filter((vendor) => vendor.vendor === "claude"),
    };
    expect(claudeOnly.vendors).toHaveLength(1);
    const dependencies = buildRunDependencies({
      config: claudeOnly,
      env: LAUNCH_ENV,
      log: () => {},
      harness: { engine: new RecordingEngine(), now: () => 0 },
    });

    expect(dependencies.ports.workerFor("claude")).not.toBeNull();
    expect(dependencies.ports.workerFor("codex")).toBeNull();
  });

  test("wires the Claude quota oracle and no Codex app-server", () => {
    const dependencies = buildRunDependencies({
      config: CONFIG,
      env: LAUNCH_ENV,
      log: () => {},
      harness: { engine: new RecordingEngine(), now: () => 0 },
    });

    expect(dependencies.ports.oracles.map((oracle) => oracle.vendor)).toEqual([
      "claude",
    ]);
    // The push half is what makes it free: it ingests worker events rather than
    // owning a process. Read off the value because `AnyQuotaOracle` does not
    // declare `ingest` — only its Claude arm does, which is the point.
    const oracle = dependencies.ports.oracles[0];
    expect(
      typeof (oracle as unknown as { readonly ingest?: unknown } | undefined)
        ?.ingest,
    ).toBe("function");
  });

  test("derives capabilities from the config rather than the whole table", () => {
    const dependencies = buildRunDependencies({
      config: CONFIG,
      env: LAUNCH_ENV,
      log: () => {},
      harness: { engine: new RecordingEngine(), now: () => 0 },
    });

    expect(
      dependencies.capabilities.map(
        (capability) => `${capability.vendor}/${capability.model}`,
      ),
    ).toEqual([
      "claude/claude-opus-5",
      "claude/claude-sonnet-5",
      "codex/gpt-5.6-terra",
    ]);
    // Ceilings are applied: `xhigh` is on the static ladder and off this config.
    expect(dependencies.capabilities[0]?.supportedEfforts).toEqual([
      "medium",
      "high",
    ]);
  });
});

/**
 * The end-to-end proof for `VendorConfig.executable`.
 *
 * Every layer between the config and the spawn is real here — the real router,
 * the real slice runner, the real `ClaudeWorker` — and only git is faked. The
 * configured path does not exist, so the spawn fails immediately with an error
 * that names it, and that name in the report is the evidence: an adapter built
 * without `{ executable }` would have tried a bare `claude` off PATH and the
 * message would say `claude`, not the configured path.
 *
 * Bounded by construction: `spawn` on a missing file rejects on the first tick,
 * and there is no second attempt — a `LAUNCH_FAILURE` is not retryable, so the
 * runner stops the slice on the reported cause instead of routing again.
 *
 * That reported cause is itself part of the evidence. The slice summary names
 * `WORKER_FAILED` with the spawn's own `ENOENT`, not the `ROUTING_FAILED` that
 * a second attempt used to manufacture by excluding a model that had never run
 * and then finding nothing else above the `hard` floor.
 */
test("the configured executable reaches the real spawn", async () => {
  await withScratchHome(async ({ scratchHome, cwd }) => {
    const configuredClaude = join(scratchHome, "bin", "claude-not-installed");
    const config: BrigadierConfig = {
      ...CONFIG,
      vendors: [
        {
          vendor: "claude",
          executable: configuredClaude,
          version: "2.0.14",
          defaultModel: "claude-opus-5",
          models: [{ id: "claude-opus-5", effortCeiling: "high" }],
        },
      ],
    };
    const hardOnly = join(cwd, "hard.json");
    await writeFile(
      hardOnly,
      JSON.stringify({ ...PLAN, slices: [PLAN.slices[0]] }),
    );

    // `runner: null` keeps the REAL slice runner, so the spawn is real too.
    const result = await invoke({
      argv: ["run", "--plan", hardOnly],
      cwd,
      scratchHome,
      config,
      runner: null,
    });

    expect(result.code).toBe(3);
    expect(result.stdout).toContain(configuredClaude);
    expect(result.stdout).toContain(
      "  s1  failed  WORKER_FAILED\n      attempt 1  claude/claude-opus-5 effort=high  WORKER_FAILED: slice s1 attempt 1: claude/claude-opus-5 failed with LAUNCH_FAILURE:",
    );
    expect(result.stdout).not.toContain(
      "failed with LAUNCH_FAILURE: spawn claude",
    );
    // Exactly one attempt: a launch that never started a process says nothing
    // about the model, so there is nothing for a second attempt to route around.
    expect(result.stdout).not.toContain("attempt 2");
    // The failed attempt's worktree was removed, and nothing was committed.
    expect(result.engine.removed).toHaveLength(1);
    expect(result.engine.committed).toEqual([]);
  });
}, 30_000);

/**
 * The interrupt exit codes and the report an interrupted run prints.
 *
 * EVERY TEST HERE DRIVES AN `AbortController`, NEVER A SIGNAL. `src/cli.ts` is
 * the only thing that turns SIGINT into an abort, and it is the one piece
 * deliberately left untestable — a test that sent SIGINT would be sending it to
 * the test runner.
 *
 * NONE OF THEM CAN HANG EITHER: `RecordingSliceRunner` settles on a fixed 1 ms
 * timer regardless of the signal, so a CLI that ignored cancellation entirely
 * finishes the run and fails on the exit code within milliseconds.
 */
describe("brigadier run: interrupts", () => {
  test("SIGINT resolves 130 and SIGTERM resolves 143", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const sigint = new AbortController();
      sigint.abort({ kind: "interrupt", signal: "SIGINT" });
      const interrupted = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        signal: sigint.signal,
      });
      expect(interrupted.code).toBe(130);

      const sigterm = new AbortController();
      sigterm.abort({ kind: "interrupt", signal: "SIGTERM" });
      const terminated = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        signal: sigterm.signal,
      });
      expect(terminated.code).toBe(143);
    });
  });

  test("an abort with an unreadable reason still resolves 130", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const controller = new AbortController();
      controller.abort();
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        signal: controller.signal,
      });
      expect(result.code).toBe(130);
    });
  });

  test("an interrupt before prepare writes no ref and runs no slice", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const controller = new AbortController();
      controller.abort({ kind: "interrupt", signal: "SIGINT" });
      const runner = new RecordingSliceRunner(succeed);
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        runner,
        signal: controller.signal,
      });

      expect(result.code).toBe(130);
      expect(result.engine.prepared).toHaveLength(0);
      expect(result.engine.created).toHaveLength(0);
      expect(result.engine.released).toHaveLength(0);
      expect(runner.inputs).toHaveLength(0);
      expect(result.stdout).toContain(
        "interrupted: workers were cancelled and worktrees removed",
      );
      // Both slices are named cancelled, and neither is called failed.
      expect(result.stdout).toContain("s1  cancelled");
      expect(result.stdout).toContain("s2  cancelled");
      expect(result.stdout).not.toContain("failed  ");
    });
  });

  test("a run interrupted while a slice is in flight releases the session's refs", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const controller = new AbortController();
      // Aborts from inside the first slice, so the run is genuinely underway.
      const runner = new RecordingSliceRunner((input) => {
        controller.abort({ kind: "interrupt", signal: "SIGINT" });
        return succeed(input);
      });
      const result = await invoke({
        argv: ["run", "--plan", plan, "--max-workers", "1"],
        cwd,
        scratchHome,
        runner,
        signal: controller.signal,
      });

      expect(result.code).toBe(130);
      // Exactly one slice was started; the second never was.
      expect(runner.inputs.map((input) => input.slice.id)).toEqual(["s1"]);
      // The session's refs were retired even though the run did not finish.
      expect(result.engine.released.map((session) => session.slug)).toEqual([
        "demo-plan",
      ]);
      expect(result.engine.removed).toHaveLength(1);
    });
  });

  test("the signal the CLI is given is the signal every slice receives", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const controller = new AbortController();
      const runner = new RecordingSliceRunner(succeed);
      await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        runner,
        signal: controller.signal,
      });
      expect(runner.inputs).toHaveLength(2);
      for (const input of runner.inputs) {
        expect(input.signal).toBe(controller.signal);
      }
    });
  });

  test("a run nobody interrupted still resolves its ordinary code", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const controller = new AbortController();
      const clean = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        signal: controller.signal,
      });
      expect(clean.code).toBe(0);
      expect(clean.stdout).not.toContain("interrupted:");

      const failed = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        runner: new RecordingSliceRunner(failWorker),
        signal: new AbortController().signal,
      });
      expect(failed.code).toBe(3);
    });
  });

  test("--help documents both interrupt codes", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const result = await invoke({
        argv: ["run", "--help"],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "130  the run was interrupted with SIGINT (Ctrl-C)",
      );
      expect(result.stdout).toContain(
        "143  the run was interrupted with SIGTERM",
      );
    });
  });
});

/**
 * The interrupt policy, driven directly.
 *
 * `src/cli.ts` holds only the two things a test cannot touch — the real
 * `process` and a real POSIX signal — and asks this gate what to do. So the
 * decision is asserted here as a value: an exact message and an exact exit
 * code, with no signal sent anywhere and nothing to wait on.
 */
describe("the interrupt gate", () => {
  test("the first interrupt before a command arms the gate exits 130 and cancels nothing", () => {
    const gate = createInterruptGate();
    expect(gate.interrupt("SIGINT")).toEqual({
      message: "\nbrigadier: SIGINT — exiting\n",
      exitCode: 130,
    });
    // Nothing is in flight, so nothing was told to stop — and, critically, the
    // user is not asked to press Ctrl-C a second time.
    expect(gate.signal.aborted).toBe(false);
  });

  test("the first SIGTERM before arming exits 143", () => {
    const gate = createInterruptGate();
    expect(gate.interrupt("SIGTERM")).toEqual({
      message: "\nbrigadier: SIGTERM — exiting\n",
      exitCode: 143,
    });
    expect(gate.signal.aborted).toBe(false);
  });

  test("the first interrupt after arming cancels the run instead of exiting", () => {
    const gate = createInterruptGate();
    gate.arm();
    expect(gate.interrupt("SIGINT")).toEqual({
      message:
        "\nbrigadier: SIGINT — cancelling workers and cleaning up; interrupt again to exit immediately\n",
      exitCode: null,
    });
    expect(gate.signal.aborted).toBe(true);
    expect(gate.signal.reason).toEqual({ kind: "interrupt", signal: "SIGINT" });
  });

  test("the second interrupt after arming is the escape hatch", () => {
    const gate = createInterruptGate();
    gate.arm();
    gate.interrupt("SIGINT");
    expect(gate.interrupt("SIGTERM")).toEqual({
      message:
        "\nbrigadier: SIGTERM again — exiting now without finishing cleanup\n",
      exitCode: 143,
    });
  });

  test("arming is idempotent and the graceful count survives it", () => {
    const gate = createInterruptGate();
    gate.arm();
    gate.interrupt("SIGINT");
    gate.arm();
    expect(gate.interrupt("SIGINT").exitCode).toBe(130);
  });
});

/**
 * WHERE the gate is armed, which is what the policy above is worth nothing
 * without. Arm too early and Ctrl-C during a blocking stdin read needs two
 * presses; arm too late and a real worker survives the first one.
 */
describe("brigadier run: arming the interrupt gate", () => {
  test("a real run arms the gate exactly once", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const armings: string[] = [];
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
        onCancellable: () => {
          armings.push("armed");
        },
      });
      expect(result.code).toBe(0);
      expect(armings).toEqual(["armed"]);
    });
  });

  test("a run that dies before the orchestrator never arms the gate", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const armings: string[] = [];
      const result = await invoke({
        argv: ["run", "--plan", join(cwd, "absent.json")],
        cwd,
        scratchHome,
        onCancellable: () => {
          armings.push("armed");
        },
      });
      // Failed to start: nothing exists that an interrupt would have to wind
      // down, so a Ctrl-C at this point must kill brigadier outright.
      expect(result.code).toBe(1);
      expect(armings).toEqual([]);
    });
  });

  test("a usage error never arms the gate", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const armings: string[] = [];
      const result = await invoke({
        argv: ["run"],
        cwd,
        scratchHome,
        onCancellable: () => {
          armings.push("armed");
        },
      });
      expect(result.code).toBe(2);
      expect(armings).toEqual([]);
    });
  });

  test("no command but run ever arms the gate", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const armings: string[] = [];
      for (const argv of [["--version"], ["init", "--help"], ["nonsense"]]) {
        await invoke({
          argv,
          cwd,
          scratchHome,
          onCancellable: () => {
            armings.push(argv.join(" "));
          },
        });
      }
      expect(armings).toEqual([]);
    });
  });
});

/**
 * What the report says about cleanup, which must be what actually happened.
 *
 * Asserted as an exact array of the rendered lines rather than a substring
 * check, because the defect being fixed here is a sentence that was PRESENT
 * when it should have been absent — and a `toContain` on the replacement would
 * pass just as happily with the false one printed beside it.
 */
describe("brigadier run: the cleanup lines of the report", () => {
  const cleanupLines = (stdout: string): readonly string[] =>
    stdout
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("  interrupted:") ||
          line.startsWith("  cleanup failures:") ||
          line.startsWith("    cleanup ") ||
          line.startsWith("    release "),
      );

  test("an interrupt whose cleanup succeeded says so and says nothing else", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const controller = new AbortController();
      const runner = new RecordingSliceRunner((input) => {
        controller.abort({ kind: "interrupt", signal: "SIGINT" });
        return succeed(input);
      });
      const result = await invoke({
        argv: ["run", "--plan", plan, "--max-workers", "1"],
        cwd,
        scratchHome,
        runner,
        signal: controller.signal,
      });

      expect(result.code).toBe(130);
      expect(cleanupLines(result.stdout)).toEqual([
        "  interrupted: workers were cancelled and worktrees removed",
      ]);
    });
  });

  test("an interrupt whose cleanup failed refuses to claim the worktrees are gone", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const controller = new AbortController();
      const runner = new RecordingSliceRunner((input) => {
        controller.abort({ kind: "interrupt", signal: "SIGINT" });
        return succeed(input);
      });
      const result = await invoke({
        argv: ["run", "--plan", plan, "--max-workers", "1"],
        cwd,
        scratchHome,
        runner,
        signal: controller.signal,
        breakEngine: (engine) => {
          engine.removeError = new Error("worktree is busy");
          engine.releaseError = new Error("a worktree is still active");
        },
      });

      expect(result.code).toBe(130);
      expect(cleanupLines(result.stdout)).toEqual([
        "  interrupted: cleanup did not finish; a worker may still be running and a worktree may still exist — see cleanup failures below",
        "  cleanup failures:",
        "    cleanup s1: worktree is busy",
        "    release demo-plan: a worktree is still active",
      ]);
    });
  });

  test("cleanup that failed on an uninterrupted run is still printed", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const result = await invoke({
        argv: ["run", "--plan", plan, "--max-workers", "1"],
        cwd,
        scratchHome,
        breakEngine: (engine) => {
          engine.releaseError = new Error("a worktree is still active");
        },
      });

      // The run succeeded; failing to tidy up does not undo that, and it does
      // not turn an uninterrupted run into an interrupted one either.
      expect(result.code).toBe(0);
      expect(cleanupLines(result.stdout)).toEqual([
        "  cleanup failures:",
        "    release demo-plan: a worktree is still active",
      ]);
    });
  });

  test("an ordinary run prints no cleanup lines at all", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const result = await invoke({
        argv: ["run", "--plan", plan],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(0);
      expect(cleanupLines(result.stdout)).toEqual([]);
    });
  });
});
