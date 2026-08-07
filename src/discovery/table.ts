/**
 * The static model table.
 *
 * Codex enumerates its own catalog (`codex debug models`), so it needs no
 * entry here. Claude has no enumeration surface at all: there is no
 * `claude debug models`, no `claude models`, no `--list-models`. Its help text
 * documents `--model <model>` and `--effort <level>` but never lists the
 * models, and the only way to enumerate them would be to start a billable
 * turn — which discovery must never do.
 *
 * So this file is the thing that gets edited when Anthropic ships a model.
 * Everything in it is transcribed from a source that can be re-checked without
 * spending money:
 *
 * - Effort levels come from `claude --help`, which prints
 *   "--effort <level>  Effort level for the current session
 *    (low, medium, high, xhigh, max)". Verified 2026-08-06, Claude Code
 *   2.1.224.
 * - Model IDs are the current Anthropic model identifiers. `claude --model`
 *   also accepts short aliases ("opus", "sonnet", "haiku", "fable"), which
 *   float to the latest model in a family; the table carries the pinned IDs so
 *   a recorded brigadier configuration keeps meaning the same model. Where a
 *   model has a dated identifier it is used, because the undated form floats.
 *   `claude-opus-5`, `claude-fable-5`, and `claude-sonnet-5` have no dated
 *   form — those strings are the complete IDs, and appending a date to one
 *   would produce an identifier the API rejects.
 *
 * `defaultEffort` is null throughout: the Claude CLI declares supported effort
 * levels but does not declare which one it defaults to, and `DiscoveredModel`
 * documents that field as the *vendor-declared* default. Inventing one here
 * would launder a guess into a reported fact.
 */

import type { DiscoveredModel } from "./contracts.js";

/** Every effort level `claude --effort` documents. Superset of brigadier's own. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Models brigadier offers for the Claude vendor, newest family first. */
export const CLAUDE_STATIC_MODELS: readonly DiscoveredModel[] = [
  claudeModel("claude-opus-5", "Claude Opus 5"),
  claudeModel("claude-fable-5", "Claude Fable 5"),
  claudeModel("claude-sonnet-5", "Claude Sonnet 5"),
  claudeModel("claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
];

function claudeModel(id: string, displayName: string): DiscoveredModel {
  return {
    id,
    displayName,
    supportedEfforts: CLAUDE_EFFORTS,
    defaultEffort: null,
    selectable: true,
  };
}
