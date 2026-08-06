#!/usr/bin/env bun

import {
  assertArgv,
  assertPrompt,
  fail,
  readPrompt,
  scenario,
  writeFixture,
} from "./harness.ts";

const selectedScenario = scenario();
assertArgv(Bun.argv.slice(2), 2);

if (selectedScenario === "app-server") {
  const decoder = new TextDecoder();
  let buffered = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      respondToRpc(line);
    }
  }

  const trailing = buffered + decoder.decode();
  if (trailing.trim().length > 0) {
    respondToRpc(trailing);
  }
  process.exit(0);
}

if (selectedScenario === "argv-error") {
  console.error(
    await Bun.file(
      `${import.meta.dir}/../../test/fixtures/codex-argv-error.txt`,
    ).text(),
  );
  process.exit(2);
}

const prompt = await readPrompt();
assertPrompt(prompt, 2);

const fixtureByScenario: Readonly<Record<string, string>> = {
  failure: "codex-failure.jsonl",
  success: "codex-success.jsonl",
};
const fixture = fixtureByScenario[selectedScenario];
if (fixture === undefined) {
  fail(`Unknown Codex fixture scenario: ${selectedScenario}`, 64);
}

await writeFixture(fixture);
if (selectedScenario === "failure") {
  process.exitCode = 1;
}

function respondToRpc(line: string): void {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
    );
    return;
  }

  if (!isRpcRequest(request)) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } })}\n`,
    );
    return;
  }

  if (request.method === "account/rateLimits/read") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          rateLimits: {
            primary: {
              usedPercent: 12,
              windowDurationMins: 300,
              resetsAt: 1_786_026_000,
            },
            secondary: {
              usedPercent: 34,
              windowDurationMins: 10_080,
              resetsAt: 1_786_458_000,
            },
          },
        },
      })}\n`,
    );
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Method not found" },
    })}\n`,
  );
}

function isRpcRequest(value: unknown): value is {
  readonly jsonrpc: "2.0";
  readonly id: unknown;
  readonly method: string;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.jsonrpc === "2.0" &&
    "id" in candidate &&
    typeof candidate.method === "string"
  );
}
