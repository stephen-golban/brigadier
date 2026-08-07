import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  CLAUDE_CATALOG_SOURCE,
  CLAUDE_STATIC_MODELS,
  CODEX_CATALOG_SOURCE,
  type CommandResult,
  createExecutableResolver,
  type DiscoveredModel,
  type DiscoveredVendor,
  type DiscoveryReport,
  parseCodexCatalog,
  type RunCommand,
  resolveExecutable,
  type VendorCatalogSource,
  VendorDiscoverer,
} from "../src/discovery/index.ts";

const fixtureDirectory = resolve(import.meta.dir, "fixtures");
const CLAUDE_PATH = "/usr/local/bin/claude";
const CODEX_PATH = "/opt/homebrew/bin/codex";
const CLAUDE_VERSION = "2.1.224 (Claude Code)";
const CODEX_VERSION = "codex-cli 0.145.0";

/**
 * A distinctive sentence planted in every fixture entry's `base_instructions`.
 * The real field is a multi-kilobyte prose blob and the real catalog is ~332 KB;
 * asserting this string never reaches a report is how we prove discovery is not
 * carrying a third of a megabyte of vendor prose into a supervisor's memory.
 */
const BASE_INSTRUCTIONS_SENTINEL =
  "FIXTURE_SENTINEL_BASE_INSTRUCTIONS_MUST_NOT_LEAK";
const MODEL_MESSAGES_SENTINEL = "FIXTURE_SENTINEL_MODEL_MESSAGES_MUST_NOT_LEAK";

/** The three models in `codex-debug-models.json`, exactly as discovery reports them. */
const EXPECTED_CODEX_MODELS: readonly DiscoveredModel[] = [
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
    selectable: true,
  },
  {
    id: "gpt-5.6-sol-wm",
    displayName: "GPT-5.6-Sol-WM",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
    selectable: false,
  },
  {
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
    selectable: true,
  },
];

/**
 * A catalog that reports `gpt-5.6-sol` twice: a hidden stub with no reasoning
 * levels FIRST, the real entry SECOND. This is the only shape that can turn a
 * duplicate into a silently missing flagship model, so it is the shape the
 * regression test drives through the whole Codex path.
 */
const STUB_BEFORE_REAL_CATALOG = JSON.stringify({
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      supported_reasoning_levels: [],
      default_reasoning_level: null,
      visibility: "hidden",
    },
    {
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      supported_reasoning_levels: [
        { effort: "medium", description: "medium" },
        { effort: "high", description: "high" },
      ],
      default_reasoning_level: "medium",
      visibility: "list",
    },
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      supported_reasoning_levels: [
        { effort: "medium", description: "medium" },
        { effort: "high", description: "high" },
        { effort: "xhigh", description: "xhigh" },
      ],
      default_reasoning_level: "high",
      visibility: "list",
    },
  ],
});

