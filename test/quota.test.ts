import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { QuotaSnapshot, QuotaWindow } from "../src/contracts.ts";
import {
  ClaudeQuotaOracle,
  normalizeClaudeRateLimitEvent,
} from "../src/quota/claude.ts";
import {
  CodexQuotaOracle,
  normalizeCodexRateLimits,
} from "../src/quota/codex.ts";
import type { ClaudeQuotaWorkerEvent } from "../src/quota/contracts.ts";
import { containsToken, modelQuotaStatus } from "../src/quota/contracts.ts";

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
              scope: { kind: "account" },
              status: "available",
              durationMinutes: 300,
              remainingFraction: 0.88,
              resetsAtMs: 1_786_026_000_000,
            },
            {
              kind: "weekly",
              scope: { kind: "account" },
              status: "available",
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
      // `rateLimitReachedType: "primary"` names exactly one window, so only
      // that window is exhausted; the weekly window is untouched.
      expect(snapshot.windows).toEqual([
        {
          kind: "rolling",
          scope: { kind: "account" },
          status: "exhausted",
          durationMinutes: 300,
          remainingFraction: 0.13,
          resetsAtMs: 1_786_026_000_000,
        },
        {
          kind: "weekly",
          scope: { kind: "account" },
          status: "available",
          durationMinutes: 10_080,
          remainingFraction: 0.5800000000000001,
          resetsAtMs: 1_786_458_000_000,
        },
      ]);

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
      expect(notReached.windows.map((window) => window.status)).toEqual([
        "available",
        "available",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "emits only the general rateLimitsByLimitId bucket",
    async () => {
      const response = await readFixtureRecord("quota-codex-by-limit-id.jsonl");
      const snapshot = normalizeCodexRateLimits(
        asObject(response.result),
        1_800_000_000_000,
      );

      // The aggregate is repeated inside the map under `limitId: "codex"`; it
      // must be emitted once, as the account bucket, not twice. The opaque
      // `codex_bengalfox` bucket has no safe scope and is not emitted.
      expect(snapshot).toEqual({
        vendor: "codex",
        status: "available",
        observedAtMs: 1_800_000_000_000,
        windows: [
          {
            kind: "weekly",
            scope: { kind: "account" },
            status: "available",
            durationMinutes: 10_080,
            remainingFraction: 0.28,
            resetsAtMs: 1_786_548_345_000,
          },
        ],
        isUsingOverage: null,
      } satisfies QuotaSnapshot);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "non-general buckets constrain no Codex model while the general bucket constrains all",
    async () => {
      const response = await readFixtureRecord("quota-codex-by-limit-id.jsonl");
      const result = asObject(response.result);
      const byLimitId = asObject(result.rateLimitsByLimitId);
      const codexModels = [
        "gpt-5.6-sol",
        "gpt-5.6-sol-wm",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex-spark",
        "codex-auto-review",
      ] as const;
      const nonGeneralDrained = normalizeCodexRateLimits(
        {
          ...result,
          rateLimitsByLimitId: {
            ...byLimitId,
            codex_bengalfox: {
              ...asObject(byLimitId.codex_bengalfox),
              primary: {
                usedPercent: 100,
                windowDurationMins: 10_080,
                resetsAt: 1_786_720_479,
              },
              rateLimitReachedType: "primary",
            },
          },
        },
        1_800_000_000_000,
      );

      expect(nonGeneralDrained).toEqual({
        vendor: "codex",
        status: "available",
        observedAtMs: 1_800_000_000_000,
        windows: [
          {
            kind: "weekly",
            scope: { kind: "account" },
            status: "available",
            durationMinutes: 10_080,
            remainingFraction: 0.28,
            resetsAtMs: 1_786_548_345_000,
          },
        ],
        isUsingOverage: null,
      } satisfies QuotaSnapshot);
      expect(
        codexModels.filter(
          (model) => modelQuotaStatus(nonGeneralDrained, model) === "available",
        ),
      ).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-sol-wm",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex-spark",
        "codex-auto-review",
      ]);

      const generalDrained = normalizeCodexRateLimits(
        {
          ...result,
          rateLimits: {
            ...asObject(result.rateLimits),
            primary: {
              usedPercent: 100,
              windowDurationMins: 10_080,
              resetsAt: 1_786_548_345,
            },
            rateLimitReachedType: "primary",
          },
        },
        1_800_000_000_000,
      );
      expect(generalDrained).toEqual({
        vendor: "codex",
        status: "exhausted",
        observedAtMs: 1_800_000_000_000,
        windows: [
          {
            kind: "weekly",
            scope: { kind: "account" },
            status: "exhausted",
            durationMinutes: 10_080,
            remainingFraction: 0,
            resetsAtMs: 1_786_548_345_000,
          },
        ],
        isUsingOverage: null,
      } satisfies QuotaSnapshot);
      expect(
        codexModels.filter(
          (model) => modelQuotaStatus(generalDrained, model) === "exhausted",
        ),
      ).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-sol-wm",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex-spark",
        "codex-auto-review",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * DEFECT 2. The adapter used to set `status: "exhausted"` from a bare
   * `rateLimitReachedType` while leaving `windows` EMPTY, which contradicts
   * `QuotaSnapshot.status`'s own contract and left the router able to answer
   * `ALL_VENDORS_EXHAUSTED` with nothing in the snapshot to explain it.
   */
  test("a bare rateLimitReachedType produces an account window, not a bare status", () => {
    expect(
      normalizeCodexRateLimits(
        { rateLimits: { rateLimitReachedType: "primary" } },
        123,
      ),
    ).toEqual({
      vendor: "codex",
      status: "exhausted",
      observedAtMs: 123,
      windows: [
        {
          // Every number is null because the vendor gave none. The refusal is
          // the only thing asserted, so it is the only thing recorded.
          kind: "unknown",
          scope: { kind: "account" },
          status: "exhausted",
          durationMinutes: null,
          remainingFraction: null,
          resetsAtMs: null,
        },
      ],
      isUsingOverage: null,
    } satisfies QuotaSnapshot);

    // The same refusal reported at the top level, with no `rateLimits` object to
    // hang it on, must survive the same way.
    expect(
      normalizeCodexRateLimits({ rateLimitReachedType: "primary" }, 123)
        .windows,
    ).toEqual([
      {
        kind: "unknown",
        scope: { kind: "account" },
        status: "exhausted",
        durationMinutes: null,
        remainingFraction: null,
        resetsAtMs: null,
      },
    ] satisfies QuotaWindow[]);

    // The control: no refusal, no invented window and no invented status.
    expect(
      normalizeCodexRateLimits(
        { rateLimits: { rateLimitReachedType: null } },
        123,
      ),
    ).toEqual({
      vendor: "codex",
      status: "unknown",
      observedAtMs: 123,
      windows: [],
      isUsingOverage: null,
    } satisfies QuotaSnapshot);
  });

  /**
   * DEFECT 3. `normalizeWindow` used to drop an empty or absent window before it
   * ever looked at `rateLimitReachedType`, so a bucket that positively refused
   * while omitting its numbers vanished entirely. Missing numbers mean unknown
   * numbers, never absent evidence.
   */
  test("a partial bucket that reports a reached limit keeps its exhaustion", () => {
    const account = normalizeCodexRateLimits(
      {
        rateLimitsByLimitId: {
          codex: { primary: null, rateLimitReachedType: "primary" },
        },
      },
      123,
    );
    expect(account.status).toBe("exhausted");
    expect(account.windows).toEqual([
      {
        kind: "unknown",
        scope: { kind: "account" },
        status: "exhausted",
        durationMinutes: null,
        remainingFraction: null,
        resetsAtMs: null,
      },
    ] satisfies QuotaWindow[]);
    expect(modelQuotaStatus(account, "gpt-5.6-sol")).toBe("exhausted");

    // A refusal naming a window the bucket does not carry at all is still a
    // refusal, and so is one naming a window key this build has never seen.
    expect(
      normalizeCodexRateLimits(
        { rateLimits: { rateLimitReachedType: "secondary" } },
        123,
      ).windows,
    ).toEqual([
      {
        // `secondary` is Codex's weekly allowance by the shape of the payload,
        // which is knowable from the key alone.
        kind: "weekly",
        scope: { kind: "account" },
        status: "exhausted",
        durationMinutes: null,
        remainingFraction: null,
        resetsAtMs: null,
      },
    ] satisfies QuotaWindow[]);
    expect(
      normalizeCodexRateLimits(
        {
          rateLimits: {
            rateLimitReachedType: "a_type_that_does_not_exist_yet",
          },
        },
        123,
      ).windows,
    ).toEqual([
      {
        kind: "unknown",
        scope: { kind: "account" },
        status: "exhausted",
        durationMinutes: null,
        remainingFraction: null,
        resetsAtMs: null,
      },
    ] satisfies QuotaWindow[]);
  });

  test(
    "a malformed record permanently fails later snapshots instead of hanging",
    async () => {
      const executable = await createUnhealthyAppServer("malformed");
      // The request timer is deliberately far out of reach rather than tuned.
      // This test is about the *reader* failing the oracle permanently, and a
      // 300 ms request timeout raced the shell app-server's spawn-and-print
      // under full-suite load: when the timer won, the rejection said "timed
      // out" instead of "invalid JSON" and the test flaked. Disarming the
      // competing timer does not weaken the proof, because hanging is still
      // caught — by `within` below, whose deadline is the only thing standing
      // between this test and an infinite wait.
      const oracle = new CodexQuotaOracle({
        executable,
        requestTimeoutMs: 30_000,
      });
      try {
        await expect(
          within(oracle.snapshot(), OPERATION_TIMEOUT_MS, "malformed snapshot"),
        ).rejects.toThrow("invalid JSON");
        await expect(
          within(
            oracle.snapshot(),
            OPERATION_TIMEOUT_MS,
            "snapshot after reader death",
          ),
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
            scope: { kind: "account" },
            status: fixtureCase.expectedStatus,
            durationMinutes: 300,
            remainingFraction: null,
            resetsAtMs: 1_786_026_000_000,
          },
        ]);
        expect(normalized.isUsingOverage).toBeFalse();

        const oracle = new ClaudeQuotaOracle({ now: () => 1_786_000_000_000 });
        oracle.ingest({ type: "quota", snapshot: normalized, raw });
        expect(await oracle.snapshot()).toEqual(normalized);
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
          scope: { kind: "account" },
          status: "unknown",
          durationMinutes: 300,
          remainingFraction: null,
          resetsAtMs: null,
        },
      ],
      isUsingOverage: null,
    });
  });

  test("maps every rate-limit type the 2.1.224 binary can emit", () => {
    const shapes = [
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "seven_day_overage_included",
      "overage",
      "a_type_that_does_not_exist_yet",
    ].map((rateLimitType) => {
      const snapshot = normalizeClaudeRateLimitEvent(
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType,
            resetsAt: 1_786_026_000,
          },
        },
        123,
      );
      if (snapshot === null) {
        throw new Error(`${rateLimitType} did not normalize`);
      }
      return [rateLimitType, snapshot.windows[0]] as const;
    });

    expect(Object.fromEntries(shapes)).toEqual({
      five_hour: window("rolling", { kind: "account" }, 300),
      seven_day: window("weekly", { kind: "account" }, 10_080),
      seven_day_opus: window(
        "weekly",
        { kind: "model", label: "opus" },
        10_080,
      ),
      seven_day_sonnet: window(
        "weekly",
        { kind: "model", label: "sonnet" },
        10_080,
      ),
      // Account-scoped: both are populated from the same unified header family
      // as five_hour and seven_day, which carries no model dimension.
      seven_day_overage_included: window("weekly", { kind: "account" }, 10_080),
      // No published window length for the purchased-credit pool, so none is
      // invented.
      overage: window("unknown", { kind: "account" }, null),
      // An unparseable token yields no tier label, so account scope is the only
      // safe reading.
      a_type_that_does_not_exist_yet: window(
        "unknown",
        { kind: "account" },
        null,
      ),
    });
  });

  test("preserves utilization as a remaining fraction", async () => {
    const raw = await readRateLimitEvent("quota-claude-session-warning.jsonl");
    const normalized = normalizeClaudeRateLimitEvent(raw, 123_456);

    // `utilization` is a fraction in [0, 1] on the wire, verified against the
    // 2.1.224 binary's own warning thresholds (0.9, 0.75, 0.5, 0.25).
    expect(normalized).toEqual({
      vendor: "claude",
      status: "warning",
      observedAtMs: 123_456,
      windows: [
        {
          kind: "rolling",
          scope: { kind: "account" },
          status: "warning",
          durationMinutes: 300,
          remainingFraction: 0.18000000000000005,
          resetsAtMs: 1_786_026_000_000,
        },
      ],
      isUsingOverage: false,
    } satisfies QuotaSnapshot);
  });

  test("an Opus-only limit does not report the whole account exhausted", async () => {
    const raw = await readRateLimitEvent("quota-claude-opus-limit.jsonl");
    const normalized = normalizeClaudeRateLimitEvent(raw, 123_456);

    // The window itself is exhausted; the snapshot is not, because the event
    // carries no account-scoped window and therefore says nothing about the
    // account. Before per-model quota metering this same event reported
    // `exhausted` vendor-wide.
    expect(normalized).toEqual({
      vendor: "claude",
      status: "unknown",
      observedAtMs: 123_456,
      windows: [
        {
          kind: "weekly",
          scope: { kind: "model", label: "opus" },
          status: "exhausted",
          durationMinutes: 10_080,
          remainingFraction: 0,
          resetsAtMs: 1_786_458_000_000,
        },
      ],
      isUsingOverage: false,
    } satisfies QuotaSnapshot);
  });

  test("accumulates independent buckets instead of overwriting them", async () => {
    const opusRaw = await readRateLimitEvent("quota-claude-opus-limit.jsonl");
    const sessionRaw = await readRateLimitEvent(
      "quota-claude-session-warning.jsonl",
    );
    const opus = requireSnapshot(normalizeClaudeRateLimitEvent(opusRaw, 1_000));
    const session = requireSnapshot(
      normalizeClaudeRateLimitEvent(sessionRaw, 2_000),
    );

    const oracle = new ClaudeQuotaOracle({ now: () => 1_786_000_000_000 });
    // The account-scoped event arrives *after* the model-scoped one. Under the
    // old one-slot oracle it erased the Opus exhaustion outright.
    oracle.ingest({ type: "quota", snapshot: opus, raw: opusRaw });
    oracle.ingest({ type: "quota", snapshot: session, raw: sessionRaw });
    const snapshot = await oracle.snapshot();
    await oracle.dispose();

    expect(snapshot).toEqual({
      vendor: "claude",
      status: "warning",
      observedAtMs: 2_000,
      windows: [
        {
          kind: "weekly",
          scope: { kind: "model", label: "opus" },
          status: "exhausted",
          durationMinutes: 10_080,
          remainingFraction: 0,
          resetsAtMs: 1_786_458_000_000,
        },
        {
          kind: "rolling",
          scope: { kind: "account" },
          status: "warning",
          durationMinutes: 300,
          remainingFraction: 0.18000000000000005,
          resetsAtMs: 1_786_026_000_000,
        },
      ],
      isUsingOverage: false,
    } satisfies QuotaSnapshot);

    expect(modelQuotaStatus(snapshot, "claude-opus-4-6")).toBe("exhausted");
    expect(modelQuotaStatus(snapshot, "claude-sonnet-5")).toBe("warning");
    expect(modelQuotaStatus(snapshot, "claude-haiku-4-5")).toBe("warning");
  });

  /**
   * DEFECT 1. `bucketKey` used to key on the NORMALIZED `(kind, scope)` pair,
   * but `ACCOUNT_WINDOW_SHAPES` maps both `seven_day` and
   * `seven_day_overage_included` to weekly/account, so the two independent
   * buckets collided. The later, healthier one erased the exhausted one outright
   * — the exact overwrite that per-model quota metering removed for
   * model-scoped buckets, left in place for two account-scoped ones.
   */
  test("keeps two account-scoped weekly buckets apart by their wire type", async () => {
    const sevenDay = claudeEvent("seven_day", "rejected", 1, 1_000);
    const overageIncluded = claudeEvent(
      "seven_day_overage_included",
      "allowed",
      0.1,
      2_000,
    );

    const oracle = new ClaudeQuotaOracle({ now: () => 1_786_000_000_000 });
    // The healthy bucket is observed strictly later. Under a shape key it won
    // the slot and the exhausted seven-day bucket disappeared.
    oracle.ingest(sevenDay);
    oracle.ingest(overageIncluded);
    const snapshot = await oracle.snapshot();
    await oracle.dispose();

    expect(snapshot).toEqual({
      vendor: "claude",
      status: "exhausted",
      observedAtMs: 2_000,
      windows: [
        {
          kind: "weekly",
          scope: { kind: "account" },
          status: "exhausted",
          durationMinutes: 10_080,
          remainingFraction: 0,
          resetsAtMs: 1_786_458_000_000,
        },
        {
          kind: "weekly",
          scope: { kind: "account" },
          status: "available",
          durationMinutes: 10_080,
          remainingFraction: 0.9,
          resetsAtMs: 1_786_458_000_000,
        },
      ],
      isUsingOverage: false,
    } satisfies QuotaSnapshot);

    // Re-observing one bucket updates that bucket and only that bucket, and
    // does not append a third window.
    const refreshed = new ClaudeQuotaOracle({ now: () => 1_786_000_000_000 });
    refreshed.ingest(sevenDay);
    refreshed.ingest(overageIncluded);
    refreshed.ingest(claudeEvent("seven_day", "allowed_warning", 0.8, 3_000));
    const second = await refreshed.snapshot();
    await refreshed.dispose();
    expect(second.windows.map((entry) => entry.status)).toEqual([
      "warning",
      "available",
    ]);
    expect(second.status).toBe("warning");
  });

  test("keeps the newest observation per bucket and settles ties by caution", async () => {
    const raw = await readRateLimitEvent("quota-claude-session-warning.jsonl");
    const warning = requireSnapshot(normalizeClaudeRateLimitEvent(raw, 2_000));
    const staleRejection = requireSnapshot(
      normalizeClaudeRateLimitEvent(
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt: 1_786_026_000,
            isUsingOverage: false,
          },
        },
        1_000,
      ),
    );

    const oracle = new ClaudeQuotaOracle({ now: () => 1_786_000_000_000 });
    oracle.ingest({ type: "quota", snapshot: warning, raw });
    // Strictly older: it must not win, however cautious it is.
    oracle.ingest({ type: "quota", snapshot: staleRejection, raw });
    expect((await oracle.snapshot()).status).toBe("warning");

    // Same instant, disagreeing: caution wins, whatever the arrival order.
    const sameInstantRejection = requireSnapshot(
      normalizeClaudeRateLimitEvent(
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt: 1_786_026_000,
            isUsingOverage: false,
          },
        },
        2_000,
      ),
    );
    oracle.ingest({ type: "quota", snapshot: sameInstantRejection, raw });
    expect((await oracle.snapshot()).status).toBe("exhausted");
    await oracle.dispose();
  });

  test("drops a window the vendor has already declared reset", async () => {
    const raw = await readRateLimitEvent("claude-rate-limit-rejected.jsonl");
    const rejected = requireSnapshot(normalizeClaudeRateLimitEvent(raw, 1_000));
    const resetsAtMs = 1_786_026_000_000;

    const before = new ClaudeQuotaOracle({ now: () => resetsAtMs - 1 });
    before.ingest({ type: "quota", snapshot: rejected, raw });
    const held = await before.snapshot();
    await before.dispose();
    expect(held.status).toBe("exhausted");
    expect(held.windows).toHaveLength(1);

    // At the reset instant itself the window is already fresh, so it is dropped.
    const after = new ClaudeQuotaOracle({ now: () => resetsAtMs });
    after.ingest({ type: "quota", snapshot: rejected, raw });
    const aged = await after.snapshot();
    await after.dispose();
    expect(aged.status).toBe("unknown");
    expect(aged.windows).toEqual([]);
  });
});

