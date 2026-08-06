/**
 * WO-002 owns this quota operation contract and may amend it freely within
 * this file. WO-002 must not add its members to the frozen `src/contracts.ts`.
 *
 * Decision: QuotaOracle ingests Claude's push-based quota WorkerEvents.
 * Keeping the latest live signal in the oracle gives the supervisor one
 * snapshot API for both vendors and keeps vendor-specific state and freshness
 * policy out of orchestration. Codex remains pull-based through a long-lived
 * `codex app-server --stdio` process. Claude's oracle owns no process; its
 * `dispose()` only closes the ingress and is therefore still idempotent.
 */

import type { QuotaSnapshot, Vendor, WorkerEvent } from "../contracts.js";

export type QuotaWorkerEvent = Extract<WorkerEvent, { readonly type: "quota" }>;

export type ClaudeQuotaWorkerEvent = QuotaWorkerEvent & {
  readonly snapshot: QuotaSnapshot & { readonly vendor: "claude" };
};

/** A vendor quota source whose process or connection may be long-lived. */
export interface QuotaOracle<V extends Vendor = Vendor> {
  readonly vendor: V;
  snapshot(): Promise<QuotaSnapshot & { readonly vendor: V }>;
  /** Closes open pipes and waits for owned resources to terminate. */
  dispose(): Promise<void>;
}

/** Pull-based Codex quota source backed by one app-server process. */
export type CodexQuotaOracle = QuotaOracle<"codex">;

/** Push-based Claude quota source retaining the latest worker observation. */
export interface ClaudeQuotaOracle extends QuotaOracle<"claude"> {
  ingest(event: ClaudeQuotaWorkerEvent): void;
}

/** A heterogeneous quota source that preserves vendor/snapshot correlation. */
export type AnyQuotaOracle = CodexQuotaOracle | ClaudeQuotaOracle;
