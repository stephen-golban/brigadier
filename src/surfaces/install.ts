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

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import type { Host, ParsedBrigadierConfig } from "../config/contracts.js";
import type { HostDetection } from "../config/ensure.js";
import { detectHosts } from "../config/ensure.js";
import type { ConfigEnvironment } from "../config/store.js";
import {
  readConfig,
  resolveConfigHome,
  resolveConfigPath,
} from "../config/store.js";
import type { OutputStream } from "../init/prompt.js";
import { SURFACE_TEMPLATES } from "./templates.js";

/**
 * Every host brigadier knows how to install into, in the order `--all` walks.
 *
 * The order is the two groups, and the groups are the product. The first three
 * read skill directories off disk, so their doctrine is a file. The last four
 * read none of them: Cursor, Windsurf, Antigravity, and Claude Desktop reach
 * brigadier only over MCP, so what gets written for them is a server
 * registration in the host's own configuration file — and only ever with the
 * user's recorded consent.
 */
export const SURFACE_HOSTS = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "windsurf",
  "antigravity",
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
const JSON_SCAN_WORK_MULTIPLIER = 8;
const MINIMUM_JSON_SCAN_WORK = 64;

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
  /** Atomic replacement for shared files that other products also modify. */
  writeFileAtomic(
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
  /** Permission bits captured with the contents and identity. */
  readonly mode: number;
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
        mode: entry.mode & 0o7777,
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

      await handle.truncate(0);
      const bytes = Buffer.from(contents, "utf8");
      await writeAll(handle, bytes, path);
      await handle.truncate(bytes.byteLength);
      // Descriptor chmod cannot be redirected if the pathname is swapped.
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  },
  async writeFileAtomic(path, contents, mode, expected) {
    const preservedMode = await verifyExpectedFile(path, expected, mode);
    const temporaryPath = `${parentOf(path)}/.${basename(path)}.brigadier-tmp-${randomBytes(12).toString("hex")}`;
    let temporaryExists = false;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        preservedMode,
      );
      temporaryExists = true;
      const bytes = Buffer.from(contents, "utf8");
      await writeAll(handle, bytes, temporaryPath);
      await handle.truncate(bytes.byteLength);
      await handle.chmod(preservedMode);
      await handle.sync();
      await handle.close();
      handle = null;

      // Re-check immediately before publication. This catches content, identity,
      // and permission changes made while the temporary file was being written.
      await verifyExpectedFile(path, expected, mode);
      await rename(temporaryPath, path);
      temporaryExists = false;
    } catch (error) {
      let cleanupError: unknown = null;
      if (handle !== null) {
        try {
          await handle.close();
        } catch (closeError) {
          cleanupError = closeError;
        }
      }
      if (temporaryExists) {
        try {
          await unlink(temporaryPath);
        } catch (unlinkError) {
          cleanupError ??= unlinkError;
        }
      }
      if (cleanupError !== null) {
        throw new AggregateError(
          [error, cleanupError],
          `atomic write to ${path} failed and its temporary file could not be cleaned up`,
        );
      }
      throw error;
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

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  path: string,
): Promise<void> {
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
}

async function verifyExpectedFile(
  path: string,
  expected: SurfaceSnapshot | null,
  defaultMode: number,
): Promise<number> {
  if (expected === null) {
    try {
      await lstat(path);
    } catch (error) {
      if (isMissingFile(error)) {
        return defaultMode;
      }
      throw error;
    }
    throw new Error(
      `refusing to create ${path}: it appeared after brigadier inspected it`,
    );
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await handle.stat();
    const current = await handle.readFile("utf8");
    const identity = fileIdentity(entry.dev, entry.ino);
    const currentMode = entry.mode & 0o7777;
    if (
      identity !== expected.identity ||
      current !== expected.contents ||
      currentMode !== expected.mode
    ) {
      throw new Error(
        `refusing to replace ${path}: it changed after brigadier inspected it`,
      );
    }
    return expected.mode;
  } finally {
    await handle.close();
  }
}

export interface InstallIo {
  readonly env: ConfigEnvironment;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly fs?: SurfaceIo;
  /**
   * The parsed config a caller already persisted. When present, installation
   * derives every config-backed decision from it and does not read config.json.
   */
  readonly configSnapshot?: ParsedBrigadierConfig;
  /** Optional so existing callers use real host detection without changing. */
  readonly detectHosts?: (
    environment: ConfigEnvironment,
  ) => Promise<readonly HostDetection[]>;
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
  /** `$HOME/.cursor`, holding Cursor's user-scoped `mcp.json`. */
  readonly cursorConfig: string;
  /** `$HOME/.codeium/windsurf`, holding Windsurf's `mcp_config.json`. */
  readonly windsurfConfig: string;
  /** `$HOME/.gemini/config`, holding Antigravity's `mcp_config.json`. */
  readonly antigravityConfig: string;
  /** `$HOME/Library/Application Support/Claude`, Desktop's config directory. */
  readonly claudeDesktopConfig: string;
}

