import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrigadierConfig, ConfigIo } from "../src/config/index.ts";
import {
  CONFIG_VERSION,
  ConfigValidationError,
  DEFAULT_EFFORT_CEILING,
  defaultEffortCeiling,
  EFFORT_LADDER,
  narrowEfforts,
  parseConfig,
  readConfig,
  resolveConfigHome,
  resolveConfigPath,
  serializeConfig,
  writeConfig,
} from "../src/config/index.ts";
import { nodeConfigIo } from "../src/config/store.ts";

/**
 * Ways a source file could reach the real home directory. The tokens are
 * assembled at runtime so this guard does not contain, verbatim, the very
 * strings it forbids in the sources it scans — itself included.
 */
const REAL_HOME_TOKENS: readonly string[] = [
  "home".concat("dir"),
  "os.user".concat("Info"),
  "process.env.".concat("HOME"),
];

const CANONICAL: BrigadierConfig = {
  version: CONFIG_VERSION,
  vendors: [
    {
      vendor: "codex",
      executable: "/opt/homebrew/bin/codex",
      version: "0.145.0",
      defaultModel: "gpt-5.6-sol",
      models: [
        { id: "gpt-5.6-sol", effortCeiling: "high" },
        { id: "gpt-5.6-terra", effortCeiling: "medium" },
      ],
      quotaFallbackModel: "gpt-5.6-terra",
    },
  ],
  secretsConsent: false,
};

const CANONICAL_BYTES = `{
  "version": 1,
  "vendors": [
    {
      "vendor": "codex",
      "executable": "/opt/homebrew/bin/codex",
      "version": "0.145.0",
      "defaultModel": "gpt-5.6-sol",
      "models": [
        {
          "id": "gpt-5.6-sol",
          "effortCeiling": "high"
        },
        {
          "id": "gpt-5.6-terra",
          "effortCeiling": "medium"
        }
      ],
      "quotaFallbackModel": "gpt-5.6-terra"
    }
  ],
  "secretsConsent": false
}
`;