/**
 * `containsToken` is exported from `src/quota/contracts.ts` for these tests and
 * is absent from `src/quota/index.ts`, so it is not package API. The export is
 * the point: its termination property has to be provable WITHOUT going through
 * `constrains`, because relying on `constrains` to keep it out of an infinite
 * loop is the defect being fixed.
 */
describe("containsToken", () => {
  /**
   * A stand-in for a model id that counts `indexOf` calls and refuses to serve
   * more than `budget` of them.
   *
   * This exists so the termination test FAILS rather than HANGS when the guard
   * inside `containsToken` is removed. A hanging test is worse than no test: it
   * never reports, it wedges the whole suite, and `bun test`'s timeout cannot
   * preempt a synchronous loop. `indexOf` is the one call the scan makes per
   * iteration, so capping it converts an unbounded loop into a thrown Error on
   * iteration `budget + 1` — the bound is the assertion.
   */
  function boundedId(text: string, budget: number) {
    let indexOfCalls = 0;
    const probe = {
      indexOf(search: string, from?: number): number {
        indexOfCalls += 1;
        if (indexOfCalls > budget) {
          throw new Error(
            `containsToken called indexOf ${indexOfCalls} times on a ${text.length}-character id: its scan does not terminate`,
          );
        }
        return text.indexOf(search, from);
      },
      charAt(index: number): string {
        return text.charAt(index);
      },
      get length(): number {
        return text.length;
      },
    };
    return { id: probe as unknown as string, indexOfCalls: () => indexOfCalls };
  }

  /**
   * DEFECT, termination half. `String.prototype.indexOf("")` clamps to the
   * string's length instead of returning `-1`, so the scan parked on the final
   * index and spun forever. A hang is this tool's worst failure mode — it
   * supervises subprocesses, so the router looping means a wedged run with no
   * stack trace at all.
   */
  test("an empty label matches nothing and terminates without scanning", () => {
    // Bounded assertion FIRST, deliberately. Remove the guard and this throws
    // on the 65th `indexOf`, failing the test before control reaches the
    // unbounded calls below — one of which spins forever on the broken code.
    const probe = boundedId("gpt-5.6-sol", 64);
    expect({
      matched: containsToken(probe.id, ""),
      indexOfCalls: probe.indexOfCalls(),
    }).toEqual({ matched: false, indexOfCalls: 0 });

    // Real strings, including the shapes where the broken loop terminated early
    // with the WRONG answer: an empty needle lands on a boundary whenever two
    // delimiters sit adjacent or the id ends in one. Only the first of these
    // hangs on the broken code; the other three returned `true`.
    expect(containsToken("gpt-5.6-sol", "")).toBe(false);
    expect(containsToken("", "")).toBe(false);
    expect(containsToken("gpt--sol", "")).toBe(false);
    expect(containsToken("gpt-", "")).toBe(false);
  });

  test("a non-empty label matches only at token boundaries", () => {
    expect({
      sol: containsToken("gpt-5.6-sol", "sol"),
      opus: containsToken("claude-opus-4-6", "opus"),
      opusx: containsToken("claude-opusx-4-6", "opus"),
      // Deliberately `true`. `containsToken` is a boundary matcher and nothing
      // more; refusing a label that names no tier is `constrains`' job, pinned
      // in the `modelQuotaStatus` suite below. Keeping the layers honest here
      // means the numeric-label mutation can only be caught by the real guard.
      bareDigit: containsToken("gpt-5.6-sol", "5"),
    }).toEqual({ sol: true, opus: true, opusx: false, bareDigit: true });
  });
});

