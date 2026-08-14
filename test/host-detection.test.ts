import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_VERSION, parseConfig } from "../src/config/contracts.ts";
import type { ExecutableLookup, HostDetection } from "../src/config/ensure.ts";
import { detectHosts } from "../src/config/ensure.ts";
import type { ConfigIo } from "../src/config/store.ts";
import { nodeConfigIo } from "../src/config/store.ts";

const NO_EXECUTABLES: ExecutableLookup = {
  resolve: () => Promise.resolve(null),
};

function describedIo(
  exists: (path: string) => boolean | Promise<boolean>,
): ConfigIo {
  return {
    ...nodeConfigIo,
    exists: async (path) => exists(path),
  };
}

function detection(
  detections: readonly HostDetection[],
  host: HostDetection["host"],
): HostDetection {
  const result = detections.find((entry) => entry.host === host);
  if (result === undefined) {
    throw new Error(`missing detection result for ${host}`);
  }
  return result;
}

test("skill hosts prefer their injected executable evidence", async () => {
  const commands: Record<string, string> = {
    claude: "/tools/claude",
    codex: "/tools/codex",
    opencode: "/tools/opencode",
  };
  const lookup: ExecutableLookup = {
    resolve: (command) => Promise.resolve(commands[command] ?? null),
  };
  const detections = await detectHosts(
    { HOME: "/machine/home" },
    describedIo(() => true),
    lookup,
  );

  for (const host of ["claude-code", "codex", "opencode"] as const) {
    expect(detection(detections, host)).toEqual({
      host,
      present: true,
      evidence: `/tools/${host === "claude-code" ? "claude" : host}`,
      evidenceKind: "executable",
    });
  }
});

test("a version-3 config without enabledHosts reads as an empty selection", () => {
  const onDisk = {
    version: CONFIG_VERSION,
    vendors: [],
    secretsConsent: false,
    linkedSecretPaths: [],
    guiRegistrationConsent: false,
    allowDegradedRouting: false,
  };
  const config = parseConfig(onDisk);
  const explicitEmpty = parseConfig({ ...onDisk, enabledHosts: [] });

  expect(config.enabledHosts).toEqual([]);
  expect(explicitEmpty.enabledHosts).toEqual([]);
  expect(JSON.parse(JSON.stringify(config))).not.toHaveProperty("enabledHosts");
  expect(JSON.parse(JSON.stringify(explicitEmpty))).not.toHaveProperty(
    "enabledHosts",
  );
});

test("every host is detected by its ordered path fallback", async () => {
  const present = new Set([
    "/machine/claude-override/settings.json",
    "/machine/codex-override/config.toml",
    "/machine/xdg/opencode/opencode.json",
    "/machine/home/.cursor",
    "/machine/home/.codeium/windsurf",
    "/machine/home/.antigravity",
    "/machine/home/Applications/Claude.app",
  ]);
  const detections = await detectHosts(
    {
      HOME: "/machine/home",
      CLAUDE_CONFIG_DIR: "/machine/claude-override",
      CODEX_HOME: "/machine/codex-override",
      XDG_CONFIG_HOME: "/machine/xdg",
    },
    describedIo((path) => present.has(path)),
    NO_EXECUTABLES,
  );

  expect(detections.map((entry) => entry.host)).toEqual([
    "claude-code",
    "codex",
    "opencode",
    "cursor",
    "windsurf",
    "antigravity",
    "claude-desktop",
  ]);
  expect(detections.every((entry) => entry.present)).toBe(true);
  expect(
    detections.every(
      (entry) => entry.evidenceKind === "directory" && entry.evidence !== null,
    ),
  ).toBe(true);
});

test("absent hosts have null evidence and shared agents skills prove nothing", async () => {
  const detections = await detectHosts(
    { HOME: "/machine/home" },
    describedIo((path) => path === "/machine/home/.agents/skills"),
    NO_EXECUTABLES,
  );

  expect(detection(detections, "codex")).toEqual({
    host: "codex",
    present: false,
    evidence: null,
    evidenceKind: null,
  });
  expect(detection(detections, "opencode")).toEqual({
    host: "opencode",
    present: false,
    evidence: null,
    evidenceKind: null,
  });
  expect(detections.every((entry) => !entry.present)).toBe(true);
});

test("brigadier install --all files do not prove skill hosts are installed", async () => {
  const installFootprint = new Set([
    "/machine/home/.claude",
    "/machine/home/.claude/skills",
    "/machine/home/.claude/skills/brigadier",
    "/machine/home/.claude/skills/brigadier/SKILL.md",
    "/machine/home/.claude/skills/brigadier/.claude-plugin",
    "/machine/home/.claude/skills/brigadier/.claude-plugin/plugin.json",
    "/machine/home/.claude/skills/brigadier/hooks",
    "/machine/home/.claude/skills/brigadier/hooks/hooks.json",
    "/machine/home/.claude/skills/brigadier/hooks/handoff.mjs",
    "/machine/home/.claude/skills/brigadier/hooks/nudge.mjs",
    "/machine/home/.claude/skills/brigadier/hooks/README.md",
    "/machine/home/.codex",
    "/machine/home/.codex/AGENTS.md",
    "/machine/home/.codex/hooks.json",
    "/machine/home/.config",
    "/machine/home/.config/opencode",
    "/machine/home/.config/opencode/plugin",
    "/machine/home/.config/opencode/plugin/brigadier.js",
  ]);
  const detections = await detectHosts(
    { HOME: "/machine/home", PATH: "" },
    describedIo((path) => installFootprint.has(path)),
    NO_EXECUTABLES,
  );

  for (const host of ["claude-code", "codex", "opencode"] as const) {
    expect(detection(detections, host)).toEqual({
      host,
      present: false,
      evidence: null,
      evidenceKind: null,
    });
  }
});

