import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";
import type { BrigadierConfig } from "../src/config/index.ts";
import {
  readConfig,
  resolveConfigPath,
  writeConfig,
} from "../src/config/index.ts";
import type {
  DiscoveredModel,
  Discoverer,
  DiscoveryReport,
} from "../src/discovery/contracts.ts";
import type { InputStream, OutputStream } from "../src/init/index.ts";
import {
  DEGRADED_ROUTING_QUESTION,
  EFFORT_CEILING_WARNING,
  proposeConfig,
  runCli,
  runInit,
  withDefaultModel,
  withDegradedRouting,
} from "../src/init/index.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

const SOL: DiscoveredModel = {
  id: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  // Includes two levels outside brigadier's three-rung ladder.
  supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  defaultEffort: "high",
  selectable: true,
};

const TERRA: DiscoveredModel = {
  id: "gpt-5.6-terra",
  displayName: "GPT-5.6 Terra",
  supportedEfforts: ["low", "medium", "high", "xhigh"],
  defaultEffort: "medium",
  selectable: true,
};

const OPUS: DiscoveredModel = {
  id: "claude-opus-4-6",
  displayName: "Claude Opus 4.6",
  supportedEfforts: ["medium", "high", "xhigh"],
  defaultEffort: "high",
  selectable: true,
};

const SONNET: DiscoveredModel = {
  id: "claude-sonnet-4-6",
  displayName: "Claude Sonnet 4.6",
  supportedEfforts: ["medium", "high"],
  defaultEffort: "high",
  selectable: true,
};

/**
 * Reports no effort level on brigadier's ladder at all, so brigadier has no
 * ceiling it could honestly record for it: excluded, with the reason shown.
 */
const HAIKU: DiscoveredModel = {
  id: "claude-haiku-4-6",
  displayName: "Claude Haiku 4.6",
  supportedEfforts: [],
  defaultEffort: null,
  selectable: true,
};

const RETIRED: DiscoveredModel = {
  id: "claude-opus-4-1-retired",
  displayName: "Claude Opus 4.1 (retired)",
  supportedEfforts: ["medium", "high"],
  defaultEffort: "high",
  selectable: false,
};

/** Exactly two Codex models: enough to prove a choice was offered. */
const CODEX_REPORT: DiscoveryReport = {
  vendors: [
    {
      vendor: "codex",
      executable: "/opt/homebrew/bin/codex",
      version: "0.145.0",
      models: [SOL, TERRA],
      catalogSource: "probe",
    },
  ],
  missing: ["claude"],
  warnings: [
    {
      vendor: "claude",
      message: "claude was not found on PATH",
      cause: "not-found",
    },
  ],
};

/**
 * The same Opus id the prior config names, still installed, but now reporting
 * `xhigh` and nothing else — the second way a model can leave the selectable
 * set, and the one the "no longer installed" wording predates.
 */
const OPUS_XHIGH_ONLY: DiscoveredModel = {
  id: "claude-opus-4-6",
  displayName: "Claude Opus 4.6",
  supportedEfforts: ["xhigh"],
  defaultEffort: "xhigh",
  selectable: true,
};

const XHIGH_ONLY_OPUS_REPORT: DiscoveryReport = {
  vendors: [
    {
      vendor: "claude",
      executable: "/opt/homebrew/bin/claude",
      version: "2.0.14",
      models: [OPUS_XHIGH_ONLY, SONNET],
      catalogSource: "static-table",
    },
  ],
  missing: ["codex"],
  warnings: [],
};

/** Every Codex model reports xhigh only: installed, and undrivable. */
const XHIGH_ONLY_CODEX_REPORT: DiscoveryReport = {
  vendors: [
    {
      vendor: "claude",
      executable: "/opt/homebrew/bin/claude",
      version: "2.0.14",
      models: [SONNET],
      catalogSource: "static-table",
    },
    {
      vendor: "codex",
      executable: "/opt/homebrew/bin/codex",
      version: "0.145.0",
      models: [
        { ...SOL, supportedEfforts: ["xhigh"], defaultEffort: "xhigh" },
        { ...TERRA, supportedEfforts: ["xhigh"], defaultEffort: "xhigh" },
      ],
      catalogSource: "probe",
    },
  ],
  missing: [],
  warnings: [],
};

const BOTH_VENDORS_REPORT: DiscoveryReport = {
  vendors: [
    {
      vendor: "claude",
      executable: "/opt/homebrew/bin/claude",
      version: "2.0.14",
      models: [SONNET, RETIRED, OPUS, HAIKU],
      catalogSource: "static-table",
    },
    {
      vendor: "codex",
      executable: "/opt/homebrew/bin/codex",
      version: "0.145.0",
      models: [TERRA, SOL],
      catalogSource: "probe",
    },
  ],
  missing: [],
  warnings: [],
};

