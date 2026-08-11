/**
 * `repositoryPath` MUST BE ABSOLUTE, proved against the real server.
 *
 * An MCP client — Claude Desktop above all — gives nobody control over this
 * server process's working directory. A relative `repositoryPath` would resolve
 * against whatever directory the client's launcher happened to inherit, which
 * means brigadier could create worktrees, spawn workers, and write commits into
 * a repository the caller never named. That is the failure this file exists to
 * keep dead.
 *
 * DRIVEN AS A SUBPROCESS, OVER A REAL PIPE, WITH REAL JSON-RPC FRAMES, and the
 * subprocess is deliberately launched with its cwd set to a scratch directory
 * that is NOT this repository — which is the whole premise of the rule. A unit
 * test of the handler would prove a function returns a string; it would not
 * prove that the running server refuses.
 *
 * "ABSOLUTE" IS NOT THE SAME QUESTION ON EVERY PLATFORM, so the subprocess
 * session below proves the POSIX rule end to end and the two unit tests at the
 * bottom prove the win32 rule, which is live code — brigadier's CLI refuses to
 * run on Windows, but this server's JavaScript entry point does not — that no
 * runner this project has would otherwise execute.
 *
 * BOUNDED BY WORK, NOT BY WALL CLOCK. Every byte and every chunk the server
 * writes is counted against a fixed budget, and the budget is what fails a
 * server that spins — a timer is worthless against a loop that never yields.
 * The kill timer below is a leak guard for a SILENT child, nothing more, and
 * `timedOut` is asserted false so it can never quietly rescue a broken run.
 */

import { expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import {
  isUnambiguousRepositoryPath,
  refuseAmbiguousRepositoryPath,
} from "../src/mcp/tools.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const entry = join(repositoryRoot, "src", "cli.ts");

/**
 * The work budgets. Eight responses of a few hundred bytes each is well under
 * 16 KiB, so a server that trips either of these is not answering — it is
 * looping.
 */
const MAX_STREAM_BYTES = 16 * 1024;
const MAX_STREAM_CHUNKS = 128;

/** Leak guard only: a child that writes NOTHING must not outlive the test. */
const KILL_AFTER_MS = 30_000;

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
 * quietly accepts a runaway server is a test that passes on broken code.
 */
async function drainBounded(
  stream: ReadableStream<Uint8Array>,
  label: string,
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
        throw new Error(
          `${label} exceeded the ${MAX_STREAM_CHUNKS}-chunk budget: the server is producing output without finishing`,
        );
      }
      if (bytes > MAX_STREAM_BYTES) {
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
 * One MCP session: write every frame, close stdin, drain both streams under
 * budget, and report what came back.
 *
 * stdout and stderr are drained concurrently rather than one after the other,
 * because a server that filled the unread pipe would block on a write while
 * this side waited for an exit that could never arrive.
 */
async function drive(
  frames: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<Session> {
  const proc = Bun.spawn({
    cmd: ["bun", entry, "mcp"],
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = drainBounded(proc.stdout, "stdout");
  const stderr = drainBounded(proc.stderr, "stderr");
  proc.stdin.write(`${frames.join("\n")}\n`);
  await proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, KILL_AFTER_MS);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return {
    stdout: await stdout,
    stderr: await stderr,
    exitCode,
    timedOut,
  };
}

/** One slice, the smallest plan that gets past document parsing. */
const PLAN = {
  id: "p",
  goal: "g",
  slices: [
    {
      id: "s",
      title: "t",
      prompt: "pr",
      ownedPaths: ["a.ts"],
      difficulty: "routine",
    },
  ],
};

function run(id: number, repositoryPath: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "brigadier_run",
      arguments: { plan: PLAN, repositoryPath },
    },
  });
}

/**
 * Everything outside the scratch boundary that this test proves the server did
 * not write. `/abs/repo` is the one path the session below hands to the tool and
 * gets ACCEPTED, so it is the one an over-eager server would most plausibly
 * create.
 */
const OUTSIDE_THE_BOUNDARY: readonly string[] = [
  join(repositoryRoot, ".brigadier"),
  join(repositoryRoot, "config.json"),
  "/abs/repo",
];

/**
 * What a path looks like right now: absent, a directory and its entries, or a
 * file and its size and mtime.
 *
 * COMPARED BEFORE AGAINST AFTER, never asserted to be absent outright. The
 * property under test is that the SERVER wrote nothing out here, and a bare
 * `existsSync(...) === false` does not state that property — it states that the
 * machine running the suite happens not to have the path, which is a different
 * claim that some other machine is entitled to falsify. Reading the fingerprint
 * on both sides keeps the real property and makes it independent of whatever
 * was already on disk; it is also strictly stronger than the non-existence
 * check it replaces, because a path that already existed and was MODIFIED now
 * fails too, where before it was never looked at.
 */
function fingerprint(path: string): string {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    return "absent";
  }
  if (stats.isDirectory()) {
    return `directory:[${readdirSync(path).sort().join(",")}]`;
  }
  return `file:${stats.size}:${stats.mtimeMs}`;
}

