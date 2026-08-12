import { describe, expect, test } from "bun:test";
import type { ConfigIo } from "../src/config/store.ts";
import { writeRunRecord } from "../src/run-record/index.ts";
import type { RunReport } from "../src/supervisor/contracts.ts";

const SUCCESSFUL_REPORT: RunReport = {
  ok: true,
  slug: "demo",
  dryRun: false,
  interrupted: false,
  cleanupFailures: [],
  integrationBranch: "brigadier/demo",
  slices: [],
  merges: [],
  planIssues: [],
  failure: null,
  durationMs: 123,
};
const scratchHome = "/example/scratch";

describe("writeRunRecord", () => {
  test("writes the versioned record at its exact absolute path", async () => {
    const disk = new MemoryIo();

    const path = await writeRunRecord(
      SUCCESSFUL_REPORT,
      {
        runId: "20260811",
        environment: { BRIGADIER_HOME: scratchHome },
      },
      (artifact) => artifact,
      disk,
    );

    expect(path).toBe("/example/scratch/runs/demo-20260811.json");
    expect(disk.files.get(path)).toBe(
      `${JSON.stringify(
        {
          version: 1,
          runId: "20260811",
          report: SUCCESSFUL_REPORT,
        },
        null,
        2,
      )}\n`,
    );
  });

  test("writes a record for a slug containing dots at its exact absolute path", async () => {
    const disk = new MemoryIo();
    const report: RunReport = { ...SUCCESSFUL_REPORT, slug: "release.v1" };

    const path = await writeRunRecord(
      report,
      {
        runId: "20260811",
        environment: { BRIGADIER_HOME: scratchHome },
      },
      (artifact) => artifact,
      disk,
    );

    expect(path).toBe("/example/scratch/runs/release.v1-20260811.json");
  });

  test("redacts secrets from the fully serialized report before writing", async () => {
    const disk = new MemoryIo();
    const secret = "sk-run-record-secret";
    const report: RunReport = {
      ...SUCCESSFUL_REPORT,
      ok: false,
      failure: {
        reason: "PREPARE_FAILED",
        message: `prepare failed: ${secret}`,
      },
    };

    const path = await writeRunRecord(
      report,
      {
        runId: "redacted",
        environment: { BRIGADIER_HOME: scratchHome },
      },
      (artifact) => artifact.replaceAll(secret, "[REDACTED]"),
      disk,
    );

    const bytes = disk.files.get(path) ?? "";
    expect(bytes).not.toContain(secret);
    expect(bytes).toContain("[REDACTED]");
  });

  test("redacts verbatim secrets before JSON escaping", async () => {
    const disk = new MemoryIo();
    const secret = 'line1"quoted\\backslash\nline2';
    const report: RunReport = {
      ...SUCCESSFUL_REPORT,
      ok: false,
      failure: {
        reason: "PREPARE_FAILED",
        message: secret,
      },
    };

    const path = await writeRunRecord(
      report,
      {
        runId: "escaped-secret",
        environment: { BRIGADIER_HOME: scratchHome },
      },
      (artifact) => artifact.replaceAll(secret, "[REDACTED]"),
      disk,
    );

    const bytes = disk.files.get(path) ?? "";
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain(JSON.stringify(secret));
    expect(JSON.parse(bytes)).toEqual({
      version: 1,
      runId: "escaped-secret",
      report: {
        ...report,
        failure: {
          ...report.failure,
          message: "[REDACTED]",
        },
      },
    });
  });

  test("elides worker output when cumulative redaction is unavailable", async () => {
    const disk = new MemoryIo();
    const rotatedSecret = "rotated-worker-output-secret";
    const report: RunReport = {
      ...SUCCESSFUL_REPORT,
      slices: [
        {
          sliceId: "worker",
          ok: false,
          branch: null,
          commit: null,
          worktree: null,
          attempts: [
            {
              attempt: 1,
              routed: null,
              outcome: {
                ok: true,
                output: rotatedSecret,
                usage: {
                  input: {
                    total: 0,
                    uncached: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  output: { total: 0, reasoning: null },
                },
                durationMs: 1,
                exitCode: 0,
                signal: null,
              },
              commit: null,
              failure: { kind: "NO_CHANGES", message: "no changes" },
              review: null,
              durationMs: 1,
            },
          ],
        },
      ],
    };

    const path = await writeRunRecord(
      report,
      {
        runId: "elided-output",
        environment: { BRIGADIER_HOME: scratchHome },
      },
      (artifact) => artifact,
      disk,
      "elide",
    );

    const bytes = disk.files.get(path) ?? "";
    expect(bytes).not.toContain(rotatedSecret);
    expect(bytes).toContain(
      "[OMITTED: cumulative linked-secret redaction unavailable]",
    );
  });

  test("elides every worker-derived string, not only the output field", async () => {
    const disk = new MemoryIo();
    // One rotated value reaching the record by all four routes a worker's bytes
    // actually travel. `output` was the only one the first elide covered.
    const rotatedSecret = "rotated-worker-stderr-secret";
    const report: RunReport = {
      ...SUCCESSFUL_REPORT,
      ok: false,
      slices: [
        {
          sliceId: "worker",
          ok: false,
          branch: "brigadier/demo/slice-1",
          commit: null,
          worktree: null,
          attempts: [
            {
              attempt: 1,
              routed: null,
              outcome: {
                ok: false,
                output: `stdout ${rotatedSecret}`,
                usage: {
                  input: {
                    total: 0,
                    uncached: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  output: { total: 0, reasoning: null },
                },
                durationMs: 1,
                exitCode: 1,
                signal: null,
                failure: {
                  // Route 2: `WorkerFailure.message` is up to 64 KiB of the
                  // worker's own stderr, verbatim.
                  kind: "UNKNOWN_FAILURE",
                  message: `stderr ${rotatedSecret}`,
                  retryable: false,
                  statusCode: null,
                },
              },
              commit: null,
              failure: {
                kind: "WORKER_FAILED",
                // Route 3: the same stderr interpolated again by the runner.
                message: `slice worker attempt 1: claude/x failed with UNKNOWN_FAILURE: stderr ${rotatedSecret}`,
                failure: {
                  kind: "UNKNOWN_FAILURE",
                  message: `stderr ${rotatedSecret}`,
                  retryable: false,
                  statusCode: null,
                },
              },
              // Route 4: a reviewer is a worker too, and its prose quotes what
              // it was shown.
              review: {
                verdict: "rejected",
                reviewer: {
                  vendor: "codex",
                  model: "gpt-5.6-sol",
                  effort: "high",
                },
                findings: [
                  {
                    source: "model",
                    severity: "blocking",
                    path: "src/a.ts",
                    line: 3,
                    summary: `the diff hardcodes ${rotatedSecret}`,
                  },
                ],
                gates: [
                  {
                    name: "tests_pass",
                    severity: "blocking",
                    status: "failed",
                    findings: [
                      {
                        source: "gate",
                        gate: "tests_pass",
                        severity: "blocking",
                        path: null,
                        line: null,
                        summary: `verify failed: ${rotatedSecret}`,
                      },
                    ],
                  },
                ],
                durationMs: 2,
              },
              durationMs: 1,
            },
          ],
        },
      ],
    };

    const path = await writeRunRecord(
      report,
      {
        runId: "elided-structurally",
        environment: { BRIGADIER_HOME: scratchHome },
      },
      // Deliberately a no-op: the elide is what must remove the value, because
      // the fallback redactor is built from files the value is no longer in.
      (artifact) => artifact,
      disk,
      "elide",
    );

    const bytes = disk.files.get(path) ?? "";
    expect(bytes).not.toContain(rotatedSecret);
    expect(bytes).toContain(
      "[OMITTED: cumulative linked-secret redaction unavailable]",
    );

    // Well-formed and still readable: everything brigadier itself computed
    // survives, so the record is worth keeping.
    const record = JSON.parse(bytes) as { readonly report: RunReport };
    const attempt = record.report.slices[0]?.attempts[0];
    expect(attempt?.outcome?.ok).toBe(false);
    expect(attempt?.outcome?.exitCode).toBe(1);
    expect(attempt?.failure?.kind).toBe("WORKER_FAILED");
    expect(attempt?.review?.verdict).toBe("rejected");
  });

  test("leaves no partial record when the temporary write fails", async () => {
    const disk = new MemoryIo();
    disk.failWrite = new Error("disk full midway through write");

    await expect(
      writeRunRecord(
        SUCCESSFUL_REPORT,
        {
          runId: "interrupted",
          environment: { BRIGADIER_HOME: scratchHome },
        },
        (artifact) => artifact,
        disk,
      ),
    ).rejects.toThrow("disk full midway through write");

    expect(disk.files).toEqual(new Map());
  });

  test("redacts secrets from a write failure before reporting it", async () => {
    const disk = new MemoryIo();
    const secret = "https://user:password@example.test";
    disk.failWrite = new Error(`could not write to ${secret}`);

    let thrown: unknown;
    try {
      await writeRunRecord(
        SUCCESSFUL_REPORT,
        {
          runId: "redacted-write-error",
          environment: { BRIGADIER_HOME: scratchHome },
        },
        (artifact) => artifact.replaceAll(secret, "[REDACTED]"),
        disk,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("RunRecordWriteError");
    expect((thrown as Error).message).not.toContain(secret);
  });

  test("redacts an invalid run ID before reporting it", async () => {
    const disk = new MemoryIo();
    const secret = "token/with/slash";

    let thrown: unknown;
    try {
      await writeRunRecord(
        SUCCESSFUL_REPORT,
        {
          runId: secret,
          environment: { BRIGADIER_HOME: scratchHome },
        },
        (artifact) => artifact.replaceAll(secret, "[REDACTED]"),
        disk,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(secret);
  });

  test("redacts a secret spanning a directory write error", async () => {
    const disk = new MemoryIo();
    const secret = "runs: password";
    disk.failMkdir = new Error("password");

    let thrown: unknown;
    try {
      await writeRunRecord(
        SUCCESSFUL_REPORT,
        {
          runId: "blocked",
          environment: { BRIGADIER_HOME: scratchHome },
        },
        (artifact) => artifact.replaceAll(secret, "[REDACTED]"),
        disk,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(secret);
  });

  test("accepts the longest slug whose temporary filename fits", async () => {
    const disk = new MemoryIo();
    const runId = "20260811";
    const maximumSlugLength =
      255 -
      Buffer.byteLength(
        `.-${runId}.json.${process.pid.toString(36)}.${"x".repeat(8)}.tmp`,
      );
    const maximumSlug = `a${"b".repeat(maximumSlugLength - 1)}`;
    const oneByteLongerSlug = `${maximumSlug}b`;

    await expect(
      writeRunRecord(
        { ...SUCCESSFUL_REPORT, slug: maximumSlug },
        {
          runId,
          environment: { BRIGADIER_HOME: scratchHome },
        },
        (artifact) => artifact,
        disk,
      ),
    ).resolves.toBe(`${scratchHome}/runs/${maximumSlug}-${runId}.json`);

    await expect(
      writeRunRecord(
        { ...SUCCESSFUL_REPORT, slug: oneByteLongerSlug },
        {
          runId,
          environment: { BRIGADIER_HOME: scratchHome },
        },
        (artifact) => artifact,
        disk,
      ),
    ).rejects.toThrow("temporary filename exceeds 255-byte limit (256 bytes)");
  });

  test("reports an unwritable record directory with its path and cause", async () => {
    const disk = new MemoryIo();
    disk.failMkdir = new Error("permission denied");

    await expect(
      writeRunRecord(
        SUCCESSFUL_REPORT,
        {
          runId: "blocked",
          environment: { BRIGADIER_HOME: scratchHome },
        },
        (artifact) => artifact,
        disk,
      ),
    ).rejects.toThrow(
      "could not write run record at /example/scratch/runs: permission denied",
    );
  });

  test("honours $BRIGADIER_HOME over $HOME", async () => {
    const disk = new MemoryIo();

    const path = await writeRunRecord(
      SUCCESSFUL_REPORT,
      {
        runId: "explicit-home",
        environment: {
          BRIGADIER_HOME: scratchHome,
          HOME: "/ignored/home",
        },
      },
      (artifact) => artifact,
      disk,
    );

    expect(path).toBe("/example/scratch/runs/demo-explicit-home.json");
  });
});

class MemoryIo implements ConfigIo {
  readonly files = new Map<string, string>();
  failMkdir: Error | null = null;
  failWrite: Error | null = null;

  async mkdir(_path: string): Promise<void> {
    if (this.failMkdir !== null) {
      throw this.failMkdir;
    }
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`missing ${path}`);
    }
    return value;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    if (this.failWrite !== null) {
      this.files.set(path, contents.slice(0, 20));
      throw this.failWrite;
    }
    this.files.set(path, contents);
  }

  async rename(from: string, to: string): Promise<void> {
    const contents = this.files.get(from);
    if (contents === undefined) {
      throw new Error(`missing ${from}`);
    }
    this.files.set(to, contents);
    this.files.delete(from);
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
}