describe("Codex catalog parsing", () => {
  test("reports the vendor's own reasoning ladder verbatim", async () => {
    const parsed = parseCodexCatalog(await fixture("codex-debug-models.json"));
    if (!parsed.ok) {
      throw new Error(`fixture failed to parse: ${parsed.message}`);
    }

    const sol = parsed.models.find((model) => model.id === "gpt-5.6-sol");
    expect(sol).toBeDefined();
    // Six levels, three of which brigadier's own Effort union cannot express.
    // Discovery must not narrow them: `init` does that.
    expect(sol?.supportedEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(sol?.defaultEffort).toBe("low");
    expect(parsed.models).toEqual(EXPECTED_CODEX_MODELS);
  });

  test("maps visibility to selectability", async () => {
    const parsed = parseCodexCatalog(await fixture("codex-debug-models.json"));
    if (!parsed.ok) {
      throw new Error(`fixture failed to parse: ${parsed.message}`);
    }
    expect(parsed.models.map((model) => [model.id, model.selectable])).toEqual([
      ["gpt-5.6-sol", true],
      ["gpt-5.6-sol-wm", false],
      ["gpt-5.6-terra", true],
    ]);
  });

  test("rejects a truncated catalog instead of reporting zero models", async () => {
    const truncated = await truncatedCatalogStdout();
    // The fixture really is cut off mid-object, partway through an entry.
    expect(truncated).toStartWith('{\n  "models": [');
    expect(truncated).toEndWith('"truncation_policy": {\n  ');

    const parsed = parseCodexCatalog(truncated);
    expect(parsed.ok).toBeFalse();
    if (parsed.ok) {
      throw new Error("truncated fixture parsed as a valid catalog");
    }
    expect(parsed.message).toStartWith(
      "codex model catalog is not valid JSON:",
    );
  });

  test("rejects a well-formed but empty catalog", () => {
    const parsed = parseCodexCatalog('{"models":[]}');
    expect(parsed).toEqual({
      ok: false,
      message: "codex model catalog is empty",
    });
  });

  test("rejects a document with no models array", () => {
    expect(parseCodexCatalog('{"data":[]}')).toEqual({
      ok: false,
      message: "codex model catalog has no `models` array",
    });
  });

  test("reports a duplicate slug rather than dropping it silently", () => {
    const parsed = parseCodexCatalog(
      JSON.stringify({
        models: [
          codexEntry("gpt-5.6-sol", "GPT-5.6 Sol (first)"),
          codexEntry("gpt-5.6-terra", "GPT-5.6 Terra"),
          codexEntry("gpt-5.6-sol", "GPT-5.6 Sol (second)"),
        ],
      }),
    );
    if (!parsed.ok) {
      throw new Error(`unexpected parse failure: ${parsed.message}`);
    }

    // The parser must not collapse duplicates. `VendorDiscoverer.probe` is the
    // single enforcement point for `DiscoveredVendor.models`' uniqueness
    // guarantee, and it can only warn about a duplicate it can still see:
    // deduplicating here made `DiscoveryReport.warnings` silent on the only
    // shipped source that can produce one. The composed behavior is asserted in
    // "collapses a duplicate slug in favor of the entry the user can use".
    expect(parsed.models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
    expect(parsed.models.map((model) => model.displayName)).toEqual([
      "GPT-5.6 Sol (first)",
      "GPT-5.6 Terra",
      "GPT-5.6 Sol (second)",
    ]);
  });

  test("tolerates a future bare-string reasoning ladder", () => {
    const parsed = parseCodexCatalog(
      JSON.stringify({
        models: [
          {
            slug: "gpt-9",
            display_name: "GPT-9",
            supported_reasoning_levels: ["low", "cosmic"],
            default_reasoning_level: "cosmic",
            visibility: "list",
          },
        ],
      }),
    );
    if (!parsed.ok) {
      throw new Error(`unexpected parse failure: ${parsed.message}`);
    }
    expect(parsed.models).toEqual([
      {
        id: "gpt-9",
        displayName: "GPT-9",
        supportedEfforts: ["low", "cosmic"],
        defaultEffort: "cosmic",
        selectable: true,
      },
    ]);
  });
});

describe("VendorDiscoverer", () => {
  test("reports both vendors, their versions, and their catalog sources", async () => {
    const machine = await healthyMachine();
    const report = await machine.discoverer.discover();

    expect(report.missing).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.vendors.map((entry) => entry.vendor)).toEqual([
      "claude",
      "codex",
    ]);

    const claude = vendorNamed(report, "claude");
    expect(claude.executable).toBe(CLAUDE_PATH);
    expect(claude.version).toBe(CLAUDE_VERSION);
    expect(claude.catalogSource).toBe("static-table");
    expect(claude.models).toEqual(CLAUDE_STATIC_MODELS);

    const codex = vendorNamed(report, "codex");
    expect(codex.executable).toBe(CODEX_PATH);
    expect(codex.version).toBe(CODEX_VERSION);
    expect(codex.catalogSource).toBe("probe");
    expect(codex.models).toEqual(EXPECTED_CODEX_MODELS);
  });

  test("probes Claude with --version only and never starts a turn", async () => {
    const machine = await healthyMachine();
    await machine.discoverer.discover();

    // A trivial Claude turn measured $0.0628. The only Claude invocation
    // discovery is allowed to make is `--version`, which makes no API call.
    expect(machine.commands).toEqual([
      [CLAUDE_PATH, ["--version"]],
      [CODEX_PATH, ["--version"]],
      [CODEX_PATH, ["debug", "models"]],
    ]);
    const claudeArgv = machine.commands
      .filter(([executable]) => executable === CLAUDE_PATH)
      .flatMap(([, args]) => args);
    expect(claudeArgv).not.toContain("-p");
    expect(claudeArgv).not.toContain("--output-format");
    expect(claudeArgv).not.toContain("--bare");
  });

  test("keeps vendor catalog prose out of the returned report", async () => {
    const machine = await healthyMachine();
    const report = await machine.discoverer.discover();

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(BASE_INSTRUCTIONS_SENTINEL);
    expect(serialized).not.toContain(MODEL_MESSAGES_SENTINEL);
    expect(serialized).not.toContain("base_instructions");
    // Sanity: the sentinel really is in the fixture the probe just read, so the
    // assertion above is testing discovery rather than an absent fixture.
    expect(await fixture("codex-debug-models.json")).toContain(
      BASE_INSTRUCTIONS_SENTINEL,
    );
  });

  test("resolves — never rejects — when the catalog is unparseable", async () => {
    const truncated = await truncatedCatalogStdout();
    const discoverer = new VendorDiscoverer({
      resolveExecutable: resolverFor({
        claude: CLAUDE_PATH,
        codex: CODEX_PATH,
      }),
      run: fakeRun({
        [`${CODEX_PATH} debug models`]: succeed(truncated),
      }),
    });

    const report = await discoverer.discover();

    expect(report.vendors.map((entry) => entry.vendor)).toEqual(["claude"]);
    expect(report.missing).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]?.cause).toBe("parse-failed");
    expect(report.warnings[0]?.vendor).toBe("codex");
    expect(report.warnings[0]?.message).toStartWith(
      "codex model catalog is not valid JSON:",
    );
  });

  test("classifies a codex exit 2 as probe-failed, not an empty catalog", async () => {
    const argvError = await fixture("codex-argv-error.txt");
    const discoverer = new VendorDiscoverer({
      resolveExecutable: resolverFor({
        claude: CLAUDE_PATH,
        codex: CODEX_PATH,
      }),
      run: fakeRun({
        [`${CODEX_PATH} debug models`]: {
          exitCode: 2,
          stdout: "",
          stderr: argvError,
        },
      }),
    });

    const report = await discoverer.discover();

    // The defect this guards: reporting codex as installed with `models: []`,
    // which would present an argv bug to the user as "this vendor has no models".
    expect(report.vendors.map((entry) => entry.vendor)).toEqual(["claude"]);
    expect(
      report.vendors.some((entry) => entry.models.length === 0),
    ).toBeFalse();
    expect(report.warnings).toEqual([
      {
        vendor: "codex",
        cause: "probe-failed",
        message:
          "`codex debug models` exited 2: error: unexpected argument '--definitely-invalid' found\n\nUsage: codex exec [OPTIONS] [PROMPT] [COMMAND]",
      },
    ]);
  });

  test("enforces unique model ids for every source, not just the Codex parser", async () => {
    // A source that hands back duplicates directly, bypassing the Codex
    // parser: the uniqueness guarantee on `DiscoveredVendor.models` belongs to
    // discovery as a whole, so a vendor added later inherits it.
    const duplicating: VendorCatalogSource = {
      vendor: "codex",
      executable: "codex",
      versionArgs: ["--version"],
      catalogSource: "probe",
      readCatalog: async () => ({
        ok: true,
        models: [
          {
            id: "gpt-5.6-sol",
            displayName: "first",
            supportedEfforts: ["high"],
            defaultEffort: "high",
            selectable: true,
          },
          {
            id: "gpt-5.6-sol",
            displayName: "second",
            supportedEfforts: ["high"],
            defaultEffort: "high",
            selectable: true,
          },
        ],
      }),
    };
    const discoverer = new VendorDiscoverer({
      resolveExecutable: resolverFor({ codex: CODEX_PATH }),
      sources: [duplicating],
      run: fakeRun({}),
    });

    const report = await discoverer.discover();

    expect(report.vendors[0]?.models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
    ]);
    expect(report.vendors[0]?.models[0]?.displayName).toBe("first");
    expect(report.warnings).toEqual([
      {
        vendor: "codex",
        cause: "parse-failed",
        message:
          'codex reported model "gpt-5.6-sol" more than once; the entry describing the most capability was kept',
      },
    ]);
  });

  test("collapses a duplicate slug in favor of the entry the user can use", async () => {
    // The real composed path: the shipped Codex source, its real parser, and
    // the discoverer's dedupe. A catalog that lists a hidden stub for a slug
    // before the usable entry for the same slug used to lose the usable one —
    // silently, because the parser dropped the duplicate before the discoverer
    // could see (and warn about) it. The flagship model then vanished from
    // `init` with no warning and no note, while the header still counted it.
    const discoverer = new VendorDiscoverer({
      resolveExecutable: resolverFor({ codex: CODEX_PATH }),
      sources: [CODEX_CATALOG_SOURCE],
      run: fakeRun({
        [`${CODEX_PATH} debug models`]: succeed(STUB_BEFORE_REAL_CATALOG),
      }),
    });

    const report = await discoverer.discover();

    // (a) the duplicate is named in a warning, on the only shipped source that
    // can actually produce one.
    expect(report.warnings).toEqual([
      {
        vendor: "codex",
        cause: "parse-failed",
        message:
          'codex reported model "gpt-5.6-sol" more than once; the entry describing the most capability was kept',
      },
    ]);

    // (b) the retained entry is the usable one, not the stub that `init` would
    // have excluded for reporting no effort level on brigadier's ladder.
    const models = report.vendors[0]?.models ?? [];
    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(models[0]).toEqual({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      supportedEfforts: ["medium", "high", "xhigh"],
      defaultEffort: "high",
      selectable: true,
    });
  });

  test("reports an absent executable as missing with cause not-found", async () => {
    const discoverer = new VendorDiscoverer({
      resolveExecutable: resolverFor({ claude: CLAUDE_PATH }),
      run: fakeRun({}),
    });

    const report = await discoverer.discover();

    expect(report.missing).toEqual(["codex"]);
    expect(report.vendors.map((entry) => entry.vendor)).toEqual(["claude"]);
    expect(report.warnings).toEqual([
      {
        vendor: "codex",
        cause: "not-found",
        message: "`codex` was not found on PATH",
      },
    ]);
  });

  test("reports a spawn failure as probe-failed without throwing", async () => {
    const discoverer = new VendorDiscoverer({
      resolveExecutable: resolverFor({
        claude: CLAUDE_PATH,
        codex: CODEX_PATH,
      }),
      run: async (executable) => {
        if (executable === CODEX_PATH) {
          throw new Error("spawn EACCES");
        }
        return succeed(`${CLAUDE_VERSION}\n`);
      },
    });

    const report = await discoverer.discover();

    expect(report.missing).toEqual([]);
    expect(report.vendors.map((entry) => entry.vendor)).toEqual(["claude"]);
    expect(report.warnings).toEqual([
      {
        vendor: "codex",
        cause: "probe-failed",
        message: "could not run `codex --version`: spawn EACCES",
      },
    ]);
  });

  test("drops a vendor whose --version exits nonzero", async () => {
    const discoverer = new VendorDiscoverer({
      resolveExecutable: resolverFor({ claude: CLAUDE_PATH }),
      sources: claudeOnly(),
      run: fakeRun({
        [`${CLAUDE_PATH} --version`]: {
          exitCode: 1,
          stdout: "",
          stderr: "keychain unavailable",
        },
      }),
    });

    const report = await discoverer.discover();

    expect(report.vendors).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.warnings).toEqual([
      {
        vendor: "claude",
        cause: "probe-failed",
        message: "`claude --version` exited 1: keychain unavailable",
      },
    ]);
  });

  test("keeps a vendor whose --version succeeds but prints nothing", async () => {
    const discoverer = new VendorDiscoverer({
      resolveExecutable: resolverFor({ claude: CLAUDE_PATH }),
      sources: claudeOnly(),
      run: fakeRun({ [`${CLAUDE_PATH} --version`]: succeed("\n  \n") }),
    });

    const report = await discoverer.discover();

    expect(report.vendors).toHaveLength(1);
    expect(report.vendors[0]?.version).toBe("unknown");
    expect(report.vendors[0]?.models).toEqual(CLAUDE_STATIC_MODELS);
    expect(report.warnings).toEqual([
      {
        vendor: "claude",
        cause: "version-unknown",
        message: "`claude --version` succeeded but printed no version",
      },
    ]);
  });

  test("takes the version verbatim from the CLI's first output line", async () => {
    const discoverer = new VendorDiscoverer({
      resolveExecutable: resolverFor({ claude: CLAUDE_PATH }),
      sources: claudeOnly(),
      run: fakeRun({
        [`${CLAUDE_PATH} --version`]: succeed(
          await fixture("claude-version.txt"),
        ),
      }),
    });

    const report = await discoverer.discover();

    expect(report.vendors[0]?.version).toBe("2.1.224 (Claude Code)");
  });

  test("survives a resolver that throws", async () => {
    const discoverer = new VendorDiscoverer({
      resolveExecutable: () => {
        throw new Error("PATH is unreadable");
      },
      run: fakeRun({}),
    });

    const report = await discoverer.discover();

    expect(report.vendors).toEqual([]);
    expect(report.missing).toEqual(["claude", "codex"]);
    expect(report.warnings.map((warning) => warning.cause)).toEqual([
      "not-found",
      "not-found",
    ]);
  });
});

