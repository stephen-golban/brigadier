import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as packageApi from "../src/index.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

test("root barrel exposes each unit's curated implementation surface", () => {
  const exports = Object.keys(packageApi);

  expect(exports).toEqual(
    expect.arrayContaining([
      "ClaudeWorker",
      "CodexWorker",
      "ClaudeQuotaOracle",
      "CodexQuotaOracle",
      "createClaudeQuotaOracle",
      "createCodexQuotaOracle",
      "GitWorktreeEngine",
      "LinkedSecretCommitError",
      "NoChangesToCommitError",
    ]),
  );
  expect(exports).not.toEqual(
    expect.arrayContaining([
      "isObject",
      "stringValue",
      "failure",
      "asObject",
      "GitCommandError",
      "consumeNdjson",
    ]),
  );
});

test("built dist output executes the Codex quota oracle under Node", () => {
  const build = spawnSync(
    "bun",
    [
      "build",
      "./src/index.ts",
      "./src/contracts.ts",
      "--target=node",
      "--sourcemap",
      "--outdir",
      "./dist",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(build.status, build.stderr).toBe(0);

  const distEntry = pathToFileURL(resolve(repositoryRoot, "dist/index.js"));
  const fakeCodex = resolve(repositoryRoot, "scripts/fakes/codex");
  const script = `
      import { createCodexQuotaOracle } from ${JSON.stringify(distEntry.href)};
      const oracle = createCodexQuotaOracle({
        executable: ${JSON.stringify(fakeCodex)},
        cwd: ${JSON.stringify(repositoryRoot)},
        environment: {
          ...process.env,
          BRIGADIER_FAKE_EXPECTED_ARGV: '["app-server","--stdio"]',
          BRIGADIER_FAKE_EXPECTED_STDIN: '',
          BRIGADIER_FAKE_SCENARIO: 'app-server'
        },
        requestTimeoutMs: 1000
      });
      oracle.snapshot()
        .then((snapshot) => console.log(snapshot.status))
        .finally(() => oracle.dispose());
    `;
  const node = spawnSync("node", ["--input-type=module", "-e", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 5_000,
  });

  expect(node.status, `${node.stdout}\n${node.stderr}`).toBe(0);
  expect(node.stdout.trim()).toBe("available");
  expect(node.stderr).not.toContain("Bun is not defined");
}, 20_000);