/** Every path outside the boundary whose fingerprint moved. */
function changedOutsideTheBoundary(
  before: readonly string[],
): readonly string[] {
  return OUTSIDE_THE_BOUNDARY.filter(
    (path, index) => fingerprint(path) !== before[index],
  );
}

test("brigadier_run refuses every relative repositoryPath and accepts every absolute one", async () => {
  const beforeOutside = OUTSIDE_THE_BOUNDARY.map(fingerprint);
  const scratchHome = await mkdtemp(join(tmpdir(), "brigadier-mcp-abspath-"));
  // The server is launched somewhere that is NOT this repository, which is what
  // a relative path would otherwise resolve against.
  const launchDirectory = await mkdtemp(join(tmpdir(), "brigadier-mcp-cwd-"));
  const scratchConfig = join(scratchHome, "config.json");

  try {
    const session = await drive(
      [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        run(2, "/abs/repo"),
        run(3, "relative/repo"),
        run(4, "~/code/repo"),
        run(5, "/abs/repo/"),
        run(6, "/abs/repo/../other"),
        run(7, "./repo"),
        run(8, ""),
      ],
      launchDirectory,
      {
        PATH: process.env.PATH ?? "",
        HOME: scratchHome,
        BRIGADIER_HOME: scratchHome,
        USER: "brigadier-test",
      },
    );

    expect(session.timedOut).toBe(false);
    expect(session.stderr).toBe("");
    expect(session.exitCode).toBe(0);

    const lines = session.stdout.split("\n");
    // Nine frames in, eight responses out plus the trailing empty segment: the
    // notification is answered with silence.
    expect(lines.length).toBe(9);
    expect(lines[8]).toBe("");

    expect(lines[0]).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"brigadier","version":"0.1.1"}}}',
    );

    // ABSOLUTE: accepted by the validator, and it got all the way to the real
    // execute, which refuses only because $BRIGADIER_HOME is empty. That the
    // path named here is the SCRATCH one is also the proof that the owner's
    // ~/.brigadier was never consulted.
    expect(lines[1]).toBe(
      `{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"no brigadier config was found at ${scratchConfig}. Run \`brigadier init\` on this machine to scan for worker CLIs and write one."}],"isError":true}}`,
    );

    // RELATIVE: refused, with the reason and the offending value quoted back.
    expect(lines[2]).toBe(
      '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"repositoryPath must be an absolute path, because this server\'s working directory is not the client\'s, so a relative path would resolve against whatever directory the server happened to be launched in and could silently target the wrong repository. Received \\"relative/repo\\"."}],"isError":true}}',
    );

    // TILDE: not absolute, not expanded, and the message says so — a caller who
    // typed `~` believes it already means their home directory.
    expect(lines[3]).toBe(
      '{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"repositoryPath must be an absolute path, because this server\'s working directory is not the client\'s, so a relative path would resolve against whatever directory the server happened to be launched in and could silently target the wrong repository. Received \\"~/code/repo\\". A leading ~ is not expanded here, because no shell is involved; spell the home directory out in full."}],"isError":true}}',
    );

    // TRAILING SLASH: still absolute, still accepted.
    expect(lines[4]).toBe(
      `{"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"no brigadier config was found at ${scratchConfig}. Run \`brigadier init\` on this machine to scan for worker CLIs and write one."}],"isError":true}}`,
    );

    // INTERIOR `..`: still absolute, still accepted. Normalising it is the
    // worktree engine's job, not this validator's.
    expect(lines[5]).toBe(
      `{"jsonrpc":"2.0","id":6,"result":{"content":[{"type":"text","text":"no brigadier config was found at ${scratchConfig}. Run \`brigadier init\` on this machine to scan for worker CLIs and write one."}],"isError":true}}`,
    );

    // EXPLICITLY RELATIVE: `./` is refused exactly like a bare relative path.
    expect(lines[6]).toBe(
      '{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"repositoryPath must be an absolute path, because this server\'s working directory is not the client\'s, so a relative path would resolve against whatever directory the server happened to be launched in and could silently target the wrong repository. Received \\"./repo\\"."}],"isError":true}}',
    );

    // TWO MISTAKES, TWO MESSAGES: an empty string still gets the original
    // non-empty-string refusal, because "you forgot the argument" and "your
    // path would have run somewhere else" are different repairs.
    expect(lines[7]).toBe(
      '{"jsonrpc":"2.0","id":8,"result":{"content":[{"type":"text","text":"repositoryPath must be a non-empty string naming the git repository to run in"}],"isError":true}}',
    );

    // THE SCHEMA AND THE RUNTIME MUST AGREE. That exact mismatch was a real
    // defect here once, so the advertised description is asserted in the same
    // session that asserts the refusal.
    const listing = await drive(
      ['{"jsonrpc":"2.0","id":9,"method":"tools/list"}'],
      launchDirectory,
      {
        PATH: process.env.PATH ?? "",
        HOME: scratchHome,
        BRIGADIER_HOME: scratchHome,
        USER: "brigadier-test",
      },
    );
    expect(listing.timedOut).toBe(false);
    expect(listing.exitCode).toBe(0);
    const parsed = JSON.parse(listing.stdout.split("\n")[0] ?? "") as {
      result: {
        tools: readonly {
          name: string;
          inputSchema: { properties: { repositoryPath: unknown } };
        }[];
      };
    };
    const runTool = parsed.result.tools.find(
      (tool) => tool.name === "brigadier_run",
    );
    expect(runTool?.inputSchema.properties.repositoryPath).toEqual({
      type: "string",
      description:
        "Path to the git repository to run in, absolute and unambiguous on the platform this server is running on: on POSIX a path beginning with /; on Windows a drive-qualified path such as C:\\repo or a UNC path such as \\\\server\\share. This server's working directory is not the client's, so anything the server would have to resolve against state of its own — a working directory, or a current drive — could silently target the wrong repository. On Windows that rules out /repo, \\repo, and C:repo, all of which are drive-relative. A leading ~ is not expanded.",
    });
    // THE SAFETY PROPERTY: the owner's real ~/.brigadier is untouched.
    //
    // It is asserted WITHOUT naming the real home directory, because
    // `test/config.test.ts` scans every test source in this suite and fails any
    // file that reaches for it — that guard is the same property stated once,
    // globally, and evading it here to restate it locally would be worse than
    // useless. What is left is stronger than a mtime comparison anyway: the
    // server was pointed at $BRIGADIER_HOME and it wrote NOTHING, anywhere.
    //
    // Nothing brigadier-shaped was written even into its own scratch home. The
    // filter is there because macOS itself drops a `Library` directory into any
    // path handed to a subprocess as $HOME, and that is the OS, not brigadier.
    expect(
      (await readdir(scratchHome)).filter(
        (name) => name === "config.json" || name === ".brigadier",
      ),
    ).toEqual([]);
    // Both scratch directories were made by this test moments ago, so absence
    // here is a fact about the server and nothing else.
    expect(existsSync(join(launchDirectory, ".brigadier"))).toBe(false);
    expect(existsSync(join(launchDirectory, "config.json"))).toBe(false);
    // And OUTSIDE the boundary, where the test does not own what is on disk,
    // the assertion is that the server changed nothing — including at
    // `/abs/repo`, the path it accepted.
    expect(changedOutsideTheBoundary(beforeOutside)).toEqual([]);
  } finally {
    await rm(scratchHome, { recursive: true, force: true });
    await rm(launchDirectory, { recursive: true, force: true });
  }
}, 60_000);

