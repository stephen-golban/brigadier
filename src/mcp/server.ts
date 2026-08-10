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
import type { ConfigEnvironment } from "../config/store.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { buildRunDependencies } from "../init/index.js";
import type { InputStream, OutputStream } from "../init/prompt.js";
// Imported from the module rather than the barrel for the same reason
// `src/init/index.ts` reaches past a barrel for the interrupt helpers: a line
// reader is transport plumbing, not prompt API, and there is exactly one correct
// implementation of "split an async chunk stream into lines" in this repository.
import { LineReader } from "../init/prompt.js";
import type { RunReport, SliceResult } from "../supervisor/contracts.js";
import { createRunner } from "../supervisor/orchestrator.js";
import { requireLaunchEnv } from "../supervisor/slice.js";
import type { MergeResult } from "../worktree/contracts.js";
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
}

/**
 * The entry point `bin/brigadier-mcp.js` calls. Wires the real process streams,
 * the real config store, and the real supervisor.
 *
 * Resolves 0 when stdin reached end of input, which for a stdio MCP server means
 * the client closed the pipe — an ordinary shutdown, not a fault.
 */
export async function runMcpServer(): Promise<number> {
  return await serveMcp({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    version: packageJson.version,
    dependencies: createRealDependencies(process.env),
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
  const dispatch = createDispatcher({
    serverName: SERVER_NAME,
    serverVersion: options.version,
    tools: createTools(options.dependencies),
  });
  const reader = new LineReader(options.stdin);
  for (;;) {
    const line = await reader.readLine();
    if (line === null) {
      return 0;
    }
    const response = await dispatch(line);
    if (response !== null) {
      options.stdout.write(`${response}\n`);
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
): ToolDependencies {
  return {
    async loadConfig(): Promise<LoadedConfig> {
      const path = resolveConfigPath(env);
      return { path, config: await readConfig(path) };
    },
    async execute(request: McpRunRequest) {
      const path = resolveConfigPath(env);
      const config = await readConfig(path);
      if (config === null) {
        return {
          text: `no brigadier config was found at ${path}. Run \`brigadier init\` on this machine to scan for worker CLIs and write one.`,
          isError: true,
        };
      }
      const launchEnv = requireLaunchEnv(env);
      const log: string[] = [];
      const dependencies = buildRunDependencies({
        config,
        env: launchEnv,
        // NOT stdout. See the header: stdout is the protocol.
        log: (line: string) => {
          log.push(line);
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
        });
        return { text: renderReport(report, log), isError: !report.ok };
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

/**
 * The run report, as text a model can act on.
 *
 * One line per slice and one per attempt beneath it, for the reason the CLI
 * renders it that way: a slice that failed on one model and succeeded on a
 * stronger one is the most interesting outcome a run produces, and it is
 * invisible from the verdict alone. The captured log follows, because on this
 * transport there was nowhere else for it to go.
 */
function renderReport(report: RunReport, log: readonly string[]): string {
  const lines: string[] = [
    `${report.dryRun ? "dry run" : "run"} ${report.slug}: ${report.slices.length} slice(s) in ${report.durationMs}ms`,
  ];
  if (report.interrupted) {
    lines.push(
      report.cleanupFailures.length === 0
        ? "  interrupted: workers were cancelled and worktrees removed"
        : "  interrupted: cleanup did not finish; a worker may still be running and a worktree may still exist",
    );
  }
  for (const failure of report.cleanupFailures) {
    lines.push(`  cleanup failure: ${failure}`);
  }
  for (const slice of report.slices) {
    lines.push(`  ${slice.sliceId}  ${describeVerdict(report, slice)}`);
    for (const attempt of slice.attempts) {
      const who =
        attempt.routed === null
          ? "unrouted"
          : `${attempt.routed.vendor}/${attempt.routed.model} effort=${attempt.routed.effort}`;
      const what =
        attempt.failure !== null
          ? `${attempt.failure.kind}: ${attempt.failure.message}`
          : attempt.commit === null
            ? "routed"
            : `ok ${attempt.commit}`;
      lines.push(`      attempt ${attempt.attempt}  ${who}  ${what}`);
    }
  }
  lines.push(`  integration branch: ${report.integrationBranch ?? "(none)"}`);
  for (const merge of report.merges) {
    lines.push(`  merge ${merge.sliceId}: ${describeMerge(merge.result)}`);
  }
  for (const issue of report.planIssues) {
    lines.push(`  plan issue ${issue.code}: ${issue.message}`);
  }
  if (report.failure !== null) {
    lines.push(
      `  run failed: ${report.failure.reason} — ${report.failure.message}`,
    );
  }
  for (const line of log) {
    lines.push(`  log: ${line}`);
  }
  return lines.join("\n");
}

function describeVerdict(report: RunReport, slice: SliceResult): string {
  if (slice.ok) {
    return `ok  ${slice.branch}  ${slice.commit}`;
  }
  if (slice.cancelled === true) {
    return slice.attempts.length === 0
      ? "cancelled  (never started)"
      : "cancelled";
  }
  const kind = slice.attempts.at(-1)?.failure?.kind;
  if (kind !== undefined) {
    return `failed  ${kind}`;
  }
  if (slice.attempts.length === 0) {
    return "failed  (not attempted)";
  }
  return report.dryRun ? "would run" : "not run  (the run stopped first)";
}

function describeMerge(result: MergeResult): string {
  return result.status === "conflicted"
    ? `conflicted — ${result.details}`
    : `${result.status} ${result.commit}`;
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
