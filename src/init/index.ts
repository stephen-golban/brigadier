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
import type { Effort, Vendor } from "../contracts.js";
import type { Discoverer, DiscoveryReport } from "../discovery/contracts.js";
import type { InputStream, OutputStream, PromptIo } from "./prompt.js";
import { confirmPrompt, LineReader, selectPrompt } from "./prompt.js";
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
  withSecretsConsent,
} from "./propose.js";

/**
 * The degraded-routing question, asked once for the whole config.
 *
 * The wording is the whole point of WO-010H. Its predecessor asked "When claude
 * quota drains, fall back to:" and offered a model list — a description of a
 * capability that no longer exists, since per-model quota metering means a
 * drained tier leaves its healthy siblings competing in the ordinary pipeline
 * on merit. What configuring a fallback actually did by then was authorize the
 * difficulty-floor waiver, so that is what is asked here, in those terms.
 */
export const DEGRADED_ROUTING_QUESTION =
  "If no model on this machine meets a slice's difficulty bar, run the slice on a weaker model instead of failing it?";

/** Decision #20's documented warning, shown before any ceiling is raised. */
export const EFFORT_CEILING_WARNING =
  "Warning: above `high`, models take longer, burn more tokens, hallucinate more, and do worse work.";

/** Decision #20: the ceiling is a cap, not a pin, and xhigh stays earned. */
export const EFFORT_CEILING_NOTE =
  "`xhigh` stays earned-on-retry regardless of this ceiling: brigadier reaches for it only after a slice fails its gate. Effort is never pinned per task tier.";

/** Decision #19 and #7, said out loud so the config is not mistaken for a router. */
export const ROUTER_NOTE =
  "This config layers on top of brigadier's router: it records which models are permitted and how high their effort may go. Routing still filters by capability, ranks by competence, then weighs difficulty, effort, and cost. Vendor is never a routing input.";

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
  // decision #21's original spirit that brigadier never silently substitutes;
  // on a re-run the current value is the default, so an existing yes is not
  // discarded by pressing enter.
  const degraded = await confirmPrompt(
    io,
    DEGRADED_ROUTING_QUESTION,
    config.allowDegradedRouting,
  );
  config = withDegradedRouting(config, degraded);

  // Decision #6: default No on a fresh config. On a re-run the current value is
  // the default, so an existing yes is not silently discarded by pressing enter.
  const consent = await confirmPrompt(
    io,
    "Allow brigadier to link secret files (for example .env) into worker worktrees?",
    config.secretsConsent,
  );
  return withSecretsConsent(config, consent);
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

export interface CliOptions {
  /** `process.argv.slice(2)`. */
  readonly argv: readonly string[];
  readonly version: string;
  readonly env: ConfigEnvironment;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly stdin?: InputStream;
  /** Injected in tests; production loads the discovery module on demand. */
  readonly discoverer?: Discoverer;
  readonly io?: ConfigIo;
}

export const USAGE = `Usage: brigadier <command> [options]

Commands:
  init                 scan for installed worker CLIs and write a config

Options for init:
  -y, --yes            accept every proposed default without prompting
      --print-config   print the resolved config as JSON and exit without writing
  -h, --help           print this message

Options:
  -V, --version        print the brigadier version
  -h, --help           print this message
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
 * WIRING: WO-008A owns `src/discovery`. The factory name is the one wiring
 * point this unit could not verify against the frozen interface, which
 * declares only the `Discoverer` shape; confirm it at reconciliation.
 */
async function loadDiscoverer(): Promise<Discoverer> {
  const discovery = await import("../discovery/index.js");
  return discovery.createDiscoverer();
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
  withSecretsConsent,
} from "./propose.js";
