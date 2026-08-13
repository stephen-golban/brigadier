/**
 * The host surfaces: the templates, the installer, and the handoff hook.
 *
 * THE CENTRAL RISK THIS FILE EXISTS TO CLOSE is that `surfaces/` and
 * `src/surfaces/templates.ts` become two different products. The directory is
 * what a reviewer reads; the constant is what a user's compiled binary actually
 * writes. Nothing in the type system connects them, a `bun build` will happily
 * ship a stale copy, and the failure is silent — the user gets doctrine nobody
 * reviewed. So every file is pinned by an absolute SHA-256 and an absolute byte
 * count, on BOTH sides, and the key sets are compared in both directions.
 *
 * The second risk is the installer losing somebody's edit. `brigadier install`
 * has to be idempotent AND has to never silently overwrite, and the tests below
 * walk all four cases that distinguishes: absent, identical, brigadier's own but
 * outdated, and edited by a human.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTools } from "../src/mcp/tools.ts";
import type { InstallIo, SurfaceIo } from "../src/surfaces/install.ts";
import { nodeSurfaceIo, runInstall, sha256 } from "../src/surfaces/install.ts";
import { SURFACE_TEMPLATES } from "../src/surfaces/templates.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const surfacesRoot = join(repositoryRoot, "surfaces");
const MAX_HOOK_STDOUT_BYTES = 64_000;

/**
 * Every installable template, pinned by content.
 *
 * These are absolute values on purpose: a test that compared the directory to
 * the constant and nothing else would pass just as happily if BOTH were wrong in
 * the same way — which is exactly what happens when a regeneration script is run
 * against an already-corrupted source.
 */
const PINNED: Readonly<Record<string, { sha256: string; bytes: number }>> = {
  "claude-code/.claude-plugin/plugin.json": {
    sha256: "e59ce92b34036515de8926b6cd6ee7e8a53570db9eda6e87285d0daefb8e2076",
    bytes: 152,
  },
  "claude-code/SKILL.md": {
    sha256: "0cb9faa8a75183bb70b6b08e08a819375affcc96558cd56937cc984b08a3da55",
    bytes: 5396,
  },
  "claude-code/hooks/README.md": {
    sha256: "45a6b3f3cf3e3da1be8e3d654ac15d4867c5c01c9df70bea4421996764f6d92f",
    bytes: 5352,
  },
  "claude-code/hooks/handoff.mjs": {
    sha256: "2726afa2525d3e609c6e0a390adcf336dcfd24e41a5eb34d5b61e03383ac10ff",
    bytes: 5445,
  },
  "claude-code/hooks/hooks.json": {
    sha256: "491a1bf6c9f84cfd94f2fbd8c0d58dc9e8f18015d4e78e0e82d1c81c07f3a655",
    bytes: 432,
  },
  "claude-code/hooks/nudge.mjs": {
    sha256: "13b2eb97a3f65ad2053262ec444098b4f5bc65aa1fdd1daf89aafe9e8f02de7d",
    bytes: 12147,
  },
  "claude-desktop/README.md": {
    sha256: "bb5a0937ed1fe91eba5b9e62389c99b538afef5e21a03cc9b67fcf3b0a79e4a3",
    bytes: 3722,
  },
  "claude-desktop/manifest.json": {
    sha256: "151d858963600f7c2cae06df761703c8bf7a3de5fab11350df1f1986497e91e9",
    bytes: 2536,
  },
  "codex/AGENTS.md": {
    sha256: "5e7e861ee00bee3015160c018e6da36f466038f8e40058ba99f22cfad3dd917a",
    bytes: 4490,
  },
  "codex/hooks/README.md": {
    sha256: "c30e3f94b875af45a988e063d692b7bb2ef17d45bd9ed75b32d0867eb1c4bb1a",
    bytes: 3597,
  },
  "codex/hooks/handoff.mjs": {
    sha256: "2726afa2525d3e609c6e0a390adcf336dcfd24e41a5eb34d5b61e03383ac10ff",
    bytes: 5445,
  },
  "codex/skills/brigadier/SKILL.md": {
    sha256: "0cb9faa8a75183bb70b6b08e08a819375affcc96558cd56937cc984b08a3da55",
    bytes: 5396,
  },
  "opencode/README.md": {
    sha256: "53feacbb72b7f667b7e280d815058e2753bf72f48e6f849fce54aa2604f1ed92",
    bytes: 2185,
  },
  "opencode/plugin/brigadier.js": {
    sha256: "574297c2697dd65f246bcc739309168e24c9224c5420cc1f17b6b8ae067b00d1",
    bytes: 2974,
  },
};

/** Every file under `surfaces/`, relative to it, sorted. */
function walkSurfaces(directory: string, prefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    const key = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      found.push(...walkSurfaces(full, key));
    } else {
      found.push(key);
    }
  }
  return found;
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** One prose paragraph, including wrapped lines, selected by an exact fragment. */
function paragraphContaining(text: string, fragment: string): string {
  return (
    text.split("\n\n").find((paragraph) => paragraph.includes(fragment)) ?? ""
  );
}

/** Exact text from one named line up to, but not including, another. */
function textBetween(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  return startIndex < 0 || endIndex < 0 ? "" : text.slice(startIndex, endIndex);
}

/**
 * True when `text` holds a control byte other than newline and tab.
 *
 * Hand-rolled rather than shelled out to `grep -P`, which on macOS BSD grep
 * FAILS OPEN: it reports every file clean and a sweep built on it proves
 * nothing. The canary test below proves this one can actually fail.
 */
function hasControlByte(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\t") {
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

interface Collected {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

async function install(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  fs?: SurfaceIo,
): Promise<Collected> {
  let stdout = "";
  let stderr = "";
  const io: InstallIo = {
    env,
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
      },
    },
    ...(fs === undefined ? {} : { fs }),
  };
  const code = await runInstall(argv, io);
  return { stdout, stderr, code };
}

interface BoundedInstall extends Collected {
  readonly elapsedMs: number;
}

async function installWithin(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  fs?: SurfaceIo,
): Promise<BoundedInstall> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      install(argv, env, fs),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("install exceeded 5,000 ms")),
          5_000,
        );
      }),
    ]);
    return { ...result, elapsedMs: Date.now() - started };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function outcomeDetail(stdout: string, path: string): string {
  const lines = stdout.split("\n");
  const index = lines.indexOf(`  refused    ${path}`);
  return index < 0 ? "" : (lines[index + 1]?.trim() ?? "");
}