describe("config location", () => {
  test("resolves $BRIGADIER_HOME, then $HOME/.brigadier, and never a real home", () => {
    expect(resolveConfigPath({ BRIGADIER_HOME: "/example/scratch" })).toBe(
      "/example/scratch/config.json",
    );
    expect(resolveConfigHome({ BRIGADIER_HOME: "/example/scratch" })).toBe(
      "/example/scratch",
    );
    expect(
      resolveConfigPath({ HOME: "/example/home", BRIGADIER_HOME: "" }),
    ).toBe("/example/home/.brigadier/config.json");
    expect(resolveConfigPath({ HOME: "/example/home" })).toBe(
      "/example/home/.brigadier/config.json",
    );
    expect(() => resolveConfigPath({})).toThrow(ConfigValidationError);
    expect(() => resolveConfigPath({})).toThrow(
      "invalid brigadier config: cannot resolve the brigadier home directory: set $BRIGADIER_HOME or $HOME",
    );
  });

  test("the store consults an injected environment, never the process home", async () => {
    const source = await readFile(
      resolve(import.meta.dir, "../src/config/store.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from "node:os"/);
    for (const token of REAL_HOME_TOKENS) {
      expect(source).not.toContain(token);
    }
  });
});

describe("effort ladder narrowing", () => {
  test("keeps brigadier's three rungs and drops every vendor level outside them", () => {
    expect(
      narrowEfforts(["low", "medium", "high", "xhigh", "max", "ultra"]),
    ).toEqual(["medium", "high", "xhigh"]);
    expect(narrowEfforts(["ultra"])).toEqual([]);
    expect(narrowEfforts(["MAX", " High ", "none"])).toEqual(["high"]);
    expect(narrowEfforts([])).toEqual([]);
    expect(EFFORT_LADDER).toEqual(["medium", "high", "xhigh"]);
    expect(DEFAULT_EFFORT_CEILING).toBe("high");
  });

  test("never proposes a rung the vendor did not report", () => {
    expect(defaultEffortCeiling(["medium", "high", "xhigh"])).toBe("high");
    expect(defaultEffortCeiling(["high", "xhigh"])).toBe("high");
    expect(defaultEffortCeiling(["high"])).toBe("high");
    expect(defaultEffortCeiling(["medium", "xhigh"])).toBe("medium");
    expect(defaultEffortCeiling(["medium"])).toBe("medium");

    // The defect this replaces: both of these returned "high", writing an
    // effort the vendor never offered. A model with no proposable rung has no
    // ceiling at all — `xhigh` is earned on retry and is never predicted here.
    expect(defaultEffortCeiling(["xhigh"])).toBeNull();
    expect(defaultEffortCeiling([])).toBeNull();
  });
});

describe("parseConfig", () => {
  test("accepts a canonical config unchanged", () => {
    expect(parseConfig(structuredClone(CANONICAL))).toEqual(CANONICAL);
    expect(serializeConfig(CANONICAL)).toBe(CANONICAL_BYTES);
  });

  test("rejects a quota fallback that is not one of the vendor's models", () => {
    const doctored = withFallback("gpt-5.6-pro");

    expect(() => parseConfig(doctored)).toThrow(ConfigValidationError);
    try {
      parseConfig(doctored);
      throw new Error("expected parseConfig to reject the absent model");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const validation = error as ConfigValidationError;
      expect(validation.issues).toEqual([
        'codex: quota fallback model "gpt-5.6-pro" is not one of this vendor\'s available models',
      ]);
      expect(validation.message).toBe(
        'invalid brigadier config: codex: quota fallback model "gpt-5.6-pro" is not one of this vendor\'s available models',
      );
    }
  });

  test("rejects every shape outside the documented surface", () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [
        "not-an-object",
        "invalid brigadier config: config must be a JSON object",
      ],
      [
        { ...CANONICAL, apiKey: "sk-live-secret" },
        'invalid brigadier config: config: unknown key "apiKey"',
      ],
      [
        { ...CANONICAL, version: 2 },
        "invalid brigadier config: config version must be 1, received 2",
      ],
      [
        { ...CANONICAL, secretsConsent: "yes" },
        "invalid brigadier config: secretsConsent must be a boolean",
      ],
      [
        {
          ...CANONICAL,
          vendors: [{ ...CANONICAL.vendors[0], vendor: "gemini" }],
        },
        'invalid brigadier config: vendors[0]: unknown vendor "gemini"',
      ],
      [
        { ...CANONICAL, vendors: [CANONICAL.vendors[0], CANONICAL.vendors[0]] },
        "invalid brigadier config: codex: duplicate vendor entry",
      ],
      [
        {
          ...CANONICAL,
          vendors: [{ ...CANONICAL.vendors[0], models: [] }],
        },
        'invalid brigadier config: codex: models must not be empty; codex: default model "gpt-5.6-sol" is not one of this vendor\'s available models; codex: quota fallback model "gpt-5.6-terra" is not one of this vendor\'s available models',
      ],
      [
        {
          ...CANONICAL,
          vendors: [
            {
              ...CANONICAL.vendors[0],
              models: [{ id: "gpt-5.6-sol", effortCeiling: "ultra" }],
              quotaFallbackModel: null,
            },
          ],
        },
        'invalid brigadier config: codex: effort ceiling "ultra" for model "gpt-5.6-sol" is not one of medium, high, xhigh; codex: default model "gpt-5.6-sol" is not one of this vendor\'s available models',
      ],
      [
        {
          ...CANONICAL,
          vendors: [
            { ...CANONICAL.vendors[0], defaultModel: "gpt-5.6-nonexistent" },
          ],
        },
        'invalid brigadier config: codex: default model "gpt-5.6-nonexistent" is not one of this vendor\'s available models',
      ],
      [
        {
          ...CANONICAL,
          vendors: [
            {
              ...CANONICAL.vendors[0],
              models: [
                { id: "gpt-5.6-sol", effortCeiling: "high" },
                { id: "gpt-5.6-sol", effortCeiling: "high" },
              ],
              quotaFallbackModel: null,
            },
          ],
        },
        'invalid brigadier config: codex: duplicate model "gpt-5.6-sol"',
      ],
    ];

    for (const [value, message] of cases) {
      expect(() => parseConfig(value)).toThrow(message);
    }
  });
});

