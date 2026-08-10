/**
 * Static capability facts used to bridge persisted config into the router.
 *
 * A positive boolean needs local evidence. Under uncertainty the value is
 * `false`: requirements remove models, so "brigadier has no evidence" must
 * never become "yes". Numeric unknowns stay `null` for the same reason.
 *
 * Sources, verified 2026-08-08:
 *
 * - `codex debug models` supplies every Codex model id, reasoning ladder,
 *   `input_modalities`, and `context_window` below. It supplies no maximum
 *   output-token value and no structured-output capability.
 * - `claude --help` supplies `low|medium|high|xhigh|max` as the Claude CLI
 *   effort ladder. The committed `CLAUDE_STATIC_MODELS` supplies the four
 *   exact Claude ids. Neither source supplies their context or output limits,
 *   or establishes image input through brigadier's worker contract.
 * - `buildClaudeCommand` disallows `WebFetch,WebSearch`; `buildCodexCommand`
 *   sets `network={enabled=false}`. Web search is therefore false even where a
 *   raw model catalog advertises a search tool.
 * - Neither worker command exposes its CLI's schema option, so structured
 *   output is false for the configured workers rather than inferred from a
 *   model's general API surface.
 *
 * Rules are exact and anchored deliberately. A future model must earn a row in
 * a reviewed diff; a similar name is not evidence that its facts are the same.
 */

import {
  type BrigadierConfig,
  EFFORT_LADDER,
  narrowEfforts,
} from "../config/contracts.js";
import type { Capability, Effort, Vendor } from "../contracts.js";

/** A vendor/model-id pattern plus the capability facts emitted for a match. */
interface CapabilityRule {
  readonly vendor: Vendor;
  readonly pattern: RegExp;
  readonly supportedEfforts: readonly Effort[];
  readonly supportsImageInput: boolean;
  readonly supportsWebSearch: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
}

const STANDARD_EFFORTS = Object.freeze(
  narrowEfforts(["low", "medium", "high", "xhigh", "max", "ultra"]),
);

/**
 * Auditable capability facts. Each member and its shared effort list are
 * frozen because callers read this exported table directly at runtime.
 */
export const CAPABILITY_TABLE: readonly CapabilityRule[] = Object.freeze([
  Object.freeze({
    vendor: "claude",
    pattern: /^claude-(?:opus-5|fable-5|sonnet-5|haiku-4-5-20251001)$/i,
    supportedEfforts: STANDARD_EFFORTS,
    supportsImageInput: false,
    supportsWebSearch: false,
    supportsStructuredOutput: false,
    contextWindowTokens: null,
    maxOutputTokens: null,
  }),
  Object.freeze({
    vendor: "codex",
    pattern:
      /^(?:gpt-5\.6-(?:sol(?:-wm)?|terra|luna)|gpt-5\.5|gpt-5\.4(?:-mini)?|codex-auto-review)$/i,
    supportedEfforts: STANDARD_EFFORTS,
    supportsImageInput: true,
    supportsWebSearch: false,
    supportsStructuredOutput: false,
    contextWindowTokens: 272_000,
    maxOutputTokens: null,
  }),
  Object.freeze({
    vendor: "codex",
    pattern: /^gpt-5\.3-codex-spark$/i,
    supportedEfforts: STANDARD_EFFORTS,
    supportsImageInput: false,
    supportsWebSearch: false,
    supportsStructuredOutput: false,
    contextWindowTokens: 128_000,
    maxOutputTokens: null,
  }),
]);

/** The first rule for an exact vendor/model pair, or null when none is known. */
export function matchCapabilityRule(
  vendor: Vendor,
  modelId: string,
): CapabilityRule | null {
  return (
    CAPABILITY_TABLE.find(
      (rule) => rule.vendor === vendor && rule.pattern.test(modelId),
    ) ?? null
  );
}

/**
 * Builds records only for models persisted in this machine's config.
 *
 * An unmatched configured model emits no record. That preserves the router's
 * actionable "no capability record" verdict; fabricating an all-false record
 * would instead assert unsupported features that brigadier has not established.
 */
export function buildCapabilities(
  config: BrigadierConfig,
): readonly Capability[] {
  const capabilities = config.vendors.flatMap((vendor) =>
    vendor.models.flatMap((model) => {
      const rule = matchCapabilityRule(vendor.vendor, model.id);
      if (rule === null) {
        return [];
      }
      return [
        Object.freeze({
          vendor: vendor.vendor,
          model: model.id,
          supportedEfforts: effortsThroughCeiling(
            rule.supportedEfforts,
            model.effortCeiling,
          ),
          supportsImageInput: rule.supportsImageInput,
          supportsWebSearch: rule.supportsWebSearch,
          supportsStructuredOutput: rule.supportsStructuredOutput,
          contextWindowTokens: rule.contextWindowTokens,
          maxOutputTokens: rule.maxOutputTokens,
        }),
      ];
    }),
  );
  return Object.freeze(capabilities);
}

function effortsThroughCeiling(
  supportedEfforts: readonly string[],
  effortCeiling: Effort,
): readonly Effort[] {
  const ceilingIndex = EFFORT_LADDER.indexOf(effortCeiling);
  return Object.freeze(
    narrowEfforts(supportedEfforts).filter(
      (effort) => EFFORT_LADDER.indexOf(effort) <= ceilingIndex,
    ),
  );
}