interface Placement {
  /** A key into `SURFACE_TEMPLATES`, which is a repo-relative surfaces path. */
  readonly template: string;
  /** The directory outside which this placement must never write. */
  readonly root: (roots: Roots) => string;
  readonly destination: (roots: Roots) => string;
  readonly executable?: true;
}

/**
 * A host that reads no skill directory, and reaches brigadier only over MCP.
 *
 * These are not placements, and the difference is the whole reason for a second
 * type. A placement owns its destination file outright; a registration is one
 * key merged into a file the host owns and other products also write, so the
 * write is a merge that preserves every other byte, and it happens only with
 * `guiRegistrationConsent` recorded in the user's own config.
 *
 * `entry` differs per host because the hosts differ. Every one of the four
 * documents a top-level `mcpServers` object, but only Cursor documents a
 * required `"type": "stdio"`, and the file names and locations share nothing.
 * Each was read from the host's own documentation, cited in `documentation`.
 */
interface McpRegistration {
  /** Must already exist: brigadier never creates another product's config dir. */
  readonly root: (roots: Roots) => string;
  readonly path: (roots: Roots) => string;
  /** The stdio server entry written under `mcpServers.brigadier`. */
  readonly entry: (command: string) => Record<string, unknown>;
  /** The host's own documentation this path and shape were read from. */
  readonly documentation: string;
}

interface HostPlan {
  readonly host: SurfaceHost;
  readonly placements: readonly Placement[];
  /** Present only for hosts whose sole door into the session is MCP. */
  readonly mcp?: McpRegistration;
  /** Printed after the file list. The honest limitations live here. */
  readonly notes: (roots: Roots) => readonly string[];
}

/** The key brigadier owns inside every host's `mcpServers` object. */
const MCP_SERVER_KEY = "brigadier";
const MCP_SERVERS_KEY = "mcpServers";

/** Overrides the command a GUI host is told to spawn. See `resolveMcpCommand`. */
const MCP_COMMAND_VARIABLE = "BRIGADIER_MCP_COMMAND";

/**
 * The command a GUI host will spawn to reach brigadier's MCP server.
 *
 * A GUI application launched from Finder does not inherit a login shell's PATH,
 * so an absolute path is worth a great deal here. When brigadier is running as
 * its own compiled binary, `process.execPath` IS that absolute path and is used.
 * Otherwise — running from source under `bun`, or from `node dist/cli.js` —
 * there is no honest absolute path to offer, so the bare name is written and
 * `bareCommandNote` is printed, saying plainly that the host must be able to
 * find it. Setting `$BRIGADIER_MCP_COMMAND` overrides both.
 */
function resolveMcpCommand(env: ConfigEnvironment): string {
  const explicit = trimmed(env[MCP_COMMAND_VARIABLE]);
  if (explicit !== null) {
    return explicit;
  }
  const running = process.execPath;
  return basename(running) === "brigadier" ? running : "brigadier";
}

/**
 * THE PROMISE ABOVE, ACTUALLY KEPT. A bare command in a GUI host's configuration
 * is a registration that exits 0, reports success, and may never start anything:
 * a Finder-launched application does not inherit a login shell's PATH, so the
 * server is simply never spawned and the user blames their editor. That is worth
 * a line on an otherwise successful install — a warning, not a failure, so the
 * exit code does not move. An absolute path needs no note and gets none.
 */
function bareCommandNote(command: string): string {
  return `THE REGISTRATION NAMES A BARE COMMAND, ${JSON.stringify(command)}. This host has to resolve it on its own PATH, and an application launched from Finder does not inherit a login shell's PATH — when it cannot find the command, the server never starts and nothing says so. Set ${MCP_COMMAND_VARIABLE} to an absolute path and run this again to write that instead.`;
}