const BOTH_VENDORS_CONFIG: BrigadierConfig = {
  version: 2,
  vendors: [
    {
      vendor: "claude",
      executable: "/opt/homebrew/bin/claude",
      version: "2.0.14",
      defaultModel: "claude-opus-4-6",
      // claude-haiku-4-6 is absent on purpose: it reports no brigadier-ladder
      // effort, so there is no ceiling that would not lie about the vendor.
      models: [
        { id: "claude-opus-4-6", effortCeiling: "high" },
        { id: "claude-sonnet-4-6", effortCeiling: "high" },
      ],
    },
    {
      vendor: "codex",
      executable: "/opt/homebrew/bin/codex",
      version: "0.145.0",
      defaultModel: "gpt-5.6-sol",
      models: [
        { id: "gpt-5.6-sol", effortCeiling: "high" },
        { id: "gpt-5.6-terra", effortCeiling: "high" },
      ],
    },
  ],
  secretsConsent: false,
  allowDegradedRouting: false,
};

describe("brigadier init --yes", () => {
  test("writes the proposed config to $BRIGADIER_HOME and exits 0", async () => {
    await withScratchHome(async (scratchHome) => {
      const stdout = collector();
      const stderr = collector();

      const code = await runInit({
        discoverer: fakeDiscoverer(BOTH_VENDORS_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr,
        assumeYes: true,
        printConfig: false,
      });

      expect(code).toBe(0);
      expect(stderr.text()).toBe("");

      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      expect(await readdir(scratchHome)).toEqual(["config.json"]);
      const raw = await readFile(path, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw)).toEqual(BOTH_VENDORS_CONFIG);
      expect(stdout.text()).toContain(`Wrote ${path}`);
    });
  });

  test('writes an effort ceiling of exactly "high" with no prompting', async () => {
    await withScratchHome(async (scratchHome) => {
      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(BOTH_VENDORS_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        assumeYes: true,
        printConfig: false,
      });
      expect(code).toBe(0);

      const written = await readConfig(
        resolveConfigPath({ BRIGADIER_HOME: scratchHome }),
      );
      const ceilings = (written?.vendors ?? []).flatMap((vendor) =>
        vendor.models.map((model) => `${model.id}=${model.effortCeiling}`),
      );
      expect(ceilings).toEqual([
        "claude-opus-4-6=high",
        "claude-sonnet-4-6=high",
        "gpt-5.6-sol=high",
        "gpt-5.6-terra=high",
      ]);

      // No prompt was rendered: the transcript never asks for input.
      expect(stdout.text()).not.toContain("[Y/n]");
      expect(stdout.text()).not.toContain("[y/N]");
      expect(stdout.text()).not.toContain("Choose 1-");
    });
  });

  test("writes secrets consent of exactly false", async () => {
    await withScratchHome(async (scratchHome) => {
      const code = await runInit({
        discoverer: fakeDiscoverer(BOTH_VENDORS_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout: collector(),
        stderr: collector(),
        assumeYes: true,
        printConfig: false,
      });
      expect(code).toBe(0);

      const written = await readConfig(
        resolveConfigPath({ BRIGADIER_HOME: scratchHome }),
      );
      expect(written?.secretsConsent).toBe(false);
      expect(JSON.stringify(written)).not.toContain("token");
      expect(JSON.stringify(written)).not.toContain("apiKey");
    });
  });

  test("renders the probe result so a real probe is distinguishable from a table", async () => {
    await withScratchHome(async (scratchHome) => {
      const stdout = collector();
      await runInit({
        discoverer: fakeDiscoverer(CODEX_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        assumeYes: true,
        printConfig: false,
      });

      const text = stdout.text();
      expect(text).toContain("codex  v0.145.0  /opt/homebrew/bin/codex");
      expect(text).toContain("2 model(s), 2 selectable  |  catalog: probe");
      expect(text).toContain("not installed: claude");
      expect(text).toContain(
        "warning [claude/not-found]: claude was not found on PATH",
      );
      expect(text).toContain("Vendor is never a routing input.");
    });
  });
});

describe("brigadier init --print-config", () => {
  test("emits valid JSON, exits 0, and writes nothing", async () => {
    await withScratchHome(async (scratchHome) => {
      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(BOTH_VENDORS_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        assumeYes: false,
        printConfig: true,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.text())).toEqual(BOTH_VENDORS_CONFIG);
      expect(
        existsSync(resolveConfigPath({ BRIGADIER_HOME: scratchHome })),
      ).toBe(false);
      expect(await readdir(scratchHome)).toEqual([]);
    });
  });

  test("still emits valid JSON when no worker CLI was found", async () => {
    await withScratchHome(async (scratchHome) => {
      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer({
          vendors: [],
          missing: ["claude", "codex"],
          warnings: [],
        }),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        assumeYes: true,
        printConfig: true,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.text())).toEqual({
        version: 2,
        vendors: [],
        secretsConsent: false,
        allowDegradedRouting: false,
      });
    });
  });

  test("a write run with nothing installed exits 1 and writes nothing", async () => {
    await withScratchHome(async (scratchHome) => {
      const stderr = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer({
          vendors: [],
          missing: ["claude", "codex"],
          warnings: [],
        }),
        env: { BRIGADIER_HOME: scratchHome },
        stdout: collector(),
        stderr,
        assumeYes: true,
        printConfig: false,
      });

      expect(code).toBe(1);
      expect(stderr.text()).toContain(
        "no installed worker CLI reported a selectable model",
      );
      expect(await readdir(scratchHome)).toEqual([]);
    });
  });
});

