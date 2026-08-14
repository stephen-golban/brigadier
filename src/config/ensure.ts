import { join } from "node:path";
import type { Discoverer, DiscoveryReport } from "../discovery/contracts.js";
import type { OutputStream } from "../init/prompt.js";
import { proposeConfig } from "../init/propose.js";
import type { BrigadierConfig, GuiHost } from "./contracts.js";
import { CONFIG_VERSION, GUI_HOSTS, parseConfig } from "./contracts.js";
import type { ConfigEnvironment, ConfigIo } from "./store.js";
import {
  nodeConfigIo,
  readConfig,
  resolveConfigPath,
  writeConfig,
} from "./store.js";

export interface EnsureConfigOptions {
  readonly environment?: ConfigEnvironment;
  readonly io?: ConfigIo;
  readonly stderr?: OutputStream;
  readonly discoverer?: Discoverer;
}

export interface EnsureConfigResult {
  readonly config: BrigadierConfig;
  readonly path: string;
  /** false when an existing, current, valid config was reused as-is. */
  readonly written: boolean;
  /**
   * true when the config exists only in memory for this run: either the
   * config home could not be written, or an existing current-version file
   * could not be parsed/validated and was left untouched to protect it from
   * destruction.
   */
  readonly inMemory: boolean;
}

/**
 * Returns a usable config, creating one from the same discovery report as
 * `brigadier init` when necessary. This path is deliberately non-interactive:
 * it has no stdin dependency and every consent whose default is No stays No.
 */
export async function ensureConfig(
  options: EnsureConfigOptions = {},
): Promise<EnsureConfigResult> {
  const environment = options.environment ?? process.env;
  const io = options.io ?? nodeConfigIo;
  const stderr = options.stderr ?? process.stderr;
  const path = resolveConfigPath(environment);

  const loaded = await loadForEnsure(path, io);
  if (loaded.kind === "current") {
    return { config: loaded.config, path, written: false, inMemory: false };
  }

  const discoverer = options.discoverer ?? (await createRealDiscoverer());
  const report = await discoverer.discover();
  const prior = loaded.kind === "wrong-version" ? loaded.prior : null;
  const proposal = proposeConfig(report, prior);
  if (proposal.vendors.length === 0) {
    throw new Error(
      "no installed worker CLI reported a selectable model. Install Claude Code or Codex, then try again.",
    );
  }

  // Non-interactive creation never grants registration consent, even if an
  // untrusted old-version file happened to contain a truthy value for it.
  const config = parseConfig({
    ...proposal.config,
    secretsConsent: prior?.secretsConsent ?? proposal.config.secretsConsent,
    linkedSecretPaths:
      prior?.linkedSecretPaths ?? proposal.config.linkedSecretPaths,
    guiRegistrationConsent: false,
    allowDegradedRouting:
      prior?.allowDegradedRouting ?? proposal.config.allowDegradedRouting,
  });
  reportDiscovery(stderr, report, path, loaded);
  for (const reset of proposal.resetChoices) {
    stderr.write(`brigadier: ${reset}\n`);
  }
  for (const dropped of proposal.droppedVendors) {
    stderr.write(
      `brigadier: did not preserve ${dropped.vendor} because it is no longer usable on this machine (${dropped.reason})\n`,
    );
  }

  // A current-version file that failed to parse or validate is left exactly
  // as it is on disk: writing over it would destroy whatever made it invalid
  // (a hand edit, a partial rewrite from elsewhere) before the user ever sees
  // it. The run proceeds on the freshly detected configuration instead.
  if (loaded.kind === "invalid") {
    return { config, path, written: false, inMemory: true };
  }

  try {
    const written = await writeConfig(path, config, io);
    stderr.write(`brigadier: wrote config to ${path}\n`);
    return { config: written, path, written: true, inMemory: false };
  } catch (error) {
    stderr.write(
      `brigadier: could not write config to ${path}; using the detected configuration in memory for this run: ${describe(error)}\n`,
    );
    return { config, path, written: false, inMemory: true };
  }
}

type EnsureLoad =
  | { readonly kind: "current"; readonly config: BrigadierConfig }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly reason: string }
  | {
      readonly kind: "wrong-version";
      readonly version: unknown;
      readonly prior: BrigadierConfig | null;
    };

async function loadForEnsure(path: string, io: ConfigIo): Promise<EnsureLoad> {
  try {
    const config = await readConfig(path, io);
    return config === null ? { kind: "missing" } : { kind: "current", config };
  } catch (error) {
    let raw: unknown;
    try {
      raw = JSON.parse(await io.readFile(path));
    } catch {
      return { kind: "invalid", reason: describe(error) };
    }
    const version = record(raw)?.version;
    if (version === CONFIG_VERSION) {
      return { kind: "invalid", reason: describe(error) };
    }
    return {
      kind: "wrong-version",
      version,
      prior: preserveCompatibleFields(raw),
    };
  }
}

