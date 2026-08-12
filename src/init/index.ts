/**
 * `brigadier init`: probe, propose, confirm, write.
 *
 * The command takes its `Discoverer`, its environment, and its streams by
 * injection, so the whole flow runs against a fake report, a scripted stdin,
 * and a scratch `$BRIGADIER_HOME` with no binary, no terminal, and no real
 * home directory involved.
 *
 * The CLI dispatch lives here rather than in `src/cli.ts` because `src/cli.ts`
 * must stay a side-effecting executable shim: `bin/brigadier.js` runs it with a
 * bare `import`, so it cannot also be an importable module for tests.
 */

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type {
  BrigadierConfig,
  ConfigEnvironment,
  ConfigIo,
  VendorConfig,
} from "../config/index.js";
import {
  ConfigValidationError,
  readConfig,
  resolveConfigPath,
  serializeConfig,
  writeConfig,
} from "../config/index.js";
import type { AnyWorker, Effort, Vendor } from "../contracts.js";
import type { Discoverer, DiscoveryReport } from "../discovery/contracts.js";
import { type McpRunControl, runMcpServer } from "../mcp/server.js";
import type { Planner, PlannerOutcome } from "../planner/index.js";
import { createModelPlanner } from "../planner/index.js";
import { createClaudeQuotaOracle } from "../quota/index.js";
import type { RoutedWorker } from "../routing/index.js";
// Imported from the module rather than the barrel on purpose: the interrupt
// helpers are CLI plumbing, not supervisor API, and `src/index.ts` re-exports
// the supervisor barrel wholesale.
import type {
  InterruptSignal,
  RunInterruption,
} from "../supervisor/contracts.js";
import { interruptExitCode } from "../supervisor/contracts.js";
import type {
  LaunchEnv,
  RunnerDependencies,
  RunReport,
  RunRequest,
  SliceAttempt,
  SliceResult,
  SliceRunner,
  SupervisorPorts,
} from "../supervisor/index.js";
import {
  buildCapabilities,
  createRunner,
  createSliceRunner,
  PlanDocumentError,
  parsePlanDocument,
  requireLaunchEnv,
} from "../supervisor/index.js";
import { runInstall } from "../surfaces/install.js";
import { createClaudeWorker, createCodexWorker } from "../worker/index.js";
// Direct-module import on purpose: planning plumbing needs the read-only seam,
// but it is not part of the package's public worktree API.
import { createSecretRedactor } from "../worktree/engine.js";
import type { MergeResult, WorktreeEngine } from "../worktree/index.js";
import { GitWorktreeEngine } from "../worktree/index.js";
import type { InputStream, OutputStream, PromptIo } from "./prompt.js";
import {
  confirmPrompt,
  LineReader,
  selectPrompt,
  textPrompt,
} from "./prompt.js";
import type {
  DroppedVendor,
  Proposal,
  RankedModel,
  VendorProposal,
} from "./propose.js";
import {
  proposeConfig,
  withDefaultModel,
  withDegradedRouting,
  withEffortCeiling,
  withLinkedSecretPaths,
  withSecretsConsent,
} from "./propose.js";

/**
 * The degraded-routing question, asked once for the whole config.
 *
 * The wording is the whole point. An earlier version asked "When claude
 * quota drains, fall back to:" and offered a model list — a description of a
 * capability that no longer exists, since per-model quota metering means a
 * drained tier leaves its healthy siblings competing in the ordinary pipeline
 * on merit. What configuring a fallback actually did by then was authorize the
 * difficulty-floor waiver, so that is what is asked here, in those terms.
 */
export const DEGRADED_ROUTING_QUESTION =
  "If no model on this machine meets a slice's difficulty bar, run the slice on a weaker model instead of failing it?";

/** The documented warning, shown before any ceiling is raised. */
export const EFFORT_CEILING_WARNING =
  "Warning: above `high`, models take longer, burn more tokens, hallucinate more, and do worse work.";

/** The ceiling is a cap, not a pin, and xhigh stays earned. */
const EFFORT_CEILING_NOTE =
  "`xhigh` stays earned-on-retry regardless of this ceiling: brigadier reaches for it only after a routed model runs the slice and fails. A routing failure, where no model ran, does not earn it. Effort is never pinned per task tier.";

/** The routing rules, said out loud so the config is not mistaken for a router. */
const ROUTER_NOTE =
  "This config layers on top of brigadier's router: it records which models are permitted and how high their effort may go. Routing still filters by capability, ranks by competence, then weighs difficulty, effort, and cost. Vendor is never a routing input.";

const LINKED_SECRET_PATHS_QUESTION =
  "Secret file paths as a JSON array of repository-relative strings:";

const LINKED_SECRET_PATH_ATTEMPTS = 3;

export interface InitOptions {
  readonly discoverer: Discoverer;
  readonly env: ConfigEnvironment;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  /** Omitted for a non-interactive run. */
  readonly stdin?: InputStream;
  /** Accept every proposed default without prompting. */
  readonly assumeYes: boolean;
  /** Print the resolved config as JSON and exit without writing. */
  readonly printConfig: boolean;
  readonly io?: ConfigIo;
}

/** Runs `brigadier init` and resolves the process exit code. */
export async function runInit(options: InitOptions): Promise<number> {
  const { stdout, stderr } = options;

  let configPath: string;
  try {
    configPath = resolveConfigPath(options.env);
  } catch (error) {
    stderr.write(`brigadier init: ${describe(error)}\n`);
    return 1;
  }

  let report: DiscoveryReport;
  try {
    report = await options.discoverer.discover();
  } catch (error) {
    stderr.write(`brigadier init: discovery failed: ${describe(error)}\n`);
    return 1;
  }

  const existing = await loadExisting(configPath, options.io, stderr);

  // `DiscoveryReport` is data from outside this process; nothing in its type
  // stops a vendor (or a future discoverer) from handing over a shape the
  // config schema rejects. A diagnostic and exit 1 is the contract here, never
  // a stack trace out of `main`.
  let proposal: Proposal;
  try {
    proposal = proposeConfig(report, existing);
  } catch (error) {
    stderr.write(
      `brigadier init: could not build a configuration from the discovery report: ${describe(error)}\n`,
    );
    return 1;
  }
  const quiet = options.printConfig;

  if (!quiet) {
    renderReport(stdout, report, configPath, existing !== null);
  }
  reportNotices(proposal, quiet ? stderr : stdout);

  if (proposal.vendors.length === 0) {
    if (quiet) {
      stdout.write(serializeConfig(proposal.config));
      return 0;
    }
    stderr.write(
      "brigadier init: no installed worker CLI reported a selectable model. Install Claude Code or Codex, then re-run `brigadier init`.\n",
    );
    return 1;
  }

  if (!quiet) {
    renderProposal(stdout, proposal);
  }

  let config = proposal.config;
  const interactive =
    !options.assumeYes && !quiet && options.stdin !== undefined;
  if (interactive && options.stdin !== undefined) {
    const io: PromptIo = {
      reader: new LineReader(options.stdin),
      output: stdout,
    };
    config = await confirmInteractively(io, proposal, config);
  } else if (!quiet) {
    stdout.write("\nAccepting every proposed default (--yes).\n");
  }

  if (quiet) {
    stdout.write(serializeConfig(config));
    return 0;
  }

  try {
    await writeConfig(configPath, config, options.io);
  } catch (error) {
    stderr.write(
      `brigadier init: could not write config: ${describe(error)}\n`,
    );
    return 1;
  }
  stdout.write(`\nWrote ${configPath}\n`);
  return 0;
}

async function loadExisting(
  configPath: string,
  io: ConfigIo | undefined,
  stderr: OutputStream,
): Promise<BrigadierConfig | null> {
  try {
    return io === undefined
      ? await readConfig(configPath)
      : await readConfig(configPath, io);
  } catch (error) {
    stderr.write(
      `brigadier init: ignoring the existing config at ${configPath} because it could not be read: ${describe(error)}\n`,
    );
    return null;
  }
}

