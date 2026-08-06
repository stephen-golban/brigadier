import { describe, expect, test } from "bun:test";
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
      const pid = oracle.pid;
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
