/**
 * `brigadier install <host>`: write the doctrine into each host's own slot.
 *
 * brigadier is one engine. Every host is configured to hand work TO it rather
 * than to do the work itself, and the host-side artifact is deliberately tiny —
 * its whole message is *you are not the worker*. This command puts that artifact
 * where each host will read it, and then gets out of the way. It is not a
 * package manager, it installs no plugin runtime, and it depends on none: the
 * shipped product spawns `claude` and `codex` as plain subprocesses.
 *
 * TWO PROPERTIES THIS COMMAND OWES THE USER, and they pull against each other:
 *
 *   IDEMPOTENT. Running it twice must do nothing the second time. Re-running
 *   after an upgrade must quietly move the user to the new templates.
 *
 *   NEVER SILENTLY OVERWRITES AN EDIT. A user who tuned the doctrine wording for
 *   their team must not lose it to a `brigadier install` in a setup script.
 *
 * Content comparison alone cannot satisfy both. "Differs from the template"
 * covers *the user edited it* and *brigadier shipped a new version* equally
 * well, and guessing wrong loses somebody's work in the first case or freezes
 * them on stale doctrine in the second. So a manifest at
 * `$BRIGADIER_HOME/surfaces.json` records the SHA-256 of what brigadier last
 * wrote to each path. A file matching its recorded hash is one brigadier wrote
 * and nobody touched: safe to replace. A file matching nothing is somebody's
 * work: refused, named, and left exactly as it is, with `--force` spelled out as
 * the way to say otherwise.
 *
 * The io and the environment are injected, in the style of `src/init/index.ts`,
 * so the whole command runs against a scratch `HOME` with nothing real on disk.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigEnvironment } from "../config/store.js";
import { resolveConfigHome } from "../config/store.js";
import type { OutputStream } from "../init/prompt.js";
import { SURFACE_TEMPLATES } from "./templates.js";

/** Every host brigadier knows how to install into, in the order `--all` walks. */
export const SURFACE_HOSTS = [
  "claude-code",
  "codex",
  "opencode",
  "claude-desktop",
] as const;

export type SurfaceHost = (typeof SURFACE_HOSTS)[number];

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;

/** Bumped only if the manifest's shape changes; an unknown version is ignored. */
const MANIFEST_VERSION = 1;
const MANIFEST_FILE_NAME = "surfaces.json";

/**
 * The filesystem operations the installer needs.
 *
 * Deliberately NOT `ConfigIo`: that port's `writeFile` opens with `wx` and fails
 * when the target exists, which is exactly right for an atomic config write and
 * exactly wrong here, where replacing a file brigadier itself wrote is the
 * normal upgrade path. The decision about whether a replacement is allowed is
 * made above this port, by the manifest, and never by an open flag.
 */
export interface SurfaceIo {
  mkdir(path: string): Promise<void>;
  /** Rejects with an ENOENT-coded error when the file does not exist. */
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string, mode: number): Promise<void>;
}

export const nodeSurfaceIo: SurfaceIo = {
  async mkdir(path) {
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  },
  readFile(path) {
    return readFile(path, "utf8");
  },
  async writeFile(path, contents, mode) {
    await writeFile(path, contents, { encoding: "utf8", mode });
    // `writeFile`'s mode applies only when it creates the file, so an existing
    // hook that lost its executable bit would silently stay unexecutable.
    await chmod(path, mode);
  },
};

export interface InstallIo {
  readonly env: ConfigEnvironment;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly fs?: SurfaceIo;
}

/* ------------------------------------------------------------------------ */
/* Where each file goes                                                      */
/* ------------------------------------------------------------------------ */

/**
 * The directories a placement can be anchored to. Every one is derived from the
 * injected environment and never from the OS home helpers — the same seam
 * `resolveConfigHome` uses, and for the same reason: writing into a real home
 * must be impossible unless a caller passed a real `HOME`.
 */