function renderReport(
  stdout: OutputStream,
  report: DiscoveryReport,
  configPath: string,
  hasExisting: boolean,
): void {
  stdout.write("brigadier init\n\n");
  stdout.write(`Config path: ${configPath}\n`);
  stdout.write(
    hasExisting
      ? "An existing config was found; its values are shown as the defaults below.\n"
      : "No existing config was found.\n",
  );
  stdout.write("\nInstalled worker CLIs\n");

  if (report.vendors.length === 0) {
    stdout.write("  (none found)\n");
  }
  for (const vendor of report.vendors) {
    const selectable = vendor.models.filter((model) => model.selectable).length;
    stdout.write(
      `  ${vendor.vendor}  v${vendor.version}  ${vendor.executable}\n`,
    );
    stdout.write(
      `      ${vendor.models.length} model(s), ${selectable} selectable  |  catalog: ${vendor.catalogSource}\n`,
    );
  }
  if (report.missing.length > 0) {
    stdout.write(`  not installed: ${report.missing.join(", ")}\n`);
  }
  for (const warning of report.warnings) {
    stdout.write(
      `  warning [${warning.vendor}/${warning.cause}]: ${warning.message}\n`,
    );
  }
}

function reportNotices(proposal: Proposal, out: OutputStream): void {
  for (const vendor of proposal.vendorsWithoutModels) {
    out.write(
      `  note: ${vendor} is installed but reported no model brigadier can drive; it is not being configured.\n`,
    );
  }
  for (const unusable of proposal.unusableModels) {
    out.write(
      `  note: ${unusable.vendor}: model "${unusable.modelId}" is not being offered because ${unusable.reason}.\n`,
    );
  }
  for (const dropped of proposal.droppedVendors) {
    out.write(
      `  note: ${dropped.vendor} is in your existing config but ${describeDropped(dropped.reason)}; its settings are not being carried forward.\n`,
    );
  }
  for (const reset of proposal.resetChoices) {
    out.write(`  note: ${reset}\n`);
  }
}

/**
 * Never says "not found" for a vendor whose version and path were printed in
 * the report a few lines above. The three reasons are distinguishable and the
 * user's next move differs for each: reinstall, upgrade, or look at the warning.
 */
function describeDropped(reason: DroppedVendor["reason"]): string {
  switch (reason) {
    case "not-installed":
      return "was not found on this machine";
    case "not-usable":
      return "reported no model brigadier can drive on this machine";
    case "probe-failed":
      return "could not be probed on this machine";
  }
}

function renderProposal(stdout: OutputStream, proposal: Proposal): void {
  stdout.write("\nProposed model mapping\n");
  for (const vendor of proposal.vendors) {
    stdout.write(`\n  ${vendor.vendor}\n`);
    stdout.write(
      `    default model:  ${vendor.config.defaultModel}  (${vendor.defaultModelRationale})\n`,
    );
    for (const model of vendor.config.models) {
      const ranked = vendor.ranked.find((entry) => entry.model.id === model.id);
      stdout.write(
        `    ${model.id}: ceiling ${model.effortCeiling}${describeAllowed(ranked)}\n`,
      );
    }
  }
  stdout.write(
    `\n  secrets consent: ${proposal.config.secretsConsent ? "yes" : "no"}\n`,
  );
  stdout.write(
    `  linked secret paths: ${proposal.config.linkedSecretPaths.length === 0 ? "(none)" : proposal.config.linkedSecretPaths.join(", ")}\n`,
  );
  stdout.write(
    `  run below-difficulty models rather than fail: ${proposal.config.allowDegradedRouting ? "yes" : "no"}\n`,
  );
  stdout.write(`\n${ROUTER_NOTE}\n`);
}

/**
 * Every proposed model reports at least one brigadier rung — `proposeConfig`
 * excludes the rest — so an empty list here can only mean the ranked entry was
 * not found at all.
 */
function describeAllowed(ranked: RankedModel | undefined): string {
  if (ranked === undefined) {
    return "";
  }
  return `  (vendor supports ${ranked.allowedEfforts.join(", ")})`;
}

async function promptLinkedSecretPaths(
  io: PromptIo,
  config: BrigadierConfig,
): Promise<BrigadierConfig> {
  const defaultValue = JSON.stringify(config.linkedSecretPaths);
  for (let attempt = 0; attempt < LINKED_SECRET_PATH_ATTEMPTS; attempt += 1) {
    const answer = await textPrompt(
      io,
      LINKED_SECRET_PATHS_QUESTION,
      defaultValue,
    );
    let value: unknown;
    try {
      value = JSON.parse(answer);
    } catch {
      io.output.write("  Enter a JSON array of strings.\n");
      continue;
    }
    if (
      !Array.isArray(value) ||
      !value.every((path) => typeof path === "string")
    ) {
      io.output.write("  Enter a JSON array of strings.\n");
      continue;
    }
    try {
      return withLinkedSecretPaths(config, value);
    } catch (error) {
      if (!(error instanceof ConfigValidationError)) {
        throw error;
      }
      io.output.write(`  ${error.message}\n`);
    }
  }
  io.output.write("  Keeping the current linked secret paths.\n");
  return config;
}

async function confirmInteractively(
  io: PromptIo,
  proposal: Proposal,
  initial: BrigadierConfig,
): Promise<BrigadierConfig> {
  let config = initial;
  for (const vendor of proposal.vendors) {
    io.output.write(`\n${vendor.vendor}\n`);
    const accepted = await confirmPrompt(
      io,
      `  Use ${current(config, vendor.vendor).defaultModel} as the default model for ${vendor.vendor}?`,
      true,
    );
    if (!accepted) {
      const chosen = await selectPrompt(
        io,
        `  Default model for ${vendor.vendor}:`,
        vendor.ranked.map((entry) => ({
          label: entry.model.id,
          value: entry.model.id,
          detail: `${entry.model.displayName} · ${entry.rationale}`,
        })),
        indexOfModel(
          vendor.ranked,
          current(config, vendor.vendor).defaultModel,
        ),
      );
      config = withDefaultModel(config, vendor.vendor, chosen);
    }

    config = await promptEffortCeilings(io, vendor, config);
  }

  // Asked once, after the per-vendor questions, because it is not a per-vendor
  // setting. Default No on a fresh config, matching the config default and
  // the original spirit that brigadier never silently substitutes;
  // on a re-run the current value is the default, so an existing yes is not
  // discarded by pressing enter.
  const degraded = await confirmPrompt(
    io,
    DEGRADED_ROUTING_QUESTION,
    config.allowDegradedRouting,
  );
  config = withDegradedRouting(config, degraded);

  // Default No on a fresh config. On a re-run the current value is
  // the default, so an existing yes is not silently discarded by pressing enter.
  const consent = await confirmPrompt(
    io,
    "Allow brigadier to link secret files (for example .env) into worker worktrees?",
    config.secretsConsent,
  );
  config = withSecretsConsent(config, consent);
  if (!consent) {
    return withLinkedSecretPaths(config, []);
  }
  return promptLinkedSecretPaths(io, config);
}

async function promptEffortCeilings(
  io: PromptIo,
  vendor: VendorProposal,
  config: BrigadierConfig,
): Promise<BrigadierConfig> {
  io.output.write(`\n  ${EFFORT_CEILING_WARNING}\n`);
  io.output.write(`  ${EFFORT_CEILING_NOTE}\n`);
  const change = await confirmPrompt(
    io,
    `  Change any per-model effort ceiling for ${vendor.vendor}? (default is high)`,
    false,
  );
  if (!change) {
    return config;
  }

  let next = config;
  for (const ranked of vendor.ranked) {
    // Only rungs the vendor itself reported. Falling back to the full ladder
    // here would let a user record an effort the vendor rejects.
    const allowed = ranked.allowedEfforts;
    const currentCeiling =
      current(next, vendor.vendor).models.find(
        (model) => model.id === ranked.model.id,
      )?.effortCeiling ?? "high";
    const chosen = await selectPrompt<Effort>(
      io,
      `    Effort ceiling for ${ranked.model.id}:`,
      allowed.map((effort) =>
        effort === "xhigh"
          ? {
              label: effort,
              value: effort,
              detail: "earned on retry only; slower, costlier, and worse work",
            }
          : { label: effort, value: effort },
      ),
      allowed.indexOf(currentCeiling),
    );
    next = withEffortCeiling(next, vendor.vendor, ranked.model.id, chosen);
  }
  return next;
}

function current(config: BrigadierConfig, vendor: Vendor): VendorConfig {
  const entry = config.vendors.find((candidate) => candidate.vendor === vendor);
  if (entry === undefined) {
    throw new ConfigValidationError([
      `no configuration for vendor ${JSON.stringify(vendor)}`,
    ]);
  }
  return entry;
}

