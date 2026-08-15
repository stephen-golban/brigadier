import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostDetection } from "../src/config/ensure.ts";
import type { InstallIo, SurfaceIo } from "../src/surfaces/install.ts";
import {
  nodeSurfaceIo,
  runInstall,
  SURFACE_HOSTS,
} from "../src/surfaces/install.ts";

const OPERATION_BUDGET = 400;
const CANARY_BYTES = "outside the install boundary\n";

interface Collected {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

interface Harness {
  readonly scratch: string;
  readonly home: string;
  readonly hooksPath: string;
  readonly outsideCanary: string;
  readonly fs: SurfaceIo;
  readonly writes: readonly string[];
  readonly outsideWriteAttempts: readonly string[];
  operations(): number;
}

async function makeHarness(homeName = "home"): Promise<Harness> {
  const scratch = await mkdtemp(join(tmpdir(), "brigadier-codex-hooks-"));
  const home = join(scratch, homeName);
  const outsideCanary = join(scratch, "outside-home-canary.txt");
  await mkdir(home, { recursive: true });
  await writeFile(outsideCanary, CANARY_BYTES, "utf8");

  let operationCount = 0;
  const writes: string[] = [];
  const outsideWriteAttempts: string[] = [];
  const tick = (): void => {
    operationCount += 1;
    if (operationCount > OPERATION_BUDGET) {
      throw new Error(
        `install exceeded its ${OPERATION_BUDGET}-filesystem-operation work budget`,
      );
    }
  };
  const beforeWrite = (path: string): void => {
    tick();
    writes.push(path);
    if (path !== home && !path.startsWith(`${home}/`)) {
      outsideWriteAttempts.push(path);
      throw new Error(`test blocked an out-of-boundary write to ${path}`);
    }
  };

  const fs: SurfaceIo = {
    async mkdir(path) {
      beforeWrite(path);
      await nodeSurfaceIo.mkdir(path);
    },
    async readFile(path) {
      tick();
      return nodeSurfaceIo.readFile(path);
    },
    async writeFile(path, contents, mode, expected) {
      beforeWrite(path);
      await nodeSurfaceIo.writeFile(path, contents, mode, expected);
    },
    async writeFileAtomic(path, contents, mode, expected) {
      beforeWrite(path);
      await nodeSurfaceIo.writeFileAtomic(path, contents, mode, expected);
    },
    async realpath(path) {
      tick();
      return nodeSurfaceIo.realpath(path);
    },
    async lstat(path) {
      tick();
      return nodeSurfaceIo.lstat(path);
    },
    async readlink(path) {
      tick();
      return nodeSurfaceIo.readlink(path);
    },
  };

  return {
    scratch,
    home,
    hooksPath: join(home, ".codex/hooks.json"),
    outsideCanary,
    fs,
    writes,
    outsideWriteAttempts,
    operations: () => operationCount,
  };
}

async function installCodex(
  harness: Harness,
  argv: readonly string[] = ["codex"],
  fs: SurfaceIo = harness.fs,
): Promise<Collected> {
  let stdout = "";
  let stderr = "";
  const detections: readonly HostDetection[] = SURFACE_HOSTS.map((host) =>
    host === "codex"
      ? {
          host,
          present: true,
          evidence: join(harness.home, ".host-detection", host),
          evidenceKind: "file",
        }
      : { host, present: false, evidence: null, evidenceKind: null },
  );
  const io: InstallIo = {
    env: { HOME: harness.home },
    fs,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
    detectHosts: () => Promise.resolve(detections),
  };
  const code = await runInstall(argv, io);
  return { stdout, stderr, code };
}

async function assertHarnessSafe(harness: Harness): Promise<void> {
  expect(harness.operations()).toBeLessThanOrEqual(OPERATION_BUDGET);
  expect(harness.outsideWriteAttempts).toEqual([]);
  expect(await readFile(harness.outsideCanary, "utf8")).toBe(CANARY_BYTES);
  expect(
    harness.writes.every(
      (path) => path === harness.home || path.startsWith(`${harness.home}/`),
    ),
  ).toBe(true);
}

async function fileIsMissing(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return false;
  } catch (error) {
    return (
      error instanceof Error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    );
  }
}

