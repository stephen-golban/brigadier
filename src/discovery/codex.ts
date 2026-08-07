/**
 * Codex discovery.
 *
 * `codex debug models` exits 0 and prints the full model catalog as JSON on
 * stdout, so Codex needs no static table. Two properties of that output drive
 * the code below:
 *
 * 1. It is large — roughly 332 KB on a real install, because every entry
 *    embeds a multi-kilobyte `base_instructions` prose blob plus a
 *    `model_messages` template. `parseCodexCatalog` copies out the five fields
 *    `DiscoveredModel` declares and drops the parsed document on return, so no
 *    catalog prose is retained, logged, or carried in a `DiscoveryReport`.
 * 2. `codex` exits 2 on an argv error. That is brigadier's bug, never "this
 *    vendor has no models", so a nonzero exit is reported as `probe-failed`
 *    with stderr attached and yields no vendor entry at all.
 */

import type {
  CatalogParseResult,
  CatalogProbeResult,
  DiscoveredModel,
  RunCommand,
  VendorCatalogSource,
} from "./contracts.js";

/** Argv that prints the catalog. No API call, no turn, no billing. */
export const CODEX_CATALOG_ARGS = ["debug", "models"] as const;
export const CODEX_VERSION_ARGS = ["--version"] as const;

/** Codex marks a model user-selectable with this `visibility` value. */
const SELECTABLE_VISIBILITY = "list";

export const CODEX_CATALOG_SOURCE: VendorCatalogSource = {
  vendor: "codex",
  executable: "codex",
  versionArgs: CODEX_VERSION_ARGS,
  catalogSource: "probe",
  readCatalog: readCodexCatalog,
};

export async function readCodexCatalog(
  executable: string,
  run: RunCommand,
): Promise<CatalogProbeResult> {
  let result: Awaited<ReturnType<RunCommand>>;
  try {
    result = await run(executable, CODEX_CATALOG_ARGS);
  } catch (error) {
    return {
      ok: false,
      cause: "probe-failed",
      message: `could not run \`codex ${CODEX_CATALOG_ARGS.join(" ")}\`: ${describeError(error)}`,
    };
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      cause: "probe-failed",
      message: `\`codex ${CODEX_CATALOG_ARGS.join(" ")}\` exited ${describeExit(result.exitCode)}${formatStderr(result.stderr)}`,
    };
  }

  const parsed = parseCodexCatalog(result.stdout);
  return parsed.ok
    ? { ok: true, models: parsed.models }
    : { ok: false, cause: "parse-failed", message: parsed.message };
}

/**
 * Extracts the model catalog from `codex debug models` stdout.
 *
 * Returns a result rather than throwing so the caller can classify the failure
 * without a try/catch, and so the parser is directly testable against a
 * fixture.
 */
export function parseCodexCatalog(stdout: string): CatalogParseResult {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch (error) {
    return {
      ok: false,
      message: `codex model catalog is not valid JSON: ${describeError(error)}`,
    };
  }

  if (!isObject(document)) {
    return { ok: false, message: "codex model catalog is not a JSON object" };
  }
  const entries = document.models;
  if (!Array.isArray(entries)) {
    return {
      ok: false,
      message: "codex model catalog has no `models` array",
    };
  }

  // Duplicate slugs are reported as they were read. `VendorDiscoverer.probe` is
  // the single place `DiscoveredVendor.models`' uniqueness guarantee is
  // enforced, so every vendor — this one and any added later — collapses
  // duplicates by the same rule and warns about them the same way. Dropping one
  // here would hide the evidence that warning is made of.
  const models: DiscoveredModel[] = [];
  for (const entry of entries) {
    const model = toDiscoveredModel(entry);
    if (model === null) {
      return {
        ok: false,
        message:
          "codex model catalog contains an entry without a string `slug`",
      };
    }
    models.push(model);
  }

  if (models.length === 0) {
    // Valid JSON that lists nothing is still unusable to `init`, and silently
    // presenting a vendor with no models would strand the user at the model
    // prompt with an empty list and no explanation.
    return { ok: false, message: "codex model catalog is empty" };
  }
  return { ok: true, models };
}

/**
 * Copies the five reported fields out of one catalog entry. Everything else —
 * `base_instructions`, `model_messages`, `description`, tool metadata — is
 * left behind with the parsed document.
 */
function toDiscoveredModel(entry: unknown): DiscoveredModel | null {
  if (!isObject(entry)) {
    return null;
  }
  const slug = entry.slug;
  if (typeof slug !== "string" || slug === "") {
    return null;
  }
  const displayName = entry.display_name;
  const defaultEffort = entry.default_reasoning_level;
  return {
    id: slug,
    displayName: typeof displayName === "string" ? displayName : slug,
    supportedEfforts: readEfforts(entry.supported_reasoning_levels),
    defaultEffort: typeof defaultEffort === "string" ? defaultEffort : null,
    selectable: entry.visibility === SELECTABLE_VISIBILITY,
  };
}

/**
 * Codex reports reasoning levels as `{effort, description}` objects. Bare
 * strings are also accepted so a future shape change degrades to a correct
 * list rather than an empty one.
 */
function readEfforts(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const efforts: string[] = [];
  for (const level of raw) {
    if (typeof level === "string") {
      efforts.push(level);
      continue;
    }
    if (isObject(level) && typeof level.effort === "string") {
      efforts.push(level.effort);
    }
  }
  return efforts;
}

function formatStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === "" ? "" : `: ${trimmed}`;
}

function describeExit(exitCode: number | null): string {
  return exitCode === null ? "on a signal" : `${exitCode}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
