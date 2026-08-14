import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  type ClaudeWorkerSpec,
  type CodexWorkerSpec,
  createIdleTimeoutMs,
  IDLE_TIMEOUT_BOUNDARY_MS,
  type WorkerEvent,
  type WorkerOutcome,
} from "../src/contracts.ts";
import { createClaudeWorker } from "../src/worker/claude.ts";
import { createCodexWorker } from "../src/worker/codex.ts";
import {
  buildClaudeCommand,
  buildCodexCommand,
  ClaudeWorker,
  CodexWorker,
} from "../src/worker/index.ts";
import { workerEnvironment } from "../src/worker/shared.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const fakeBin = resolve(repositoryRoot, "scripts/fakes");
const prompt = "Return exactly ok.";
const temporaryDirectories: string[] = [];

/**
 * The anti-hang bound for a real subprocess settling.
 *
 * Every wait in this file is bounded so a wedged adapter FAILS the suite instead
 * of wedging it. The bound is a hang detector and nothing else — it is not a
 * latency assertion, because each of these promises is waiting on a child that
 * has already produced its terminal record.
 *
 * One second did not mean only that. It flakes under ordinary parallel load —
 * three worktrees running their suites at once was enough, and the same three
 * tests fail on unmodified `main` — which turns a hang detector into a false
 * alarm. Five seconds is still a hard bound and still orders of magnitude below
 * anything a real deadlock would take.
 */