interface Roots {
  /** `$CLAUDE_CONFIG_DIR`, else `$HOME/.claude`. */
  readonly claudeConfig: string;
  /** `$HOME/.agents/skills`, read by both Codex and opencode. */
  readonly agentsSkills: string;
  /** `$XDG_CONFIG_HOME/opencode`, else `$HOME/.config/opencode`. */
  readonly opencodeConfig: string;
  /** `$CODEX_HOME`, else `$HOME/.codex`. */
  readonly codexHome: string;
  /** `$BRIGADIER_HOME`, else `$HOME/.brigadier`. */
  readonly brigadierHome: string;
}

interface Placement {
  /** A key into `SURFACE_TEMPLATES`, which is a repo-relative surfaces path. */
  readonly template: string;
  readonly destination: (roots: Roots) => string;
  readonly executable?: true;
}

interface HostPlan {
  readonly host: SurfaceHost;
  readonly placements: readonly Placement[];
  /** Printed after the file list. The honest limitations live here. */
  readonly notes: (roots: Roots) => readonly string[];
}

const CLAUDE_SKILL = (roots: Roots): string =>
  join(roots.claudeConfig, "skills", "brigadier");
const AGENTS_SKILL = (roots: Roots): string =>
  join(roots.agentsSkills, "brigadier");
const DESKTOP_BUNDLE = (roots: Roots): string =>
  join(roots.brigadierHome, "surfaces", "claude-desktop");

const HOST_PLANS: readonly HostPlan[] = [
  {
    host: "claude-code",
    placements: [
      {
        template: "claude-code/SKILL.md",
        destination: (roots) => join(CLAUDE_SKILL(roots), "SKILL.md"),
      },
      {
        template: "claude-code/.claude-plugin/plugin.json",
        destination: (roots) =>
          join(CLAUDE_SKILL(roots), ".claude-plugin", "plugin.json"),
      },
      {
        template: "claude-code/hooks/hooks.json",
        destination: (roots) =>
          join(CLAUDE_SKILL(roots), "hooks", "hooks.json"),
      },
      {
        template: "claude-code/hooks/handoff.mjs",
        destination: (roots) =>
          join(CLAUDE_SKILL(roots), "hooks", "handoff.mjs"),
        executable: true,
      },
      {
        template: "claude-code/hooks/README.md",
        destination: (roots) => join(CLAUDE_SKILL(roots), "hooks", "README.md"),
      },
    ],
    notes: (roots) => [
      `The skill auto-loads as the plugin \`brigadier@skills-dir\` in your next Claude Code session, because of the .claude-plugin/plugin.json beside it. No marketplace, and no consent dialog.`,
      `The handoff hook is registered against PreCompact in ${join(CLAUDE_SKILL(roots), "hooks", "hooks.json")} and needs no approval on this host.`,
    ],
  },
  {
    host: "codex",
    placements: [
      {
        template: "codex/skills/brigadier/SKILL.md",
        destination: (roots) => join(AGENTS_SKILL(roots), "SKILL.md"),
      },
      {
        template: "codex/hooks/handoff.mjs",
        destination: (roots) =>
          join(AGENTS_SKILL(roots), "hooks", "handoff.mjs"),
        executable: true,
      },
      {
        template: "codex/hooks/README.md",
        destination: (roots) => join(AGENTS_SKILL(roots), "hooks", "README.md"),
      },
      {
        template: "codex/AGENTS.md",
        destination: (roots) => join(roots.codexHome, "AGENTS.md"),
      },
    ],
    notes: (roots) => [
      `~/.agents/skills is read by both Codex and opencode, so this one skill serves both.`,
      `THE HANDOFF HOOK IS TRUST-GATED ON CODEX. Running it is a click, and the click is required again after every edit, because Codex hashes the hook definition. brigadier does NOT write a Codex hook registration: the configuration key differs across Codex releases and a guessed one is a silent no-op. Register it yourself against ${join(AGENTS_SKILL(roots), "hooks", "handoff.mjs")} — see the README next to it.`,
      `${join(roots.codexHome, "AGENTS.md")} is loaded by Codex 0.145.0 into every session including brigadier's own workers, and no flag suppresses it. Keep it doctrine.`,
    ],
  },
  {
    host: "opencode",
    placements: [
      {
        template: "opencode/plugin/brigadier.js",
        destination: (roots) =>
          join(roots.opencodeConfig, "plugin", "brigadier.js"),
      },
      {
        template: "opencode/README.md",
        destination: (roots) =>
          join(roots.opencodeConfig, "brigadier.README.md"),
      },
    ],
    notes: () => [
      `opencode reads ~/.claude/skills and ~/.agents/skills natively, so \`brigadier install claude-code\` or \`brigadier install codex\` already gave it the doctrine. This plugin adds the one thing a skill cannot be: the handoff hook.`,
      `The plugin reacts to the bus events named in HANDOFF_EVENT_TYPES. Those names were NOT verified against a running opencode; if the hook never fires, that array is the one line to change.`,
    ],
  },
  {
    host: "claude-desktop",
    placements: [
      {
        template: "claude-desktop/manifest.json",
        destination: (roots) => join(DESKTOP_BUNDLE(roots), "manifest.json"),
      },
      {
        template: "claude-desktop/README.md",
        destination: (roots) => join(DESKTOP_BUNDLE(roots), "README.md"),
      },
    ],
    notes: (roots) => [
      `NOTHING WAS INSTALLED INTO CLAUDE DESKTOP. Desktop installs a bundle by an explicit user action and brigadier does not forge those; the bundle was staged at ${DESKTOP_BUNDLE(roots)}.`,
      `To finish: run \`bun run build:mcp\` to emit server/brigadier-mcp.js beside the manifest, zip that directory with manifest.json at the archive root, rename it brigadier.mcpb, and open it with Desktop.`,
      `Desktop gets an MCP server rather than a skill because Desktop Skills execute server-side and cannot invoke a local binary, while Desktop MCP servers run locally with your full privileges and can spawn \`claude -p\`.`,
      `THE HANDOFF HOOK IS IMPOSSIBLE ON CLAUDE DESKTOP. It exposes no hook surface, and an MCP server is called by the model rather than by the transcript. There is no workaround.`,
    ],
  },
];

