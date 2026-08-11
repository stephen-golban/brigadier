import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  humanizeDuration,
  renderQuietRunReport,
  writeRunRecordDetail,
} from "../src/report/render.ts";
import type {
  RunReport,
  SliceAttempt,
  SliceResult,
} from "../src/supervisor/contracts.ts";
import type { WorktreeSession } from "../src/worktree/contracts.ts";

const SESSION: WorktreeSession = {
  repositoryPath: "/repo",
  slug: "csv-export",
  baseCommit: "base",
  baseBranch: "brigadier/csv-export/base",
  integrationBranch: "brigadier/csv-export",
};

const ROUTED = {
  vendor: "claude",
  model: "claude-opus-5",
  effort: "high",
  rationale: ["fixture"],
  waivedDifficultyFloor: false,
} as const;

function successfulSlice(
  sliceId: string,
  commit: string,
  attempts: readonly SliceAttempt[],
): SliceResult {
  const branch = `brigadier/csv-export/${sliceId}`;
  return {
    sliceId,
    ok: true,
    branch,
    commit,
    worktree: {
      repositoryPath: SESSION.repositoryPath,
      path: `/worktrees/${sliceId}`,
      branch,
      isolated: true,
      session: SESSION,
    },
    attempts,
  };
}

function approvedAttempt(attempt: number, commit: string): SliceAttempt {
  return {
    attempt,
    routed: ROUTED,
    outcome: null,
    commit,
    failure: null,
    review: {
      verdict: "approved",
      reviewer: {
        vendor: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
      findings: [],
      durationMs: 5,
    },
    durationMs: 10,
  };
}

function baseReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    ok: true,
    slug: "csv-export",
    dryRun: false,
    interrupted: false,
    cleanupFailures: [],
    integrationBranch: "brigadier/csv-export",
    slices: [
      successfulSlice("writer", "8f3c9a2", [approvedAttempt(1, "8f3c9a2")]),
    ],
    merges: [],
    planIssues: [],
    failure: null,
    durationMs: 512_000,
    ...overrides,
  };
}

describe("the quiet run report", () => {
  test("humanizes seconds, minutes, and hours consistently", () => {
    expect(humanizeDuration(12_000)).toBe("12s");
    expect(humanizeDuration(512_000)).toBe("8m32s");
    expect(humanizeDuration(3_840_000)).toBe("1h04m");
  });

  test("keeps retries, skipped reviews, failures, cleanup, and plan issues visible", () => {
    const firstAttempt: SliceAttempt = {
      attempt: 1,
      routed: ROUTED,
      outcome: null,
      commit: null,
      failure: {
        kind: "NO_CHANGES",
        message: "the first worker changed nothing",
      },
      review: null,
      durationMs: 10,
    };
    const skippedAttempt: SliceAttempt = {
      ...approvedAttempt(1, "1b77e05"),
      review: {
        verdict: "skipped",
        reviewer: null,
        reason: "NO_OTHER_VENDOR",
        message: "no other vendor is configured",
        durationMs: 0,
      },
    };
    const failed: SliceResult = {
      sliceId: "publish",
      ok: false,
      branch: null,
      commit: null,
      worktree: null,
      attempts: [
        {
          attempt: 1,
          routed: ROUTED,
          outcome: null,
          commit: null,
          failure: {
            kind: "WORKER_FAILED",
            message: "the worker crashed",
            failure: {
              kind: "UNKNOWN_FAILURE",
              message: "crashed",
              retryable: false,
              statusCode: null,
            },
          },
          review: null,
          durationMs: 10,
        },
      ],
    };
    const report = baseReport({
      ok: false,
      interrupted: true,
      cleanupFailures: ["release csv-export: ref is busy"],
      slices: [
        successfulSlice("writer", "8f3c9a2", [
          firstAttempt,
          approvedAttempt(2, "8f3c9a2"),
        ]),
        successfulSlice("writer-tests", "1b77e05", [skippedAttempt]),
        failed,
      ],
      planIssues: [
        {
          code: "INVALID_PATH",
          message: "one path is invalid",
          sliceIds: ["publish"],
          paths: ["../outside"],
        },
      ],
      failure: {
        reason: "SLICE_FAILED",
        message: "publish did not complete",
      },
    });

    expect(
      renderQuietRunReport(report, {
        log: ["slice publish: failed WORKER_FAILED"],
        detailLine: "  full detail: /home/runs/csv-export-run-id.json",
      }),
    ).toBe(
      [
        "run csv-export: 3 slices, 8m32s → brigadier/csv-export",
        "  interrupted: cleanup did not finish; a worker may still be running and a worktree may still exist — see cleanup failures below",
        "  cleanup failure: release csv-export: ref is busy",
        "  writer        ok  8f3c9a2  (retried once, approved by codex)",
        "  writer-tests  ok  1b77e05  (not reviewed: NO_OTHER_VENDOR)",
        "  publish       failed WORKER_FAILED  (none)  (not reviewed: gate not reached)",
        "  plan issue INVALID_PATH: one path is invalid",
        "  run failed: SLICE_FAILED — publish did not complete",
        "  log: slice publish: failed WORKER_FAILED",
        "  full detail: /home/runs/csv-export-run-id.json",
      ].join("\n"),
    );
  });

  test("claims cleanup succeeded only when there are no cleanup failures", () => {
    expect(
      renderQuietRunReport(
        baseReport({ interrupted: true, cleanupFailures: [] }),
      ),
    ).toContain("  interrupted: workers were cancelled and worktrees removed");
  });
});

