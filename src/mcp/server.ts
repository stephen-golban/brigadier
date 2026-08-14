/**
 * `brigadier-mcp`: the Model Context Protocol server, for Claude Desktop.
 *
 * WHY THIS EXISTS AT ALL, given that every other host gets a 40-line skill.
 * Desktop Skills execute server-side: they run in Anthropic's infrastructure and
 * cannot invoke a binary on the user's machine, so the doctrine file — whose
 * whole message is "hand the work to `brigadier run`" — would be addressed to a
 * model with nothing to hand it to. Desktop MCP servers run LOCALLY with the
 * user's full privileges and can spawn `claude -p`. That asymmetry is the entire
 * argument for this file.
 *
 * ZERO RUNTIME DEPENDENCIES, including no `@modelcontextprotocol/sdk`. See
 * `./protocol.ts` for the transport and the reason.
 *
 * STDOUT IS THE PROTOCOL. Every byte written to it must be one JSON-RPC message
 * followed by one newline, so nothing in this process may log to stdout — not
 * the run log, not a warning, not a stray `console.log`. The orchestrator's log
 * lines are therefore captured into the tool's own result text, where the model
 * can actually read them, and diagnostics go to stderr.
 *
 * `bin/brigadier-mcp.js` (owned elsewhere) is expected to do exactly this and
 * nothing else:
 *
 *     import { runMcpServer } from "../dist/mcp/server.js";
 *     process.exitCode = await runMcpServer();
 */

import packageJson from "../../package.json";
import { type EnsureConfigResult, ensureConfig } from "../config/index.js";
import type { ConfigEnvironment } from "../config/store.js";
import { resolveConfigPath } from "../config/store.js";
import type { Discoverer } from "../discovery/contracts.js";
import { buildRunDependencies } from "../init/index.js";
import type { InputStream, OutputStream } from "../init/prompt.js";
// Imported from the module rather than the barrel for the same reason
// `src/init/index.ts` reaches past a barrel for the interrupt helpers: a line
// reader is transport plumbing, not prompt API, and there is exactly one correct
// implementation of "split an async chunk stream into lines" in this repository.
import { LineReader } from "../init/prompt.js";
import {
  renderQuietRunReport,
  writeRunRecordDetail,
} from "../report/render.js";
import { interruptExitCode } from "../supervisor/contracts.js";
import { createRunner } from "../supervisor/orchestrator.js";
import { requireLaunchEnv } from "../supervisor/slice.js";
import { ABORTED, raceAbort, settle } from "../supervisor/support.js";
import { createDispatcher } from "./protocol.js";
import type { LoadedConfig, McpRunRequest, ToolDependencies } from "./tools.js";
import { createTools } from "./tools.js";

/** The name a client sees in `initialize`. */
export const SERVER_NAME = "brigadier";

export interface McpServerOptions {
  readonly stdin: InputStream;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly version: string;
  readonly dependencies: ToolDependencies;
  readonly signal?: AbortSignal;
  readonly onCancellable?: () => void;
}

export interface McpRunControl {
  readonly signal?: AbortSignal;
  readonly onCancellable?: () => void;
}

interface RealDependenciesControl extends Pick<McpRunControl, "signal"> {
  readonly stderr?: OutputStream;
  /** Test seam for deterministic lazy-config discovery. */
  readonly discoverer?: Discoverer;
}

/**
 * The entry point `bin/brigadier-mcp.js` calls. Wires the real process streams,
 * the real config store, and the real supervisor.
 *
 * Resolves 0 when stdin reached end of input, which for a stdio MCP server means
 * the client closed the pipe — an ordinary shutdown, not a fault.
 */
export async function runMcpServer(
  control: McpRunControl = {},
): Promise<number> {
  return await serveMcp({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    version: packageJson.version,
    dependencies: createRealDependencies(process.env, {
      // STDOUT is JSON-RPC only. Lazy-config diagnostics belong on stderr.
      stderr: process.stderr,
      ...(control.signal === undefined ? {} : { signal: control.signal }),
    }),
    ...control,
  });
}

