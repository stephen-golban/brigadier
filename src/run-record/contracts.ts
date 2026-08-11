import type { ConfigEnvironment } from "../config/store.js";
import type { RunReport } from "../supervisor/contracts.js";

export const RUN_RECORD_VERSION = 1;
export const RUN_RECORD_DIRECTORY_NAME = "runs";

/** The durable, versioned representation of one completed run. */
export interface RunRecord {
  readonly version: typeof RUN_RECORD_VERSION;
  readonly runId: string;
  readonly report: RunReport;
}

/** Inputs that identify a run and locate the home in which to record it. */
export interface WriteRunRecordOptions {
  readonly runId: string;
  readonly environment: ConfigEnvironment;
}
