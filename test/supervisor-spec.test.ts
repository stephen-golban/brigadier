import { describe, expect, test } from "bun:test";
import {
  type ClaudeWorkerSpec,
  type CodexWorkerSpec,
  createIdleTimeoutMs,
  DEFAULT_IDLE_TIMEOUT_MS,
  IDLE_TIMEOUT_BOUNDARY_MS,
  type Slice,
} from "../src/contracts.js";
import type { RoutedWorker } from "../src/routing/contracts.js";
import { buildWorkerSpec } from "../src/supervisor/spec.js";
import { buildClaudeCommand } from "../src/worker/claude.js";
import { buildCodexCommand } from "../src/worker/codex.js";

const SLICE: Slice = {
  id: "slice-auth",
  title: "Implement authentication",
  prompt: "Implement the authentication flow and its focused tests.",
  ownedPaths: ["src/auth.ts", "test/auth.test.ts"],
  dependsOn: ["slice-contracts"],
};

const ENV = {
  HOME: "/Users/worker",
  PATH: "/opt/brigadier/bin:/usr/bin:/bin",
  USER: "worker",
};

const CLAUDE_ROUTE: RoutedWorker = {
  vendor: "claude",
  model: "claude-routed-model",
  effort: "high",
  rationale: ["competence: 95", "effort: high"],
  waivedDifficultyFloor: false,
};

const CODEX_ROUTE: RoutedWorker = {
  vendor: "codex",
  model: "codex-routed-model",
  effort: "xhigh",
  rationale: ["competence: 94", "effort: xhigh"],
  waivedDifficultyFloor: false,
};

