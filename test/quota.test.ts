import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { QuotaSnapshot } from "../src/contracts.ts";
import {
  ClaudeQuotaOracle,
  normalizeClaudeRateLimitEvent,
} from "../src/quota/claude.ts";
import {
  CodexQuotaOracle,
  normalizeCodexRateLimits,
} from "../src/quota/codex.ts";

const TEST_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 2_000;
const repositoryRoot = resolve(import.meta.dir, "..");
const fakeCodex = resolve(repositoryRoot, "scripts/fakes/codex");
const fixtureDirectory = resolve(import.meta.dir, "fixtures");
const appServerArgs = ["app-server", "--stdio"] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("Codex quota oracle", () => {
  test(
    "uses one long-lived app-server for repeated snapshots",
    async () => {
      const oracle = createFakeCodexOracle(1_800_000_000_000);
      try {
        const first = await within(
          oracle.snapshot(),
          OPERATION_TIMEOUT_MS,
          "first quota snapshot",
        );
        const pid = oracle.pid;
        expect(pid).toBeNumber();
        if (pid === null) {
          throw new Error("app-server did not expose a pid");
        }
        expect(isProcessAlive(pid)).toBeTrue();

        const second = await within(
          oracle.snapshot(),
          OPERATION_TIMEOUT_MS,
          "second quota snapshot",
        );

        expect(oracle.pid).toBe(pid);
        expect(first).toEqual(second);
        expect(first).toEqual({
          vendor: "codex",
          status: "available",
          observedAtMs: 1_800_000_000_000,
          windows: [
            {
              kind: "rolling",
              durationMinutes: 300,
              remainingFraction: 0.88,
              resetsAtMs: 1_786_026_000_000,
            },
            {
              kind: "weekly",
              durationMinutes: 10_080,
              remainingFraction: 0.6599999999999999,
              resetsAtMs: 1_786_458_000_000,
            },
          ],
          isUsingOverage: null,
        });
      } finally {
        await within(oracle.dispose(), OPERATION_TIMEOUT_MS, "oracle disposal");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "dispose is idempotent and terminates the detached process group",
    async () => {
      const oracle = createFakeCodexOracle(1);
      await within(oracle.snapshot(), OPERATION_TIMEOUT_MS, "quota snapshot");
      const pid = oracle.pid;
      if (pid === null) {
        throw new Error("app-server did not expose a pid");
      }

      const firstDispose = oracle.dispose();
      const secondDispose = oracle.dispose();
      expect(secondDispose).toBe(firstDispose);
      await within(firstDispose, OPERATION_TIMEOUT_MS, "first disposal");
      await within(secondDispose, OPERATION_TIMEOUT_MS, "second disposal");

      expect(isProcessGroupAlive(pid)).toBeFalse();
      await expect(oracle.snapshot()).rejects.toThrow("disposed");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "dispose rejects an in-flight request and closes app-server stdin",
    async () => {
      const oracle = createFakeCodexOracle(1);
      const snapshot = oracle.snapshot();
      const pid = await within(
        waitForPid(oracle),
        OPERATION_TIMEOUT_MS,
        "app-server pid",
      );
      if (pid === null) {
        throw new Error("app-server did not expose a pid");
      }

      const snapshotOutcome = snapshot.then(
        () => null,
        (error: unknown) => error,
      );
      const disposal = oracle.dispose();
      await within(disposal, OPERATION_TIMEOUT_MS, "mid-request disposal");
      const error = await snapshotOutcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("disposed");
      expect(isProcessGroupAlive(pid)).toBeFalse();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "dispose awaits shutdown when it wins the process spawn race",
    async () => {
      const oracle = createFakeCodexOracle(1);
      const snapshot = oracle.snapshot();
      const snapshotOutcome = snapshot.then(
        () => null,
        (error: unknown) => error,
      );

      await within(
        oracle.dispose(),
        OPERATION_TIMEOUT_MS,
        "spawn-race disposal",
      );
      const error = await within(
        snapshotOutcome,
        OPERATION_TIMEOUT_MS,
        "spawn-race snapshot",
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("disposed");
      const pid = oracle.pid;
      expect(pid).toBeNumber();
      if (pid !== null) {
        expect(isProcessGroupAlive(pid)).toBeFalse();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "uses non-null rateLimitReachedType as the exhaustion predicate",
    async () => {
      const response = await readFixtureRecord("quota-codex-exhausted.jsonl");
      const snapshot = normalizeCodexRateLimits(
        asObject(response.result),
        1_800_000_000_000,
      );

      expect(snapshot.status).toBe("exhausted");
      expect(snapshot.windows[0]?.remainingFraction).toBeCloseTo(0.13);

      const notReached = normalizeCodexRateLimits(
        {
          ...asObject(response.result),
          rateLimits: {
            ...asObject(asObject(response.result).rateLimits),
            rateLimitReachedType: null,
          },
        },
        1_800_000_000_000,
      );
      expect(notReached.status).toBe("available");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a malformed record permanently fails later snapshots instead of hanging",
    async () => {
      const executable = await createUnhealthyAppServer("malformed");
      const oracle = new CodexQuotaOracle({
        executable,
        requestTimeoutMs: 300,
      });
      try {
        await expect(
          within(oracle.snapshot(), 750, "malformed snapshot"),
        ).rejects.toThrow("invalid JSON");
        await expect(
          within(oracle.snapshot(), 100, "snapshot after reader death"),
        ).rejects.toThrow("invalid JSON");
      } finally {
        await within(oracle.dispose(), 1_000, "malformed oracle disposal");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "request timeout fails the process permanently and shutdown escalates",
    async () => {
      const executable = await createUnhealthyAppServer("silent");
      const oracle = new CodexQuotaOracle({
        executable,
        requestTimeoutMs: 100,
      });
      let pid: number | null = null;
      try {
        await expect(
          within(oracle.snapshot(), 500, "silent snapshot"),
        ).rejects.toThrow("timed out after 100 ms");
        pid = oracle.pid;
        await expect(
          within(oracle.snapshot(), 100, "snapshot after request timeout"),
        ).rejects.toThrow("timed out after 100 ms");
      } finally {
        pid ??= oracle.pid;
        try {
          await within(oracle.dispose(), 1_000, "silent oracle disposal");
        } finally {
          pid ??= oracle.pid;
          if (pid !== null) {
            await forceKillProcessTree(pid);
          }
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("Claude quota ingress", () => {
  for (const fixtureCase of [
    {
      fixture: "claude-rate-limit-allowed.jsonl",
      expectedStatus: "available",
    },
    {
      fixture: "claude-rate-limit.jsonl",
      expectedStatus: "warning",
    },
    {
      fixture: "claude-rate-limit-rejected.jsonl",
      expectedStatus: "exhausted",
    },
  ] as const) {
    test(
      `maps and retains ${fixtureCase.fixture}`,
      async () => {
        const raw = await readRateLimitEvent(fixtureCase.fixture);
        const normalized = normalizeClaudeRateLimitEvent(raw, 123_456);
        expect(normalized).not.toBeNull();
        if (normalized === null) {
          throw new Error("fixture did not contain a valid rate-limit event");
        }
        expect(normalized.status).toBe(fixtureCase.expectedStatus);
        expect(normalized.windows).toEqual([
          {
            kind: "rolling",
            durationMinutes: 300,
            remainingFraction: null,
            resetsAtMs: 1_786_026_000_000,
          },
        ]);
        expect(normalized.isUsingOverage).toBeFalse();

        const oracle = new ClaudeQuotaOracle();
        oracle.ingest({ type: "quota", snapshot: normalized, raw });
        expect(await oracle.snapshot()).toBe(normalized);
        await oracle.dispose();
        expect(() =>
          oracle.ingest({ type: "quota", snapshot: normalized, raw }),
        ).toThrow("disposed");
      },
      TEST_TIMEOUT_MS,
    );
  }

  test(
    "reports unknown before the first push event",
    async () => {
      const oracle = new ClaudeQuotaOracle();
      const snapshot = await oracle.snapshot();
      expect(snapshot).toMatchObject({
        vendor: "claude",
        status: "unknown",
        windows: [],
        isUsingOverage: null,
      } satisfies Partial<QuotaSnapshot>);
      await oracle.dispose();
    },
    TEST_TIMEOUT_MS,
  );

  test("normalizes unknown statuses and negative reset times consistently", () => {
    expect(
      normalizeClaudeRateLimitEvent(
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "new_vendor_status",
            rateLimitType: "five_hour",
            resetsAt: -1,
          },
        },
        123,
      ),
    ).toEqual({
      vendor: "claude",
      status: "unknown",
      observedAtMs: 123,
      windows: [
        {
          kind: "rolling",
          durationMinutes: 300,
          remainingFraction: null,
          resetsAtMs: null,
        },
      ],
      isUsingOverage: null,
    });
  });
});

function createFakeCodexOracle(now: number): CodexQuotaOracle {
  return new CodexQuotaOracle({
    executable: fakeCodex,
    cwd: repositoryRoot,
    environment: {
      ...process.env,
      BRIGADIER_FAKE_EXPECTED_ARGV: JSON.stringify(appServerArgs),
      BRIGADIER_FAKE_EXPECTED_STDIN: "",
      BRIGADIER_FAKE_SCENARIO: "app-server",
    },
    now: () => now,
  });
}

async function readRateLimitEvent(fixture: string): Promise<JsonObject> {
  const contents = await Bun.file(resolve(fixtureDirectory, fixture)).text();
  for (const line of contents.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const event = asObject(JSON.parse(line));
    if (event.type === "rate_limit_event") {
      return event;
    }
  }
  throw new Error(`${fixture} has no rate_limit_event`);
}

async function readFixtureRecord(fixture: string): Promise<JsonObject> {
  const contents = await Bun.file(resolve(fixtureDirectory, fixture)).text();
  const line = contents.trim();
  return asObject(JSON.parse(line));
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value as JsonObject;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(pid: number): boolean {
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

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPid(oracle: CodexQuotaOracle): Promise<number> {
  while (oracle.pid === null) {
    await Bun.sleep(1);
  }
  return oracle.pid;
}

async function createUnhealthyAppServer(
  behavior: "malformed" | "silent",
): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "brigadier-quota-"));
  temporaryDirectories.push(directory);
  const executable = resolve(directory, "codex");
  const response =
    behavior === "malformed" ? "printf '%s\\n' '{not-json'" : ":";
  await Bun.write(
    executable,
    `#!/bin/sh
IFS= read -r request
${response}
trap '' TERM
while :; do sleep 60; done
`,
  );
  await chmod(executable, 0o755);
  return executable;
}
