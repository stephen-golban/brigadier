/**
 * The MCP server, driven the only way that proves anything: as a real
 * subprocess, over a real pipe, with real JSON-RPC frames, asserting the exact
 * bytes that come back.
 *
 * A green unit test of `createDispatcher` would prove that a function returns a
 * string. It would not prove that the process starts, that the transport is
 * newline-delimited rather than `Content-Length`-framed, that stdout carries the
 * protocol and nothing else, or that a notification is answered with silence —
 * and every one of those is a way a working handler still yields a server no
 * client can talk to.
 *
 * EVERY SESSION IS BOUNDED BY WORK, AND THE BOUND IS ASSERTED. `drive` writes
 * its whole script, closes stdin, and counts every chunk and every byte the
 * child writes against a fixed budget; past either budget it kills the child and
 * throws. That is the bound that matters. A server that streams without ever
 * finishing is otherwise drained without limit for the whole twenty seconds of
 * the deadline below — measured at 20,093 ms, and at a few megabytes a second
 * that is enough to exhaust this runner before the kill ever arrives. The
 * deadline is a leak guard for a SILENT child, nothing more, and `timedOut` is
 * asserted false in every test so it can never quietly rescue a broken run.
 *
 * A server broken into hanging therefore fails in seconds with a clear reason
 * instead of wedging the suite, which is the one failure mode a subprocess test
 * can have that is worse than no test at all.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";

const repositoryRoot = resolve(import.meta.dir, "..");

/**
 * Leak guard only, for a child that writes NOTHING: generous enough that a cold
 * `bun` start on a loaded machine is not flaky, and short enough that a silent
 * hung server is a fast red rather than a stalled suite. A child that writes is
 * caught by the work budgets below instead, and much sooner.
 */
const TIMEOUT_MS = 20_000;

/**
 * The work budgets, in bytes and in chunks.
 *
 * The largest frame any session here provokes is the `tools/list` response, at
 * 5,555 bytes, and the busiest session asks for a handful of much smaller
 * frames on top of it. 64 KiB is therefore an order of magnitude above anything
 * a working server produces and still nowhere near enough to hurt: a server
 * that trips either budget is not answering, it is looping.
 *
 * The chunk budget exists alongside the byte budget because a child can also
 * loop while writing almost nothing — a stream of empty or one-byte writes
 * would sit under a byte budget forever.
 */
const MAX_STREAM_BYTES = 64 * 1024;
const MAX_STREAM_CHUNKS = 256;

/**
 * The version pinned into the `initialize` literal below.
 *
 * Asserted separately so a release that bumps `package.json` fails HERE, on one
 * legible line, instead of failing inside a 165-character golden string where
 * the diff is unreadable.
 */
const VERSION = "0.2.0";

