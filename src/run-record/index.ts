/**
 * Persisting a completed run as a durable, versioned JSON artifact.
 */

import { basename, join } from "node:path";
import type { ConfigIo } from "../config/store.js";
import { nodeConfigIo, resolveConfigHome } from "../config/store.js";
import type { WorkerOutcome } from "../contracts.js";
import type {
  DeterministicGateResult,
  RunReport,
  SliceAttempt,
  SliceFailure,
  SliceReview,
} from "../supervisor/contracts.js";
import type { SecretRedactor } from "../worktree/engine.js";
import type { RunRecord, WriteRunRecordOptions } from "./contracts.js";
import { RUN_RECORD_DIRECTORY_NAME, RUN_RECORD_VERSION } from "./contracts.js";

const MAX_FILE_NAME_BYTES = 255;
const MAX_RANDOM_SUFFIX_BYTES = 8;
const OMITTED_WORKER_OUTPUT =
  "[OMITTED: cumulative linked-secret redaction unavailable]";

export type WorkerOutputPersistence = "include" | "elide";

export type { RunRecord, WriteRunRecordOptions } from "./contracts.js";
export {
  RUN_RECORD_DIRECTORY_NAME,
  RUN_RECORD_VERSION,
} from "./contracts.js";

/**
 * Writes one run report through a same-directory temporary file, so readers
 * observe either the preceding complete record or the replacement, never a
 * partial JSON document.
 */