async function recordOwnedBytes(
  home: string,
  target: string,
  contents: string,
): Promise<void> {
  const manifestPath = join(home, ".brigadier/surfaces.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: number;
    files: Record<string, string>;
  };
  manifest.files[target] = sha256(contents);
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function fileDigest(path: string): Promise<{
  readonly bytes: number;
  readonly sha256: string;
}> {
  const bytes = await readFile(path);
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Only the per-file verdict lines, which is what the assertions are about. */
function verdictLines(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .filter((line) =>
      /^ {2}(created|updated|unchanged|skipped|refused|failed) /.test(line),
    );
}

/** A complete, valid config whose only interesting field is the consent. */
function configBytes(guiRegistrationConsent: boolean): string {
  return `${JSON.stringify(
    {
      version: 3,
      vendors: [
        {
          vendor: "codex",
          executable: "/opt/homebrew/bin/codex",
          version: "0.145.0",
          defaultModel: "gpt-5.6-sol",
          models: [{ id: "gpt-5.6-sol", effortCeiling: "high" }],
        },
      ],
      secretsConsent: false,
      linkedSecretPaths: [],
      guiRegistrationConsent,
      allowDegradedRouting: false,
    },
    null,
    2,
  )}\n`;
}

/** The four host configuration directories, as if all four were installed. */
const GUI_HOST_DIRECTORIES = [
  ".cursor",
  ".codeium/windsurf",
  ".gemini/config",
  "Library/Application Support/Claude",
] as const;

async function makeGuiHostsPresent(home: string): Promise<void> {
  for (const directory of GUI_HOST_DIRECTORIES) {
    await mkdir(join(home, directory), { recursive: true });
  }
}

function guiRegistrationPaths(home: string): readonly string[] {
  return [
    join(home, ".cursor/mcp.json"),
    join(home, ".codeium/windsurf/mcp_config.json"),
    join(home, ".gemini/config/mcp_config.json"),
    join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
  ];
}

describe("the surface templates", () => {
  test("the compiled templates are exactly these fourteen files", () => {
    expect(Object.keys(SURFACE_TEMPLATES).sort()).toEqual([
      "claude-code/.claude-plugin/plugin.json",
      "claude-code/SKILL.md",
      "claude-code/hooks/README.md",
      "claude-code/hooks/handoff.mjs",
      "claude-code/hooks/hooks.json",
      "claude-code/hooks/nudge.mjs",
      "claude-desktop/README.md",
      "claude-desktop/manifest.json",
      "codex/AGENTS.md",
      "codex/hooks/README.md",
      "codex/hooks/handoff.mjs",
      "codex/skills/brigadier/SKILL.md",
      "opencode/README.md",
      "opencode/plugin/brigadier.js",
    ]);
  });

  test("every compiled template matches its pinned hash and size", () => {
    for (const [key, pin] of Object.entries(PINNED)) {
      const contents = SURFACE_TEMPLATES[key];
      expect(typeof contents).toBe("string");
      expect(Buffer.byteLength(contents ?? "", "utf8")).toBe(pin.bytes);
      expect(hashOf(contents ?? "")).toBe(pin.sha256);
    }
  });

  test("every file on disk matches the same pinned hash and size", () => {
    const onDisk = walkSurfaces(surfacesRoot, "").filter(
      (key) => key !== "README.md",
    );
    expect(onDisk.sort()).toEqual(Object.keys(PINNED).sort());
    for (const key of onDisk) {
      const contents = readFileSync(join(surfacesRoot, key), "utf8");
      const pin = PINNED[key];
      if (pin === undefined) {
        throw new Error(`surfaces/${key} is on disk with no pinned hash`);
      }
      expect(Buffer.byteLength(contents, "utf8")).toBe(pin.bytes);
      expect(hashOf(contents)).toBe(pin.sha256);
    }
  });

  test("no surface asset is silently excluded from the commit", () => {
    // A REAL DEFECT THIS CAUGHT. `.gitignore` opened with a bare `brigadier`,
    // meant for the compiled executable at the repository root. A bare pattern
    // matches any path component of that name at ANY depth, so it also ignored
    // `surfaces/codex/skills/brigadier/` — an asset that existed on disk, passed
    // every hash assertion above, was compiled into `templates.ts`, and would
    // simply not have been in the commit. Every test in this file was green
    // while the deliverable was invisible to git.
    const files = walkSurfaces(surfacesRoot, "");
    expect(files.length).toBe(15);
    for (const key of files) {
      const result = spawnSync("git", ["check-ignore", "-q", key], {
        cwd: surfacesRoot,
        encoding: "utf8",
        timeout: 20_000,
      });
      // `git check-ignore -q` exits 1 for a path that is NOT ignored, which is
      // the only acceptable answer here. The key is folded into the assertion so
      // a failure names the file rather than reporting "expected 1, got 0".
      expect(`${key} ignored=${result.status}`).toBe(`${key} ignored=1`);
    }
  });

  test("surfaces/README.md documents the directory and is never installed", () => {
    expect(walkSurfaces(surfacesRoot, "")).toContain("README.md");
    expect(SURFACE_TEMPLATES["README.md"]).toBeUndefined();
  });

  test("the doctrine and the hook are one text each, not two that drifted", () => {
    // ONE DOCTRINE. Claude Code's skill and Codex's skill are the same bytes, so
    // a wording fix cannot land on one host and miss the other.
    expect(SURFACE_TEMPLATES["codex/skills/brigadier/SKILL.md"]).toBe(
      SURFACE_TEMPLATES["claude-code/SKILL.md"] ?? "",
    );
    // ONE HOOK. Same contract, same bytes, on both hosts that can run it.
    expect(SURFACE_TEMPLATES["codex/hooks/handoff.mjs"]).toBe(
      SURFACE_TEMPLATES["claude-code/hooks/handoff.mjs"] ?? "",
    );
  });

  test("every installed doctrine states the current dependency and command contracts", () => {
    const claude = SURFACE_TEMPLATES["claude-code/SKILL.md"] ?? "";
    const codexSkill =
      SURFACE_TEMPLATES["codex/skills/brigadier/SKILL.md"] ?? "";
    const codexAgents = SURFACE_TEMPLATES["codex/AGENTS.md"] ?? "";

    for (const doctrine of [claude, codexSkill]) {
      expect(textBetween(doctrine, "1. **Decompose.**", "\n2. **Write")).toBe(
        "1. **Decompose.** Disjoint `ownedPaths` are necessary, but they do not by\n   themselves make slices independent. If one slice needs another's committed\n   output, declare that real dependency in `dependsOn`. Dependencies place work\n   in later serial waves; independent slices share a wave and can run\n   concurrently, up to `--max-workers`. Partition by file ownership, not by\n   topic.",
      );
      expect(
        textBetween(
          doctrine,
          "   `id`, `title`, `prompt`, `ownedPaths`",
          "\n3. **Dry-run",
        ),
      ).toBe(
        "   `id`, `title`, `prompt`, `ownedPaths` and `difficulty` are required on every\n   slice. `difficulty` is one of `routine`, `standard`, `hard`, and it has no\n   default: a plan that does not say how hard a slice is has not been planned.\n   `dependsOn` is optional and names prerequisite slice ids. brigadier runs\n   dependency waves in order and reconciles each non-final wave before creating\n   the next wave's worktrees, so dependent slices start from their prerequisites'\n   committed output. Unknown ids, self-dependencies, and cycles are refused.\n   `requires` is optional and takes `imageInput`, `webSearch`,\n   `structuredOutput`, `commandExecution`, and `minContextWindowTokens`.",
      );
      expect(
        textBetween(
          doctrine,
          "- Do not invent commands.",
          "\n\n## There is no setup step",
        ),
      ).toBe(
        '- Do not invent commands. brigadier has exactly four: `run`, `install`, `mcp`,\n  and `init`. `brigadier run "<task description>"` asks a model to decompose the\n  task, then sends the result through the same validator used for `--plan`. On\n  genuine ambiguity it exits 4 with `status: "needs_human"` and structured\n  questions; no worktree is created and no slice worker is spawned.',
      );
      expect(
        paragraphContaining(doctrine, "`1` setup or planning failed"),
      ).toBe(
        "`0` succeeded · `1` setup or planning failed, or the runner threw before returning\na report · `2` usage error · `3` a run report says the run failed, including\nschedulability or routing failures that created no worktree · `4` the planner needs\nhuman input (questions were printed; no slice worker, ref, or worktree was created)\n· `130`/`143` interrupted.\n",
      );
    }

    expect(
      textBetween(
        codexAgents,
        "1. **Decompose by file ownership.**",
        "\n2. **Write",
      ),
    ).toBe(
      "1. **Decompose by file ownership.** Disjoint `ownedPaths` are necessary, but do\n   not by themselves make slices independent. If one slice needs another's\n   committed output, declare that real dependency in `dependsOn`. Dependencies\n   place work in later serial waves; independent slices share a wave and can run\n   concurrently, up to `--max-workers`.",
    );
    expect(
      textBetween(
        codexAgents,
        "2. **Write a plan document**",
        "\n\n   ```json",
      ),
    ).toBe(
      "2. **Write a plan document** (JSON). Every slice needs `id`, `title`, `prompt`,\n   `ownedPaths`, and `difficulty` (`routine`, `standard`, or `hard` — there is no\n   default). `requires` is optional. `dependsOn` names prerequisite slice ids.\n   brigadier reconciles each non-final dependency wave before creating the next\n   wave's worktrees, so dependent slices start from their prerequisites' committed\n   output. Unknown ids, self-dependencies, and cycles are refused.",
    );
    expect(
      textBetween(
        codexAgents,
        "- Invent commands.",
        "\n\nThere is no setup step.",
      ),
    ).toBe(
      '- Invent commands. brigadier has exactly four: `run`, `install`, `mcp`, and\n  `init`. `brigadier run "<task description>"` asks a model to decompose the task\n  and sends the result through the same validator used for `--plan`. On genuine\n  ambiguity it exits 4 with `status: "needs_human"` and structured questions; no\n  worktree is created and no slice worker is spawned.',
    );
  });

  test("every installed doctrine bans a worker from re-entering brigadier", () => {
    // THE GUARD THAT DECIDES. `workerEnvironment` stamps BRIGADIER_WORKER=1 into
    // every worker's environment, which keeps the nudge hook quiet inside a
    // worker, but nothing in the product refuses a second run — so a worker that
    // decides to orchestrate still spends its whole slice and lands nothing. It
    // has happened once already. These paragraphs are the rest of the defence,
    // which is why they are pinned rather than merely written, and why they must
    // describe the marker honestly rather than claim there is nothing at all.
    for (const doctrine of [
      SURFACE_TEMPLATES["claude-code/SKILL.md"] ?? "",
      SURFACE_TEMPLATES["codex/skills/brigadier/SKILL.md"] ?? "",
      SURFACE_TEMPLATES["codex/AGENTS.md"] ?? "",
    ]) {
      expect(doctrine).toContain(
        "## If you are already a brigadier worker, stop here",
      );
      expect(
        paragraphContaining(doctrine, "must never invoke brigadier"),
      ).toContain(
        "**A brigadier worker must never invoke brigadier.** If the prompt you were given\nis one slice of somebody else's plan — it names an `id`, the paths you own, and\nthe evidence you owe — then you are the worker, and the work in front of you is\nthe work you do. Spawning a second orchestrator from inside a slice spends the\nwhole slice and lands nothing. This has happened. brigadier stamps\n`BRIGADIER_WORKER=1` into every worker's environment, which is enough to keep the\nnudge hook quiet inside a worker but does not stop you: nothing in the product\nrefuses a second run, so this paragraph is what prevents it.",
      );
    }
  });

  test("every installed doctrine says configuration is automatic", () => {
    // `brigadier init` stopped being a prerequisite when `ensureConfig` landed.
    // A doctrine that still sends the host model to an init step sends it to a
    // step that does nothing it needs.
    //
    // THE ONE CARVE-OUT IS PINNED TOO. `consentInstructions` in
    // `src/surfaces/install.ts` — the only remedy offered when a GUI
    // registration is skipped for want of consent — tells the reader to run
    // interactive `brigadier init`. A doctrine that forbade that outright would
    // forbid the single step consent recovery requires, so the exception is
    // stated here rather than left to collide.
    const skill = SURFACE_TEMPLATES["claude-code/SKILL.md"] ?? "";
    expect(paragraphContaining(skill, "Configuration is automatic")).toBe(
      "Configuration is automatic. `brigadier run` probes this machine for installed\nworker CLIs, writes `$BRIGADIER_HOME/config.json` — `~/.brigadier/config.json` by\ndefault — when none is there, and carries on. Never run `brigadier init` to make\na config appear: it has never been a prerequisite for a run, and a turn spent on\nit is a turn wasted. The one exception is not yours to take. Registering\nbrigadier's MCP server into a GUI application's own configuration takes a human's\nexplicit yes, and only the interactive question can ask for it — so if\n`brigadier install` reports a registration skipped for want of consent, pass that\nsentence to the user and let them run `brigadier init` once themselves.",
    );
    expect(
      paragraphContaining(
        SURFACE_TEMPLATES["codex/AGENTS.md"] ?? "",
        "There is no setup step",
      ),
    ).toBe(
      "There is no setup step. Configuration is automatic: `brigadier run` probes this\nmachine, writes `$BRIGADIER_HOME/config.json` (default `~/.brigadier/config.json`)\nwhen none is there, and carries on. Never run `brigadier init` to make a config\nappear; it is not a prerequisite. Its one real job belongs to a human: recording\nthe explicit yes that lets brigadier register its MCP server into a GUI\napplication's own configuration. If `brigadier install` reports a registration\nskipped for want of consent, pass that sentence to the user and let them run\n`brigadier init` once themselves.",
    );
    for (const doctrine of [
      skill,
      SURFACE_TEMPLATES["codex/skills/brigadier/SKILL.md"] ?? "",
      SURFACE_TEMPLATES["codex/AGENTS.md"] ?? "",
    ]) {
      expect(doctrine).not.toContain("must have been run once on this machine");
      expect(doctrine).not.toContain("exits 1 and tells you to run `init`");
    }
  });

  test("the Claude Code registration carries both hooks and no matcher on the nudge", () => {
    // UserPromptSubmit takes no matcher on this host. A matcher there is not a
    // harmless extra key; it is a registration the host may reject outright.
    const hooks = JSON.parse(
      SURFACE_TEMPLATES["claude-code/hooks/hooks.json"] ?? "",
    ) as {
      hooks: Record<
        string,
        readonly {
          matcher?: string;
          hooks: readonly Record<string, string>[];
        }[]
      >;
    };
    expect(Object.keys(hooks.hooks)).toEqual([
      "PreCompact",
      "UserPromptSubmit",
    ]);
    expect(hooks.hooks.PreCompact?.[0]?.matcher).toBe("*");
    expect(hooks.hooks.UserPromptSubmit?.[0]?.matcher).toBeUndefined();
    expect(hooks.hooks.UserPromptSubmit?.[0]?.hooks).toEqual([
      {
        type: "command",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands this, not JavaScript. It is a literal byte of the registration.
        command: "${CLAUDE_PLUGIN_ROOT}/hooks/nudge.mjs",
      },
    ]);
  });

  test("the Codex registration deliberately stays a single event", () => {
    // LANDMINE, STATED IN THE ARTIFACT. Codex binds hook approval to the
    // registration — event, matcher, and command together — so registering the
    // nudge there would disarm the already-approved handoff until the user
    // approved again. The nudge is not worth that, and the README says so.
    const codex = SURFACE_TEMPLATES["codex/hooks/README.md"] ?? "";
    expect(codex).not.toContain("nudge.mjs");
    expect(paragraphContaining(codex, "only event brigadier registers")).toBe(
      "`PreCompact` is the only event brigadier registers here, and that is deliberate.\nClaude Code also gets a `UserPromptSubmit` nudge; Codex does not, because Codex\nbinds approval to the registration — event, matcher, and command together — so\nadding a second event would disarm the already-approved handoff until the user\napproved the new registration. A nudge is not worth silently switching off the\nhandoff.",
    );
  });

  test("the published methodology states the consented unranked-model policy", () => {
    const methodology = readFileSync(
      join(repositoryRoot, "docs/METHODOLOGY.md"),
      "utf8",
    );
    expect(paragraphContaining(methodology, "not proven to clear it")).toBe(
      "An unranked model is not proven weaker than a difficulty floor, but it is\nnot proven to clear it either. It is therefore excluded from ordinary eligibility\nand enters the same consented salvage pool as a ranked model below the floor\n([`src/routing/router.ts:714`](../src/routing/router.ts#L714) and\n[`src/routing/router.ts:735`](../src/routing/router.ts#L735)). Without\n`allowDegradedRouting`, an unranked model cannot take the slice.",
    );
    expect(paragraphContaining(methodology, "contains both kinds")).toBe(
      "With consent, the salvage pool contains both kinds of model that brigadier\ncould not prove meet the requested floor:",
    );
    expect(
      paragraphContaining(methodology, "does not claim an unranked model"),
    ).toBe(
      "Every successful salvage route records `waivedDifficultyFloor: true`. For a\nranked winner this records a known below-floor score. For an unranked winner it\ndoes not claim an unranked model has a sub-floor score; it records that brigadier\ndid not establish the requested floor. Ranked candidates precede all unranked\ncandidates, ranked candidates are ordered by descending score, and ties or\nunranked-only choices preserve configuration order\n([`src/routing/router.ts:343`](../src/routing/router.ts#L343) and\n[`src/routing/router.ts:657`](../src/routing/router.ts#L657)).",
    );
  });

  test("the surface index distinguishes its review-only README from installed bytes", () => {
    const index = readFileSync(join(surfacesRoot, "README.md"), "utf8");
    expect(paragraphContaining(index, "review-only")).toBe(
      "This README is review-only and is never installed. Every other file under\nthis directory is an installable template. `brigadier install <host>` copies\nthose files into the host's configuration directory.\n`src/surfaces/templates.ts` carries a byte-for-byte copy of each installable file\nso the compiled single-file binary can write them without this directory being\npresent on the user's machine, and `test/surfaces.test.ts` fails the build if the\ntwo ever diverge — in either direction, for any installable file.",
    );
  });

  test("the surface index matches the verified opencode and Codex hook states", () => {
    const index = readFileSync(join(surfacesRoot, "README.md"), "utf8");
    expect(textBetween(index, "- **opencode", "\n- **Codex")).toBe(
      "- **opencode — event binding verified, with limits.** The plugin's event names\n  were verified against opencode 1.18.16, but no live compaction was triggered,\n  only that version was tested, and its event vocabulary is version-dependent.\n  See `opencode/plugin/brigadier.js` and `opencode/README.md`.",
    );
    expect(textBetween(index, "- **Codex", "\n- **Claude Desktop")).toBe(
      "- **Codex — registered, then trust-gated.** `brigadier install codex` merges a\n  `PreCompact` registration into `$CODEX_HOME/hooks.json`, but Codex runs it only\n  after you approve the registration. Approval is bound to the registration, not\n  to the contents of `handoff.mjs`, so editing the script does not prompt again.\n  The nudge is deliberately not registered there, because adding an event would\n  disarm the approved handoff. See `codex/hooks/`.",
    );
  });

  test("the surface index cites each GUI host's own documentation for its path", () => {
    // A registration written to a guessed path is silent breakage the user
    // blames on their editor. The citation is what makes the path auditable.
    const index = readFileSync(join(surfacesRoot, "README.md"), "utf8");
    for (const [host, path, documentation] of [
      ["Cursor", "`~/.cursor/mcp.json`", "https://cursor.com/docs/context/mcp"],
      [
        "Windsurf",
        "`~/.codeium/windsurf/mcp_config.json`",
        "https://docs.devin.ai/desktop/cascade/mcp",
      ],
      [
        "Antigravity",
        "`~/.gemini/config/mcp_config.json`",
        "https://antigravity.google/docs/mcp",
      ],
      [
        "Claude Desktop",
        "`~/Library/Application Support/Claude/claude_desktop_config.json`",
        "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
      ],
    ]) {
      expect(`${host}: ${index.includes(path ?? "")}`).toBe(`${host}: true`);
      expect(`${host}: ${index.includes(documentation ?? "")}`).toBe(
        `${host}: true`,
      );
    }
  });

  test("the opencode README names both installed files", () => {
    const opencode = SURFACE_TEMPLATES["opencode/README.md"] ?? "";
    expect(paragraphContaining(opencode, "**Status:")).toBe(
      "**Status: plugin and event names verified on opencode 1.18.16; no live\ncompaction was triggered.**",
    );
    expect(paragraphContaining(opencode, "It writes")).toBe(
      "`brigadier install opencode` adds the one thing a skill cannot be: a plugin that\nwatches the session and reports automatic or manual compaction. It writes\n`plugin/brigadier.js` to `~/.config/opencode/plugin/brigadier.js` and\n`README.md` to `~/.config/opencode/brigadier.README.md`.",
    );
  });

  test("the Codex README states exactly what approval identifies", () => {
    const codex = SURFACE_TEMPLATES["codex/hooks/README.md"] ?? "";
    expect(paragraphContaining(codex, "Approval is bound")).toBe(
      "`brigadier install codex` registers the hook, but registration is not approval.\nCodex will not run a hook it has not been told to trust. Approving one is a\nmanual, interactive click in Codex. Approval is bound to the registration — the\nevent, matcher, and command configuration — not to the contents of\n`handoff.mjs`. The script at that approved path can later change without Codex\nasking again. To re-review an edited script, deliberately change the registration\nand approve the new registration.",
    );
    expect(paragraphContaining(codex, "persisted approval")).toBe(
      "Start an interactive Codex session and approve the hook when Codex presents its\nhook-trust prompt. Until that approval is persisted, the hook is a silent no-op:\nCodex still exits 0, with no warning and no hook output. That persisted approval\nremains valid when `handoff.mjs` changes. Only changing the registration itself —\nthe command string, event, or matcher — re-arms the prompt. To re-review an\nedited script, deliberately change the registration and approve it again.",
    );
  });

  test("the opencode plugin comment claims only declared event names", () => {
    const plugin = SURFACE_TEMPLATES["opencode/plugin/brigadier.js"] ?? "";
    expect(
      textBetween(
        plugin,
        "/**\n * The event names opencode",
        "\nexport const HANDOFF_EVENT_TYPES",
      ),
    ).toBe(
      "/**\n * The event names opencode 1.18.16 declares for compaction start and completion.\n * They were read from its OpenAPI union; emission during a real compaction was\n * not observed.\n */",
    );
  });

  test("Desktop doctrine keeps verified hook and staged-build limits explicit", () => {
    const desktop = SURFACE_TEMPLATES["claude-desktop/README.md"] ?? "";
    expect(paragraphContaining(desktop, "transcript-watching handoff")).toBe(
      "The transcript-watching handoff works on Claude Code. On\nopencode, its event names were verified only on 1.18.16, without triggering live\ncompaction, and remain version-dependent. On Codex, brigadier registers it and\nCodex trust-gates the registration; approval remains valid if the script at that\npath changes. On Desktop it is **impossible**, not merely unimplemented:\nDesktop exposes no hook surface of any kind, and an MCP server is invoked by the\nmodel when the model chooses to invoke it — never by the transcript, and never at\nthe moment the context fills. There is no workaround and none is offered.",
    );
    expect(
      textBetween(
        desktop,
        "1. `bun run build:mcp`",
        "\n\nThe server is zero-dependency",
      ),
    ).toBe(
      "1. `bun run build:mcp` — emits `dist/mcp/server.js`; it does not populate the\n   staged bundle.\n2. Copy that output into the staged directory as `server/brigadier-mcp.js`, the\n   path named by `manifest.json`.\n3. Zip the staged directory with `manifest.json` at the archive root and rename\n   it `brigadier.mcpb`.\n4. Open it with Claude Desktop, or drop it into Desktop's extensions pane.",
    );
  });

  test("no surface file carries a control byte, and the sweep can fail", () => {
    // THE CANARY. A control byte makes `grep` silently return nothing for every
    // pattern in a file, so a sweep that cannot be shown to fail is worthless.
    expect(hasControlByte("clean text\nwith a tab\there")).toBe(false);
    expect(hasControlByte("poisoned\u0007text")).toBe(true);
    expect(hasControlByte("poisoned\u0000text")).toBe(true);

    for (const key of walkSurfaces(surfacesRoot, "")) {
      expect(
        hasControlByte(readFileSync(join(surfacesRoot, key), "utf8")),
      ).toBe(false);
    }
    for (const contents of Object.values(SURFACE_TEMPLATES)) {
      expect(hasControlByte(contents)).toBe(false);
    }
  });

  test("the .mcpb manifest advertises exactly the server's tool names", () => {
    const manifest = JSON.parse(
      SURFACE_TEMPLATES["claude-desktop/manifest.json"] ?? "",
    ) as { tools: readonly { name: string; description: string }[] };
    const served = createTools({
      loadConfig: () =>
        Promise.resolve({ path: "/unused/config.json", config: null }),
      execute: () => Promise.resolve({ text: "unused", isError: false }),
    });
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      "brigadier_validate_plan",
      "brigadier_route_plan",
      "brigadier_run",
    ]);
    expect(served.map((tool) => tool.name)).toEqual(
      manifest.tools.map((tool) => tool.name),
    );
    expect(manifest.tools.map((tool) => tool.description)).toEqual(
      served.map((tool) => tool.description),
    );
  });
});

