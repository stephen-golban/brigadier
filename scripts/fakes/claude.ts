#!/usr/bin/env bun

import {
  assertArgv,
  assertPrompt,
  fail,
  fixtureText,
  readClaudeStdin,
  scenario,
  writeFixture,
} from "./harness.ts";

const fixtures: Readonly<Record<string, string>> = {
  "api-retry": "claude-api-retry.jsonl",
  "bad-model": "claude-bad-model.jsonl",
  "budget-exhaustion": "claude-budget-exhaustion.jsonl",
  "rate-limit": "claude-rate-limit.jsonl",
  "rate-limit-allowed": "claude-rate-limit-allowed.jsonl",
  "rate-limit-rejected": "claude-rate-limit-rejected.jsonl",
  success: "claude-success.jsonl",
  "unicode-separator": "claude-u2028.jsonl",
};

const selectedScenario = scenario();
assertArgv(Bun.argv.slice(2), 1);
const stdin = await readClaudeStdin();
assertPrompt(stdin.prompt, 1);

if (selectedScenario === "long-silence") {
  const lines = (await fixtureText("claude-long-silence.jsonl"))
    .trimEnd()
    .split("\n");
  const firstLine = lines.shift();
  if (firstLine === undefined) {
    fail("long-silence fixture must not be empty", 64);
  }
  process.stdout.write(`${firstLine}\n`);

  const configuredDelay = process.env.BRIGADIER_FAKE_SILENCE_MS;
  const delayMs =
    configuredDelay === undefined ? 405_000 : Number(configuredDelay);
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    fail("BRIGADIER_FAKE_SILENCE_MS must be a non-negative number", 64);
  }
  await Bun.sleep(delayMs);
  process.stdout.write(`${lines.join("\n")}\n`);
  await stdin.waitForEof();
  process.exit(0);
}

if (selectedScenario === "grandchild-pipe") {
  const grandchild = Bun.spawn(
    ["/bin/sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 60; done"],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  grandchild.unref();
  process.stdout.write('{"type":"system","subtype":"grandchild_pipe_open"}\n');
  await stdin.waitForEof();
  process.exit(0);
}

const fixture = fixtures[selectedScenario];
if (fixture === undefined) {
  fail(`Unknown Claude fixture scenario: ${selectedScenario}`, 64);
}

await writeFixture(fixture);
await stdin.waitForEof();
if (
  selectedScenario === "bad-model" ||
  selectedScenario === "budget-exhaustion"
) {
  process.exitCode = 1;
}
