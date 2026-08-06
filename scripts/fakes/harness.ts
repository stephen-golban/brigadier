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