describe("Claude static table", () => {
  test("offers the current pinned model IDs with the CLI's effort ladder", () => {
    expect(CLAUDE_STATIC_MODELS).toEqual([
      claudeTableEntry("claude-opus-5", "Claude Opus 5"),
      claudeTableEntry("claude-fable-5", "Claude Fable 5"),
      claudeTableEntry("claude-sonnet-5", "Claude Sonnet 5"),
      // Dated: `claude-haiku-4-5` floats to the newest 4.5 Haiku, which would
      // silently change what a recorded config means. The other three have no
      // dated form — those strings are the complete IDs.
      claudeTableEntry("claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
    ]);
  });

  test("pins every table ID to a form that cannot float", () => {
    const ids = CLAUDE_STATIC_MODELS.map((model) => model.id);
    expect(ids).toEqual([
      "claude-opus-5",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    // A bare family alias is what floats; the table must never carry one.
    for (const id of ids) {
      expect(["opus", "sonnet", "haiku", "fable"]).not.toContain(id);
    }
  });
});

describe("resolveExecutable", () => {
  test("returns the first PATH hit as an absolute path", async () => {
    const probe = executableProbe(["/opt/homebrew/bin/codex"]);
    expect(
      await resolveExecutable("codex", {
        pathEnv: "/usr/bin:/opt/homebrew/bin:/usr/local/bin",
        isExecutable: probe,
      }),
    ).toBe("/opt/homebrew/bin/codex");
  });

  test("prefers the earlier PATH entry", async () => {
    const probe = executableProbe([
      "/usr/bin/codex",
      "/opt/homebrew/bin/codex",
    ]);
    expect(
      await resolveExecutable("codex", {
        pathEnv: "/usr/bin:/opt/homebrew/bin",
        isExecutable: probe,
      }),
    ).toBe("/usr/bin/codex");
  });

  test("returns null when PATH is absent or holds no match", async () => {
    const probe = executableProbe(["/opt/homebrew/bin/codex"]);
    expect(
      await resolveExecutable("codex", { isExecutable: probe }),
    ).toBeNull();
    expect(
      await resolveExecutable("codex", {
        pathEnv: "/usr/bin:/bin",
        isExecutable: probe,
      }),
    ).toBeNull();
  });

  test("honors an explicit override ahead of PATH", async () => {
    const probe = executableProbe([
      "/opt/homebrew/bin/codex",
      "/custom/codex-beta",
    ]);
    expect(
      await resolveExecutable("codex", {
        override: "/custom/codex-beta",
        pathEnv: "/opt/homebrew/bin",
        isExecutable: probe,
      }),
    ).toBe("/custom/codex-beta");
  });

  test("fails rather than silently falling back when an override is bad", async () => {
    const probe = executableProbe(["/opt/homebrew/bin/codex"]);
    expect(
      await resolveExecutable("codex", {
        override: "/custom/codex-beta",
        pathEnv: "/opt/homebrew/bin",
        isExecutable: probe,
      }),
    ).toBeNull();
  });

  test("resolves a relative override against the given cwd", async () => {
    const probe = executableProbe(["/work/tools/codex"]);
    expect(
      await resolveExecutable("codex", {
        override: "tools/codex",
        cwd: "/work",
        isExecutable: probe,
      }),
    ).toBe("/work/tools/codex");
  });

  test("treats a name containing a slash as a path, not a PATH search", async () => {
    const probe = executableProbe(["/opt/homebrew/bin/codex"]);
    expect(
      await resolveExecutable("./bin/codex", {
        cwd: "/work",
        pathEnv: "/opt/homebrew/bin",
        isExecutable: probe,
      }),
    ).toBeNull();
  });

  test("skips empty PATH entries rather than searching the cwd", async () => {
    const probe = executableProbe(["/work/codex"]);
    expect(
      await resolveExecutable("codex", {
        pathEnv: ":/usr/bin:",
        cwd: "/work",
        isExecutable: probe,
      }),
    ).toBeNull();
  });

  test("finds a real executable file and rejects a directory or plain file", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "brigadier-discovery-"));
    try {
      const binary = resolve(directory, "codex");
      await writeFile(binary, "#!/bin/sh\nexit 0\n");
      await chmod(binary, 0o755);
      await writeFile(resolve(directory, "claude"), "not executable\n");
      await mkdir(resolve(directory, "fable"));
      await chmod(resolve(directory, "fable"), 0o755);

      expect(await resolveExecutable("codex", { pathEnv: directory })).toBe(
        binary,
      );
      expect(
        await resolveExecutable("claude", { pathEnv: directory }),
      ).toBeNull();
      expect(
        await resolveExecutable("fable", { pathEnv: directory }),
      ).toBeNull();

      const bound = createExecutableResolver({ pathEnv: directory });
      expect(await bound("codex")).toBe(binary);
      expect(await bound("missing-worker")).toBeNull();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function claudeTableEntry(id: string, displayName: string): DiscoveredModel {
  return {
    id,
    displayName,
    // Exactly what `claude --help` prints for `--effort <level>`.
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    // The Claude CLI documents the levels but declares no default.
    defaultEffort: null,
    selectable: true,
  };
}

function vendorNamed(
  report: DiscoveryReport,
  vendor: string,
): DiscoveredVendor {
  const entry = report.vendors.find((candidate) => candidate.vendor === vendor);
  if (entry === undefined) {
    throw new Error(`report has no ${vendor} vendor`);
  }
  return entry;
}

/** A discoverer over a machine where both CLIs are installed and healthy. */
async function healthyMachine(): Promise<{
  readonly discoverer: VendorDiscoverer;
  readonly commands: readonly (readonly [string, readonly string[]])[];
}> {
  const catalog = await fixture("codex-debug-models.json");
  const commands: [string, readonly string[]][] = [];
  const run = fakeRun(
    {
      [`${CLAUDE_PATH} --version`]: succeed(
        await fixture("claude-version.txt"),
      ),
      [`${CODEX_PATH} --version`]: succeed(`${CODEX_VERSION}\n`),
      [`${CODEX_PATH} debug models`]: succeed(catalog),
    },
    commands,
  );
  return {
    discoverer: new VendorDiscoverer({
      resolveExecutable: resolverFor({
        claude: CLAUDE_PATH,
        codex: CODEX_PATH,
      }),
      run,
    }),
    commands,
  };
}

/** Restricts discovery to the Claude source, for vendor-specific assertions. */
function claudeOnly(): readonly VendorCatalogSource[] {
  return [CLAUDE_CATALOG_SOURCE];
}

/**
 * A `RunCommand` backed by a table keyed on "<executable> <args...>". Any
 * command with no table entry succeeds with a plausible version line, so each
 * test only spells out the behavior it is actually about.
 */
function fakeRun(
  responses: Readonly<Record<string, CommandResult>>,
  log?: [string, readonly string[]][],
): RunCommand {
  return async (executable, args) => {
    log?.push([executable, [...args]]);
    const key = [executable, ...args].join(" ");
    const response = responses[key];
    if (response !== undefined) {
      return response;
    }
    if (args.length === 1 && args[0] === "--version") {
      return succeed(
        executable === CLAUDE_PATH
          ? `${CLAUDE_VERSION}\n`
          : `${CODEX_VERSION}\n`,
      );
    }
    throw new Error(`unexpected command in test: ${key}`);
  };
}

/** One `codex debug models` catalog entry, in the shape the real CLI prints. */
function codexEntry(slug: string, displayName: string): unknown {
  return {
    slug,
    display_name: displayName,
    supported_reasoning_levels: [{ effort: "high", description: "high" }],
    default_reasoning_level: "high",
    visibility: "list",
  };
}

function succeed(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

/** Resolves only the vendors named in `installed`; everything else is absent. */
function resolverFor(
  installed: Readonly<Record<string, string>>,
): (name: string) => Promise<string | null> {
  return async (name) => installed[name] ?? null;
}

function executableProbe(
  present: readonly string[],
): (path: string) => Promise<boolean> {
  return async (path) => present.includes(path);
}

async function fixture(name: string): Promise<string> {
  return await Bun.file(resolve(fixtureDirectory, name)).text();
}

/**
 * The byte-truncated `codex debug models` stdout.
 *
 * It is stored inside a JSON wrapper because `biome check` — one of this
 * repository's gates — parses every `.json` file, and a literally malformed one
 * fails that gate before any test runs. Unwrapping here hands the parser the
 * exact truncated bytes, so the test still exercises the real failure.
 */
async function truncatedCatalogStdout(): Promise<string> {
  const wrapper: unknown = JSON.parse(
    await fixture("codex-debug-models-truncated.json"),
  );
  if (
    typeof wrapper !== "object" ||
    wrapper === null ||
    !("stdout" in wrapper) ||
    typeof wrapper.stdout !== "string"
  ) {
    throw new Error("truncated fixture has no `stdout` string");
  }
  return wrapper.stdout;
}