test("secondary host markers and additive home fallbacks remain evidence", async () => {
  const present = new Set([
    "/machine/home/.claude.json",
    "/machine/codex-override/auth.json",
    "/machine/home/.config/opencode/opencode.json",
  ]);
  const detections = await detectHosts(
    {
      HOME: "/machine/home",
      CLAUDE_CONFIG_DIR: "/machine/claude-override",
      CODEX_HOME: "/machine/codex-override",
      XDG_CONFIG_HOME: "/machine/xdg",
    },
    describedIo((path) => present.has(path)),
    NO_EXECUTABLES,
  );

  expect(detection(detections, "claude-code").evidence).toBe(
    "/machine/home/.claude.json",
  );
  expect(detection(detections, "codex").evidence).toBe(
    "/machine/codex-override/auth.json",
  );
  expect(detection(detections, "opencode").evidence).toBe(
    "/machine/home/.config/opencode/opencode.json",
  );
});

test("a missing override remains additive with the home fallback", async () => {
  const seen: string[] = [];
  const detections = await detectHosts(
    {
      HOME: "/machine/home",
      CLAUDE_CONFIG_DIR: "/machine/missing-claude",
    },
    describedIo((path) => {
      seen.push(path);
      return path === "/machine/home/.claude/settings.json";
    }),
    NO_EXECUTABLES,
  );

  expect(seen.indexOf("/machine/missing-claude/settings.json")).toBeLessThan(
    seen.indexOf("/machine/home/.claude/settings.json"),
  );
  expect(detection(detections, "claude-code")).toEqual({
    host: "claude-code",
    present: true,
    evidence: "/machine/home/.claude/settings.json",
    evidenceKind: "directory",
  });
});

test("permission errors are not presence and do not hide later evidence", async () => {
  const inaccessible = new Error("permission denied") as Error & {
    code: string;
  };
  inaccessible.code = "EACCES";
  const detections = await detectHosts(
    {
      HOME: "/machine/home",
      CLAUDE_CONFIG_DIR: "/machine/inaccessible-claude",
      CODEX_HOME: "/machine/inaccessible-codex",
    },
    describedIo((path) => {
      if (path.includes("inaccessible")) {
        throw inaccessible;
      }
      return path === "/machine/home/.claude/settings.json";
    }),
    NO_EXECUTABLES,
  );

  expect(detection(detections, "claude-code")).toEqual({
    host: "claude-code",
    present: true,
    evidence: "/machine/home/.claude/settings.json",
    evidenceKind: "directory",
  });
  expect(detection(detections, "codex").present).toBe(false);
});

test("PATH entries retain spaces and executable evidence is absolute", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "brigadier-host-path-"));
  try {
    const executableDirectory = join(scratch, "  tools  ");
    await mkdir(executableDirectory);
    const executable = join(executableDirectory, "codex");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    const relativeEntry = relative(process.cwd(), executableDirectory);

    const detections = await detectHosts({
      HOME: join(scratch, "absent-home"),
      PATH: `${relativeEntry}${delimiter}`,
    });

    expect(detection(detections, "codex")).toEqual({
      host: "codex",
      present: true,
      evidence: resolve(executable),
      evidenceKind: "executable",
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("X_OK, not an unrelated execute bit, decides executable presence", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "brigadier-host-xok-"));
  const executableDirectory = join(scratch, "bin");
  try {
    await mkdir(executableDirectory);
    const candidate = join(executableDirectory, "codex");
    await writeFile(candidate, "#!/bin/sh\nexit 0\n");
    // The owner lacks X while an unrelated class has it. A mode-bit test sees
    // a non-zero 0o111 mask; access(X_OK) asks whether this user can execute it.
    await chmod(candidate, 0o010);
    await chmod(scratch, 0o755);
    await chmod(executableDirectory, 0o755);

    const environment = {
      HOME: join(scratch, "absent-home"),
      PATH: executableDirectory,
    };
    if (process.getuid?.() !== 0) {
      const detections = await detectHosts(environment);
      expect(detection(detections, "codex").present).toBe(false);
      return;
    }

    const ensureModule = pathToFileURL(
      resolve(import.meta.dir, "../src/config/ensure.ts"),
    ).href;
    const program = `
      import { detectHosts } from ${JSON.stringify(ensureModule)};
      process.setgid(65_534);
      process.setuid(65_534);
      const detections = await detectHosts(${JSON.stringify(environment)});
      const codex = detections.find((entry) => entry.host === "codex");
      process.stdout.write(JSON.stringify(codex));
    `;
    const child = spawnSync(process.execPath, ["--eval", program], {
      encoding: "utf8",
    });

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      host: "codex",
      present: false,
      evidence: null,
      evidenceKind: null,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