describe("modelQuotaStatus", () => {
  const accountWindow = (status: QuotaWindow["status"]): QuotaWindow => ({
    kind: "rolling",
    scope: { kind: "account" },
    status,
    durationMinutes: 300,
    remainingFraction: null,
    resetsAtMs: null,
  });
  const modelWindow = (
    label: string,
    status: QuotaWindow["status"],
  ): QuotaWindow => ({
    kind: "weekly",
    scope: { kind: "model", label },
    status,
    durationMinutes: 10_080,
    remainingFraction: null,
    resetsAtMs: null,
  });
  const snapshotOf = (windows: readonly QuotaWindow[]): QuotaSnapshot => ({
    vendor: "claude",
    status: "unknown",
    observedAtMs: 1_000,
    windows,
    isUsingOverage: null,
  });

  test("an exhausted account window exhausts every model", () => {
    const snapshot = snapshotOf([
      accountWindow("exhausted"),
      modelWindow("opus", "available"),
    ]);

    expect(modelQuotaStatus(snapshot, "claude-opus-4-6")).toBe("exhausted");
    expect(modelQuotaStatus(snapshot, "claude-sonnet-5")).toBe("exhausted");
    expect(modelQuotaStatus(snapshot, "claude-haiku-4-5")).toBe("exhausted");
    expect(modelQuotaStatus(snapshot, "gpt-5.6-terra")).toBe("exhausted");
  });

  test("an exhausted model window exhausts only its own tier", () => {
    const snapshot = snapshotOf([
      accountWindow("available"),
      modelWindow("opus", "exhausted"),
    ]);

    expect(modelQuotaStatus(snapshot, "claude-opus-4-6")).toBe("exhausted");
    expect(modelQuotaStatus(snapshot, "CLAUDE-OPUS-4-6")).toBe("exhausted");
    expect(modelQuotaStatus(snapshot, "claude-sonnet-5")).toBe("available");
    expect(modelQuotaStatus(snapshot, "claude-haiku-4-5")).toBe("available");
  });

  /**
   * DEFECT 4, matching half. A label is the only part of a `QuotaWindow` an
   * adapter derives from data it does not control, and a match removes a model
   * from routing, so the match must be narrow. A bare substring test was not.
   */
  test("a label matches only at token boundaries", () => {
    const snapshot = snapshotOf([modelWindow("opus", "exhausted")]);

    expect(modelQuotaStatus(snapshot, "claude-opus-4-6")).toBe("exhausted");
    // Delimited by the ends of the id rather than by punctuation.
    expect(modelQuotaStatus(snapshot, "opus")).toBe("exhausted");
    expect(modelQuotaStatus(snapshot, "claude-opus")).toBe("exhausted");
    // Mid-token occurrences are not the tier: a model whose name merely
    // contains the letters is a different model.
    expect(modelQuotaStatus(snapshot, "claude-opusx-4-6")).toBe("unknown");
    expect(modelQuotaStatus(snapshot, "claude-superopus-4-6")).toBe("unknown");

    // A label with its own punctuation still has to land on boundaries.
    const versioned = snapshotOf([modelWindow("5.3-codex", "exhausted")]);
    expect(modelQuotaStatus(versioned, "gpt-5.3-codex-spark")).toBe(
      "exhausted",
    );
    expect(modelQuotaStatus(versioned, "gpt-5.3-codexx")).toBe("unknown");

    // Every occurrence is examined, not just the first: the mid-token hit at
    // index 0 must not stop the search before the bounded hit later on.
    const repeated = snapshotOf([modelWindow("opus", "exhausted")]);
    expect(modelQuotaStatus(repeated, "opusx-claude-opus-4-6")).toBe(
      "exhausted",
    );
  });

  test("a bare vendor-family label constrains nothing", () => {
    for (const familyWord of [
      "gpt",
      "GPT",
      "codex",
      "claude",
      "openai",
      "anthropic",
      "  gpt  ",
    ]) {
      const snapshot = snapshotOf([
        accountWindow("available"),
        modelWindow(familyWord, "exhausted"),
      ]);
      // Before the fix, a single bucket labelled with any of these reported the
      // whole family dead.
      expect(modelQuotaStatus(snapshot, "gpt-5.6-sol")).toBe("available");
      expect(modelQuotaStatus(snapshot, "gpt-5.6-terra")).toBe("available");
      expect(modelQuotaStatus(snapshot, "claude-opus-4-6")).toBe("available");
    }
  });

  test("a label matching nothing constrains no model", () => {
    const snapshot = snapshotOf([
      accountWindow("available"),
      modelWindow("bengalfox", "exhausted"),
    ]);

    expect(modelQuotaStatus(snapshot, "claude-opus-4-6")).toBe("available");
    expect(modelQuotaStatus(snapshot, "gpt-5.6-sol")).toBe("available");
  });

  test("an empty label is ignored rather than matching every model", () => {
    const snapshot = snapshotOf([modelWindow("", "exhausted")]);

    expect(modelQuotaStatus(snapshot, "claude-opus-4-6")).toBe("unknown");
    expect(modelQuotaStatus(snapshot, "gpt-5.6-sol")).toBe("unknown");
  });

  /**
   * DEFECT, numeric-label half. `.` and `-` are both delimiters, so
   * `gpt-5.6-sol` tokenizes as `gpt`/`5`/`6`/`sol` and a label of `"5"` claimed
   * it at a genuine token boundary. Labels arrive off the wire unreviewed and a
   * match REMOVES a model from routing, so one bucket keyed by version would
   * have reported a whole generation dead — a bogus `ALL_VENDORS_EXHAUSTED`
   * with every quota actually fine. Latent, not live: real Codex `limitId`s are
   * opaque codenames.
   */
  test("a label with no alphabetic character constrains nothing", () => {
    for (const noLetters of ["5", "6", "4-6", "5.6", "2026", "  5  ", "4_6"]) {
      const snapshot = snapshotOf([
        accountWindow("available"),
        modelWindow(noLetters, "exhausted"),
      ]);

      expect({
        label: noLetters,
        sol: modelQuotaStatus(snapshot, "gpt-5.6-sol"),
        spark: modelQuotaStatus(snapshot, "gpt-5.3-codex-spark"),
        opus: modelQuotaStatus(snapshot, "claude-opus-4-6"),
        haiku: modelQuotaStatus(snapshot, "claude-haiku-4-6"),
        sonnet: modelQuotaStatus(snapshot, "claude-sonnet-5"),
      }).toEqual({
        label: noLetters,
        sol: "available",
        spark: "available",
        opus: "available",
        haiku: "available",
        sonnet: "available",
      });
    }
  });

  /**
   * The other side of that rule, so the refusal cannot quietly grow into "any
   * label containing a digit". Real tiers carry digits — `gpt-4o` proves it —
   * so only a label with no alphabetic identity AT ALL is refused.
   */
  test("a digit-bearing label that still names a tier keeps constraining", () => {
    const fourO = snapshotOf([
      accountWindow("available"),
      modelWindow("4o", "exhausted"),
    ]);
    expect({
      fourO: modelQuotaStatus(fourO, "gpt-4o"),
      mini: modelQuotaStatus(fourO, "gpt-4o-mini"),
      sol: modelQuotaStatus(fourO, "gpt-5.6-sol"),
    }).toEqual({ fourO: "exhausted", mini: "exhausted", sol: "available" });

    const versioned = snapshotOf([
      accountWindow("available"),
      modelWindow("opus-4-6", "exhausted"),
    ]);
    expect({
      opus: modelQuotaStatus(versioned, "claude-opus-4-6"),
      haiku: modelQuotaStatus(versioned, "claude-haiku-4-6"),
    }).toEqual({ opus: "exhausted", haiku: "available" });
  });

  /** Pinned: neither guard may move these. */
  test("a model-scoped window still claims its own tier and only its own", () => {
    const snapshot = snapshotOf([modelWindow("opus", "exhausted")]);

    expect({
      opus: modelQuotaStatus(snapshot, "claude-opus-4-6"),
      sonnet: modelQuotaStatus(snapshot, "claude-sonnet-5"),
    }).toEqual({ opus: "exhausted", sonnet: "unknown" });
  });

  test("the most cautious applicable window wins", () => {
    expect(
      modelQuotaStatus(
        snapshotOf([
          accountWindow("warning"),
          modelWindow("opus", "available"),
        ]),
        "claude-opus-4-6",
      ),
    ).toBe("warning");
    expect(
      modelQuotaStatus(
        snapshotOf([
          accountWindow("available"),
          modelWindow("opus", "warning"),
        ]),
        "claude-opus-4-6",
      ),
    ).toBe("warning");
    expect(
      modelQuotaStatus(
        snapshotOf([
          accountWindow("unknown"),
          modelWindow("opus", "available"),
        ]),
        "claude-opus-4-6",
      ),
    ).toBe("unknown");
  });

  test("a snapshot with no applicable window is unknown, not available", () => {
    expect(modelQuotaStatus(snapshotOf([]), "claude-opus-4-6")).toBe("unknown");
    expect(
      modelQuotaStatus(
        snapshotOf([modelWindow("opus", "exhausted")]),
        "claude-sonnet-5",
      ),
    ).toBe("unknown");
  });
});

