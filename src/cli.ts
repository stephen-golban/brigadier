#!/usr/bin/env node

/**
 * Executable shim. `bin/brigadier.js` runs this with a bare `import`, so this
 * module must dispatch as a side effect of being loaded and must therefore stay
 * unimportable from tests. Every testable part of the command line lives in
 * `src/init/index.ts`.
 */

import packageJson from "../package.json";
import { runCli } from "./init/index.js";

// Not a top-level await: `bun build --compile --bytecode` cannot compile one.
// The catch is the last resort: every command is supposed to resolve an exit
// code, and anything that escapes one must still leave the user with a
// diagnostic and exit 1 rather than an unhandled rejection and a stack trace.
void main().catch((error: unknown) => {
  process.stderr.write(
    `brigadier: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const code = await runCli({
    argv: process.argv.slice(2),
    version: packageJson.version,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  });
  // Release stdin so a finished interactive run does not hold the event loop.
  if (!process.stdin.destroyed) {
    process.stdin.destroy();
  }
  process.exitCode = code;
}