/**
 * WO-010H replaced the per-vendor quota-fallback prompt — "When codex quota
 * drains, fall back to:" plus a model list — with one question about the
 * behaviour the setting actually controls. The prompt's copy is part of the
 * change and not decoration: the old wording described a substitution that
 * per-model quota metering had already made the ordinary pipeline perform on
 * merit, so a user answering it was consenting to one thing while reading
 * about another.
 */
describe("degraded routing", () => {
  test("is asked once for the whole config, not once per vendor", async () => {
    await withScratchHome(async (scratchHome) => {
      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(BOTH_VENDORS_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        // claude: accept model, no ceiling change.
        // codex: accept model, no ceiling change.
        // then, once: degraded routing yes, secrets no.
        stdin: scriptedInput(["", "", "", "", "y", ""]),
        assumeYes: false,
        printConfig: false,
      });

      expect(code).toBe(0);
      const written = await readConfig(
        resolveConfigPath({ BRIGADIER_HOME: scratchHome }),
      );
      expect(written?.allowDegradedRouting).toBe(true);
      expect(written?.secretsConsent).toBe(false);

      const transcript = stdout.text();
      expect(transcript).toContain(DEGRADED_ROUTING_QUESTION);
      expect(DEGRADED_ROUTING_QUESTION).toBe(
        "If no model on this machine meets a slice's difficulty bar, run the slice on a weaker model instead of failing it?",
      );
      // Asked once even though two vendors were configured.
      expect(transcript.split(DEGRADED_ROUTING_QUESTION).length - 1).toBe(1);
      // Defaults to No, and says so in the hint.
      expect(transcript).toContain(`${DEGRADED_ROUTING_QUESTION} [y/N]`);
      // The prompt this replaced is gone, wording and model list alike.
      expect(transcript).not.toContain("quota drains");
      expect(transcript).not.toContain("fall back to");
      expect(transcript).not.toContain("fail the slice instead");
    });
  });

  test("defaults to no, so brigadier never silently substitutes", () => {
    const proposal = proposeConfig(CODEX_REPORT, null);
    expect(proposal.config.allowDegradedRouting).toBe(false);
    expect(
      withDegradedRouting(proposal.config, true).allowDegradedRouting,
    ).toBe(true);
    expect(
      withDegradedRouting(withDegradedRouting(proposal.config, true), false)
        .allowDegradedRouting,
    ).toBe(false);
    // It is a root setting: no vendor entry carries a trace of it.
    for (const vendor of withDegradedRouting(proposal.config, true).vendors) {
      expect(JSON.stringify(vendor)).not.toContain("egraded");
    }
  });

  test("is rendered in the summary the user confirms", async () => {
    await withScratchHome(async (scratchHome) => {
      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(CODEX_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        assumeYes: true,
        printConfig: false,
      });
      expect(code).toBe(0);
      expect(stdout.text()).toContain(
        "run below-difficulty models rather than fail: no",
      );
      expect(stdout.text()).not.toContain("quota fallback");
    });
  });
});

