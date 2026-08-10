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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTools } from "../src/mcp/tools.ts";
import type { InstallIo, SurfaceIo } from "../src/surfaces/install.ts";
import { runInstall, sha256 } from "../src/surfaces/install.ts";
import { SURFACE_TEMPLATES } from "../src/surfaces/templates.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const surfacesRoot = join(repositoryRoot, "surfaces");

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
    sha256: "04338d25b51bfc7b89625156956ca1f779596681360c73312a3939f3127592d3",
    bytes: 3648,
  },
  "claude-code/hooks/README.md": {
    sha256: "db99e47da941e8e4a6f33e7f85222b83703be4929cb199c1ac3417184e923b25",
    bytes: 1848,
  },
  "claude-code/hooks/handoff.mjs": {
    sha256: "175458810ac053db483b653564ba985da567937c3ad77968014d0f345ffa88a9",
    bytes: 4570,
  },
  "claude-code/hooks/hooks.json": {
    sha256: "896daf07fe5d2ca91b92f51a4de35d3f713395c6cc0b6ea610d0462b6f582992",
    bytes: 236,
  },
  "claude-desktop/README.md": {
    sha256: "e429ca8a5cbba12f82bf63e7a2de20a413fb2a7cc573269219b8a9f9be5fa741",
    bytes: 2718,
  },
  "claude-desktop/manifest.json": {
    sha256: "3c59451856ffbcc451e6fa1ea31572951d95317ec1d382b7dab87b6952f03f5f",
    bytes: 1597,
  },
  "codex/AGENTS.md": {
    sha256: "feeb444d4a86eb128c6826caa228b996b59913e2459e3cc90a38fa5fc9ddbe85",
    bytes: 2869,
  },
  "codex/hooks/README.md": {
    sha256: "64cdc2af24479711b36664d89e6646e8a2b95e0d192672164ebf95d84d33a88d",
    bytes: 2099,
  },
  "codex/hooks/handoff.mjs": {
    sha256: "175458810ac053db483b653564ba985da567937c3ad77968014d0f345ffa88a9",
    bytes: 4570,
  },
  "codex/skills/brigadier/SKILL.md": {
    sha256: "04338d25b51bfc7b89625156956ca1f779596681360c73312a3939f3127592d3",
    bytes: 3648,
  },
  "opencode/README.md": {
    sha256: "b86a7ca88693a91bf255cc392d2399a29422313636f3197bf7b11a3d6a42e9ae",
    bytes: 1731,
  },
  "opencode/plugin/brigadier.js": {
    sha256: "782555e1df289d86ed570988c1f7e63e7210f85ad4c1c10a02c057b1508d68e6",
    bytes: 3395,
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

/** Only the per-file verdict lines, which is what the assertions are about. */
function verdictLines(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .filter((line) =>
      /^ {2}(created|updated|unchanged|refused|failed) /.test(line),
    );
}

describe("the surface templates", () => {
  test("the compiled templates are exactly these thirteen files", () => {
    expect(Object.keys(SURFACE_TEMPLATES).sort()).toEqual([
      "claude-code/.claude-plugin/plugin.json",
      "claude-code/SKILL.md",
      "claude-code/hooks/README.md",
      "claude-code/hooks/handoff.mjs",
      "claude-code/hooks/hooks.json",
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
    expect(files.length).toBe(14);
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
      expect(
        textBetween(
          doctrine,
          "   `id`, `title`, `prompt`, `ownedPaths`",
          "\n3. **Dry-run",
        ),
      ).toBe(
        "   `id`, `title`, `prompt`, `ownedPaths` and `difficulty` are required on every\n   slice. `difficulty` is one of `routine`, `standard`, `hard`, and it has no\n   default: a plan that does not say how hard a slice is has not been planned.\n   `dependsOn` is optional and names prerequisite slice ids. brigadier runs\n   dependency waves in order and reconciles each non-final wave before creating\n   the next wave's worktrees, so dependent slices start from their prerequisites'\n   committed output. Unknown ids, self-dependencies, and cycles are refused.\n   `requires` is optional and takes `imageInput`, `webSearch`,\n   `structuredOutput`, and `minContextWindowTokens`.",
      );
      expect(
        textBetween(doctrine, "- Do not invent commands.", "\n\n## Before"),
      ).toBe(
        '- Do not invent commands. brigadier has exactly four: `init`, `run`,\n  `install`, and `mcp`. `brigadier run "<task description>"` asks a model to\n  decompose the task, then sends the result through the same validator used for\n  `--plan`. On genuine ambiguity it exits 4 with `status: "needs_human"` and\n  structured questions; no worktree is created and no slice worker is spawned.',
      );
      expect(paragraphContaining(doctrine, "`4` needs human input")).toBe(
        "`0` succeeded · `1` never started (no config, bad plan file, missing HOME/PATH/USER)\n· `2` usage error · `3` the run started and did not succeed · `4` needs human input\n(the task was too ambiguous to plan; questions were printed and no run started) ·\n`130`/`143` interrupted.\n",
      );
    }

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
      textBetween(codexAgents, "- Invent commands.", "\n\n`brigadier init`"),
    ).toBe(
      '- Invent commands. brigadier has exactly four: `init`, `run`, `install`, and\n  `mcp`. `brigadier run "<task description>"` asks a model to decompose the task\n  and sends the result through the same validator used for `--plan`. On genuine\n  ambiguity it exits 4 with `status: "needs_human"` and structured questions; no\n  worktree is created and no slice worker is spawned.',
    );
  });

  test("the published methodology states the consented unranked-model policy", () => {
    const methodology = readFileSync(
      join(repositoryRoot, "docs/METHODOLOGY.md"),
      "utf8",
    );
    expect(paragraphContaining(methodology, "not proven to clear it")).toBe(
      "An unranked model is not proven weaker than a difficulty floor, but it is\nnot proven to clear it either. It is therefore excluded from ordinary eligibility\nand enters the same consented salvage pool as a ranked model below the floor\n([`src/routing/router.ts:733`](../src/routing/router.ts#L733) and\n[`src/routing/router.ts:747`](../src/routing/router.ts#L747)). Without\n`allowDegradedRouting`, an unranked model cannot take the slice.",
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

  test("opencode handoff status does not outrun its verification", () => {
    const index = readFileSync(join(surfacesRoot, "README.md"), "utf8");
    expect(textBetween(index, "- **opencode", "\n- **Codex")).toBe(
      "- **opencode — event binding unverified.** The plugin subscribes to the\n  session event bus, but its two event names have not been verified against a\n  running opencode build. See `opencode/plugin/brigadier.js`.",
    );

    const opencode = SURFACE_TEMPLATES["opencode/README.md"] ?? "";
    expect(paragraphContaining(opencode, "**Status:")).toBe(
      "**Status: plugin installs; handoff event names are unverified.**",
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
        `  created    ${home}/.claude/skills/brigadier/hooks/README.md`,
        `  created    ${home}/.agents/skills/brigadier/SKILL.md`,
        `  created    ${home}/.agents/skills/brigadier/hooks/handoff.mjs`,
        `  created    ${home}/.agents/skills/brigadier/hooks/README.md`,
        `  created    ${home}/.codex/AGENTS.md`,
        `  created    ${home}/.config/opencode/plugin/brigadier.js`,
        `  created    ${home}/.config/opencode/brigadier.README.md`,
        `  created    ${home}/.brigadier/surfaces/claude-desktop/manifest.json`,
        `  created    ${home}/.brigadier/surfaces/claude-desktop/README.md`,
      ]);
      expect(
        result.stdout.endsWith(
          "\ndry run: 13 written, 0 unchanged, 0 refused.\n",
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
      // Codex: trust-gated, and the click comes back on every edit.
      expect(
        notes.some((note) =>
          note.includes(
            "THE HANDOFF HOOK IS TRUST-GATED ON CODEX. Running it is a click, and the click is required again after every edit, because Codex hashes the hook definition.",
          ),
        ),
      ).toBe(true);
      // opencode: works, and the unverified line is named as unverified.
      expect(
        notes.some((note) =>
          note.includes(
            "Those names were NOT verified against a running opencode",
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
          note.includes("NOTHING WAS INSTALLED INTO CLAUDE DESKTOP."),
        ),
      ).toBe(true);
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
        result.stdout.endsWith("\n5 written, 0 unchanged, 0 refused.\n"),
      ).toBe(true);

      const skill = join(home, ".claude/skills/brigadier");
      expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe(
        SURFACE_TEMPLATES["claude-code/SKILL.md"] ?? "",
      );
      expect(hashOf(await readFile(join(skill, "SKILL.md"), "utf8"))).toBe(
        "04338d25b51bfc7b89625156956ca1f779596681360c73312a3939f3127592d3",
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
      ]);
      expect(manifest.files[`${skill}/SKILL.md`]).toBe(
        "04338d25b51bfc7b89625156956ca1f779596681360c73312a3939f3127592d3",
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
        `  unchanged  ${home}/.claude/skills/brigadier/hooks/README.md`,
      ]);
      expect(
        second.stdout.endsWith("\n0 written, 5 unchanged, 0 refused.\n"),
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
        second.stdout.endsWith("\n0 written, 4 unchanged, 1 refused.\n"),
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
        `  created    ${home}/elsewhere/claude/skills/brigadier/hooks/README.md`,
        `  created    ${home}/.agents/skills/brigadier/SKILL.md`,
        `  created    ${home}/.agents/skills/brigadier/hooks/handoff.mjs`,
        `  created    ${home}/.agents/skills/brigadier/hooks/README.md`,
        `  created    ${home}/elsewhere/codex/AGENTS.md`,
        `  created    ${home}/elsewhere/xdg/opencode/plugin/brigadier.js`,
        `  created    ${home}/elsewhere/xdg/opencode/brigadier.README.md`,
        `  created    ${home}/elsewhere/brigadier/surfaces/claude-desktop/manifest.json`,
        `  created    ${home}/elsewhere/brigadier/surfaces/claude-desktop/README.md`,
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

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
        'brigadier install: unknown host "emacs"; known hosts are claude-code, codex, opencode, claude-desktop',
      );

      const none = await install([], { HOME: home });
      expect(none.code).toBe(2);
      expect(none.stderr.split("\n")[0]).toBe(
        "brigadier install: name at least one host, or pass --all; known hosts are claude-code, codex, opencode, claude-desktop",
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
      expect(verdictLines(result.stdout).length).toBe(5);
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
    const stdout = new Response(proc.stdout).text();
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

describe("the opencode plugin", () => {
  test("fires on exactly the two named events and on nothing else", async () => {
    const module = (await import(
      join(surfacesRoot, "opencode/plugin/brigadier.js")
    )) as {
      HANDOFF_EVENT_TYPES: readonly string[];
      isHandoffEvent: (event: unknown) => boolean;
      buildHandoffMessage: (turns: unknown) => string;
      readTurnCount: (event: unknown) => number | null;
    };

    expect(module.HANDOFF_EVENT_TYPES).toEqual([
      "session.compacted",
      "session.compacting",
    ]);
    expect(module.isHandoffEvent({ type: "session.compacted" })).toBe(true);
    expect(module.isHandoffEvent({ type: "session.compacting" })).toBe(true);
    expect(module.isHandoffEvent({ type: "session.idle" })).toBe(false);
    expect(module.isHandoffEvent({ type: "message.updated" })).toBe(false);
    expect(module.isHandoffEvent(null)).toBe(false);
    expect(module.isHandoffEvent("session.compacted")).toBe(false);

    expect(module.buildHandoffMessage(12)).toBe(
      "brigadier: this session is out of context after 12 assistant turn(s). Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review.",
    );
    expect(module.buildHandoffMessage(null)).toBe(
      "brigadier: this session is out of context. Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review.",
    );
    expect(module.buildHandoffMessage(1.5)).toBe(
      module.buildHandoffMessage(null),
    );

    expect(module.readTurnCount({ properties: { messageCount: 9 } })).toBe(9);
    expect(module.readTurnCount({ properties: { turns: 4 } })).toBe(4);
    expect(module.readTurnCount({ properties: {} })).toBe(null);
    expect(module.readTurnCount({})).toBe(null);
  });

  test("the doctrine sentence is the same on every host that can say it", async () => {
    const module = (await import(
      join(surfacesRoot, "opencode/plugin/brigadier.js")
    )) as { buildHandoffMessage: (turns: unknown) => string };
    // The opencode plugin and the handoff.mjs hook must not say different
    // things: one doctrine, whatever the seam.
    expect(module.buildHandoffMessage(3)).toBe(
      "brigadier: this session is out of context after 3 assistant turn(s). Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review.",
    );
  });
});