describe("brigadier install", () => {
  test("--all --dry-run names every destination and writes nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      const scratchHome = join(home, ".brigadier");
      const result = await install(["--all", "--dry-run"], {
        HOME: home,
        BRIGADIER_HOME: scratchHome,
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(verdictLines(result.stdout)).toEqual([
        `  created    ${home}/.claude/skills/brigadier/SKILL.md`,
        `  created    ${home}/.claude/skills/brigadier/.claude-plugin/plugin.json`,
        `  created    ${home}/.claude/skills/brigadier/hooks/hooks.json`,
        `  created    ${home}/.claude/skills/brigadier/hooks/handoff.mjs`,
        `  created    ${home}/.claude/skills/brigadier/hooks/nudge.mjs`,
        `  created    ${home}/.claude/skills/brigadier/hooks/README.md`,
        `  created    ${home}/.agents/skills/brigadier/SKILL.md`,
        `  created    ${home}/.agents/skills/brigadier/hooks/handoff.mjs`,
        `  created    ${home}/.agents/skills/brigadier/hooks/README.md`,
        `  created    ${home}/.codex/AGENTS.md`,
        `  created    ${home}/.codex/hooks.json`,
        `  created    ${home}/.config/opencode/plugin/brigadier.js`,
        `  created    ${home}/.config/opencode/brigadier.README.md`,
        // Every GUI host is skipped: this scratch HOME has no config, and no
        // config is not a yes.
        `  skipped    ${home}/.cursor/mcp.json`,
        `  skipped    ${home}/.codeium/windsurf/mcp_config.json`,
        `  skipped    ${home}/.gemini/config/mcp_config.json`,
        `  created    ${home}/.brigadier/surfaces/claude-desktop/manifest.json`,
        `  created    ${home}/.brigadier/surfaces/claude-desktop/README.md`,
        `  skipped    ${home}/Library/Application Support/Claude/claude_desktop_config.json`,
      ]);
      expect(
        result.stdout.endsWith(
          "\ndry run: 15 written, 0 unchanged, 4 skipped, 0 refused.\n",
        ),
      ).toBe(true);
      // A dry run writes NOTHING, not even the manifest that records writes.
      expect(readdirSync(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("--all states the four hook realities out loud", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      const result = await install(["--all", "--dry-run"], { HOME: home });
      const notes = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("  note: "));
      // Claude Code: no click at all.
      expect(
        notes.some((note) =>
          note.includes(
            "registered against PreCompact in " +
              `${home}/.claude/skills/brigadier/hooks/hooks.json` +
              " and needs no approval on this host",
          ),
        ),
      ).toBe(true);
      // Codex: registered, but not live until the registration is approved.
      expect(notes).toContain(
        `  note: THE HANDOFF HOOK IS REGISTERED AGAINST PreCompact IN ${home}/.codex/hooks.json, BUT IT WILL NOT RUN UNTIL YOU APPROVE IT IN CODEX. Approval is bound to the registration (event, matcher, and command), not to the contents of handoff.mjs, so editing the script leaves approval intact. To re-review an edited script, deliberately change the registration and approve it again. Claude Code needs no approval for the same hook; that asymmetry is deliberate on Codex's part, and brigadier neither works around it nor hides it.`,
      );
      // opencode: event names are verified, with the residual limits explicit.
      expect(
        notes.some((note) =>
          note.includes(
            "was verified on 2026-08-10 against a running opencode 1.18.16 darwin-arm64 by fetching GET /doc",
          ),
        ),
      ).toBe(true);
      // Desktop: impossible, and nothing was installed into Desktop.
      expect(
        notes.some((note) =>
          note.includes(
            "THE HANDOFF HOOK IS IMPOSSIBLE ON CLAUDE DESKTOP. It exposes no hook surface, and an MCP server is called by the model rather than by the transcript. There is no workaround.",
          ),
        ),
      ).toBe(true);
      expect(
        notes.some((note) =>
          note.includes("THE .mcpb BUNDLE WAS ONLY STAGED, AT "),
        ),
      ).toBe(true);
      // The four hosts that can only be reached over MCP say so, each naming
      // its own file rather than borrowing a neighbour's.
      for (const claim of [
        `Cursor reads no skill directory. ${home}/.cursor/mcp.json is the user-scoped MCP configuration`,
        `Windsurf reads no skill directory. ${home}/.codeium/windsurf/mcp_config.json is the only documented MCP configuration for Cascade`,
        `Antigravity reads no skill directory. ${home}/.gemini/config/mcp_config.json is the global configuration shared by its IDE, CLI, and SDK.`,
        `Desktop reads ${home}/Library/Application Support/Claude/claude_desktop_config.json only at startup.`,
      ]) {
        expect(
          `${claim.slice(0, 24)}: ${notes.some((note) => note.includes(claim))}`,
        ).toBe(`${claim.slice(0, 24)}: true`);
      }
      // Each registered path cites the host's own documentation, in the output
      // the user actually reads rather than only in a source comment.
      expect(
        notes.filter((note) =>
          note.startsWith("  note: that path and entry shape were read from "),
        ),
      ).toEqual([
        "  note: that path and entry shape were read from https://cursor.com/docs/context/mcp",
        "  note: that path and entry shape were read from https://docs.devin.ai/desktop/cascade/mcp",
        "  note: that path and entry shape were read from https://antigravity.google/docs/mcp",
        "  note: that path and entry shape were read from https://modelcontextprotocol.io/docs/develop/connect-local-servers",
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("claude-code lands byte-exact, with the hook executable", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      const result = await install(["claude-code"], { HOME: home });
      expect(result.code).toBe(0);
      expect(
        result.stdout.endsWith(
          "\n6 written, 0 unchanged, 0 skipped, 0 refused.\n",
        ),
      ).toBe(true);

      const skill = join(home, ".claude/skills/brigadier");
      expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe(
        SURFACE_TEMPLATES["claude-code/SKILL.md"] ?? "",
      );
      expect(hashOf(await readFile(join(skill, "SKILL.md"), "utf8"))).toBe(
        "0cb9faa8a75183bb70b6b08e08a819375affcc96558cd56937cc984b08a3da55",
      );
      expect(
        await readFile(join(skill, ".claude-plugin/plugin.json"), "utf8"),
      ).toBe(
        '{\n  "name": "brigadier",\n  "description": "You are not the worker: hand coding work to the brigadier CLI.",\n  "author": {\n    "name": "brigadier"\n  }\n}\n',
      );

      // A hook that is not executable is not a hook.
      expect((await stat(join(skill, "hooks/handoff.mjs"))).mode & 0o777).toBe(
        0o755,
      );
      expect((await stat(join(skill, "SKILL.md"))).mode & 0o777).toBe(0o644);

      // The manifest records what was written, and only that.
      const manifest = JSON.parse(
        await readFile(join(home, ".brigadier/surfaces.json"), "utf8"),
      ) as { version: number; files: Record<string, string> };
      expect(manifest.version).toBe(1);
      expect(Object.keys(manifest.files).sort()).toEqual([
        `${skill}/.claude-plugin/plugin.json`,
        `${skill}/SKILL.md`,
        `${skill}/hooks/README.md`,
        `${skill}/hooks/handoff.mjs`,
        `${skill}/hooks/hooks.json`,
        `${skill}/hooks/nudge.mjs`,
      ]);
      expect(manifest.files[`${skill}/SKILL.md`]).toBe(
        "0cb9faa8a75183bb70b6b08e08a819375affcc96558cd56937cc984b08a3da55",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("installing twice changes nothing the second time", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      await install(["claude-code"], { HOME: home });
      const second = await install(["claude-code"], { HOME: home });
      expect(second.code).toBe(0);
      expect(verdictLines(second.stdout)).toEqual([
        `  unchanged  ${home}/.claude/skills/brigadier/SKILL.md`,
        `  unchanged  ${home}/.claude/skills/brigadier/.claude-plugin/plugin.json`,
        `  unchanged  ${home}/.claude/skills/brigadier/hooks/hooks.json`,
        `  unchanged  ${home}/.claude/skills/brigadier/hooks/handoff.mjs`,
        `  unchanged  ${home}/.claude/skills/brigadier/hooks/nudge.mjs`,
        `  unchanged  ${home}/.claude/skills/brigadier/hooks/README.md`,
      ]);
      expect(
        second.stdout.endsWith(
          "\n0 written, 6 unchanged, 0 skipped, 0 refused.\n",
        ),
      ).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an edited file is refused, named, and left exactly as the user left it", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      await install(["claude-code"], { HOME: home });
      const edited = join(home, ".claude/skills/brigadier/SKILL.md");
      await writeFile(edited, "our team's own wording\n", "utf8");

      const second = await install(["claude-code"], { HOME: home });
      expect(second.code).toBe(1);
      expect(verdictLines(second.stdout)[0]).toBe(`  refused    ${edited}`);
      expect(second.stdout).toContain(
        "this file was edited after brigadier wrote it. Re-run with --force to discard those edits.",
      );
      // THE EDIT SURVIVED. This is the whole property.
      expect(await readFile(edited, "utf8")).toBe("our team's own wording\n");
      expect(
        second.stdout.endsWith(
          "\n0 written, 5 unchanged, 0 skipped, 1 refused.\n",
        ),
      ).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a file brigadier never wrote is refused with a different sentence", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      const target = join(home, ".codex/AGENTS.md");
      await install(["--all", "--dry-run"], { HOME: home });
      await Bun.write(target, "# my own global codex doctrine\n");

      const result = await install(["codex"], { HOME: home });
      expect(result.code).toBe(1);
      expect(verdictLines(result.stdout)[3]).toBe(`  refused    ${target}`);
      expect(result.stdout).toContain(
        "brigadier has no record of writing this file, so it belongs to something else. Re-run with --force to replace it.",
      );
      expect(await readFile(target, "utf8")).toBe(
        "# my own global codex doctrine\n",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("--force replaces an edited file", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      await install(["claude-code"], { HOME: home });
      const edited = join(home, ".claude/skills/brigadier/SKILL.md");
      await writeFile(edited, "our team's own wording\n", "utf8");

      const forced = await install(["claude-code", "--force"], { HOME: home });
      expect(forced.code).toBe(0);
      expect(verdictLines(forced.stdout)[0]).toBe(`  updated    ${edited}`);
      expect(await readFile(edited, "utf8")).toBe(
        SURFACE_TEMPLATES["claude-code/SKILL.md"] ?? "",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a file brigadier wrote and nobody touched is upgraded without a prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      await install(["claude-code"], { HOME: home });
      const target = join(home, ".claude/skills/brigadier/SKILL.md");
      const previous = "an older brigadier's doctrine\n";
      await writeFile(target, previous, "utf8");

      // Rewrite the manifest to claim brigadier itself wrote those bytes, which
      // is exactly the state a user is in after upgrading the binary.
      const manifestPath = join(home, ".brigadier/surfaces.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        version: number;
        files: Record<string, string>;
      };
      manifest.files[target] = sha256(previous);
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );

      const upgraded = await install(["claude-code"], { HOME: home });
      expect(upgraded.code).toBe(0);
      expect(verdictLines(upgraded.stdout)[0]).toBe(`  updated    ${target}`);
      expect(await readFile(target, "utf8")).toBe(
        SURFACE_TEMPLATES["claude-code/SKILL.md"] ?? "",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a final symlink outside a symlinked install root is refused even with --force", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-install-link-"));
    try {
      const home = `${scratch}/home`;
      const realConfig = `${scratch}/real-claude-config`;
      const configLink = `${scratch}/claude-config-link`;
      const outside = `${scratch}/dotfiles/SKILL.md`;
      const outsideBytes = Buffer.from(
        "FINAL OUTSIDE BYTES: do not overwrite\n",
        "utf8",
      );
      await mkdir(realConfig, { recursive: true });
      await mkdir(`${scratch}/dotfiles`, { recursive: true });
      await symlink(realConfig, configLink, "dir");
      await install(["claude-code"], {
        HOME: home,
        CLAUDE_CONFIG_DIR: configLink,
      });

      const target = `${configLink}/skills/brigadier/SKILL.md`;
      await writeFile(outside, outsideBytes);
      await recordOwnedBytes(home, target, outsideBytes.toString("utf8"));
      await unlink(target);
      await symlink(outside, target, "file");

      const result = await installWithin(["claude-code"], {
        HOME: home,
        CLAUDE_CONFIG_DIR: configLink,
      });
      const realOutside = await realpath(outside);
      expect(result.elapsedMs).toBeLessThan(5_000);
      expect(await fileDigest(outside)).toEqual({
        bytes: 38,
        sha256:
          "c275d8c915d3ca3938ff5a18e19d85b53cacff23f7392cecc3ddfe62460bdad8",
      });
      expect(result.code).toBe(1);
      expect(verdictLines(result.stdout)[0]).toBe(`  refused    ${target}`);
      expect(outcomeDetail(result.stdout, target)).toBe(
        `refusing to write ${target}: it is a symbolic link to ${outside} (real path ${realOutside}); brigadier never writes through a destination symlink. --force replaces edited files; it does not override this refusal.`,
      );
      expect(await readFile(outside)).toEqual(outsideBytes);

      const forced = await installWithin(["claude-code", "--force"], {
        HOME: home,
        CLAUDE_CONFIG_DIR: configLink,
      });
      expect(forced.elapsedMs).toBeLessThan(5_000);
      expect(await fileDigest(outside)).toEqual({
        bytes: 38,
        sha256:
          "c275d8c915d3ca3938ff5a18e19d85b53cacff23f7392cecc3ddfe62460bdad8",
      });
      expect(forced.code).toBe(1);
      expect(verdictLines(forced.stdout)[0]).toBe(`  refused    ${target}`);
      expect(outcomeDetail(forced.stdout, target)).toBe(
        `refusing to write ${target}: it is a symbolic link to ${outside} (real path ${realOutside}); brigadier never writes through a destination symlink. --force replaces edited files; it does not override this refusal.`,
      );
      expect(await readFile(outside)).toEqual(outsideBytes);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);

  test("a symlink-sensitive dot-dot root is refused without writing either interpretation", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-install-link-"));
    try {
      const home = `${scratch}/home`;
      const redirectTarget = `${scratch}/elsewhere/child`;
      const redirect = `${scratch}/redirect`;
      await mkdir(redirectTarget, { recursive: true });
      await mkdir(`${scratch}/elsewhere/claude`, { recursive: true });
      await symlink(redirectTarget, redirect, "dir");

      // String concatenation is load-bearing: join() would erase `redirect/..`
      // before the kernel could follow redirect to elsewhere/child.
      const configuredRoot = `${redirect}/../claude`;
      const result = await installWithin(["claude-code"], {
        HOME: home,
        CLAUDE_CONFIG_DIR: configuredRoot,
      });
      const actualTarget = `${scratch}/elsewhere/claude/skills/brigadier/SKILL.md`;
      const lexicallyCollapsedTarget = `${scratch}/claude/skills/brigadier/SKILL.md`;
      const states = await Promise.all(
        [actualTarget, lexicallyCollapsedTarget].map((path) =>
          readFile(path).then(
            () => "present",
            (error: unknown) =>
              error instanceof Error &&
              (error as { readonly code?: unknown }).code === "ENOENT"
                ? "absent"
                : "unexpected read error",
          ),
        ),
      );
      const target = `${configuredRoot}/skills/brigadier/SKILL.md`;
      expect(result.elapsedMs).toBeLessThan(5_000);
      expect(states).toEqual(["absent", "absent"]);
      expect(result.code).toBe(1);
      expect(verdictLines(result.stdout)[0]).toBe(`  refused    ${target}`);
      expect(outcomeDetail(result.stdout, target)).toBe(
        `refusing to write ${target}: install root ${configuredRoot} contains a ".." segment whose symlink-sensitive target cannot be established safely. --force replaces edited files; it does not override this refusal.`,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);

  test("a mid-path symlink outside the install root is refused", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-install-link-"));
    try {
      const home = `${scratch}/home`;
      await install(["claude-code"], { HOME: home });
      const installRoot = `${home}/.claude`;
      const linkedDirectory = `${installRoot}/skills/brigadier`;
      const outsideDirectory = `${scratch}/dotfiles/brigadier`;
      const target = `${linkedDirectory}/SKILL.md`;
      const outside = `${outsideDirectory}/SKILL.md`;
      const outsideBytes = Buffer.from(
        "MID-PATH OUTSIDE BYTES: do not overwrite\n",
        "utf8",
      );
      await mkdir(`${scratch}/dotfiles`, { recursive: true });
      await rename(linkedDirectory, outsideDirectory);
      await writeFile(outside, outsideBytes);
      await recordOwnedBytes(home, target, outsideBytes.toString("utf8"));
      await symlink(outsideDirectory, linkedDirectory, "dir");

      const result = await installWithin(["claude-code"], { HOME: home });
      const realRoot = await realpath(installRoot);
      const realOutside = await realpath(outside);
      expect(result.elapsedMs).toBeLessThan(5_000);
      expect(await fileDigest(outside)).toEqual({
        bytes: 41,
        sha256:
          "2c50cdeed64da8436cff8e3860c794a727cbebcbd64ceb64aa22801069554f03",
      });
      expect(result.code).toBe(1);
      expect(verdictLines(result.stdout)[0]).toBe(`  refused    ${target}`);
      expect(outcomeDetail(result.stdout, target)).toBe(
        `refusing to write ${target}: its real path is ${realOutside}, outside install root ${realRoot}. --force replaces edited files; it does not permit writes outside the install root.`,
      );
      expect(await readFile(outside)).toEqual(outsideBytes);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);

  test("a dangling final symlink is refused instead of creating its outside target", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-install-link-"));
    try {
      const home = `${scratch}/home`;
      await install(["claude-code"], { HOME: home });
      const target = `${home}/.claude/skills/brigadier/SKILL.md`;
      const outside = `${scratch}/dotfiles/new-SKILL.md`;
      await mkdir(`${scratch}/dotfiles`, { recursive: true });
      await unlink(target);
      await symlink(outside, target, "file");

      const result = await installWithin(["claude-code"], { HOME: home });
      const outsideState = await readFile(outside).then(
        (bytes) => ({
          exists: true,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
        (error: unknown) => ({
          exists: false,
          bytes: 0,
          sha256:
            error instanceof Error &&
            (error as { readonly code?: unknown }).code === "ENOENT"
              ? null
              : "unexpected read error",
        }),
      );
      expect(result.elapsedMs).toBeLessThan(5_000);
      expect(outsideState).toEqual({ exists: false, bytes: 0, sha256: null });
      expect(result.code).toBe(1);
      expect(verdictLines(result.stdout)[0]).toBe(`  refused    ${target}`);
      expect(outcomeDetail(result.stdout, target)).toBe(
        `refusing to write ${target}: it is a symbolic link to ${outside}, whose target could not be resolved. --force replaces edited files; it does not override this refusal.`,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);

  test("a final symlink introduced after inspection cannot redirect the write", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-install-link-"));
    try {
      const home = `${scratch}/home`;
      await install(["claude-code"], { HOME: home });
      const target = `${home}/.claude/skills/brigadier/SKILL.md`;
      const outside = `${scratch}/dotfiles/raced-SKILL.md`;
      const outsideBytes = Buffer.from(
        "RACED OUTSIDE BYTES: do not overwrite\n",
        "utf8",
      );
      await mkdir(`${scratch}/dotfiles`, { recursive: true });
      await writeFile(target, outsideBytes);
      await writeFile(outside, outsideBytes);
      await recordOwnedBytes(home, target, outsideBytes.toString("utf8"));

      let swapped = false;
      const racingIo: SurfaceIo = {
        ...nodeSurfaceIo,
        async writeFile(path, contents, mode, expected) {
          if (path === target && !swapped) {
            swapped = true;
            await unlink(target);
            await symlink(outside, target, "file");
          }
          await nodeSurfaceIo.writeFile(path, contents, mode, expected);
        },
      };
      const result = await installWithin(
        ["claude-code"],
        { HOME: home },
        racingIo,
      );
      const realOutside = await realpath(outside);
      expect(result.elapsedMs).toBeLessThan(5_000);
      expect(await fileDigest(outside)).toEqual({
        bytes: 38,
        sha256:
          "80ba87f60be66226ec1ad1b7a37aec984d2c5e13184edb5c830a37f668a722bf",
      });
      expect(swapped).toBe(true);
      expect(result.code).toBe(1);
      expect(verdictLines(result.stdout)[0]).toBe(`  refused    ${target}`);
      expect(outcomeDetail(result.stdout, target)).toBe(
        `refusing to write ${target}: it is a symbolic link to ${outside} (real path ${realOutside}); brigadier never writes through a destination symlink. --force replaces edited files; it does not override this refusal.`,
      );
      expect(await readFile(outside)).toEqual(outsideBytes);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);

  test("the computed manifest path cannot redirect its write outside BRIGADIER_HOME", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-install-link-"));
    try {
      const home = `${scratch}/home`;
      await install(["claude-code"], { HOME: home });
      const manifest = `${home}/.brigadier/surfaces.json`;
      const outside = `${scratch}/dotfiles/surfaces.json`;
      const outsideBytes = Buffer.from(
        "MANIFEST OUTSIDE BYTES: do not overwrite\n",
        "utf8",
      );
      await mkdir(`${scratch}/dotfiles`, { recursive: true });
      await writeFile(outside, outsideBytes);
      await unlink(manifest);
      await symlink(outside, manifest, "file");

      const result = await installWithin(["claude-code"], { HOME: home });
      const realOutside = await realpath(outside);
      expect(result.elapsedMs).toBeLessThan(5_000);
      expect(await fileDigest(outside)).toEqual({
        bytes: 41,
        sha256:
          "0bf03d7155451c24397db54321b6f9c4445fd4bca0526a26cd99aa23cd5026ba",
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `brigadier install: could not safely read ${manifest}: refusing to write ${manifest}: it is a symbolic link to ${outside} (real path ${realOutside}); brigadier never writes through a destination symlink. --force replaces edited files; it does not override this refusal.\n`,
      );
      expect(await readFile(outside)).toEqual(outsideBytes);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);

  test("a corrupt manifest fails safe: nothing is replaced", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      await install(["claude-code"], { HOME: home });
      const target = join(home, ".claude/skills/brigadier/SKILL.md");
      await writeFile(target, "edited\n", "utf8");
      await writeFile(
        join(home, ".brigadier/surfaces.json"),
        "{not json",
        "utf8",
      );

      const result = await install(["claude-code"], { HOME: home });
      expect(result.code).toBe(1);
      expect(verdictLines(result.stdout)[0]).toBe(`  refused    ${target}`);
      expect(await readFile(target, "utf8")).toBe("edited\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("the host directories honour their own environment overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      const scratchHome = `${home}/elsewhere/brigadier`;
      const result = await install(["--all", "--dry-run"], {
        HOME: home,
        CLAUDE_CONFIG_DIR: `${home}/elsewhere/claude`,
        CODEX_HOME: `${home}/elsewhere/codex`,
        XDG_CONFIG_HOME: `${home}/elsewhere/xdg`,
        BRIGADIER_HOME: scratchHome,
      });
      expect(result.code).toBe(0);
      expect(verdictLines(result.stdout)).toEqual([
        `  created    ${home}/elsewhere/claude/skills/brigadier/SKILL.md`,
        `  created    ${home}/elsewhere/claude/skills/brigadier/.claude-plugin/plugin.json`,
        `  created    ${home}/elsewhere/claude/skills/brigadier/hooks/hooks.json`,
        `  created    ${home}/elsewhere/claude/skills/brigadier/hooks/handoff.mjs`,
        `  created    ${home}/elsewhere/claude/skills/brigadier/hooks/nudge.mjs`,
        `  created    ${home}/elsewhere/claude/skills/brigadier/hooks/README.md`,
        `  created    ${home}/.agents/skills/brigadier/SKILL.md`,
        `  created    ${home}/.agents/skills/brigadier/hooks/handoff.mjs`,
        `  created    ${home}/.agents/skills/brigadier/hooks/README.md`,
        `  created    ${home}/elsewhere/codex/AGENTS.md`,
        `  created    ${home}/elsewhere/codex/hooks.json`,
        `  created    ${home}/elsewhere/xdg/opencode/plugin/brigadier.js`,
        `  created    ${home}/elsewhere/xdg/opencode/brigadier.README.md`,
        // The four GUI hosts read only their own documented location. None of
        // them honours an override, so none is offered, and these paths stay
        // anchored to HOME while every other root has moved.
        `  skipped    ${home}/.cursor/mcp.json`,
        `  skipped    ${home}/.codeium/windsurf/mcp_config.json`,
        `  skipped    ${home}/.gemini/config/mcp_config.json`,
        `  created    ${home}/elsewhere/brigadier/surfaces/claude-desktop/manifest.json`,
        `  created    ${home}/elsewhere/brigadier/surfaces/claude-desktop/README.md`,
        `  skipped    ${home}/Library/Application Support/Claude/claude_desktop_config.json`,
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("with no consent recorded, every GUI registration is skipped and named", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      // Every host present, every host installed, and still nothing is written:
      // presence is not permission.
      await makeGuiHostsPresent(home);
      await mkdir(join(home, ".brigadier"), { recursive: true });
      await writeFile(
        join(home, ".brigadier/config.json"),
        configBytes(false),
        "utf8",
      );

      const result = await install(
        ["cursor", "windsurf", "antigravity", "claude-desktop"],
        { HOME: home },
      );
      expect(result.code).toBe(0);
      const registrations = guiRegistrationPaths(home);
      expect(
        verdictLines(result.stdout).filter((line) => /skipped/.test(line)),
      ).toEqual(registrations.map((path) => `  skipped    ${path}`));
      // THE INSTRUCTIONS ARE PART OF THE GATE. A skip that does not say how to
      // proceed is indistinguishable from a bug.
      expect(result.stdout).toContain(
        `brigadier writes into another application's configuration only on an explicit yes, and only a human can give it. Run \`brigadier init\` yourself — recording this consent is the one thing it is for — and answer yes to "Register brigadier's MCP server with detected GUI hosts", which records "guiRegistrationConsent": true in ${home}/.brigadier/config.json. Nothing else, including --force, grants it.`,
      );
      // NOTHING WAS REGISTERED, SO THERE IS NO COMMAND TO WARN ABOUT. The PATH
      // note belongs to a registration that actually happened.
      expect(result.stdout).not.toContain(
        "THE REGISTRATION NAMES A BARE COMMAND",
      );
      // NOT ONE BYTE LANDED IN ANY OF THEM.
      for (const path of registrations) {
        expect(`${path} exists=${existsSync(path)}`).toBe(
          `${path} exists=false`,
        );
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("--force does not grant consent", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      await makeGuiHostsPresent(home);
      await mkdir(join(home, ".brigadier"), { recursive: true });
      await writeFile(
        join(home, ".brigadier/config.json"),
        configBytes(false),
        "utf8",
      );
      const forced = await install(["cursor", "--force"], { HOME: home });
      expect(forced.code).toBe(0);
      expect(verdictLines(forced.stdout)).toEqual([
        `  skipped    ${home}/.cursor/mcp.json`,
      ]);
      expect(existsSync(join(home, ".cursor/mcp.json"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a config that cannot be parsed is a no, not a yes", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      await makeGuiHostsPresent(home);
      await mkdir(join(home, ".brigadier"), { recursive: true });
      await writeFile(
        join(home, ".brigadier/config.json"),
        "{not json",
        "utf8",
      );
      const result = await install(["cursor"], { HOME: home });
      expect(verdictLines(result.stdout)).toEqual([
        `  skipped    ${home}/.cursor/mcp.json`,
      ]);
      expect(existsSync(join(home, ".cursor/mcp.json"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("with consent, each host gets its own documented path and shape", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      await makeGuiHostsPresent(home);
      await mkdir(join(home, ".brigadier"), { recursive: true });
      await writeFile(
        join(home, ".brigadier/config.json"),
        configBytes(true),
        "utf8",
      );

      const result = await install(
        ["cursor", "windsurf", "antigravity", "claude-desktop"],
        { HOME: home, BRIGADIER_MCP_COMMAND: "/usr/local/bin/brigadier" },
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const [cursor, windsurf, antigravity, desktop] =
        guiRegistrationPaths(home);
      expect(verdictLines(result.stdout)).toEqual([
        `  created    ${cursor}`,
        `  created    ${windsurf}`,
        `  created    ${antigravity}`,
        `  created    ${home}/.brigadier/surfaces/claude-desktop/manifest.json`,
        `  created    ${home}/.brigadier/surfaces/claude-desktop/README.md`,
        `  created    ${desktop}`,
      ]);

      // ONE HOST'S SHAPE DOES NOT GENERALISE TO ANOTHER. Cursor's own field
      // table marks `type` required for stdio servers; none of the other three
      // documents the key at all, so none of the other three is given it.
      expect(JSON.parse(await readFile(cursor ?? "", "utf8"))).toEqual({
        mcpServers: {
          brigadier: {
            type: "stdio",
            command: "/usr/local/bin/brigadier",
            args: ["mcp"],
          },
        },
      });
      for (const path of [windsurf, antigravity, desktop]) {
        expect(JSON.parse(await readFile(path ?? "", "utf8"))).toEqual({
          mcpServers: {
            brigadier: { command: "/usr/local/bin/brigadier", args: ["mcp"] },
          },
        });
      }
      // AN ABSOLUTE COMMAND NEEDS NO WARNING AND GETS NONE. The note below is
      // for the bare-name case only; printing it here would train the reader to
      // ignore it.
      expect(result.stdout).not.toContain(
        "THE REGISTRATION NAMES A BARE COMMAND",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a bare command is registered with the note that the host must find it", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      // THE COMMENT'S PROMISE, ASSERTED. Installing from source under `bun` (or
      // from `node dist/cli.js`) has no honest absolute path to offer, so the
      // bare name goes into a GUI host's config — a registration that exits 0
      // and may never start anything, because a Finder-launched application does
      // not inherit a login shell's PATH. The install still succeeds; it just
      // has to say so. `BRIGADIER_MCP_COMMAND` is deliberately unset here, which
      // is what makes the command bare under the test runner.
      await makeGuiHostsPresent(home);
      await mkdir(join(home, ".brigadier"), { recursive: true });
      await writeFile(
        join(home, ".brigadier/config.json"),
        configBytes(true),
        "utf8",
      );
      const target = join(home, ".cursor/mcp.json");

      const result = await install(["cursor"], { HOME: home });
      expect(result.code).toBe(0);
      expect(verdictLines(result.stdout)).toEqual([`  created    ${target}`]);
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
        mcpServers: {
          brigadier: { type: "stdio", command: "brigadier", args: ["mcp"] },
        },
      });
      expect(result.stdout).toContain(
        `  note: THE REGISTRATION NAMES A BARE COMMAND, "brigadier". This host has to resolve it on its own PATH, and an application launched from Finder does not inherit a login shell's PATH — when it cannot find the command, the server never starts and nothing says so. Set BRIGADIER_MCP_COMMAND to an absolute path and run this again to write that instead.\n`,
      );

      // A WARNING, NOT A FAILURE: the second run is unchanged, still exits 0,
      // and still says it, because the bare command is still in the file.
      const again = await install(["cursor"], { HOME: home });
      expect(again.code).toBe(0);
      expect(verdictLines(again.stdout)).toEqual([`  unchanged  ${target}`]);
      expect(again.stdout).toContain("THE REGISTRATION NAMES A BARE COMMAND");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a registration preserves every other server and key in the file", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      await makeGuiHostsPresent(home);
      await mkdir(join(home, ".brigadier"), { recursive: true });
      await writeFile(
        join(home, ".brigadier/config.json"),
        configBytes(true),
        "utf8",
      );
      const target = join(home, ".cursor/mcp.json");
      // Deliberately not brigadier's formatting: compact arrays, an unknown
      // top-level key, and a foreign server that must come back untouched.
      const original = `{\n  "mcpServers": {\n    "someone-else": {\n      "command": "npx",\n      "args": ["-y", "other"]\n    }\n  },\n  "unknownTopLevel": 42\n}\n`;
      await writeFile(target, original, "utf8");

      const result = await install(["cursor"], {
        HOME: home,
        BRIGADIER_MCP_COMMAND: "/usr/local/bin/brigadier",
      });
      expect(result.code).toBe(0);
      expect(verdictLines(result.stdout)).toEqual([`  updated    ${target}`]);
      const after = await readFile(target, "utf8");
      // The foreign server's own bytes, including its compact array, survive.
      expect(after).toContain(
        `    "someone-else": {\n      "command": "npx",\n      "args": ["-y", "other"]\n    }`,
      );
      expect(after).toContain(`  "unknownTopLevel": 42`);
      expect(JSON.parse(after)).toEqual({
        mcpServers: {
          "someone-else": { command: "npx", args: ["-y", "other"] },
          brigadier: {
            type: "stdio",
            command: "/usr/local/bin/brigadier",
            args: ["mcp"],
          },
        },
        unknownTopLevel: 42,
      });

      // Idempotent: a second install changes nothing at all.
      const second = await install(["cursor"], {
        HOME: home,
        BRIGADIER_MCP_COMMAND: "/usr/local/bin/brigadier",
      });
      expect(verdictLines(second.stdout)).toEqual([`  unchanged  ${target}`]);
      expect(await readFile(target, "utf8")).toBe(after);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a host that is not installed is skipped rather than conjured", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      // Consent given, but only Cursor is actually on this machine.
      await mkdir(join(home, ".cursor"), { recursive: true });
      await mkdir(join(home, ".brigadier"), { recursive: true });
      await writeFile(
        join(home, ".brigadier/config.json"),
        configBytes(true),
        "utf8",
      );

      const result = await install(["cursor", "windsurf"], {
        HOME: home,
        BRIGADIER_MCP_COMMAND: "/usr/local/bin/brigadier",
      });
      expect(result.code).toBe(0);
      expect(verdictLines(result.stdout)).toEqual([
        `  created    ${home}/.cursor/mcp.json`,
        `  skipped    ${home}/.codeium/windsurf/mcp_config.json`,
      ]);
      expect(result.stdout).toContain(
        `${home}/.codeium/windsurf does not exist, so this host is not installed on this machine. brigadier does not create another product's configuration directory.`,
      );
      expect(existsSync(join(home, ".codeium"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("malformed host JSON is refused and left byte-for-byte intact", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      await makeGuiHostsPresent(home);
      await mkdir(join(home, ".brigadier"), { recursive: true });
      await writeFile(
        join(home, ".brigadier/config.json"),
        configBytes(true),
        "utf8",
      );
      const target = join(home, ".cursor/mcp.json");
      const malformed = '{"mcpServers": {\nHAND EDIT\n';
      await writeFile(target, malformed, "utf8");

      const result = await install(["cursor"], { HOME: home });
      expect(result.code).toBe(1);
      expect(verdictLines(result.stdout)).toEqual([`  refused    ${target}`]);
      expect(outcomeDetail(result.stdout, target)).toBe(
        `could not parse ${target}. Fix the malformed JSON and re-run; brigadier left the file unchanged.`,
      );
      expect(await readFile(target, "utf8")).toBe(malformed);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a registration is never written through a destination symlink", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-install-link-"));
    try {
      const home = `${scratch}/home`;
      await makeGuiHostsPresent(home);
      await mkdir(`${home}/.brigadier`, { recursive: true });
      await mkdir(`${scratch}/dotfiles`, { recursive: true });
      await writeFile(
        `${home}/.brigadier/config.json`,
        configBytes(true),
        "utf8",
      );
      const target = `${home}/.cursor/mcp.json`;
      const outside = `${scratch}/dotfiles/mcp.json`;
      const outsideBytes = "REGISTRATION OUTSIDE BYTES: do not overwrite\n";
      await writeFile(outside, outsideBytes, "utf8");
      await symlink(outside, target, "file");

      const result = await installWithin(["cursor"], { HOME: home });
      const realOutside = await realpath(outside);
      expect(result.elapsedMs).toBeLessThan(5_000);
      expect(result.code).toBe(1);
      expect(verdictLines(result.stdout)).toEqual([`  refused    ${target}`]);
      expect(outcomeDetail(result.stdout, target)).toBe(
        `refusing to write ${target}: it is a symbolic link to ${outside} (real path ${realOutside}); brigadier never writes through a destination symlink. --force replaces edited files; it does not override this refusal.`,
      );
      expect(await readFile(outside, "utf8")).toBe(outsideBytes);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);

  test("no HOME is refused rather than guessed", async () => {
    const result = await install(["claude-code"], {});
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "brigadier install: invalid brigadier config: cannot resolve the brigadier home directory: set $BRIGADIER_HOME or $HOME\n",
    );
    expect(result.stdout).toBe("");
  });

  test("a write that fails is reported as failed and earns exit 1", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      const failing: SurfaceIo = {
        ...nodeSurfaceIo,
        mkdir: () => Promise.resolve(),
        readFile: () => {
          const error = new Error("ENOENT") as Error & { code: string };
          error.code = "ENOENT";
          return Promise.reject(error);
        },
        writeFile: () => Promise.reject(new Error("read-only file system")),
      };
      const result = await install(["opencode"], { HOME: home }, failing);
      expect(result.code).toBe(1);
      expect(verdictLines(result.stdout)).toEqual([
        `  failed     ${home}/.config/opencode/plugin/brigadier.js`,
        `  failed     ${home}/.config/opencode/brigadier.README.md`,
      ]);
      expect(result.stdout).toContain("read-only file system");
      expect(result.stderr).toContain("could not record what was written to");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("usage errors exit 2 and help exits 0", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      const unknown = await install(["emacs"], { HOME: home });
      expect(unknown.code).toBe(2);
      expect(unknown.stderr.split("\n")[0]).toBe(
        'brigadier install: unknown host "emacs"; known hosts are claude-code, codex, opencode, cursor, windsurf, antigravity, claude-desktop',
      );

      const none = await install([], { HOME: home });
      expect(none.code).toBe(2);
      expect(none.stderr.split("\n")[0]).toBe(
        "brigadier install: name at least one host, or pass --all; known hosts are claude-code, codex, opencode, cursor, windsurf, antigravity, claude-desktop",
      );

      const badOption = await install(["--frobnicate"], { HOME: home });
      expect(badOption.code).toBe(2);
      expect(badOption.stderr.split("\n")[0]).toBe(
        'brigadier install: unknown option "--frobnicate"',
      );

      const help = await install(["--help"], { HOME: home });
      expect(help.code).toBe(0);
      expect(help.stderr).toBe("");
      expect(help.stdout.split("\n")[0]).toBe(
        "Usage: brigadier install <host>... [options]",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a host named twice is installed once", async () => {
    const home = await mkdtemp(join(tmpdir(), "brigadier-install-"));
    try {
      const result = await install(
        ["claude-code", "claude-code", "--dry-run"],
        { HOME: home },
      );
      expect(result.code).toBe(0);
      expect(verdictLines(result.stdout).length).toBe(6);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("the handoff hook", () => {
  const hookPath = join(surfacesRoot, "claude-code/hooks/handoff.mjs");

  interface HookRun {
    readonly stdout: string;
    readonly exitCode: number;
    readonly timedOut: boolean;
  }

  /**
   * Runs the hook as the host would: a JSON object on stdin, JSON on stdout.
   *
   * `closeStdin: false` is how the "stdin never ends" case is driven, and the
   * deadline here is what stops that case from wedging the suite if the hook's
   * own timeout is ever removed.
   */
  async function runHook(
    payload: string,
    env: Record<string, string>,
    closeStdin = true,
  ): Promise<HookRun> {
    const proc = Bun.spawn({
      cmd: ["node", hookPath],
      env: { PATH: process.env.PATH ?? "", ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = (async (): Promise<string> => {
      const reader = proc.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            return Buffer.concat(chunks, bytes).toString("utf8");
          }
          bytes += next.value.byteLength;
          if (bytes > MAX_HOOK_STDOUT_BYTES) {
            proc.kill(9);
            throw new Error(
              `hook stdout exceeded ${MAX_HOOK_STDOUT_BYTES} bytes`,
            );
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
    })();
    proc.stdin.write(payload);
    if (closeStdin) {
      await proc.stdin.end();
    } else {
      await proc.stdin.flush();
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, 15_000);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { stdout: await stdout, exitCode, timedOut };
  }

  test("a real transcript is counted and reported in one sentence", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-hook-"));
    try {
      const transcript = join(scratch, "transcript.jsonl");
      await writeFile(
        transcript,
        [
          '{"type":"user","message":"do the thing"}',
          '{"type":"assistant","message":"ok"}',
          '{"type":"assistant","message":"still going"}',
          "{ truncated line",
          '{"type":"assistant","message":"nearly out of room"}',
          "",
        ].join("\n"),
        "utf8",
      );
      const run = await runHook(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcript,
          session_id: "abc",
        }),
        {},
      );
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe(
        '{"systemMessage":"brigadier: this session is out of context after 3 assistant turn(s). Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review."}\n',
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("a Codex rollout transcript is counted and reported in one sentence", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-hook-"));
    try {
      const transcript = join(scratch, "rollout.jsonl");
      await writeFile(
        transcript,
        [
          '{"type":"session_meta","payload":{"id":"session-abc"}}',
          '{"type":"event_msg","payload":{"type":"task_started"}}',
          '{"type":"response_item","payload":{"type":"message","role":"user","content":[]}}',
          '{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Working through the request."}]}}',
          '{"type":"response_item","payload":{"type":"reasoning","role":"assistant","summary":[]}}',
          '{"type":"turn_context","payload":{"turn_id":"turn-1"}}',
          '{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"The requested work is complete."}]}}',
          "",
        ].join("\n"),
        "utf8",
      );
      const run = await runHook(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcript,
          session_id: "abc",
        }),
        {},
      );
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe(
        '{"systemMessage":"brigadier: this session is out of context after 2 assistant turn(s). Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review."}\n',
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("an unrecognised transcript shape degrades to the shorter sentence", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-hook-"));
    try {
      const transcript = join(scratch, "transcript.jsonl");
      await writeFile(
        transcript,
        [
          '{"type":"metadata","session_id":"abc"}',
          '{"type":"tool_result","content":"done"}',
          "",
        ].join("\n"),
        "utf8",
      );
      const run = await runHook(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcript,
          session_id: "abc",
        }),
        {},
      );
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe(
        '{"systemMessage":"brigadier: this session is out of context. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review."}\n',
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("a mixed transcript sums Claude Code and Codex assistant turns", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-hook-"));
    try {
      const transcript = join(scratch, "transcript.jsonl");
      await writeFile(
        transcript,
        [
          '{"type":"assistant","message":"Claude Code turn"}',
          '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}',
          '{"type":"assistant","message":"another Claude Code turn"}',
          "",
        ].join("\n"),
        "utf8",
      );
      const run = await runHook(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcript,
          session_id: "abc",
        }),
        {},
      );
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe(
        '{"systemMessage":"brigadier: this session is out of context after 3 assistant turn(s). Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review."}\n',
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("an absent or unreadable transcript degrades to the shorter sentence", async () => {
    const withoutPath = await runHook(
      JSON.stringify({ hook_event_name: "PreCompact" }),
      {},
    );
    expect(withoutPath.timedOut).toBe(false);
    expect(withoutPath.exitCode).toBe(0);
    expect(withoutPath.stdout).toBe(
      '{"systemMessage":"brigadier: this session is out of context. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review."}\n',
    );

    const missing = await runHook(
      JSON.stringify({
        hook_event_name: "PreCompact",
        transcript_path: "/nonexistent/transcript.jsonl",
      }),
      {},
    );
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout).toBe(withoutPath.stdout);
  }, 30_000);

  test("a FIFO transcript degrades to the shorter sentence instead of hanging", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-hook-"));
    try {
      const transcript = join(scratch, "transcript.fifo");
      const created = spawnSync("mkfifo", [transcript]);
      if (created.error !== undefined || created.status !== 0) {
        throw new Error(
          `mkfifo failed: status=${created.status}, error=${created.error}`,
        );
      }
      const run = await runHook(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcript,
        }),
        {},
      );
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe(
        '{"systemMessage":"brigadier: this session is out of context. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review."}\n',
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("a directory as transcript_path degrades to the shorter sentence", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-hook-"));
    try {
      const readMarker = join(scratch, "directory-read-attempted");
      const preload = join(scratch, "observe-directory-read.mjs");
      await writeFile(
        preload,
        [
          'import fs from "node:fs";',
          'import { syncBuiltinESMExports } from "node:module";',
          "const originalReadFileSync = fs.readFileSync;",
          "fs.readFileSync = function (...args) {",
          "  if (args[0] === process.env.BRIGADIER_TEST_DIRECTORY_TRANSCRIPT) {",
          '    fs.writeFileSync(process.env.BRIGADIER_TEST_DIRECTORY_READ_MARKER, "");',
          "  }",
          "  return originalReadFileSync.apply(this, args);",
          "};",
          "syncBuiltinESMExports();",
          "",
        ].join("\n"),
        "utf8",
      );
      const run = await runHook(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: scratch,
        }),
        {
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          BRIGADIER_TEST_DIRECTORY_TRANSCRIPT: scratch,
          BRIGADIER_TEST_DIRECTORY_READ_MARKER: readMarker,
        },
      );
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe(
        '{"systemMessage":"brigadier: this session is out of context. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review."}\n',
      );
      expect(existsSync(readMarker)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("a transcript too large to walk is not walked", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-hook-"));
    try {
      const transcript = join(scratch, "huge.jsonl");
      // One assistant turn, padded past the 8 MB ceiling. A hook that walked it
      // anyway would report 1 rather than degrading.
      await writeFile(
        transcript,
        `{"type":"assistant","message":"${"x".repeat(8_100_000)}"}\n`,
        "utf8",
      );
      const run = await runHook(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcript,
        }),
        {},
      );
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe(
        '{"systemMessage":"brigadier: this session is out of context. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review."}\n',
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("input the hook cannot understand produces silence, never a failure", async () => {
    const garbage = await runHook("this is not JSON at all", {});
    expect(garbage.timedOut).toBe(false);
    expect(garbage.exitCode).toBe(0);
    expect(garbage.stdout).toBe("");

    const notAnObject = await runHook('"a bare string"', {});
    expect(notAnObject.exitCode).toBe(0);
    expect(notAnObject.stdout).toBe("");
  }, 30_000);

  test("a top-level JSON array on stdin produces silence", async () => {
    const array = await runHook("[]", {});
    expect(array.exitCode).toBe(0);
    expect(array.stdout).toBe("");

    const number = await runHook("42", {});
    expect(number.exitCode).toBe(0);
    expect(number.stdout).toBe("");

    const nullValue = await runHook("null", {});
    expect(nullValue.exitCode).toBe(0);
    expect(nullValue.stdout).toBe("");
  }, 30_000);

  test("a closed stdout does not turn the hook into a failure", () => {
    const pipeline = spawnSync(
      "bash",
      [
        "-c",
        `set -o pipefail\nprintf '%s' '{"hook_event_name":"PreCompact"}' | node ${JSON.stringify(hookPath)} | true`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    // A timeout would set error; if the pipeline hangs, this assertion fails clearly.
    expect(pipeline.error).toBeUndefined();
    expect(pipeline.status).toBe(0);
  }, 30_000);

  test("stdin that never ends is abandoned rather than waited on forever", async () => {
    const started = Date.now();
    const run = await runHook(
      JSON.stringify({ hook_event_name: "PreCompact" }),
      { BRIGADIER_HANDOFF_STDIN_TIMEOUT_MS: "150" },
      false,
    );
    // BOUNDED, AND THE BOUND IS ASSERTED. A hook that waits on a stdin the host
    // forgot to close hangs the session it was supposed to help.
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run.stdout).toBe(
      '{"systemMessage":"brigadier: this session is out of context. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review."}\n',
    );
  }, 30_000);
});

describe("the nudge hook", () => {
  const nudgePath = join(surfacesRoot, "claude-code/hooks/nudge.mjs");

  /** One prompt, one scratch temp root, so once-per-session is observable. */
  async function runNudge(
    payload: unknown,
    scratch: string,
    env: Record<string, string> = {},
  ): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn({
      cmd: ["node", nudgePath],
      env: { PATH: process.env.PATH ?? "", TMPDIR: scratch, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).text();
    proc.stdin.write(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
    await proc.stdin.end();
    const exitCode = await proc.exited;
    return { stdout: await stdout, exitCode };
  }

  function prompt(sessionId: string, text: string): Record<string, unknown> {
    return {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      transcript_path: "/nonexistent/transcript.jsonl",
      cwd: "/tmp",
      user_input: text,
    };
  }

  const MULTI_PART =
    "Refactor the authentication module so the token refresh is shared, and update every call site across the codebase to use the new helper instead of the inline logic they each carry today.";

  const EXPECTED_MESSAGE =
    "brigadier: this looks like more than one independent piece of work. Load the brigadier skill, write it as a plan, and run `brigadier run` from here rather than doing it inline. If you are already a brigadier worker running one slice, ignore this and do your slice.";

  /**
   * THE WHOLE MATCHER, AS A TABLE, WITH ABSOLUTE EXPECTATIONS.
   *
   * A false positive costs far more than a false negative here: the hook has one
   * nudge per session, and spending it on a bug report means the genuinely
   * multi-part task three prompts later gets nothing. Every silent case below is
   * a shape that fired, or nearly fired, before this table existed.
   */
  const MATCHER_CASES: readonly [string, boolean, string][] = [
    // A QUESTION IS NEVER ENOUGH, however it is formatted. Three bullets of
    // symptoms under an opening question is one bug, not three pieces of work.
    [
      "a question with three bullets of symptoms",
      false,
      "Why is the /orders endpoint returning 502 in staging but never locally, when the same build passes every check we have?\n- p95 latency triples about a minute before it starts\n- the pod restarts twice an hour with no OOM in the events\n- the upstream logs show a connection reset rather than a timeout",
    ],
    // ORDINARY ENGLISH ABOUT ONE FUNCTION. A structural verb beside a plural
    // word is not a plan: this is one function in one file.
    [
      "a big verb about one function",
      false,
      "Refactor `parseCsv` to handle multiple delimiters across quoted fields, and keep the existing tests green so nothing that already parses today starts failing.",
    ],
    // A PASTE IS NOT AN ASSIGNMENT.
    [
      "a pasted stack trace",
      false,
      "TypeError: Cannot read properties of undefined (reading 'id')\n    at resolveOrder (/srv/app/src/orders/resolve.js:42:19)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)\n    at async invokeHandler (/srv/app/src/http/handler.js:18:3)",
    ],
    // A FENCE IS QUOTED MATERIAL. Those three bullets are the user's config,
    // not three slices, and the breadth and scope words inside it are theirs.
    [
      "a fenced block whose contents are bulleted",
      false,
      "Here is the CI config we are using right now, and something in it makes the cache miss on the second run:\n\n```yaml\nsteps:\n  - build every package in the workspace\n  - migrate the database\n  - rename the outputs\n```\n\nTake a look and tell me what you find.",
    ],
    ["something short", false, "fix the typo in parser.ts"],
    [
      "one file, at length",
      false,
      "In src/http/client.ts the retry loop currently swallows the abort signal when the timeout fires, which makes a cancelled request look like a transient failure. Please fix that.",
    ],
    [
      "a question that merely says each",
      false,
      "Can you walk me through how each of these middleware functions is invoked, and across which routes, so that I understand the ordering before I change anything?",
    ],
    [
      "breadth with no scope verb",
      false,
      "Have a look at every one of the handlers in the routes directory and tell me which of them are still using the deprecated response helper, across the whole codebase.",
    ],
    // AND THE OTHER DIRECTION: genuinely independent pieces, which are what the
    // session's one nudge is for.
    [
      "a shared helper and every call site",
      true,
      "Refactor the authentication module so the token refresh is shared, and update every call site across the codebase to use the new helper instead of the inline logic they each carry today.",
    ],
    [
      "a migration naming three files",
      true,
      "Migrate the billing integration off the deprecated SDK across all the services that use it: src/billing/client.ts, src/billing/webhooks.ts and src/billing/reconcile.ts each need the new auth header, and their shared fixtures need updating too.",
    ],
    [
      "a rename reaching every module that imports it",
      true,
      "Rename the legacy UserRecord type to Account and update every module that imports it, including the API handlers, the persistence layer and the seed scripts, then rewrite the fixtures that hard-code the old name.",
    ],
    [
      "an enumerated plan of three items",
      true,
      "Please pick up the following work items today:\n1. Add a retry helper in src/http/retry.ts\n2. Wire it into the client in src/http/client.ts\n3. Backfill the tests in test/http.test.ts",
    ],
  ];

  test("the matcher fires on independent pieces and on nothing else", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-nudge-"));
    try {
      for (const [label, shouldFire, text] of MATCHER_CASES) {
        const run = await runNudge(prompt(`session-${label}`, text), scratch);
        // The absolute expected value, per case: exit code and the exact bytes.
        expect(`${label}: ${run.exitCode} ${JSON.stringify(run.stdout)}`).toBe(
          `${label}: 0 ${JSON.stringify(
            shouldFire
              ? `${JSON.stringify({
                  systemMessage: EXPECTED_MESSAGE,
                  additionalContext: EXPECTED_MESSAGE,
                })}\n`
              : "",
          )}`,
        );
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  test("a worker never hears the nudge, whatever its slice prompt says", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-nudge-"));
    try {
      // THE MECHANICAL HALF OF THE RE-ENTRY GUARD. `workerEnvironment` in
      // src/worker/shared.ts stamps this marker at the spawn, so a slice prompt
      // — long, enumerated, and full of exactly the words the matcher looks for
      // — cannot make the hook tell a worker to run brigadier. The prompt used
      // here is one the matcher demonstrably fires on above.
      const [, , firing] = MATCHER_CASES[8] ?? ["", false, ""];
      const run = await runNudge(prompt("session-worker", firing), scratch, {
        BRIGADIER_WORKER: "1",
      });
      expect(`${run.exitCode} ${JSON.stringify(run.stdout)}`).toBe('0 ""');

      // The same prompt, the same scratch root, without the marker: the marker
      // is what silenced it, not the once-per-session claim.
      const unmarked = await runNudge(
        prompt("session-not-worker", firing),
        scratch,
      );
      expect(JSON.parse(unmarked.stdout).systemMessage).toBe(EXPECTED_MESSAGE);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("an ordinary prompt is met with silence", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-nudge-"));
    try {
      // THE PROPERTY THAT KEEPS THE HOOK INSTALLED. A hook that speaks every
      // turn is uninstalled within a day, so each of these must be silent: too
      // short, long but about one file, and a question that merely says "each".
      const cases: readonly [string, string][] = [
        ["short", "fix the typo in parser.ts"],
        [
          "one file, at length",
          "In src/http/client.ts the retry loop currently swallows the abort signal when the timeout fires, which makes a cancelled request look like a transient failure. Please fix that.",
        ],
        [
          "a question",
          "Can you walk me through how each of these middleware functions is invoked, and across which routes, so that I understand the ordering before I change anything?",
        ],
        [
          "breadth with no scope verb",
          "Have a look at every one of the handlers in the routes directory and tell me which of them are still using the deprecated response helper, across the whole codebase.",
        ],
      ];
      for (const [label, text] of cases) {
        const run = await runNudge(prompt(`session-${label}`, text), scratch);
        expect(`${label}: ${run.exitCode} ${JSON.stringify(run.stdout)}`).toBe(
          `${label}: 0 ""`,
        );
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("genuinely multi-part work is nudged exactly once per session", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-nudge-"));
    try {
      const first = await runNudge(prompt("session-a", MULTI_PART), scratch);
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({
        // Both keys carry the same line. `systemMessage` is what the user sees;
        // `additionalContext` is what the model reads, and a nudge that reached
        // only the human would not make the skill fire.
        systemMessage: EXPECTED_MESSAGE,
        additionalContext: EXPECTED_MESSAGE,
      });

      // ONCE. The second prompt in the same session, however multi-part, is met
      // with silence.
      const second = await runNudge(prompt("session-a", MULTI_PART), scratch);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toBe("");

      // A different session is a different budget.
      const other = await runNudge(prompt("session-b", MULTI_PART), scratch);
      expect(other.stdout).toBe(first.stdout);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("an enumerated plan of three or more items is nudged", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-nudge-"));
    try {
      const run = await runNudge(
        prompt(
          "session-list",
          [
            "Please pick up the following work items today:",
            "1. Add a retry helper in src/http/retry.ts",
            "2. Wire it into the client in src/http/client.ts",
            "3. Backfill the tests in test/http.test.ts",
          ].join("\n"),
        ),
        scratch,
      );
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout).systemMessage).toBe(EXPECTED_MESSAGE);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("an unbounded or unrecognised call produces silence, never a failure", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-nudge-"));
    try {
      const cases: readonly [string, unknown][] = [
        ["garbage", "this is not JSON at all"],
        ["array", "[]"],
        ["null", "null"],
        // A session with no id cannot be bounded to one nudge, so it gets none.
        [
          "no session id",
          {
            hook_event_name: "UserPromptSubmit",
            user_input: MULTI_PART,
          },
        ],
        // Registered against the wrong event, the script is inert.
        [
          "wrong event",
          {
            hook_event_name: "PreCompact",
            session_id: "session-wrong",
            user_input: MULTI_PART,
          },
        ],
        // No prompt text at all.
        [
          "no prompt",
          { hook_event_name: "UserPromptSubmit", session_id: "session-empty" },
        ],
      ];
      for (const [label, payload] of cases) {
        const run = await runNudge(payload, scratch);
        expect(`${label}: ${run.exitCode} ${JSON.stringify(run.stdout)}`).toBe(
          `${label}: 0 ""`,
        );
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("the older `prompt` field is read, and BRIGADIER_NUDGE=off silences it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-nudge-"));
    try {
      const legacy = await runNudge(
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "session-legacy",
          prompt: MULTI_PART,
        },
        scratch,
      );
      expect(JSON.parse(legacy.stdout).systemMessage).toBe(EXPECTED_MESSAGE);

      const off = await runNudge(prompt("session-off", MULTI_PART), scratch, {
        BRIGADIER_NUDGE: "off",
      });
      expect(off.exitCode).toBe(0);
      expect(off.stdout).toBe("");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("an unwritable marker directory means silence, not a nudge every turn", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-nudge-"));
    try {
      // A temp root that is a regular file: the marker directory cannot be
      // created, so once-per-session cannot be enforced, so nothing is said.
      const blocked = join(scratch, "not-a-directory");
      await writeFile(blocked, "", "utf8");
      const run = await runNudge(
        prompt("session-blocked", MULTI_PART),
        blocked,
      );
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe("");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("stdin that never ends is abandoned rather than waited on forever", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "brigadier-nudge-"));
    try {
      const started = Date.now();
      const proc = Bun.spawn({
        cmd: ["node", nudgePath],
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: scratch,
          BRIGADIER_HANDOFF_STDIN_TIMEOUT_MS: "150",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new Response(proc.stdout).text();
      proc.stdin.write(JSON.stringify(prompt("session-open", MULTI_PART)));
      await proc.stdin.flush();
      const timer = setTimeout(() => proc.kill(9), 15_000);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      // BOUNDED, AND THE BOUND IS ASSERTED. The pipe is never closed; the hook
      // still answers and exits.
      expect(exitCode).toBe(0);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(JSON.parse(await stdout).systemMessage).toBe(EXPECTED_MESSAGE);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the opencode plugin", () => {
  test("matches the verified event vocabulary exactly", async () => {
    const module = (await import(
      join(surfacesRoot, "opencode/plugin/brigadier.js")
    )) as {
      HANDOFF_EVENT_TYPES: readonly string[];
      isHandoffEvent: (event: unknown) => boolean;
    };

    expect(module.isHandoffEvent({ type: "session.compacted" })).toBe(true);
    expect(module.isHandoffEvent({ type: "session.compacting" })).toBe(false);
    expect(
      module.isHandoffEvent({ type: "session.next.compaction.started" }),
    ).toBe(true);
    expect(module.HANDOFF_EVENT_TYPES).toEqual([
      "session.compacted",
      "session.next.compaction.started",
    ]);
    expect(module.isHandoffEvent({ type: "session.created" })).toBe(false);
    expect(module.isHandoffEvent(null)).toBe(false);
    expect(module.isHandoffEvent("session.compacted")).toBe(false);
  });

  test("uses the verified compaction reason without inventing a turn count", async () => {
    const module = (await import(
      join(surfacesRoot, "opencode/plugin/brigadier.js")
    )) as {
      buildHandoffMessage: (reason: unknown) => string;
      readCompactionReason: (event: unknown) => "auto" | "manual" | null;
    };

    const autoEvent = {
      type: "session.next.compaction.started",
      properties: {
        timestamp: 1_786_311_000_000,
        sessionID: "ses_verified",
        messageID: "msg_verified",
        reason: "auto",
      },
    };
    const manualEvent = {
      ...autoEvent,
      properties: { ...autoEvent.properties, reason: "manual" },
    };

    expect(module.readCompactionReason(autoEvent)).toBe("auto");
    expect(module.readCompactionReason(manualEvent)).toBe("manual");
    expect(module.readCompactionReason({ type: "session.compacted" })).toBe(
      null,
    );
    expect(
      module.buildHandoffMessage(module.readCompactionReason(autoEvent)),
    ).toBe(
      "brigadier: this session is out of context. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review.",
    );
    expect(
      module.buildHandoffMessage(module.readCompactionReason(manualEvent)),
    ).toBe(
      "brigadier: this session is being compacted at your request. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review.",
    );
    expect(module.buildHandoffMessage(null)).toBe(
      "brigadier: this session was compacted. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review.",
    );
  });

  test("contains malformed event input and a rejected toast", async () => {
    const module = (await import(
      join(surfacesRoot, "opencode/plugin/brigadier.js")
    )) as {
      BrigadierPlugin: (input: unknown) => Promise<{
        event: (input: unknown) => Promise<void>;
      }>;
    };
    let toastAttempts = 0;
    const plugin = await module.BrigadierPlugin({
      client: {
        tui: {
          showToast: async () => {
            toastAttempts += 1;
            if (toastAttempts > 1) {
              throw new Error("toast work budget exceeded");
            }
            throw new Error("toast unavailable");
          },
        },
      },
    });

    await expect(plugin.event(null)).resolves.toBeUndefined();
    await expect(
      plugin.event({
        event: { type: "session.compacted", properties: null },
      }),
    ).resolves.toBeUndefined();
    expect(toastAttempts).toBe(1);
  });

  test("the doctrine sentence is the same on every host that can say it", async () => {
    const module = (await import(
      join(surfacesRoot, "opencode/plugin/brigadier.js")
    )) as { buildHandoffMessage: (reason: unknown) => string };
    // The opencode plugin and the handoff.mjs hook must not say different
    // things: one doctrine, whatever the seam.
    expect(module.buildHandoffMessage("auto")).toBe(
      "brigadier: this session is out of context. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review.",
    );
  });
});