describe("effort ceilings", () => {
  test('a model reporting only "ultra" is excluded, never written as high', async () => {
    await withScratchHome(async (scratchHome) => {
      const ultraOnly: DiscoveryReport = {
        vendors: [
          {
            vendor: "codex",
            executable: "/opt/homebrew/bin/codex",
            version: "0.145.0",
            models: [
              SOL,
              {
                id: "gpt-5.6-ultraonly",
                displayName: "GPT-5.6 Ultra Only",
                supportedEfforts: ["ultra"],
                defaultEffort: "ultra",
                selectable: true,
              },
            ],
            catalogSource: "probe",
          },
        ],
        missing: ["claude"],
        warnings: [],
      };

      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(ultraOnly),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        assumeYes: true,
        printConfig: false,
      });
      expect(code).toBe(0);

      const written = await readConfig(
        resolveConfigPath({ BRIGADIER_HOME: scratchHome }),
      );
      // The defect this replaces: gpt-5.6-ultraonly was written with
      // effortCeiling "high", an effort that vendor does not accept, and was
      // then offerable as a default model — failing exactly when needed.
      expect(written?.vendors[0]?.models).toEqual([
        { id: "gpt-5.6-sol", effortCeiling: "high" },
      ]);
      expect(JSON.stringify(written)).not.toContain("gpt-5.6-ultraonly");

      // The exclusion is explained rather than silent.
      expect(stdout.text()).toContain(
        'note: codex: model "gpt-5.6-ultraonly" is not being offered because the vendor reports no effort level on brigadier\'s ladder (medium, high, xhigh).',
      );

      for (const vendor of written?.vendors ?? []) {
        for (const model of vendor.models) {
          expect(["medium", "high", "xhigh"]).toContain(model.effortCeiling);
        }
      }
    });
  });

  test('a model reporting exactly "xhigh" is excluded: xhigh is never predicted', async () => {
    await withScratchHome(async (scratchHome) => {
      const xhighOnly: DiscoveryReport = {
        vendors: [
          {
            vendor: "codex",
            executable: "/opt/homebrew/bin/codex",
            version: "0.145.0",
            models: [
              SOL,
              {
                id: "gpt-5.6-peak",
                displayName: "GPT-5.6 Peak",
                supportedEfforts: ["low", "xhigh", "max"],
                defaultEffort: "xhigh",
                selectable: true,
              },
            ],
            catalogSource: "probe",
          },
        ],
        missing: ["claude"],
        warnings: [],
      };

      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(xhighOnly),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        assumeYes: true,
        printConfig: false,
      });
      expect(code).toBe(0);

      const written = await readConfig(
        resolveConfigPath({ BRIGADIER_HOME: scratchHome }),
      );
      expect(written?.vendors[0]?.models).toEqual([
        { id: "gpt-5.6-sol", effortCeiling: "high" },
      ]);
      expect(written?.vendors[0]?.defaultModel).toBe("gpt-5.6-sol");
      expect(stdout.text()).toContain(
        'note: codex: model "gpt-5.6-peak" is not being offered because the vendor reports xhigh only, and xhigh is earned on retry after a failed gate — brigadier never predicts it.',
      );

      // It is not selectable as a default by any route either: `parseConfig`
      // only knows the models the proposal recorded.
      const proposal = proposeConfig(xhighOnly, null);
      expect(() =>
        withDefaultModel(proposal.config, "codex", "gpt-5.6-peak"),
      ).toThrow(
        'invalid brigadier config: codex: default model "gpt-5.6-peak" is not one of this vendor\'s available models',
      );
    });
  });

  test("a vendor whose every model is unusable is not configured at all", async () => {
    await withScratchHome(async (scratchHome) => {
      const stderr = collector();
      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer({
          vendors: [
            {
              vendor: "codex",
              executable: "/opt/homebrew/bin/codex",
              version: "0.145.0",
              models: [
                {
                  id: "gpt-5.6-peak",
                  displayName: "GPT-5.6 Peak",
                  supportedEfforts: ["xhigh"],
                  defaultEffort: "xhigh",
                  selectable: true,
                },
              ],
              catalogSource: "probe",
            },
          ],
          missing: ["claude"],
          warnings: [],
        }),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr,
        assumeYes: true,
        printConfig: false,
      });

      expect(code).toBe(1);
      expect(stdout.text()).toContain(
        "note: codex is installed but reported no model brigadier can drive; it is not being configured.",
      );
      expect(await readdir(scratchHome)).toEqual([]);
    });
  });

  test("only rungs the vendor reported are offered as ceiling choices", async () => {
    await withScratchHome(async (scratchHome) => {
      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer({
          vendors: [
            {
              vendor: "claude",
              executable: "/opt/homebrew/bin/claude",
              version: "2.0.14",
              // Narrows to exactly ["medium", "high"] — no xhigh anywhere.
              models: [SONNET],
              catalogSource: "static-table",
            },
          ],
          missing: ["codex"],
          warnings: [],
        }),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        // accept model, change ceilings, ceiling choice 1 (medium),
        // degraded routing no, secrets no
        stdin: scriptedInput(["", "y", "1", "", ""]),
        assumeYes: false,
        printConfig: false,
      });

      expect(code).toBe(0);
      const written = await readConfig(
        resolveConfigPath({ BRIGADIER_HOME: scratchHome }),
      );
      expect(written?.vendors[0]?.models).toEqual([
        { id: "claude-sonnet-4-6", effortCeiling: "medium" },
      ]);

      const transcript = stdout.text();
      expect(transcript).toContain("Effort ceiling for claude-sonnet-4-6:");
      expect(transcript).toContain("Choose 1-2 [2]");
      // The full ladder is never substituted for the vendor's own.
      expect(transcript).not.toContain("3) xhigh");
    });
  });

  test("offers a per-model ceiling override behind the documented warning", async () => {
    await withScratchHome(async (scratchHome) => {
      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(CODEX_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        // accept model, change ceilings, sol -> xhigh, terra -> medium,
        // degraded routing no, secrets no
        stdin: scriptedInput(["", "y", "3", "1", "", ""]),
        assumeYes: false,
        printConfig: false,
      });

      expect(code).toBe(0);
      const written = await readConfig(
        resolveConfigPath({ BRIGADIER_HOME: scratchHome }),
      );
      expect(written?.vendors[0]?.models).toEqual([
        { id: "gpt-5.6-sol", effortCeiling: "xhigh" },
        { id: "gpt-5.6-terra", effortCeiling: "medium" },
      ]);
      expect(written?.allowDegradedRouting).toBe(false);

      const transcript = stdout.text();
      expect(transcript).toContain(EFFORT_CEILING_WARNING);
      expect(transcript).toContain(
        "`xhigh` stays earned-on-retry regardless of this ceiling",
      );
      expect(transcript).toContain("Effort is never pinned per task tier.");
      // Ceilings are offered per model, never per task tier.
      expect(transcript).not.toContain("task tier:");
    });
  });
});

