/**
 * Turning a `DiscoveryReport` into a proposed config, plus the pure transforms
 * `init` applies when a user overrides a proposal.
 *
 * The competence table below *ranks* model ids brigadier has exercised; it
 * never *asserts* that a model exists. Every option offered anywhere in `init`
 * comes from the discovery report, filtered to `selectable: true`, so the week
 * a vendor ships a new model the flow still offers it (unranked, below the
 * known tiers) instead of pretending it is absent.
 */

import type {
  BrigadierConfig,
  ModelPermission,
  VendorConfig,
} from "../config/contracts.js";
import {
  CONFIG_VERSION,
  ConfigValidationError,
  defaultEffortCeiling,
  narrowEfforts,
  parseConfig,
} from "../config/contracts.js";
import type { Effort, Vendor } from "../contracts.js";
import type {
  DiscoveredModel,
  DiscoveredVendor,
  DiscoveryReport,
} from "../discovery/contracts.js";

/** A model-id pattern with the competence tier brigadier has observed for it. */
export interface CompetenceRule {
  readonly pattern: RegExp;
  readonly score: number;
  readonly rationale: string;
}

export const UNRANKED_SCORE = 0;
export const UNRANKED_RATIONALE =
  "not in brigadier's competence table; offered because the probe found it, ranked below the tiers brigadier has exercised";

/**
 * Ranks by demonstrated competence, not by vendor. Two models from different
 * vendors compete on the same scale, which is what keeps decision #7 honest:
 * the proposal never says "use vendor V", only "this model outranks that one".
 */
export const COMPETENCE_TABLE: readonly CompetenceRule[] = [
  {
    pattern: /opus/i,
    score: 100,
    rationale:
      "deepest Anthropic reasoning tier: architecture and ambiguous specs",
  },
  {
    pattern: /gpt-5\.6-sol/i,
    score: 96,
    rationale:
      "deepest Codex reasoning tier: cross-cutting refactors and subtle debugging",
  },
  {
    pattern: /sonnet/i,
    score: 74,
    rationale: "balanced Anthropic tier: well-specified multi-file edits",
  },
  {
    pattern: /gpt-5\.6-terra/i,
    score: 70,
    rationale:
      "fast Codex tier: mechanical volume, scaffolding, and boilerplate",
  },
  {
    pattern: /haiku/i,
    score: 40,
    rationale: "smallest Anthropic tier: lookups and single-file transcription",
  },
];

export interface RankedModel {
  readonly model: DiscoveredModel;
  readonly score: number;
  readonly rationale: string;
  /** Brigadier-ladder efforts this model supports; may be empty. */
  readonly allowedEfforts: readonly Effort[];
}

export interface VendorProposal {
  readonly vendor: Vendor;
  readonly executable: string;
  readonly version: string;
  readonly catalogSource: DiscoveredVendor["catalogSource"];
  readonly totalModels: number;
  /** Selectable models, best first. Never empty. */
  readonly ranked: readonly RankedModel[];
  readonly config: VendorConfig;
  readonly defaultModelRationale: string;
  /** True when a previous config supplied this vendor's defaults. */
  readonly carriedOver: boolean;
}

/** A discovered model brigadier cannot drive, and why it was left out. */
export interface UnusableModel {
  readonly vendor: Vendor;
  readonly modelId: string;
  /** Brigadier-ladder efforts the vendor reported for it; `xhigh` at most. */
  readonly allowedEfforts: readonly Effort[];
  readonly reason: string;
}

/**
 * A vendor in the prior config that is not being configured now, and why.
 *
 * The reason is carried rather than assumed. "Not found on this machine" was
 * the only outcome when absence was the only way to lose a vendor; a vendor
 * whose every model reports an effort ladder brigadier cannot drive is present
 * — its version and path are printed in the report above — so saying it was
 * not found contradicts the line directly above the note.
 */
