import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { Discoverer, DiscoveryReport } from "../discovery/contracts.js";
import type { OutputStream } from "../init/prompt.js";
import { proposeConfig } from "../init/propose.js";
import type { BrigadierConfig, GuiHost, Host } from "./contracts.js";
import { CONFIG_VERSION, GUI_HOSTS, HOSTS, parseConfig } from "./contracts.js";
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

/** Injectable executable resolution keeps host detection machine-independent. */
export interface ExecutableLookup {
  resolve(command: string): Promise<string | null>;
}

export type HostDetection =
  | {
      readonly host: Host;
      readonly present: true;
      readonly evidence: string;
      readonly evidenceKind: "executable" | "directory";
    }
  | {
      readonly host: Host;
      readonly present: false;
      readonly evidence: null;
      readonly evidenceKind: null;
    };

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
    ...(prior !== null && prior.enabledHosts.length > 0
      ? { enabledHosts: prior.enabledHosts }
      : {}),
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
      ...(Array.isArray(old.enabledHosts) && old.enabledHosts.length > 0
        ? { enabledHosts: old.enabledHosts }
        : {}),
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

/** Read-only detection of every host brigadier knows how to install into. */
export async function detectHosts(
  environment: ConfigEnvironment,
  io: ConfigIo = nodeConfigIo,
  lookup: ExecutableLookup = createExecutableLookup(environment),
): Promise<readonly HostDetection[]> {
  const directoryCandidates = hostDirectoryCandidates(environment);
  const detected: HostDetection[] = [];

  for (const host of HOSTS) {
    const command = hostCommand(host);
    if (command !== null) {
      try {
        const executable = await lookup.resolve(command);
        if (executable !== null && executable.length > 0) {
          detected.push({
            host,
            present: true,
            evidence: resolve(executable),
            evidenceKind: "executable",
          });
          continue;
        }
      } catch {
        // A failed executable probe is unknown; directory evidence may remain.
      }
    }

    let evidence: string | null = null;
    for (const candidate of directoryCandidates[host]) {
      if (await pathExists(io, candidate)) {
        evidence = resolve(candidate);
        break;
      }
    }
    detected.push(
      evidence === null
        ? { host, present: false, evidence: null, evidenceKind: null }
        : { host, present: true, evidence, evidenceKind: "directory" },
    );
  }
  return detected;
}

/** Cheap, read-only detection of GUI hosts. No result is persisted. */
export async function detectGuiHosts(
  environment: ConfigEnvironment,
  io: ConfigIo = nodeConfigIo,
): Promise<readonly GuiHost[]> {
  const detections = await detectHosts(environment, io, {
    resolve: () => Promise.resolve(null),
  });
  return detections
    .filter(
      (entry): entry is HostDetection & { readonly host: GuiHost } =>
        entry.present && (GUI_HOSTS as readonly string[]).includes(entry.host),
    )
    .map((entry) => entry.host);
}

async function pathExists(io: ConfigIo, path: string): Promise<boolean> {
  try {
    if (io.exists !== undefined) {
      return (await io.exists(path)) === true;
    }
    await io.readFile(path);
    return true;
  } catch {
    // Missing, inaccessible, and every other failure are not positive evidence.
    return false;
  }
}

function createExecutableLookup(
  environment: ConfigEnvironment,
): ExecutableLookup {
  return {
    async resolve(command) {
      const path = environment.PATH ?? "";
      for (const directory of path.split(delimiter)) {
        // PATH entries are POSIX path bytes. Spaces are legal and meaningful.
        if (directory.length === 0) {
          continue;
        }
        const candidate = resolve(join(directory, command));
        try {
          const metadata = await stat(candidate);
          if (!metadata.isFile()) {
            continue;
          }
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {
          // An unusable candidate does not hide a later PATH entry.
        }
      }
      return null;
    },
  };
}

function hostCommand(host: Host): string | null {
  if (host === "claude-code") {
    return "claude";
  }
  if (host === "codex" || host === "opencode") {
    return host;
  }
  return null;
}

function hostDirectoryCandidates(
  environment: ConfigEnvironment,
): Readonly<Record<Host, readonly string[]>> {
  const home = environment.HOME ?? "";
  const fromEnvironment = (name: string, ...parts: string[]): string[] => {
    const root = environment[name] ?? "";
    return root.length === 0 ? [] : [resolve(root, ...parts)];
  };
  const fromHome = (...parts: string[]): string[] =>
    home.length === 0 ? [] : [resolve(home, ...parts)];

  return {
    "claude-code": [
      ...fromEnvironment("CLAUDE_CONFIG_DIR"),
      ...fromHome(".claude"),
    ],
    codex: [...fromEnvironment("CODEX_HOME"), ...fromHome(".codex")],
    opencode: [
      ...fromEnvironment("XDG_CONFIG_HOME", "opencode"),
      ...fromHome(".config", "opencode"),
    ],
    // ~/.agents/skills is deliberately absent: Codex and opencode both read
    // it, and brigadier itself creates it when installing either host.
    ...guiHostCandidates(environment),
  };
}

function guiHostCandidates(
  environment: ConfigEnvironment,
): Readonly<Record<GuiHost, readonly string[]>> {
  const home = environment.HOME ?? "";
  const appData = environment.APPDATA ?? "";
  const localAppData = environment.LOCALAPPDATA ?? "";
  const fromHome = (...parts: string[]): string[] =>
    home.length === 0 ? [] : [resolve(home, ...parts)];
  const fromAppData = (root: string, ...parts: string[]): string[] =>
    root.length === 0 ? [] : [resolve(root, ...parts)];

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
