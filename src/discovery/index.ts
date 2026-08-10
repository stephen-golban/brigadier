/**
 * Discovery: find every worker CLI brigadier knows about, learn its real model
 * catalog, and report what was found.
 *
 * `discover()` never throws for a missing or broken vendor. A vendor that is
 * absent, unprobeable, or unparseable becomes an entry in `missing` or
 * `warnings`; the caller (`brigadier init`) always gets a report it can render.
 * That is the whole contract — an install with one broken CLI must still be
 * able to configure the other one.
 */

import { spawn } from "node:child_process";
import type { Vendor } from "../contracts.js";
import { CLAUDE_CATALOG_SOURCE } from "./claude.js";
import { CODEX_CATALOG_SOURCE } from "./codex.js";
import type {
  CommandResult,
  DiscoveredModel,
  DiscoveredVendor,
  Discoverer,
  DiscoveryReport,
  DiscoveryWarning,
  ExecutableResolver,
  RunCommand,
  VendorCatalogSource,
} from "./contracts.js";
import { createExecutableResolver } from "./executable.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
/**
 * Generous enough for the ~332 KB Codex catalog with room for growth, small
 * enough that a runaway CLI cannot exhaust memory. Discovery keeps the text
 * only until it is parsed.
 */
const MAX_STDOUT_CHARS = 8 * 1_024 * 1_024;
const MAX_STDERR_CHARS = 64 * 1_024;

/** Every vendor discovery knows how to look for. */
const VENDOR_CATALOG_SOURCES: readonly VendorCatalogSource[] = [
  CLAUDE_CATALOG_SOURCE,
  CODEX_CATALOG_SOURCE,
];

export interface VendorDiscovererOptions {
  /** Runs a probe command. Injected by tests so no real binary is spawned. */
  readonly run?: RunCommand | undefined;
  /** Resolves a command name to an absolute path, or null when absent. */
  readonly resolveExecutable?: ExecutableResolver | undefined;
  /** Explicit executable paths per vendor, honored ahead of PATH. */
  readonly executables?: Readonly<Partial<Record<Vendor, string>>> | undefined;
  /** PATH used when no resolver is injected. Defaults to `process.env.PATH`. */
  readonly pathEnv?: string | undefined;
  readonly cwd?: string | undefined;
  /** Vendors to look for. Defaults to every vendor brigadier supports. */
  readonly sources?: readonly VendorCatalogSource[] | undefined;
  readonly commandTimeoutMs?: number | undefined;
}

/** Probes every known vendor and reports what is installed. */
export class VendorDiscoverer implements Discoverer {
  private readonly sources: readonly VendorCatalogSource[];
  private readonly run: RunCommand;
  private readonly resolveExecutable: ExecutableResolver;

  constructor(options: VendorDiscovererOptions = {}) {
    this.sources = options.sources ?? VENDOR_CATALOG_SOURCES;
    this.run =
      options.run ??
      createCommandRunner({
        timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      });
    this.resolveExecutable =
      options.resolveExecutable ??
      createExecutableResolver({
        pathEnv: options.pathEnv ?? process.env.PATH,
        cwd: options.cwd,
        overrides: options.executables as
          | Readonly<Record<string, string>>
          | undefined,
      });
  }

  async discover(): Promise<DiscoveryReport> {
    const vendors: DiscoveredVendor[] = [];
    const missing: Vendor[] = [];
    const warnings: DiscoveryWarning[] = [];

    // Sequential rather than concurrent: the whole flow is three short
    // subprocesses, and a deterministic report order keeps `init`'s prompts
    // and these tests stable.
    for (const source of this.sources) {
      const outcome = await this.probe(source);
      if (outcome.vendor !== null) {
        vendors.push(outcome.vendor);
      }
      if (outcome.missing) {
        missing.push(source.vendor);
      }
      warnings.push(...outcome.warnings);
    }
    return { vendors, missing, warnings };
  }