export interface DroppedVendor {
  readonly vendor: Vendor;
  /**
   * `not-installed` — no executable for it was found on this machine.
   * `not-usable` — installed, but it reported no model brigadier can drive.
   * `probe-failed` — installed, but discovery could not learn its models.
   */
  readonly reason: "not-installed" | "not-usable" | "probe-failed";
}

export interface Proposal {
  readonly config: BrigadierConfig;
  readonly vendors: readonly VendorProposal[];
  /** Discovered but unusable: nothing selectable brigadier can drive. */
  readonly vendorsWithoutModels: readonly Vendor[];
  /**
   * Selectable models excluded because no rung brigadier may propose is
   * available. Rendered for the user: a silently missing model looks like a
   * discovery bug.
   */
  readonly unusableModels: readonly UnusableModel[];
  /** Present in the prior config but not being configured now, with the reason. */
  readonly droppedVendors: readonly DroppedVendor[];
  /** Prior choices that no longer exist and were reset, described for the user. */
  readonly resetChoices: readonly string[];
}

/**
 * Builds the proposal. A prior config supplies the defaults wherever its
 * choices still exist on this machine; anything that no longer exists is reset
 * and reported in `resetChoices` rather than dropped silently.
 */
export function proposeConfig(
  report: DiscoveryReport,
  existing: BrigadierConfig | null,
): Proposal {
  const vendors: VendorProposal[] = [];
  const vendorsWithoutModels: Vendor[] = [];
  const unusableModels: UnusableModel[] = [];
  const resetChoices: string[] = [];

  for (const discovered of report.vendors) {
    // Why each excluded model was excluded, kept per vendor so a prior choice
    // that names one is explained with that reason instead of being called
    // uninstalled.
    const unusableReasons = new Map<string, string>();
    const ranked = rankModels(discovered.models).filter((entry) => {
      if (defaultEffortCeiling(entry.allowedEfforts) !== null) {
        return true;
      }
      const reason =
        entry.allowedEfforts.length === 0
          ? "the vendor reports no effort level on brigadier's ladder (medium, high, xhigh)"
          : "the vendor reports xhigh only, and xhigh is earned on retry after a failed gate — brigadier never predicts it";
      unusableReasons.set(entry.model.id, reason);
      unusableModels.push({
        vendor: discovered.vendor,
        modelId: entry.model.id,
        allowedEfforts: entry.allowedEfforts,
        reason,
      });
      return false;
    });
    if (ranked.length === 0) {
      vendorsWithoutModels.push(discovered.vendor);
      continue;
    }
    const prior =
      existing?.vendors.find((entry) => entry.vendor === discovered.vendor) ??
      null;
    vendors.push(
      proposeVendor(discovered, ranked, prior, unusableReasons, resetChoices),
    );
  }

  const configured = new Set(vendors.map((entry) => entry.vendor));
  const unusableVendors = new Set(vendorsWithoutModels);
  const droppedVendors = (existing?.vendors ?? [])
    .map((entry) => entry.vendor)
    .filter((vendor) => !configured.has(vendor))
    .map((vendor) => ({
      vendor,
      reason: whyDropped(report, vendor, unusableVendors),
    }));

  const config = parseConfig({
    version: CONFIG_VERSION,
    vendors: vendors.map((entry) => entry.config),
    secretsConsent: existing?.secretsConsent ?? false,
  });

  return {
    config,
    vendors,
    vendorsWithoutModels,
    unusableModels,
    droppedVendors,
    resetChoices,
  };
}

/**
 * Classifies a prior vendor that is not being configured now. Only a vendor
 * discovery actually failed to find is called uninstalled; one that answered
 * the probe is described by what it answered.
 */