/** Whether this outcome leaves the command sitting in the host's config. */
function registrationCarriesCommand(verdict: Verdict): boolean {
  return (
    verdict === "created" || verdict === "updated" || verdict === "unchanged"
  );
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
        template: "claude-code/hooks/nudge.mjs",
        root: (roots) => roots.claudeConfig,
        destination: (roots) =>
          appendPath(CLAUDE_SKILL(roots), "hooks", "nudge.mjs"),
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
      `The nudge hook is registered against UserPromptSubmit in the same file and also needs no approval. It stays silent unless a prompt describes work in more than one independent piece, and then says one line, once per session. Set BRIGADIER_NUDGE=off to silence it entirely.`,
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
      `THE HANDOFF HOOK IS REGISTERED AGAINST PreCompact IN ${appendPath(roots.codexHome, CODEX_HOOKS_FILE_NAME)}, BUT IT WILL NOT RUN UNTIL YOU APPROVE IT IN CODEX. Approval is bound to the registration (event, matcher, and command), not to the contents of handoff.mjs, so editing the script leaves approval intact. To re-review an edited script, deliberately change the registration and approve it again. Claude Code needs no approval for the same hook; that asymmetry is deliberate on Codex's part, and brigadier neither works around it nor hides it.`,
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
      `HANDOFF_EVENT_TYPES was verified on 2026-08-10 against a running opencode 1.18.16 darwin-arm64 by fetching GET /doc and enumerating its OpenAPI event union. No live compaction was triggered, only 1.18.16 was tested, and the event vocabulary is version-dependent; if a future build renames either event, that array remains the one line to change.`,
    ],
  },
  {
    host: "cursor",
    placements: [],
    mcp: {
      root: (roots) => roots.cursorConfig,
      path: (roots) => appendPath(roots.cursorConfig, "mcp.json"),
      // Cursor's field table marks `type` required for stdio servers while its
      // own examples omit it. Writing it satisfies the table and contradicts
      // nothing in the examples, so it is written.
      entry: (command) => ({ type: "stdio", command, args: ["mcp"] }),
      documentation: "https://cursor.com/docs/context/mcp",
    },
    notes: (roots) => [
      `Cursor reads no skill directory. ${appendPath(roots.cursorConfig, "mcp.json")} is the user-scoped MCP configuration, and the tool descriptions brigadier's server advertises are the whole of the doctrine it can deliver here.`,
      `There is no hook surface on Cursor. Nothing watches the transcript, and the server is invoked only when the model chooses to invoke it.`,
    ],
  },
  {
    host: "windsurf",
    placements: [],
    mcp: {
      root: (roots) => roots.windsurfConfig,
      path: (roots) => appendPath(roots.windsurfConfig, "mcp_config.json"),
      entry: (command) => ({ command, args: ["mcp"] }),
      documentation: "https://docs.devin.ai/desktop/cascade/mcp",
    },
    notes: (roots) => [
      `Windsurf reads no skill directory. ${appendPath(roots.windsurfConfig, "mcp_config.json")} is the only documented MCP configuration for Cascade, and it is global; Windsurf documents no project-scoped file.`,
      `Cognition folded Windsurf into Devin, and its own documentation now describes Cascade as the legacy agent while the Devin Local agent configures MCP through the Devin CLI instead. This path is correct for Cascade today and is a shrinking surface.`,
    ],
  },
  {
    host: "antigravity",
    placements: [],
    mcp: {
      root: (roots) => roots.antigravityConfig,
      path: (roots) => appendPath(roots.antigravityConfig, "mcp_config.json"),
      entry: (command) => ({ command, args: ["mcp"] }),
      documentation: "https://antigravity.google/docs/mcp",
    },
    notes: (roots) => [
      `Antigravity reads no skill directory. ${appendPath(roots.antigravityConfig, "mcp_config.json")} is the global configuration shared by its IDE, CLI, and SDK.`,
      `Third-party guides name ~/.gemini/antigravity/mcp_config.json instead. That path is wrong: Antigravity's own documentation puts only mcp_oauth_tokens.json under ~/.gemini/antigravity.`,
    ],
  },
  {
    host: "claude-desktop",
    mcp: {
      root: (roots) => roots.claudeDesktopConfig,
      path: (roots) =>
        appendPath(roots.claudeDesktopConfig, "claude_desktop_config.json"),
      entry: (command) => ({ command, args: ["mcp"] }),
      documentation:
        "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
    },
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
      `THE .mcpb BUNDLE WAS ONLY STAGED, AT ${DESKTOP_BUNDLE(roots)}. Desktop installs a bundle by an explicit user action and brigadier does not forge those. The MCP registration above is the path that needs no build step; the bundle is here for anyone who wants the packaged extension instead.`,
      `Quit Claude Desktop completely and relaunch it before the registered server appears. Desktop reads ${appendPath(roots.claudeDesktopConfig, "claude_desktop_config.json")} only at startup.`,
      `To finish the bundle instead: run \`bun run build:mcp\` to emit dist/mcp/server.js, copy it to server/brigadier-mcp.js beside the manifest, zip that directory with manifest.json at the archive root, rename it brigadier.mcpb, and open it with Desktop.`,
      `Desktop gets an MCP server rather than a skill because Desktop Skills execute server-side and cannot invoke a local binary, while Desktop MCP servers run locally with your full privileges and can spawn \`claude -p\`.`,
      `THE HANDOFF HOOK IS IMPOSSIBLE ON CLAUDE DESKTOP. It exposes no hook surface, and an MCP server is called by the model rather than by the transcript. There is no workaround.`,
    ],
  },
];

