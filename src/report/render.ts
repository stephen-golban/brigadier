/**
 * The compact report shared by the terminal and the MCP transport, plus the
 * durable-record step that must precede either rendering.
 */

import { randomUUID } from "node:crypto";
import { type ConfigEnvironment, nodeConfigIo } from "../config/store.js";
import type { WorkerOutputPersistence } from "../run-record/index.js";
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
  let workerOutput: WorkerOutputPersistence = "include";
  try {
    // THE TOKEN IS THIS RUN'S SESSION AND NOTHING ELSE IS. Asking by slug used
    // to match "some terminal session with this name", which in a long-lived
    // MCP server running the same plan twice can be the PREVIOUS run's leftover
    // registration — writing run B's worker output under run A's inventory and
    // skipping the elide below without saying so. A report that carries no
    // token names no session, so it takes the fail-closed branch.
    const sessionToken = report.sessionToken;
    if (sessionToken === undefined) {
      throw new Error("run report carries no worktree session token");
    }
    redactor = await createSecretRedactor({
      repositoryPath: options.repositoryPath,
      linkedSecretPaths: options.linkedSecretPaths,
      sessionToken,
    });
  } catch {
    // A failure before `prepare()` has no session inventory and no worker
    // output. Its already-scrubbed diagnostic can still use the tokenless
    // redactor, which reads the current linked files and unions in any live
    // session over this repository. That union is still NOT an equivalent
    // fallback once a worker ran: reaching this branch means THIS run's
    // inventory was not reachable, and a value it saw rotate away may sit in
    // worker output, in the worker's own stderr-bearing failure message, or in
    // a reviewer's findings with nothing left on disk or in another session to
    // match it against.
    try {
      redactor = await createSecretRedactor({
        repositoryPath: options.repositoryPath,
        linkedSecretPaths: options.linkedSecretPaths,
      });
      if (hasWorkerDerivedText(report)) {
        workerOutput = "elide";
      }
    } catch {
      return unavailableRunRecordDetail();
    }
  }

  try {
    const path = await writeRunRecord(
      report,
      { runId: randomUUID(), environment: options.environment },
      redactor,
      nodeConfigIo,
      workerOutput,
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

/**
 * Whether anything a subprocess produced could be sitting in this report.
 *
 * IT ASKS ABOUT THREE FIELDS, NOT ONE. A worker's stderr — up to 64 KiB of it —
 * is normalized into `WorkerFailure.message` and interpolated again into
 * `SliceAttempt.failure.message`, and a reviewer's prose lands in
 * `SliceReview`. An attempt can carry any of those with `outcome` still null,
 * so a test for `outcome` alone let two of the three routes through.
 */
function hasWorkerDerivedText(report: RunReport): boolean {
  return report.slices.some((slice) =>
    slice.attempts.some(
      (attempt) =>
        attempt.outcome !== null ||
        attempt.failure !== null ||
        attempt.review !== null,
    ),
  );
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

  // DISCLOSED ON EVERY RUN THAT HAS ONE, not only on dry runs. This argv is a
  // process brigadier launches with the user's own permissions, from a file the
  // user passed to `--plan` — and, in the documented agent-driven workflow,
  // from a file an agent wrote and an agent named. A capability that executes
  // has to be legible in the output of the run that executed it; printing it
  // only in the preview meant the one run that actually spawned it said
  // nothing. A run with no command still says so on a dry run, where "what
  // would happen" is the whole question.
  const verifyLine = describeVerifyCommand(report);
  if (verifyLine !== null) {
    lines.push(verifyLine);
  }

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

/**
 * The verification argv this run will execute, or null when there is nothing
 * for the caller to disclose.
 *
 * JSON is used as an argv notation, not as a command builder. Rejoining the
 * elements with spaces would falsely suggest shell parsing and make arguments
 * containing whitespace impossible to distinguish in the preview.
 *
 * NULL AND "no verify command" ARE DIFFERENT ANSWERS. A dry run is asked what
 * would happen, so the absence of a command is itself the answer and gets a
 * line. A real run is asked what did happen; a line about a command nobody ran
 * is noise, and the caller drops it.
 */
export function describeVerifyCommand(report: RunReport): string | null {
  if (report.testCommand !== undefined) {
    return `  verify command: ${JSON.stringify(report.testCommand)}`;
  }
  return report.dryRun
    ? "  no verify command; the tests_pass gate will be skipped"
    : null;
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
  for (const gate of review.gates ?? []) {
    if (gate.status === "skipped") {
      parts.push(`${gate.name} skipped: ${gate.reason}`);
    }
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