describe("the shared run-record step", () => {
  test("writes a real run through the inventory redactor with a valid generated id", async () => {
    const root = await mkdtemp(join(tmpdir(), "brigadier-report-"));
    const repositoryPath = join(root, "repo");
    const scratchHome = join(root, "home");
    const secret = "record-secret-a19d";
    await mkdir(repositoryPath);
    await mkdir(scratchHome);
    await writeFile(join(repositoryPath, ".env"), `TOKEN=${secret}\n`);
    try {
      const report = baseReport({
        ok: false,
        failure: {
          reason: "SLICE_FAILED",
          message: `do not persist ${secret}`,
        },
      });
      const detail = await writeRunRecordDetail(report, {
        environment: { BRIGADIER_HOME: scratchHome },
        repositoryPath,
        linkedSecretPaths: [".env"],
      });
      expect(detail).toMatch(/^ {2}full detail: .+\.json$/);
      const path = detail?.slice("  full detail: ".length) ?? "";
      const contents = await readFile(path, "utf8");
      expect(contents).not.toContain(secret);
      expect(contents).toContain("do not persist [REDACTED]");
      const record = JSON.parse(contents) as { readonly runId: string };
      expect(record.runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(Buffer.byteLength(record.runId)).toBeLessThanOrEqual(255);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not write a dry run", async () => {
    const root = await mkdtemp(join(tmpdir(), "brigadier-report-"));
    const repositoryPath = join(root, "repo");
    const scratchHome = join(root, "home");
    await mkdir(repositoryPath);
    await mkdir(scratchHome);
    try {
      expect(
        await writeRunRecordDetail(baseReport({ dryRun: true }), {
          environment: { BRIGADIER_HOME: scratchHome },
          repositoryPath,
          linkedSecretPaths: [],
        }),
      ).toBeNull();
      expect(await readdir(scratchHome)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("omits raw detail when the redaction inventory cannot be built", async () => {
    const root = await mkdtemp(join(tmpdir(), "brigadier-report-"));
    const repositoryPath = join(root, "repo");
    const scratchHome = join(root, "home");
    const secret = "sk_live_record_inventory_4mN8pR";
    const linkedSecretPath = `secrets/${secret}`;
    await mkdir(join(repositoryPath, "secrets"), { recursive: true });
    await mkdir(scratchHome);
    await symlink(secret, join(repositoryPath, linkedSecretPath));
    try {
      const unavailable = await writeRunRecordDetail(baseReport(), {
        environment: { BRIGADIER_HOME: scratchHome },
        repositoryPath,
        linkedSecretPaths: [linkedSecretPath],
      });
      expect(unavailable).toBe(
        "  full detail: unavailable (RUN_RECORD_WRITE_FAILED: diagnostic detail omitted because linked-secret redaction is unavailable)",
      );
      expect(unavailable).not.toContain(secret);
      expect(await readdir(scratchHome)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
