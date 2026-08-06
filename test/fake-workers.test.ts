import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { FailureKind } from "../src/contracts.ts";

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

type JsonObject = Record<string, unknown>;

interface ReplayCase {
  readonly name: string;
  readonly executable: "claude" | "codex";
  readonly args: readonly string[];
  readonly scenario: string;
  readonly exitCode: number;
  readonly failure: FailureKind | null;
}

const cases: readonly ReplayCase[] = [
  {
    name: "Claude success",
    executable: "claude",
    args: claudeArgs,
    scenario: "success",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Claude bad model",
    executable: "claude",
    args: claudeArgs,
    scenario: "bad-model",
    exitCode: 1,
    failure: "BAD_MODEL",
  },
  {
    name: "Claude budget exhaustion",
    executable: "claude",
    args: claudeArgs,
    scenario: "budget-exhaustion",
    exitCode: 1,
    failure: "BUDGET_EXCEEDED",
  },
  {
    name: "Claude rate limit warning",
    executable: "claude",
    args: claudeArgs,
    scenario: "rate-limit",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Claude rate limit allowed",
    executable: "claude",
    args: claudeArgs,
    scenario: "rate-limit-allowed",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Claude rate limit rejected",
    executable: "claude",
    args: claudeArgs,
    scenario: "rate-limit-rejected",
    exitCode: 0,
    failure: "QUOTA_EXHAUSTED",
  },
  {
    name: "Claude internal API retry",
    executable: "claude",
    args: claudeArgs,
    scenario: "api-retry",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Claude U+2028 payload",
    executable: "claude",
    args: claudeArgs,
    scenario: "unicode-separator",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Codex success",
    executable: "codex",
    args: codexArgs,
    scenario: "success",
    exitCode: 0,
    failure: null,
  },
  {
    name: "Codex failure",
    executable: "codex",
    args: codexArgs,
    scenario: "failure",
    exitCode: 1,
    failure: "BAD_MODEL",
  },
];

describe("fake worker executables", () => {
  for (const replayCase of cases) {
    test(`replays and classifies ${replayCase.name}`, async () => {
      const processHandle = spawnFake(
        replayCase.executable,
        replayCase.args,
        replayCase.scenario,
      );
      processHandle.stdin.write(prompt);
      processHandle.stdin.end();

      const [stdout, stderr, exitCode] = await within(
        Promise.all([
          new Response(processHandle.stdout).text(),
          new Response(processHandle.stderr).text(),
          processHandle.exited,
        ]),
        2_000,
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

  test("validates Claude argv and Codex stdin with vendor exit codes", async () => {
    const claude = spawnFake("claude", ["-p"], "success", {
      expectedArgs: claudeArgs,
    });
    claude.stdin.end();
    const [claudeStderr, claudeExit] = await within(
      Promise.all([new Response(claude.stderr).text(), claude.exited]),
      2_000,
      "Claude argv validation",
    );
    expect(claudeExit).toBe(1);
    expect(claudeStderr).toContain("argv mismatch");

    const codex = spawnFake("codex", codexArgs, "success", {
      expectedStdin: prompt,
    });
    codex.stdin.write("wrong prompt");
    codex.stdin.end();
    const [codexStderr, codexExit] = await within(
      Promise.all([new Response(codex.stderr).text(), codex.exited]),
      2_000,
      "Codex stdin validation",
    );
    expect(codexExit).toBe(2);
    expect(codexStderr).toContain("stdin mismatch");
  });

  test("classifies a Codex argv parser failure from exit 2", async () => {
    const args = ["exec", "--definitely-invalid"] as const;
    const processHandle = spawnFake("codex", args, "argv-error");
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

  test("exposes Claude completion before its process exits", async () => {
    const processHandle = spawnFake("claude", claudeArgs, "never-exits");
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

  test("requires process-group kill to close a grandchild-held pipe", async () => {
    const processHandle = spawnFake("claude", claudeArgs, "grandchild-pipe", {
      detached: true,
    });
    const output = new Response(processHandle.stdout).text();
    processHandle.stdin.write(prompt);
    processHandle.stdin.end();

    try {
      expect(
        await within(processHandle.exited, 2_000, "fake parent exit"),
      ).toBe(0);
      processHandle.kill("SIGTERM");
      await expect(within(output, 100, "pid-only pipe close")).rejects.toThrow(
        "pid-only pipe close timed out",
      );

      process.kill(-processHandle.pid, "SIGTERM");
      const events = parseNdjson(
        await within(output, 2_000, "process-group pipe close"),
      );
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

  test("models a healthy 405-second Claude silence without waiting 405 seconds", async () => {
    const startedAt = performance.now();
    const processHandle = spawnFake("claude", claudeArgs, "long-silence", {
      extraEnvironment: { BRIGADIER_FAKE_SILENCE_MS: "80" },
    });
    processHandle.stdin.write(prompt);
    processHandle.stdin.end();

    const [stdout, exitCode] = await within(
      Promise.all([
        new Response(processHandle.stdout).text(),
        processHandle.exited,
      ]),
      2_000,
      "scaled long silence",
    );
    const elapsedMs = performance.now() - startedAt;
    const events = parseNdjson(stdout);
    const terminal = events.at(-1);

    expect(exitCode).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(70);
    expect(terminal?.duration_ms).toBe(405_000);
    expect(600_001).toBeGreaterThan(600_000);
  });

  test("keeps a Codex app-server alive across requests and exits on stdin EOF", async () => {
    const args = ["app-server", "--stdio"] as const;
    const processHandle = spawnFake("codex", args, "app-server");
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
    readonly expectedArgs?: readonly string[];
    readonly expectedStdin?: string;
    readonly extraEnvironment?: Readonly<Record<string, string>>;
  } = {},
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
      BRIGADIER_FAKE_EXPECTED_ARGV: JSON.stringify(
        options.expectedArgs ?? args,
      ),
      BRIGADIER_FAKE_EXPECTED_STDIN: options.expectedStdin ?? prompt,
      BRIGADIER_FAKE_SCENARIO: selectedScenario,
      PATH: `${fakeBin}:${currentPath}`,
    },
    stdin: "pipe",
    stderr: "pipe",
    stdout: "pipe",
  });
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

function classify(
  events: readonly JsonObject[],
  exitCode: number,
): FailureKind | null {
  if (exitCode === 2) {
    return "ARGV_BUG";
  }

  const result = events.findLast((event) => event.type === "result");
  if (result?.terminal_reason === "max_budget_usd") {
    return "BUDGET_EXCEEDED";
  }
  if (
    result?.terminal_reason === "rate_limit" ||
    result?.api_error_status === 429
  ) {
    return "QUOTA_EXHAUSTED";
  }
  if (result?.api_error_status === 404) {
    return "BAD_MODEL";
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
