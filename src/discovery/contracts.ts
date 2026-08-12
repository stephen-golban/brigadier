/**
 * The discovery contract. `DiscoveredVendor`, `DiscoveredModel`,
 * `DiscoveryReport`, `DiscoveryWarning`, and `Discoverer` are exported from
 * the package root and consumed verbatim by `brigadier init`, so renaming,
 * widening, or restructuring any of them is a breaking change. Types that only
 * this module needs — the injectable seam below — belong here rather than in
 * the shared `src/contracts.ts`.
 *
 * Discovery reports what a vendor said about itself. It deliberately does not
 * narrow to brigadier's own `Effort` ladder: Codex reports six reasoning
 * levels and Claude reports five, while brigadier accepts three. An
 * unrecognized future level must survive the probe so that `init` — not
 * discovery — decides what brigadier can drive.
 */

import type { Vendor } from "../contracts.js";

/** A worker CLI found on this machine. */
export interface DiscoveredVendor {
  readonly vendor: Vendor; // from the shared contract in src/contracts.ts
  readonly executable: string; // absolute resolved path
  readonly version: string; // as reported by the CLI, verbatim
  /**
   * GUARANTEE: model ids are unique within this list, and every id a vendor
   * reported more than once is described in `DiscoveryReport.warnings`.
   * Collapsing is done in one place (`VendorDiscoverer.probe`), never in a
   * per-vendor parser, so the warning cannot be lost upstream of it.
   *
   * The surviving entry is the one describing the most capability — selectable
   * over hidden, a reported effort ladder over an empty one, ties and list
   * position going to the first occurrence. A vendor that lists a placeholder
   * ahead of the real model must not have the real model discarded.
   *
   * Consumers may index this list by id without deduplicating it — `brigadier
   * init` builds a config whose schema rejects a duplicate model outright.
   */
  readonly models: readonly DiscoveredModel[];
  /** How the model list was obtained — surfaced to the user at init. */
  readonly catalogSource: "probe" | "static-table";
}

/** One model the vendor reports (or that the static table claims) as usable. */
export interface DiscoveredModel {
  readonly id: string; // e.g. "gpt-5.6-sol"
  readonly displayName: string;
  /** Efforts the vendor reports. May exceed brigadier's own `Effort` ladder. */
  readonly supportedEfforts: readonly string[];
  /** Vendor-declared default, if it declares one. */
  readonly defaultEffort: string | null;
  /** True when the vendor lists the model as user-selectable. */
  readonly selectable: boolean;
}

export interface DiscoveryReport {
  readonly vendors: readonly DiscoveredVendor[];
  /** Vendors brigadier knows about but did not find installed. */
  readonly missing: readonly Vendor[];
  /** Non-fatal problems: found but unprobeable, bad exit code, unparseable. */
  readonly warnings: readonly DiscoveryWarning[];
}

export interface DiscoveryWarning {
  readonly vendor: Vendor;
  readonly message: string;
  readonly cause:
    | "not-found"
    | "probe-failed"
    | "parse-failed"
    | "version-unknown";
}

export interface Discoverer {
  /** Never throws for a missing or broken vendor — reports it in the result. */
  discover(): Promise<DiscoveryReport>;
}

/**
 * The injectable seam. Every probe reaches the outside world through
 * `RunCommand` and `ExecutableResolver`, so tests drive discovery without a
 * real binary on PATH.
 */

export interface CommandResult {
  /** Null when the process was terminated by a signal rather than exiting. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a command to completion and buffers its output.
 *
 * An implementation must reject only when the process could not be observed at
 * all (spawn failure); a nonzero exit is a resolved `CommandResult`, because a
 * bad exit code is a discovery warning rather than a discovery crash.
 */
export type RunCommand = (
  executable: string,
  args: readonly string[],
) => Promise<CommandResult>;

/** Resolves a command name to an absolute path, or null when not installed. */
export type ExecutableResolver = (name: string) => Promise<string | null>;

/** A parsed model catalog, or the reason the catalog text was unusable. */
export type CatalogParseResult =
  | { readonly ok: true; readonly models: readonly DiscoveredModel[] }
  | { readonly ok: false; readonly message: string };

/**
 * A catalog read, which can fail for two distinguishable reasons. The split
 * matters: a CLI that exits nonzero has told us nothing about its models, and
 * must never be reported as a vendor whose catalog happens to be empty.
 */
export type CatalogProbeResult =
  | { readonly ok: true; readonly models: readonly DiscoveredModel[] }
  | {
      readonly ok: false;
      readonly message: string;
      readonly cause: "probe-failed" | "parse-failed";
    };

/**
 * One vendor's discovery behavior. Adding a vendor means adding one of these
 * and listing it, not reshaping the discovery flow.
 */
export interface VendorCatalogSource {
  readonly vendor: Vendor;
  /** Command name looked up on PATH when no override path is configured. */
  readonly executable: string;
  /**
   * Argv that makes the CLI print its version and exit. This must not start a
   * model turn: a trivial Claude turn was measured at $0.0628, so version
   * detection is `--version` and nothing else.
   */
  readonly versionArgs: readonly string[];
  readonly catalogSource: "probe" | "static-table";
  /** Obtains the model catalog. Must not start a billable turn. */
  readCatalog(executable: string, run: RunCommand): Promise<CatalogProbeResult>;
}
