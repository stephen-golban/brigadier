import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ClaudeStdinLifecycle } from "../scripts/fakes/harness.ts";
import {
  ADAPTER_DECLARATIONS,
  type AnyWorker,
  type ClaudeWorkerEnvironment,
  createIdleTimeoutMs,
  DEFAULT_IDLE_TIMEOUT_MS,
  type FailureKind,
  IDLE_TIMEOUT_BOUNDARY_MS,
  type SpawnedWorker,
  type WorkerEvent,
  type WorkerOutcome,
} from "../src/contracts.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const fakeBin = resolve(repositoryRoot, "scripts/fakes");
const fixtureDirectory = resolve(import.meta.dir, "fixtures");
const prompt = "Return exactly ok.";
const claudeArgs = [
  "-p",
  "--verbose",
  "--output-format",
  "stream-json",
  "--exclude-dynamic-system-prompt-sections",
  "--tools",
  "Read,Edit",
  "--add-dir",
  "/workspace/shared",
  "--mcp-config",
  "/workspace/mcp.json",
  "--strict-mcp-config",
] as const;
const codexArgs = ["exec", "--json", "-"] as const;
const claudeStdinLifecycles = [
  "write-then-close",
  "keep-open",
] as const satisfies readonly ClaudeStdinLifecycle[];

type JsonObject = Record<string, unknown>;

interface ReplayCase {
  readonly name: string;
  readonly executable: "claude" | "codex";
  readonly args: readonly string[];
  readonly expectedStdin: string;
  readonly scenario: string;
  readonly exitCode: number;
  readonly failure: FailureKind | null;
}

const cases: readonly ReplayCase[] = [
  {
    name: "Claude success",
    executable: "claude",
    args: claudeArgs,
    expectedStdin: prompt,
    scenario: "success",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Claude bad model",
    executable: "claude",
    args: claudeArgs,
    expectedStdin: prompt,
    scenario: "bad-model",
    exitCode: 1,
    failure: "BAD_MODEL",
  },
  {
    name: "Claude budget exhaustion",
    executable: "claude",
    args: claudeArgs,
    expectedStdin: prompt,
    scenario: "budget-exhaustion",
    exitCode: 1,
    failure: "BUDGET_EXCEEDED",
  },
  {
    name: "Claude rate limit warning",
    executable: "claude",
    args: claudeArgs,
    expectedStdin: prompt,
    scenario: "rate-limit",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Claude rate limit allowed",
    executable: "claude",
    args: claudeArgs,
    expectedStdin: prompt,
    scenario: "rate-limit-allowed",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Claude rate limit rejected",
    executable: "claude",
    args: claudeArgs,
    expectedStdin: prompt,
    scenario: "rate-limit-rejected",
    exitCode: 0,
    failure: "QUOTA_EXHAUSTED",
  },
  {
    name: "Claude internal API retry",
    executable: "claude",
    args: claudeArgs,
    expectedStdin: prompt,
    scenario: "api-retry",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Claude U+2028 payload",
    executable: "claude",
    args: claudeArgs,
    expectedStdin: prompt,
    scenario: "unicode-separator",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Codex success",
    executable: "codex",
    args: codexArgs,
    expectedStdin: prompt,
    scenario: "success",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Codex failure",
    executable: "codex",
    args: codexArgs,
    expectedStdin: prompt,
    scenario: "failure",
    exitCode: 1,
    failure: "BAD_MODEL",
  },
];

