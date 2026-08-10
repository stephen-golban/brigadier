/**
 * The MCP tool surface: exactly what brigadier can do today, and nothing that
 * merely sounds like something it could do.
 *
 * Three tools, ordered by how much they touch:
 *
 *   `brigadier_validate_plan`  pure. Shape, schedulability, and the waves.
 *   `brigadier_route_plan`     one config read. Who would take each slice.
 *   `brigadier_run`            the real thing: worktrees, workers, commits.
 *
 * There is no `brigadier_plan` tool in this protocol surface. The CLI can turn a
 * task description into a plan, but MCP clients submit plan documents to these
 * three tools; task-to-plan is not part of this MCP contract.
 *
 * The two impure tools reach the outside world through injected functions, so
 * every assertion in `test/mcp.test.ts` about framing, dispatch, and the two
 * pure tools runs against the real implementation, and only the part that would
 * spawn `claude` is ever replaced.
 */

import type { BrigadierConfig } from "../config/contracts.js";
import { validatePlan } from "../plan/validate.js";
import type { RoutedWorker, RoutingDecision } from "../routing/contracts.js";
import { route } from "../routing/router.js";
import { buildCapabilities } from "../supervisor/capabilities.js";
import type { PlanDocument } from "../supervisor/contracts.js";
import {
  PlanDocumentError,
  parsePlanDocument,
} from "../supervisor/plan-document.js";
import type { ToolDefinition, ToolResult } from "./protocol.js";

/** The machine's config, and where it was looked for whether or not it existed. */
export interface LoadedConfig {
  readonly path: string;
  readonly config: BrigadierConfig | null;
}

/** Everything `brigadier_run` needs, already parsed and defaulted. */
export interface McpRunRequest {
  readonly document: PlanDocument;
  readonly repositoryPath: string;
  readonly slug: string;
  readonly maxWorkers: number;
  readonly dryRun: boolean;
  readonly unsafeInPlace: boolean;
}

export interface ToolDependencies {
  loadConfig(): Promise<LoadedConfig>;
  execute(request: McpRunRequest): Promise<ToolResult>;
}

/**
 * The slug rule, which is `GitWorktreeEngine.validateSlug`'s and is repeated
 * here rather than imported because the CLI's own copy in `src/init/index.ts` is
 * private to that module. If this pattern and that one ever disagree, the engine
 * is right and both callers are wrong.
 */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `brigadier run` defaults concurrency to 1 and this does too. Fan-out is
 * earned: a client that wants three workers says three.
 */
const DEFAULT_MAX_WORKERS = 1;

const PLAN_SCHEMA = {
  type: "object",
  description:
    "A brigadier plan document. Every slice requires id, title, prompt, ownedPaths, and difficulty (routine | standard | hard, with no default). requires is optional. dependsOn is optional and names prerequisite slice ids. Dependency waves are reconciled before later worktrees are created, so a dependent slice sees its prerequisites' committed output. Unknown ids, self-dependencies, and cycles are refused.",
  properties: {
    id: { type: "string" },
    goal: { type: "string" },
    slices: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          prompt: { type: "string" },
          ownedPaths: { type: "array", items: { type: "string" } },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description:
              "Prerequisite slice ids. Each prerequisite wave is reconciled before this slice's worktree is created.",
          },
          difficulty: { enum: ["routine", "standard", "hard"] },
          requires: {
            type: "object",
            properties: {
              imageInput: { type: "boolean" },
              webSearch: { type: "boolean" },
              structuredOutput: { type: "boolean" },
              minContextWindowTokens: { type: "integer" },
            },
          },
        },
        required: ["id", "title", "prompt", "ownedPaths", "difficulty"],
      },
    },
  },
  required: ["id", "goal", "slices"],
} as const;

