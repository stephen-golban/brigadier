/**
 * The persisted configuration vocabulary. It is owned by this module, and its
 * members deliberately stay out of the shared `src/contracts.ts`, the core
 * contract every other module compiles against. That is a layering boundary,
 * not a privacy one: `src/index.ts` re-exports this module through the package
 * barrel, so every name and shape below is public API. Renaming a member,
 * changing a field's type, or tightening a value is a breaking change for
 * consumers and needs the same deliberate semver consideration as an edit to
 * `src/contracts.ts` itself.
 *
 * The config records *which models are available and permitted* and how high
 * their effort may go. It is deliberately incapable of expressing a
 * "use vendor V for task type T" table: the routing pipeline (capability
 * filter, competence rank, difficulty, effort, cost) keeps vendor out, and this
 * schema must never become a back door into it.
 *
 * It also never holds a secret. Model ids, effort ceilings, resolved executable
 * paths, vendor versions, consent flags, and repository-relative paths to
 * user-approved secret files are the entire surface; `parseConfig` rejects
 * every other key.
 */

import {
  ADAPTER_DECLARATIONS,
  type Effort,
  type Vendor,
} from "../contracts.js";

/**
 * Bumped only when the on-disk shape changes incompatibly.
 *
 * Version 3 adds `linkedSecretPaths`, the repository-relative files whose
 * values the worktree engine inventories for mandatory artifact redaction.
 * Because `parseConfig` rejects unknown and missing keys, older files would
 * otherwise report shape symptoms instead of the cause; the version check runs
 * first and throws one actionable error instead.
 */
export const CONFIG_VERSION = 3;

/** GUI coding hosts whose own configuration may expose brigadier over MCP. */
export const GUI_HOSTS = [
  "cursor",
  "windsurf",
  "antigravity",
  "claude-desktop",
] as const;
export type GuiHost = (typeof GUI_HOSTS)[number];

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
 * `high` is the default ceiling. `xhigh` remains reachable only
 * as an earned escalation after a routed model runs the slice and fails,
 * whatever ceiling a user records here. A routing failure does not earn it.
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
}

export interface BrigadierConfig {
  readonly version: typeof CONFIG_VERSION;
  readonly vendors: readonly VendorConfig[];
  /** Consent to link secret files into worker worktrees. */
  readonly secretsConsent: boolean;
  /** Repository-relative `.env`-shaped files approved for worker worktrees. */
  readonly linkedSecretPaths: readonly string[];
  /** Consent to register brigadier's MCP server into GUI hosts' own configs. */
  readonly guiRegistrationConsent?: boolean;
  /**
   * Consent to run a slice on a model that scores below its difficulty floor
   * rather than failing the slice.
   *
   * This replaces the earlier per-vendor `quotaFallbackModel` ("when this
   * vendor's quota drains, fall back to model X"), which per-model quota
   * metering made obsolete in both halves of its job. The substitution
   * half now happens without it: a drained Opus tier no longer removes Sonnet
   * from the pool, so Sonnet competes and wins on merit through the ordinary
   * pipeline. The consent half is what was actually left — configuring any
   * fallback at all was the only thing that unlocked the difficulty-floor
   * waiver — so it is recorded here as the flag it really is.
   *
   * It is not per vendor. It authorizes a routing *behaviour*, and nothing
   * about that behaviour is vendor-specific once the substituted model's
   * identity is gone: the router already picks the best below-floor model on
   * the machine, from whichever vendor is holding it.
   *
   * `false` is the default, and it preserves that older flag's spirit: brigadier
   * tells the user it could not route the slice rather than quietly running it
   * on something weaker than the work asked for.
   */
  readonly allowDegradedRouting: boolean;
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
  "linkedSecretPaths",
  "guiRegistrationConsent",
  "allowDegradedRouting",
]);
const VENDOR_KEYS: ReadonlySet<string> = new Set([
  "vendor",
  "executable",
  "version",
  "defaultModel",
  "models",
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
 * brigadier knows) or contains only `xhigh` (`xhigh` is earned on retry after a
 * routed model runs the slice and fails, and must never be predicted up front).
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

function isEffort(value: unknown): value is Effort {
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

  // The version is checked first and thrown on immediately, alone.
  //
  // Every other rule below assumes the file is shaped the way this build
  // expects. An older file is not, and letting it fall through would report
  // shape differences instead of their cause. One sentence saying which
  // version was found and what to do about it is the whole diagnosis. `init`
  // catches this error, ignores the existing file, and rebuilds a complete
  // config by collecting the user's choices again instead of migrating the
  // prior values.
  if (root.version !== CONFIG_VERSION) {
    throw new ConfigValidationError([
      `config version must be ${CONFIG_VERSION}, received ${JSON.stringify(root.version)}; this file was written by a different version of brigadier — run \`brigadier init\` again to rewrite it`,
    ]);
  }

  const issues: string[] = [];
  rejectUnknownKeys(root, CONFIG_KEYS, "config", issues);

  if (typeof root.secretsConsent !== "boolean") {
    issues.push("secretsConsent must be a boolean");
  }
  const linkedSecretPaths = parseLinkedSecretPaths(
    root.linkedSecretPaths,
    issues,
  );
  if (typeof root.allowDegradedRouting !== "boolean") {
    issues.push("allowDegradedRouting must be a boolean");
  }
  if (
    root.guiRegistrationConsent !== undefined &&
    typeof root.guiRegistrationConsent !== "boolean"
  ) {
    issues.push("guiRegistrationConsent must be a boolean when present");
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
    linkedSecretPaths,
    guiRegistrationConsent: root.guiRegistrationConsent === true,
    allowDegradedRouting: root.allowDegradedRouting === true,
  };
}

function parseLinkedSecretPaths(
  value: unknown,
  issues: string[],
): readonly string[] {
  if (!Array.isArray(value)) {
    issues.push("linkedSecretPaths must be an array");
    return [];
  }

  const paths: string[] = [];
  for (const [index, path] of value.entries()) {
    const field = `linkedSecretPaths[${index}]`;
    if (typeof path !== "string" || path.length === 0) {
      issues.push(`${field} must be a non-empty string`);
      continue;
    }
    if (hasControlCharacter(path)) {
      issues.push(`${field} must not contain control characters`);
      continue;
    }
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      /^[a-zA-Z]:\//u.test(path)
    ) {
      issues.push(`${field} must be a repository-relative POSIX path`);
      continue;
    }
    if (path.split("/").includes("..")) {
      issues.push(`${field} must not contain ".." path segments`);
      continue;
    }
    paths.push(path);
  }
  return paths;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
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

  return {
    vendor,
    executable,
    version,
    defaultModel: typeof defaultModel === "string" ? defaultModel : "",
    models,
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