/* ------------------------------------------------------------------------ */
/* The command                                                               */
/* ------------------------------------------------------------------------ */

const USAGE = `Usage: brigadier install <host>... [options]

Hosts:
  claude-code      a skill at ~/.claude/skills/brigadier, auto-loading as a plugin
  codex            a skill at ~/.agents/skills/brigadier, plus $CODEX_HOME/AGENTS.md
  opencode         a plugin at ~/.config/opencode/plugin/brigadier.js
  claude-desktop   an MCP bundle staged at ~/.brigadier/surfaces/claude-desktop

Options:
      --all        install every host above
      --dry-run    report what would be written and write nothing
      --force      replace a file that brigadier did not write, or that was
                   edited after brigadier wrote it
  -h, --help       print this message

Exit codes:
  0  every file is in place
  1  at least one file was refused or could not be written
  2  usage error
`;

type Verdict = "created" | "updated" | "unchanged" | "refused" | "failed";

interface FileOutcome {
  readonly verdict: Verdict;
  readonly path: string;
  /** Present for `refused` and `failed`; the sentence that says what to do. */
  readonly detail: string | null;
}

/**
 * Runs `brigadier install` and resolves the process exit code.
 *
 * `argv` has the `install` command word already removed, matching how
 * `src/init/index.ts` hands `run`'s argv to `runPlan`.
 */