export function createTools(
  dependencies: ToolDependencies,
): readonly ToolDefinition[] {
  return [
    {
      name: "brigadier_validate_plan",
      description:
        "Check a brigadier plan document for shape defects and scheduling defects, and report the dependency waves it would run in. Touches nothing.",
      inputSchema: {
        type: "object",
        properties: { plan: PLAN_SCHEMA },
        required: ["plan"],
      },
      handle: (args) => Promise.resolve(validateTool(args)),
    },
    {
      name: "brigadier_route_plan",
      description:
        "Report which vendor, model, and effort this machine would give each slice of a plan, or why no model can take it. Creates no worktree and spawns no worker.",
      inputSchema: {
        type: "object",
        properties: { plan: PLAN_SCHEMA },
        required: ["plan"],
      },
      handle: (args) => routeTool(args, dependencies),
    },
    {
      name: "brigadier_run",
      description:
        "Run a brigadier plan on a local repository: route every slice, spawn a worker for each, commit what it produced, and merge the lot.",
      inputSchema: {
        type: "object",
        properties: {
          plan: PLAN_SCHEMA,
          repositoryPath: {
            type: "string",
            description:
              "Non-empty string naming the git repository to run in.",
          },
          slug: {
            type: "string",
            description:
              "Names every ref this run creates. Defaults to the plan id, made branch-safe.",
          },
          maxWorkers: { type: "integer", minimum: 1 },
          dryRun: {
            type: "boolean",
            description:
              "Route every slice and report it; create no worktree, spawn no worker, write no commit.",
          },
          unsafeInPlace: {
            type: "boolean",
            description:
              "Run workers in the checkout itself instead of isolated worktrees. Every file there becomes visible to every worker.",
          },
        },
        required: ["plan", "repositoryPath"],
      },
      handle: (args) => runTool(args, dependencies),
    },
  ];
}

/* ------------------------------------------------------------------------ */
/* brigadier_validate_plan                                                   */
/* ------------------------------------------------------------------------ */

function validateTool(args: unknown): ToolResult {
  const parsed = parseDocument(args);
  if (!parsed.ok) {
    return { text: parsed.text, isError: true };
  }
  const { document } = parsed;

  const validation = validatePlan(document.plan);
  if (!validation.ok) {
    const lines = [
      `plan ${document.plan.id} cannot be scheduled (${validation.issues.length} issue(s)):`,
    ];
    for (const issue of validation.issues) {
      lines.push(`  ${issue.code}: ${issue.message}`);
    }
    return { text: lines.join("\n"), isError: true };
  }

  const lines = [
    `plan ${document.plan.id} is valid: ${document.plan.slices.length} slice(s) in ${validation.waves.length} wave(s).`,
  ];
  for (const [index, wave] of validation.waves.entries()) {
    lines.push(`  wave ${index + 1}: ${wave.join(", ")}`);
  }
  return { text: lines.join("\n"), isError: false };
}

/* ------------------------------------------------------------------------ */
/* brigadier_route_plan                                                      */
/* ------------------------------------------------------------------------ */

/**
 * THE QUOTA CAVEAT IS PRINTED, NOT HIDDEN. This tool routes against an empty
 * quota snapshot, which the pipeline reads as "unknown" and therefore as
 * available. A drained model is not avoided here. That is the same trade
 * `brigadier run` makes for Codex today, and a user comparing this tool's answer
 * to a real run needs to be told rather than left to discover it.
 */
async function routeTool(
  args: unknown,
  dependencies: ToolDependencies,
): Promise<ToolResult> {
  const parsed = parseDocument(args);
  if (!parsed.ok) {
    return { text: parsed.text, isError: true };
  }
  const { document } = parsed;

  const loaded = await dependencies.loadConfig();
  if (loaded.config === null) {
    return {
      text: `no brigadier config was found at ${loaded.path}. Run \`brigadier init\` on this machine to scan for worker CLIs and write one.`,
      isError: true,
    };
  }

  const capabilities = buildCapabilities(loaded.config);
  const lines = [
    `plan ${document.plan.id}: ${document.plan.slices.length} slice(s) routed against this machine's config.`,
    "no quota snapshot is read here, so a drained model is not avoided; a real run learns that from the worker and escalates.",
  ];
  let anyFailed = false;
  for (const [index, slice] of document.plan.slices.entries()) {
    const directive = document.directives[index];
    if (directive === undefined) {
      // `parsePlanDocument` emits one directive per slice, in slice order. This
      // is unreachable through it, and a hand-built document is not supported.
      anyFailed = true;
      lines.push(
        `  ${slice.id}  unrouted  NO_DIRECTIVE: the plan document is misaligned`,
      );
      continue;
    }
    const decision = route(
      {
        slice,
        difficulty: directive.difficulty,
        ...(directive.requires === undefined
          ? {}
          : { requires: directive.requires }),
      },
      { config: loaded.config, capabilities, quota: [] },
    );
    if (!decision.ok) {
      anyFailed = true;
    }
    for (const line of describeDecision(slice.id, decision)) {
      lines.push(line);
    }
  }
  return { text: lines.join("\n"), isError: anyFailed };
}

