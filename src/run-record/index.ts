/**
 * Persisting a completed run as a durable, versioned JSON artifact.
 */

import { basename, join } from "node:path";
import type { ConfigIo } from "../config/store.js";
import { nodeConfigIo, resolveConfigHome } from "../config/store.js";
import type { RunReport } from "../supervisor/contracts.js";
import type { SecretRedactor } from "../worktree/engine.js";
import type { RunRecord, WriteRunRecordOptions } from "./contracts.js";
import { RUN_RECORD_DIRECTORY_NAME, RUN_RECORD_VERSION } from "./contracts.js";

const MAX_FILE_NAME_BYTES = 255;
const MAX_RANDOM_SUFFIX_BYTES = 8;

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
    report,
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