describe("atomic config write", () => {
  test("writes exactly the serialized bytes, owner-only, with no leftovers", async () => {
    await withScratchHome(async (scratchHome) => {
      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      await writeConfig(path, CANONICAL);

      expect(await readFile(path, "utf8")).toBe(CANONICAL_BYTES);
      expect(await readdir(scratchHome)).toEqual(["config.json"]);
      expect((await stat(path)).mode & 0o077).toBe(0);
      expect(await readConfig(path)).toEqual(CANONICAL);
    });
  });

  test("tightens a pre-existing config directory to 0700", async () => {
    await withScratchHome(async (scratchHome) => {
      // `mkdtemp` already creates at 0700, so the directory has to be loosened
      // first for this to prove anything: `mkdir` applies its mode only to
      // directories it creates, and the defect was that a config home left over
      // from an earlier tool — or a hand-made one at 0755 — stayed readable by
      // everyone for every write that followed.
      await chmod(scratchHome, 0o755);
      expect((await stat(scratchHome)).mode & 0o777).toBe(0o755);

      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      await writeConfig(path, CANONICAL);

      expect((await stat(scratchHome)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o077).toBe(0);
    });
  });

  test("an interrupted write leaves a pre-existing config byte-identical", async () => {
    await withScratchHome(async (scratchHome) => {
      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      await writeConfig(path, CANONICAL);
      const before = await readFile(path, "utf8");
      expect(before).toBe(CANONICAL_BYTES);

      const replacement: BrigadierConfig = {
        ...CANONICAL,
        secretsConsent: true,
      };
      const interrupted: ConfigIo = {
        ...nodeConfigIo,
        rename: async () => {
          throw new Error("interrupted before rename");
        },
      };

      await expect(writeConfig(path, replacement, interrupted)).rejects.toThrow(
        "interrupted before rename",
      );

      expect(await readFile(path, "utf8")).toBe(CANONICAL_BYTES);
      expect(await readFile(path, "utf8")).toBe(before);
      expect(await readdir(scratchHome)).toEqual(["config.json"]);
      expect(await readConfig(path)).toEqual(CANONICAL);
    });
  });

  test("refuses to write a config it could not read back", async () => {
    await withScratchHome(async (scratchHome) => {
      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      const doctored = withFallback("gpt-5.6-pro");

      await expect(
        writeConfig(path, doctored as BrigadierConfig),
      ).rejects.toThrow(
        'invalid brigadier config: codex: quota fallback model "gpt-5.6-pro" is not one of this vendor\'s available models',
      );
      expect(await readdir(scratchHome)).toEqual([]);
    });
  });

  test("reads back null when absent and refuses unreadable JSON", async () => {
    await withScratchHome(async (scratchHome) => {
      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      expect(await readConfig(path)).toBeNull();

      await writeFile(path, "{ not json", "utf8");
      await expect(readConfig(path)).rejects.toThrow(ConfigValidationError);
    });
  });
});

test("no test in the suite resolves $BRIGADIER_HOME to the real home directory", async () => {
  const testDirectory = import.meta.dir;
  const files = (await readdir(testDirectory)).filter((name) =>
    name.endsWith(".test.ts"),
  );
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const source = await readFile(join(testDirectory, file), "utf8");

    // Nothing in the suite may reach for the real home directory at all.
    for (const token of REAL_HOME_TOKENS) {
      expect(source).not.toContain(token);
    }

    // Every $BRIGADIER_HOME value must come from the scratch-directory helper.
    const assignments = [
      ...source.matchAll(/BRIGADIER_HOME\s*:\s*([^,\n}]+)/g),
    ];
    for (const assignment of assignments) {
      const value = (assignment[1] ?? "").trim();
      expect(value).toMatch(/^(scratchHome|"\/example\/scratch"|"")$/);
    }

    // Any file that writes a config must be pointing at a scratch home.
    if (source.includes("writeConfig(") || source.includes("runInit(")) {
      expect(source).toContain("BRIGADIER_HOME");
      expect(source).toContain("withScratchHome");
    }
  }
});

/** A config identical to CANONICAL except for a quota fallback set by hand. */
function withFallback(modelId: string): unknown {
  return {
    ...CANONICAL,
    vendors: [{ ...CANONICAL.vendors[0], quotaFallbackModel: modelId }],
  };
}

async function withScratchHome(
  body: (scratchHome: string) => Promise<void>,
): Promise<void> {
  const scratchHome = await mkdtemp(join(tmpdir(), "brigadier-config-"));
  try {
    await body(scratchHome);
  } finally {
    await rm(scratchHome, { recursive: true, force: true });
  }
}
