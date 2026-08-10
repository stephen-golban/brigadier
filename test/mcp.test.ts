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
 * EVERY SESSION IS BOUNDED AND THE BOUND IS ASSERTED. `drive` writes its whole
 * script, closes stdin, and kills the process on a deadline; `timedOut` is
 * asserted false in every test. A server broken into hanging therefore fails in
 * seconds with a clear reason instead of wedging the suite, which is the one
 * failure mode a subprocess test can have that is worse than no test at all.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";

const repositoryRoot = resolve(import.meta.dir, "..");

/**
 * Generous enough that a cold `bun` start on a loaded machine is not flaky, and
 * short enough that a hung server is a fast red rather than a stalled suite.
 */
const TIMEOUT_MS = 20_000;

/**
 * The version pinned into the `initialize` literal below.
 *
 * Asserted separately so a release that bumps `package.json` fails HERE, on one
 * legible line, instead of failing inside a 165-character golden string where
 * the diff is unreadable.
 */
const VERSION = "0.0.0";

interface Session {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
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
): Promise<Session> {
  const proc = Bun.spawn({
    cmd: ["bun", entry],
    cwd: repositoryRoot,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  proc.stdin.write(`${lines.join("\n")}\n`);
  await proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timer);

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
 * `PATH` is carried through only so `bun` itself can be found.
 */
function scratchEnv(scratchHome: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: scratchHome,
    BRIGADIER_HOME: scratchHome,
    USER: "brigadier-test",
  };
}

/* ------------------------------------------------------------------------ */
/* Entry points written into a scratch directory                             */
/* ------------------------------------------------------------------------ */

/**
 * The real exported entry, exactly as `bin/brigadier-mcp.js` will call it.
 *
 * Nothing is faked here. `brigadier_run` reaches the real supervisor path, and
 * the test keeps it bounded by pointing `$BRIGADIER_HOME` at an empty directory:
 * with no config there is nothing to launch, so the tool must refuse in
 * milliseconds rather than spawn a worker at whoever is running the suite.
 */
const REAL_ENTRY = `import { runMcpServer } from ${JSON.stringify(`${repositoryRoot}/src/mcp/server.ts`)};
process.exitCode = await runMcpServer();
`;

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
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"brigadier","version":"0.0.0"}}}',
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
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"brigadier","version":"0.0.0"}}}',
      );
      // An older revision this server does speak is echoed back rather than
      // silently upgraded.
      expect(lines[1]).toBe(
        '{"jsonrpc":"2.0","id":2,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"brigadier","version":"0.0.0"}}}',
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
      expect(tools[0]?.description).toBe(
        "Check a brigadier plan document for shape defects and scheduling defects, and report the dependency waves it would run in. Touches nothing.",
      );
      expect(tools[1]?.description).toBe(
        "Report which vendor, model, and effort this machine would give each slice of a plan, or why no model can take it. Creates no worktree and spawns no worker.",
      );
      expect(tools[2]?.description).toBe(
        "Run a brigadier plan on a local repository: route every slice, spawn a worker for each, commit what it produced, and merge the lot.",
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
            description: "Absolute path to the git repository to run in.",
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

  test("the real exported runMcpServer serves, and refuses to run with no config", async () => {
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

      // The entry point `bin/brigadier-mcp.js` will call, with no injection at
      // all, reporting the version out of package.json.
      expect(lines[0]).toBe(
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"brigadier","version":"0.0.0"}}}',
      );
      // The pure tool is fully real here: no fake touched it.
      expect(lines[1]).toBe(
        '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"plan add-retry is valid: 2 slice(s) in 1 wave(s).\\n  wave 1: retry-core, retry-docs"}],"isError":false}}',
      );
      // Both impure tools refuse against an empty $BRIGADIER_HOME, which is what
      // keeps this test from spawning a worker on the machine running it.
      const configPath = `${home}/config.json`;
      expect(lines[2]).toBe(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: {
            content: [
              {
                type: "text",
                text: `no brigadier config was found at ${configPath}. Run \`brigadier init\` on this machine to scan for worker CLIs and write one.`,
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
                text: `no brigadier config was found at ${configPath}. Run \`brigadier init\` on this machine to scan for worker CLIs and write one.`,
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
});