interface Session {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

/**
 * Drains one stream, counting work rather than time.
 *
 * Throws — rather than truncating — past either budget, because a test that
 * quietly accepts a runaway server is a test that passes on broken code. The
 * child is killed first, so the throw is not left waiting on an exit that a
 * looping process would never reach.
 *
 * This is what `new Response(stream).text()` cannot do. That reads to the end of
 * the stream with no budget at all, so against a child that never stops writing
 * it grows a string until the deadline below finally kills the child — twenty
 * seconds of accumulation that a fast writer turns into memory this runner does
 * not have. The budgets here stop the same child in milliseconds.
 */
async function drainBounded(
  stream: ReadableStream<Uint8Array>,
  label: string,
  kill: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let chunks = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        return text + decoder.decode();
      }
      chunks += 1;
      bytes += next.value.byteLength;
      if (chunks > MAX_STREAM_CHUNKS) {
        kill();
        throw new Error(
          `${label} exceeded the ${MAX_STREAM_CHUNKS}-chunk budget: the server is producing output without finishing`,
        );
      }
      if (bytes > MAX_STREAM_BYTES) {
        kill();
        throw new Error(
          `${label} exceeded the ${MAX_STREAM_BYTES}-byte budget: the server is producing output without finishing`,
        );
      }
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Runs one MCP session to completion.
 *
 * stdout and stderr are drained concurrently rather than after exit, because a
 * server whose output filled the pipe buffer would block forever on a write
 * while this side waited for an exit that could never come.
 */
async function drive(
  entry: string,
  lines: readonly string[],
  env: Record<string, string>,
  argv: readonly string[] = [],
): Promise<Session> {
  const proc = Bun.spawn({
    cmd: [process.execPath, entry, ...argv],
    cwd: repositoryRoot,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = (): void => {
    proc.kill(9);
  };
  const stdout = drainBounded(proc.stdout, "stdout", kill);
  const stderr = drainBounded(proc.stderr, "stderr", kill);
  proc.stdin.write(`${lines.join("\n")}\n`);
  await proc.stdin.end();

  // Both rejections are observed from the moment they can happen. A budget
  // overrun rejects while this side is still waiting on `exited`, and a
  // rejection nobody is holding in that window takes the whole runner down
  // instead of failing the one test that provoked it.
  const drained = Promise.allSettled([stdout, stderr]);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  await drained;

  return {
    stdout: await stdout,
    stderr: await stderr,
    exitCode,
    timedOut,
  };
}

/** The response lines, in order, with the trailing newline already accounted for. */
function responses(session: Session): readonly string[] {
  expect(session.timedOut).toBe(false);
  return session.stdout.split("\n").slice(0, -1);
}

/**
 * The scratch home every session gets: no config, no worker CLI, nothing real.
 * The subprocess is launched with this test runner's absolute executable path,
 * so PATH can be empty and prove that lazy configuration sees no real worker.
 */
function scratchEnv(scratchHome: string): Record<string, string> {
  return {
    PATH: "",
    HOME: scratchHome,
    BRIGADIER_HOME: scratchHome,
    USER: "brigadier-test",
  };
}

/* ------------------------------------------------------------------------ */
/* Entry points written into a scratch directory                             */
/* ------------------------------------------------------------------------ */

/**
 * The real exported entry used by the compiled binary's `mcp` subcommand.
 *
 * Nothing is faked here. `brigadier_run` reaches the real supervisor path, and
 * the test keeps it bounded by pointing `$BRIGADIER_HOME` at an empty directory:
 * with no config there is nothing to launch, so the tool must refuse in
 * milliseconds rather than spawn a worker at whoever is running the suite.
 */
const REAL_ENTRY = `import { runMcpServer } from ${JSON.stringify(`${repositoryRoot}/src/mcp/server.ts`)};
process.exitCode = await runMcpServer();
`;

/** The real dependencies, with discovery injected only to make setup portable. */
const LAZY_CONFIG_ENTRY = `import type { Discoverer } from ${JSON.stringify(`${repositoryRoot}/src/discovery/contracts.ts`)};
import { createRealDependencies, serveMcp } from ${JSON.stringify(`${repositoryRoot}/src/mcp/server.ts`)};

const discoverer: Discoverer = {
  discover: async () => ({
    vendors: [{
      vendor: "claude",
      executable: "/opt/brigadier-test/claude",
      version: "2.0.14",
      catalogSource: "static-table",
      models: [{
        id: "claude-opus-4-6",
        displayName: "Claude Opus 4.6",
        supportedEfforts: ["medium", "high"],
        defaultEffort: "high",
        selectable: true,
      }],
    }],
    missing: ["codex"],
    warnings: [],
  }),
};

process.exitCode = await serveMcp({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  version: ${JSON.stringify(VERSION)},
  dependencies: createRealDependencies(process.env, {
    stderr: process.stderr,
    discoverer,
  }),
});
`;

const NO_WORKER_CLI_MESSAGE =
  "no installed worker CLI reported a selectable model. Install Claude Code or Codex, then try again.";

/**
 * The same server with the one impure dependency replaced.
 *
 * `loadConfig` hands over a literal config and `execute` records its request
 * instead of running it, which is what makes the routing assertions below the
 * REAL router's answer against a KNOWN machine rather than whatever happens to
 * be installed on the machine running the tests.
 */
const FAKE_ENTRY = `import type { BrigadierConfig } from ${JSON.stringify(`${repositoryRoot}/src/config/contracts.ts`)};
import { serveMcp } from ${JSON.stringify(`${repositoryRoot}/src/mcp/server.ts`)};

const CONFIG: BrigadierConfig = {
  version: 2,
  vendors: [
    {
      vendor: "claude",
      executable: "/opt/homebrew/bin/claude",
      version: "2.0.14",
      defaultModel: "claude-opus-5",
      models: [
        { id: "claude-opus-5", effortCeiling: "high" },
        { id: "claude-sonnet-5", effortCeiling: "high" },
      ],
    },
  ],
  secretsConsent: false,
  allowDegradedRouting: false,
};

process.exitCode = await serveMcp({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  version: ${JSON.stringify(VERSION)},
  dependencies: {
    loadConfig: () =>
      Promise.resolve({
        path: "/scratch/.brigadier/config.json",
        config: CONFIG,
      }),
    execute: (request) =>
      Promise.resolve({
        text: \`fake execute slug=\${request.slug} maxWorkers=\${request.maxWorkers} dryRun=\${request.dryRun} unsafeInPlace=\${request.unsafeInPlace} repo=\${request.repositoryPath} slices=\${request.document.plan.slices.length}\`,
        isError: false,
      }),
  },
});
`;

/* ------------------------------------------------------------------------ */
/* Plans used by the assertions below                                        */
/* ------------------------------------------------------------------------ */

const VALID_PLAN = {
  id: "add-retry",
  goal: "Retry transient HTTP failures",
  slices: [
    {
      id: "retry-core",
      title: "Retry loop",
      prompt: "write it",
      ownedPaths: ["src/http/retry.ts"],
      difficulty: "hard",
    },
    {
      id: "retry-docs",
      title: "Document it",
      prompt: "write docs",
      ownedPaths: ["docs/retry.md"],
      difficulty: "routine",
    },
  ],
};

function call(id: number, name: string, args: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

describe("the MCP server over stdio", () => {
  test("package.json still carries the version pinned into the golden frames", () => {
    expect(packageJson.version).toBe(VERSION);
  });

  test("brigadier mcp uses the real server when no server is injected", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    try {
      const session = await drive(
        join(repositoryRoot, "src", "cli.ts"),
        ['{"jsonrpc":"2.0","id":13,"method":"ping"}'],
        scratchEnv(home),
        ["mcp"],
      );
      const lines = responses(session);
      expect(lines).toEqual(['{"jsonrpc":"2.0","id":13,"result":{}}']);
      expect(session.stderr).toBe("");
      expect(session.exitCode).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("initialize, ping, and a notification answer with exactly these bytes", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, FAKE_ENTRY, "utf8");
    try {
      const session = await drive(
        entry,
        [
          '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
          '{"jsonrpc":"2.0","method":"notifications/initialized"}',
          '{"jsonrpc":"2.0","id":2,"method":"ping"}',
        ],
        scratchEnv(home),
      );
      const lines = responses(session);

      // THREE REQUESTS IN, TWO LINES OUT. The notification is answered with
      // silence, which JSON-RPC requires and which a strict client disconnects
      // over.
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe(
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"brigadier","version":"0.2.0"}}}',
      );
      expect(lines[1]).toBe('{"jsonrpc":"2.0","id":2,"result":{}}');
      expect(session.stderr).toBe("");
      expect(session.exitCode).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("an unsupported protocolVersion is answered with this server's own", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, FAKE_ENTRY, "utf8");
    try {
      const session = await drive(
        entry,
        [
          '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01","capabilities":{}}}',
          '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}',
        ],
        scratchEnv(home),
      );
      const lines = responses(session);
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe(
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"brigadier","version":"0.2.0"}}}',
      );
      // An older revision this server does speak is echoed back rather than
      // silently upgraded.
      expect(lines[1]).toBe(
        '{"jsonrpc":"2.0","id":2,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"brigadier","version":"0.2.0"}}}',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("tools/list advertises the exact meaning of all three tool schemas", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, FAKE_ENTRY, "utf8");
    try {
      const session = await drive(
        entry,
        ['{"jsonrpc":"2.0","id":3,"method":"tools/list"}'],
        scratchEnv(home),
      );
      const lines = responses(session);
      expect(lines.length).toBe(1);
      const line = lines[0] ?? "";

      const parsed = JSON.parse(line) as {
        jsonrpc: string;
        id: number;
        result: {
          tools: readonly {
            name: string;
            description: string;
            inputSchema: unknown;
          }[];
        };
      };
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.id).toBe(3);
      const tools = parsed.result.tools;
      expect(tools.map((tool) => tool.name)).toEqual([
        "brigadier_validate_plan",
        "brigadier_route_plan",
        "brigadier_run",
      ]);
      // THESE STRINGS ARE THE DOCTRINE, NOT DECORATION. Cursor, Windsurf,
      // Antigravity, and Claude Desktop read no skill directory, so this
      // metadata is the only thing brigadier ever says to their model: when to
      // delegate, that the work goes here rather than inline, how to shape a
      // plan, that a run needs no setup while `brigadier init` is the user's
      // step for enabling hosts and recording GUI-registration consent, and
      // that a worker must never call back in.
      // A GUI host reads no skill file, so if the configuration sentence is not
      // here it reaches that host nowhere at all. They are pinned whole,
      // and `test/surfaces.test.ts` holds the .mcpb manifest to the same bytes.
      expect(tools[0]?.description).toBe(
        "Check a brigadier plan document for shape defects and scheduling defects, and report the dependency waves it would run in. Touches nothing. Draft a plan against this before brigadier_run: it names every defect at once, including two slices that claim the same path.",
      );
      expect(tools[1]?.description).toBe(
        "Report which vendor, model, and effort this machine would give each slice of a plan, or why no model can take it. Creates no worktree and spawns no worker. Worth a call before brigadier_run, because a slice no model can take is worth knowing about before a worker is spent on its siblings.",
      );
      expect(tools[2]?.description).toBe(
        "Hand multi-part coding work to brigadier instead of doing it inline: it routes every slice, gives each its own git worktree and worker, commits what each produced, and merges the lot. Reach for this whenever the work has more than one independent piece — a feature, a cross-file refactor, a migration, a bug with several call sites, a batch of mechanical edits — and route that work here rather than editing the files yourself. Build the plan as the plan argument documents: one slice per independent piece, exclusive ownedPaths (no two slices may claim the same path, or a directory containing another's), and dependsOn naming any slice whose committed output another slice needs. A run needs no setup: brigadier configures itself on first use, so never tell the user to run brigadier init before one. Init is instead the setup step for AI hosts — it records which detected hosts to enable, and the consent that registers brigadier with a GUI host — and only the user, running it interactively, can record either. Never call this if you are yourself a brigadier worker running one slice: re-entry spends the whole slice and lands nothing.",
      );

      // This MCP contract accepts plan documents. Task-to-plan is available on
      // the CLI, but is not a fourth MCP tool.
      expect(tools.some((tool) => tool.name.includes("plan_task"))).toBe(false);

      expect(tools[0]?.inputSchema).toEqual({
        type: "object",
        properties: {
          plan: {
            type: "object",
            description:
              "A brigadier plan document. Every slice requires id, title, prompt, ownedPaths, and difficulty (routine | standard | hard, with no default). requires is optional. dependsOn is optional and names prerequisite slice ids. Dependency waves are reconciled before later worktrees are created, so a dependent slice sees its prerequisites' committed output. Unknown ids, self-dependencies, and cycles are refused.",
            properties: {
              id: { type: "string" },
              goal: { type: "string" },
              slices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    prompt: { type: "string" },
                    ownedPaths: {
                      type: "array",
                      items: { type: "string" },
                    },
                    dependsOn: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "Prerequisite slice ids. Each prerequisite wave is reconciled before this slice's worktree is created.",
                    },
                    difficulty: {
                      enum: ["routine", "standard", "hard"],
                    },
                    requires: {
                      type: "object",
                      properties: {
                        imageInput: { type: "boolean" },
                        webSearch: { type: "boolean" },
                        structuredOutput: { type: "boolean" },
                        minContextWindowTokens: { type: "integer" },
                      },
                    },
                  },
                  required: [
                    "id",
                    "title",
                    "prompt",
                    "ownedPaths",
                    "difficulty",
                  ],
                },
              },
            },
            required: ["id", "goal", "slices"],
          },
        },
        required: ["plan"],
      });
      expect(tools[1]?.inputSchema).toEqual({
        type: "object",
        properties: {
          plan: {
            type: "object",
            description:
              "A brigadier plan document. Every slice requires id, title, prompt, ownedPaths, and difficulty (routine | standard | hard, with no default). requires is optional. dependsOn is optional and names prerequisite slice ids. Dependency waves are reconciled before later worktrees are created, so a dependent slice sees its prerequisites' committed output. Unknown ids, self-dependencies, and cycles are refused.",
            properties: {
              id: { type: "string" },
              goal: { type: "string" },
              slices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    prompt: { type: "string" },
                    ownedPaths: {
                      type: "array",
                      items: { type: "string" },
                    },
                    dependsOn: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "Prerequisite slice ids. Each prerequisite wave is reconciled before this slice's worktree is created.",
                    },
                    difficulty: {
                      enum: ["routine", "standard", "hard"],
                    },
                    requires: {
                      type: "object",
                      properties: {
                        imageInput: { type: "boolean" },
                        webSearch: { type: "boolean" },
                        structuredOutput: { type: "boolean" },
                        minContextWindowTokens: { type: "integer" },
                      },
                    },
                  },
                  required: [
                    "id",
                    "title",
                    "prompt",
                    "ownedPaths",
                    "difficulty",
                  ],
                },
              },
            },
            required: ["id", "goal", "slices"],
          },
        },
        required: ["plan"],
      });
      expect(tools[2]?.inputSchema).toEqual({
        type: "object",
        properties: {
          plan: {
            type: "object",
            description:
              "A brigadier plan document. Every slice requires id, title, prompt, ownedPaths, and difficulty (routine | standard | hard, with no default). requires is optional. dependsOn is optional and names prerequisite slice ids. Dependency waves are reconciled before later worktrees are created, so a dependent slice sees its prerequisites' committed output. Unknown ids, self-dependencies, and cycles are refused.",
            properties: {
              id: { type: "string" },
              goal: { type: "string" },
              slices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    prompt: { type: "string" },
                    ownedPaths: {
                      type: "array",
                      items: { type: "string" },
                    },
                    dependsOn: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "Prerequisite slice ids. Each prerequisite wave is reconciled before this slice's worktree is created.",
                    },
                    difficulty: {
                      enum: ["routine", "standard", "hard"],
                    },
                    requires: {
                      type: "object",
                      properties: {
                        imageInput: { type: "boolean" },
                        webSearch: { type: "boolean" },
                        structuredOutput: { type: "boolean" },
                        minContextWindowTokens: { type: "integer" },
                      },
                    },
                  },
                  required: [
                    "id",
                    "title",
                    "prompt",
                    "ownedPaths",
                    "difficulty",
                  ],
                },
              },
            },
            required: ["id", "goal", "slices"],
          },
          repositoryPath: {
            type: "string",
            description:
              "Path to the git repository to run in, absolute and unambiguous on the platform this server is running on: on POSIX a path beginning with /; on Windows a drive-qualified path such as C:\\repo or a UNC path such as \\\\server\\share. This server's working directory is not the client's, so anything the server would have to resolve against state of its own — a working directory, or a current drive — could silently target the wrong repository. On Windows that rules out /repo, \\repo, and C:repo, all of which are drive-relative. A leading ~ is not expanded.",
          },
          slug: {
            type: "string",
            description:
              "Names every ref this run creates. Defaults to the plan id, made branch-safe.",
          },
          maxWorkers: { type: "integer", minimum: 1 },
          dryRun: {
            type: "boolean",
            description:
              "Route every slice and report it; create no worktree, spawn no worker, write no commit.",
          },
          unsafeInPlace: {
            type: "boolean",
            description:
              "Run workers in the checkout itself instead of isolated worktrees. Every file there becomes visible to every worker.",
          },
        },
        required: ["plan", "repositoryPath"],
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("brigadier_validate_plan reports waves, and every defect at once", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, FAKE_ENTRY, "utf8");
    try {
      const session = await drive(
        entry,
        [
          call(4, "brigadier_validate_plan", { plan: VALID_PLAN }),
          call(5, "brigadier_validate_plan", {
            plan: { id: "x", goal: "y", slices: [{ id: "a" }] },
          }),
          call(6, "brigadier_validate_plan", {
            plan: {
              id: "conflicting",
              goal: "g",
              slices: [
                {
                  id: "one",
                  title: "t",
                  prompt: "p",
                  ownedPaths: ["src/a.ts"],
                  difficulty: "routine",
                },
                {
                  id: "two",
                  title: "t",
                  prompt: "p",
                  ownedPaths: ["src/a.ts"],
                  difficulty: "routine",
                },
              ],
            },
          }),
        ],
        scratchEnv(home),
      );
      const lines = responses(session);
      expect(lines.length).toBe(3);

      expect(lines[0]).toBe(
        '{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"plan add-retry is valid: 2 slice(s) in 1 wave(s).\\n  wave 1: retry-core, retry-docs"}],"isError":false}}',
      );

      // FOUR ISSUES, NOT ONE. A tool that reported the first defect would cost a
      // model turn per defect on a plan it wrote itself.
      expect(lines[1]).toBe(
        '{"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"plan document is not valid (4 issue(s)):\\n  slices[0].title must be a non-empty string\\n  slices[0].prompt must be a non-empty string\\n  slices[0].ownedPaths must be an array\\n  slices[0].difficulty is required and must be one of routine, standard, hard — a plan that does not say how hard a slice is has not been planned"}],"isError":true}}',
      );

      // Shape and schedulability are different questions with different
      // answers. This plan is perfectly well-shaped and cannot be scheduled.
      expect(lines[2]).toBe(
        '{"jsonrpc":"2.0","id":6,"result":{"content":[{"type":"text","text":"plan conflicting cannot be scheduled (1 issue(s)):\\n  PATH_CONFLICT: slices \\"one\\" and \\"two\\" have conflicting ownership claims \\"src/a.ts\\"; both slices claim the exact same path"}],"isError":true}}',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("a multi-line tool result still crosses the wire as exactly one line", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, FAKE_ENTRY, "utf8");
    try {
      const session = await drive(
        entry,
        [call(4, "brigadier_validate_plan", { plan: VALID_PLAN })],
        scratchEnv(home),
      );
      // The text inside carries a newline; the frame must not. A server that
      // wrote the text raw would deliver two messages, and the second would be
      // unparseable.
      expect(session.stdout.split("\n").length).toBe(2);
      expect(session.stdout.endsWith("}\n")).toBe(true);
      const text = (
        JSON.parse(responses(session)[0] ?? "") as {
          result: { content: readonly { text: string }[] };
        }
      ).result.content[0]?.text;
      expect(text).toBe(
        "plan add-retry is valid: 2 slice(s) in 1 wave(s).\n  wave 1: retry-core, retry-docs",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("brigadier_route_plan names the model, the effort, and the quota caveat", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, FAKE_ENTRY, "utf8");
    try {
      const session = await drive(
        entry,
        [call(6, "brigadier_route_plan", { plan: VALID_PLAN })],
        scratchEnv(home),
      );
      const lines = responses(session);
      expect(lines.length).toBe(1);

      // The real router, against the literal config in FAKE_ENTRY: a `hard`
      // slice has exactly one model above the floor, and a `routine` one takes
      // the cheapest. The caveat sentence is not decoration — routing here reads
      // no quota, so this answer can differ from a real run's.
      expect(lines[0]).toBe(
        '{"jsonrpc":"2.0","id":6,"result":{"content":[{"type":"text","text":"plan add-retry: 2 slice(s) routed against this machine\'s config.\\nno quota snapshot is read here, so a drained model is not avoided; a real run learns that from the worker and escalates.\\n  retry-core  claude/claude-opus-5 effort=high\\n  retry-docs  claude/claude-sonnet-5 effort=medium"}],"isError":false}}',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("brigadier_run derives a branch-safe slug and defaults maxWorkers to 1", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, FAKE_ENTRY, "utf8");
    try {
      const onlySlice = [
        {
          id: "s",
          title: "t",
          prompt: "p",
          ownedPaths: ["a.ts"],
          difficulty: "routine",
        },
      ];
      const session = await drive(
        entry,
        [
          call(7, "brigadier_run", {
            plan: { id: "add retry!", goal: "g", slices: onlySlice },
            repositoryPath: "/repo",
            maxWorkers: 3,
            dryRun: true,
          }),
          call(8, "brigadier_run", {
            plan: { id: "plain", goal: "g", slices: onlySlice },
            repositoryPath: "/repo",
          }),
          call(9, "brigadier_run", {
            plan: { id: "plain", goal: "g", slices: onlySlice },
            repositoryPath: "/repo",
            slug: "not a slug",
          }),
          call(10, "brigadier_run", {
            plan: { id: "plain", goal: "g", slices: onlySlice },
          }),
          call(11, "brigadier_run", {
            plan: { id: "plain", goal: "g", slices: onlySlice },
            repositoryPath: "/repo",
            maxWorkers: 0,
          }),
        ],
        scratchEnv(home),
      );
      const lines = responses(session);
      expect(lines.length).toBe(5);

      expect(lines[0]).toBe(
        '{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"fake execute slug=add-retry- maxWorkers=3 dryRun=true unsafeInPlace=false repo=/repo slices=1"}],"isError":false}}',
      );
      // FAN-OUT IS EARNED: an omitted maxWorkers is 1, never "as many as fit".
      expect(lines[1]).toBe(
        '{"jsonrpc":"2.0","id":8,"result":{"content":[{"type":"text","text":"fake execute slug=plain maxWorkers=1 dryRun=false unsafeInPlace=false repo=/repo slices=1"}],"isError":false}}',
      );
      // An explicit bad slug is refused rather than repaired: the slug names
      // every ref the run creates, so a silent substitution collides two plans.
      expect(lines[2]).toBe(
        '{"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"no branch-safe slug is available: pass slug explicitly (letters, digits, dots, underscores, and hyphens, starting with a letter or digit), because none can be derived from plan id \\"plain\\""}],"isError":true}}',
      );
      expect(lines[3]).toBe(
        '{"jsonrpc":"2.0","id":10,"result":{"content":[{"type":"text","text":"repositoryPath must be a non-empty string naming the git repository to run in"}],"isError":true}}',
      );
      expect(lines[4]).toBe(
        '{"jsonrpc":"2.0","id":11,"result":{"content":[{"type":"text","text":"maxWorkers must be a positive whole number"}],"isError":true}}',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("bad frames get the standard codes and never stop the server", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, FAKE_ENTRY, "utf8");
    try {
      const session = await drive(
        entry,
        [
          '{"jsonrpc":"2.0","id":8,"method":"frobnicate"}',
          "{not json",
          '[{"jsonrpc":"2.0","id":9,"method":"ping"}]',
          '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"nope"}}',
          '{"jsonrpc":"1.0","id":12,"method":"ping"}',
          '"a bare string"',
          "",
          '{"jsonrpc":"2.0","id":11,"method":"ping"}',
        ],
        scratchEnv(home),
      );
      const lines = responses(session);

      // Eight lines in, one of them blank and therefore silent: seven out.
      expect(lines.length).toBe(7);
      expect(lines[0]).toBe(
        '{"jsonrpc":"2.0","id":8,"error":{"code":-32601,"message":"unknown method \\"frobnicate\\""}}',
      );
      // The engine's own parse wording is deliberately not forwarded, so this
      // frame is identical under Bun and under Node.
      expect(lines[1]).toBe(
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"invalid JSON"}}',
      );
      expect(lines[2]).toBe(
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"batch requests are not supported: MCP removed JSON-RPC batching in revision 2025-06-18"}}',
      );
      // An unknown TOOL NAME is a protocol error, where a tool that ran and
      // failed is a result with isError. The model must never read the first as
      // a work product.
      expect(lines[3]).toBe(
        '{"jsonrpc":"2.0","id":10,"error":{"code":-32602,"message":"unknown tool \\"nope\\""}}',
      );
      expect(lines[4]).toBe(
        '{"jsonrpc":"2.0","id":12,"error":{"code":-32600,"message":"jsonrpc must be \\"2.0\\""}}',
      );
      expect(lines[5]).toBe(
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"a JSON-RPC message must be an object"}}',
      );
      // THE SERVER IS STILL SERVING after five malformed frames in a row.
      expect(lines[6]).toBe('{"jsonrpc":"2.0","id":11,"result":{}}');
      expect(session.exitCode).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("a tools call without config creates and uses one", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, LAZY_CONFIG_ENTRY, "utf8");
    try {
      const session = await drive(
        entry,
        [call(3, "brigadier_route_plan", { plan: VALID_PLAN })],
        scratchEnv(home),
      );
      const lines = responses(session);
      expect(lines).toHaveLength(1);
      const response = JSON.parse(lines[0] ?? "") as {
        result: {
          isError: boolean;
          content: readonly { text: string; type: string }[];
        };
      };
      expect(response.result).toEqual({
        content: [
          {
            text: "plan add-retry: 2 slice(s) routed against this machine's config.\nno quota snapshot is read here, so a drained model is not avoided; a real run learns that from the worker and escalates.\n  retry-core  claude/claude-opus-4-6 effort=high\n  retry-docs  claude/claude-opus-4-6 effort=medium",
            type: "text",
          },
        ],
        isError: false,
      });
      expect(session.stderr).toContain(
        `brigadier: wrote config to ${home}/config.json`,
      );
      expect(session.exitCode).toBe(0);

      const persisted = JSON.parse(
        await readFile(join(home, "config.json"), "utf8"),
      ) as { version: number; vendors: readonly { vendor: string }[] };
      expect(persisted.version).toBe(3);
      expect(persisted.vendors.map((vendor) => vendor.vendor)).toEqual([
        "claude",
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("the real exported runMcpServer reports why no worker CLI can be configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, REAL_ENTRY, "utf8");
    try {
      const session = await drive(
        entry,
        [
          '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}',
          call(2, "brigadier_validate_plan", { plan: VALID_PLAN }),
          call(3, "brigadier_route_plan", { plan: VALID_PLAN }),
          call(4, "brigadier_run", {
            plan: VALID_PLAN,
            repositoryPath: repositoryRoot,
          }),
        ],
        scratchEnv(home),
      );
      const lines = responses(session);
      expect(lines.length).toBe(4);

      // The server entry point used by the compiled binary's `mcp` subcommand,
      // called here with no injection, reports the version out of package.json.
      expect(lines[0]).toBe(
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"brigadier","version":"0.2.0"}}}',
      );
      // The pure tool is fully real here: no fake touched it.
      expect(lines[1]).toBe(
        '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"plan add-retry is valid: 2 slice(s) in 1 wave(s).\\n  wave 1: retry-core, retry-docs"}],"isError":false}}',
      );
      // Both impure tools use the real lazy configuration path. With PATH empty
      // there is no worker to configure, so the fatal reason is returned in the
      // ordinary ToolResult shape without ever starting a worker.
      expect(lines[2]).toBe(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: {
            content: [
              {
                type: "text",
                text: NO_WORKER_CLI_MESSAGE,
              },
            ],
            isError: true,
          },
        }),
      );
      expect(lines[3]).toBe(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          result: {
            content: [
              {
                type: "text",
                text: NO_WORKER_CLI_MESSAGE,
              },
            ],
            isError: true,
          },
        }),
      );
      expect(session.stderr).toBe("");
      expect(session.exitCode).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("the real configured execute dependency completes a dry run", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-"));
    const entry = join(home, "entry.ts");
    await writeFile(entry, REAL_ENTRY, "utf8");
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 3,
        vendors: [
          {
            vendor: "claude",
            executable: "/must-not-run/claude",
            version: "2.1.226",
            defaultModel: "claude-opus-5",
            models: [{ id: "claude-opus-5", effortCeiling: "high" }],
          },
        ],
        secretsConsent: false,
        linkedSecretPaths: [],
        allowDegradedRouting: false,
      }),
      "utf8",
    );
    try {
      const session = await drive(
        entry,
        [
          call(12, "brigadier_run", {
            plan: VALID_PLAN,
            repositoryPath: repositoryRoot,
            dryRun: true,
          }),
        ],
        { ...scratchEnv(home), PATH: process.env.PATH ?? "" },
      );
      const lines = responses(session);
      expect(lines.length).toBe(1);
      const response = JSON.parse(lines[0] ?? "") as {
        readonly jsonrpc: string;
        readonly id: number;
        readonly result: {
          readonly content: readonly [
            { readonly type: string; readonly text: string },
          ];
          readonly isError: boolean;
        };
      };
      expect({
        jsonrpc: response.jsonrpc,
        id: response.id,
        type: response.result.content[0].type,
        isError: response.result.isError,
        text: response.result.content[0].text.replace(
          /dry run add-retry: 2 slices, \S+ →/,
          "dry run add-retry: 2 slices, <duration> →",
        ),
      }).toEqual({
        jsonrpc: "2.0",
        id: 12,
        type: "text",
        isError: false,
        text: [
          "dry run add-retry: 2 slices, <duration> → (none)",
          "  no verify command; the tests_pass gate will be skipped",
          "  retry-core  would run  (none)  (not reviewed: dry run)",
          "  retry-docs  would run  (none)  (not reviewed: dry run)",
          "  log: run add-retry: 2 slice(s) in 1 wave(s)",
        ].join("\n"),
      });
      expect(await readdir(home)).not.toContain("runs");
      expect(session.stderr).toBe("");
      expect(session.exitCode).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);
});

