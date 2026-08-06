/**
 * WO-002 owns this quota operation contract and may amend it freely within
 * this file. WO-002 must not add its members to the frozen `src/contracts.ts`.
 *
 * WO-002 must decide and document whether QuotaOracle ingests Claude's
 * push-based mid-stream `rate_limit_event` values, already surfaced as quota
 * WorkerEvents, or stays pull-only while the supervisor merges them. Codex
 * quota is pull-based through a long-lived `codex app-server --stdio` process
 * that exits on stdin EOF.
 */

import type { QuotaSnapshot, Vendor } from "../contracts.js";

/** A vendor quota source whose process or connection may be long-lived. */
export interface QuotaOracle<V extends Vendor = Vendor> {
  readonly vendor: V;
  snapshot(): Promise<QuotaSnapshot & { readonly vendor: V }>;
  /** Closes open pipes and waits for owned resources to terminate. */
  dispose(): Promise<void>;
}

/** A heterogeneous quota source that preserves vendor/snapshot correlation. */
export type AnyQuotaOracle = { [V in Vendor]: QuotaOracle<V> }[Vendor];