function whyDropped(
  report: DiscoveryReport,
  vendor: Vendor,
  unusableVendors: ReadonlySet<Vendor>,
): DroppedVendor["reason"] {
  if (
    unusableVendors.has(vendor) ||
    report.vendors.some((entry) => entry.vendor === vendor)
  ) {
    return "not-usable";
  }
  if (
    report.warnings.some(
      (warning) => warning.vendor === vendor && warning.cause !== "not-found",
    )
  ) {
    return "probe-failed";
  }
  return "not-installed";
}

function proposeVendor(
  discovered: DiscoveredVendor,
  ranked: readonly RankedModel[],
  prior: VendorConfig | null,
  unusableReasons: ReadonlyMap<string, string>,
  resetChoices: string[],
): VendorProposal {
  const best = ranked[0];
  if (best === undefined) {
    throw new Error("proposeVendor requires at least one selectable model");
  }
  const selectableIds = new Set(ranked.map((entry) => entry.model.id));

  const priorCeilings = new Map<string, Effort>(
    (prior?.models ?? []).map((model) => [model.id, model.effortCeiling]),
  );
  const models: ModelPermission[] = ranked.map((entry) => ({
    id: entry.model.id,
    effortCeiling: carryCeiling(
      discovered.vendor,
      entry,
      priorCeilings.get(entry.model.id),
      resetChoices,
    ),
  }));

  let defaultModel = best.model.id;
  let rationale = best.rationale;
  let carriedOver = false;
  if (prior !== null) {
    if (selectableIds.has(prior.defaultModel)) {
      defaultModel = prior.defaultModel;
      rationale = "carried over from your existing config";
      carriedOver = true;
    } else {
      resetChoices.push(
        `${discovered.vendor}: previous default model "${prior.defaultModel}" ${whyUnavailable(discovered, unusableReasons, prior.defaultModel)}; proposing "${best.model.id}"`,
      );
    }
  }

  // Decision #21: nothing is proposed as a fallback. Brigadier never invents a
  // same-vendor downgrade; substituting a model is a choice the user makes.
  let quotaFallbackModel: string | null = null;
  const priorFallback = prior?.quotaFallbackModel ?? null;
  if (priorFallback !== null) {
    if (selectableIds.has(priorFallback)) {
      quotaFallbackModel = priorFallback;
      carriedOver = true;
    } else {
      resetChoices.push(
        `${discovered.vendor}: previous quota fallback "${priorFallback}" ${whyUnavailable(discovered, unusableReasons, priorFallback)}; reset to none`,
      );
    }
  }

  return {
    vendor: discovered.vendor,
    executable: discovered.executable,
    version: discovered.version,
    catalogSource: discovered.catalogSource,
    totalModels: discovered.models.length,
    ranked,
    defaultModelRationale: rationale,
    carriedOver,
    config: {
      vendor: discovered.vendor,
      executable: discovered.executable,
      version: discovered.version,
      defaultModel,
      models,
      quotaFallbackModel,
    },
  };
}

/**
 * Says why a prior model choice is not on offer any more.
 *
 * There are three ways to lose one and only one of them is absence. A model the
 * vendor still reports but brigadier cannot drive gets a `note:` two lines
 * above saying exactly that, so claiming it is "no longer installed" here
 * contradicts the note and sends the user looking for a broken install.
 */
function whyUnavailable(
  discovered: DiscoveredVendor,
  unusableReasons: ReadonlyMap<string, string>,
  modelId: string,
): string {
  const unusable = unusableReasons.get(modelId);
  if (unusable !== undefined) {
    return `is installed but brigadier cannot drive it (${unusable})`;
  }
  if (discovered.models.some((model) => model.id === modelId)) {
    return `is installed but ${discovered.vendor} no longer lists it as selectable`;
  }
  return "is no longer installed";
}

/**
 * The ceiling to record for one model. A prior choice is preserved only while
 * the vendor still reports that rung: a ceiling the vendor does not accept
 * fails at the moment it is used, so an unsupported prior is reset and the
 * reset is reported rather than carried forward.
 *
 * `proposeConfig` has already excluded every model with no proposable ceiling,
 * so `defaultEffortCeiling` cannot return null here.
 */
