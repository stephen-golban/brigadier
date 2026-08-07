/**
 * WO-008B owns the persisted configuration vocabulary and may amend it freely
 * within this file. It must not add its members to the frozen
 * `src/contracts.ts`.
 *
 * The config records *which models are available and permitted* and how high
 * their effort may go. It is deliberately incapable of expressing a
 * "use vendor V for task type T" table: decision #7 keeps vendor out of the
 * routing pipeline (capability filter, competence rank, difficulty, effort,
 * cost), and this schema must never become a back door into it.
 *
 * It also never holds a secret. Model ids, effort ceilings, quota fallbacks,
 * resolved executable paths, vendor versions, and one consent boolean are the
 * entire surface; `parseConfig` rejects every other key.
 */

import {
  ADAPTER_DECLARATIONS,
  type Effort,
  type Vendor,
} from "../contracts.js";

/** Bumped only when the on-disk shape changes incompatibly. */
export const CONFIG_VERSION = 1;

/**
 * Brigadier's own effort ladder, ordered lowest to highest. Vendor CLIs report
 * richer ladders (Codex reports `low|medium|high|xhigh|max|ultra`); levels with
 * no brigadier equivalent are dropped by `narrowEfforts`, never mapped onto a
 * neighbouring rung.
 */
export const EFFORT_LADDER = [
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly Effort[];

/**
 * Decision #20: `high` is the default ceiling. `xhigh` remains reachable only
 * as an earned escalation after a slice fails its gate, whatever ceiling a user
 * records here.
 */
export const DEFAULT_EFFORT_CEILING = "high" satisfies Effort;

/** One model the machine actually has, plus the ceiling the user permits. */
export interface ModelPermission {
  readonly id: string;
  readonly effortCeiling: Effort;
}

/** Everything brigadier persists about one installed vendor CLI. */
export interface VendorConfig {
  readonly vendor: Vendor;
  readonly executable: string;
  readonly version: string;
  /** Must be one of `models`; the router still overrides it per slice. */
  readonly defaultModel: string;
  readonly models: readonly ModelPermission[];
  /** Decision #21: user-chosen. `null` means fail the slice instead. */
  readonly quotaFallbackModel: string | null;
}

export interface BrigadierConfig {
  readonly version: typeof CONFIG_VERSION;
  readonly vendors: readonly VendorConfig[];
  /** Decision #6: consent to link secret files into worker worktrees. */
  readonly secretsConsent: boolean;
}

/** Raised by `parseConfig` and by every config transform in `init`. */
export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid brigadier config: ${issues.join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = [...issues];
  }
}

const KNOWN_VENDORS: ReadonlySet<string> = new Set(
  ADAPTER_DECLARATIONS.map((declaration) => declaration.vendor),
);
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "version",
  "vendors",
  "secretsConsent",
]);
const VENDOR_KEYS: ReadonlySet<string> = new Set([
  "vendor",
  "executable",
  "version",
  "defaultModel",
  "models",
  "quotaFallbackModel",
]);
const MODEL_KEYS: ReadonlySet<string> = new Set(["id", "effortCeiling"]);

/**
 * Narrows a vendor-reported effort ladder to brigadier's three rungs. A level
 * brigadier does not know (`low`, `max`, `ultra`, anything a vendor ships next
 * week) is dropped rather than rounded onto a neighbouring rung, so a ceiling
 * derived from this list can never exceed `xhigh`.
 */
export function narrowEfforts(
  supportedEfforts: readonly string[],
): readonly Effort[] {
  const reported = new Set<string>();
  for (const level of supportedEfforts) {
    reported.add(level.trim().toLowerCase());
  }
  return EFFORT_LADDER.filter((effort) => reported.has(effort));
}

/**
 * The ceiling brigadier proposes for a model, or `null` when it can propose
 * none.
 *
 * The returned rung is always one the vendor itself reported: `high` where the
 * vendor supports it, otherwise `medium`. It is never a rung the vendor did not
 * report, and never above `high`.
 *
 * `null` means the model is not usable by brigadier at a proposed ceiling. That
 * happens when the narrowed ladder is empty (the vendor reports no rung
 * brigadier knows) or contains only `xhigh` (decision #20: `xhigh` is earned on
 * retry after a slice fails its gate and must never be predicted up front).
 * Writing `high` for such a model would record an effort the vendor does not
 * accept, so the caller must exclude the model instead.
 */
export function defaultEffortCeiling(
  allowed: readonly Effort[],
): Effort | null {
  if (allowed.includes(DEFAULT_EFFORT_CEILING)) {
    return DEFAULT_EFFORT_CEILING;
  }
  if (allowed.includes("medium")) {
    return "medium";
  }
  return null;
}

export function isEffort(value: unknown): value is Effort {
  return (
    typeof value === "string" &&
    (EFFORT_LADDER as readonly string[]).includes(value)
  );
}

/**
 * Validates an untrusted value into a `BrigadierConfig`, rejecting unknown keys
 * so nothing outside the documented surface can be smuggled into the file.
 * Returns a fresh, canonically ordered object.
 */