/**
 * WHAT "ABSOLUTE" HAS TO MEAN ON WINDOWS, and why `isAbsolute` is not it.
 *
 * `path.win32.isAbsolute` answers TRUE for `/repo` and `\repo`. Those are
 * drive-relative: they resolve to `C:\repo` when the process's current drive is
 * C and `D:\repo` when it is D. A server that accepted them would resolve the
 * caller's path against state the caller cannot see, which is the exact failure
 * the rule exists to prevent, arriving through the primitive chosen to prevent
 * it. The two assertions on `win32.isAbsolute` below are here on purpose: they
 * pin the primitive's real behaviour, so a later reader can see why the code
 * cannot simply call it.
 */
test("an unambiguous repositoryPath names its volume on win32", () => {
  // ACCEPTED: the volume is named, by drive letter or by host and share.
  expect(isUnambiguousRepositoryPath("C:\\repo", "win32")).toBe(true);
  expect(isUnambiguousRepositoryPath("c:/repo", "win32")).toBe(true);
  expect(isUnambiguousRepositoryPath("C:\\repo\\..\\other", "win32")).toBe(
    true,
  );
  expect(isUnambiguousRepositoryPath("\\\\server\\share", "win32")).toBe(true);
  expect(isUnambiguousRepositoryPath("\\\\server\\share\\repo", "win32")).toBe(
    true,
  );

  // REFUSED, AND THE PRIMITIVE DISAGREES: drive-relative, both of them.
  expect(win32.isAbsolute("/repo")).toBe(true);
  expect(win32.isAbsolute("\\repo")).toBe(true);
  expect(isUnambiguousRepositoryPath("/repo", "win32")).toBe(false);
  expect(isUnambiguousRepositoryPath("\\repo", "win32")).toBe(false);

  // REFUSED, and the primitive agrees: relative to the current directory of
  // drive C, which is per-drive state and not the process's working directory.
  expect(win32.isAbsolute("C:repo")).toBe(false);
  expect(isUnambiguousRepositoryPath("C:repo", "win32")).toBe(false);

  // REFUSED: a host with no share names nothing to resolve within.
  expect(isUnambiguousRepositoryPath("\\\\server", "win32")).toBe(false);
  expect(isUnambiguousRepositoryPath("\\\\server\\", "win32")).toBe(false);

  // REFUSED: ordinary relative paths, on Windows as everywhere.
  expect(isUnambiguousRepositoryPath("relative\\repo", "win32")).toBe(false);
  expect(isUnambiguousRepositoryPath(".\\repo", "win32")).toBe(false);
  expect(isUnambiguousRepositoryPath("~\\code\\repo", "win32")).toBe(false);
  expect(isUnambiguousRepositoryPath("", "win32")).toBe(false);
});