describe("prompt synchronization", () => {
  /**
   * The defect: `selectPrompt` returned its only choice without reading a line,
   * so every later prompt ate the answer meant for the prompt before it. The
   * scenario below has one single-option prompt in the middle of the run; each
   * later answer lands one question early unless that prompt consumes its line.
   *
   * The review's own reproduction used two models narrowing to ["xhigh"]. Under
   * the ruling for MAJOR 3 those models are no longer configurable at all, so
   * the single-option prompt is reproduced with a medium-only model — the other
   * way a vendor can report exactly one brigadier rung.
   */
  test("a single-option prompt still consumes its line", async () => {
    await withScratchHome(async (scratchHome) => {
      const mediumOnly: DiscoveryReport = {
        vendors: [
          {
            vendor: "codex",
            executable: "/opt/homebrew/bin/codex",
            version: "0.145.0",
            models: [
              // Narrows to exactly ["medium"]: one option, one keystroke.
              {
                id: "gpt-5.6-sol",
                displayName: "GPT-5.6 Sol",
                supportedEfforts: ["low", "medium", "max"],
                defaultEffort: "medium",
                selectable: true,
              },
              // Narrows to ["medium", "high"]: two options.
              {
                id: "gpt-5.6-terra",
                displayName: "GPT-5.6 Terra",
                supportedEfforts: ["low", "medium", "high"],
                defaultEffort: "medium",
                selectable: true,
              },
            ],
            catalogSource: "probe",
          },
        ],
        missing: ["claude"],
        warnings: [],
      };

      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(mediumOnly),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        // "" accept the default model
        // "y" yes, change the ceilings
        // "1" sol's ceiling: its only option, medium
        // "2" terra's ceiling: high
        // ""  degraded routing: no
        // ""  secrets: no
        stdin: scriptedInput(["", "y", "1", "2", "", ""]),
        assumeYes: false,
        printConfig: false,
      });

      expect(code).toBe(0);
      const written = await readConfig(
        resolveConfigPath({ BRIGADIER_HOME: scratchHome }),
      );

      // Before the fix: sol's prompt read nothing, terra's prompt ate the "1"
      // and recorded medium, and the "2" meant for terra landed on the next
      // prompt — answering a question nobody was asked.
      expect(written?.vendors[0]?.models).toEqual([
        { id: "gpt-5.6-sol", effortCeiling: "medium" },
        { id: "gpt-5.6-terra", effortCeiling: "high" },
      ]);
      expect(written?.allowDegradedRouting).toBe(false);
      expect(written?.secretsConsent).toBe(false);

      const transcript = stdout.text();
      expect(transcript).toContain("only option: medium");
    });
  });

  test("every prompt in the flow reads exactly one line", async () => {
    await withScratchHome(async (scratchHome) => {
      const singleModel: DiscoveryReport = {
        vendors: [
          {
            vendor: "codex",
            executable: "/opt/homebrew/bin/codex",
            version: "0.145.0",
            models: [
              {
                id: "gpt-5.6-sol",
                displayName: "GPT-5.6 Sol",
                supportedEfforts: ["medium"],
                defaultEffort: "medium",
                selectable: true,
              },
            ],
            catalogSource: "probe",
          },
        ],
        missing: ["claude"],
        warnings: [],
      };

      // Six prompts: default-model confirm ("n" forces the single-option model
      // prompt), the model prompt itself, the ceilings confirm, the single-
      // option ceiling prompt, the degraded-routing confirm, then secrets.
      //
      // The last two answers disagree on purpose. If any prompt failed to
      // consume its line, the degraded-routing "y" would land on secrets and
      // both booleans would come out wrong together — so asserting `true` then
      // `false` catches a one-line drift that two matching answers would hide.
      const code = await runInit({
        discoverer: fakeDiscoverer(singleModel),
        env: { BRIGADIER_HOME: scratchHome },
        stdout: collector(),
        stderr: collector(),
        stdin: scriptedInput(["n", "1", "y", "1", "y", "n"]),
        assumeYes: false,
        printConfig: false,
      });

      expect(code).toBe(0);
      const written = await readConfig(
        resolveConfigPath({ BRIGADIER_HOME: scratchHome }),
      );
      expect(written?.vendors[0]?.defaultModel).toBe("gpt-5.6-sol");
      expect(written?.vendors[0]?.models).toEqual([
        { id: "gpt-5.6-sol", effortCeiling: "medium" },
      ]);
      // The final "n" is the secrets answer, and it arrives at the secrets
      // prompt only if every prompt before it consumed exactly one line.
      expect(written?.allowDegradedRouting).toBe(true);
      expect(written?.secretsConsent).toBe(false);
    });
  });
});