function indexOfModel(ranked: readonly RankedModel[], modelId: string): number {
  const index = ranked.findIndex((entry) => entry.model.id === modelId);
  return index >= 0 ? index : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------------ */
/* Command line                                                              */
/* ------------------------------------------------------------------------ */

interface CliOptions {
  /** `process.argv.slice(2)`. */
  readonly argv: readonly string[];
  readonly version: string;
  readonly env: ConfigEnvironment;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly stdin?: InputStream;
  /** Injected in tests; production loads the discovery module on demand. */
  readonly discoverer?: Discoverer;
  /**
   * Injected in tests; production serves MCP over the real process streams.
   *
   * IT EXISTS TO STOP A TEST FROM HANGING. `runMcpServer` reads the real
   * `process.stdin` and resolves only when the client closes the pipe, so a
   * test that reached it would block until the runner was killed — and a test
   * that hangs on broken code never reports the breakage it was written to
   * catch. With this seam, the `mcp` dispatch is provable without a server.
   */
  readonly mcpServer?: (control?: McpRunControl) => Promise<number>;
  readonly io?: ConfigIo;
  /** The repository `run` operates on. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Injected in tests so `run` touches neither git nor a subprocess. */
  readonly harness?: RunHarness;
  /**
   * Stops a run in progress. `src/cli.ts` builds one `AbortController` — inside
   * an `InterruptGate` — and aborts it with a `RunInterruption` from its SIGINT
   * and SIGTERM handlers; tests drive the same controller directly, which is
   * what keeps every assertion about cancellation out of the business of
   * sending real signals to the test process.
   */
  readonly signal?: AbortSignal;
  /**
   * Called at most once, at the exact moment this invocation acquires something
   * an interrupt would have to clean up. See `InterruptGate.arm`.
   *
   * `run` calls it immediately before handing control to the orchestrator;
   * `mcp` calls it immediately before dispatching a run tool. `init` never does,
   * which is the point: `init` creates no
   * worktree and spawns no worker, so a Ctrl-C in it has nothing to wind down
   * and must kill brigadier on the first press.
   */
  readonly onCancellable?: () => void;
}

/**
 * What the shim must do about one interrupt.
 *
 * A value rather than a pair of side effects, so the decision — which is
 * policy — is testable without a real `process` and without a real signal, and
 * the shim is left with only the two things it alone can do: write to the real
 * stderr and exit the real process.
 */
interface InterruptDecision {
  /** Exactly what to write to stderr, newline-terminated on both ends. */
  readonly message: string;
  /** Null to keep running; a number to exit with that code immediately. */
  readonly exitCode: number | null;
}

/**
 * The interrupt policy, minus the signals.
 *
 * REGISTERING A SIGNAL HANDLER DISABLES NODE'S DEFAULT TERMINATION, for the
 * whole life of the process and not merely for the part of it that has workers
 * to kill. That is the trap this type exists to close. `brigadier run --plan -`
 * can sit on a blocking stdin read, config loading, and environment validation
 * long before the orchestrator exists, and `brigadier init` never reaches an
 * orchestrator at all — and in every one of those moments a handler that
 * unconditionally "cancels workers" would swallow the user's first Ctrl-C,
 * announce a cleanup of nothing, and make them press it again. One press used
 * to be enough. It has to stay enough.
 *
 * So the gate starts DISARMED and terminates on the first interrupt, exactly
 * as the default would have. A command arms it at the moment it acquires
 * something an interrupt would have to wind down — for `run`, immediately
 * before control passes to the orchestrator, which is the first instant a
 * worker process or a worktree can exist. From then on the first interrupt is
 * graceful and the second is the escape hatch, because a user who has run out
 * of patience must never be trapped watching a cleanup they cannot escape.
 */
export interface InterruptGate {
  /**
   * Aborted with a `RunInterruption` when a graceful interrupt is accepted.
   * Hand it to `runCli` as `signal`.
   */
  readonly signal: AbortSignal;
  /**
   * Switches this gate from "terminate now" to "cancel, then terminate on the
   * next one". Idempotent, and there is no way back: a run that started is
   * cancellable for the rest of the process's life, because its worktrees are.
   */
  arm(): void;
  /** Records one interrupt and answers what the shim must do about it. */
  interrupt(signal: InterruptSignal): InterruptDecision;
}

export function createInterruptGate(): InterruptGate {
  const controller = new AbortController();
  let armed = false;
  let gracefulInterrupts = 0;
  return {
    signal: controller.signal,
    arm: (): void => {
      armed = true;
    },
    interrupt: (signal: InterruptSignal): InterruptDecision => {
      const reason: RunInterruption = { kind: "interrupt", signal };
      if (!armed) {
        // Nothing is in flight, so there is nothing to say beyond the fact of
        // stopping. Claiming workers were cancelled here would be false, and
        // it is the sentence a user reads while wondering why Ctrl-C did not
        // work.
        return {
          message: `\nbrigadier: ${signal} — exiting\n`,
          exitCode: interruptExitCode(reason),
        };
      }
      gracefulInterrupts += 1;
      if (gracefulInterrupts > 1) {
        return {
          message: `\nbrigadier: ${signal} again — exiting now without finishing cleanup\n`,
          exitCode: interruptExitCode(reason),
        };
      }
      controller.abort(reason);
      return {
        message: `\nbrigadier: ${signal} — cancelling workers and cleaning up; interrupt again to exit immediately\n`,
        exitCode: null,
      };
    },
  };
}

const USAGE = `Usage: brigadier <command> [options]

Commands:
  init                 scan for installed worker CLIs and write a config
  run                  run a task or a plan: decompose it, route every slice,
                       spawn a worker for each, commit what it produced, and
                       merge the lot
  install              write brigadier's host-side doctrine into each host
  mcp                  serve brigadier's tools over stdio MCP

Options for init:
  -y, --yes            accept every proposed default without prompting
      --print-config   print the resolved config as JSON and exit without writing
  -h, --help           print this message

Usage for run:
  brigadier run "<task description>"   plan the task, then run the plan
  brigadier run --plan <file>          run a plan that already exists

Options for run:
      --plan <file>    the plan JSON to run; "-" reads the plan from stdin.
                       Mutually exclusive with a task description
      --max-workers <n>
                       slices to run at once (default 1; fan-out is earned).
                       For a task description this is also the largest number
                       of slices the planner may propose
      --slug <name>    names this run's branches (default: from the plan id)
      --dry-run        plan and route every slice and report it. A task-backed
                       dry run still runs a planner model and costs tokens; it
                       creates no slice worktree or ref, spawns no slice worker,
                       and writes no commit
      --unsafe-in-place
                       run workers in this checkout instead of isolated
                       worktrees; every file here becomes visible to every worker
  -h, --help           print this message

Options:
  -V, --version        print the brigadier version
  -h, --help           print this message

Exit codes:
  0  the command succeeded
  1  brigadier could not start the run: no config, an unreadable or invalid
     plan file, an environment with no HOME, PATH, or USER, or a planner that
     could not produce a plan
  2  usage error
  3  the run started and did not succeed; the "run failed:" line names which
     stage stopped it, and each slice's line names what happened to it
  4  the planner model ran but found the task too ambiguous to plan, so
     brigadier refused to guess and printed the questions it needs answered.
     No slice worker, worktree, ref, or commit was created. This is not a
     failed slice run: answer the questions and run it again
  130  the run was interrupted with SIGINT (Ctrl-C): brigadier attempts to
     terminate every worker still running along with its whole process group,
     remove its worktree, and retire the refs the run created. Neither this
     code nor 143 asserts that cleanup succeeded: whatever failed is listed
     under "cleanup failures:" in the report, and a failure there means a
     worker may still be running and spending quota, so read it. Interrupt a
     second time to skip that cleanup and exit at once
  143  the run was interrupted with SIGTERM; identical to 130 in every respect
     but the signal
`;

/** Parses argv and dispatches; resolves the process exit code. */
export async function runCli(options: CliOptions): Promise<number> {
  const { argv, stdout, stderr } = options;
  const command = argv[0];

  if (argv.length === 1 && (command === "--version" || command === "-V")) {
    stdout.write(`${options.version}\n`);
    return 0;
  }
  if (argv.length === 1 && (command === "--help" || command === "-h")) {
    stdout.write(USAGE);
    return 0;
  }
  if (command === "run") {
    return runPlan({
      argv: argv.slice(1),
      env: options.env,
      // The one `process.cwd()` read in the system, and it lives here for the
      // same reason the one `process.env` read does: a run operates on the
      // repository the user is standing in, and nothing deeper should have to
      // know which one that is.
      cwd: options.cwd ?? process.cwd(),
      stdout,
      stderr,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.io === undefined ? {} : { io: options.io }),
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onCancellable === undefined
        ? {}
        : { onCancellable: options.onCancellable }),
    });
  }
  // `install` owns its own argv, including its help and its usage errors, and
  // it is handed argv with the command word removed exactly as `run` is. It is
  // dispatched rather than reimplemented here: it is another unit's, it is
  // proven, and the composition root's job is to hand it its io.
  if (command === "install") {
    return runInstall(argv.slice(1), {
      env: options.env,
      stdout,
      stderr,
    });
  }
  // `mcp` takes no options at all, so anything after the command word is a
  // mistake worth naming rather than ignoring. It is refused HERE because
  // `runMcpServer` reads the real `process.stdin` and blocks until the client
  // closes the pipe — a stray flag that reached it would look like a hang.
  if (command === "mcp") {
    const extra = argv.slice(1);
    if (extra.includes("--help") || extra.includes("-h")) {
      stdout.write(USAGE);
      return 0;
    }
    const unknown = extra[0];
    if (unknown !== undefined) {
      stderr.write(
        `brigadier mcp: unexpected argument ${JSON.stringify(unknown)}; the MCP server takes no options\n`,
      );
      stderr.write(USAGE);
      return 2;
    }
    return (options.mcpServer ?? runMcpServer)({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onCancellable === undefined
        ? {}
        : { onCancellable: options.onCancellable }),
    });
  }
  if (command !== "init") {
    stderr.write(
      command === undefined
        ? "brigadier: a command is required\n"
        : `brigadier: unknown command ${JSON.stringify(command)}\n`,
    );
    stderr.write(USAGE);
    return 2;
  }

  let assumeYes = false;
  let printConfig = false;
  for (const argument of argv.slice(1)) {
    if (argument === "--help" || argument === "-h") {
      // Help is help wherever it appears. Treating `init --help` as an option
      // error would make the one command that has options the one command
      // whose options cannot be looked up.
      stdout.write(USAGE);
      return 0;
    }
    if (argument === "--yes" || argument === "-y") {
      assumeYes = true;
    } else if (argument === "--print-config") {
      printConfig = true;
    } else {
      stderr.write(
        `brigadier init: unknown option ${JSON.stringify(argument)}\n`,
      );
      stderr.write(USAGE);
      return 2;
    }
  }

  let discoverer: Discoverer;
  try {
    discoverer = options.discoverer ?? (await loadDiscoverer());
  } catch (error) {
    stderr.write(
      `brigadier init: no discovery backend is available: ${describe(error)}\n`,
    );
    return 1;
  }

  return runInit({
    discoverer,
    env: options.env,
    stdout,
    stderr,
    assumeYes,
    printConfig,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.io === undefined ? {} : { io: options.io }),
  });
}

