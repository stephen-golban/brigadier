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
  "ATTEMPT_LIMIT",
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
  "DIFFICULTY_FLOORS",
  "EFFORT_LADDER",
  "FAILURE_KINDS",
  "GitWorktreeEngine",
  "IDLE_TIMEOUT_BOUNDARY_MS",
  "LinkedSecretCommitError",
  "NoChangesToCommitError",
  "PlanDocumentError",
  "REVIEW_SKIP_REASONS",
  "RUN_FAILURE_REASONS",
  "SLICE_FAILURE_KINDS",
  "VendorDiscoverer",
  "buildCapabilities",
  "buildClaudeCommand",
  "buildCodexCommand",
  "buildWorkerSpec",
  "claudeWorker",
  "codexWorker",
  "createClaudeQuotaOracle",
  "createClaudeWorker",
  "createCodexQuotaOracle",
  "createCodexWorker",
  "createCrossVendorReviewer",
  "createDiscoverer",
  "createIdleTimeoutMs",
  "createRunner",
  "createSliceRunner",
  "defaultEffortCeiling",
  "narrowEfforts",
  "normalizeClaudeRateLimitEvent",
  "normalizeCodexRateLimits",
  "parseCodexCatalog",
  "parseConfig",
  "parsePlanDocument",
  "proposeConfig",
  "readConfig",
  "readNdjson",
  "requireLaunchEnv",
  "resolveConfigHome",
  "resolveConfigPath",
  "route",
  "runInit",
  "runOneShotPrompt",
  "serializeConfig",
  "validatePlan",
  "withDefaultModel",
  "withDegradedRouting",
  "withEffortCeiling",
  "withSecretsConsent",
  "writeConfig",
];

test("root barrel exposes exactly the curated public surface", () => {
  const exports = Object.keys(packageApi).sort();

  expect(exports).toEqual([...PUBLIC_API]);
  expect(exports).toHaveLength(64);
});

test("root barrel leaks neither internals nor CLI and discovery plumbing", () => {
  const exports = Object.keys(packageApi);

  // Asserted one at a time: `not.toEqual(arrayContaining([a, b]))` passes as
  // soon as a single name is absent, so a list of them proves almost nothing.
  const mustNotLeak: readonly string[] = [
    "PlanValidationOptions",
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
    "runPlan",
    "buildRunDependencies",
    "createWorkerFactory",
    // Supervisor internals. The orchestrator's branch numbering and its worker
    // pool are a contract with `GitWorktreeEngine`'s refs, not with a consumer;
    // `DefaultSliceRunner` is the class behind `createSliceRunner`; and the
    // capability table is the lookup behind `buildCapabilities`, whose derived
    // `Capability[]` is the artifact worth auditing.
    "allocateAttemptSlots",
    "runBounded",
    "DefaultSliceRunner",
    "CAPABILITY_TABLE",
    "matchCapabilityRule",
    // Review-gate internals. `spawnWorker` is the vendor-correlation guard the
    // slice runner and the one-shot primitive share; `parseFindings` is this
    // build's tolerance of a reviewer's reply format, which has to stay free to
    // change as the vendors' output does.
    "spawnWorker",
    "parseFindings",
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
    "DEGRADED_ROUTING_QUESTION",
    // Routing internals. `COMPETENCE_TABLE` and `DIFFICULTY_FLOORS` are API
    // because decision #7 promises the ranking is auditable data; the scoring
    // path that reads them is how the router and `init` stay in agreement, and
    // exporting it would freeze the table's shape rather than its contents.
    "matchCompetenceRule",
    "scoreModelId",
    "UNRANKED_RATIONALE",
    "UNRANKED_SCORE",
  ];

  for (const name of mustNotLeak) {
    expect(exports).not.toContain(name);
  }
  expect(mustNotLeak).toHaveLength(44);
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
