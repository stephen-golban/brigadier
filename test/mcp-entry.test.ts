import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";

const repositoryRoot = resolve(import.meta.dir, "..");
const executable = join(repositoryRoot, "bin", "brigadier-mcp.js");
const sourceBundle = join(repositoryRoot, "src", "mcp", "server.js");
const sourceMap = `${sourceBundle}.map`;
const distributionBundle = join(repositoryRoot, "dist", "mcp", "server.js");
const TIMEOUT_MS = 5_000;

interface Session {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

async function runBounded(
  command: readonly string[],
  input = "",
  env: Record<string, string | undefined> = process.env,
): Promise<Session> {
  const process = Bun.spawn({
    cmd: [...command],
    cwd: repositoryRoot,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(process.stdout).text();
  const stderr = new Response(process.stderr).text();
  process.stdin.write(input);
  await process.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill(9);
  }, TIMEOUT_MS);
  const exitCode = await process.exited;
  clearTimeout(timer);

  return {
    stdout: await stdout,
    stderr: await stderr,
    exitCode,
    timedOut,
  };
}

test("build:mcp writes only the distribution bundle and the package build includes it", async () => {
  const build = await runBounded(["bun", "run", "build:mcp"]);

  expect(build.timedOut).toBe(false);
  expect(build.exitCode).toBe(0);
  expect(existsSync(sourceBundle)).toBe(false);
  expect(existsSync(sourceMap)).toBe(false);
  expect(existsSync(distributionBundle)).toBe(true);
  expect(packageJson.scripts["build:mcp"]).toBe(
    "bun build ./src/mcp/server.ts --target=node --minify --sourcemap --outdir ./dist/mcp",
  );
  expect(packageJson.scripts.build).toBe(
    "bun run build:dist && bun run build:mcp && bun run build:binary && bun run build:codesign",
  );
}, 10_000);

test("the packaged executable answers initialize over its real stdio transport", async () => {
  const build = await runBounded(["bun", "run", "build:mcp"]);
  expect(build.timedOut).toBe(false);
  expect(build.exitCode).toBe(0);

  const scratchHome = await mkdtemp(join(tmpdir(), "brigadier-mcp-entry-"));
  try {
    const session = await runBounded(
      [executable],
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}\n',
      {
        PATH: process.env.PATH,
        HOME: scratchHome,
        BRIGADIER_HOME: scratchHome,
        USER: "brigadier-test",
      },
    );

    expect(session.timedOut).toBe(false);
    expect(session.stdout).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"brigadier","version":"0.0.0"}}}\n',
    );
    expect(session.stderr).toBe("");
    expect(session.exitCode).toBe(0);
  } finally {
    await rm(scratchHome, { recursive: true, force: true });
  }
}, 10_000);