describe("worker contracts", () => {
  test("keeps adapter discovery table-driven", () => {
    expect(ADAPTER_DECLARATIONS).toEqual([
      {
        vendor: "claude",
        executable: "claude",
        processCompletion: "signals-then-must-be-killed",
        workerShell: "withheld",
      },
      {
        vendor: "codex",
        executable: "codex",
        processCompletion: "self-exits",
        workerShell: "available",
      },
    ]);
  });

  test("keeps vendor and completion behavior correlated in AnyWorker", () => {
    const contradictoryClaudeWorker = {
      vendor: "claude",
      processCompletion: "self-exits",
      spawn: async () => {
        throw new Error("not called");
      },
    } as const;

    // @ts-expect-error AnyWorker rejects Claude paired with Codex completion behavior.
    acceptAnyWorker(contradictoryClaudeWorker);
  });

  test("keeps the default idle timeout above the 600-second boundary", () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeGreaterThan(IDLE_TIMEOUT_BOUNDARY_MS);
    expect(() => createIdleTimeoutMs(IDLE_TIMEOUT_BOUNDARY_MS)).toThrow(
      "idle timeout must be a whole number above 600000 ms",
    );
    expect(() => createIdleTimeoutMs(599_999)).toThrow(RangeError);
  });

  test("couples pid presence to launch outcome", async () => {
    const launchFailure = {
      ok: false,
      output: "",
      usage: emptyUsage(),
      durationMs: 0,
      exitCode: null,
      signal: null,
      failure: {
        kind: "LAUNCH_FAILURE",
        message: "spawn ENOENT",
        retryable: false,
        statusCode: null,
      },
    } as const satisfies WorkerOutcome;

    const numericPidWithLaunchFailure = {
      pid: 123,
      events: noWorkerEvents(),
      completion: Promise.resolve(launchFailure),
      cancel: async () => {
        await Promise.resolve();
      },
    };
    // @ts-expect-error A launched pid cannot resolve to LAUNCH_FAILURE.
    acceptSpawnedWorker(numericPidWithLaunchFailure);

    const success = {
      ok: true,
      output: "ok",
      usage: emptyUsage(),
      durationMs: 1,
      exitCode: 0,
      signal: null,
    } as const satisfies WorkerOutcome;
    const nullPidWithSuccess = {
      pid: null,
      events: noWorkerEvents(),
      completion: Promise.resolve(success),
      cancel: async () => {
        await Promise.resolve();
      },
    };
    // @ts-expect-error A null pid is reserved for a LAUNCH_FAILURE outcome.
    acceptSpawnedWorker(nullPidWithSuccess);

    const spawned = {
      pid: null,
      events: noWorkerEvents(),
      completion: Promise.resolve(launchFailure),
      cancel: async () => {
        await Promise.resolve();
      },
    } satisfies SpawnedWorker;

    expect(spawned.pid).toBeNull();
    expect(await spawned.completion).toEqual(launchFailure);
  });

  test("requires non-TTY and Claude auto-memory environment guarantees", () => {
    const environment = {
      SHELL: "/bin/sh",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      EXTRA: "allowed",
    } as const satisfies ClaudeWorkerEnvironment;
    expect(environment.SHELL).toBe("/bin/sh");
    expect(environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");

    type AutoMemoryIsMandatory =
      ClaudeWorkerEnvironment["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] extends "1"
        ? true
        : false;
    type NonTtyShellIsMandatory =
      ClaudeWorkerEnvironment["SHELL"] extends "/bin/sh" ? true : false;
    const guarantees: [AutoMemoryIsMandatory, NonTtyShellIsMandatory] = [
      true,
      true,
    ];
    expect(guarantees).toEqual([true, true]);
  });
});

describe("fake worker executables", () => {
  for (const replayCase of cases) {
    const lifecycles =
      replayCase.executable === "claude"
        ? claudeStdinLifecycles
        : ([null] as const);
    for (const lifecycle of lifecycles) {
      const lifecycleLabel = lifecycle === null ? "one-shot stdin" : lifecycle;
      test(`replays and classifies ${replayCase.name} with ${lifecycleLabel}`, async () => {
        const processHandle = spawnFake(
          replayCase.executable,
          replayCase.args,
          replayCase.scenario,
          {
            expectedArgs: replayCase.args,
            expectedStdin: replayCase.expectedStdin,
            claudeStdinLifecycle: lifecycle ?? undefined,
          },
        );
        const [stdout, stderr, exitCode] = await runPromptScenario(
          processHandle,
          replayCase.expectedStdin,
          lifecycle,
          replayCase.name,
        );
        const events = parseNdjson(stdout);

        expect(stderr).toBe("");
        expect(exitCode).toBe(replayCase.exitCode);
        expect(events.length).toBeGreaterThan(0);
        expect(
          events.every((event) => typeof event.type === "string"),
        ).toBeTrue();
        expect(classify(events, exitCode)).toBe(replayCase.failure);
        assertBehavior(replayCase.scenario, events);
      });
    }
  }

  for (const vendor of ["claude", "codex"] as const) {
    const expectedArgs = vendor === "claude" ? claudeArgs : codexArgs;
    const errorExitCode = vendor === "claude" ? 1 : 2;

    test(`rejects a swallowed positional prompt for ${vendor}`, async () => {
      const processHandle = spawnFake(vendor, expectedArgs, "success", {
        expectedArgs,
        expectedStdin: prompt,
        claudeStdinLifecycle:
          vendor === "claude" ? "write-then-close" : undefined,
      });
      processHandle.stdin.end();
      const [stderr, exitCode] = await within(
        Promise.all([
          new Response(processHandle.stderr).text(),
          processHandle.exited,
        ]),
        2_000,
        `${vendor} stdin validation`,
      );
      expect(exitCode).toBe(errorExitCode);
      expect(stderr).toContain("stdin mismatch");
    });

    test(`rejects bad argv for ${vendor}`, async () => {
      const processHandle = spawnFake(vendor, ["--bad-argv"], "success", {
        expectedArgs,
        expectedStdin: prompt,
        claudeStdinLifecycle:
          vendor === "claude" ? "write-then-close" : undefined,
      });
      processHandle.stdin.end();
      const [stderr, exitCode] = await within(
        Promise.all([
          new Response(processHandle.stderr).text(),
          processHandle.exited,
        ]),
        2_000,
        `${vendor} argv validation`,
      );
      expect(exitCode).toBe(errorExitCode);
      expect(stderr).toContain("argv mismatch");
    });
  }

  test("classifies a Codex argv parser failure from exit 2", async () => {
    const args = ["exec", "--definitely-invalid"] as const;
    const processHandle = spawnFake("codex", args, "argv-error", {
      expectedArgs: args,
      expectedStdin: "",
      claudeStdinLifecycle: undefined,
    });
    processHandle.stdin.end();

    const [stdout, stderr, exitCode] = await within(
      Promise.all([
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
        processHandle.exited,
      ]),
      2_000,
      "Codex argv error",
    );

    expect(stdout).toBe("");
    expect(stderr).toContain("unexpected argument '--definitely-invalid'");
    expect(exitCode).toBe(2);
    expect(classify([], exitCode)).toBe("ARGV_BUG");
  });

  test("classifies Claude terminal results from all three error fields", () => {
    const hard404 = {
      type: "result",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 404,
    };
    expect(classify([hard404], 0)).toBe("BAD_MODEL");
    expect(classify([{ ...hard404, is_error: false }], 0)).toBeNull();
  });

  test("exposes Claude completion before its keep-open process exits", async () => {
    const processHandle = spawnFake("claude", claudeArgs, "success", {
      expectedArgs: claudeArgs,
      expectedStdin: prompt,
      claudeStdinLifecycle: "keep-open",
    });
    const [eventStream, drainStream] = processHandle.stdout.tee();
    const events = createNdjsonReader(eventStream);
    const draining = new Response(drainStream).text();
    processHandle.stdin.write(`${prompt}\n`);

    try {
      let terminal: JsonObject | null = null;
      while (terminal === null) {
        const event = await within(
          events.next(),
          2_000,
          "Claude terminal event",
        );
        if (event.type === "result") {
          terminal = event;
        }
      }
      expect(terminal.terminal_reason).toBe("completed");

      await expect(
        within(
          Promise.all([draining, processHandle.exited]),
          100,
          "process-exit stream reader",
        ),
      ).rejects.toThrow("process-exit stream reader timed out");
    } finally {
      processHandle.stdin.end();
    }

    expect(await within(processHandle.exited, 2_000, "Claude stdin EOF")).toBe(
      0,
    );
    await within(draining, 2_000, "Claude stdout EOF");
  });

  for (const lifecycle of claudeStdinLifecycles) {
    test(`requires process-group kill with ${lifecycle} Claude stdin`, async () => {
      const processHandle = spawnFake("claude", claudeArgs, "grandchild-pipe", {
        detached: true,
        expectedArgs: claudeArgs,
        expectedStdin: prompt,
        claudeStdinLifecycle: lifecycle,
      });
      const reader = processHandle.stdout.getReader();
      processHandle.stdin.write(
        lifecycle === "keep-open" ? `${prompt}\n` : prompt,
      );
      if (lifecycle === "write-then-close") {
        processHandle.stdin.end();
      }
      const first = await within(
        reader.read(),
        2_000,
        `${lifecycle} grandchild output`,
      );
      expect(first.done).toBeFalse();

      try {
        if (lifecycle === "keep-open") {
          await expect(
            within(processHandle.exited, 75, "fake parent before stdin EOF"),
          ).rejects.toThrow("fake parent before stdin EOF timed out");
          processHandle.stdin.end();
        }
        expect(
          await within(processHandle.exited, 2_000, "fake parent exit"),
        ).toBe(0);
        processHandle.kill("SIGTERM");
        await expect(
          within(reader.read(), 100, "pid-only pipe close"),
        ).rejects.toThrow("pid-only pipe close timed out");

        process.kill(-processHandle.pid, "SIGTERM");
        const output =
          decodeChunk(first.value) +
          (await within(
            readRemaining(reader),
            2_000,
            "process-group pipe close",
          ));
        const events = parseNdjson(output);
        expect(events).toHaveLength(1);
        expect(events[0]?.subtype).toBe("grandchild_pipe_open");
      } finally {
        try {
          process.kill(-processHandle.pid, "SIGKILL");
        } catch {
          // The group normally no longer exists after the asserted SIGTERM.
        }
      }
    });
  }

  for (const lifecycle of claudeStdinLifecycles) {
    test(`models a healthy 405-second Claude silence with ${lifecycle}`, async () => {
      const startedAt = performance.now();
      const processHandle = spawnFake("claude", claudeArgs, "long-silence", {
        expectedArgs: claudeArgs,
        expectedStdin: prompt,
        claudeStdinLifecycle: lifecycle,
        extraEnvironment: { BRIGADIER_FAKE_SILENCE_MS: "80" },
      });
      const [stdout, _stderr, exitCode] = await runPromptScenario(
        processHandle,
        prompt,
        lifecycle,
        "scaled long silence",
      );
      const elapsedMs = performance.now() - startedAt;
      const events = parseNdjson(stdout);
      const terminal = events.at(-1);

      expect(exitCode).toBe(0);
      expect(elapsedMs).toBeGreaterThanOrEqual(70);
      expect(terminal?.duration_ms).toBe(405_000);
    });
  }

  test("keeps a Codex app-server alive across requests and exits on stdin EOF", async () => {
    const args = ["app-server", "--stdio"] as const;
    const processHandle = spawnFake("codex", args, "app-server", {
      expectedArgs: args,
      expectedStdin: "",
      claudeStdinLifecycle: undefined,
    });
    const responses = createNdjsonReader(processHandle.stdout);
    const stderr = new Response(processHandle.stderr).text();

    processHandle.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "account/rateLimits/read" })}\n`,
    );
    const first = await within(responses.next(), 2_000, "first RPC response");
    expect(first.id).toBe(1);
    expect(first.result).toEqual({
      rateLimits: {
        primary: {
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: 1_786_026_000,
        },
        secondary: {
          usedPercent: 34,
          windowDurationMins: 10_080,
          resetsAt: 1_786_458_000,
        },
      },
    });

    await expect(
      within(processHandle.exited, 75, "app-server before EOF"),
    ).rejects.toThrow("app-server before EOF timed out");

    processHandle.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "unknown/method" })}\n`,
    );
    const second = await within(responses.next(), 2_000, "second RPC response");
    expect(second.id).toBe(2);
    expect(second.error).toEqual({ code: -32601, message: "Method not found" });

    processHandle.stdin.end();
    expect(await within(processHandle.exited, 2_000, "app-server EOF")).toBe(0);
    expect(await within(stderr, 2_000, "app-server stderr EOF")).toBe("");
  });
});