const SETTLE_BOUND_MS = 5_000;

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("ClaudeWorker", () => {
  test("uses the configured executable for argv and process spawn", async () => {
    const executable = resolve(fakeBin, "claude");
    expect(buildClaudeCommand(claudeSpec("success"), executable)[0]).toBe(
      executable,
    );

    const decoyBin = await createExecutableDecoys();
    const spec = claudeSpec("success", {
      PATH: `${decoyBin}:${requiredPath()}`,
    });
    const spawned = await within(
      createClaudeWorker({ executable }).spawn(spec),
      2_000,
      "configured Claude spawn",
    );
    const outcome = await within<WorkerOutcome>(
      spawned.completion,
      2_000,
      "configured Claude completion",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toBe("ok");
  });

  test("passes the prompt only on write-then-close stdin and normalizes success", async () => {
    const spec = claudeSpec("success");
    const command = buildClaudeCommand(spec);
    expect(command).not.toContain(prompt);
    expect(command).not.toContain("--system-prompt");
    expect(command).not.toContain("--safe-mode");
    expect(command).not.toContain("--bare");
    const spawned = await within(
      new ClaudeWorker().spawn(spec),
      2_000,
      "Claude spawn",
    );
    const [outcome, events] = await within(
      Promise.all([spawned.completion, collect(spawned.events)]),
      2_000,
      "Claude success",
    );

    expect(spawned.pid).toBeNumber();
    expect(outcome).toMatchObject({
      ok: true,
      output: "ok",
      usage: {
        input: {
          total: 31_323,
          uncached: 9,
          cacheRead: 0,
          cacheWrite: 31_314,
        },
        output: { total: 40, reasoning: null },
      },
      costUsd: 0.062837,
      durationMs: 2_439,
    });
    expect(events.some((event) => event.type === "started")).toBeTrue();
    expect(
      events.some((event) => event.type === "message" && event.text === "ok"),
    ).toBeTrue();
  });

  test("detects completion from result before the Claude process exits", async () => {
    const temporaryBin = await createNeverExitingClaude();
    const spec = claudeSpec("unused", {
      PATH: `${temporaryBin}:${requiredPath()}`,
    });
    const spawned = await within(
      new ClaudeWorker().spawn(spec),
      2_000,
      "never-exiting Claude spawn",
    );
    if (spawned.pid === null) {
      throw new Error("temporary Claude failed to launch");
    }

    const outcome = await within(
      spawned.completion,
      SETTLE_BOUND_MS,
      "Claude terminal result",
    );
    expect(outcome.ok).toBeTrue();
    expect(outcome.output).toBe("completed before exit");
    expect(canSignal(spawned.pid)).toBeFalse();

    await within(collect(spawned.events), 2_000, "Claude event EOF");
  });

  test("a shutdown throw still settles completion", async () => {
    const worker = new ClaudeWorker(async () => {
      throw new Error("injected shutdown failure");
    });
    const spawned = await worker.spawn(claudeSpec("success"));
    if (spawned.pid === null) {
      throw new Error("shutdown-throw Claude failed to launch");
    }

    expect(
      await within(
        spawned.completion,
        SETTLE_BOUND_MS,
        "shutdown-throw completion",
      ),
    ).toMatchObject({
      ok: false,
      failure: {
        kind: "UNKNOWN_FAILURE",
        message: "injected shutdown failure",
      },
    });
  });

  test("kills the process group so a grandchild-held stdout pipe closes", async () => {
    const spec = claudeSpec("grandchild-pipe");
    const spawned = await within(
      new ClaudeWorker().spawn(spec),
      2_000,
      "grandchild Claude spawn",
    );
    const iterator = spawned.events[Symbol.asyncIterator]();
    const first = await within(iterator.next(), 2_000, "grandchild event");
    expect(first.done).toBeFalse();
    expect(first.value).toMatchObject({
      type: "other",
      description: "system",
    });

    await within(
      spawned.cancel({ kind: "requested", message: "test complete" }),
      500,
      "group cancellation",
    );
    const [outcome, end] = await within(
      Promise.all([spawned.completion, iterator.next()]),
      2_000,
      "grandchild pipe EOF",
    );
    expect(end.done).toBeTrue();
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "CANCELLED", message: "test complete" },
    });
  });

  test("classifies a hard 404 from the terminal tuple despite success subtype", async () => {
    const outcome = await runClaude("bad-model");
    expect(outcome).toMatchObject({
      ok: false,
      output: "There's an issue with the selected model...",
      failure: {
        kind: "BAD_MODEL",
        retryable: false,
        statusCode: 404,
      },
    });
  });

  test("maps Claude exit 1 without a result record to ARGV_BUG", async () => {
    const original = claudeSpec("success");
    const spec = {
      ...original,
      environment: {
        ...original.environment,
        BRIGADIER_FAKE_EXPECTED_ARGV: JSON.stringify(["--invalid"]),
      },
    };
    const spawned = await within(
      new ClaudeWorker().spawn(spec),
      2_000,
      "Claude argv-error spawn",
    );
    const outcome = await within<WorkerOutcome>(
      spawned.completion,
      2_000,
      "Claude argv error",
    );
    expect(outcome).toMatchObject({
      ok: false,
      exitCode: 1,
      failure: { kind: "ARGV_BUG", retryable: false },
    });
  });

  test("classifies a rejected Claude quota window", async () => {
    const outcome = await runClaude("rate-limit-rejected");
    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "QUOTA_EXHAUSTED",
        retryable: false,
        statusCode: 429,
      },
    });
  });

  test("prefers modelUsage when budget exhaustion zeroes usage", async () => {
    const outcome = await runClaude("budget-exhaustion");
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "BUDGET_EXCEEDED" },
      usage: {
        input: {
          total: 3_021,
          uncached: 21,
          cacheRead: 1_000,
          cacheWrite: 2_000,
        },
        output: { total: 42, reasoning: null },
      },
      costUsd: 0.07,
    });
  });

  test("preserves literal U+2028 inside one NDJSON record and raw payload", async () => {
    const spec = claudeSpec("unicode-separator");
    const spawned = await within(
      new ClaudeWorker().spawn(spec),
      2_000,
      "Claude U+2028 spawn",
    );
    const [outcome, events] = await within(
      Promise.all([spawned.completion, collect(spawned.events)]),
      2_000,
      "Claude U+2028",
    );
    expect(outcome.ok).toBeTrue();
    const message = events.find((event) => event.type === "message");
    expect(message).toMatchObject({
      type: "message",
      text: "line separator remains inside one JSON value",
    });
    expect(JSON.stringify(message?.raw)).toContain("line separator");
  });

  test("emits api_retry telemetry without wrapping Claude in another retry", async () => {
    const spec = claudeSpec("api-retry");
    const spawned = await within(
      new ClaudeWorker().spawn(spec),
      2_000,
      "Claude API-retry spawn",
    );
    const [outcome, events] = await within(
      Promise.all([spawned.completion, collect(spawned.events)]),
      2_000,
      "Claude API retry",
    );
    expect(outcome.ok).toBeTrue();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "api_retry",
        attempt: 2,
        maxRetries: 10,
        retryDelayMs: 30_000,
        statusCode: 529,
        error: "overloaded",
      }),
    );
  });

  test("does not treat a scaled healthy long silence as completion", async () => {
    const startedAt = performance.now();
    const outcome = await runClaude("long-silence", {
      BRIGADIER_FAKE_SILENCE_MS: "80",
    });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(70);
    expect(outcome).toMatchObject({ ok: true, durationMs: 405_000 });
  });
});