function expectedFreshHooks(home: string): string {
  return `{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'${home}/.agents/skills/brigadier/hooks/handoff.mjs' # brigadier-managed-hook"
          }
        ]
      }
    ]
  }
}
`;
}

function expectedBrigadierEntry(home: string): {
  readonly hooks: readonly [
    { readonly type: "command"; readonly command: string },
  ];
} {
  return {
    hooks: [
      {
        type: "command",
        command: `'${home}/.agents/skills/brigadier/hooks/handoff.mjs' # brigadier-managed-hook`,
      },
    ],
  };
}

const SUPACODE_FIXTURE = {
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            command:
              "supacode/notify --event session_start # supacode-managed-hook",
            timeout: 5,
            type: "command",
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            command: "supacode/notify --event idle # supacode-managed-hook",
            timeout: 10,
            type: "command",
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            command: "supacode/notify --event busy # supacode-managed-hook",
            timeout: 10,
            type: "command",
          },
        ],
      },
    ],
  },
} as const;

const SUPACODE_FIXTURE_BYTES = `${JSON.stringify(SUPACODE_FIXTURE, null, 2)
  .replace('"hooks": {', '"hooks" : {')
  .replaceAll("supacode/notify", "supacode\\/notify")}\n`;

describe("Codex handoff-hook registration", () => {
  test("brigadier registers exactly one Codex event, and it is PreCompact", async () => {
    // A REGRESSION GUARD WITH A COST BEHIND IT. Codex binds hook approval to the
    // registration — event, matcher, and command together — so adding a second
    // event here does not merely add a hook: it invalidates the approval the
    // user already gave, and the handoff goes silently dead until they approve
    // again. Claude Code gets a `UserPromptSubmit` nudge for exactly this
    // reason; Codex deliberately does not. Anyone adding an event here has to
    // change this test, and changing it is where they should stop and read
    // `surfaces/codex/hooks/README.md`.
    const harness = await makeHarness();
    try {
      const result = await installCodex(harness);
      expect(result.code).toBe(0);
      const written = JSON.parse(await readFile(harness.hooksPath, "utf8")) as {
        hooks: Record<string, unknown>;
      };
      expect(Object.keys(written.hooks)).toEqual(["PreCompact"]);
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("a fresh install creates the exact PreCompact registration with an absolute shell-quoted path", async () => {
    const harness = await makeHarness("home with a space");
    try {
      const result = await installCodex(harness);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(await readFile(harness.hooksPath, "utf8")).toBe(
        expectedFreshHooks(harness.home),
      );
      expect(
        (await readdir(join(harness.home, ".codex"))).filter((name) =>
          name.includes(".brigadier-tmp-"),
        ),
      ).toEqual([]);
      expect(
        result.stdout
          .split("\n")
          .filter((line) => /^ {2}(created|updated|unchanged) /.test(line))
          .filter((line) => line.endsWith("hooks.json")),
      ).toEqual([`  created    ${harness.hooksPath}`]);
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("a forced install preserves all three supacode registrations byte-for-byte and adds brigadier", async () => {
    const harness = await makeHarness();
    try {
      await mkdir(join(harness.home, ".codex"), { recursive: true });
      await writeFile(harness.hooksPath, SUPACODE_FIXTURE_BYTES, "utf8");
      const beforeEntries = Object.fromEntries(
        Object.entries(SUPACODE_FIXTURE.hooks).map(([event, entries]) => [
          event,
          JSON.stringify(entries),
        ]),
      );

      const result = await installCodex(harness, ["codex", "--force"]);
      const afterBytes = await readFile(harness.hooksPath, "utf8");
      const after = JSON.parse(afterBytes) as {
        hooks: Record<string, unknown>;
      };
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(
        Object.fromEntries(
          ["SessionStart", "Stop", "UserPromptSubmit"].map((event) => [
            event,
            JSON.stringify(after.hooks[event]),
          ]),
        ),
      ).toEqual(beforeEntries);
      const hooksClose = SUPACODE_FIXTURE_BYTES.lastIndexOf("\n  }\n}");
      const retainedBytes = SUPACODE_FIXTURE_BYTES.slice(0, hooksClose);
      const expectedBrigadier = JSON.stringify(
        [
          {
            hooks: [
              {
                type: "command",
                command: `'${harness.home}/.agents/skills/brigadier/hooks/handoff.mjs' # brigadier-managed-hook`,
              },
            ],
          },
        ],
        null,
        2,
      );
      expect(afterBytes).toBe(
        `${retainedBytes},\n    "PreCompact": ${expectedBrigadier
          .split("\n")
          .map((line, index) => (index === 0 ? line : `    ${line}`))
          .join("\n")}${SUPACODE_FIXTURE_BYTES.slice(hooksClose)}`,
      );
      expect(afterBytes).toContain('"hooks" : {');
      expect(afterBytes.match(/supacode\\\/notify/g)?.length ?? 0).toBe(3);
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("an unrelated PreCompact registration survives beside brigadier's entry", async () => {
    const harness = await makeHarness();
    try {
      const existingEntry = {
        matcher: "compact-*",
        hooks: [
          {
            type: "command",
            command: "'/opt/another tool/precompact' --retain",
            timeout: 17,
          },
        ],
        futureOption: { mode: "strict" },
      };
      await mkdir(join(harness.home, ".codex"), { recursive: true });
      await writeFile(
        harness.hooksPath,
        `${JSON.stringify({ hooks: { PreCompact: [existingEntry] } }, null, 2)}\n`,
        "utf8",
      );

      const result = await installCodex(harness);
      const after = JSON.parse(await readFile(harness.hooksPath, "utf8")) as {
        hooks: { PreCompact: unknown[] };
      };
      expect(result.code).toBe(0);
      expect(after.hooks.PreCompact).toEqual([
        existingEntry,
        {
          hooks: [
            {
              type: "command",
              command: `'${harness.home}/.agents/skills/brigadier/hooks/handoff.mjs' # brigadier-managed-hook`,
            },
          ],
        },
      ]);
      expect(JSON.stringify(after.hooks.PreCompact[0])).toBe(
        JSON.stringify(existingEntry),
      );
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("a marked hook beside a foreign sibling stays byte-for-byte intact and brigadier appends", async () => {
    const harness = await makeHarness();
    try {
      const foreignEntry = `{"matcher":"foreign","hooks":[
      {"type":"command","command":"awk '{ print $1 }' # brigadier-managed-hook"},
      {"type":"command","command":"other-tool --keep-me"}]}`;
      const original = `{"hooks":{"PreCompact":[${foreignEntry}]}}\n`;
      const expected = `{"hooks":{"PreCompact":[${foreignEntry},
      {
        "hooks": [
          {
            "type": "command",
            "command": "'${harness.home}/.agents/skills/brigadier/hooks/handoff.mjs' # brigadier-managed-hook"
          }
        ]
      }
    ]}}\n`;
      await mkdir(join(harness.home, ".codex"), { recursive: true });
      await writeFile(harness.hooksPath, original, "utf8");

      const result = await installCodex(harness);
      const afterBytes = await readFile(harness.hooksPath, "utf8");
      const after = JSON.parse(afterBytes) as {
        hooks: { PreCompact: unknown[] };
      };
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(afterBytes).toBe(expected);
      expect(afterBytes.includes(foreignEntry)).toBe(true);
      expect(after.hooks.PreCompact).toEqual([
        {
          matcher: "foreign",
          hooks: [
            {
              type: "command",
              command: "awk '{ print $1 }' # brigadier-managed-hook",
            },
            { type: "command", command: "other-tool --keep-me" },
          ],
        },
        expectedBrigadierEntry(harness.home),
      ]);
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("a marked single hook with a matcher is foreign and stays byte-for-byte intact", async () => {
    const harness = await makeHarness();
    try {
      const foreignEntry =
        '{ "matcher" : "foreign", "hooks" : [{"type":"command","command":"foreign-tool # brigadier-managed-hook"}] }';
      const original = `{"hooks":{"PreCompact":[${foreignEntry}]}}\n`;
      const expected = `{"hooks":{"PreCompact":[${foreignEntry},
      {
        "hooks": [
          {
            "type": "command",
            "command": "'${harness.home}/.agents/skills/brigadier/hooks/handoff.mjs' # brigadier-managed-hook"
          }
        ]
      }
    ]}}\n`;
      await mkdir(join(harness.home, ".codex"), { recursive: true });
      await writeFile(harness.hooksPath, original, "utf8");

      const result = await installCodex(harness);
      const afterBytes = await readFile(harness.hooksPath, "utf8");
      const after = JSON.parse(afterBytes) as {
        hooks: { PreCompact: unknown[] };
      };
      expect(result.code).toBe(0);
      expect(afterBytes).toBe(expected);
      expect(afterBytes.includes(foreignEntry)).toBe(true);
      expect(after.hooks.PreCompact).toEqual([
        {
          matcher: "foreign",
          hooks: [
            {
              type: "command",
              command: "foreign-tool # brigadier-managed-hook",
            },
          ],
        },
        expectedBrigadierEntry(harness.home),
      ]);
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("replacing brigadier's own entry preserves every retained foreign entry byte", async () => {
    const harness = await makeHarness();
    try {
      const foreignEntry = `{
\t"matcher" : "foreign-format",
\t"hooks" : [ { "type" : "command", "command" : "keep-format" } ]
}`;
      const oldBrigadier =
        '{"hooks":[{"type":"command","command":"old/path # brigadier-managed-hook"}]}';
      const original = `{"hooks":{"PreCompact":[${foreignEntry},${oldBrigadier}]}}\n`;
      const desired = JSON.stringify(expectedBrigadierEntry(harness.home));
      const expected = `{"hooks":{"PreCompact":[${foreignEntry},${desired}]}}\n`;
      await mkdir(join(harness.home, ".codex"), { recursive: true });
      await writeFile(harness.hooksPath, original, "utf8");

      const result = await installCodex(harness);
      const afterBytes = await readFile(harness.hooksPath, "utf8");
      expect(result.code).toBe(0);
      expect(afterBytes).toBe(expected);
      expect(afterBytes.includes(foreignEntry)).toBe(true);
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("installing twice leaves exactly one marked brigadier entry", async () => {
    const harness = await makeHarness();
    try {
      const first = await installCodex(harness);
      const firstBytes = await readFile(harness.hooksPath, "utf8");
      const second = await installCodex(harness);
      const secondBytes = await readFile(harness.hooksPath, "utf8");
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(second.stderr).toBe("");
      expect(secondBytes).toBe(firstBytes);
      expect(secondBytes.match(/# brigadier-managed-hook/g)?.length ?? 0).toBe(
        1,
      );
      expect(
        (
          JSON.parse(secondBytes) as {
            hooks: { PreCompact: unknown[] };
          }
        ).hooks.PreCompact,
      ).toEqual([expectedBrigadierEntry(harness.home)]);
      expect(
        second.stdout
          .split("\n")
          .filter((line) => /^ {2}(created|updated|unchanged) /.test(line))
          .filter((line) => line.endsWith("hooks.json")),
      ).toEqual([`  unchanged  ${harness.hooksPath}`]);
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("an existing hooks.json keeps mode 0600 and a new one is created as 0644", async () => {
    const existing = await makeHarness("existing-home");
    const fresh = await makeHarness("fresh-home");
    try {
      await mkdir(join(existing.home, ".codex"), { recursive: true });
      await writeFile(
        existing.hooksPath,
        '{"hooks":{"PreCompact":[]}}\n',
        "utf8",
      );
      await chmod(existing.hooksPath, 0o600);

      const updated = await installCodex(existing);
      const created = await installCodex(fresh);
      expect(updated.code).toBe(0);
      expect(created.code).toBe(0);
      expect((await stat(existing.hooksPath)).mode & 0o777).toBe(0o600);
      expect((await stat(fresh.hooksPath)).mode & 0o777).toBe(0o644);
      await assertHarnessSafe(existing);
      await assertHarnessSafe(fresh);
    } finally {
      await rm(existing.scratch, { recursive: true, force: true });
      await rm(fresh.scratch, { recursive: true, force: true });
    }
  });

  test("a failed shared-file write leaves the original bytes and no atomic temporary file", async () => {
    const harness = await makeHarness();
    try {
      const original = '{"hooks":{"PreCompact":[]},"owner":"foreign"}\n';
      await mkdir(join(harness.home, ".codex"), { recursive: true });
      await writeFile(harness.hooksPath, original, "utf8");
      const failingIo = {
        ...harness.fs,
        async writeFile(
          path: string,
          contents: string,
          mode: number,
          expected: Parameters<SurfaceIo["writeFile"]>[3],
        ) {
          if (path === harness.hooksPath) {
            await nodeSurfaceIo.writeFile(path, "", mode, expected);
            throw new Error("injected interruption after truncation");
          }
          await harness.fs.writeFile(path, contents, mode, expected);
        },
        async writeFileAtomic(
          path: string,
          _contents: string,
          _mode: number,
          _expected: Parameters<SurfaceIo["writeFile"]>[3],
        ) {
          if (path === harness.hooksPath) {
            throw new Error("injected atomic write failure");
          }
          throw new Error(`unexpected atomic write to ${path}`);
        },
      } as SurfaceIo;

      const result = await installCodex(harness, ["codex"], failingIo);
      expect(result.code).toBe(1);
      expect(await readFile(harness.hooksPath, "utf8")).toBe(original);
      expect(
        (await readdir(join(harness.home, ".codex"))).filter((name) =>
          name.includes(".brigadier-tmp-"),
        ),
      ).toEqual([]);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("the atomic writer removes its temporary file when pre-rename verification fails", async () => {
    const harness = await makeHarness();
    try {
      const codexHome = join(harness.home, ".codex");
      const original = '{"hooks":{"PreCompact":[]},"owner":"foreign"}\n';
      await mkdir(codexHome, { recursive: true });
      await writeFile(harness.hooksPath, original, "utf8");
      await chmod(harness.hooksPath, 0o600);
      const snapshot = await nodeSurfaceIo.readFile(harness.hooksPath);

      const tamperAfterTemporaryCreation = (async (): Promise<void> => {
        for (let attempt = 0; attempt < 5_000; attempt += 1) {
          const names = await readdir(codexHome);
          if (names.some((name) => name.includes(".brigadier-tmp-"))) {
            await chmod(harness.hooksPath, 0o640);
            return;
          }
          await Bun.sleep(1);
        }
        throw new Error("atomic temporary file did not appear");
      })();
      const writing = nodeSurfaceIo.writeFileAtomic(
        harness.hooksPath,
        "replacement bytes\n".repeat(1_000_000),
        0o644,
        snapshot,
      );

      await tamperAfterTemporaryCreation;
      await expect(writing).rejects.toThrow(
        `refusing to replace ${harness.hooksPath}: it changed after brigadier inspected it`,
      );
      expect(await readFile(harness.hooksPath, "utf8")).toBe(original);
      expect(
        (await readdir(codexHome)).filter((name) =>
          name.includes(".brigadier-tmp-"),
        ),
      ).toEqual([]);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("malformed JSON aborts before any write and leaves the exact bytes intact", async () => {
    const harness = await makeHarness();
    try {
      const malformed = '{"hooks":{"PreCompact":[}\nHAND EDIT\n';
      await mkdir(join(harness.home, ".codex"), { recursive: true });
      await writeFile(harness.hooksPath, malformed, "utf8");

      const result = await installCodex(harness, ["codex", "--force"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `brigadier install: could not parse ${harness.hooksPath}. Fix the malformed JSON and re-run; brigadier left the file unchanged.\n`,
      );
      expect(await readFile(harness.hooksPath, "utf8")).toBe(malformed);
      expect(harness.writes).toEqual([]);
      expect(
        await fileIsMissing(join(harness.home, ".brigadier/surfaces.json")),
      ).toBe(true);
      expect(await fileIsMissing(join(harness.home, ".codex/AGENTS.md"))).toBe(
        true,
      );
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("an unknown future event and unknown root keys are preserved exactly", async () => {
    const harness = await makeHarness();
    try {
      const futureEvent = [
        {
          matcher: { branch: "future" },
          hooks: [
            {
              type: "future-type",
              command: "future/command --flag",
              futureHookKey: [1, "two", false],
            },
          ],
        },
      ];
      const existing = {
        schemaVersion: 99,
        futureRootKey: { retained: true },
        hooks: { WorkspaceTeleported: futureEvent },
      };
      const existingBytes = `${JSON.stringify(existing, null, 2)
        .replace("WorkspaceTeleported", "\\u0057orkspaceTeleported")
        .replace("future/command", "future\\/command")}\n`;
      await mkdir(join(harness.home, ".codex"), { recursive: true });
      await writeFile(harness.hooksPath, existingBytes, "utf8");

      const result = await installCodex(harness);
      const afterBytes = await readFile(harness.hooksPath, "utf8");
      const after = JSON.parse(afterBytes) as {
        schemaVersion: number;
        futureRootKey: unknown;
        hooks: Record<string, unknown>;
      };
      expect(result.code).toBe(0);
      expect(after.schemaVersion).toBe(99);
      expect(after.futureRootKey).toEqual({ retained: true });
      expect(JSON.stringify(after.hooks.WorkspaceTeleported)).toBe(
        JSON.stringify(futureEvent),
      );
      expect(Object.keys(after.hooks)).toEqual([
        "WorkspaceTeleported",
        "PreCompact",
      ]);
      expect(afterBytes).toContain('"\\u0057orkspaceTeleported"');
      expect(afterBytes).toContain('"command": "future\\/command --flag"');
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });

  test("dry-run neither creates hooks.json nor changes existing bytes", async () => {
    const harness = await makeHarness();
    try {
      const absent = await installCodex(harness, ["codex", "--dry-run"]);
      expect(absent.code).toBe(0);
      expect(await fileIsMissing(harness.hooksPath)).toBe(true);
      expect(
        absent.stdout
          .split("\n")
          .filter((line) => /^ {2}(created|updated|unchanged) /.test(line))
          .filter((line) => line.endsWith("hooks.json")),
      ).toEqual([`  created    ${harness.hooksPath}`]);
      expect(harness.writes).toEqual([]);

      const original = '{ "future": true, "hooks": { "Stop": [] } }\n';
      await mkdir(join(harness.home, ".codex"), { recursive: true });
      await writeFile(harness.hooksPath, original, "utf8");
      const existing = await installCodex(harness, ["codex", "--dry-run"]);
      expect(existing.code).toBe(0);
      expect(existing.stderr).toBe("");
      expect(await readFile(harness.hooksPath, "utf8")).toBe(original);
      expect(
        existing.stdout
          .split("\n")
          .filter((line) => /^ {2}(created|updated|unchanged) /.test(line))
          .filter((line) => line.endsWith("hooks.json")),
      ).toEqual([`  updated    ${harness.hooksPath}`]);
      expect(harness.writes).toEqual([]);
      await assertHarnessSafe(harness);
    } finally {
      await rm(harness.scratch, { recursive: true, force: true });
    }
  });
});