describe("buildWorkerSpec", () => {
  test("builds the exact Claude spec from the routed decision", () => {
    const spec = buildWorkerSpec({
      slice: SLICE,
      routed: CLAUDE_ROUTE,
      worktreePath: "/worktrees/run-17/slice-auth",
      env: { ...ENV, AWS_SECRET_ACCESS_KEY: "must-not-leak" },
    });

    expect(spec).toEqual({
      id: "slice-auth",
      vendor: "claude",
      model: "claude-routed-model",
      effort: "high",
      prompt:
        "You may edit only these owned paths:\n- src/auth.ts\n- test/auth.test.ts\n\nImplement the authentication flow and its focused tests.",
      cwd: "/worktrees/run-17/slice-auth",
      environment: {
        HOME: "/Users/worker",
        PATH: "/opt/brigadier/bin:/usr/bin:/bin",
        USER: "worker",
        SHELL: "/bin/sh",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        filesystem: {
          workspaceAccess: "edit",
          editablePaths: ["src/auth.ts", "test/auth.test.ts"],
        },
        network: { allowedDomains: [] },
      },
      instructionFiles: { user: "exclude", project: "include" },
      idleTimeoutMs: createIdleTimeoutMs(900_000),
      timeoutMs: 3_600_000,
      maxTurns: null,
      maxBudgetUsd: null,
      excludeDynamicSystemPromptSections: true,
      tools: ["Edit", "Glob", "Grep", "Read", "Write"],
      extraDirectories: [],
      mcp: { configFiles: [], strict: true },
    });
  });

  test("builds the exact Codex spec and remains discriminated without casts", () => {
    const spec = buildWorkerSpec({
      slice: SLICE,
      routed: CODEX_ROUTE,
      worktreePath: "/worktrees/run-17/slice-auth",
      env: { ...ENV, AWS_SECRET_ACCESS_KEY: "must-not-leak" },
    });

    expect(spec).toEqual({
      id: "slice-auth",
      vendor: "codex",
      model: "codex-routed-model",
      effort: "xhigh",
      prompt:
        "You may edit only these owned paths:\n- src/auth.ts\n- test/auth.test.ts\n\nImplement the authentication flow and its focused tests.",
      cwd: "/worktrees/run-17/slice-auth",
      environment: {
        HOME: "/Users/worker",
        PATH: "/opt/brigadier/bin:/usr/bin:/bin",
        USER: "worker",
        SHELL: "/bin/sh",
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        filesystem: {
          workspaceAccess: "edit",
          editablePaths: ["src/auth.ts", "test/auth.test.ts"],
        },
        network: { allowedDomains: [] },
      },
      instructionFiles: { user: "exclude", project: "include" },
      idleTimeoutMs: createIdleTimeoutMs(900_000),
      timeoutMs: 3_600_000,
      maxTurns: null,
    });

    if (spec.vendor === "codex") {
      expectCodex(spec);
      expect(spec.model).toBe("codex-routed-model");
    } else {
      expectClaude(spec);
      expect(spec.model).toBe("codex-routed-model");
    }
  });

  test("keeps the required USER identity in both vendor environments", () => {
    for (const routed of [CLAUDE_ROUTE, CODEX_ROUTE]) {
      const spec = buildWorkerSpec({
        slice: SLICE,
        routed,
        worktreePath: "/worktrees/run-17/slice-auth",
        env: ENV,
      });

      expect(
        spec.environment.USER,
        `${routed.vendor} worker USER must be "worker"; Claude Code cannot authenticate without USER, so it is required for both vendors by the shared environment policy`,
      ).toBe("worker");
    }
  });

  test("uses explicit timeout and turn overrides and validates idle timeout", () => {
    const spec = buildWorkerSpec({
      slice: SLICE,
      routed: CODEX_ROUTE,
      worktreePath: "/worktrees/run-17/slice-auth",
      env: ENV,
      idleTimeoutMs: IDLE_TIMEOUT_BOUNDARY_MS + 1,
      timeoutMs: null,
      maxTurns: 4,
    });

    expect(Number(spec.idleTimeoutMs)).toBe(600_001);
    expect(spec.timeoutMs).toBeNull();
    expect(spec.maxTurns).toBe(4);
    expect(Number(DEFAULT_IDLE_TIMEOUT_MS)).toBe(900_000);
    expect(() =>
      buildWorkerSpec({
        slice: SLICE,
        routed: CODEX_ROUTE,
        worktreePath: "/worktrees/run-17/slice-auth",
        env: ENV,
        idleTimeoutMs: 600_000,
      }),
    ).toThrow("idle timeout must be a whole number above 600000 ms");
  });

  test("keeps Bash out of the Claude tool lane", () => {
    const spec = buildWorkerSpec({
      slice: SLICE,
      routed: CLAUDE_ROUTE,
      worktreePath: "/worktrees/run-17/slice-auth",
      env: ENV,
    });
    if (spec.vendor !== "claude") {
      throw new Error("expected the Claude route to produce a Claude spec");
    }
    if (spec.tools.includes("Bash")) {
      throw new Error(
        "Claude tools must exclude Bash: Edit(glob) and Write(glob) rules do not constrain shell writes, so Bash would widen the worker lane to the whole filesystem",
      );
    }

    expect(spec.tools).toEqual(["Edit", "Glob", "Grep", "Read", "Write"]);
  });

  /**
   * The injection this guard exists for. Claude's lane is one `--allowedTools`
   * argument of comma-joined `Edit(<path>)` and `Write(<path>)` rules, so an
   * owned path spelled `owned),Edit(package.json` closes its own rule and opens
   * a second one for a file the slice does not own. The plan gate rejects these
   * first; this is the second layer, at the last point an owned path is seen
   * before it becomes a vendor permission rule.
   *
   * BOTH RULE KINDS ARE ATTACKABLE THE SAME WAY, which is why the `Write` spelling
   * is here beside the `Edit` one: the payload that forges a create permission for
   * `package.json` is exactly as damaging as the one that forges an edit
   * permission for it, and the guard is a property of the characters rather than
   * of the rule name, so neither can be refused without the other.
   */
  test("refuses an owned path that would inject a second Claude permission rule", () => {
    const payloads = [
      "owned),Edit(package.json",
      "owned),Write(package.json",
    ] as const;

    for (const payload of payloads) {
      const injected: Slice = {
        ...SLICE,
        ownedPaths: ["src/auth.ts", payload],
      };
      for (const routed of [CLAUDE_ROUTE, CODEX_ROUTE]) {
        expect(() =>
          buildWorkerSpec({
            slice: injected,
            routed,
            worktreePath: "/worktrees/run-17/slice-auth",
            env: ENV,
          }),
        ).toThrow(
          `refusing to build a worker spec for slice "slice-auth": owned path ${JSON.stringify(payload)} contains U+0028, U+0029, U+002C, which can alter a vendor's lane grammar`,
        );
      }
    }
  });

  test("refuses the characters that would break Codex's quoted lane profile", () => {
    const cases: readonly (readonly [string, string])[] = [
      [
        'src/a".ts',
        'refusing to build a worker spec for slice "slice-auth": owned path "src/a\\".ts" contains U+0022, which can alter a vendor\'s lane grammar',
      ],
      [
        "src/a\\b.ts",
        'refusing to build a worker spec for slice "slice-auth": owned path "src/a\\\\b.ts" contains U+005C, which can alter a vendor\'s lane grammar',
      ],
      [
        "src/a\u0000b.ts",
        'refusing to build a worker spec for slice "slice-auth": owned path "src/a\\u0000b.ts" contains U+0000, which can alter a vendor\'s lane grammar',
      ],
      [
        "src/a\nb.ts",
        'refusing to build a worker spec for slice "slice-auth": owned path "src/a\\nb.ts" contains U+000A, which can alter a vendor\'s lane grammar',
      ],
    ];

    for (const [ownedPath, message] of cases) {
      expect(() =>
        buildWorkerSpec({
          slice: { ...SLICE, ownedPaths: [ownedPath] },
          routed: CODEX_ROUTE,
          worktreePath: "/worktrees/run-17/slice-auth",
          env: ENV,
        }),
      ).toThrow(message);
    }
  });

  test("leaves ordinary owned paths alone", () => {
    const spec = buildWorkerSpec({
      slice: {
        ...SLICE,
        ownedPaths: ["src/a b.ts", "src/it's.ts", "src/{x}.ts", "src/a=b.ts"],
      },
      routed: CODEX_ROUTE,
      worktreePath: "/worktrees/run-17/slice-auth",
      env: ENV,
    });

    expect(spec.sandbox.filesystem.editablePaths).toEqual([
      "src/a b.ts",
      "src/it's.ts",
      "src/{x}.ts",
      "src/a=b.ts",
    ]);
  });

  /**
   * Verified against the installed codex-cli 0.145.0, not assumed:
   * `codex exec --help` documents `--ignore-user-config` as "auth still uses
   * `CODEX_HOME`"; `CODEX_HOME=<empty dir> codex doctor --json` reports
   * `auth.credentials: fail`; the same command against a directory holding a
   * copy of `auth.json` reports `ok`; and a real `codex exec` under the empty
   * directory fails with `401 Unauthorized`.
   */
  test("passes a configured CODEX_HOME to a Codex worker only, and never invents one", () => {
    const withHome = buildWorkerSpec({
      slice: SLICE,
      routed: CODEX_ROUTE,
      worktreePath: "/worktrees/run-17/slice-auth",
      env: { ...ENV, CODEX_HOME: "/Users/worker/.codex-work" },
    });
    expect(withHome.environment).toEqual({
      HOME: "/Users/worker",
      PATH: "/opt/brigadier/bin:/usr/bin:/bin",
      USER: "worker",
      SHELL: "/bin/sh",
      CODEX_HOME: "/Users/worker/.codex-work",
    });

    // Claude has no use for it, and the minimal environment admits nothing a
    // vendor does not need.
    const claude = buildWorkerSpec({
      slice: SLICE,
      routed: CLAUDE_ROUTE,
      worktreePath: "/worktrees/run-17/slice-auth",
      env: { ...ENV, CODEX_HOME: "/Users/worker/.codex-work" },
    });
    expect(claude.environment).toEqual({
      HOME: "/Users/worker",
      PATH: "/opt/brigadier/bin:/usr/bin:/bin",
      USER: "worker",
      SHELL: "/bin/sh",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });

    // Unset and empty both mean "let Codex resolve it": a default invented here
    // would replace the vendor's own fallback with a guess.
    for (const env of [ENV, { ...ENV, CODEX_HOME: "" }]) {
      const spec = buildWorkerSpec({
        slice: SLICE,
        routed: CODEX_ROUTE,
        worktreePath: "/worktrees/run-17/slice-auth",
        env,
      });
      expect(spec.environment).toEqual({
        HOME: "/Users/worker",
        PATH: "/opt/brigadier/bin:/usr/bin:/bin",
        USER: "worker",
        SHELL: "/bin/sh",
      });
    }
  });

  test("feeds the Claude spec into the adapter with exact launch argv", () => {
    const spec = buildWorkerSpec({
      slice: SLICE,
      routed: CLAUDE_ROUTE,
      worktreePath: "/worktrees/run-17/slice-auth",
      env: ENV,
    });
    if (spec.vendor !== "claude") {
      throw new Error("expected the Claude route to produce a Claude spec");
    }

    expect(buildClaudeCommand(spec, "/opt/claude/bin/claude")).toEqual([
      "/opt/claude/bin/claude",
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--model",
      "claude-routed-model",
      "--effort",
      "high",
      "--exclude-dynamic-system-prompt-sections",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Edit,Glob,Grep,Read,Write",
      "--allowedTools",
      "Edit(src/auth.ts),Write(src/auth.ts),Edit(test/auth.test.ts),Write(test/auth.test.ts)",
      "--disallowedTools",
      "WebFetch,WebSearch",
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
    ]);
  });

  test("feeds the Codex spec into the adapter with exact launch argv", () => {
    const spec = buildWorkerSpec({
      slice: SLICE,
      routed: CODEX_ROUTE,
      worktreePath: "/worktrees/run-17/slice-auth",
      env: ENV,
    });
    if (spec.vendor !== "codex") {
      throw new Error("expected the Codex route to produce a Codex spec");
    }

    expect(buildCodexCommand(spec, "/opt/codex/bin/codex")).toEqual([
      "/opt/codex/bin/codex",
      "exec",
      "--json",
      "--model",
      "codex-routed-model",
      "-c",
      "model_reasoning_effort=xhigh",
      "-c",
      'default_permissions="brigadier_lane"',
      "-c",
      'permissions.brigadier_lane={filesystem={":root"="read",":workspace_roots"={"."="read","src/auth.ts"="write","test/auth.test.ts"="write"}},network={enabled=false}}',
      "--ignore-user-config",
      "-",
    ]);
  });
});

function expectClaude(spec: ClaudeWorkerSpec): void {
  expect(spec.vendor).toBe("claude");
}

function expectCodex(spec: CodexWorkerSpec): void {
  expect(spec.vendor).toBe("codex");
}