function describeDecision(
  sliceId: string,
  decision: RoutingDecision,
): readonly string[] {
  if (decision.ok) {
    return [`  ${sliceId}  ${describeRouted(decision.routed)}`];
  }
  const lines = [
    `  ${sliceId}  unrouted  ${decision.reason}: ${decision.message}`,
  ];
  for (const rejection of decision.rejected) {
    lines.push(
      `    rejected ${rejection.vendor}/${rejection.model} [${rejection.stage}]: ${rejection.reason}`,
    );
  }
  return lines;
}

function describeRouted(routed: RoutedWorker): string {
  const waived = routed.waivedDifficultyFloor
    ? " (below this slice's difficulty floor; allowDegradedRouting is on)"
    : "";
  return `${routed.vendor}/${routed.model} effort=${routed.effort}${waived}`;
}

/* ------------------------------------------------------------------------ */
/* brigadier_run                                                             */
/* ------------------------------------------------------------------------ */

async function runTool(
  args: unknown,
  dependencies: ToolDependencies,
): Promise<ToolResult> {
  const record = asRecord(args);
  if (record === null) {
    return { text: "arguments must be an object", isError: true };
  }
  const parsed = parseDocument(args);
  if (!parsed.ok) {
    return { text: parsed.text, isError: true };
  }
  const { document } = parsed;

  const repositoryPath = record.repositoryPath;
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0) {
    return {
      text: "repositoryPath must be a non-empty string naming the git repository to run in",
      isError: true,
    };
  }

  const slug = resolveSlug(record.slug, document.plan.id);
  if (slug === null) {
    return {
      text: `no branch-safe slug is available: pass slug explicitly (letters, digits, dots, underscores, and hyphens, starting with a letter or digit), because none can be derived from plan id ${JSON.stringify(document.plan.id)}`,
      isError: true,
    };
  }

  const maxWorkers = readMaxWorkers(record.maxWorkers);
  if (maxWorkers === null) {
    return {
      text: "maxWorkers must be a positive whole number",
      isError: true,
    };
  }

  return await dependencies.execute({
    document,
    repositoryPath,
    slug,
    maxWorkers,
    dryRun: record.dryRun === true,
    unsafeInPlace: record.unsafeInPlace === true,
  });
}

/**
 * An explicit slug is taken as given or refused; an absent one is derived from
 * the plan id exactly as `brigadier run` derives it. Never substituted silently:
 * the slug names every ref the run creates, so two plans sharing a fallback
 * would collide on one set of branches.
 */
function resolveSlug(value: unknown, planId: string): string | null {
  if (typeof value === "string" && value.length > 0) {
    return SLUG_PATTERN.test(value) ? value : null;
  }
  const derived = planId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  return SLUG_PATTERN.test(derived) ? derived : null;
}

function readMaxWorkers(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_MAX_WORKERS;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/* ------------------------------------------------------------------------ */
/* shared                                                                    */
/* ------------------------------------------------------------------------ */

type ParsedDocument =
  | { readonly ok: true; readonly document: PlanDocument }
  | { readonly ok: false; readonly text: string };

/**
 * Every issue at once, never the first one. `parsePlanDocument` collects the
 * whole repair precisely so a caller fixes a plan in one pass, and a tool that
 * reported one line at a time would spend a model turn per defect.
 */
function parseDocument(args: unknown): ParsedDocument {
  const record = asRecord(args);
  if (record === null) {
    return { ok: false, text: "arguments must be an object" };
  }
  try {
    return { ok: true, document: parsePlanDocument(record.plan) };
  } catch (error) {
    if (error instanceof PlanDocumentError) {
      const lines = [
        `plan document is not valid (${error.issues.length} issue(s)):`,
      ];
      for (const issue of error.issues) {
        lines.push(`  ${issue}`);
      }
      return { ok: false, text: lines.join("\n") };
    }
    return {
      ok: false,
      text: `could not read the plan: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}