  private async probe(source: VendorCatalogSource): Promise<ProbeOutcome> {
    const executable = await this.resolveExecutableSafely(source);
    if (executable === null) {
      return {
        vendor: null,
        missing: true,
        warnings: [
          {
            vendor: source.vendor,
            cause: "not-found",
            message: `\`${source.executable}\` was not found on PATH`,
          },
        ],
      };
    }

    const warnings: DiscoveryWarning[] = [];
    const version = await this.readVersion(source, executable);
    if (!version.ok) {
      return { vendor: null, missing: false, warnings: [version.warning] };
    }
    if (version.warning !== null) {
      warnings.push(version.warning);
    }

    const catalog = await source.readCatalog(executable, this.run);
    if (!catalog.ok) {
      warnings.push({
        vendor: source.vendor,
        cause: catalog.cause,
        message: catalog.message,
      });
      return { vendor: null, missing: false, warnings };
    }

    // The uniqueness guarantee on `DiscoveredVendor.models` is enforced here,
    // not left to each source, so it holds for every vendor added later too —
    // and so a duplicate always produces the warning the guarantee promises.
    const unique = deduplicateModels(catalog.models);
    if (unique.duplicates.length > 0) {
      warnings.push({
        vendor: source.vendor,
        cause: "parse-failed",
        message: `${source.executable} reported ${formatDuplicates(unique.duplicates)} more than once; the entry describing the most capability was kept`,
      });
    }

    return {
      vendor: {
        vendor: source.vendor,
        executable,
        version: version.version,
        models: unique.models,
        catalogSource: source.catalogSource,
      },
      missing: false,
      warnings,
    };
  }

  /**
   * A resolver that throws (an unreadable PATH entry, a permissions error) is
   * indistinguishable from a missing binary as far as the user is concerned,
   * and must not abort discovery of the other vendors.
   */
  private async resolveExecutableSafely(
    source: VendorCatalogSource,
  ): Promise<string | null> {
    try {
      return await this.resolveExecutable(source.executable);
    } catch {
      return null;
    }
  }

  private async readVersion(
    source: VendorCatalogSource,
    executable: string,
  ): Promise<VersionOutcome> {
    const command = `\`${source.executable} ${source.versionArgs.join(" ")}\``;
    let result: CommandResult;
    try {
      result = await this.run(executable, source.versionArgs);
    } catch (error) {
      return {
        ok: false,
        warning: {
          vendor: source.vendor,
          cause: "probe-failed",
          message: `could not run ${command}: ${describeError(error)}`,
        },
      };
    }

    // A CLI that is present but cannot report its version is broken, not
    // versionless: reporting it as a usable vendor would offer the user a
    // worker that will fail on first spawn.
    if (result.exitCode !== 0) {
      return {
        ok: false,
        warning: {
          vendor: source.vendor,
          cause: "probe-failed",
          message: `${command} exited ${describeExit(result.exitCode)}${formatDetail(result.stderr)}`,
        },
      };
    }

    const version = firstNonEmptyLine(result.stdout);
    if (version === null) {
      return {
        ok: true,
        version: "unknown",
        warning: {
          vendor: source.vendor,
          cause: "version-unknown",
          message: `${command} succeeded but printed no version`,
        },
      };
    }
    return { ok: true, version, warning: null };
  }
}

/** Convenience constructor mirroring the other brigadier modules. */
export function createDiscoverer(
  options: VendorDiscovererOptions = {},
): Discoverer {
  return new VendorDiscoverer(options);
}

interface CommandRunnerOptions {
  readonly timeoutMs?: number | undefined;
  readonly cwd?: string | undefined;
  readonly environment?:
    | Readonly<Record<string, string | undefined>>
    | undefined;
}

/**
 * The default `RunCommand`: spawn, buffer bounded output, resolve on exit.
 *
 * stdin is `ignore`d rather than piped. A probe must never leave a CLI waiting
 * on input — that is exactly how `claude -p --output-format stream-json` hangs
 * forever — and ignoring stdin makes a hang impossible rather than unlikely.
 * The timeout is a second guard for a CLI that wedges without reading stdin.
 */
