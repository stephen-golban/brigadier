/**
 * Claude discovery.
 *
 * Claude Code exposes no enumeration surface: there is no `claude debug
 * models`, no `claude models`, no `--list-models`. Every way to make it name a
 * model runs a real turn, and a trivial turn was measured at $0.0628 from
 * ~31k cache-creation tokens — so the catalog comes from the static table in
 * `table.ts` and is reported with `catalogSource: "static-table"` so `init`
 * can tell the user where the list came from.
 *
 * Three probes are specifically forbidden here and none of them appear below:
 * `-p --output-format stream-json` (never exits; waits on stdin), `--bare`
 * (hard-refuses OAuth/keychain and would misreport a working subscription
 * install as broken), and anything that starts a turn.
 */

import type {
  CatalogProbeResult,
  RunCommand,
  VendorCatalogSource,
} from "./contracts.js";
import { CLAUDE_STATIC_MODELS } from "./table.js";

export const CLAUDE_VERSION_ARGS = ["--version"] as const;

export const CLAUDE_CATALOG_SOURCE: VendorCatalogSource = {
  vendor: "claude",
  executable: "claude",
  versionArgs: CLAUDE_VERSION_ARGS,
  catalogSource: "static-table",
  readCatalog: readClaudeCatalog,
};

/**
 * Returns the static table. The signature matches the probing vendors so the
 * discovery flow stays uniform; neither argument is used, and deliberately so
 * — reaching for the binary here is what would cost money.
 */
export async function readClaudeCatalog(
  _executable: string,
  _run: RunCommand,
): Promise<CatalogProbeResult> {
  return { ok: true, models: CLAUDE_STATIC_MODELS };
}