/* ------------------------------------------------------------------------ */
/* The command                                                               */
/* ------------------------------------------------------------------------ */

const USAGE = `Usage: brigadier install [<host>...] [options]

With no host names, installs the hosts selected by \`brigadier init\` that are
currently detected on this machine.

Hosts that read a skill directory:
  claude-code      a skill at ~/.claude/skills/brigadier, auto-loading as a plugin
  codex            a skill at ~/.agents/skills/brigadier, plus $CODEX_HOME/AGENTS.md
  opencode         a plugin at ~/.config/opencode/plugin/brigadier.js

Hosts that read none, and reach brigadier only over MCP. Each writes one
"brigadier" key into the host's own MCP configuration, and every one of them is
skipped unless guiRegistrationConsent is recorded in your brigadier config:
  cursor           ~/.cursor/mcp.json
  windsurf         ~/.codeium/windsurf/mcp_config.json
  antigravity      ~/.gemini/config/mcp_config.json
  claude-desktop   ~/Library/Application Support/Claude/claude_desktop_config.json,
                   plus an .mcpb bundle staged at ~/.brigadier/surfaces/claude-desktop

Options:
      --all        install every host above that is currently detected
      --dry-run    report what would be written and write nothing
      --force      replace a file that brigadier did not write, or that was
                   edited after brigadier wrote it (written with mode 0644 or
                   0755, not the replaced file's mode). For explicitly named
                   hosts only, it also overrides failed host detection. It does
                   not grant registration consent, and nothing here does.
  -h, --help       print this message

Environment:
  BRIGADIER_MCP_COMMAND   the command a GUI host is told to spawn; defaults to
                          this executable when it is the compiled binary, and to
                          "brigadier" otherwise

Exit codes:
  0  every file is in place
  1  at least one file was refused or could not be written
  2  usage error
`;

