/**
 * The compact report shared by the terminal and the MCP transport, plus the
 * durable-record step that must precede either rendering.
 */

import { randomUUID } from "node:crypto";
import type { ConfigEnvironment } from "../config/store.js";
import { writeRunRecord } from "../run-record/index.js";
import type { RunReport, SliceResult } from "../supervisor/contracts.js";
import { createSecretRedactor } from "../worktree/engine.js";

export interface RunRecordDetailOptions {
  readonly environment: ConfigEnvironment;
  readonly repositoryPath: string;
  readonly linkedSecretPaths: readonly string[];
}

export interface QuietRunReportOptions {
  /** Null on a dry run, which deliberately has no durable run artifact. */
  readonly detailLine?: string | null;
  /** MCP's normal-level log; the CLI writes these lines as they happen. */
  readonly log?: readonly string[];
}

/**
 * Writes the durable artifact and returns the one terminal line that describes
 * the result. Record creation is deliberately best-effort: the work has
 * already landed by this point, so losing its secondary artifact must never
 * rewrite a successful run as a failure.
 */
export async function writeRunRecordDetail(
  report: RunReport,
  options: RunRecordDetailOptions,
): Promise<string | null> {
  if (report.dryRun) {
    return null;
  }

  let redactor: Awaited<ReturnType<typeof createSecretRedactor>>;
  try {
    // This rebuild sees only current file contents, so a value rotated away
    // mid-run is not covered. The session's cumulative inventory is stronger;
    // using it here needs a session-scoped redactor seam on the engine.
    // Never fall back to an identity redactor. If the inventory cannot be
    // built, preserving the report is less important than refusing to persist
    // it with secrets exposed.
    redactor = await createSecretRedactor({
      repositoryPath: options.repositoryPath,
      linkedSecretPaths: options.linkedSecretPaths,
    });
  } catch {
    return unavailableRunRecordDetail();
  }

  try {
    const path = await writeRunRecord(
      report,
      { runId: randomUUID(), environment: options.environment },
      redactor,
    );
    return `  full detail: ${path}`;
  } catch (error) {
    try {
      return `  full detail: unavailable (could not write run record: ${redactor(describe(error))})`;
    } catch {
      return unavailableRunRecordDetail();
    }
  }
}

function unavailableRunRecordDetail(): string {
  // Inventory construction can fail on a path that itself contains a secret.
  // The raw exception must not become the fallback when no redactor can prove
  // it safe. This fixed class-only sentence deliberately loses detail so a
  // future "more helpful" diagnostic cannot reopen the leak.
  return "  full detail: unavailable (RUN_RECORD_WRITE_FAILED: diagnostic detail omitted because linked-secret redaction is unavailable)";
}

/** The default report: one line per slice, with the gate outcome kept visible. */
export function renderQuietRunReport(
  report: RunReport,
  options: QuietRunReportOptions = {},
): string {
  const count = report.slices.length;
  const lines = [
    `${report.dryRun ? "dry run" : "run"} ${report.slug}: ${count} ${count === 1 ? "slice" : "slices"}, ${humanizeDuration(report.durationMs)} → ${report.integrationBranch ?? "(none)"}`,
  ];

  if (report.interrupted) {
    lines.push(
      report.cleanupFailures.length === 0
        ? "  interrupted: workers were cancelled and worktrees removed"
        : "  interrupted: cleanup did not finish; a worker may still be running and a worktree may still exist — see cleanup failures below",
    );
  }
  for (const failure of report.cleanupFailures) {
    lines.push(`  cleanup failure: ${failure}`);
  }

  const idWidth = Math.max(
    0,
    ...report.slices.map((slice) => slice.sliceId.length),
  );
  for (const slice of report.slices) {
    lines.push(
      `  ${slice.sliceId.padEnd(idWidth)}  ${describeQuietVerdict(report, slice)}  ${slice.ok ? slice.commit : "(none)"}  (${describeAnnotation(report, slice)})`,
    );
  }

  for (const issue of report.planIssues) {
    lines.push(`  plan issue ${issue.code}: ${issue.message}`);
  }
  if (report.failure !== null) {
    lines.push(
      `  run failed: ${report.failure.reason} — ${report.failure.message}`,
    );
  }
  for (const line of options.log ?? []) {
    lines.push(`  log: ${line}`);
  }
  if (options.detailLine !== undefined && options.detailLine !== null) {
    lines.push(options.detailLine);
  }
  return lines.join("\n");
}

export function humanizeDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return `${totalMinutes}m${seconds.toString().padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes.toString().padStart(2, "0")}m`;
}

function describeQuietVerdict(report: RunReport, slice: SliceResult): string {
  if (slice.ok) {
    return "ok";
  }
  if (slice.cancelled === true) {
    return slice.attempts.length === 0
      ? "cancelled (never started)"
      : "cancelled";
  }
  const kind = slice.attempts.at(-1)?.failure?.kind;
  if (kind !== undefined) {
    return `failed ${kind}`;
  }
  if (slice.attempts.length === 0) {
    return "failed (not attempted)";
  }
  return report.dryRun ? "would run" : "not run (the run stopped first)";
}

function describeAnnotation(report: RunReport, slice: SliceResult): string {
  const parts: string[] = [];
  const retries = Math.max(0, slice.attempts.length - 1);
  if (retries > 0) {
    parts.push(
      retries === 1
        ? "retried once"
        : retries === 2
          ? "retried twice"
          : `retried ${retries} times`,
    );
  }

  const attempt = slice.attempts.at(-1);
  if (attempt === undefined) {
    parts.push("not reviewed: no attempt");
    return parts.join(", ");
  }
  const review = attempt.review;
  if (review === null) {
    parts.push(
      report.dryRun && attempt.failure === null
        ? "not reviewed: dry run"
        : "not reviewed: gate not reached",
    );
    return parts.join(", ");
  }
  if (review.verdict === "skipped") {
    parts.push(`not reviewed: ${review.reason}`);
    return parts.join(", ");
  }
  parts.push(`${review.verdict} by ${review.reviewer.vendor}`);
  return parts.join(", ");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
