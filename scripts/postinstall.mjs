#!/usr/bin/env node

/**
 * A best-effort `brigadier init --yes` at install time.
 *
 * WHAT THIS IS FOR. brigadier configures itself rather than asking a human to
 * remember `brigadier init`. The real guarantee that a config exists is the
 * lazy one inside the product, which builds a config on first use. This script
 * is only the convenience layer on top of it: when the install happens to be a
 * human at a terminal, the config usually exists before the first run instead
 * of being written during it.
 *
 * SO IT IS ALLOWED TO DO NOTHING, AND IT DOES NOTHING OFTEN. `npm install
 * --ignore-scripts`, CI, Docker builds, and any non-interactive install all
 * skip it, by design. Nothing downstream may depend on it having run.
 *
 * WHAT IT MAY NEVER DO IS BREAK AN INSTALL. A postinstall hook that exits
 * nonzero fails `npm install` for the whole dependency tree, which is strictly
 * worse for a user than never having had a probe. Every path here — including
 * every internal defect — ends at exit code 0, and the two process-level
 * handlers below are the backstop for the ones that were not foreseen.
 *
 * IT REGISTERS NOTHING INTO ANY THIRD-PARTY APPLICATION. Writing into another
 * app's configuration is gated on an explicit human yes given during an
 * interactive `brigadier init`, and `--yes` means "accept the proposed
 * defaults", whose default for that consent is no. This script has no path of
 * its own into any of that: it spawns the ordinary CLI entry point and passes
 * the ordinary flag.
 *
 * Plain Node ESM with no dependencies and no bun, because a published user is
 * not assumed to have either a bun or a TypeScript toolchain.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The probe is abandoned rather than waited on. Discovery spawns the vendor
 * CLIs, and on a slow or unhappy machine one of them can take arbitrarily long;
 * an install that appears to hang is a worse outcome than a config written on
 * first run instead. Abandoning mid-probe is safe because `writeConfig` writes
 * a temp file and renames over the target, so a killed init cannot leave a
 * partial config behind.
 */
const PROBE_TIMEOUT_MS = 5_000;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The backstop. Nothing above is expected to reach these, which is exactly why
// they are here: an unforeseen throw or rejection must still leave the install
// succeeding, and Node's default for both is a nonzero exit.
process.on("uncaughtException", () => {
  process.exit(0);
});
process.on("unhandledRejection", () => {
  process.exit(0);
});

await main();

async function main() {
  try {
    if (!shouldProbe()) {
      return;
    }
    if (await configExists()) {
      return;
    }
    await runProbe();
  } catch {
    // Deliberately silent and deliberately swallowed. There is no failure of
    // this script that a user installing a package can act on, and a
    // postinstall that prints during a routine install gets the package
    // uninstalled.
  } finally {
    process.exitCode = 0;
  }
}

/**
 * Whether this install looks like a human at a terminal.
 *
 * `CI` is checked by presence, not by value: every CI provider sets it, and the
 * conservative reading of an unexpected value is to skip. A non-TTY stdout
 * covers the rest — a Docker build, a `postinstall` behind a package manager
 * that pipes its output, a machine-driven install — because a probe that cannot
 * reach a human has no convenience to offer and only slows the install down.
 */
function shouldProbe() {
  if (process.env.CI !== undefined) {
    return false;
  }
  return process.stdout.isTTY === true;
}

/**
 * Whether a config is already on this machine.
 *
 * The path is read from the product's own `resolveConfigPath` rather than
 * rebuilt here, so this script cannot become a second opinion about where a
 * config lives. A build that has not produced `dist/` yet, or an environment
 * with neither `$BRIGADIER_HOME` nor `$HOME`, resolves no path at all — and
 * that is reported as "a config exists", because the honest answer is that this
 * script cannot tell, and the safe move when it cannot tell is to leave the
 * machine alone.
 */
async function configExists() {
  let resolveConfigPath;
  try {
    ({ resolveConfigPath } = await import(
      pathToFileURL(join(packageRoot, "dist", "index.js")).href
    ));
  } catch {
    return true;
  }
  if (typeof resolveConfigPath !== "function") {
    return true;
  }
  try {
    return existsSync(resolveConfigPath(process.env));
  } catch {
    return true;
  }
}

/**
 * Runs `brigadier init --yes` through the just-installed bin entry point and
 * resolves once it is gone, however it went.
 *
 * DETACHED ON PURPOSE. `init` spawns the vendor CLIs to discover them, so
 * killing the child alone could orphan a grandchild that keeps probing after
 * the install returns. Its own process group makes the timeout able to take the
 * whole tree with it.
 */
function runProbe() {
  return new Promise((resolveProbe) => {
    let child;
    try {
      child = spawn(
        process.execPath,
        [join(packageRoot, "bin", "brigadier.js"), "init", "--yes"],
        {
          cwd: packageRoot,
          // Quiet on success and quiet on failure: whatever init would have
          // printed is noise in the middle of an install log.
          stdio: "ignore",
          detached: true,
        },
      );
    } catch {
      resolveProbe();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveProbe();
    };

    const timer = setTimeout(() => {
      killGroup(child);
      finish();
    }, PROBE_TIMEOUT_MS);
    // Nothing here should keep this process alive by itself; the child handle
    // already does that, and it is the thing worth waiting on.
    timer.unref?.();

    // `error` covers the spawn that never became a process — a missing node, a
    // missing entry point — and `close` covers every way a real one ended.
    child.on("error", finish);
    child.on("close", finish);
  });
}

/** SIGKILL to the whole group, and never a throw. */
function killGroup(child) {
  try {
    if (typeof child.pid === "number") {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // The group is already gone, or was never a group. Fall through.
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already reaped.
  }
}