/**
 * POSIX IS UNCHANGED, asserted against the predicate directly and stated in the
 * same values the subprocess session above drives end to end.
 *
 * The win32 forms are refused here, which is the deliberate half of the rule:
 * on POSIX `C:\repo` is not a path to a volume at all, it is an ordinary
 * relative filename that happens to contain a colon and a backslash, and
 * accepting it would resolve against the working directory nobody controls.
 */
test("an unambiguous repositoryPath is simply an absolute one on posix", () => {
  for (const platform of ["darwin", "linux"] as const) {
    expect(isUnambiguousRepositoryPath("/abs/repo", platform)).toBe(true);
    expect(isUnambiguousRepositoryPath("/abs/repo/", platform)).toBe(true);
    expect(isUnambiguousRepositoryPath("/abs/repo/../other", platform)).toBe(
      true,
    );
    expect(isUnambiguousRepositoryPath("/", platform)).toBe(true);

    expect(isUnambiguousRepositoryPath("relative/repo", platform)).toBe(false);
    expect(isUnambiguousRepositoryPath("./repo", platform)).toBe(false);
    expect(isUnambiguousRepositoryPath("~/code/repo", platform)).toBe(false);
    expect(isUnambiguousRepositoryPath("", platform)).toBe(false);
    expect(isUnambiguousRepositoryPath("C:\\repo", platform)).toBe(false);
    expect(isUnambiguousRepositoryPath("\\\\server\\share", platform)).toBe(
      false,
    );
  }
});

/**
 * The bytes a caller actually reads. The POSIX message is asserted over the
 * real pipe in the session above; this pins the win32 one, which no runner here
 * can produce, and pins that the two differ only by the clause that applies.
 */
test("the refusal names the Windows rule only on Windows", () => {
  const preamble =
    "repositoryPath must be an absolute path, because this server's working directory is not the client's, so a relative path would resolve against whatever directory the server happened to be launched in and could silently target the wrong repository.";
  const windowsClause =
    " On Windows an absolute path must also name its volume — a drive-qualified path like C:\\repo or a UNC path like \\\\server\\share — because /repo, \\repo, and C:repo are drive-relative and resolve against a current drive or per-drive directory the caller cannot see.";
  const tildeClause =
    " A leading ~ is not expanded here, because no shell is involved; spell the home directory out in full.";

  expect(refuseAmbiguousRepositoryPath("/repo", "win32")).toEqual({
    text: `${preamble} Received "/repo".${windowsClause}`,
    isError: true,
  });
  expect(refuseAmbiguousRepositoryPath("~\\code\\repo", "win32")).toEqual({
    text: `${preamble} Received "~\\\\code\\\\repo".${windowsClause}${tildeClause}`,
    isError: true,
  });
  expect(refuseAmbiguousRepositoryPath("relative/repo", "linux")).toEqual({
    text: `${preamble} Received "relative/repo".`,
    isError: true,
  });
  expect(refuseAmbiguousRepositoryPath("~/code/repo", "darwin")).toEqual({
    text: `${preamble} Received "~/code/repo".${tildeClause}`,
    isError: true,
  });

  // Accepted paths produce no refusal at all, on either platform.
  expect(refuseAmbiguousRepositoryPath("/abs/repo", "darwin")).toBe(null);
  expect(refuseAmbiguousRepositoryPath("C:\\repo", "win32")).toBe(null);
});
