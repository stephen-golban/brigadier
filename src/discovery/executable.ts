/**
 * POSIX executable resolution, in code rather than via `which`.
 *
 * Shelling out to `which`/`where` would make resolution untestable and would
 * inherit whatever shell builtins and aliases the user's environment happens to
 * define. Resolving PATH here keeps discovery hermetic: a test injects a PATH
 * string and an `isExecutable` predicate and never touches a real binary.
 *
 * Windows is out of scope as of commit 3ae19dc, so this deliberately has no
 * `.exe`/`.cmd` suffix search, no PATHEXT handling, and no `;` delimiter.
 */

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const PATH_SEPARATOR = ":";

/** Answers whether a path names a file this process may execute. */
export type ExecutableProbe = (path: string) => Promise<boolean>;

export interface ResolveExecutableOptions {
  /**
   * An explicit path from configuration. Honored ahead of PATH; when it does
   * not name an executable file, resolution fails rather than falling back to
   * PATH — a configured path that silently resolves elsewhere is worse than a
   * clear `not-found`.
   */
  readonly override?: string | undefined;
  /** The raw PATH value; absent or empty means nothing is searchable. */
  readonly pathEnv?: string | undefined;
  /** Base for relative overrides. Defaults to the current working directory. */
  readonly cwd?: string | undefined;
  readonly isExecutable?: ExecutableProbe | undefined;
}

/**
 * Resolves `name` to an absolute path, or null when it is not installed.
 *
 * A name containing a slash is treated as a path, matching POSIX shell
 * behavior: PATH is not searched for it.
 */
export async function resolveExecutable(
  name: string,
  options: ResolveExecutableOptions = {},
): Promise<string | null> {
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const cwd = options.cwd ?? process.cwd();

  if (options.override !== undefined && options.override !== "") {
    return await acceptIfExecutable(
      toAbsolute(options.override, cwd),
      isExecutable,
    );
  }

  if (name.includes("/")) {
    return await acceptIfExecutable(toAbsolute(name, cwd), isExecutable);
  }

  for (const directory of searchDirectories(options.pathEnv)) {
    const candidate = await acceptIfExecutable(
      resolve(cwd, directory, name),
      isExecutable,
    );
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

/**
 * Builds a resolver bound to one environment, for injection into a Discoverer.
 */
export function createExecutableResolver(
  options: Omit<ResolveExecutableOptions, "override"> & {
    readonly overrides?: Readonly<Record<string, string>> | undefined;
  } = {},
): (name: string) => Promise<string | null> {
  return (name) =>
    resolveExecutable(name, {
      ...options,
      override: options.overrides?.[name],
    });
}

async function acceptIfExecutable(
  path: string,
  isExecutable: ExecutableProbe,
): Promise<string | null> {
  return (await isExecutable(path)) ? path : null;
}

function toAbsolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * An empty PATH entry means "the current directory" to POSIX, but honoring
 * that would make discovery depend on where brigadier was invoked. Empty
 * entries are dropped instead.
 */
function searchDirectories(pathEnv: string | undefined): readonly string[] {
  if (pathEnv === undefined) {
    return [];
  }
  return pathEnv.split(PATH_SEPARATOR).filter((entry) => entry !== "");
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