/**
 * WIRING: the discovery contract declares only the `Discoverer` shape, not the
 * name of the factory that produces one, so this is the single place that
 * knows `src/discovery` exports `createDiscoverer`.
 */
async function loadDiscoverer(): Promise<Discoverer> {
  const discovery = await import("../discovery/index.js");
  return discovery.createDiscoverer();
}

/* ------------------------------------------------------------------------ */
/* run                                                                       */
/* ------------------------------------------------------------------------ */

/**
 * `brigadier run` — the composition root.
 *
 * Everything under `src/supervisor` is a pure function of its inputs or reaches
 * the outside world through `SupervisorPorts`. This is where those inputs are
 * produced and those ports are built, and it is deliberately the only place in
 * the product that reads the ambient environment or the working directory.
 *
 * THE EXIT CODES, which are an interface a CI step branches on:
 *
 *   0  the run succeeded.
 *   1  brigadier could not start the run at all — no config, an unreadable or
 *      malformed plan file, or an environment missing any of HOME, PATH, or
 *      USER, all three of which `requireLaunchEnv` demands. Nothing was
 *      created, and the fix is outside the plan.
 *   2  usage error: an unknown option, a missing `--plan`, a bad `--slug` or
 *      `--max-workers`, or a bare positional argument.
 *   3  the run started and did not succeed. This is a report, not a crash: the
 *      slices that landed are on the integration branch and the summary names
 *      which stage stopped the rest.
 *
 * They are three codes rather than one per `RunFailureReason` because a caller
 * that needs the finer answer has it printed: the reason is on the
 * `run failed:` line by name. What a script can usefully branch on is whether
 * the run happened at all, and that is exactly the 1/3 split.
 *
 * AN INTERRUPTED RUN RESOLVES 130 OR 143 INSTEAD, and those two are not part of
 * that scheme at all — they are 128 plus the signal number, which is what every
 * shell reports for a process a signal killed. A run stopped by SIGINT is not
 * "a run that did not succeed" in the sense a CI step cares about; it is a run
 * nobody finished asking for, and giving it 3 would make a Ctrl-C in a terminal
 * indistinguishable from a plan whose slices genuinely failed. The interrupt
 * code outranks the report's own verdict, including a report that came back
 * `ok: true` because the abort landed after the last merge.
 */
const RUN_OK = 0;
const RUN_NOT_STARTED = 1;
const RUN_USAGE_ERROR = 2;
const RUN_FAILED = 3;

/**
 * THE `needs-human` EXIT CODE: the task was too ambiguous to plan.
 *
 * It needed a code of its own, and the three existing ones each say something
 * false about it. `0` would tell a `brigadier run … && deploy` that the work
 * landed when nothing was built. `1` means "could not start" and is right about
 * the facts but wrong about the remedy — every other 1 sends the user to look at
 * their config, their plan file, or their environment, and this one is a
 * question waiting for an answer. `3` means a slice run started and did not
 * succeed, but no slice execution started here: the planner model ran, while no
 * slice worktree was created, no ref was written, and no slice worker was
 * spawned.
 *
 * A user who gets questions has not had a run fail, and the host-side skill
 * branches on exactly that distinction to re-invoke with the answers folded in.
 * `4` is the next free number below the shell's reserved 126/127/128+n range.
 */
const RUN_NEEDS_HUMAN = 4;

/** The engine's own rule (`validateSlug`), applied before any ref is written. */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Where this run's plan comes from.
 *
 * The two arms are mutually exclusive rather than layered, and that is the
 * decision the reserved positional slot was always holding open: `--plan`
 * names a plan that already exists, and a bare argument names a task that does
 * not have one yet. A run that accepted both would have to decide which wins,
 * and either answer silently discards something the user typed.
 */
type PlanOrigin =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "task"; readonly description: string };

/** Everything `brigadier run` decides from argv alone, before it touches disk. */
interface RunInvocation {
  readonly source: PlanOrigin;
  /** Null means "derive it from the plan id". */
  readonly slug: string | null;
  readonly maxWorkers: number;
  readonly dryRun: boolean;
  readonly unsafeInPlace: boolean;
}

type RunArguments =
  | { readonly kind: "run"; readonly invocation: RunInvocation }
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly message: string };

/**
 * The seam that makes `brigadier run` testable without git and without a
 * subprocess. Production passes nothing and gets the real engine, the real
 * clock, and the real slice runner.
 *
 * The quota oracles are deliberately NOT injectable: which oracles a run reads
 * is a product decision documented in `buildRunDependencies`, and a test that
 * could replace them would stop proving that decision holds.
 */
export interface RunHarness {
  readonly engine?: WorktreeEngine;
  readonly now?: () => number;
  readonly sliceRunner?: SliceRunner;
  /**
   * Replaces only the adapter lookup used by the production model planner.
   *
   * This is deliberately lower than `planner`: composition tests can exercise
   * the real `createModelPlanner` bridge without launching a vendor process.
   * Production passes nothing and resolves adapters from the saved config.
   */
  readonly plannerWorkerFor?: (vendor: Vendor) => AnyWorker | null;
  /**
   * Replaces the model that turns a task description into a plan.
   *
   * Without this seam every test of `brigadier run "<task>"` would spawn a real
   * vendor CLI, which would make the CLI's exit codes a function of somebody's
   * quota. The planner's OWN tests inject one level lower — at the one-shot
   * call — so the prompt, the budget rule, and the reply parsing are still
   * exercised for real; this seam exists for the tests that are about the
   * command line rather than about planning.
   */
  readonly planner?: Planner;
}

