import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as packageApi from "../src/index.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

/**
 * The exact public surface, sorted.
 *
 * This is an exact-set assertion on purpose. The previous `arrayContaining`
 * spot-check could never fail on growth: it passed as long as the named symbols
 * existed, so a unit could triple the barrel without a single test noticing.
 * Adding or removing a package export must be a deliberate edit to this list,
 * reviewed like any other API change.
 */
const PUBLIC_API: readonly string[] = [
  "ADAPTER_DECLARATIONS",
  "CLAUDE_STATIC_MODELS",
  "COMPETENCE_TABLE",
  "CONFIG_FILE_NAME",
  "CONFIG_HOME_VARIABLE",
  "CONFIG_VERSION",
  "ClaudeQuotaOracle",
  "ClaudeWorker",
  "CodexQuotaOracle",
  "CodexWorker",
  "ConfigValidationError",
  "DEFAULT_EFFORT_CEILING",
  "DEFAULT_IDLE_TIMEOUT_MS",
  "EFFORT_LADDER",
  "FAILURE_KINDS",
  "GitWorktreeEngine",
  "IDLE_TIMEOUT_BOUNDARY_MS",
  "LinkedSecretCommitError",
  "NoChangesToCommitError",
  "VendorDiscoverer",
  "buildClaudeCommand",
  "buildCodexCommand",
  "claudeWorker",
  "codexWorker",
  "createClaudeQuotaOracle",
  "createCodexQuotaOracle",
  "createDiscoverer",
  "createIdleTimeoutMs",
  "defaultEffortCeiling",
  "narrowEfforts",
  "normalizeClaudeRateLimitEvent",
  "normalizeCodexRateLimits",
  "parseCodexCatalog",
  "parseConfig",
  "proposeConfig",
  "readConfig",
  "readNdjson",
  "resolveConfigHome",
  "resolveConfigPath",
  "runInit",
  "serializeConfig",
  "withDefaultModel",
  "withEffortCeiling",
  "withQuotaFallback",
  "withSecretsConsent",
  "writeConfig",
];

test("root barrel exposes exactly the curated public surface", () => {
  const exports = Object.keys(packageApi).sort();

  expect(exports).toEqual([...PUBLIC_API]);
  expect(exports).toHaveLength(46);
});

test("root barrel leaks neither internals nor CLI and discovery plumbing", () => {
  const exports = Object.keys(packageApi);

  // Asserted one at a time: `not.toEqual(arrayContaining([a, b]))` passes as
  // soon as a single name is absent, so a list of them proves almost nothing.
  const mustNotLeak: readonly string[] = [
    "isObject",
    "stringValue",
    "failure",
    "asObject",
    "GitCommandError",
    "consumeNdjson",
    "LineReader",
    "confirmPrompt",
    "selectPrompt",
    "rankModels",
    "nodeConfigIo",
    "isEffort",
    // CLI internals: `src/cli.ts` imports these from `./init/index.js`.
    "runCli",
    "USAGE",
    // Discovery wiring and low-level readers.
    "VENDOR_CATALOG_SOURCES",
    "CLAUDE_CATALOG_SOURCE",
    "CODEX_CATALOG_SOURCE",
    "CLAUDE_VERSION_ARGS",
    "CODEX_VERSION_ARGS",
    "CODEX_CATALOG_ARGS",
    "readClaudeCatalog",
    "readCodexCatalog",
    "createCommandRunner",
    "createExecutableResolver",
    "resolveExecutable",
    // Prompt copy, not API.
    "EFFORT_CEILING_NOTE",
    "EFFORT_CEILING_WARNING",
    "ROUTER_NOTE",
    "FALLBACK_NONE_LABEL",
  ];

  for (const name of mustNotLeak) {
    expect(exports).not.toContain(name);
  }
  expect(mustNotLeak).toHaveLength(29);
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