function createCommandRunner(options: CommandRunnerOptions = {}): RunCommand {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return (executable, args) =>
    new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.environment === undefined
          ? {}
          : { env: { ...options.environment } }),
      });

      if (child.stdout === null || child.stderr === null) {
        child.kill("SIGKILL");
        reject(new Error(`\`${executable}\` was spawned without output pipes`));
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new Error(
              `\`${executable} ${args.join(" ")}\` did not exit within ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);

      const finish = (settle: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        settle();
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendBounded(stdout, chunk, MAX_STDOUT_CHARS);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendBounded(stderr, chunk, MAX_STDERR_CHARS);
      });
      child.on("error", (error) => {
        finish(() => reject(error));
      });
      child.on("close", (exitCode) => {
        finish(() => resolve({ exitCode, stdout, stderr }));
      });
    });
}

/**
 * Keeps one entry per model id and names the ids that were reported twice.
 *
 * Which entry survives is the whole point. A catalog can list the same slug
 * twice with a placeholder first — `visibility: "hidden"`, no reasoning levels
 * — and the usable entry second; keeping the first occurrence would retain a
 * stub that `init` then excludes, silently removing the model the user can
 * actually run. The entry claiming the most capability wins instead: selectable
 * beats hidden, and a reported effort ladder beats an empty one. Ties keep the
 * earlier entry, and the surviving entry keeps the position the id first
 * appeared in, so the result is deterministic either way.
 */
function deduplicateModels(models: readonly DiscoveredModel[]): {
  readonly models: readonly DiscoveredModel[];
  readonly duplicates: readonly string[];
} {
  const positionById = new Map<string, number>();
  const duplicates: string[] = [];
  const unique: DiscoveredModel[] = [];
  for (const model of models) {
    const position = positionById.get(model.id);
    if (position === undefined) {
      positionById.set(model.id, unique.length);
      unique.push(model);
      continue;
    }
    if (!duplicates.includes(model.id)) {
      duplicates.push(model.id);
    }
    const kept = unique[position];
    if (kept !== undefined && capability(model) > capability(kept)) {
      unique[position] = model;
    }
  }
  return { models: unique, duplicates };
}

/**
 * Ranks two entries for the same model id. Both signals are the vendor's own:
 * an entry the vendor lists as selectable describes more of the model than a
 * hidden one, and an entry that names reasoning levels describes more than one
 * that names none.
 */
function capability(model: DiscoveredModel): number {
  return (
    (model.selectable ? 2 : 0) + (model.supportedEfforts.length > 0 ? 1 : 0)
  );
}

function formatDuplicates(ids: readonly string[]): string {
  const quoted = ids.map((id) => JSON.stringify(id)).join(", ");
  return ids.length === 1 ? `model ${quoted}` : `models ${quoted}`;
}

function appendBounded(current: string, chunk: string, limit: number): string {
  if (current.length >= limit) {
    return current;
  }
  return (current + chunk).slice(0, limit);
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  return null;
}

function formatDetail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === "" ? "" : `: ${trimmed}`;
}

function describeExit(exitCode: number | null): string {
  return exitCode === null ? "on a signal" : `${exitCode}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ProbeOutcome {
  readonly vendor: DiscoveredVendor | null;
  readonly missing: boolean;
  readonly warnings: readonly DiscoveryWarning[];
}

type VersionOutcome =
  | { readonly ok: false; readonly warning: DiscoveryWarning }
  | {
      readonly ok: true;
      readonly version: string;
      readonly warning: DiscoveryWarning | null;
    };

export {
  CLAUDE_CATALOG_SOURCE,
  CLAUDE_VERSION_ARGS,
  readClaudeCatalog,
} from "./claude.js";
export {
  CODEX_CATALOG_ARGS,
  CODEX_CATALOG_SOURCE,
  CODEX_VERSION_ARGS,
  parseCodexCatalog,
  readCodexCatalog,
} from "./codex.js";
export type {
  CatalogParseResult,
  CatalogProbeResult,
  CommandResult,
  DiscoveredModel,
  DiscoveredVendor,
  Discoverer,
  DiscoveryReport,
  DiscoveryWarning,
  ExecutableResolver,
  RunCommand,
  VendorCatalogSource,
} from "./contracts.js";
export {
  createExecutableResolver,
  type ExecutableProbe,
  type ResolveExecutableOptions,
  resolveExecutable,
} from "./executable.js";
export { CLAUDE_STATIC_MODELS } from "./table.js";