function carryCeiling(
  vendor: Vendor,
  ranked: RankedModel,
  prior: Effort | undefined,
  resetChoices: string[],
): Effort {
  const proposed = defaultEffortCeiling(ranked.allowedEfforts);
  if (proposed === null) {
    throw new ConfigValidationError([
      `${vendor}: model ${JSON.stringify(ranked.model.id)} reports no effort level brigadier can propose`,
    ]);
  }
  if (prior === undefined) {
    return proposed;
  }
  if (ranked.allowedEfforts.includes(prior)) {
    return prior;
  }
  resetChoices.push(
    `${vendor}: model "${ranked.model.id}" no longer reports effort "${prior}"; ceiling lowered to "${proposed}"`,
  );
  return proposed;
}

/** Selectable models only, best first, ties broken by discovery order. */
export function rankModels(
  models: readonly DiscoveredModel[],
): readonly RankedModel[] {
  return models
    .filter((model) => model.selectable)
    .map((model, index) => ({ ...score(model), index }))
    .sort((left, right) =>
      left.score === right.score
        ? left.index - right.index
        : right.score - left.score,
    )
    .map(({ model, score: value, rationale, allowedEfforts }) => ({
      model,
      score: value,
      rationale,
      allowedEfforts,
    }));
}

function score(model: DiscoveredModel): RankedModel {
  const rule = COMPETENCE_TABLE.find((entry) => entry.pattern.test(model.id));
  return {
    model,
    score: rule?.score ?? UNRANKED_SCORE,
    rationale: rule?.rationale ?? UNRANKED_RATIONALE,
    allowedEfforts: narrowEfforts(model.supportedEfforts),
  };
}

/** Replaces a vendor's default model, re-validating against its model list. */
export function withDefaultModel(
  config: BrigadierConfig,
  vendor: Vendor,
  modelId: string,
): BrigadierConfig {
  return mapVendor(config, vendor, (entry) => ({
    ...entry,
    defaultModel: modelId,
  }));
}

/**
 * Replaces a vendor's quota fallback. `null` means fail the slice instead.
 * A model absent from the vendor's discovered list is rejected.
 */
export function withQuotaFallback(
  config: BrigadierConfig,
  vendor: Vendor,
  modelId: string | null,
): BrigadierConfig {
  return mapVendor(config, vendor, (entry) => ({
    ...entry,
    quotaFallbackModel: modelId,
  }));
}

/** Replaces one model's effort ceiling. */
export function withEffortCeiling(
  config: BrigadierConfig,
  vendor: Vendor,
  modelId: string,
  ceiling: Effort,
): BrigadierConfig {
  return mapVendor(config, vendor, (entry) => {
    if (!entry.models.some((model) => model.id === modelId)) {
      throw new ConfigValidationError([
        `${vendor}: effort ceiling requested for ${JSON.stringify(modelId)}, which is not one of this vendor's available models`,
      ]);
    }
    return {
      ...entry,
      models: entry.models.map((model) =>
        model.id === modelId ? { ...model, effortCeiling: ceiling } : model,
      ),
    };
  });
}

export function withSecretsConsent(
  config: BrigadierConfig,
  consent: boolean,
): BrigadierConfig {
  return parseConfig({ ...config, secretsConsent: consent });
}

function mapVendor(
  config: BrigadierConfig,
  vendor: Vendor,
  transform: (entry: VendorConfig) => VendorConfig,
): BrigadierConfig {
  if (!config.vendors.some((entry) => entry.vendor === vendor)) {
    throw new ConfigValidationError([
      `no configuration for vendor ${JSON.stringify(vendor)}`,
    ]);
  }
  return parseConfig({
    ...config,
    vendors: config.vendors.map((entry) =>
      entry.vendor === vendor ? transform(entry) : entry,
    ),
  });
}
