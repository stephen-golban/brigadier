import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";

const repositoryRoot = resolve(import.meta.dir, "..");
const workflowPath = join(
  repositoryRoot,
  ".github",
  "workflows",
  "release.yml",
);
const GUARD_STEP_NAME = "Verify tag matches package version";

/**
 * The text this test executes is read out of `.github/workflows/release.yml` at
 * run time and run verbatim. It is never transcribed into this file: a test that
 * re-implemented the guard would only prove the transcription self-consistent,
 * and would keep passing after someone deleted the real step. Edit the guard in
 * the workflow and this test sees the edit.
 */
const guardStepScript = extractStepRun(
  readFileSync(workflowPath, "utf8"),
  GUARD_STEP_NAME,
);

interface GuardResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

test("the release workflow's tag guard passes for the tag naming the packaged version", () => {
  const result = runGuardStep({
    cwd: repositoryRoot,
    tagName: `v${packageJson.version}`,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("the release workflow's tag guard fails for a tag that does not match the packaged version", () => {
  const result = runGuardStep({ cwd: repositoryRoot, tagName: "v999.999.999" });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    `verify-tag-version: tag v999.999.999 does not match package version ${packageJson.version}\n`,
  );
});

test("the release workflow's tag guard fails when no tag name reaches it", () => {
  const result = runGuardStep({ cwd: repositoryRoot });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "verify-tag-version: GITHUB_REF_NAME is unset or empty\n",
  );
});

test("the release workflow's tag guard fails when a platform pin drifts from the packaged version", () => {
  const checkout = syntheticCheckout({
    name: "@stephen-golban/brigadier",
    version: "1.2.3",
    optionalDependencies: {
      "@stephen-golban/brigadier-darwin-arm64": "1.2.3",
      "@stephen-golban/brigadier-darwin-x64": "1.2.2",
      "@stephen-golban/brigadier-linux-arm64": "1.2.3",
    },
  });

  try {
    const result = runGuardStep({ cwd: checkout, tagName: "v1.2.3" });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "verify-tag-version: optionalDependencies must pin every platform package to 1.2.3: " +
        "@stephen-golban/brigadier-darwin-x64 is pinned to 1.2.2, " +
        "@stephen-golban/brigadier-linux-x64 is not pinned\n",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("the release workflow's tag guard passes when every platform pin moves with the version", () => {
  const checkout = syntheticCheckout({
    name: "@stephen-golban/brigadier",
    version: "1.2.3",
    optionalDependencies: {
      "@stephen-golban/brigadier-darwin-arm64": "1.2.3",
      "@stephen-golban/brigadier-darwin-x64": "1.2.3",
      "@stephen-golban/brigadier-linux-arm64": "1.2.3",
      "@stephen-golban/brigadier-linux-x64": "1.2.3",
    },
  });

  try {
    const result = runGuardStep({ cwd: checkout, tagName: "v1.2.3" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("the workflow step reader recovers a block-scalar run: body verbatim", () => {
  const workflow = [
    "jobs:",
    "  build:",
    "    steps:",
    "      - uses: actions/checkout@v4.4.0",
    "      - name: Example step",
    "        shell: bash",
    "        run: |",
    "          first --line",
    "          if [[ -n x ]]; then",
    "            second --line",
    "          fi",
    "      - name: Later step",
    "        run: later --line",
    "",
  ].join("\n");

  expect(extractStepRun(workflow, "Example step")).toBe(
    "first --line\nif [[ -n x ]]; then\n  second --line\nfi",
  );
  expect(extractStepRun(workflow, "Later step")).toBe("later --line");
});

/**
 * Run the workflow step under the same interpreter GitHub Actions uses for
 * `shell: bash`, which is `bash --noprofile --norc -eo pipefail {0}`.
 *
 * Bounded by work: `spawnSync` returns when the guard exits, and the guard is a
 * finite script with no waiting in it. There is no timer to tune and nothing
 * that passes or fails differently on a slow machine.
 */
function runGuardStep(options: {
  readonly cwd: string;
  readonly tagName?: string;
}): GuardResult {
  const directory = mkdtempSync(
    join(tmpdir(), "brigadier-release-guard-step-"),
  );
  try {
    const stepPath = join(directory, "step.sh");
    writeFileSync(stepPath, `${guardStepScript}\n`);

    // HOME points at the throwaway directory, never at the real one: the
    // suite-wide guard in test/config.test.ts forbids any test from reaching
    // for the developer's actual home, and the guard script does not read it.
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: directory,
    };
    if (options.tagName !== undefined) {
      environment.GITHUB_REF_NAME = options.tagName;
    }

    const result = Bun.spawnSync({
      cmd: ["bash", "--noprofile", "--norc", "-eo", "pipefail", stepPath],
      cwd: options.cwd,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * A throwaway checkout carrying only what the guard reads: a package.json, and
 * the real guard script at the path the workflow names. The script is symlinked
 * rather than copied so these cases exercise the same bytes CI runs.
 */
function syntheticCheckout(manifest: unknown): string {
  const directory = mkdtempSync(
    join(tmpdir(), "brigadier-release-guard-repo-"),
  );
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  mkdirSync(join(directory, "scripts"));
  symlinkSync(
    join(repositoryRoot, "scripts", "verify-tag-version.sh"),
    join(directory, "scripts", "verify-tag-version.sh"),
  );
  return directory;
}

function extractStepRun(workflow: string, stepName: string): string {
  const lines = workflow.split("\n");
  const stepIndex = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}`,
  );
  if (stepIndex === -1) {
    throw new Error(`release.yml declares no step named "${stepName}"`);
  }
  const keyIndent = indentOf(lines[stepIndex] ?? "") + 2;

  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      continue;
    }
    const indent = indentOf(line);
    if (
      indent < keyIndent ||
      (indent === keyIndent && line.trimStart().startsWith("- "))
    ) {
      break;
    }
    if (indent > keyIndent) {
      continue;
    }
    const header = /^run:\s*(.*)$/.exec(line.trim());
    if (header === null) {
      continue;
    }
    const scalar = (header[1] ?? "").trim();
    if (scalar === "") {
      throw new Error(`step "${stepName}" declares an empty run:`);
    }
    if (scalar !== "|" && scalar !== "|-" && scalar !== "|+") {
      return scalar;
    }
    return blockScalarBody(lines, index + 1, keyIndent);
  }
  throw new Error(`step "${stepName}" declares no run: script`);
}

function blockScalarBody(
  lines: readonly string[],
  start: number,
  keyIndent: number,
): string {
  const body: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (indentOf(line) <= keyIndent) {
      break;
    }
    body.push(line);
  }
  while (body.length > 0 && body[body.length - 1] === "") {
    body.pop();
  }
  const populated = body.filter((line) => line !== "");
  if (populated.length === 0) {
    throw new Error("run: block scalar has no content");
  }
  const margin = Math.min(...populated.map(indentOf));
  return body.map((line) => (line === "" ? "" : line.slice(margin))).join("\n");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}