describe("CodexWorker", () => {
  test("uses the configured executable for argv and process spawn", async () => {
    const executable = resolve(fakeBin, "codex");
    expect(buildCodexCommand(codexSpec("success"), executable)[0]).toBe(
      executable,
    );

    const decoyBin = await createExecutableDecoys();
    const base = codexSpec("success");
    const spec = {
      ...base,
      environment: {
        ...base.environment,
        PATH: `${decoyBin}:${requiredPath()}`,
      },
    } as const satisfies CodexWorkerSpec;
    const spawned = await within(
      createCodexWorker({ executable }).spawn(spec),
      2_000,
      "configured Codex spawn",
    );
    const outcome = await within<WorkerOutcome>(
      spawned.completion,
      2_000,
      "configured Codex completion",
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toBe("ok");
  });

  test("uses stdin sentinel and reasoning config while preserving Codex tokens", async () => {
    const spec = codexSpec("success");
    const command = buildCodexCommand(spec);
    expect(command).not.toContain(prompt);
    expect(command.at(-1)).toBe("-");
    expect(command).not.toContain("--effort");
    expect(command).toContain("model_reasoning_effort=xhigh");
    expect(command).toContain('default_permissions="brigadier_lane"');
    expect(command).toContain(
      'permissions.brigadier_lane={filesystem={":root"="read",":workspace_roots"={"."="read","src/worker/**"="write"}},network={enabled=false}}',
    );
    const spawned = await within(
      new CodexWorker().spawn(spec),
      2_000,
      "Codex spawn",
    );
    const [outcome, events] = await within(
      Promise.all([spawned.completion, collect(spawned.events)]),
      2_000,
      "Codex success",
    );
    expect(outcome).toMatchObject({
      ok: true,
      output: "ok",
      exitCode: 0,
      usage: {
        input: {
          total: 16_196,
          uncached: 5_188,
          cacheRead: 11_008,
          cacheWrite: 0,
        },
        output: { total: 5, reasoning: 0 },
      },
    });
    expect("costUsd" in outcome).toBeFalse();
    expect(events.some((event) => event.type === "started")).toBeTrue();
  });

  test("maps Codex exit 2 to ARGV_BUG", async () => {
    const spec = codexSpec("argv-error");
    const spawned = await within(
      new CodexWorker().spawn(spec),
      2_000,
      "Codex argv-error spawn",
    );
    const outcome = await within<WorkerOutcome>(
      spawned.completion,
      2_000,
      "Codex argv error",
    );
    expect(outcome).toMatchObject({
      ok: false,
      exitCode: 2,
      failure: { kind: "ARGV_BUG", retryable: false },
    });
    expect(outcome.output).toBe("");
  });

  test("Codex natural completion kills a grandchild holding stdout", async () => {
    const temporaryBin = await createGrandchildCodex();
    const base = codexSpec("unused");
    const spec = {
      ...base,
      environment: {
        ...base.environment,
        PATH: `${temporaryBin}:${requiredPath()}`,
      },
      timeoutMs: null,
    } as const satisfies CodexWorkerSpec;
    const spawned = await new CodexWorker().spawn(spec);
    if (spawned.pid === null) {
      throw new Error("grandchild Codex failed to launch");
    }

    try {
      const [outcome, events] = await within(
        Promise.all([spawned.completion, collect(spawned.events)]),
        SETTLE_BOUND_MS,
        "Codex grandchild completion",
      );
      expect(outcome).toMatchObject({
        ok: true,
        output: "grandchild complete",
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "message",
          text: "grandchild complete",
        }),
      );
      expect(canSignalProcessGroup(spawned.pid)).toBeFalse();
    } finally {
      await forceKillProcessTree(spawned.pid);
    }
  });

  test("classifies Codex turn failure from its native payload", async () => {
    const spec = codexSpec("failure");
    const spawned = await within(
      new CodexWorker().spawn(spec),
      2_000,
      "Codex failure spawn",
    );
    const outcome = await within<WorkerOutcome>(
      spawned.completion,
      2_000,
      "Codex turn failure",
    );
    expect(outcome).toMatchObject({
      ok: false,
      exitCode: 1,
      failure: {
        kind: "BAD_MODEL",
        retryable: false,
        statusCode: 400,
      },
    });
  });
});