type Verdict =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped"
  | "refused"
  | "failed";

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

  // ONE VALUE, ONE SNAPSHOT, FOR THE WHOLE INSTALL. A caller that has just
  // persisted a parsed config can hand that exact value over; every other
  // caller keeps the existing single read. The config used to be read twice —
  // once for `enabledHosts` and again for `guiRegistrationConsent` — and
  // `writeConfig` renames over the file, which `brigadier init` does. Multiple
  // reads could assemble authorization from two different files. Everything
  // below derives from this one value.
  const snapshot: ConfigSnapshot =
    io.configSnapshot === undefined
      ? await readConfigSnapshot(io.env)
      : {
          kind: "ok",
          path: resolveConfigPath(io.env),
          config: io.configSnapshot,
        };

  let candidates: readonly SurfaceHost[];
  if (parsed.selection === "enabled") {
    // A config that exists but cannot be read or parsed is a HARD ERROR here,
    // deliberately unlike the consent policy below: silently degrading to "no
    // hosts enabled" would report an empty selection the user never made.
    if (snapshot.kind === "unreadable") {
      io.stderr.write(
        `brigadier install: could not read enabled hosts from ${snapshot.path}: ${snapshot.reason}. Run \`brigadier init\` to record them again.\n`,
      );
      return 1;
    }
    const recorded: readonly Host[] =
      snapshot.kind === "ok" ? snapshot.config.enabledHosts : [];
    const enabledHosts = recorded.filter(isHost);
    if (enabledHosts.length === 0) {
      io.stderr.write(
        "brigadier install: no enabled hosts are recorded; run `brigadier init` to choose which detected hosts to install.\n",
      );
      return 1;
    }
    candidates = enabledHosts;
  } else if (parsed.selection === "all") {
    candidates = SURFACE_HOSTS;
  } else {
    candidates = parsed.hosts;
  }

  let detections: readonly HostDetection[];
  try {
    detections = await (io.detectHosts ?? detectHosts)(io.env);
  } catch (error) {
    io.stderr.write(
      `brigadier install: could not detect installed hosts: ${describe(error)}\n`,
    );
    return 1;
  }
  const present = new Set(
    detections.filter((entry) => entry.present).map((entry) => entry.host),
  );
  const forcePresence = parsed.selection === "explicit" && parsed.force;
  const hosts = candidates.filter((host) => present.has(host) || forcePresence);
  const undetected = candidates.filter(
    (host) => !present.has(host) && !forcePresence,
  );
  for (const host of undetected) {
    const forceHint =
      parsed.selection === "explicit" && !parsed.force
        ? "; re-run with --force to install it anyway"
        : "";
    io.stdout.write(
      `  skipped    ${host} (not detected on this machine${forceHint})\n`,
    );
  }

  if (hosts.length === 0) {
    io.stdout.write(
      `\n${parsed.dryRun ? "dry run: " : ""}0 written, 0 unchanged, ${undetected.length} skipped, 0 refused.\n`,
    );
    if (parsed.selection === "all") {
      io.stderr.write(
        "brigadier install: no supported AI hosts were detected on this machine.\n",
      );
      return 1;
    }
    if (parsed.selection === "enabled") {
      io.stderr.write(
        `brigadier install: none of the enabled hosts are currently detected: ${candidates.join(", ")}.\n`,
      );
      return 1;
    }
    return 0;
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
  if (hosts.includes("codex")) {
    const prepared = await prepareCodexHookRegistration(fs, roots);
    if (!prepared.ok) {
      io.stderr.write(`brigadier install: ${prepared.message}\n`);
      return 1;
    }
    codexHook = prepared;
  }

  const consent = guiConsentFrom(snapshot);
  const mcpCommand = resolveMcpCommand(io.env);

  let refused = 0;
  let changed = 0;
  let unchanged = 0;
  let skipped = undetected.length;

  for (const host of hosts) {
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
      } else if (outcome.verdict === "skipped") {
        skipped += 1;
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
    let mcpVerdict: Verdict | null = null;
    if (plan.mcp !== undefined) {
      const outcome = await applyMcpRegistration({
        fs,
        registration: plan.mcp,
        roots,
        env: io.env,
        command: mcpCommand,
        consent,
        dryRun: parsed.dryRun,
      });
      mcpVerdict = outcome.verdict;
      writeOutcome(io.stdout, outcome);
      if (outcome.verdict === "refused" || outcome.verdict === "failed") {
        refused += 1;
      } else if (outcome.verdict === "unchanged") {
        unchanged += 1;
      } else if (outcome.verdict === "skipped") {
        skipped += 1;
      } else {
        changed += 1;
      }
    }
    io.stdout.write("\n");
    for (const note of plan.notes(roots)) {
      io.stdout.write(`  note: ${note}\n`);
    }
    if (plan.mcp !== undefined) {
      // The citation is printed, not merely recorded. A registration written to
      // a guessed path is silent breakage the user blames on their editor, so
      // the source it was read from belongs where they can check it.
      io.stdout.write(
        `  note: that path and entry shape were read from ${plan.mcp.documentation}\n`,
      );
      if (
        mcpVerdict !== null &&
        registrationCarriesCommand(mcpVerdict) &&
        !isAbsolute(mcpCommand)
      ) {
        io.stdout.write(`  note: ${bareCommandNote(mcpCommand)}\n`);
      }
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
    `\n${parsed.dryRun ? "dry run: " : ""}${changed} written, ${unchanged} unchanged, ${skipped} skipped, ${refused} refused.\n`,
  );
  return refused > 0 ? 1 : 0;
}

/**
 * The one config snapshot `runInstall` uses, and everything it could not read.
 *
 * The three arms exist because the two readers below hold two different
 * policies about failure, and collapsing them into one would be a regression
 * rather than a simplification.
 */
type ConfigSnapshot =
  | {
      readonly kind: "ok";
      readonly path: string;
      readonly config: ParsedBrigadierConfig;
    }
  | { readonly kind: "missing"; readonly path: string }
  | {
      readonly kind: "unreadable";
      readonly path: string;
      readonly reason: string;
    };

async function readConfigSnapshot(
  env: ConfigEnvironment,
): Promise<ConfigSnapshot> {
  let path: string;
  try {
    path = resolveConfigPath(env);
  } catch (error) {
    // Unreachable while `resolveRoots` runs first — it makes the same refusal
    // through `resolveConfigHome` — but this stays total rather than throwing.
    return {
      kind: "unreadable",
      path: "$BRIGADIER_HOME/config.json",
      reason: describe(error),
    };
  }
  try {
    const config = await readConfig(path);
    return config === null
      ? { kind: "missing", path }
      : { kind: "ok", path, config };
  } catch (error) {
    return { kind: "unreadable", path, reason: describe(error) };
  }
}

/**
 * Whether the user has said yes, once, to brigadier writing into a third-party
 * application's configuration.
 *
 * EVERY FAILURE IS A NO, and that is the point rather than a shortcut. A missing
 * config, an unparseable one, an unreadable one, and an explicit false all mean
 * the same thing here: nobody said yes. Only `guiRegistrationConsent === true`
 * in a config that actually parsed is a yes.
 */
function guiConsentFrom(snapshot: ConfigSnapshot): boolean {
  return (
    snapshot.kind === "ok" && snapshot.config.guiRegistrationConsent === true
  );
}

/**
 * The sentence that says how to turn registration on. Never how to fake it.
 *
 * IT NAMES `brigadier init` ON PURPOSE, AND THE DOCTRINE AGREES. Every installed
 * SKILL.md tells an agent never to run init to make a config appear — config is
 * automatic — and carves out exactly this one case, because recording consent to
 * write into somebody else's application is a human's decision and the
 * interactive question is the only thing that can ask for it. So this sentence
 * addresses the person, and an agent that reads it should hand it over rather
 * than run it.
 */
function consentInstructions(env: ConfigEnvironment): string {
  let path: string;
  try {
    path = resolveConfigPath(env);
  } catch {
    path = "$BRIGADIER_HOME/config.json";
  }
  return `brigadier writes into another application's configuration only on an explicit yes, and only a human can give it. Run \`brigadier init\` yourself — recording this consent is the one thing it is for — and answer yes to "Register brigadier's MCP server with detected GUI hosts", which records "guiRegistrationConsent": true in ${path}. Nothing else, including --force, grants it.`;
}

interface McpApplyInput {
  readonly fs: SurfaceIo;
  readonly registration: McpRegistration;
  readonly roots: Roots;
  readonly env: ConfigEnvironment;
  readonly command: string;
  readonly consent: boolean;
  readonly dryRun: boolean;
}

/**
 * Merges brigadier's own key into a host's MCP configuration, or explains why it
 * did not.
 *
 * TWO GATES, IN THIS ORDER, and both answer `skipped` rather than an error: no
 * recorded consent, and a host whose configuration directory is not there.
 * The second is not a safety check so much as an honesty one — creating
 * `~/.cursor/` on a machine with no Cursor writes a file nothing will ever read
 * and leaves a stranger's directory behind.
 */
async function applyMcpRegistration(
  input: McpApplyInput,
): Promise<FileOutcome> {
  const path = input.registration.path(input.roots);
  const root = input.registration.root(input.roots);
  if (!input.consent) {
    return {
      verdict: "skipped",
      path,
      detail: consentInstructions(input.env),
    };
  }

  let rootPresent: boolean;
  try {
    await input.fs.lstat(root);
    rootPresent = true;
  } catch (error) {
    if (!isMissingFile(error)) {
      return { verdict: "failed", path, detail: describe(error) };
    }
    rootPresent = false;
  }
  if (!rootPresent) {
    return {
      verdict: "skipped",
      path,
      detail: `${root} does not exist, so this host is not installed on this machine. brigadier does not create another product's configuration directory.`,
    };
  }

  const proof = await proveWriteContained(input.fs, root, path);
  if (!proof.ok) {
    return { verdict: "refused", path, detail: proof.message };
  }

  let snapshot: SurfaceSnapshot | null;
  try {
    snapshot = await readIfPresent(input.fs, path);
  } catch (error) {
    return {
      verdict: "failed",
      path,
      detail: `could not safely read ${path}: ${describe(error)}`,
    };
  }

  const entry = input.registration.entry(input.command);
  const merged = mergeMcpServer(snapshot?.contents ?? null, entry, path);
  if (!merged.ok) {
    return { verdict: "refused", path, detail: merged.message };
  }
  const verdict: Verdict =
    snapshot === null
      ? "created"
      : merged.contents === snapshot.contents
        ? "unchanged"
        : "updated";
  if (verdict === "unchanged" || input.dryRun) {
    return { verdict, path, detail: null };
  }

  try {
    await input.fs.mkdir(parentOf(path));
    const finalProof = await proveWriteContained(input.fs, root, path);
    if (!finalProof.ok) {
      return { verdict: "refused", path, detail: finalProof.message };
    }
    await input.fs.writeFileAtomic(path, merged.contents, FILE_MODE, snapshot);
    return { verdict, path, detail: null };
  } catch (error) {
    const after = await proveWriteContained(input.fs, root, path);
    return after.ok
      ? { verdict: "failed", path, detail: describe(error) }
      : { verdict: "refused", path, detail: after.message };
  }
}

/**
 * Produces the file contents with `mcpServers.brigadier` set to `entry`.
 *
 * ONLY BRIGADIER'S OWN KEY IS TOUCHED. Every other server in the file, every
 * unknown top-level key, and the surrounding formatting survive, because the
 * merge is byte surgery on the parsed layout rather than a re-serialization of
 * the whole document. A file that is not a JSON object is refused and left
 * exactly as it is: a user's MCP configuration is not brigadier's to repair.
 */
function mergeMcpServer(
  source: string | null,
  entry: Record<string, unknown>,
  path: string,
):
  | { readonly ok: true; readonly contents: string }
  | { readonly ok: false; readonly message: string } {
  const fresh = `${JSON.stringify({ [MCP_SERVERS_KEY]: { [MCP_SERVER_KEY]: entry } }, null, 2)}\n`;
  // A zero-byte or whitespace-only file carries no information to preserve, and
  // some hosts create one before they have ever been configured.
  if (source === null || source.trim().length === 0) {
    return { ok: true, contents: fresh };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return {
      ok: false,
      message: `could not parse ${path}. Fix the malformed JSON and re-run; brigadier left the file unchanged.`,
    };
  }
  if (!isJsonObject(parsed)) {
    return {
      ok: false,
      message: `could not merge ${path}: its top level must be a JSON object. Fix the file and re-run; brigadier left it unchanged.`,
    };
  }
  const serversValue = parsed[MCP_SERVERS_KEY];
  if (serversValue !== undefined && !isJsonObject(serversValue)) {
    return {
      ok: false,
      message: `could not merge ${path}: "${MCP_SERVERS_KEY}" must be a JSON object. Fix the file and re-run; brigadier left it unchanged.`,
    };
  }

  const budget = new JsonScanBudget(source);
  const rootLayout = objectLayout(source, 0, budget);
  const serversRange = rootLayout.properties.get(MCP_SERVERS_KEY);
  if (serversRange === undefined) {
    return {
      ok: true,
      contents: insertObjectProperty(
        source,
        rootLayout,
        MCP_SERVERS_KEY,
        JSON.stringify({ [MCP_SERVER_KEY]: entry }, null, 2),
        2,
      ),
    };
  }

  const serversLayout = objectLayout(source, serversRange.start, budget);
  const existing = serversLayout.properties.get(MCP_SERVER_KEY);
  if (existing === undefined) {
    return {
      ok: true,
      contents: insertObjectProperty(
        source,
        serversLayout,
        MCP_SERVER_KEY,
        JSON.stringify(entry, null, 2),
        4,
      ),
    };
  }
  if (
    JSON.stringify(JSON.parse(source.slice(existing.start, existing.end))) ===
    JSON.stringify(entry)
  ) {
    return { ok: true, contents: source };
  }
  return {
    ok: true,
    contents: `${source.slice(0, existing.start)}${JSON.stringify(entry)}${source.slice(existing.end)}`,
  };
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
    await fs.writeFileAtomic(
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
  const budget = new JsonScanBudget(source);
  const layouts = objectLayout(source, 0, budget);
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

  const hooksLayout = objectLayout(source, hooksRange.start, budget);
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

  const entries = arrayElements(source, preCompactRange.start, budget);
  const owned = entries.filter((range) =>
    isBrigadierOwnedEntry(JSON.parse(source.slice(range.start, range.end))),
  );
  if (
    owned.length === 1 &&
    JSON.stringify(JSON.parse(source.slice(owned[0]?.start, owned[0]?.end))) ===
      JSON.stringify(desired)
  ) {
    return { ok: true, contents: source };
  }
  if (owned.length === 0) {
    const insertion = `${preCompact.length === 0 ? "" : ","}\n${indentJson(
      JSON.stringify(desired, null, 2),
      6,
    )}\n    `;
    return {
      ok: true,
      contents: `${source.slice(0, preCompactRange.end - 1)}${insertion}${source.slice(preCompactRange.end - 1)}`,
    };
  }

  const survivor = owned[0];
  if (survivor === undefined) {
    throw new Error("brigadier hook ownership scan lost its first entry");
  }
  let contents = source;
  for (const duplicate of owned.slice(1).reverse()) {
    const index = entries.indexOf(duplicate);
    const previous = entries[index - 1];
    if (previous === undefined) {
      throw new Error("brigadier hook ownership scan lost an array delimiter");
    }
    contents = `${contents.slice(0, previous.end)}${contents.slice(duplicate.end)}`;
  }
  const replacement = JSON.stringify(desired);
  return {
    ok: true,
    contents: `${contents.slice(0, survivor.start)}${replacement}${contents.slice(survivor.end)}`,
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

function isBrigadierOwnedEntry(value: unknown): boolean {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.hooks) ||
    value.hooks.length !== 1
  ) {
    return false;
  }
  const hook = value.hooks[0];
  return (
    isJsonObject(hook) &&
    Object.keys(hook).length === 2 &&
    hook.type === "command" &&
    typeof hook.command === "string" &&
    hook.command.endsWith(CODEX_HOOK_MARKER)
  );
}

class JsonScanBudget {
  private remaining: number;

  constructor(source: string) {
    this.remaining = Math.max(
      MINIMUM_JSON_SCAN_WORK,
      source.length * JSON_SCAN_WORK_MULTIPLIER,
    );
  }

  spend(): void {
    this.remaining -= 1;
    if (this.remaining < 0) {
      throw new Error(
        "Codex hooks.json scanner exceeded its input-sized work budget",
      );
    }
  }
}

function objectLayout(
  source: string,
  start: number,
  budget: JsonScanBudget,
): JsonObjectLayout {
  const properties = new Map<string, JsonRange>();
  let cursor = skipJsonWhitespace(source, start, budget) + 1;
  for (;;) {
    budget.spend();
    cursor = skipJsonWhitespace(source, cursor, budget);
    if (source[cursor] === "}") {
      return { close: cursor, properties };
    }
    const keyEnd = jsonStringEnd(source, cursor, budget);
    const key = JSON.parse(source.slice(cursor, keyEnd)) as string;
    cursor = skipJsonWhitespace(source, keyEnd, budget) + 1;
    const valueStart = skipJsonWhitespace(source, cursor, budget);
    const valueEnd = jsonValueEnd(source, valueStart, budget);
    properties.set(key, { start: valueStart, end: valueEnd });
    cursor = skipJsonWhitespace(source, valueEnd, budget);
    if (source[cursor] === ",") {
      cursor += 1;
    }
  }
}

function arrayElements(
  source: string,
  start: number,
  budget: JsonScanBudget,
): readonly JsonRange[] {
  const elements: JsonRange[] = [];
  let cursor = skipJsonWhitespace(source, start, budget) + 1;
  for (;;) {
    budget.spend();
    cursor = skipJsonWhitespace(source, cursor, budget);
    if (source[cursor] === "]") {
      return elements;
    }
    const end = jsonValueEnd(source, cursor, budget);
    elements.push({ start: cursor, end });
    cursor = skipJsonWhitespace(source, end, budget);
    if (source[cursor] === ",") {
      cursor += 1;
    }
  }
}

function jsonValueEnd(
  source: string,
  start: number,
  budget: JsonScanBudget,
): number {
  if (source[start] === '"') {
    return jsonStringEnd(source, start, budget);
  }
  if (source[start] === "{" || source[start] === "[") {
    const opening = source[start];
    const closing = opening === "{" ? "}" : "]";
    let depth = 1;
    let cursor = start + 1;
    while (depth > 0) {
      budget.spend();
      if (source[cursor] === '"') {
        cursor = jsonStringEnd(source, cursor, budget);
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
    budget.spend();
    cursor += 1;
  }
  return cursor;
}

function jsonStringEnd(
  source: string,
  start: number,
  budget: JsonScanBudget,
): number {
  let cursor = start + 1;
  while (source[cursor] !== '"') {
    budget.spend();
    cursor += source[cursor] === "\\" ? 2 : 1;
  }
  return cursor + 1;
}

function skipJsonWhitespace(
  source: string,
  start: number,
  budget: JsonScanBudget,
): number {
  let cursor = start;
  while (/\s/.test(source[cursor] ?? "")) {
    budget.spend();
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
 * An absent or unrecognizable manifest — missing, not JSON, or not a record of
 * the expected version and shape — is treated as empty, which fails in the safe
 * direction: with no record, every pre-existing file is refused rather than
 * replaced. A manifest that exists but cannot be read is a different case and
 * is not treated as empty: `readIfPresent` rethrows every error but a missing
 * file, `readManifest` catches only the parse, and `runInstall` turns what
 * escapes into "could not safely read" and exit 1 before any file is placed.
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
      readonly selection: "all" | "enabled" | "explicit";
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
    return {
      kind: "install",
      selection: "all",
      hosts: [],
      dryRun,
      force,
    };
  }
  if (hosts.length === 0) {
    return {
      kind: "install",
      selection: "enabled",
      hosts: [],
      dryRun,
      force,
    };
  }
  return { kind: "install", selection: "explicit", hosts, dryRun, force };
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
    // No environment overrides for these four: each host documents exactly one
    // user-scoped location and none of them reads an override variable, so an
    // invented one would only be a way to write the registration where the host
    // will never look for it.
    cursorConfig: appendPath(home, ".cursor"),
    windsurfConfig: appendPath(home, ".codeium", "windsurf"),
    antigravityConfig: appendPath(home, ".gemini", "config"),
    claudeDesktopConfig: appendPath(
      home,
      "Library",
      "Application Support",
      "Claude",
    ),
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