/** Projects only current fields out of an old file before normal validation. */
function preserveCompatibleFields(raw: unknown): BrigadierConfig | null {
  const old = record(raw);
  if (old === null) {
    return null;
  }
  try {
    return parseConfig({
      version: CONFIG_VERSION,
      vendors: old.vendors,
      secretsConsent: old.secretsConsent === true,
      linkedSecretPaths: Array.isArray(old.linkedSecretPaths)
        ? old.linkedSecretPaths
        : [],
      guiRegistrationConsent: false,
      allowDegradedRouting: old.allowDegradedRouting === true,
    });
  } catch {
    return null;
  }
}

function reportDiscovery(
  stderr: OutputStream,
  report: DiscoveryReport,
  path: string,
  loaded: Exclude<EnsureLoad, { readonly kind: "current" }>,
): void {
  if (loaded.kind === "wrong-version") {
    stderr.write(
      `brigadier: config at ${path} has version ${JSON.stringify(loaded.version)}; re-probing this machine and preserving compatible settings\n`,
    );
  } else if (loaded.kind === "invalid") {
    stderr.write(
      `brigadier: config at ${path} could not be parsed: ${loaded.reason}; leaving it untouched and proceeding with a detected configuration that will not be saved\n`,
    );
  }
  for (const vendor of report.vendors) {
    stderr.write(
      `brigadier: detected ${vendor.vendor} ${vendor.version} at ${vendor.executable}\n`,
    );
  }
}

async function createRealDiscoverer(): Promise<Discoverer> {
  const discovery = await import("../discovery/index.js");
  return discovery.createDiscoverer();
}

/** Cheap, read-only detection of GUI hosts. No result is persisted. */
export async function detectGuiHosts(
  environment: ConfigEnvironment,
  io: ConfigIo = nodeConfigIo,
): Promise<readonly GuiHost[]> {
  const candidates = guiHostCandidates(environment);
  const detected: GuiHost[] = [];
  for (const host of GUI_HOSTS) {
    const paths = candidates[host];
    for (const path of paths) {
      try {
        if (await pathExists(io, path)) {
          detected.push(host);
          break;
        }
      } catch {
        // One inaccessible candidate must not hide another host or break init.
      }
    }
  }
  return detected;
}

async function pathExists(io: ConfigIo, path: string): Promise<boolean> {
  if (io.exists !== undefined) {
    return io.exists(path);
  }
  try {
    await io.readFile(path);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    );
  }
}

function guiHostCandidates(
  environment: ConfigEnvironment,
): Readonly<Record<GuiHost, readonly string[]>> {
  const home = environment.HOME?.trim() ?? "";
  const appData = environment.APPDATA?.trim() ?? "";
  const localAppData = environment.LOCALAPPDATA?.trim() ?? "";
  const fromHome = (...parts: string[]): string[] =>
    home.length === 0 ? [] : [join(home, ...parts)];
  const fromAppData = (root: string, ...parts: string[]): string[] =>
    root.length === 0 ? [] : [join(root, ...parts)];

  return {
    cursor: [
      ...fromHome(".cursor"),
      ...fromHome(".config", "Cursor"),
      ...fromHome("Applications", "Cursor.app"),
      "/Applications/Cursor.app",
      ...fromHome("Library", "Application Support", "Cursor"),
      ...fromAppData(appData, "Cursor"),
    ],
    windsurf: [
      ...fromHome(".codeium", "windsurf"),
      ...fromHome(".config", "Windsurf"),
      ...fromHome("Applications", "Windsurf.app"),
      "/Applications/Windsurf.app",
      ...fromHome("Library", "Application Support", "Windsurf"),
      ...fromAppData(appData, "Windsurf"),
    ],
    antigravity: [
      ...fromHome(".antigravity"),
      ...fromHome(".gemini", "antigravity"),
      ...fromHome(".config", "Antigravity"),
      ...fromHome("Applications", "Antigravity.app"),
      "/Applications/Antigravity.app",
      ...fromHome("Library", "Application Support", "Antigravity"),
      ...fromAppData(appData, "Antigravity"),
      ...fromAppData(localAppData, "Antigravity"),
    ],
    "claude-desktop": [
      ...fromHome("Applications", "Claude.app"),
      "/Applications/Claude.app",
      ...fromHome("Library", "Application Support", "Claude"),
      ...fromHome(".config", "Claude"),
      ...fromAppData(appData, "Claude"),
    ],
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