/* ------------------------------------------------------------------------ */
/* The budgets themselves                                                    */
/* ------------------------------------------------------------------------ */

/**
 * A child that writes and never finishes — the failure the budgets exist for.
 *
 * It writes 4 KiB per tick, so it crosses the 64 KiB byte budget in about
 * seventeen ticks and a few dozen milliseconds. It never exits on its own and
 * never reads its stdin, which is exactly the shape of a server broken into a
 * loop that still has a working stdout.
 */
const RUNAWAY_ENTRY = `const chunk = "x".repeat(4096) + "\\n";
setInterval(() => {
  process.stdout.write(chunk);
}, 1);
`;

describe("the work budgets", () => {
  test("a child that streams without finishing fails the session instead of wedging it", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-mcp-runaway-"));
    try {
      const entry = join(home, "runaway.ts");
      await writeFile(entry, RUNAWAY_ENTRY, "utf8");

      // The budget is what fails this, and it fails it in milliseconds. Read
      // through `new Response(stream).text()` the same child would be drained
      // without limit until the 20-second leak guard finally killed it, having
      // accumulated tens of megabytes on this side first.
      await expect(
        drive(entry, ['{"jsonrpc":"2.0","id":1,"method":"ping"}'], {
          PATH: process.env.PATH ?? "",
        }),
      ).rejects.toThrow(
        "stdout exceeded the 65536-byte budget: the server is producing output without finishing",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a child that loops while writing almost nothing trips the chunk budget", async () => {
    // Driven against a synthetic stream rather than a subprocess, because the
    // point is a child whose BYTES stay small forever, and only a stream this
    // side controls can guarantee the one-byte writes arrive one at a time
    // rather than being coalesced by the pipe on their way over.
    let killed = 0;
    let enqueued = 0;
    // `highWaterMark: 0` so the stream buffers nothing and `pull` runs only for
    // a read that is actually waiting: the count below is then exactly the
    // number of chunks the drain took, with no read-ahead of the default
    // strategy's to explain away.
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          enqueued += 1;
          controller.enqueue(new Uint8Array([0x2e]));
        },
      },
      { highWaterMark: 0 },
    );

    await expect(
      drainBounded(endless, "stdout", () => {
        killed += 1;
      }),
    ).rejects.toThrow(
      "stdout exceeded the 256-chunk budget: the server is producing output without finishing",
    );

    // 257 chunks: the budget is exceeded by the first chunk past it, and not
    // one byte of the 257 was enough to trouble the 65,536-byte budget.
    expect(enqueued).toBe(257);
    expect(killed).toBe(1);
  });
});
