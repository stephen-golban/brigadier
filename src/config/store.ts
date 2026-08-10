/**
 * Locating, reading, and atomically writing `$BRIGADIER_HOME/config.json`.
 *
 * The home directory is resolved from an injected environment and never from
 * the operating-system home helpers. That is deliberate: it is the seam that
 * lets a test point at a scratch directory, and it makes writing to a real
 * home impossible unless a caller passes a real `HOME`.
 */

import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { BrigadierConfig } from "./contracts.js";
import { ConfigValidationError, parseConfig } from "./contracts.js";

export const CONFIG_HOME_VARIABLE = "BRIGADIER_HOME";
const CONFIG_DIRECTORY_NAME = ".brigadier";
export const CONFIG_FILE_NAME = "config.json";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** The subset of the process environment config resolution consults. */
export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The filesystem operations the store needs. Injecting this port keeps the
 * atomic-write sequence observable in tests without a test-only code path in
 * the production write.
 */
export interface ConfigIo {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const nodeConfigIo: ConfigIo = {
  /**
   * `mkdir` applies `mode` only to directories it creates, so a config home
   * that already exists at 0755 would keep every config brigadier writes
   * world-readable. The directory is chmodded whenever it grants anything to
   * group or other, which makes the 0700 intent hold on the second run too.
   */
  async mkdir(path) {
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    const existing = await stat(path);
    if ((existing.mode & 0o077) !== 0) {
      await chmod(path, DIRECTORY_MODE);
    }
  },
  readFile(path) {
    return readFile(path, "utf8");
  },
  async writeFile(path, contents) {
    const handle = await open(path, "wx", FILE_MODE);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async unlink(path) {
    await unlink(path);
  },
};

/** `$BRIGADIER_HOME`, defaulting to `$HOME/.brigadier`. POSIX paths only. */
export function resolveConfigHome(environment: ConfigEnvironment): string {
  const explicit = environment[CONFIG_HOME_VARIABLE]?.trim() ?? "";
  if (explicit.length > 0) {
    return resolve(explicit);
  }
  const home = environment.HOME?.trim() ?? "";
  if (home.length === 0) {
    throw new ConfigValidationError([
      `cannot resolve the brigadier home directory: set $${CONFIG_HOME_VARIABLE} or $HOME`,
    ]);
  }
  return resolve(home, CONFIG_DIRECTORY_NAME);
}

/** `$BRIGADIER_HOME/config.json`, defaulting to `$HOME/.brigadier/config.json`. */
export function resolveConfigPath(environment: ConfigEnvironment): string {
  return join(resolveConfigHome(environment), CONFIG_FILE_NAME);
}

/** Serializes a config exactly as it is written to disk. */
export function serializeConfig(config: BrigadierConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Reads and validates the config. Returns `null` when no config exists yet and
 * throws `ConfigValidationError` when one exists but cannot be trusted.
 */
export async function readConfig(
  path: string,
  io: ConfigIo = nodeConfigIo,
): Promise<BrigadierConfig | null> {
  let contents: string;
  try {
    contents = await io.readFile(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new ConfigValidationError([
      `${path} is not valid JSON: ${describe(error)}`,
    ]);
  }
  return parseConfig(parsed);
}

/**
 * Validates, then writes through a temp file in the same directory and renames
 * over the target, so an interrupted write can never leave a partial or
 * unreadable config behind. Returns the config exactly as persisted.
 */
export async function writeConfig(
  path: string,
  config: BrigadierConfig,
  io: ConfigIo = nodeConfigIo,
): Promise<BrigadierConfig> {
  const validated = parseConfig(config);
  const directory = dirname(path);
  await io.mkdir(directory);

  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid.toString(36)}.${randomSuffix()}.tmp`,
  );
  await io.writeFile(temporaryPath, serializeConfig(validated));
  try {
    await io.rename(temporaryPath, path);
  } catch (error) {
    await discard(io, temporaryPath);
    throw error;
  }
  return validated;
}

async function discard(io: ConfigIo, path: string): Promise<void> {
  try {
    await io.unlink(path);
  } catch {
    // A leftover temp file is preferable to masking the original failure.
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