export async function writeRunRecord(
  report: RunReport,
  options: WriteRunRecordOptions,
  /**
   * This is required because a caller must consciously choose the secrets
   * policy. Redact every string value at any depth in JSON.stringify's
   * replacer so future string report fields cannot bypass it by being omitted
   * from per-field redaction. This happens before JSON escaping; non-string
   * primitives and object keys are not covered, so callers must not place
   * secrets there.
   */
  redactor: SecretRedactor,
  io: ConfigIo = nodeConfigIo,
  workerOutput: WorkerOutputPersistence = "include",
): Promise<string> {
  const directory = join(
    resolveConfigHome(options.environment),
    RUN_RECORD_DIRECTORY_NAME,
  );
  const path = join(
    directory,
    recordFileName(report.slug, options.runId, redactor),
  );
  const record: RunRecord = {
    version: RUN_RECORD_VERSION,
    runId: options.runId,
    report: workerOutput === "include" ? report : elideWorkerOutput(report),
  };
  const contents = `${JSON.stringify(
    record,
    (_key, value) => (typeof value === "string" ? redactor(value) : value),
    2,
  )}\n`;

  await createDirectory(io, directory, redactor);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid.toString(36)}.${randomSuffix()}.tmp`,
  );
  try {
    await io.writeFile(temporaryPath, contents);
    await io.rename(temporaryPath, path);
  } catch (error) {
    await discard(io, temporaryPath);
    throw new RunRecordWriteError(path, error, redactor);
  }
  return path;
}

/**
 * Replaces every worker- and reviewer-derived string in the report with the
 * omission marker, for the path where no cumulative inventory can prove one
 * safe.
 *
 * IT ELIDES BY STRUCTURE, NOT BY FIELD NAME, and that is the whole point. The
 * previous version overwrote one named key — `attempt.outcome.output` — while
 * up to 64 KiB of worker stderr reached the record by a second route entirely,
 * interpolated into `attempt.failure.message` and carried again in
 * `attempt.outcome.failure.message`. A secret that rotated mid-run was written
 * in cleartext through a redactor built from CURRENT files, which by definition
 * no longer contain it.
 *
 * SO NOTHING HERE SPREADS THE ORIGINAL. Every replacement object is written out
 * as a complete literal, so a spread cannot let a new member opt itself into
 * the record silently — which is exactly how the original defect was shipped.
 *
 * THE COMPILER CATCHES ONLY HALF OF THAT, and the half it misses is worth
 * naming. Add a REQUIRED member to `SliceAttempt`, `WorkerOutcome`,
 * `SliceFailure` or `SliceReview` and this file stops compiling until someone
 * decides whether it is safe to keep. Add an OPTIONAL member and it compiles
 * clean: the literal simply omits it and the field is dropped from the record.
 * That is the safe direction — a dropped field cannot leak — but it is silent,
 * so nobody may rely on the type checker to raise an optional addition here. An
 * optional field that ought to survive into the record has to be added by hand.
 *
 * WHAT IT DELIBERATELY KEEPS is everything brigadier itself computed and no
 * subprocess ever touched: verdicts, kinds, reasons, gate names, routing
 * rejections, token counts, exit codes, durations, commits and branches. A
 * record that elided those would be unreadable, and none of them can carry a
 * value that was read out of a linked secret file.
 */
function elideWorkerOutput(report: RunReport): RunReport {
  return {
    ...report,
    slices: report.slices.map((slice) => ({
      ...slice,
      attempts: slice.attempts.map(elideAttempt),
    })),
  };
}

function elideAttempt(attempt: SliceAttempt): SliceAttempt {
  return {
    attempt: attempt.attempt,
    routed: attempt.routed,
    outcome: attempt.outcome === null ? null : elideOutcome(attempt.outcome),
    commit: attempt.commit,
    failure: attempt.failure === null ? null : elideFailure(attempt.failure),
    review: attempt.review === null ? null : elideReview(attempt.review),
    durationMs: attempt.durationMs,
  };
}

function elideOutcome(outcome: WorkerOutcome): WorkerOutcome {
  if (outcome.ok) {
    return {
      ok: true,
      output: OMITTED_WORKER_OUTPUT,
      usage: outcome.usage,
      ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }),
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
    };
  }
  const failure = outcome.failure;
  if (failure.kind === "LAUNCH_FAILURE") {
    return {
      ok: false,
      output: OMITTED_WORKER_OUTPUT,
      usage: outcome.usage,
      ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }),
      durationMs: outcome.durationMs,
      exitCode: null,
      signal: null,
      failure: {
        kind: "LAUNCH_FAILURE",
        message: OMITTED_WORKER_OUTPUT,
        retryable: failure.retryable,
        statusCode: failure.statusCode,
      },
    };
  }
  return {
    ok: false,
    output: OMITTED_WORKER_OUTPUT,
    usage: outcome.usage,
    ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }),
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    failure: {
      kind: failure.kind,
      message: OMITTED_WORKER_OUTPUT,
      retryable: failure.retryable,
      statusCode: failure.statusCode,
    },
  };
}

function elideFailure(failure: SliceFailure): SliceFailure {
  switch (failure.kind) {
    case "ROUTING_FAILED":
      // `rejected` is kept because of what composes it, NOT because routing
      // predates every subprocess — it does not. Routing consumes a quota
      // snapshot, and a quota oracle can spawn a vendor CLI to obtain one, so
      // "nothing has run yet" is simply false here.
      //
      // What holds is narrower and enough: every field of a `RoutingRejection`
      // is either a closed union (`stage`), an id out of the user's own config
      // (`vendor`, `model`), or a `reason` the router composes from those plus
      // `QuotaWindow` — whose members are closed unions, numbers and a
      // lowercase tier token off the vendor's own quota wire. None of that is a
      // channel for a linked-secret value: the router never sees worker stdout,
      // worker stderr, a slice prompt, or the contents of a linked file.
      //
      // The message can carry all of those: it is interpolated from the stage
      // that failed.
      return {
        kind: "ROUTING_FAILED",
        message: OMITTED_WORKER_OUTPUT,
        reason: failure.reason,
        rejected: failure.rejected,
      };
    case "WORKTREE_FAILED":
      return failure.deterministic === true
        ? {
            kind: "WORKTREE_FAILED",
            message: OMITTED_WORKER_OUTPUT,
            deterministic: true,
          }
        : { kind: "WORKTREE_FAILED", message: OMITTED_WORKER_OUTPUT };
    case "WORKER_FAILED":
      return {
        kind: "WORKER_FAILED",
        message: OMITTED_WORKER_OUTPUT,
        failure: {
          kind: failure.failure.kind,
          message: OMITTED_WORKER_OUTPUT,
          retryable: failure.failure.retryable,
          statusCode: failure.failure.statusCode,
        },
      };
    case "REVIEW_REJECTED":
      return {
        kind: "REVIEW_REJECTED",
        message: OMITTED_WORKER_OUTPUT,
        review: {
          verdict: "rejected",
          reviewer: failure.review.reviewer,
          findings: [],
          ...(failure.review.gates === undefined
            ? {}
            : { gates: elideGates(failure.review.gates) }),
          durationMs: failure.review.durationMs,
        },
      };
    case "NO_CHANGES":
      return { kind: "NO_CHANGES", message: OMITTED_WORKER_OUTPUT };
    case "COMMIT_FAILED":
      return { kind: "COMMIT_FAILED", message: OMITTED_WORKER_OUTPUT };
  }
}

/**
 * The reviewer is a worker too. Its findings quote the diff and the files it
 * was shown, and `tests_pass` carries the project command's own output, so the
 * verdict survives here and every sentence explaining it does not.
 */
function elideReview(review: SliceReview): SliceReview {
  if (review.verdict === "skipped") {
    return {
      verdict: "skipped",
      reviewer: review.reviewer,
      reason: review.reason,
      message: OMITTED_WORKER_OUTPUT,
      ...(review.findings === undefined ? {} : { findings: [] }),
      ...(review.gates === undefined
        ? {}
        : { gates: elideGates(review.gates) }),
      ...(review.cleanupFailure === undefined
        ? {}
        : { cleanupFailure: OMITTED_WORKER_OUTPUT }),
      durationMs: review.durationMs,
    };
  }
  if (review.verdict === "approved") {
    return {
      verdict: "approved",
      reviewer: review.reviewer,
      findings: [],
      ...(review.gates === undefined
        ? {}
        : { gates: elideGates(review.gates) }),
      durationMs: review.durationMs,
    };
  }
  return {
    verdict: "rejected",
    reviewer: review.reviewer,
    findings: [],
    ...(review.gates === undefined ? {} : { gates: elideGates(review.gates) }),
    durationMs: review.durationMs,
  };
}

function elideGates(
  gates: readonly DeterministicGateResult[],
): readonly DeterministicGateResult[] {
  return gates.map((gate) =>
    gate.status === "skipped"
      ? {
          name: gate.name,
          severity: gate.severity,
          status: "skipped",
          reason: OMITTED_WORKER_OUTPUT,
          findings: [],
        }
      : {
          name: gate.name,
          severity: gate.severity,
          status: gate.status,
          findings: [],
        },
  );
}

function recordFileName(
  slug: string,
  runId: string,
  redactor: SecretRedactor,
): string {
  if (!isFileComponent(slug)) {
    throw new Error(redactor(fileComponentError("slug", slug)));
  }
  if (!isFileComponent(runId)) {
    throw new Error(redactor(fileComponentError("run ID", runId)));
  }
  const fileName = `${slug}-${runId}.json`;
  const temporaryFileName = `.${fileName}.${process.pid.toString(36)}.${"x".repeat(MAX_RANDOM_SUFFIX_BYTES)}.tmp`;
  const temporaryFileNameBytes = Buffer.byteLength(temporaryFileName);
  if (temporaryFileNameBytes > MAX_FILE_NAME_BYTES) {
    throw new Error(
      redactor(
        `cannot write run record: temporary filename exceeds ${MAX_FILE_NAME_BYTES}-byte limit (${temporaryFileNameBytes} bytes)`,
      ),
    );
  }
  return fileName;
}

function isFileComponent(value: string): boolean {
  // Mirror the engine's slug validator: a run it accepted must remain recordable.
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    Buffer.byteLength(value) <= MAX_FILE_NAME_BYTES
  );
}

function fileComponentError(label: string, value: string): string {
  const valueBytes = Buffer.byteLength(value);
  if (valueBytes > MAX_FILE_NAME_BYTES) {
    return `cannot write run record: ${label} exceeds ${MAX_FILE_NAME_BYTES}-byte limit (${valueBytes} bytes)`;
  }
  return `cannot write run record: invalid ${label} ${JSON.stringify(value)}`;
}

async function createDirectory(
  io: ConfigIo,
  directory: string,
  redactor: SecretRedactor,
): Promise<void> {
  try {
    await io.mkdir(directory);
  } catch (error) {
    throw new RunRecordWriteError(directory, error, redactor);
  }
}

async function discard(io: ConfigIo, path: string): Promise<void> {
  try {
    await io.unlink(path);
  } catch {
    // The primary write failure explains why no durable record was produced.
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

class RunRecordWriteError extends Error {
  constructor(path: string, cause: unknown, redactor: SecretRedactor) {
    // Redact the complete artifact so a secret spanning formatted fields is seen.
    super(
      redactor(`could not write run record at ${path}: ${describe(cause)}`),
    );
    this.name = "RunRecordWriteError";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