function window(
  kind: QuotaWindow["kind"],
  scope: QuotaWindow["scope"],
  durationMinutes: number | null,
): QuotaWindow {
  return {
    kind,
    scope,
    status: "available",
    durationMinutes,
    remainingFraction: null,
    resetsAtMs: 1_786_026_000_000,
  };
}

/**
 * One `rate_limit_event` for exactly one bucket, normalized and wrapped as the
 * WorkerEvent the oracle ingests. `raw` is carried through untouched because the
 * oracle reads the vendor's `rateLimitType` off it to identify the bucket.
 */
function claudeEvent(
  rateLimitType: string,
  status: string,
  utilization: number,
  observedAtMs: number,
): ClaudeQuotaWorkerEvent {
  const raw = {
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      rateLimitType,
      resetsAt: 1_786_458_000,
      utilization,
      isUsingOverage: false,
    },
  };
  return {
    type: "quota",
    snapshot: requireSnapshot(normalizeClaudeRateLimitEvent(raw, observedAtMs)),
    raw,
  };
}

function requireSnapshot(
  snapshot: (QuotaSnapshot & { readonly vendor: "claude" }) | null,
): QuotaSnapshot & { readonly vendor: "claude" } {
  if (snapshot === null) {
    throw new Error("expected a normalized Claude quota snapshot");
  }
  return snapshot;
}

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
