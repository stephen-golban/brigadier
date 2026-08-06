import { resolve } from "node:path";

const fixtureDirectory = resolve(import.meta.dir, "../../test/fixtures");

export function scenario(): string {
  const value = process.env.BRIGADIER_FAKE_SCENARIO;
  if (value === undefined) {
    fail("BRIGADIER_FAKE_SCENARIO is required", 64);
  }
  return value;
}

export function assertArgv(
  actual: readonly string[],
  errorExitCode: number,
): void {
  const encoded = process.env.BRIGADIER_FAKE_EXPECTED_ARGV;
  if (encoded === undefined) {
    fail("BRIGADIER_FAKE_EXPECTED_ARGV is required", errorExitCode);
  }

  let expected: unknown;
  try {
    expected = JSON.parse(encoded);
  } catch {
    fail("BRIGADIER_FAKE_EXPECTED_ARGV must be JSON", errorExitCode);
  }

  if (
    !Array.isArray(expected) ||
    !expected.every((argument) => typeof argument === "string")
  ) {
    fail("BRIGADIER_FAKE_EXPECTED_ARGV must be a string array", errorExitCode);
  }

  if (
    actual.length !== expected.length ||
    actual.some((argument, index) => argument !== expected[index])
  ) {
    fail(
      `argv mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      errorExitCode,
    );
  }
}

export async function readPrompt(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

export type ClaudeStdinLifecycle = "write-then-close" | "keep-open";

export interface ClaudeStdin {
  readonly prompt: string;
  /** Resolves immediately for one-shot stdin, or at EOF for control stdin. */
  readonly waitForEof: () => Promise<void>;
}

export async function readClaudeStdin(): Promise<ClaudeStdin> {
  const lifecycle = process.env.BRIGADIER_FAKE_STDIN_LIFECYCLE;
  if (lifecycle === "write-then-close") {
    return {
      prompt: await readPrompt(),
      waitForEof: async () => {},
    };
  }
  if (lifecycle !== "keep-open") {
    fail(
      "BRIGADIER_FAKE_STDIN_LIFECYCLE must be write-then-close or keep-open",
      64,
    );
  }

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      fail("keep-open Claude stdin ended before the prompt newline", 1);
    }
    buffered += decoder.decode(chunk.value, { stream: true });
  }

  const newline = buffered.indexOf("\n");
  const prompt = buffered.slice(0, newline + 1);
  return {
    prompt,
    waitForEof: async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          decoder.decode();
          return;
        }
        decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

export function assertPrompt(actual: string, errorExitCode: number): void {
  const expected = process.env.BRIGADIER_FAKE_EXPECTED_STDIN;
  if (expected === undefined) {
    fail("BRIGADIER_FAKE_EXPECTED_STDIN is required", errorExitCode);
  }

  if (actual.replace(/\r?\n$/, "") !== expected) {
    fail(
      `stdin mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      errorExitCode,
    );
  }
}

export async function fixtureText(name: string): Promise<string> {
  return Bun.file(resolve(fixtureDirectory, name)).text();
}

export async function writeFixture(name: string): Promise<void> {
  process.stdout.write(await fixtureText(name));
}

export function fail(message: string, exitCode: number): never {
  console.error(message);
  process.exit(exitCode);
}