export function parseConfig(value: unknown): BrigadierConfig {
  const root = asRecord(value);
  if (root === null) {
    throw new ConfigValidationError(["config must be a JSON object"]);
  }

  const issues: string[] = [];
  rejectUnknownKeys(root, CONFIG_KEYS, "config", issues);

  if (root.version !== CONFIG_VERSION) {
    issues.push(
      `config version must be ${CONFIG_VERSION}, received ${JSON.stringify(root.version)}`,
    );
  }
  if (typeof root.secretsConsent !== "boolean") {
    issues.push("secretsConsent must be a boolean");
  }
  if (!Array.isArray(root.vendors)) {
    issues.push("vendors must be an array");
    throw new ConfigValidationError(issues);
  }

  const vendors: VendorConfig[] = [];
  const seenVendors = new Set<string>();
  for (const [index, entry] of root.vendors.entries()) {
    const parsed = parseVendor(entry, index, seenVendors, issues);
    if (parsed !== null) {
      vendors.push(parsed);
    }
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
  return {
    version: CONFIG_VERSION,
    vendors,
    secretsConsent: root.secretsConsent === true,
  };
}

function parseVendor(
  value: unknown,
  index: number,
  seenVendors: Set<string>,
  issues: string[],
): VendorConfig | null {
  const record = asRecord(value);
  if (record === null) {
    issues.push(`vendors[${index}] must be an object`);
    return null;
  }

  const vendorName = record.vendor;
  if (typeof vendorName !== "string" || !KNOWN_VENDORS.has(vendorName)) {
    issues.push(
      `vendors[${index}]: unknown vendor ${JSON.stringify(vendorName)}`,
    );
    return null;
  }
  const vendor = vendorName as Vendor;
  rejectUnknownKeys(record, VENDOR_KEYS, vendor, issues);

  if (seenVendors.has(vendor)) {
    issues.push(`${vendor}: duplicate vendor entry`);
  }
  seenVendors.add(vendor);

  const executable = requireNonEmptyString(
    record.executable,
    vendor,
    "executable",
    issues,
  );
  const version = requireNonEmptyString(
    record.version,
    vendor,
    "version",
    issues,
  );

  const models: ModelPermission[] = [];
  const modelIds = new Set<string>();
  if (!Array.isArray(record.models)) {
    issues.push(`${vendor}: models must be an array`);
  } else if (record.models.length === 0) {
    issues.push(`${vendor}: models must not be empty`);
  } else {
    for (const [modelIndex, rawModel] of record.models.entries()) {
      const model = parseModel(rawModel, vendor, modelIndex, modelIds, issues);
      if (model !== null) {
        models.push(model);
        modelIds.add(model.id);
      }
    }
  }

  const defaultModel = record.defaultModel;
  if (typeof defaultModel !== "string" || defaultModel.length === 0) {
    issues.push(`${vendor}: defaultModel must be a non-empty string`);
  } else if (!modelIds.has(defaultModel)) {
    issues.push(
      `${vendor}: default model ${JSON.stringify(defaultModel)} is not one of this vendor's available models`,
    );
  }

  const fallback = record.quotaFallbackModel;
  if (fallback !== null && typeof fallback !== "string") {
    issues.push(`${vendor}: quotaFallbackModel must be a string or null`);
  } else if (typeof fallback === "string" && !modelIds.has(fallback)) {
    issues.push(
      `${vendor}: quota fallback model ${JSON.stringify(fallback)} is not one of this vendor's available models`,
    );
  }

  return {
    vendor,
    executable,
    version,
    defaultModel: typeof defaultModel === "string" ? defaultModel : "",
    models,
    quotaFallbackModel: typeof fallback === "string" ? fallback : null,
  };
}

function parseModel(
  value: unknown,
  vendor: Vendor,
  index: number,
  seenIds: ReadonlySet<string>,
  issues: string[],
): ModelPermission | null {
  const record = asRecord(value);
  if (record === null) {
    issues.push(`${vendor}: models[${index}] must be an object`);
    return null;
  }
  rejectUnknownKeys(record, MODEL_KEYS, `${vendor}.models[${index}]`, issues);

  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    issues.push(`${vendor}: models[${index}].id must be a non-empty string`);
    return null;
  }
  if (seenIds.has(id)) {
    issues.push(`${vendor}: duplicate model ${JSON.stringify(id)}`);
    return null;
  }
  if (!isEffort(record.effortCeiling)) {
    issues.push(
      `${vendor}: effort ceiling ${JSON.stringify(record.effortCeiling)} for model ${JSON.stringify(id)} is not one of ${EFFORT_LADDER.join(", ")}`,
    );
    return null;
  }
  return { id, effortCeiling: record.effortCeiling };
}

function requireNonEmptyString(
  value: unknown,
  vendor: Vendor,
  field: string,
  issues: string[],
): string {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${vendor}: ${field} must be a non-empty string`);
    return "";
  }
  return value;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  scope: string,
  issues: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push(`${scope}: unknown key ${JSON.stringify(key)}`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