/**
 * The server loop, over injected streams.
 *
 * One line in, at most one line out, strictly in order: `await`ing each dispatch
 * before reading the next line serializes tool calls, which is what stops two
 * concurrent `brigadier_run`s from fighting over the same worktree namespace on
 * a client that pipelines requests. A server that wanted concurrency would need
 * a scheduler, and brigadier already has one — it is called `brigadier run`, and
 * it takes `maxWorkers`.
 */
export async function serveMcp(options: McpServerOptions): Promise<number> {
  const dependencies: ToolDependencies = {
    ...options.dependencies,
    execute: async (request) => {
      options.onCancellable?.();
      return await options.dependencies.execute(request);
    },
  };
  const dispatch = createDispatcher({
    serverName: SERVER_NAME,
    serverVersion: options.version,
    tools: createTools(dependencies),
  });
  const reader = new LineReader(options.stdin);
  for (;;) {
    const read = await raceAbort(options.signal, settle(reader.readLine()));
    if (read === ABORTED) {
      return interruptExitCode(options.signal?.reason);
    }
    if (!read.ok) {
      throw read.error;
    }
    const line = read.value;
    if (line === null) {
      return 0;
    }
    const response = await dispatch(line);
    if (response !== null) {
      options.stdout.write(`${response}\n`);
    }
    if (options.signal?.aborted === true) {
      return interruptExitCode(options.signal.reason);
    }
  }
}

/**
 * The production dependencies: the machine's config, and a real run.
 *
 * Injected rather than reached for inside the tools so `test/mcp.test.ts` can
 * drive the real server, over a real pipe, with real JSON-RPC frames, without
 * `brigadier_run` spawning `claude` at somebody's laptop.
 */
export function createRealDependencies(
  env: ConfigEnvironment,
  control: RealDependenciesControl = {},
): ToolDependencies {
  const stderr = control.stderr ?? process.stderr;
  return {
    async loadConfig(): Promise<LoadedConfig> {
      try {
        const ensured = await ensureConfig({
          environment: env,
          stderr,
          ...(control.discoverer === undefined
            ? {}
            : { discoverer: control.discoverer }),
        });
        return { path: ensured.path, config: ensured.config };
      } catch (error) {
        return {
          path: resolveConfigPath(env),
          config: null,
          reason: describeError(error),
        };
      }
    },
    async execute(request: McpRunRequest) {
      let ensured: EnsureConfigResult;
      try {
        ensured = await ensureConfig({
          environment: env,
          stderr,
          ...(control.discoverer === undefined
            ? {}
            : { discoverer: control.discoverer }),
        });
      } catch (error) {
        return {
          text: describeError(error),
          isError: true,
        };
      }
      const config = ensured.config;
      const launchEnv = requireLaunchEnv(env);
      const log: string[] = [];
      const dependencies = buildRunDependencies({
        config,
        env: launchEnv,
        // NOT stdout. See the header: stdout is the protocol.
        log: (line: string, level = "normal") => {
          if (level === "normal") {
            log.push(line);
          }
        },
      });
      try {
        const report = await createRunner(dependencies).run({
          document: request.document,
          repositoryPath: request.repositoryPath,
          slug: request.slug,
          maxWorkers: request.maxWorkers,
          dryRun: request.dryRun,
          unsafeInPlace: request.unsafeInPlace,
          ...(control.signal === undefined ? {} : { signal: control.signal }),
        });
        const detailLine = await writeRunRecordDetail(report, {
          environment: env,
          repositoryPath: request.repositoryPath,
          linkedSecretPaths: config.linkedSecretPaths,
        });
        // The CLI has already emitted these normal-level lines to its stream.
        // MCP has nowhere else for them to go, so the shared renderer appends
        // them to the tool result while the verbose progress stays discarded.
        return {
          text: renderQuietRunReport(report, { detailLine, log }),
          isError: !report.ok,
        };
      } finally {
        // A long-lived MCP server that leaked one oracle per run would hold a
        // vendor subprocess for the life of the client.
        await Promise.allSettled(
          dependencies.ports.oracles.map((oracle) => oracle.dispose()),
        );
      }
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { ToolDefinition, ToolResult } from "./protocol.js";
export {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./protocol.js";
export type {
  LoadedConfig,
  McpRunRequest,
  ToolDependencies,
} from "./tools.js";
export { createTools } from "./tools.js";