test("Claude argv is an absolute contract for mandatory flags and edit lanes", () => {
  expect(buildClaudeCommand(claudeSpec("success"))).toEqual([
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--model",
    "claude-test-model",
    "--effort",
    "high",
    "--exclude-dynamic-system-prompt-sections",
    "--permission-mode",
    "dontAsk",
    "--max-budget-usd",
    "1.5",
    "--tools",
    "Read,Edit",
    "--allowedTools",
    "Edit(src/worker/**),Write(src/worker/**)",
    "--disallowedTools",
    "WebFetch,WebSearch",
    "--setting-sources",
    "",
    "--add-dir",
    "/workspace/shared",
    "--mcp-config",
    "/workspace/mcp.json",
    "--strict-mcp-config",
  ]);
});

test("worker executable defaults and empty-string validation are explicit", () => {
  expect(buildClaudeCommand(claudeSpec("success"), undefined)[0]).toBe(
    "claude",
  );
  expect(buildCodexCommand(codexSpec("success"), undefined)[0]).toBe("codex");

  expect(() => createClaudeWorker({ executable: "" })).toThrow(RangeError);
  expect(() => createClaudeWorker({ executable: "" })).toThrow(
    "Claude executable must not be empty",
  );
  expect(() => createCodexWorker({ executable: "" })).toThrow(RangeError);
  expect(() => createCodexWorker({ executable: "" })).toThrow(
    "Codex executable must not be empty",
  );
  expect(() => buildClaudeCommand(claudeSpec("success"), "")).toThrow(
    "Claude executable must not be empty",
  );
  expect(() => buildCodexCommand(codexSpec("success"), "")).toThrow(
    "Codex executable must not be empty",
  );
});

test("read-only specs emit no edit permissions in either adapter", () => {
  const claude = claudeSpec("success");
  const readOnlyClaude = {
    ...claude,
    sandbox: {
      ...claude.sandbox,
      filesystem: {
        ...claude.sandbox.filesystem,
        workspaceAccess: "read",
      },
    },
  } as const satisfies ClaudeWorkerSpec;
  expect(buildClaudeCommand(readOnlyClaude)).not.toContain("--allowedTools");

  const codex = codexSpec("success");
  const readOnlyCodex = {
    ...codex,
    sandbox: {
      ...codex.sandbox,
      filesystem: {
        ...codex.sandbox.filesystem,
        workspaceAccess: "read",
      },
    },
  } as const satisfies CodexWorkerSpec;
  expect(buildCodexCommand(readOnlyCodex)).toContain(
    'permissions.brigadier_lane={filesystem={":root"="read",":workspace_roots"={"."="read"}},network={enabled=false}}',
  );

  const withoutUserInstructions = {
    ...codex,
    instructionFiles: { ...codex.instructionFiles, user: "exclude" },
  } as const satisfies CodexWorkerSpec;
  expect(buildCodexCommand(withoutUserInstructions)).toContain(
    "--ignore-user-config",
  );
});

test("adapters validate maxTurns at their one-shot launch boundaries", () => {
  expect(() =>
    buildClaudeCommand({ ...claudeSpec("success"), maxTurns: 0 }),
  ).toThrow("maxTurns must be null or a positive whole number");
  expect(() =>
    buildCodexCommand({ ...codexSpec("success"), maxTurns: 0 }),
  ).toThrow("maxTurns must be null or a positive whole number");
});

