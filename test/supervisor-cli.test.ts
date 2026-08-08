import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrigadierConfig } from "../src/config/index.ts";
import { resolveConfigPath, writeConfig } from "../src/config/index.ts";
import type { AnyWorker } from "../src/contracts.ts";
import type {
  InputStream,
  OutputStream,
  RunHarness,
} from "../src/init/index.ts";
import { buildRunDependencies, runCli } from "../src/init/index.ts";
import type {
  SliceResult,
  SliceRunInput,
  SliceRunner,
} from "../src/supervisor/index.ts";
import { requireLaunchEnv } from "../src/supervisor/index.ts";
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
  version: 2,
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
    return Promise.resolve();
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
  readonly env?: Readonly<Record<string, string | undefined>>;
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
  const runner =
    options.runner === undefined
      ? new RecordingSliceRunner(succeed)
      : options.runner;
  const harness: RunHarness = {
    engine,
    // A constant clock: every duration the report prints is then exactly 0ms.
    now: () => 1_700_000_000_000,
    ...(runner === null ? {} : { sliceRunner: runner }),
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
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), engine, runner };
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

  test("a missing --plan exits 2", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const result = await invoke({ argv: ["run"], cwd, scratchHome });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "brigadier run: --plan <file> is required; pass a plan JSON file, or `--plan -` to read it from stdin",
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
        "  1  brigadier could not start the run: no config, an unreadable or invalid\n     plan file, or an environment with no HOME, PATH, or USER",
      );
      // The code the sentence describes.
      expect(() =>
        requireLaunchEnv({ HOME: "/Users/worker", PATH: "/usr/bin" }),
      ).toThrow("cannot launch a worker: USER is missing from the environment");
    });
  });
});

describe("brigadier run: the reserved positional slot", () => {
  test("a bare positional argument reports that planning is not implemented", async () => {
    await withScratchHome(async ({ scratchHome, cwd }) => {
      const result = await invoke({
        argv: ["run", "fix the parser"],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "brigadier run: planning a task description is not implemented yet, so a bare argument cannot be turned into a plan. Pass a plan file with `--plan <file>`, or `--plan -` to read the plan from stdin.",
      );
      expect(result.engine.prepared).toEqual([]);
    });
  });

  test("a positional given alongside --plan is still refused", async () => {
    await withScratchHome(async ({ scratchHome, cwd, plan }) => {
      const result = await invoke({
        argv: ["run", "--plan", plan, "fix the parser"],
        cwd,
        scratchHome,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("planning a task description");
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
