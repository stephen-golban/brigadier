import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const fakeBin = resolve(repositoryRoot, "scripts/fakes");
const fixtureDirectory = resolve(import.meta.dir, "fixtures");

interface ReplayCase {
  readonly name: string;
  readonly executable: "claude" | "codex";
  readonly args: readonly string[];
  readonly scenario: string;
  readonly fixture: string;
  readonly exitCode: number;
}

const cases: readonly ReplayCase[] = [
  {
    name: "Claude success",
    executable: "claude",
    args: ["-p", "--output-format", "stream-json"],
    scenario: "success",
    fixture: "claude-success.jsonl",
    exitCode: 0,
  },
  {
    name: "Claude bad model",
    executable: "claude",
    args: ["-p", "--output-format", "stream-json"],
    scenario: "bad-model",
    fixture: "claude-bad-model.jsonl",
    exitCode: 1,
  },
  {
    name: "Claude rate limit warning",
    executable: "claude",
    args: ["-p", "--output-format", "stream-json"],
    scenario: "rate-limit",
    fixture: "claude-rate-limit.jsonl",
    exitCode: 0,
  },
  {
    name: "Codex success",
    executable: "codex",
    args: ["exec", "--json"],
    scenario: "success",
    fixture: "codex-success.jsonl",
    exitCode: 0,
  },
  {
    name: "Codex failure",
    executable: "codex",
    args: ["exec", "--json"],
    scenario: "failure",
    fixture: "codex-failure.jsonl",
    exitCode: 1,
  },
];

describe("fake worker executables", () => {
  for (const replayCase of cases) {
    test(`replays ${replayCase.name}`, async () => {
      const currentPath = process.env.PATH;
      if (currentPath === undefined) {
        throw new Error("PATH must be set for fake executable tests");
      }

      const processHandle = Bun.spawn(
        [replayCase.executable, ...replayCase.args],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            BRIGADIER_FAKE_SCENARIO: replayCase.scenario,
            PATH: `${fakeBin}:${currentPath}`,
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );

      const [stdout, stderr, exitCode, expected] = await Promise.all([
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
        processHandle.exited,
        Bun.file(resolve(fixtureDirectory, replayCase.fixture)).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(replayCase.exitCode);
      expect(stdout).toBe(expected);
    });
  }
});