describe("a discovery report the config schema rejects", () => {
  const DUPLICATE_SLUG_REPORT: DiscoveryReport = {
    vendors: [
      {
        vendor: "codex",
        executable: "/opt/homebrew/bin/codex",
        version: "0.145.0",
        models: [SOL, TERRA, SOL],
        catalogSource: "probe",
      },
    ],
    missing: ["claude"],
    warnings: [],
  };

  test("exits 1 with a diagnostic instead of throwing out of runInit", async () => {
    await withScratchHome(async (scratchHome) => {
      const stderr = collector();
      let code: number;
      try {
        code = await runInit({
          discoverer: fakeDiscoverer(DUPLICATE_SLUG_REPORT),
          env: { BRIGADIER_HOME: scratchHome },
          stdout: collector(),
          stderr,
          assumeYes: true,
          printConfig: false,
        });
      } catch (error) {
        throw new Error(
          `runInit threw instead of returning an exit code: ${String(error)}`,
        );
      }

      expect(code).toBe(1);
      expect(stderr.text()).toBe(
        'brigadier init: could not build a configuration from the discovery report: invalid brigadier config: codex: duplicate model "gpt-5.6-sol"\n',
      );
      expect(await readdir(scratchHome)).toEqual([]);
    });
  });

  test("exits 1 rather than throwing on the --print-config path too", async () => {
    await withScratchHome(async (scratchHome) => {
      const stderr = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(DUPLICATE_SLUG_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout: collector(),
        stderr,
        assumeYes: false,
        printConfig: true,
      });

      expect(code).toBe(1);
      expect(stderr.text()).toContain('codex: duplicate model "gpt-5.6-sol"');
    });
  });

  test("the CLI entry point turns an escaped rejection into a diagnostic", async () => {
    // `src/cli.ts` was a bare `void main()`, so anything that escaped an exit
    // code produced an unhandled rejection and a stack trace. The `.catch()`
    // there is the last resort, and this drives it for real.
    //
    // The rejection is genuine, not simulated: prompt input is read by
    // iterating `process.stdin`, that iteration is not inside any try, and a
    // stdin whose fd is a directory rejects on the first read. Every earlier
    // step is deliberately kept working — a fake `claude` on PATH answers
    // `--version`, so discovery succeeds and the flow really does reach the
    // first prompt. `--nope` cannot do this: `runCli` returns 2 for it and
    // never rejects, so it exercises none of the catch.
    await withScratchHome(async (scratchHome) => {
      const binDirectory = join(scratchHome, "bin");
      await mkdir(binDirectory);
      const fakeClaude = join(binDirectory, "claude");
      await writeFile(fakeClaude, '#!/bin/sh\necho "2.1.224 (Claude Code)"\n');
      await chmod(fakeClaude, 0o755);

      // A directory opened for reading: the open succeeds, the read does not.
      const directoryStdin = openSync(binDirectory, "r");
      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync(process.execPath, ["src/cli.ts", "init"], {
          cwd: repositoryRoot,
          encoding: "utf8",
          timeout: 20_000,
          stdio: [directoryStdin, "pipe", "pipe"],
          env: { PATH: binDirectory, BRIGADIER_HOME: scratchHome },
        });
      } finally {
        closeSync(directoryStdin);
      }

      // The diagnostic, not a stack trace, and exit 1 rather than a crash.
      expect(result.stderr).toStartWith("brigadier: ");
      expect(result.stderr).toContain("EISDIR");
      expect(result.stderr).not.toContain("at main");
      expect(result.stderr).not.toContain("Bun v");
      expect(result.status).toBe(1);
      // It really did get past discovery to a prompt, and wrote nothing.
      expect(result.stdout).toContain("as the default model for claude?");
      expect(await readdir(scratchHome)).toEqual(["bin"]);
    });
  }, 30_000);
});

