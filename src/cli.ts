#!/usr/bin/env node

/**
 * Executable entry point. The compiled binary starts here, so this module must
 * dispatch as a side effect of being loaded and must therefore stay unimportable
 * from tests. Every testable part of the command line lives in `src/init/index.ts`.
 *
 * The signal handlers below are the one thing that genuinely cannot live there:
 * they need the real `process`, and a test that installed them would be sending
 * signals to the test runner. So this file does the untestable half only — turn
 * a POSIX signal into a call on an `InterruptGate`, then write what the gate
 * says and exit if it says to. WHAT to do about an interrupt is policy, it
 * lives in `createInterruptGate`, and it is tested there against no process and
 * no signal at all. Everything downstream reacts to an `AbortSignal`, which a
 * test drives directly.
 */

import packageJson from "../package.json";
import type { InterruptGate } from "./init/index.js";
import { createInterruptGate, runCli } from "./init/index.js";
import type { InterruptSignal } from "./supervisor/contracts.js";

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
  const gate = createInterruptGate();
  installInterruptHandlers(gate);
  const code = await runCli({
    argv: process.argv.slice(2),
    version: packageJson.version,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    signal: gate.signal,
    // The command tells the gate when an interrupt acquires a duty. Until then
    // the first Ctrl-C kills brigadier outright, exactly as it did before any
    // handler existed here.
    onCancellable: (): void => {
      gate.arm();
    },
  });
  // Release stdin so a finished interactive run does not hold the event loop.
  if (!process.stdin.destroyed) {
    process.stdin.destroy();
  }
  process.exitCode = code;
}

/**
 * Registers SIGINT and SIGTERM and does exactly what the gate answers.
 *
 * REGISTERING A HANDLER DISABLES THE DEFAULT TERMINATION. From the first line
 * of this function onward, Ctrl-C no longer kills brigadier; it asks brigadier
 * what to do. That is why this function holds no policy of its own — the gate
 * decides, and the gate's default is to terminate, so the disabling costs the
 * user nothing until a command has actually taken on something to wind down.
 */
function installInterruptHandlers(gate: InterruptGate): void {
  const onSignal = (signal: InterruptSignal): void => {
    const decision = gate.interrupt(signal);
    process.stderr.write(decision.message);
    if (decision.exitCode !== null) {
      process.exit(decision.exitCode);
    }
  };
  process.on("SIGINT", () => {
    onSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    onSignal("SIGTERM");
  });
}