describe("JSONL fixture integrity", () => {
  test("parses every non-empty line of every fixture", async () => {
    const fixtureNames: string[] = [];
    for await (const name of new Bun.Glob("*.jsonl").scan(fixtureDirectory)) {
      fixtureNames.push(name);
      const contents = await Bun.file(resolve(fixtureDirectory, name)).text();
      const events = parseNdjson(contents);
      expect(events.length).toBeGreaterThan(0);
    }
    expect(fixtureNames.length).toBeGreaterThanOrEqual(11);
  });

  test("keeps literal U+2028 inside one NDJSON record", async () => {
    const contents = await Bun.file(
      resolve(fixtureDirectory, "claude-u2028.jsonl"),
    ).text();
    const events = parseNdjson(contents);
    expect(events).toHaveLength(3);
    expect(contents).toContain("\u2028");
    expect(
      JSON.stringify(events[1]?.message).includes("line separator"),
    ).toBeTrue();
  });
});

function spawnFake(
  executable: "claude" | "codex",
  args: readonly string[],
  selectedScenario: string,
  options: {
    readonly detached?: boolean;
    readonly expectedArgs: readonly string[];
    readonly expectedStdin: string;
    readonly claudeStdinLifecycle: ClaudeStdinLifecycle | undefined;
    readonly extraEnvironment?: Readonly<Record<string, string>>;
  },
) {
  const currentPath = process.env.PATH;
  if (currentPath === undefined) {
    throw new Error("PATH must be set for fake executable tests");
  }

  return Bun.spawn([executable, ...args], {
    cwd: repositoryRoot,
    detached: options.detached ?? false,
    env: {
      ...process.env,
      ...options.extraEnvironment,
      ...(options.claudeStdinLifecycle === undefined
        ? {}
        : {
            BRIGADIER_FAKE_STDIN_LIFECYCLE: options.claudeStdinLifecycle,
          }),
      BRIGADIER_FAKE_EXPECTED_ARGV: JSON.stringify(options.expectedArgs),
      BRIGADIER_FAKE_EXPECTED_STDIN: options.expectedStdin,
      BRIGADIER_FAKE_SCENARIO: selectedScenario,
      PATH: `${fakeBin}:${currentPath}`,
    },
    stdin: "pipe",
    stderr: "pipe",
    stdout: "pipe",
  });
}