interface RunOptions {
  /** `argv` with the `run` command word already removed. */
  readonly argv: readonly string[];
  readonly env: ConfigEnvironment;
  /** The repository the run operates on. */
  readonly cwd: string;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  /** Required only for `--plan -`. */
  readonly stdin?: InputStream;
  readonly io?: ConfigIo;
  readonly harness?: RunHarness;
  /** See `CliOptions.signal`. */
  readonly signal?: AbortSignal;
  /** See `CliOptions.onCancellable`. */
  readonly onCancellable?: () => void;
}

/** Runs `brigadier run` and resolves the process exit code. */
async function runPlan(options: RunOptions): Promise<number> {
  const { stdout, stderr } = options;

  const parsed = parseRunArguments(options.argv);
  if (parsed.kind === "help") {
    stdout.write(USAGE);
    return RUN_OK;
  }
  if (parsed.kind === "usage-error") {
    stderr.write(`${parsed.message}\n`);
    stderr.write(USAGE);
    return RUN_USAGE_ERROR;
  }
  const invocation = parsed.invocation;

  const resolved = await resolvePlan(options, invocation);
  if (resolved.kind === "stop") {
    return resolved.code;
  }
  const { document, config, env } = resolved;

  const slug = invocation.slug ?? deriveSlug(document.plan.id);
  if (slug === null) {
    stderr.write(
      `brigadier run: no branch-safe slug can be derived from plan id ${JSON.stringify(document.plan.id)}; pass --slug <name> (letters, digits, dots, underscores, and hyphens, starting with a letter or digit)\n`,
    );
    return RUN_NOT_STARTED;
  }

  const dependencies = buildRunDependencies({
    config,
    env,
    log: (line: string) => {
      stdout.write(`${line}\n`);
    },
    ...(options.harness === undefined ? {} : { harness: options.harness }),
  });

  const request: RunRequest = {
    document,
    repositoryPath: options.cwd,
    slug,
    maxWorkers: invocation.maxWorkers,
    dryRun: invocation.dryRun,
    unsafeInPlace: invocation.unsafeInPlace,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  // THE LAST LINE BEFORE THE ORCHESTRATOR HAS ANYTHING TO CLEAN UP. From here
  // on the orchestrator owns worktrees and the runner owns worker process
  // groups, and a first interrupt has to be allowed to wind them down.
  //
  // A PLANNED RUN HAS ALREADY ARMED THE GATE, in `resolvePlan`, because the
  // planner spawns a real worker process and a Ctrl-C during planning has to be
  // able to kill it. `arm` is documented idempotent and one-way, so calling it
  // again here costs nothing. What is NOT true any more, and used to be, is
  // that "every failure above this point returns without having created a
  // process": a task run can fail after its planner ran. It still returns
  // without having created a ref or a worktree, which is the property the
  // failure paths above actually depend on.
  //
  // Armed for a dry run too, which creates neither: a dry run returns before
  // `prepare`, so the window is microseconds wide, and arming on the same line
  // for every run is worth more than a branch that makes the rule conditional.
  options.onCancellable?.();

  let report: RunReport;
  try {
    report = await createRunner(dependencies).run(request);
  } catch (error) {
    // `run` is documented to report rather than throw for anything a caller can
    // legitimately hand it, so this is a defect rather than an outcome. It still
    // owes the user a sentence instead of a stack trace. An interrupt still
    // outranks it: a user who pressed Ctrl-C gets the signal's code, not a
    // "brigadier could not start" that would send them looking for a bad config.
    stderr.write(
      `brigadier run: the run did not complete: ${describe(error)}\n`,
    );
    return interruptedExitCode(options.signal) ?? RUN_NOT_STARTED;
  } finally {
    await disposeOracles(dependencies.ports, stderr);
  }

  renderRunReport(stdout, report);
  return (
    interruptedExitCode(options.signal) ?? (report.ok ? RUN_OK : RUN_FAILED)
  );
}

/**
 * A plan, the config it will run under, and a launchable environment — or the
 * exit code to return instead.
 *
 * `stop` carries only a code because every branch that produces one has already
 * written its own diagnostic. Bundling the three values is what lets the two
 * origins keep their own ORDER of failures: a `--plan` run reports a bad plan
 * file before it ever looks for a config, which is the behaviour it has always
 * had, while a task run must have both config and environment in hand before it
 * can launch the planner that produces the plan at all.
 */
type ResolvedPlan =
  | {
      readonly kind: "ok";
      readonly document: RunRequest["document"];
      readonly config: BrigadierConfig;
      readonly env: LaunchEnv;
    }
  | { readonly kind: "stop"; readonly code: number };

async function resolvePlan(
  options: RunOptions,
  invocation: RunInvocation,
): Promise<ResolvedPlan> {
  return invocation.source.kind === "file"
    ? resolvePlanFromFile(options, invocation.source.path)
    : resolvePlanFromTask(options, invocation, invocation.source.description);
}

/** `brigadier run --plan <file>`: the path this command has always had. */
async function resolvePlanFromFile(
  options: RunOptions,
  path: string,
): Promise<ResolvedPlan> {
  const { stderr } = options;

  const source = await readPlanSource(path, options);
  if (!source.ok) {
    stderr.write(`${source.message}\n`);
    return { kind: "stop", code: RUN_NOT_STARTED };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(source.text);
  } catch (error) {
    stderr.write(
      `brigadier run: ${source.label} is not valid JSON: ${describe(error)}\n`,
    );
    return { kind: "stop", code: RUN_NOT_STARTED };
  }

  let document: RunRequest["document"];
  try {
    document = parsePlanDocument(parsedJson);
  } catch (error) {
    // Every issue, never the first one. `parsePlanDocument` collects the whole
    // repair precisely so a user fixes a plan in one pass instead of running
    // the CLI once per defect.
    if (error instanceof PlanDocumentError) {
      stderr.write(
        `brigadier run: ${source.label} is not a valid plan document (${error.issues.length} issue(s)):\n`,
      );
      for (const issue of error.issues) {
        stderr.write(`  ${issue}\n`);
      }
      return { kind: "stop", code: RUN_NOT_STARTED };
    }
    stderr.write(
      `brigadier run: could not read the plan: ${describe(error)}\n`,
    );
    return { kind: "stop", code: RUN_NOT_STARTED };
  }

  const environment = await loadConfigAndEnv(options);
  if (!environment.ok) {
    stderr.write(`${environment.message}\n`);
    return { kind: "stop", code: RUN_NOT_STARTED };
  }
  return {
    kind: "ok",
    document,
    config: environment.config,
    env: environment.env,
  };
}

/**
 * `brigadier run "<task>"`: ask a model for a plan, then run it like any other.
 *
 * THE PLAN IS PRINTED BEFORE THE RUN, AND THAT IS NOT DECORATION. The user did
 * not write this plan and cannot open it anywhere: it exists only inside this
 * process. Printing it first means they see what brigadier decided to do before
 * the workers start, and — the case that actually matters — that they still
 * have it when the run fails. `PlannerOutcome.json` is a plan file `--plan`
 * accepts, so the printed block is a working artifact rather than a summary.
 */
async function resolvePlanFromTask(
  options: RunOptions,
  invocation: RunInvocation,
  task: string,
): Promise<ResolvedPlan> {
  const { stdout, stderr } = options;

  const environment = await loadConfigAndEnv(options);
  if (!environment.ok) {
    stderr.write(`${environment.message}\n`);
    return { kind: "stop", code: RUN_NOT_STARTED };
  }

  let redactPlannerText: (artifact: string) => string;
  try {
    redactPlannerText = await createSecretRedactor({
      repositoryPath: options.cwd,
      linkedSecretPaths: environment.config.linkedSecretPaths,
    });
  } catch (error) {
    stderr.write(
      `brigadier run: could not inventory linked secrets before planning: ${describe(error)}\n`,
    );
    return { kind: "stop", code: RUN_NOT_STARTED };
  }

  const planner =
    options.harness?.planner ??
    createModelPlanner({
      config: environment.config,
      workerFor:
        options.harness?.plannerWorkerFor ??
        createWorkerFactory(environment.config),
      env: environment.env,
      log: (line: string) => {
        stdout.write(`${redactPlannerText(line)}\n`);
      },
    });

  // ARMED BEFORE THE PLANNER RUNS, not after. The planner spawns a real vendor
  // process, so from this line onward a Ctrl-C has something to wind down and
  // must be allowed to, rather than killing brigadier and orphaning the model.
  // Nothing above it has created a process, a ref, or a worktree.
  options.onCancellable?.();

  let outcome: PlannerOutcome;
  try {
    outcome = await planner.plan({
      task: redactPlannerText(task),
      cwd: options.cwd,
      maxSlices: invocation.maxWorkers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    // A `Planner` is documented to report rather than throw, so this is a
    // defect rather than an outcome — and it still owes the user a sentence.
    stderr.write(
      `brigadier run: the planner did not complete: ${describe(error)}\n`,
    );
    return {
      kind: "stop",
      code: interruptedExitCode(options.signal) ?? RUN_NOT_STARTED,
    };
  }

  if (outcome.kind === "failed") {
    stderr.write(`${redactPlannerText(outcome.message)}\n`);
    return {
      kind: "stop",
      code: interruptedExitCode(options.signal) ?? RUN_NOT_STARTED,
    };
  }
  if (outcome.kind === "needs-human") {
    renderNeedsHuman(stdout, outcome.questions.map(redactPlannerText));
    // An interrupt still outranks it: a user who pressed Ctrl-C during planning
    // is owed the signal's code, not a set of questions they did not wait for.
    return {
      kind: "stop",
      code: interruptedExitCode(options.signal) ?? RUN_NEEDS_HUMAN,
    };
  }

  let redactedPlan: unknown;
  let document: RunRequest["document"];
  try {
    redactedPlan = JSON.parse(outcome.json, (_key, value: unknown) =>
      typeof value === "string" ? redactPlannerText(value) : value,
    );
    document = parsePlanDocument(redactedPlan);
  } catch (error) {
    stderr.write(
      `brigadier run: the planner output could not be redacted into a valid plan: ${redactPlannerText(describe(error))}\n`,
    );
    return {
      kind: "stop",
      code: interruptedExitCode(options.signal) ?? RUN_NOT_STARTED,
    };
  }

  stdout.write(
    `\nplanned by ${outcome.planner.vendor}/${outcome.planner.model} at ${outcome.planner.effort} effort:\n`,
  );
  stdout.write(`${JSON.stringify(redactedPlan, null, 2)}\n`);
  return {
    kind: "ok",
    document,
    config: environment.config,
    env: environment.env,
  };
}

/**
 * `needs-human` ON SCREEN: questions, and an explicit account of what ran.
 *
 * The planner model has already run and cost tokens, while no slice worker,
 * worktree, ref, or commit exists. Both facts are printed because neither is
 * cheap for a user to infer. The trailing JSON line is for the host-side skill
 * that re-invokes brigadier with the answers folded in — the same
 * "machine-readable last line" contract the review gate asks of its reviewers,
 * chosen for the same reason: parsing prose to recover a question list is worse
 * than emitting the list.
 */
function renderNeedsHuman(
  out: OutputStream,
  questions: readonly string[],
): void {
  out.write(
    "\nbrigadier run: the planner model ran, but this task is ambiguous enough that producing a plan would mean guessing. No slice worker, worktree, ref, or commit was created.\n\nAnswer these and run it again:\n",
  );
  for (const [index, question] of questions.entries()) {
    out.write(`  ${index + 1}. ${question}\n`);
  }
  out.write(`${JSON.stringify({ status: "needs_human", questions })}\n`);
}

type LoadedEnvironment =
  | {
      readonly ok: true;
      readonly config: BrigadierConfig;
      readonly env: LaunchEnv;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The machine's config plus a launchable environment, in that order.
 *
 * The one legitimate `process.env` read in the system arrives here, already
 * narrowed by the caller. A machine missing HOME, PATH, or USER cannot launch
 * any worker for any slice — USER included, because Claude Code resolves its
 * OAuth credentials through it — so it is refused before a ref is written
 * rather than rediscovered once per slice. A task run refuses it before the
 * PLANNER launches, for the same reason and one step earlier.
 */
async function loadConfigAndEnv(
  options: RunOptions,
): Promise<LoadedEnvironment> {
  const loaded = await loadRunConfig(options);
  if (!loaded.ok) {
    return { ok: false, message: loaded.message };
  }
  try {
    return {
      ok: true,
      config: loaded.config,
      env: requireLaunchEnv(options.env),
    };
  } catch (error) {
    return { ok: false, message: `brigadier run: ${describe(error)}` };
  }
}

/**
 * The exit code an interrupt earns, or null when the run was not interrupted.
 *
 * Read off the signal rather than off `RunReport.interrupted` because only the
 * signal carries WHICH interrupt it was, and 130 and 143 differ by exactly
 * that. The two agree by construction — the orchestrator samples the same
 * signal — so this is a matter of which value has the answer, not of which
 * source to trust.
 */
function interruptedExitCode(signal: AbortSignal | undefined): number | null {
  return signal?.aborted === true ? interruptExitCode(signal.reason) : null;
}

/**
 * Everything a run composes, in one function, so the ports a test asserts
 * against are the ports the CLI actually builds rather than a reimplementation
 * of them.
 */
interface RunDependenciesInput {
  readonly config: BrigadierConfig;
  readonly env: LaunchEnv;
  readonly log: (line: string) => void;
  readonly harness?: RunHarness;
}

export function buildRunDependencies(
  input: RunDependenciesInput,
): RunnerDependencies {
  const harness = input.harness ?? {};
  const ports: SupervisorPorts = {
    engine: harness.engine ?? new GitWorktreeEngine(),
    // Bound to the executable `brigadier init` recorded for each vendor. The
    // config is the only place that knows where this machine's CLIs live —
    // a Homebrew path, a version-manager shim, a checkout — and an adapter
    // built without it falls back to a bare `claude` / `codex` off PATH, which
    // is a different binary whenever the user's PATH is not the probe's.
    workerFor: createWorkerFactory(input.config),
    // ONLY THE CLAUDE ORACLE, AND THIS IS A DELIBERATE V1 TRADE.
    //
    // Claude's oracle is push-based: a plain object the slice runner ingests
    // worker events into, costing no process and no probe. Codex's is
    // pull-based and backs itself with a real `codex app-server` subprocess, so
    // wiring it here would mean every run — including a dry run, and including
    // a run that touches no Codex model at all — starts by spawning a vendor
    // process and waiting on it. A vendor problem entirely unrelated to the
    // user's plan would then be able to hang the whole supervisor before it did
    // any work.
    //
    // THE PRICE, STATED HONESTLY: with no Codex snapshot, the router sees no
    // Codex quota. `judgeQuota` reads an absent snapshot as "unknown", which the
    // pipeline treats as available, so a drained Codex model is NOT avoided up
    // front. It is routed to, the spawn fails, and the slice's earned escalation
    // handles it — one wasted worktree and one wasted attempt instead of a
    // routing decision that never had to be made. That is worse than knowing,
    // and better than a supervisor that cannot start.
    oracles: [createClaudeQuotaOracle()],
    now: harness.now ?? ((): number => Date.now()),
    log: input.log,
  };
  return {
    ports,
    config: input.config,
    capabilities: buildCapabilities(input.config),
    sliceRunner:
      harness.sliceRunner ?? createSliceRunner({ ports, env: input.env }),
  };
}

/**
 * Resolves each configured vendor to an adapter bound to that vendor's recorded
 * executable, and every other vendor to null.
 *
 * Null rather than a default adapter is the whole point: an unconfigured vendor
 * is one `brigadier init` did not find, and handing back an adapter that would
 * spawn a bare `codex` off PATH would launch a binary the config never approved.
 * The slice runner turns the null into a `LAUNCH_FAILURE` naming the vendor.
 *
 * The adapters are built once and shared across every slice in the run. They
 * hold no per-launch state — each `spawn` builds its own event queue, lifecycle,
 * and process handle — so sharing them is safe and keeps a concurrent wave from
 * re-resolving the same path per slice.
 */
function createWorkerFactory(
  config: BrigadierConfig,
): (vendor: Vendor) => AnyWorker | null {
  const adapters = new Map<Vendor, AnyWorker>();
  for (const entry of config.vendors) {
    adapters.set(entry.vendor, adapterFor(entry));
  }
  return (vendor: Vendor): AnyWorker | null => adapters.get(vendor) ?? null;
}

/**
 * A `switch` with no `default`, so a third vendor added to `Vendor` stops
 * compiling here rather than silently resolving to null at runtime.
 */
function adapterFor(entry: VendorConfig): AnyWorker {
  switch (entry.vendor) {
    case "claude":
      return createClaudeWorker({ executable: entry.executable });
    case "codex":
      return createCodexWorker({ executable: entry.executable });
  }
}

/**
 * Releases anything an oracle owns. Failures are reported and swallowed: the run
 * is already over, and a dispose error must not change its exit code.
 */
async function disposeOracles(
  ports: SupervisorPorts,
  stderr: OutputStream,
): Promise<void> {
  const settled = await Promise.allSettled(
    ports.oracles.map((oracle) => oracle.dispose()),
  );
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      const vendor = ports.oracles[index]?.vendor ?? "unknown";
      stderr.write(
        `brigadier run: could not dispose the ${vendor} quota oracle: ${describe(outcome.reason)}\n`,
      );
    }
  }
}

type LoadedConfig =
  | { readonly ok: true; readonly config: BrigadierConfig }
  | { readonly ok: false; readonly message: string };

/**
 * Reads the machine's config, or explains what to do about not having one.
 *
 * Both failures point at `brigadier init`, and they are worded apart on
 * purpose: "there is no config" and "the config you have cannot be trusted" ask
 * the same command of the user for different reasons, and a user who has run
 * `init` before needs to know which one they are looking at.
 */
async function loadRunConfig(options: RunOptions): Promise<LoadedConfig> {
  let configPath: string;
  try {
    configPath = resolveConfigPath(options.env);
  } catch (error) {
    return {
      ok: false,
      message: `brigadier run: ${describe(error)}`,
    };
  }

  let config: BrigadierConfig | null;
  try {
    config =
      options.io === undefined
        ? await readConfig(configPath)
        : await readConfig(configPath, options.io);
  } catch (error) {
    return {
      ok: false,
      message: `brigadier run: the config at ${configPath} cannot be used: ${describe(error)}. Re-run \`brigadier init\` to rebuild it.`,
    };
  }
  if (config === null) {
    return {
      ok: false,
      message: `brigadier run: no brigadier config was found at ${configPath}. Run \`brigadier init\` to scan this machine for worker CLIs and write one.`,
    };
  }
  return { ok: true, config };
}

type PlanSource =
  | { readonly ok: true; readonly text: string; readonly label: string }
  | { readonly ok: false; readonly message: string };

/** Reads the plan bytes from a file or from stdin. */
async function readPlanSource(
  planSource: string,
  options: RunOptions,
): Promise<PlanSource> {
  if (planSource === "-") {
    const stdin = options.stdin;
    if (stdin === undefined) {
      return {
        ok: false,
        message:
          "brigadier run: --plan - was given, but this process has no stdin to read the plan from",
      };
    }
    try {
      return {
        ok: true,
        text: await readAllInput(stdin),
        label: "the plan on stdin",
      };
    } catch (error) {
      return {
        ok: false,
        message: `brigadier run: could not read the plan from stdin: ${describe(error)}`,
      };
    }
  }

  const path = resolvePath(options.cwd, planSource);
  try {
    return { ok: true, text: await readFile(path, "utf8"), label: path };
  } catch (error) {
    return {
      ok: false,
      message: `brigadier run: could not read the plan file ${path}: ${describe(error)}`,
    };
  }
}

/**
 * Drains an input stream to a string. Bounded by the stream ending, which is
 * the caller's contract: `--plan -` is a deliberate request to read until EOF.
 */
async function readAllInput(input: InputStream): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of input) {
    text +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Turns a plan id into a branch-safe slug, or null when nothing usable is left.
 *
 * Null rather than a fallback like `run`: the slug names every ref the run
 * creates, so a silent substitution would make two different plans collide on
 * one set of branches. `--slug` is the answer, and the diagnostic says so.
 */
function deriveSlug(planId: string): string | null {
  const slug = planId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  return SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Parses `run`'s options. Pure, and total: every path returns one of the three
 * members rather than throwing.
 *
 * `--plan` is an option rather than a positional argument, and that is a
 * decision rather than a style: the positional slot holds the task description
 * the planner consumes, and a `--plan` that also accepted a bare path would
 * make `brigadier run plan.json` and `brigadier run "fix the parser"`
 * indistinguishable now that both are real commands.
 *
 * A SECOND POSITIONAL IS REFUSED RATHER THAN JOINED. `brigadier run fix the
 * parser` without quotes arrives here as three arguments, and concatenating
 * them would silently accept a command whose shell quoting is wrong — which is
 * how a task description ends up missing whatever the shell ate.
 */
function parseRunArguments(argv: readonly string[]): RunArguments {
  let planSource: string | null = null;
  let task: string | null = null;
  let slug: string | null = null;
  let maxWorkers = 1;
  let dryRun = false;
  let unsafeInPlace = false;

  let index = 0;
  while (index < argv.length) {
    const argument = argv[index] ?? "";
    index += 1;

    if (argument === "--help" || argument === "-h") {
      // Help is help wherever it appears, exactly as `init` treats it.
      return { kind: "help" };
    }

    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const name = equals > 0 ? argument.slice(0, equals) : argument;
    const inline = equals > 0 ? argument.slice(equals + 1) : null;

    if (name === "--plan" || name === "--slug" || name === "--max-workers") {
      let value = inline;
      if (value === null) {
        value = argv[index] ?? null;
        index += 1;
      }
      if (value === null || value === "") {
        return {
          kind: "usage-error",
          message: `brigadier run: ${name} requires a value`,
        };
      }
      if (name === "--plan") {
        planSource = value;
        continue;
      }
      if (name === "--slug") {
        if (!SLUG_PATTERN.test(value)) {
          return {
            kind: "usage-error",
            message: `brigadier run: --slug ${JSON.stringify(value)} is not branch-safe; use letters, digits, dots, underscores, and hyphens, starting with a letter or digit`,
          };
        }
        slug = value;
        continue;
      }
      const parsed = parsePositiveInteger(value);
      if (parsed === null) {
        return {
          kind: "usage-error",
          message: `brigadier run: --max-workers must be a positive whole number, received ${JSON.stringify(value)}`,
        };
      }
      maxWorkers = parsed;
      continue;
    }

    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--unsafe-in-place") {
      unsafeInPlace = true;
      continue;
    }
    if (argument.startsWith("-")) {
      return {
        kind: "usage-error",
        message: `brigadier run: unknown option ${JSON.stringify(argument)}`,
      };
    }
    if (task !== null) {
      return {
        kind: "usage-error",
        message: `brigadier run: only one task description is accepted, and a second one ${JSON.stringify(argument)} was given; quote the whole task as a single argument`,
      };
    }
    if (argument.trim() === "") {
      return {
        kind: "usage-error",
        message: "brigadier run: the task description is empty",
      };
    }
    task = argument;
  }

  const rest = { slug, maxWorkers, dryRun, unsafeInPlace };
  if (task !== null) {
    if (planSource !== null) {
      return {
        kind: "usage-error",
        message:
          "brigadier run: pass a task description or --plan <file>, not both; --plan runs a plan that already exists and a task description asks brigadier to write one",
      };
    }
    return {
      kind: "run",
      invocation: { source: { kind: "task", description: task }, ...rest },
    };
  }
  if (planSource === null) {
    return {
      kind: "usage-error",
      message:
        'brigadier run: nothing to run; pass a task description as a single quoted argument, or a plan JSON file with `--plan <file>` ("-" reads it from stdin)',
    };
  }
  return {
    kind: "run",
    invocation: { source: { kind: "file", path: planSource }, ...rest },
  };
}

/** Digits only: `Number.parseInt` would accept `3abc` and `1e9`. */
function parsePositiveInteger(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Prints the report a user acts on.
 *
 * One line per slice, then one line per attempt beneath it, because the two
 * answer different questions: the slice line says whether the work landed, and
 * the attempt lines say who did it and at what effort. Printing only the last
 * attempt would hide the escalation — a slice that failed on one model and
 * succeeded on a stronger one is the single most interesting outcome a run
 * produces, and it is invisible from the verdict alone.
 *
 * A DRY RUN PRINTS THE SAME ATTEMPT LINES, which is the point of the flag: the
 * question it answers is "who would do this work, and how expensive is that"
 * before a worktree is spent. It also has to be read through `report.dryRun`
 * rather than through each slice's `ok`, because a routed-but-unrun slice is
 * `ok: false` by construction — the successful arm of `SliceResult` demands a
 * commit a dry run never produces.
 */
function renderRunReport(out: OutputStream, report: RunReport): void {
  out.write(
    `\n${report.dryRun ? "dry run" : "run"} ${report.slug}: ${report.slices.length} slice(s) in ${report.durationMs}ms\n`,
  );
  // Printed before the slice lines rather than with the failure at the bottom,
  // because it changes how every line below it should be read: "cancelled" on a
  // slice means something different when the user knows they caused it.
  //
  // THE CLEAN WORDING IS A CLAIM ABOUT `cancel()`, `remove()` AND `release()`,
  // AND IT IS ONLY MADE WHEN THEY ALL SUCCEEDED. Printing it unconditionally
  // told a user their workers were dead and their worktrees were gone at
  // exactly the moment a worker was still alive and still spending their paid
  // quota — the one moment they most needed to be told to go kill it.
  if (report.interrupted) {
    out.write(
      report.cleanupFailures.length === 0
        ? "  interrupted: workers were cancelled and worktrees removed\n"
        : "  interrupted: cleanup did not finish; a worker may still be running and a worktree may still exist — see cleanup failures below\n",
    );
  }
  // Printed whether or not the run was interrupted: a worktree that would not
  // be removed on the ordinary path is the same leak and needs the same
  // sentence.
  if (report.cleanupFailures.length > 0) {
    out.write("  cleanup failures:\n");
    for (const failure of report.cleanupFailures) {
      out.write(`    ${failure}\n`);
    }
  }
  for (const slice of report.slices) {
    out.write(`  ${slice.sliceId}  ${describeSliceVerdict(report, slice)}\n`);
    for (const attempt of slice.attempts) {
      out.write(
        `      attempt ${attempt.attempt}  ${describeRouted(attempt.routed)}  ${describeAttempt(attempt)}\n`,
      );
      renderRejections(out, attempt);
      renderReview(out, attempt);
    }
  }

  out.write(`  integration branch: ${describeIntegration(report)}\n`);
  if (report.merges.length === 0) {
    out.write("  merges: (none)\n");
  } else {
    out.write("  merges:\n");
    for (const merge of report.merges) {
      out.write(`    ${merge.sliceId}: ${describeMerge(merge.result)}\n`);
    }
  }
  if (report.planIssues.length > 0) {
    out.write("  plan issues:\n");
    for (const issue of report.planIssues) {
      out.write(`    ${issue.code}: ${issue.message}\n`);
    }
  }
  if (report.failure !== null) {
    out.write(
      `  run failed: ${report.failure.reason} — ${report.failure.message}\n`,
    );
  }
}

/**
 * The router's rejection list, printed in full for every routing failure.
 *
 * This array is the entire diagnosis. "No configured model can take this slice"
 * is not actionable on its own; "sonnet scored 74 against a hard floor of 90,
 * and opus is quota-exhausted" tells the user whether to re-slice the plan,
 * lower the difficulty, or wait for a window. Summarizing it would leave a user
 * with a refusal and no way to answer it.
 */
function renderRejections(out: OutputStream, attempt: SliceAttempt): void {
  const failure = attempt.failure;
  if (failure === null || failure.kind !== "ROUTING_FAILED") {
    return;
  }
  if (failure.rejected.length === 0) {
    out.write("        rejected: (no model reached a routing stage)\n");
    return;
  }
  for (const rejection of failure.rejected) {
    out.write(
      `        rejected ${rejection.vendor}/${rejection.model} [${rejection.stage}]: ${rejection.reason}\n`,
    );
  }
}

/**
 * The cross-vendor gate's verdict, printed under every attempt that reached it.
 *
 * IT IS PRINTED FOR APPROVALS TOO, AND THAT IS THE WHOLE REASON THIS FUNCTION
 * EXISTS. The gate fails open: a run with only one vendor configured, or one
 * whose reviewer hit a quota wall, commits every slice exactly as a fully
 * reviewed run does. If the report said nothing on the happy path, those two
 * runs would be byte-identical on screen, and a user would believe a second
 * vendor had checked work that nothing had checked. So a skip prints its
 * reason, an approval says who approved it, and silence means the attempt never
 * got as far as the gate.
 *
 * CONCERNS ARE PRINTED UNDER AN APPROVAL. They did not stop the commit, and a
 * reviewer that raised one has said the most useful thing it will say all run;
 * dropping it because the slice passed would throw away the half of a review
 * that a human can still act on.
 */
function renderReview(out: OutputStream, attempt: SliceAttempt): void {
  const review = attempt.review;
  if (review === null) {
    return;
  }
  if (review.verdict === "skipped") {
    out.write(
      `        review: not run (${review.reason}) — ${review.message}\n`,
    );
    return;
  }
  const reviewer = `${review.reviewer.vendor}/${review.reviewer.model}`;
  out.write(
    `        review: ${review.verdict} by ${reviewer} effort=${review.reviewer.effort} in ${review.durationMs}ms\n`,
  );
  for (const finding of review.findings) {
    const where =
      finding.path === null
        ? ""
        : finding.line === null
          ? ` ${finding.path}`
          : ` ${finding.path}:${finding.line}`;
    out.write(`          ${finding.severity}${where}: ${finding.summary}\n`);
  }
}

/**
 * The verdict line, which must never be read off `report.dryRun` alone.
 *
 * A dry run's slices are all `ok: false` by construction, so the flag cannot be
 * the first question — a slice that FAILED TO ROUTE during a dry run is exactly
 * the answer the user asked for, and labelling it "would run" would report a
 * refusal as a plan. The failure is therefore checked first, and "would run" is
 * reserved for a slice that routed and was deliberately not executed.
 *
 * CANCELLED IS CHECKED BEFORE THE FAILURE KIND, for a related reason. A
 * cancelled slice does carry a `SliceFailure` — the runner records why it
 * stopped — so reading the kind first would print `failed WORKER_FAILED` for a
 * worker the user themselves killed, which is the single most misleading line
 * this report could produce.
 */
function describeSliceVerdict(report: RunReport, slice: SliceResult): string {
  if (slice.ok) {
    return `ok  ${slice.branch}  ${slice.commit}`;
  }
  if (slice.cancelled === true) {
    return slice.attempts.length === 0
      ? "cancelled  (never started)"
      : "cancelled";
  }
  const kind = slice.attempts.at(-1)?.failure?.kind;
  if (kind !== undefined) {
    return `failed  ${kind}`;
  }
  if (slice.attempts.length === 0) {
    return "failed  (not attempted)";
  }
  // Routed, nothing went wrong, and nothing ran: a dry run, or a slice the
  // pre-flight routed before a sibling's failure stopped the run.
  return report.dryRun ? "would run" : "not run  (the run stopped first)";
}

function describeRouted(routed: RoutedWorker | null): string {
  if (routed === null) {
    return "unrouted";
  }
  const waived = routed.waivedDifficultyFloor
    ? " (below this slice's difficulty floor; allowDegradedRouting is on)"
    : "";
  return `${routed.vendor}/${routed.model} effort=${routed.effort}${waived}`;
}

/**
 * `routed` rather than `ok` for an attempt with no commit: committing is the
 * last thing a real attempt does, so an attempt that failed nothing and
 * committed nothing did not run — on a dry run by design, and otherwise because
 * the run stopped around it.
 */
function describeAttempt(attempt: SliceAttempt): string {
  const failure = attempt.failure;
  if (failure !== null) {
    return `${failure.kind}: ${failure.message}`;
  }
  return attempt.commit === null ? "routed" : `ok ${attempt.commit}`;
}

function describeIntegration(report: RunReport): string {
  if (report.integrationBranch !== null) {
    return report.integrationBranch;
  }
  return report.dryRun
    ? "(none: a dry run writes no ref)"
    : "(none: nothing was merged)";
}

function describeMerge(result: MergeResult): string {
  return result.status === "conflicted"
    ? `conflicted — ${result.details}`
    : `${result.status} ${result.commit}`;
}

export type { Choice, InputStream, OutputStream } from "./prompt.js";
export type {
  CompetenceRule,
  DroppedVendor,
  Proposal,
  RankedModel,
  UnusableModel,
  VendorProposal,
} from "./propose.js";
export {
  COMPETENCE_TABLE,
  proposeConfig,
  withDefaultModel,
  withDegradedRouting,
  withEffortCeiling,
  withLinkedSecretPaths,
  withSecretsConsent,
} from "./propose.js";