test("Claude maxTurns succeeds at the limit and fails only over the limit", async () => {
  const atLimitSpec = withExpectedArgv(
    { ...claudeSpec("success"), maxTurns: 1 },
    buildClaudeCommand({ ...claudeSpec("success"), maxTurns: 1 }),
  );
  const atLimit = await new ClaudeWorker().spawn(atLimitSpec);
  expect(
    await within<WorkerOutcome>(
      atLimit.completion,
      SETTLE_BOUND_MS,
      "Claude at-limit completion",
    ),
  ).toMatchObject({ ok: true, output: "ok" });

  const temporaryBin = await createTwoTurnClaude();
  const overLimitBase = {
    ...claudeSpec("unused", {
      PATH: `${temporaryBin}:${requiredPath()}`,
    }),
    maxTurns: 1,
  } as const satisfies ClaudeWorkerSpec;
  const overLimitSpec = withExpectedArgv(
    overLimitBase,
    buildClaudeCommand(overLimitBase),
  );
  const overLimit = await new ClaudeWorker().spawn(overLimitSpec);
  expect(
    await within<WorkerOutcome>(
      overLimit.completion,
      SETTLE_BOUND_MS,
      "Claude over-limit completion",
    ),
  ).toMatchObject({
    ok: false,
    failure: { kind: "TURN_LIMIT" },
  });
});

test("every worker is stamped as a worker, at the spawner", () => {
  // THE MECHANICAL HALF OF THE RE-ENTRY GUARD. A slice prompt is long,
  // enumerated, and full of exactly the words the host-side nudge hook matches
  // on, so without this marker that hook fires inside a worker and tells it to
  // start a second orchestrator — which spends the whole slice and lands
  // nothing. `surfaces/claude-code/hooks/nudge.mjs` reads it before it reads
  // stdin, and `test/surfaces.test.ts` asserts the silence it produces.
  //
  // STAMPED HERE, NEVER INHERITED. It is written after the spec's environment is
  // spread, so a spec cannot carry a different value in and a genuine top-level
  // session cannot pick one up from an ancestor and silently disarm its nudge.
  expect(workerEnvironment(claudeSpec("success"))).toMatchObject({
    SHELL: "/bin/sh",
    BRIGADIER_WORKER: "1",
  });
  expect(workerEnvironment(codexSpec("success"))).toMatchObject({
    SHELL: "/bin/sh",
    BRIGADIER_WORKER: "1",
  });
  const spec = claudeSpec("success", { BRIGADIER_WORKER: "not-a-worker" });
  expect(workerEnvironment(spec).BRIGADIER_WORKER).toBe("1");
});

test("re-validates branded idle timeout values at the spawn boundary", async () => {
  const invalid = {
    ...codexSpec("success"),
    idleTimeoutMs: IDLE_TIMEOUT_BOUNDARY_MS as CodexWorkerSpec["idleTimeoutMs"],
  };
  await expect(new CodexWorker().spawn(invalid)).rejects.toThrow(
    "idle timeout must be a whole number above 600000 ms",
  );
});