export async function runInstall(
  argv: readonly string[],
  io: InstallIo,
): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed.kind === "help") {
    io.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === "usage-error") {
    io.stderr.write(`${parsed.message}\n`);
    io.stderr.write(USAGE);
    return 2;
  }

  let roots: Roots;
  try {
    roots = resolveRoots(io.env);
  } catch (error) {
    io.stderr.write(`brigadier install: ${describe(error)}\n`);
    return 1;
  }

  const fs = io.fs ?? nodeSurfaceIo;
  const manifestPath = join(roots.brigadierHome, MANIFEST_FILE_NAME);
  const recorded = await readManifest(fs, manifestPath);
  const written = new Map(recorded);

  let refused = 0;
  let changed = 0;
  let unchanged = 0;

  for (const host of parsed.hosts) {
    const plan = HOST_PLANS.find((candidate) => candidate.host === host);
    if (plan === undefined) {
      // Unreachable: `parseArguments` only yields members of SURFACE_HOSTS.
      continue;
    }
    io.stdout.write(`\nbrigadier install ${host}\n\n`);
    for (const placement of plan.placements) {
      const outcome = await applyPlacement({
        fs,
        placement,
        roots,
        recorded,
        written,
        force: parsed.force,
        dryRun: parsed.dryRun,
      });
      writeOutcome(io.stdout, outcome);
      if (outcome.verdict === "refused" || outcome.verdict === "failed") {
        refused += 1;
      } else if (outcome.verdict === "unchanged") {
        unchanged += 1;
      } else {
        changed += 1;
      }
    }
    io.stdout.write("\n");
    for (const note of plan.notes(roots)) {
      io.stdout.write(`  note: ${note}\n`);
    }
  }

  if (!parsed.dryRun) {
    try {
      await writeManifest(fs, manifestPath, written);
    } catch (error) {
      io.stderr.write(
        `brigadier install: could not record what was written to ${manifestPath}: ${describe(error)}. The files are in place, but the next install will refuse to replace them.\n`,
      );
      refused += 1;
    }
  }

  io.stdout.write(
    `\n${parsed.dryRun ? "dry run: " : ""}${changed} written, ${unchanged} unchanged, ${refused} refused.\n`,
  );
  return refused > 0 ? 1 : 0;
}

interface ApplyInput {
  readonly fs: SurfaceIo;
  readonly placement: Placement;
  readonly roots: Roots;
  readonly recorded: ReadonlyMap<string, string>;
  readonly written: Map<string, string>;
  readonly force: boolean;
  readonly dryRun: boolean;
}

async function applyPlacement(input: ApplyInput): Promise<FileOutcome> {
  const destination = input.placement.destination(input.roots);
  const contents = SURFACE_TEMPLATES[input.placement.template];
  if (contents === undefined) {
    // Unreachable while `test/surfaces.test.ts` passes: it proves every
    // placement names a template that exists.
    return {
      verdict: "failed",
      path: destination,
      detail: `no template named ${JSON.stringify(input.placement.template)} is compiled into this binary`,
    };
  }
  const mode =
    input.placement.executable === true ? EXECUTABLE_MODE : FILE_MODE;
  const desiredHash = sha256(contents);

  const existing = await readIfPresent(input.fs, destination);
  if (existing !== null && existing === contents) {
    input.written.set(destination, desiredHash);
    return { verdict: "unchanged", path: destination, detail: null };
  }
  if (existing !== null && !input.force) {
    const recordedHash = input.recorded.get(destination);
    if (recordedHash === undefined || recordedHash !== sha256(existing)) {
      return {
        verdict: "refused",
        path: destination,
        detail:
          recordedHash === undefined
            ? "brigadier has no record of writing this file, so it belongs to something else. Re-run with --force to replace it."
            : "this file was edited after brigadier wrote it. Re-run with --force to discard those edits.",
      };
    }
  }

  const verdict: Verdict = existing === null ? "created" : "updated";
  if (input.dryRun) {
    return { verdict, path: destination, detail: null };
  }
  try {
    await input.fs.mkdir(parentOf(destination));
    await input.fs.writeFile(destination, contents, mode);
  } catch (error) {
    return { verdict: "failed", path: destination, detail: describe(error) };
  }
  input.written.set(destination, desiredHash);
  return { verdict, path: destination, detail: null };
}

function writeOutcome(stdout: OutputStream, outcome: FileOutcome): void {
  stdout.write(`  ${outcome.verdict.padEnd(9)}  ${outcome.path}\n`);
  if (outcome.detail !== null) {
    stdout.write(`             ${outcome.detail}\n`);
  }
}

/* ------------------------------------------------------------------------ */
/* The manifest                                                              */
/* ------------------------------------------------------------------------ */

/**
 * An unreadable or unrecognizable manifest is treated as empty, which fails in
 * the safe direction: with no record, every pre-existing file is refused rather
 * than replaced.
 */
async function readManifest(
  fs: SurfaceIo,
  path: string,
): Promise<ReadonlyMap<string, string>> {
  const contents = await readIfPresent(fs, path);
  if (contents === null) {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return new Map();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new Map();
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== MANIFEST_VERSION) {
    return new Map();
  }
  const files = record.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return new Map();
  }
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(files as Record<string, unknown>)) {
    if (typeof value === "string") {
      entries.set(key, value);
    }
  }
  return entries;
}