describe("re-running init", () => {
  test("shows current values as the defaults and discards nothing", async () => {
    await withScratchHome(async (scratchHome) => {
      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      const prior: BrigadierConfig = {
        version: 2,
        vendors: [
          {
            vendor: "codex",
            executable: "/opt/homebrew/bin/codex",
            version: "0.145.0",
            defaultModel: "gpt-5.6-terra",
            models: [
              { id: "gpt-5.6-sol", effortCeiling: "xhigh" },
              { id: "gpt-5.6-terra", effortCeiling: "medium" },
            ],
          },
        ],
        secretsConsent: true,
        allowDegradedRouting: true,
      };
      await writeConfig(path, prior);

      const code = await runInit({
        discoverer: fakeDiscoverer(CODEX_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout: collector(),
        stderr: collector(),
        assumeYes: true,
        printConfig: false,
      });
      expect(code).toBe(0);
      expect(await readConfig(path)).toEqual(prior);

      // An interactive re-run offers those same values as its defaults.
      const stdout = collector();
      const interactive = await runInit({
        discoverer: fakeDiscoverer(CODEX_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        stdin: scriptedInput([]),
        assumeYes: false,
        printConfig: false,
      });
      expect(interactive).toBe(0);
      expect(stdout.text()).toContain(
        "Use gpt-5.6-terra as the default model for codex? [Y/n]",
      );
      expect(stdout.text()).toContain(
        "Allow brigadier to link secret files (for example .env) into worker worktrees? [Y/n]",
      );
      // A prior `true` becomes the default, so pressing enter keeps it. The
      // hint is `[Y/n]` rather than the fresh-config `[y/N]`, which is the only
      // visible difference between "the user said yes last time" and "brigadier
      // decided for them".
      expect(stdout.text()).toContain(`${DEGRADED_ROUTING_QUESTION} [Y/n]`);
      expect(await readConfig(path)).toEqual(prior);
    });
  });

  test("reports, rather than silently applies, a prior choice the machine no longer has", async () => {
    await withScratchHome(async (scratchHome) => {
      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      await writeConfig(path, {
        version: 2,
        vendors: [
          {
            vendor: "codex",
            executable: "/opt/homebrew/bin/codex",
            version: "0.144.0",
            defaultModel: "gpt-5.6-gone",
            models: [{ id: "gpt-5.6-gone", effortCeiling: "medium" }],
          },
        ],
        secretsConsent: false,
        allowDegradedRouting: true,
      });

      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(CODEX_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        assumeYes: true,
        printConfig: false,
      });

      expect(code).toBe(0);
      expect(stdout.text()).toContain(
        'note: codex: previous default model "gpt-5.6-gone" is no longer installed; proposing "gpt-5.6-sol"',
      );
      const written = await readConfig(path);
      expect(written?.vendors[0]?.defaultModel).toBe("gpt-5.6-sol");
      expect(written?.vendors[0]?.version).toBe("0.145.0");
      // Resetting a model choice is not a reason to revoke a consent that has
      // nothing to do with any model.
      expect(written?.allowDegradedRouting).toBe(true);
    });
  });

  test("does not call a prior default uninstalled when it is installed but undrivable", async () => {
    await withScratchHome(async (scratchHome) => {
      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      await writeConfig(path, {
        version: 2,
        vendors: [
          {
            vendor: "claude",
            executable: "/opt/homebrew/bin/claude",
            version: "2.0.13",
            defaultModel: "claude-opus-4-6",
            models: [{ id: "claude-opus-4-6", effortCeiling: "xhigh" }],
          },
        ],
        secretsConsent: false,
        allowDegradedRouting: false,
      });

      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(XHIGH_ONLY_OPUS_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        assumeYes: true,
        printConfig: false,
      });
      expect(code).toBe(0);

      // The model is present — the note above says so in as many words — so
      // the reset must not blame an absent install two lines below it.
      expect(stdout.text()).toContain(
        'note: claude: model "claude-opus-4-6" is not being offered because the vendor reports xhigh only, and xhigh is earned on retry after a failed gate — brigadier never predicts it.',
      );
      expect(stdout.text()).toContain(
        'note: claude: previous default model "claude-opus-4-6" is installed but brigadier cannot drive it (the vendor reports xhigh only, and xhigh is earned on retry after a failed gate — brigadier never predicts it); proposing "claude-sonnet-4-6"',
      );
      expect(stdout.text()).not.toContain("is no longer installed");

      const written = await readConfig(path);
      expect(written?.vendors[0]?.defaultModel).toBe("claude-sonnet-4-6");
    });
  });

  test("does not call a prior vendor missing when it is installed but undrivable", async () => {
    await withScratchHome(async (scratchHome) => {
      const path = resolveConfigPath({ BRIGADIER_HOME: scratchHome });
      await writeConfig(path, {
        version: 2,
        vendors: [
          {
            vendor: "codex",
            executable: "/opt/homebrew/bin/codex",
            version: "0.144.0",
            defaultModel: "gpt-5.6-sol",
            models: [{ id: "gpt-5.6-sol", effortCeiling: "xhigh" }],
          },
        ],
        secretsConsent: false,
        allowDegradedRouting: false,
      });

      const stdout = collector();
      const code = await runInit({
        discoverer: fakeDiscoverer(XHIGH_ONLY_CODEX_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout,
        stderr: collector(),
        assumeYes: true,
        printConfig: false,
      });
      expect(code).toBe(0);

      // The header prints codex's version and path; a note claiming it was not
      // found would contradict the line directly above it.
      expect(stdout.text()).toContain(
        "codex  v0.145.0  /opt/homebrew/bin/codex",
      );
      expect(stdout.text()).toContain(
        "note: codex is installed but reported no model brigadier can drive; it is not being configured.",
      );
      expect(stdout.text()).toContain(
        "note: codex is in your existing config but reported no model brigadier can drive on this machine; its settings are not being carried forward.",
      );
      expect(stdout.text()).not.toContain("was not found on this machine");

      const written = await readConfig(path);
      expect(written?.vendors.map((entry) => entry.vendor)).toEqual(["claude"]);
    });
  });
});

describe("proposal", () => {
  test("ranks by competence and offers only what the probe returned", () => {
    const proposal = proposeConfig(BOTH_VENDORS_REPORT, null);
    expect(proposal.vendors.map((vendor) => vendor.vendor)).toEqual([
      "claude",
      "codex",
    ]);
    expect(proposal.config.vendors[0]?.defaultModel).toBe("claude-opus-4-6");
    expect(proposal.config.vendors[1]?.defaultModel).toBe("gpt-5.6-sol");
    expect(proposal.config.vendors[0]?.models.map((model) => model.id)).toEqual(
      ["claude-opus-4-6", "claude-sonnet-4-6"],
    );
    expect(proposal.vendors[0]?.defaultModelRationale).toBe(
      "deepest Anthropic reasoning tier: architecture and ambiguous specs",
    );
  });

  test("offers a model brigadier has never heard of, ranked last, never dropped", () => {
    const unknownModel: DiscoveredModel = {
      id: "gpt-6.0-nova",
      displayName: "GPT-6.0 Nova",
      supportedEfforts: ["medium", "high"],
      defaultEffort: "high",
      selectable: true,
    };
    const proposal = proposeConfig(
      {
        vendors: [
          {
            vendor: "codex",
            executable: "/opt/homebrew/bin/codex",
            version: "0.145.0",
            models: [unknownModel, TERRA],
            catalogSource: "probe",
          },
        ],
        missing: [],
        warnings: [],
      },
      null,
    );

    expect(proposal.config.vendors[0]?.models.map((model) => model.id)).toEqual(
      ["gpt-5.6-terra", "gpt-6.0-nova"],
    );
    expect(proposal.vendors[0]?.ranked[1]?.rationale).toContain(
      "not in brigadier's competence table",
    );
  });

  test("never records a vendor-to-task-type mapping", () => {
    const proposal = proposeConfig(BOTH_VENDORS_REPORT, null);
    const serialized = JSON.stringify(proposal.config);
    for (const forbidden of ["taskType", "tier", "route", "prefer"]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const vendor of proposal.config.vendors) {
      expect(Object.keys(vendor).sort()).toEqual([
        "defaultModel",
        "executable",
        "models",
        "vendor",
        "version",
      ]);
    }
  });
});

describe("command line", () => {
  test("--version still works from the built entry point", () => {
    const result = spawnSync("bun", ["src/cli.ts", "--version"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  }, 30_000);

  test("an unknown command exits 2 with usage", () => {
    const result = spawnSync("bun", ["src/cli.ts", "frobnicate"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('brigadier: unknown command "frobnicate"');
    expect(result.stderr).toContain("Usage: brigadier <command> [options]");
  }, 30_000);

  test("init --help and init -h print usage and exit 0", async () => {
    for (const flag of ["--help", "-h"]) {
      const stdout = collector();
      const stderr = collector();
      // No discoverer is injected: help must not reach discovery at all, and
      // would fail loading one in this environment if it tried.
      const code = await runCli({
        argv: ["init", flag],
        version: "0.0.0",
        env: {},
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      expect(stderr.text()).toBe("");
      expect(stdout.text()).toContain("Usage: brigadier <command> [options]");
      expect(stdout.text()).toContain("--print-config");
    }
  });

  test("--help is honored in the bare position too", async () => {
    for (const flag of ["--help", "-h"]) {
      const stdout = collector();
      const code = await runCli({
        argv: [flag],
        version: "0.0.0",
        env: {},
        stdout,
        stderr: collector(),
      });
      expect(code).toBe(0);
      expect(stdout.text()).toContain("Usage: brigadier <command> [options]");
    }
  });

  test("an unknown init option exits 2 without touching discovery", () => {
    const result = spawnSync("bun", ["src/cli.ts", "init", "--nope"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('brigadier init: unknown option "--nope"');
  }, 30_000);

  test("dispatches init --yes and init --print-config with an injected discoverer", async () => {
    await withScratchHome(async (scratchHome) => {
      const printed = collector();
      expect(
        await runCli({
          argv: ["init", "--print-config"],
          version: "0.0.0",
          env: { BRIGADIER_HOME: scratchHome },
          stdout: printed,
          stderr: collector(),
          discoverer: fakeDiscoverer(BOTH_VENDORS_REPORT),
        }),
      ).toBe(0);
      expect(JSON.parse(printed.text())).toEqual(BOTH_VENDORS_CONFIG);

      const version = collector();
      expect(
        await runCli({
          argv: ["--version"],
          version: "9.9.9",
          env: { BRIGADIER_HOME: scratchHome },
          stdout: version,
          stderr: collector(),
        }),
      ).toBe(0);
      expect(version.text()).toBe("9.9.9\n");

      expect(
        await runCli({
          argv: ["init", "-y"],
          version: "0.0.0",
          env: { BRIGADIER_HOME: scratchHome },
          stdout: collector(),
          stderr: collector(),
          discoverer: fakeDiscoverer(BOTH_VENDORS_REPORT),
        }),
      ).toBe(0);
      expect(
        await readConfig(resolveConfigPath({ BRIGADIER_HOME: scratchHome })),
      ).toEqual(BOTH_VENDORS_CONFIG);
    });
  });

  test("a closed stdin answers every prompt with its default instead of hanging", async () => {
    await withScratchHome(async (scratchHome) => {
      const code = await runInit({
        discoverer: fakeDiscoverer(BOTH_VENDORS_REPORT),
        env: { BRIGADIER_HOME: scratchHome },
        stdout: collector(),
        stderr: collector(),
        stdin: scriptedInput([]),
        assumeYes: false,
        printConfig: false,
      });
      expect(code).toBe(0);
      expect(
        await readConfig(resolveConfigPath({ BRIGADIER_HOME: scratchHome })),
      ).toEqual(BOTH_VENDORS_CONFIG);
    });
  });
});

function fakeDiscoverer(report: DiscoveryReport): Discoverer {
  return {
    discover(): Promise<DiscoveryReport> {
      return Promise.resolve(report);
    },
  };
}

function scriptedInput(lines: readonly string[]): InputStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        yield `${line}\n`;
      }
    },
  };
}

function collector(): OutputStream & { text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

async function withScratchHome(
  body: (scratchHome: string) => Promise<void>,
): Promise<void> {
  const scratchHome = await mkdtemp(join(tmpdir(), "brigadier-init-"));
  try {
    await body(scratchHome);
  } finally {
    await rm(scratchHome, { recursive: true, force: true });
  }
}