async function runClaude(
  scenario: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<WorkerOutcome> {
  const spawned = await within(
    new ClaudeWorker().spawn(claudeSpec(scenario, extraEnvironment)),
    2_000,
    `Claude ${scenario} spawn`,
  );
  return within<WorkerOutcome>(spawned.completion, 2_000, `Claude ${scenario}`);
}

function claudeSpec(
  scenario: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): ClaudeWorkerSpec {
  const base = {
    id: `claude-${scenario}`,
    vendor: "claude",
    model: "claude-test-model",
    effort: "high",
    prompt,
    cwd: repositoryRoot,
    environment: {
      ...baseEnvironment(),
      BRIGADIER_FAKE_SCENARIO: scenario,
      BRIGADIER_FAKE_EXPECTED_STDIN: prompt,
      BRIGADIER_FAKE_STDIN_LIFECYCLE: "write-then-close",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      SHELL: "/bin/sh",
      ...extraEnvironment,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      filesystem: {
        workspaceAccess: "edit",
        editablePaths: ["src/worker/**"],
      },
      network: { allowedDomains: [] },
    },
    instructionFiles: { user: "exclude", project: "exclude" },
    idleTimeoutMs: createIdleTimeoutMs(IDLE_TIMEOUT_BOUNDARY_MS + 1),
    timeoutMs: 1_500,
    maxTurns: null,
    maxBudgetUsd: 1.5,
    excludeDynamicSystemPromptSections: true,
    tools: ["Read", "Edit"],
    extraDirectories: ["/workspace/shared"],
    mcp: { configFiles: ["/workspace/mcp.json"], strict: true },
  } as const satisfies ClaudeWorkerSpec;
  return withExpectedArgv(base, buildClaudeCommand(base));
}

function codexSpec(scenario: string): CodexWorkerSpec {
  const base = {
    id: `codex-${scenario}`,
    vendor: "codex",
    model: "gpt-test-model",
    effort: "xhigh",
    prompt,
    cwd: repositoryRoot,
    environment: {
      ...baseEnvironment(),
      BRIGADIER_FAKE_SCENARIO: scenario,
      BRIGADIER_FAKE_EXPECTED_STDIN: prompt,
      SHELL: "/bin/sh",
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      filesystem: {
        workspaceAccess: "edit",
        editablePaths: ["src/worker/**"],
      },
      network: { allowedDomains: [] },
    },
    instructionFiles: { user: "include", project: "exclude" },
    idleTimeoutMs: createIdleTimeoutMs(IDLE_TIMEOUT_BOUNDARY_MS + 1),
    timeoutMs: 1_500,
    maxTurns: null,
  } as const satisfies CodexWorkerSpec;
  return withExpectedArgv(base, buildCodexCommand(base));
}

function withExpectedArgv<Spec extends ClaudeWorkerSpec | CodexWorkerSpec>(
  spec: Spec,
  command: readonly string[],
): Spec {
  return {
    ...spec,
    environment: {
      ...spec.environment,
      BRIGADIER_FAKE_EXPECTED_ARGV: JSON.stringify(command.slice(1)),
    },
  };
}

function baseEnvironment(): Record<string, string> & {
  readonly PATH: string;
} {
  return {
    PATH: `${fakeBin}:${requiredPath()}`,
  };
}

function requiredPath(): string {
  const path = process.env.PATH;
  if (path === undefined) {
    throw new Error("PATH is required for worker adapter tests");
  }
  return path;
}

async function collect(
  events: AsyncIterable<WorkerEvent>,
): Promise<WorkerEvent[]> {
  const collected: WorkerEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function createNeverExitingClaude(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "brigadier-claude-"));
  temporaryDirectories.push(directory);
  const executable = resolve(directory, "claude");
  await Bun.write(
    executable,
    `#!/bin/sh
IFS= read -r received
if [ "$received" != "${prompt}" ]; then
  echo "stdin mismatch" >&2
  exit 1
fi
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"never-exits"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","api_error_status":null,"result":"completed before exit","duration_ms":5,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"modelUsage":{}}'
trap 'sleep 1; exit 0' TERM
while :; do sleep 60; done
`,
  );
  await chmod(executable, 0o755);
  return directory;
}

async function createTwoTurnClaude(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "brigadier-claude-turns-"));
  temporaryDirectories.push(directory);
  const executable = resolve(directory, "claude");
  await Bun.write(
    executable,
    `#!/bin/sh
IFS= read -r received
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"one"}]}}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"two"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","api_error_status":null,"result":"two turns","duration_ms":5,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"modelUsage":{}}'
`,
  );
  await chmod(executable, 0o755);
  return directory;
}

async function createGrandchildCodex(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "brigadier-codex-child-"));
  temporaryDirectories.push(directory);
  const executable = resolve(directory, "codex");
  await Bun.write(
    executable,
    `#!/bin/sh
IFS= read -r received
printf '%s\n' '{"type":"thread.started","thread_id":"grandchild-thread"}'
printf '%s\n' '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"grandchild complete"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}'
/bin/sh -c "trap '' TERM; while :; do sleep 60; done" &
exit 0
`,
  );
  await chmod(executable, 0o755);
  return directory;
}

async function createExecutableDecoys(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "brigadier-decoys-"));
  temporaryDirectories.push(directory);
  const claudeExecutable = resolve(directory, "claude");
  const codexExecutable = resolve(directory, "codex");
  await Promise.all([
    Bun.write(claudeExecutable, "#!/bin/sh\nexit 97\n"),
    Bun.write(codexExecutable, "#!/bin/sh\nexit 97\n"),
  ]);
  await Promise.all([
    chmod(claudeExecutable, 0o755),
    chmod(codexExecutable, 0o755),
  ]);
  return directory;
}

function canSignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canSignalProcessGroup(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function forceKillProcessTree(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ESRCH"
    ) {
      throw error;
    }
  }
}