/** Sorted keys, so two installs of the same set produce identical bytes. */
async function writeManifest(
  fs: SurfaceIo,
  path: string,
  written: ReadonlyMap<string, string>,
): Promise<void> {
  const files: Record<string, string> = {};
  for (const key of [...written.keys()].sort()) {
    const value = written.get(key);
    if (value !== undefined) {
      files[key] = value;
    }
  }
  await fs.mkdir(parentOf(path));
  await fs.writeFile(
    path,
    `${JSON.stringify({ version: MANIFEST_VERSION, files }, null, 2)}\n`,
    0o600,
  );
}

/* ------------------------------------------------------------------------ */
/* Arguments and environment                                                 */
/* ------------------------------------------------------------------------ */

type Arguments =
  | {
      readonly kind: "install";
      readonly hosts: readonly SurfaceHost[];
      readonly dryRun: boolean;
      readonly force: boolean;
    }
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly message: string };

/** Pure and total: every path returns a member rather than throwing. */
export function parseArguments(argv: readonly string[]): Arguments {
  const hosts: SurfaceHost[] = [];
  let all = false;
  let dryRun = false;
  let force = false;

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      return { kind: "help" };
    }
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument.startsWith("-")) {
      return {
        kind: "usage-error",
        message: `brigadier install: unknown option ${JSON.stringify(argument)}`,
      };
    }
    if (!isHost(argument)) {
      return {
        kind: "usage-error",
        message: `brigadier install: unknown host ${JSON.stringify(argument)}; known hosts are ${SURFACE_HOSTS.join(", ")}`,
      };
    }
    if (!hosts.includes(argument)) {
      hosts.push(argument);
    }
  }

  if (all) {
    return { kind: "install", hosts: SURFACE_HOSTS, dryRun, force };
  }
  if (hosts.length === 0) {
    return {
      kind: "usage-error",
      message: `brigadier install: name at least one host, or pass --all; known hosts are ${SURFACE_HOSTS.join(", ")}`,
    };
  }
  return { kind: "install", hosts, dryRun, force };
}

function isHost(value: string): value is SurfaceHost {
  return (SURFACE_HOSTS as readonly string[]).includes(value);
}

/**
 * Throws when `$HOME` is unset and no override supplies a root, which is the
 * same refusal `resolveConfigHome` makes and for the same reason: guessing a
 * home directory is how an installer writes into `/`.
 */
export function resolveRoots(env: ConfigEnvironment): Roots {
  const brigadierHome = resolveConfigHome(env);
  const home = env.HOME?.trim() ?? "";
  const claudeConfig = trimmed(env.CLAUDE_CONFIG_DIR);
  const codexHome = trimmed(env.CODEX_HOME);
  const xdgConfig = trimmed(env.XDG_CONFIG_HOME);

  const needsHome =
    claudeConfig === null || codexHome === null || xdgConfig === null;
  if (needsHome && home.length === 0) {
    throw new Error(
      "cannot resolve the host configuration directories: set $HOME, or set every one of $CLAUDE_CONFIG_DIR, $CODEX_HOME, and $XDG_CONFIG_HOME",
    );
  }

  return {
    claudeConfig: claudeConfig ?? join(home, ".claude"),
    agentsSkills: join(home, ".agents", "skills"),
    opencodeConfig:
      xdgConfig === null
        ? join(home, ".config", "opencode")
        : join(xdgConfig, "opencode"),
    codexHome: codexHome ?? join(home, ".codex"),
    brigadierHome,
  };
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/* ------------------------------------------------------------------------ */
/* Small shared pieces                                                       */
/* ------------------------------------------------------------------------ */

async function readIfPresent(
  fs: SurfaceIo,
  path: string,
): Promise<string | null> {
  try {
    return await fs.readFile(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

export function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/**
 * The parent directory, by string surgery rather than `path.dirname`, for
 * uniformity with the rest of this file's absolute-path handling. Every path it
 * sees was built by `join` from a resolved root, so it always contains a
 * separator.
 */
function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { Roots };