async function runPromptScenario(
  processHandle: ReturnType<typeof spawnFake>,
  expectedStdin: string,
  lifecycle: ClaudeStdinLifecycle | null,
  label: string,
): Promise<readonly [stdout: string, stderr: string, exitCode: number]> {
  const stderrPromise = new Response(processHandle.stderr).text();
  if (lifecycle !== "keep-open") {
    processHandle.stdin.write(expectedStdin);
    processHandle.stdin.end();
    return within(
      Promise.all([
        new Response(processHandle.stdout).text(),
        stderrPromise,
        processHandle.exited,
      ]),
      2_000,
      label,
    );
  }

  const reader = processHandle.stdout.getReader();
  const decoder = new TextDecoder();
  processHandle.stdin.write(`${expectedStdin}\n`);
  const first = await within(reader.read(), 2_000, `${label} first output`);
  expect(first.done).toBeFalse();
  await expect(
    within(processHandle.exited, 75, `${label} before stdin EOF`),
  ).rejects.toThrow(`${label} before stdin EOF timed out`);
  processHandle.stdin.end();
  const firstText = decoder.decode(first.value, { stream: true });

  const [remaining, stderr, exitCode] = await within(
    Promise.all([
      readRemaining(reader, decoder),
      stderrPromise,
      processHandle.exited,
    ]),
    2_000,
    `${label} after stdin EOF`,
  );
  return [firstText + remaining, stderr, exitCode];
}

