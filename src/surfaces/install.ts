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
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath } from "node:fs/promises";
import { basename, dirname, relative, sep } from "node:path";
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
const CODEX_HOOK_MARKER = "# brigadier-managed-hook";
const CODEX_HOOKS_FILE_NAME = "hooks.json";

/**
 * The filesystem operations the installer needs.
 *
 * Deliberately NOT `ConfigIo`: that port's `writeFile` opens with `wx` and fails
 * when the target exists, which is exactly right for an atomic config write and
 * exactly wrong here, where replacing a file brigadier itself wrote is the
 * normal upgrade path. This port instead opens with O_NOFOLLOW and checks the
 * inspected file's identity on the same descriptor it later mutates.
 */
export interface SurfaceIo {
  mkdir(path: string): Promise<void>;
  /** Rejects with an ENOENT-coded error when the file does not exist. */
  readFile(path: string): Promise<SurfaceSnapshot>;
  writeFile(
    path: string,
    contents: string,
    mode: number,
    expected: SurfaceSnapshot | null,
  ): Promise<void>;
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink(path: string): Promise<string>;
}

export interface SurfaceSnapshot {
  readonly contents: string;
  /** Opaque identity used only to prove the writer opened the inspected file. */
  readonly identity: string;
}

export const nodeSurfaceIo: SurfaceIo = {
  async mkdir(path) {
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  },
  async readFile(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = await handle.stat();
      return {
        contents: await handle.readFile("utf8"),
        identity: fileIdentity(entry.dev, entry.ino),
      };
    } finally {
      await handle.close();
    }
  },
  async writeFile(path, contents, mode, expected) {
    const flags =
      expected === null
        ? constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW
        : constants.O_RDWR | constants.O_NOFOLLOW;
    const handle = await open(path, flags, mode);
    try {
      if (expected !== null) {
        const entry = await handle.stat();
        const identity = fileIdentity(entry.dev, entry.ino);
        const current = await handle.readFile("utf8");
        if (identity !== expected.identity || current !== expected.contents) {
          throw new Error(
            `refusing to replace ${path}: it changed after brigadier inspected it`,
          );
        }
      }

      const bytes = Buffer.from(contents, "utf8");
      await handle.truncate(0);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (bytesWritten === 0) {
          throw new Error(`could not finish writing ${path}`);
        }
        offset += bytesWritten;
      }
      await handle.truncate(bytes.byteLength);
      // Descriptor chmod cannot be redirected if the pathname is swapped.
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  },
  realpath(path) {
    return realpath(path);
  },
  lstat(path) {
    return lstat(path);
  },
  readlink(path) {
    return readlink(path);
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
  /** The directory outside which this placement must never write. */
  readonly root: (roots: Roots) => string;
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
  appendPath(roots.claudeConfig, "skills", "brigadier");
const AGENTS_SKILL = (roots: Roots): string =>
  appendPath(roots.agentsSkills, "brigadier");
const DESKTOP_BUNDLE = (roots: Roots): string =>
  appendPath(roots.brigadierHome, "surfaces", "claude-desktop");

const HOST_PLANS: readonly HostPlan[] = [
  {
    host: "claude-code",
    placements: [
      {
        template: "claude-code/SKILL.md",
        root: (roots) => roots.claudeConfig,
        destination: (roots) => appendPath(CLAUDE_SKILL(roots), "SKILL.md"),
      },
      {
        template: "claude-code/.claude-plugin/plugin.json",
        root: (roots) => roots.claudeConfig,
        destination: (roots) =>
          appendPath(CLAUDE_SKILL(roots), ".claude-plugin", "plugin.json"),
      },
      {
        template: "claude-code/hooks/hooks.json",
        root: (roots) => roots.claudeConfig,
        destination: (roots) =>
          appendPath(CLAUDE_SKILL(roots), "hooks", "hooks.json"),
      },
      {
        template: "claude-code/hooks/handoff.mjs",
        root: (roots) => roots.claudeConfig,
        destination: (roots) =>
          appendPath(CLAUDE_SKILL(roots), "hooks", "handoff.mjs"),
        executable: true,
      },
      {
        template: "claude-code/hooks/README.md",
        root: (roots) => roots.claudeConfig,
        destination: (roots) =>
          appendPath(CLAUDE_SKILL(roots), "hooks", "README.md"),
      },
    ],
    notes: (roots) => [
      `The skill auto-loads as the plugin \`brigadier@skills-dir\` in your next Claude Code session, because of the .claude-plugin/plugin.json beside it. No marketplace, and no consent dialog.`,
      `The handoff hook is registered against PreCompact in ${appendPath(CLAUDE_SKILL(roots), "hooks", "hooks.json")} and needs no approval on this host.`,
    ],
  },
  {
    host: "codex",
    placements: [
      {
        template: "codex/skills/brigadier/SKILL.md",
        root: (roots) => roots.agentsSkills,
        destination: (roots) => appendPath(AGENTS_SKILL(roots), "SKILL.md"),
      },
      {
        template: "codex/hooks/handoff.mjs",
        root: (roots) => roots.agentsSkills,
        destination: (roots) =>
          appendPath(AGENTS_SKILL(roots), "hooks", "handoff.mjs"),
        executable: true,
      },
      {
        template: "codex/hooks/README.md",
        root: (roots) => roots.agentsSkills,
        destination: (roots) =>
          appendPath(AGENTS_SKILL(roots), "hooks", "README.md"),
      },
      {
        template: "codex/AGENTS.md",
        root: (roots) => roots.codexHome,
        destination: (roots) => appendPath(roots.codexHome, "AGENTS.md"),
      },
    ],
    notes: (roots) => [
      `~/.agents/skills is read by both Codex and opencode, so this one skill serves both.`,
      `THE HANDOFF HOOK IS REGISTERED AGAINST PreCompact IN ${appendPath(roots.codexHome, CODEX_HOOKS_FILE_NAME)}, BUT IT WILL NOT RUN UNTIL YOU APPROVE IT IN CODEX. Approval is bound to a hash of the hook definition, so it is required again after any edit to handoff.mjs. Claude Code needs no approval for the same hook; that asymmetry is deliberate on Codex's part, and brigadier neither works around it nor hides it.`,
      `${appendPath(roots.codexHome, "AGENTS.md")} is loaded by Codex 0.145.0 into every session including brigadier's own workers, and no flag suppresses it. Keep it doctrine.`,
    ],
  },
  {
    host: "opencode",
    placements: [
      {
        template: "opencode/plugin/brigadier.js",
        root: (roots) => roots.opencodeConfig,
        destination: (roots) =>
          appendPath(roots.opencodeConfig, "plugin", "brigadier.js"),
      },
      {
        template: "opencode/README.md",
        root: (roots) => roots.opencodeConfig,
        destination: (roots) =>
          appendPath(roots.opencodeConfig, "brigadier.README.md"),
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
        root: (roots) => roots.brigadierHome,
        destination: (roots) =>
          appendPath(DESKTOP_BUNDLE(roots), "manifest.json"),
      },
      {
        template: "claude-desktop/README.md",
        root: (roots) => roots.brigadierHome,
        destination: (roots) => appendPath(DESKTOP_BUNDLE(roots), "README.md"),
      },
    ],
    notes: (roots) => [
      `NOTHING WAS INSTALLED INTO CLAUDE DESKTOP. Desktop installs a bundle by an explicit user action and brigadier does not forge those; the bundle was staged at ${DESKTOP_BUNDLE(roots)}.`,
      `To finish: run \`bun run build:mcp\` to emit dist/mcp/server.js, copy it to server/brigadier-mcp.js beside the manifest, zip that directory with manifest.json at the archive root, rename it brigadier.mcpb, and open it with Desktop.`,
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
  const manifestPath = appendPath(roots.brigadierHome, MANIFEST_FILE_NAME);
  let manifest: ManifestRead;
  try {
    const proof = await proveWriteContained(
      fs,
      roots.brigadierHome,
      manifestPath,
    );
    if (!proof.ok) {
      throw new Error(proof.message);
    }
    manifest = await readManifest(fs, manifestPath);
  } catch (error) {
    const proof = await proveWriteContained(
      fs,
      roots.brigadierHome,
      manifestPath,
    );
    io.stderr.write(
      `brigadier install: could not safely read ${manifestPath}: ${proof.ok ? describe(error) : proof.message}\n`,
    );
    return 1;
  }
  const recorded = manifest.files;
  const written = new Map(recorded);

  let codexHook: CodexHookPreparation | null = null;
  if (parsed.hosts.includes("codex")) {
    const prepared = await prepareCodexHookRegistration(fs, roots);
    if (!prepared.ok) {
      io.stderr.write(`brigadier install: ${prepared.message}\n`);
      return 1;
    }
    codexHook = prepared;
  }

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
    if (host === "codex" && codexHook !== null) {
      const outcome = await applyCodexHookRegistration(
        fs,
        roots,
        codexHook,
        parsed.dryRun,
      );
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
      await writeManifest(
        fs,
        roots.brigadierHome,
        manifestPath,
        written,
        manifest.snapshot,
      );
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

interface CodexHookPreparation {
  readonly ok: true;
  readonly path: string;
  readonly snapshot: SurfaceSnapshot | null;
  readonly contents: string;
  readonly verdict: "created" | "updated" | "unchanged";
}

interface CodexHookPreparationError {
  readonly ok: false;
  readonly message: string;
}

async function prepareCodexHookRegistration(
  fs: SurfaceIo,
  roots: Roots,
): Promise<CodexHookPreparation | CodexHookPreparationError> {
  const path = appendPath(roots.codexHome, CODEX_HOOKS_FILE_NAME);
  const proof = await proveWriteContained(fs, roots.codexHome, path);
  if (!proof.ok) {
    return { ok: false, message: proof.message };
  }

  let snapshot: SurfaceSnapshot | null;
  try {
    snapshot = await readIfPresent(fs, path);
  } catch (error) {
    return {
      ok: false,
      message: `could not safely read ${path}: ${describe(error)}`,
    };
  }

  const command = `${shellQuote(
    appendPath(AGENTS_SKILL(roots), "hooks", "handoff.mjs"),
  )} ${CODEX_HOOK_MARKER}`;
  if (snapshot === null) {
    return {
      ok: true,
      path,
      snapshot,
      contents: formatCodexHooks({
        hooks: { PreCompact: [codexHook(command)] },
      }),
      verdict: "created",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.contents);
  } catch {
    return {
      ok: false,
      message: `could not parse ${path}. Fix the malformed JSON and re-run; brigadier left the file unchanged.`,
    };
  }
  const merged = mergeCodexHook(snapshot.contents, parsed, command, path);
  if (!merged.ok) {
    return merged;
  }
  const contents = merged.contents;
  return {
    ok: true,
    path,
    snapshot,
    contents,
    verdict: contents === snapshot.contents ? "unchanged" : "updated",
  };
}

async function applyCodexHookRegistration(
  fs: SurfaceIo,
  roots: Roots,
  prepared: CodexHookPreparation,
  dryRun: boolean,
): Promise<FileOutcome> {
  if (prepared.verdict === "unchanged" || dryRun) {
    return {
      verdict: prepared.verdict,
      path: prepared.path,
      detail: null,
    };
  }
  try {
    await fs.mkdir(parentOf(prepared.path));
    const proof = await proveWriteContained(fs, roots.codexHome, prepared.path);
    if (!proof.ok) {
      return { verdict: "refused", path: prepared.path, detail: proof.message };
    }
    await fs.writeFile(
      prepared.path,
      prepared.contents,
      FILE_MODE,
      prepared.snapshot,
    );
    return { verdict: prepared.verdict, path: prepared.path, detail: null };
  } catch (error) {
    const proof = await proveWriteContained(fs, roots.codexHome, prepared.path);
    return proof.ok
      ? { verdict: "failed", path: prepared.path, detail: describe(error) }
      : { verdict: "refused", path: prepared.path, detail: proof.message };
  }
}

function mergeCodexHook(
  source: string,
  parsed: unknown,
  command: string,
  path: string,
):
  | { readonly ok: true; readonly contents: string }
  | CodexHookPreparationError {
  if (!isJsonObject(parsed)) {
    return {
      ok: false,
      message: `could not merge ${path}: its top level must be a JSON object. Fix the file and re-run; brigadier left it unchanged.`,
    };
  }
  const root = parsed;
  const hooksValue = root.hooks;
  if (hooksValue !== undefined && !isJsonObject(hooksValue)) {
    return {
      ok: false,
      message: `could not merge ${path}: "hooks" must be a JSON object. Fix the file and re-run; brigadier left it unchanged.`,
    };
  }
  const hooks = hooksValue ?? {};
  const preCompactValue = hooks.PreCompact;
  if (preCompactValue !== undefined && !Array.isArray(preCompactValue)) {
    return {
      ok: false,
      message: `could not merge ${path}: "hooks.PreCompact" must be an array. Fix the file and re-run; brigadier left it unchanged.`,
    };
  }

  const preCompact = preCompactValue ?? [];
  const desired = codexHook(command);
  const layouts = objectLayout(source, 0);
  const hooksRange = layouts.properties.get("hooks");
  if (hooksRange === undefined) {
    return {
      ok: true,
      contents: insertObjectProperty(
        source,
        layouts,
        "hooks",
        JSON.stringify({ PreCompact: [desired] }, null, 2),
        2,
      ),
    };
  }

  const hooksLayout = objectLayout(source, hooksRange.start);
  const preCompactRange = hooksLayout.properties.get("PreCompact");
  if (preCompactRange === undefined) {
    return {
      ok: true,
      contents: insertObjectProperty(
        source,
        hooksLayout,
        "PreCompact",
        JSON.stringify([desired], null, 2),
        4,
      ),
    };
  }

  const entries = arrayElements(source, preCompactRange.start);
  const marked = entries.filter((range) =>
    containsBrigadierHook(JSON.parse(source.slice(range.start, range.end))),
  );
  if (
    marked.length === 1 &&
    JSON.stringify(
      JSON.parse(source.slice(marked[0]?.start, marked[0]?.end)),
    ) === JSON.stringify(desired)
  ) {
    return { ok: true, contents: source };
  }
  if (marked.length === 0) {
    const insertion = `${preCompact.length === 0 ? "" : ","}\n${indentJson(
      JSON.stringify(desired, null, 2),
      6,
    )}\n    `;
    return {
      ok: true,
      contents: `${source.slice(0, preCompactRange.end - 1)}${insertion}${source.slice(preCompactRange.end - 1)}`,
    };
  }

  const retained = entries
    .filter((range) => !marked.includes(range))
    .map((range) => source.slice(range.start, range.end));
  const replacement = `[
${[...retained, JSON.stringify(desired, null, 2)]
  .map((entry) => indentJson(entry, 6))
  .join(",\n")}
    ]`;
  return {
    ok: true,
    contents: `${source.slice(0, preCompactRange.start)}${replacement}${source.slice(preCompactRange.end)}`,
  };
}

interface JsonRange {
  readonly start: number;
  readonly end: number;
}

interface JsonObjectLayout {
  readonly close: number;
  readonly properties: ReadonlyMap<string, JsonRange>;
}

function containsBrigadierHook(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    Array.isArray(value.hooks) &&
    value.hooks.some(
      (hook) =>
        isJsonObject(hook) &&
        typeof hook.command === "string" &&
        hook.command.endsWith(CODEX_HOOK_MARKER),
    )
  );
}

function objectLayout(source: string, start: number): JsonObjectLayout {
  const properties = new Map<string, JsonRange>();
  let cursor = skipJsonWhitespace(source, start) + 1;
  for (;;) {
    cursor = skipJsonWhitespace(source, cursor);
    if (source[cursor] === "}") {
      return { close: cursor, properties };
    }
    const keyEnd = jsonStringEnd(source, cursor);
    const key = JSON.parse(source.slice(cursor, keyEnd)) as string;
    cursor = skipJsonWhitespace(source, keyEnd) + 1;
    const valueStart = skipJsonWhitespace(source, cursor);
    const valueEnd = jsonValueEnd(source, valueStart);
    properties.set(key, { start: valueStart, end: valueEnd });
    cursor = skipJsonWhitespace(source, valueEnd);
    if (source[cursor] === ",") {
      cursor += 1;
    }
  }
}

function arrayElements(source: string, start: number): readonly JsonRange[] {
  const elements: JsonRange[] = [];
  let cursor = skipJsonWhitespace(source, start) + 1;
  for (;;) {
    cursor = skipJsonWhitespace(source, cursor);
    if (source[cursor] === "]") {
      return elements;
    }
    const end = jsonValueEnd(source, cursor);
    elements.push({ start: cursor, end });
    cursor = skipJsonWhitespace(source, end);
    if (source[cursor] === ",") {
      cursor += 1;
    }
  }
}

function jsonValueEnd(source: string, start: number): number {
  if (source[start] === '"') {
    return jsonStringEnd(source, start);
  }
  if (source[start] === "{" || source[start] === "[") {
    const opening = source[start];
    const closing = opening === "{" ? "}" : "]";
    let depth = 1;
    let cursor = start + 1;
    while (depth > 0) {
      if (source[cursor] === '"') {
        cursor = jsonStringEnd(source, cursor);
        continue;
      }
      if (source[cursor] === opening) {
        depth += 1;
      } else if (source[cursor] === closing) {
        depth -= 1;
      }
      cursor += 1;
    }
    return cursor;
  }
  let cursor = start;
  while (!/[\s,}\]]/.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function jsonStringEnd(source: string, start: number): number {
  let cursor = start + 1;
  while (source[cursor] !== '"') {
    cursor += source[cursor] === "\\" ? 2 : 1;
  }
  return cursor + 1;
}

function skipJsonWhitespace(source: string, start: number): number {
  let cursor = start;
  while (/\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function insertObjectProperty(
  source: string,
  layout: JsonObjectLayout,
  key: string,
  value: string,
  spaces: number,
): string {
  const property = `${JSON.stringify(key)}: ${indentJson(value, spaces).trimStart()}\n${" ".repeat(Math.max(0, spaces - 2))}`;
  if (layout.properties.size === 0) {
    return `${source.slice(0, layout.close)}\n${" ".repeat(spaces)}${property}${source.slice(layout.close)}`;
  }
  const lastEnd = Math.max(
    ...[...layout.properties.values()].map((range) => range.end),
  );
  return `${source.slice(0, lastEnd)},${source.slice(lastEnd, layout.close)}  ${property}${source.slice(layout.close)}`;
}

function indentJson(value: string, spaces: number): string {
  const indentation = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${indentation}${line}`)
    .join("\n");
}

function codexHook(command: string): Record<string, unknown> {
  return { hooks: [{ type: "command", command }] };
}

function formatCodexHooks(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
  const installRoot = input.placement.root(input.roots);
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

  const initialProof = await proveWriteContained(
    input.fs,
    installRoot,
    destination,
  );
  if (!initialProof.ok) {
    return {
      verdict: "refused",
      path: destination,
      detail: initialProof.message,
    };
  }

  let snapshot: SurfaceSnapshot | null;
  try {
    snapshot = await readIfPresent(input.fs, destination);
  } catch (error) {
    const proof = await proveWriteContained(input.fs, installRoot, destination);
    return proof.ok
      ? { verdict: "failed", path: destination, detail: describe(error) }
      : { verdict: "refused", path: destination, detail: proof.message };
  }
  const existing = snapshot?.contents ?? null;
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
    // This narrows the ancestor-swap window to the call boundary below. Node
    // exposes no portable openat-style API that could bind every component;
    // O_NOFOLLOW and the descriptor identity check do bind the final file.
    const finalProof = await proveWriteContained(
      input.fs,
      installRoot,
      destination,
    );
    if (!finalProof.ok) {
      return {
        verdict: "refused",
        path: destination,
        detail: finalProof.message,
      };
    }
    await input.fs.writeFile(destination, contents, mode, snapshot);
  } catch (error) {
    const proof = await proveWriteContained(input.fs, installRoot, destination);
    return proof.ok
      ? { verdict: "failed", path: destination, detail: describe(error) }
      : { verdict: "refused", path: destination, detail: proof.message };
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
interface ManifestRead {
  readonly files: ReadonlyMap<string, string>;
  readonly snapshot: SurfaceSnapshot | null;
}

async function readManifest(
  fs: SurfaceIo,
  path: string,
): Promise<ManifestRead> {
  const snapshot = await readIfPresent(fs, path);
  if (snapshot === null) {
    return { files: new Map(), snapshot: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.contents);
  } catch {
    return { files: new Map(), snapshot };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { files: new Map(), snapshot };
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== MANIFEST_VERSION) {
    return { files: new Map(), snapshot };
  }
  const files = record.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return { files: new Map(), snapshot };
  }
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(files as Record<string, unknown>)) {
    if (typeof value === "string") {
      entries.set(key, value);
    }
  }
  return { files: entries, snapshot };
}

/** Sorted keys, so two installs of the same set produce identical bytes. */
async function writeManifest(
  fs: SurfaceIo,
  root: string,
  path: string,
  written: ReadonlyMap<string, string>,
  expected: SurfaceSnapshot | null,
): Promise<void> {
  const files: Record<string, string> = {};
  for (const key of [...written.keys()].sort()) {
    const value = written.get(key);
    if (value !== undefined) {
      files[key] = value;
    }
  }
  const initialProof = await proveWriteContained(fs, root, path);
  if (!initialProof.ok) {
    throw new Error(initialProof.message);
  }
  await fs.mkdir(parentOf(path));
  const finalProof = await proveWriteContained(fs, root, path);
  if (!finalProof.ok) {
    throw new Error(finalProof.message);
  }
  try {
    await fs.writeFile(
      path,
      `${JSON.stringify({ version: MANIFEST_VERSION, files }, null, 2)}\n`,
      0o600,
      expected,
    );
  } catch (error) {
    const proof = await proveWriteContained(fs, root, path);
    if (!proof.ok) {
      throw new Error(proof.message);
    }
    throw error;
  }
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
  // Keep resolveConfigHome as the authority for its validation and error text,
  // but do not use its lexically-normalized path: realpath must see `..` on
  // disk when a preceding component is a symbolic link.
  resolveConfigHome(env);
  const rawHome = env.HOME?.trim() ?? "";
  const home = rawHome.length === 0 ? "" : absoluteWithoutCollapsing(rawHome);
  const explicitBrigadierHome = trimmed(env.BRIGADIER_HOME);
  const brigadierHome =
    explicitBrigadierHome === null
      ? appendPath(home, ".brigadier")
      : absoluteWithoutCollapsing(explicitBrigadierHome);
  const claudeConfig = absoluteIfPresent(trimmed(env.CLAUDE_CONFIG_DIR));
  const codexHome = absoluteIfPresent(trimmed(env.CODEX_HOME));
  const xdgConfig = absoluteIfPresent(trimmed(env.XDG_CONFIG_HOME));

  const needsHome =
    claudeConfig === null || codexHome === null || xdgConfig === null;
  if (needsHome && home.length === 0) {
    throw new Error(
      "cannot resolve the host configuration directories: set $HOME, or set every one of $CLAUDE_CONFIG_DIR, $CODEX_HOME, and $XDG_CONFIG_HOME",
    );
  }

  return {
    claudeConfig: claudeConfig ?? appendPath(home, ".claude"),
    agentsSkills: appendPath(home, ".agents", "skills"),
    opencodeConfig:
      xdgConfig === null
        ? appendPath(home, ".config", "opencode")
        : appendPath(xdgConfig, "opencode"),
    codexHome: codexHome ?? appendPath(home, ".codex"),
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
): Promise<SurfaceSnapshot | null> {
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
 * sees was built by appendPath from an absolute root, so it always contains a
 * separator and still carries any `..` evidence into the safety check.
 */
function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function appendPath(root: string, ...segments: readonly string[]): string {
  const separator = root.endsWith("/") ? "" : "/";
  return `${root}${separator}${segments.join("/")}`;
}

function absoluteIfPresent(path: string | null): string | null {
  return path === null ? null : absoluteWithoutCollapsing(path);
}

/** Make a path absolute without erasing a symlink-sensitive `..` segment. */
function absoluteWithoutCollapsing(path: string): string {
  return path.startsWith("/") ? path : appendPath(process.cwd(), path);
}

function fileIdentity(device: number | bigint, inode: number | bigint): string {
  return `${String(device)}:${String(inode)}`;
}

type ContainmentProof =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Prove where a write would land using the filesystem, never string cleanup.
 *
 * The root and destination are both resolved through their deepest existing
 * ancestor. A missing suffix is safe to re-append only after `lstat` proves it
 * is genuinely absent rather than a dangling symlink. Final symlinks are
 * refused even when they point inward: the descriptor writer deliberately uses
 * O_NOFOLLOW so the ownership check and mutation concern one regular file.
 */
async function proveWriteContained(
  fs: SurfaceIo,
  root: string,
  destination: string,
): Promise<ContainmentProof> {
  if (root.split("/").includes("..")) {
    return {
      ok: false,
      message: `refusing to write ${destination}: install root ${root} contains a ".." segment whose symlink-sensitive target cannot be established safely. --force replaces edited files; it does not override this refusal.`,
    };
  }
  const resolvedRoot = await resolveThroughExisting(fs, root);
  if (!resolvedRoot.ok) {
    return {
      ok: false,
      message: `refusing to write ${destination}: the real install root ${root} could not be established: ${resolvedRoot.message}. --force replaces edited files; it does not override this refusal.`,
    };
  }

  let finalEntry: { isSymbolicLink(): boolean } | null;
  try {
    finalEntry = await fs.lstat(destination);
  } catch (error) {
    if (!isMissingFile(error)) {
      return {
        ok: false,
        message: `refusing to write ${destination}: the destination could not be inspected: ${describe(error)}. --force replaces edited files; it does not override this refusal.`,
      };
    }
    finalEntry = null;
  }
  if (finalEntry?.isSymbolicLink() === true) {
    let linkTarget: string;
    try {
      linkTarget = await fs.readlink(destination);
    } catch (error) {
      return {
        ok: false,
        message: `refusing to write ${destination}: it is a symbolic link whose target could not be read: ${describe(error)}. --force replaces edited files; it does not override this refusal.`,
      };
    }
    let realTarget: string | null;
    try {
      realTarget = await fs.realpath(destination);
    } catch {
      realTarget = null;
    }
    return {
      ok: false,
      message:
        realTarget === null
          ? `refusing to write ${destination}: it is a symbolic link to ${linkTarget}, whose target could not be resolved. --force replaces edited files; it does not override this refusal.`
          : `refusing to write ${destination}: it is a symbolic link to ${linkTarget} (real path ${realTarget}); brigadier never writes through a destination symlink. --force replaces edited files; it does not override this refusal.`,
    };
  }

  const resolvedDestination = await resolveThroughExisting(fs, destination);
  if (!resolvedDestination.ok) {
    return {
      ok: false,
      message: `refusing to write ${destination}: its real path could not be established: ${resolvedDestination.message}. --force replaces edited files; it does not override this refusal.`,
    };
  }
  if (escapes(resolvedRoot.path, resolvedDestination.path)) {
    return {
      ok: false,
      message: `refusing to write ${destination}: its real path is ${resolvedDestination.path}, outside install root ${resolvedRoot.path}. --force replaces edited files; it does not permit writes outside the install root.`,
    };
  }
  return { ok: true };
}

function escapes(root: string, target: string): boolean {
  const inside = relative(root, target);
  return (
    inside === "" ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    inside.startsWith("/")
  );
}

type ResolvedTarget =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

async function resolveThroughExisting(
  fs: SurfaceIo,
  target: string,
): Promise<ResolvedTarget> {
  const missing: string[] = [];
  let candidate = target;
  for (;;) {
    try {
      const real = await fs.realpath(candidate);
      return {
        ok: true,
        path:
          missing.length === 0 ? real : appendPath(real, ...missing.reverse()),
      };
    } catch (error) {
      if (!isMissingFile(error)) {
        return { ok: false, message: describe(error) };
      }
      const unresolvable = await describeUnresolvable(fs, candidate);
      if (unresolvable !== null) {
        return { ok: false, message: unresolvable };
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        return {
          ok: false,
          message: `no existing ancestor of ${target} could be resolved`,
        };
      }
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

async function describeUnresolvable(
  fs: SurfaceIo,
  candidate: string,
): Promise<string | null> {
  let entry: { isSymbolicLink(): boolean };
  try {
    entry = await fs.lstat(candidate);
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    return `path component ${candidate} could not be inspected: ${describe(error)}`;
  }
  if (!entry.isSymbolicLink()) {
    return `path component ${candidate} exists but its real path could not be resolved`;
  }
  try {
    const linkTarget = await fs.readlink(candidate);
    return `path component ${candidate} is a symbolic link to ${linkTarget}, whose target could not be resolved`;
  } catch {
    return `path component ${candidate} is a symbolic link whose target could not be resolved`;
  }
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