async function readRemaining(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder = new TextDecoder(),
): Promise<string> {
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return text + decoder.decode();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function decodeChunk(chunk: Uint8Array | undefined): string {
  return chunk === undefined ? "" : new TextDecoder().decode(chunk);
}

function parseNdjson(text: string): JsonObject[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on NDJSON line ${index + 1}`, {
          cause: error,
        });
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`NDJSON line ${index + 1} is not an object`);
      }
      return value as JsonObject;
    });
}

function createNdjsonReader(stream: ReadableStream<Uint8Array>): {
  next(): Promise<JsonObject>;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  return {
    async next(): Promise<JsonObject> {
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline).replace(/\r$/, "");
          buffered = buffered.slice(newline + 1);
          if (line.length === 0) {
            continue;
          }
          return parseNdjson(`${line}\n`)[0] as JsonObject;
        }

        const chunk = await reader.read();
        if (chunk.done) {
          buffered += decoder.decode();
          if (buffered.length > 0) {
            const finalLine = buffered;
            buffered = "";
            return parseNdjson(finalLine)[0] as JsonObject;
          }
          throw new Error("NDJSON stream ended before another event arrived");
        }
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

/**
 * Reference oracle for fixture expectations only. Its callers should be moved
 * onto the production normalizer this function implements.
 */
function classify(
  events: readonly JsonObject[],
  exitCode: number,
): FailureKind | null {
  if (exitCode === 2) {
    return "ARGV_BUG";
  }

  const result = events.findLast((event) => event.type === "result");
  const isError = result?.is_error === true;
  const terminalReason = result?.terminal_reason;
  const apiErrorStatus = result?.api_error_status;
  if (isError) {
    if (terminalReason === "max_budget_usd") {
      return "BUDGET_EXCEEDED";
    }
    if (terminalReason === "rate_limit" || apiErrorStatus === 429) {
      return "QUOTA_EXHAUSTED";
    }
    if (apiErrorStatus === 404) {
      return "BAD_MODEL";
    }
  }

  const serialized = JSON.stringify(events);
  if (serialized.includes("model is not supported")) {
    return "BAD_MODEL";
  }
  return exitCode === 0 ? null : "UNKNOWN_FAILURE";
}

function assertBehavior(
  selectedScenario: string,
  events: readonly JsonObject[],
): void {
  if (selectedScenario.startsWith("rate-limit")) {
    const expectedStatus = selectedScenario
      .replace("rate-limit-", "")
      .replace("rate-limit", "allowed_warning");
    const rateLimit = events.find((event) => event.type === "rate_limit_event");
    const rateLimitInfo = asObject(rateLimit?.rate_limit_info);
    expect(rateLimitInfo.status).toBe(expectedStatus);
  }

  if (selectedScenario === "budget-exhaustion") {
    const terminal = events.findLast((event) => event.type === "result");
    const usage = asObject(terminal?.usage);
    const modelUsage = asObject(terminal?.modelUsage);
    const perModel = asObject(Object.values(modelUsage)[0]);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(perModel.inputTokens).toBe(21);
    expect(perModel.outputTokens).toBe(42);
    expect(preferredClaudeInputTotal(terminal)).toBe(3_021);
  }

  if (selectedScenario === "api-retry") {
    const retries = events.filter(
      (event) => event.type === "system" && event.subtype === "api_retry",
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      attempt: 2,
      max_retries: 10,
      error_status: 529,
      error: "overloaded",
    });
  }

  if (selectedScenario === "unicode-separator") {
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events[1]?.message)).toContain("\u2028");
  }
}

/**
 * Reference oracle for fixture expectations only. Its callers should be moved
 * onto production token normalization.
 */
function preferredClaudeInputTotal(result: JsonObject | undefined): number {
  const modelUsage = asObject(result?.modelUsage);
  const models = Object.values(modelUsage);
  if (models.length > 0) {
    return models.reduce<number>((total, value) => {
      const usage = asObject(value);
      return (
        total +
        asNumber(usage.inputTokens) +
        asNumber(usage.cacheReadInputTokens) +
        asNumber(usage.cacheCreationInputTokens)
      );
    }, 0);
  }

  const usage = asObject(result?.usage);
  return (
    asNumber(usage.input_tokens) +
    asNumber(usage.cache_read_input_tokens) +
    asNumber(usage.cache_creation_input_tokens)
  );
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function emptyUsage(): WorkerOutcome["usage"] {
  return {
    input: { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 },
    output: { total: 0, reasoning: null },
  };
}

async function* noWorkerEvents(): AsyncGenerator<WorkerEvent> {
  yield* [] as WorkerEvent[];
}

function acceptAnyWorker(_worker: AnyWorker): void {}

function acceptSpawnedWorker(_worker: SpawnedWorker): void {}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}
