import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const notarizeScriptPath = join(repositoryRoot, "scripts", "notarize.sh");
const GUARD_STEP_NAME = "Verify tag matches package version";
const AD_HOC_CONTROL_STEP_NAME =
  "Prove notarization requirement rejects ad-hoc binary";
const NOTARIZED_BINARY_GATE_STEP_NAME =
  "Verify release binary is Developer ID signed and notarized";
const ASSEMBLY_STEP_NAME = "Assemble release archive";
const CHECKSUMS_STEP_NAME = "Assemble combined checksums";
const CREATE_RELEASE_STEP_NAME = "Create GitHub release";
const TAP_CHECKOUT_STEP_NAME = "Check out Homebrew tap";
const FORMULA_STEP_NAME = "Update Homebrew formula from release artifacts";
const FORMULA_DISABLED_STEP_NAME = "Homebrew formula update disabled";

/**
 * The guard's whole output is one line of a few dozen bytes, so this is three
 * orders of magnitude above anything it produces and still small enough that a
 * guard which streams is killed long before this runner notices the memory.
 */
const MAX_GUARD_OUTPUT_BYTES = 64 * 1024;

/**
 * Backstop only, for a guard that consumes CPU without producing output. The
 * guard is a finite script and every case here finishes in milliseconds; a run
 * that reaches this deadline is a defect, and is failed rather than tolerated.
 */
const GUARD_TIMEOUT_MS = 30_000;

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

// This is a static text-order assertion. Execution order cannot be recovered
// from static text; the real execution-order guarantee is
// `codesign --verify -R "=notarized"` against a genuinely built artifact.
test("the notarization script text places disk-image signing and verification before submission", () => {
  const script = readFileSync(notarizeScriptPath, "utf8");
  const signDmg = `codesign --sign "\${DEVELOPER_ID_IDENTITY}" --timestamp "\${NOTARIZED_DMG_PATH}"`;
  const verifyDmg = `codesign --verify --strict --verbose=2 "\${NOTARIZED_DMG_PATH}"`;
  const submitDmg = `xcrun notarytool submit "\${NOTARIZED_DMG_PATH}"`;

  const signIndex = script.indexOf(signDmg);
  const verifyIndex = script.indexOf(verifyDmg);
  const submitIndex = script.indexOf(submitDmg);

  expect(signIndex).toBeGreaterThan(-1);
  expect(verifyIndex).toBeGreaterThan(signIndex);
  expect(submitIndex).toBeGreaterThan(verifyIndex);
});

test("the notarization script copies the signed payload binary back after signing", () => {
  const script = readFileSync(notarizeScriptPath, "utf8");
  const signBinary = `--sign "\${DEVELOPER_ID_IDENTITY}" \\`;
  const copyBack = `cp "\${payload_directory}/brigadier" "\${ARTIFACT_PATH}"`;

  const signIndex = script.indexOf(signBinary);
  const copyBackIndex = script.indexOf(copyBack);

  // Keep both presence checks unconditional: indexOf returns -1 for a missing
  // target, and guarding either assertion with `if (index >= 0)` would fail open.
  expect(signIndex).toBeGreaterThan(-1);
  expect(copyBackIndex).toBeGreaterThan(signIndex);
});

// Note for a future maintainer: the workflow tests below pin each new runtime
// check's exact `run:` text, but never assert its `if:` condition or the
// ad-hoc sign → rejection check → notarization → positive gate ordering.
// Setting both checks to `if: false` would leave all four notarization tests
// green while the runtime checks are skipped. Deleting the ad-hoc-sign step
// would leave them green without guaranteeing that the negative control's input
// was deliberately ad-hoc signed.
// The conditions are correct as shipped, so this was adjudicated non-blocking
// for `v0.1.1`. Closing the gap means asserting the `if:` conditions and the
// ad-hoc sign → rejection check → notarization → positive gate ordering.
test("the release workflow proves the notarization requirement rejects the ad-hoc binary", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const stepIndex = workflow.indexOf(`- name: ${AD_HOC_CONTROL_STEP_NAME}`);

  // Missing targets must fail, never skip the assertion behind a conditional.
  expect(stepIndex).toBeGreaterThan(-1);
  expect(extractStepRun(workflow, AD_HOC_CONTROL_STEP_NAME)).toBe(
    [
      `codesign --verify --strict "\${GITHUB_WORKSPACE}/release-bin/brigadier"`,
      `if codesign --verify -R "=notarized" "\${GITHUB_WORKSPACE}/release-bin/brigadier"; then`,
      '  echo "The freshly ad-hoc-signed binary unexpectedly satisfied the notarization requirement" >&2',
      "  exit 1",
      "fi",
    ].join("\n"),
  );
});

test("the release workflow gates assembly on the notarized release binary", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const notarizeIndex = workflow.indexOf(
    "- name: Developer ID sign and notarize",
  );
  const gateIndex = workflow.indexOf(
    `- name: ${NOTARIZED_BINARY_GATE_STEP_NAME}`,
  );
  const assemblyIndex = workflow.indexOf(`- name: ${ASSEMBLY_STEP_NAME}`);

  // These separate presence checks are load-bearing: -1 must never participate
  // in an ordering comparison that could make an absent step look correctly placed.
  expect(notarizeIndex).toBeGreaterThan(-1);
  expect(gateIndex).toBeGreaterThan(-1);
  expect(assemblyIndex).toBeGreaterThan(-1);
  expect(gateIndex).toBeGreaterThan(notarizeIndex);
  expect(assemblyIndex).toBeGreaterThan(gateIndex);
  expect(extractStepRun(workflow, NOTARIZED_BINARY_GATE_STEP_NAME)).toBe(
    [
      `if codesign --verify -R "=notarized" "\${GITHUB_WORKSPACE}/release-bin/brigadier"; then`,
      "  exit 0",
      "fi",
      `if codesign -dv "\${GITHUB_WORKSPACE}/release-bin/brigadier" 2>&1 | grep -qF 'Signature=adhoc'; then`,
      '  echo "Release binary is ad-hoc signed instead of Developer ID signed" >&2',
      "else",
      '  echo "Release binary did not satisfy the notarization requirement and is not ad-hoc signed" >&2',
      "fi",
      "exit 1",
    ].join("\n"),
  );
});

interface GuardResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A step run with nothing assumed about how it ended, bounds included. */
interface SpawnedStep extends GuardResult {
  /** `undefined` when the step exited on its own; the signal when it was killed. */
  readonly signalCode: string | undefined;
  readonly exitedDueToTimeout: boolean | undefined;
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

test("the release workflow creates and uploads a checksum manifest for every artifact", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const checksumsIndex = workflow.indexOf(`- name: ${CHECKSUMS_STEP_NAME}`);
  const releaseIndex = workflow.indexOf(`- name: ${CREATE_RELEASE_STEP_NAME}`);

  expect(checksumsIndex).toBeGreaterThan(-1);
  expect(releaseIndex).toBeGreaterThan(checksumsIndex);
  expect(extractStepRun(workflow, CHECKSUMS_STEP_NAME)).toBe(
    [
      "cd release-packages",
      "shopt -s nullglob",
      "release_assets=(*.tar.gz *.tar.gz.sha256 *.dmg)",
      `if (( \${#release_assets[@]} == 0 )); then`,
      '  echo "No release artifacts were downloaded" >&2',
      "  exit 1",
      "fi",
      `shasum -a 256 "\${release_assets[@]}" > checksums.txt`,
    ].join("\n"),
  );
  expect(extractStepRun(workflow, CREATE_RELEASE_STEP_NAME)).toContain(
    "release-packages/checksums.txt",
  );
});

test("the release workflow bumps the tap formula from real artifact checksums", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const releaseIndex = workflow.indexOf(`- name: ${CREATE_RELEASE_STEP_NAME}`);
  const tapCheckoutIndex = workflow.indexOf(
    `- name: ${TAP_CHECKOUT_STEP_NAME}`,
  );
  const formulaIndex = workflow.indexOf(`- name: ${FORMULA_STEP_NAME}`);

  expect(releaseIndex).toBeGreaterThan(-1);
  expect(tapCheckoutIndex).toBeGreaterThan(releaseIndex);
  expect(formulaIndex).toBeGreaterThan(tapCheckoutIndex);
  expect(workflow).toContain(
    [
      `      - name: ${TAP_CHECKOUT_STEP_NAME}`,
      "        if: >-",
      "          env.RELEASE_PUBLISH_ENABLED == 'true' &&",
      "          env.HOMEBREW_TAP_TOKEN != ''",
      "        uses: actions/checkout@v7.0.1",
      "        with:",
      "          repository: stephen-golban/homebrew-tap",
      `          token: \${{ secrets.HOMEBREW_TAP_TOKEN }}`,
      "          path: homebrew-tap",
    ].join("\n"),
  );
  expect(workflow).toContain(
    [
      `      - name: ${FORMULA_STEP_NAME}`,
      "        if: >-",
      "          env.RELEASE_PUBLISH_ENABLED == 'true' &&",
      "          env.HOMEBREW_TAP_TOKEN != ''",
      "        shell: bash",
    ].join("\n"),
  );
  expect(extractStepRun(workflow, FORMULA_STEP_NAME)).toBe(
    [
      `version="\${GITHUB_REF_NAME#v}"`,
      `bun ./scripts/update-homebrew-formula.ts "\${version}" ./release-packages ./homebrew-tap/Formula/brigadier.rb`,
      'git -C ./homebrew-tap config user.name "github-actions[bot]"',
      'git -C ./homebrew-tap config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
      "git -C ./homebrew-tap add Formula/brigadier.rb",
      `git -C ./homebrew-tap commit -m "Update Homebrew formula to \${GITHUB_REF_NAME}"`,
      "git -C ./homebrew-tap push origin HEAD",
    ].join("\n"),
  );
});

test("a missing tap token skips the formula bump without failing the release", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const formulaIndex = workflow.indexOf(`- name: ${FORMULA_STEP_NAME}`);
  const disabledIndex = workflow.indexOf(
    `- name: ${FORMULA_DISABLED_STEP_NAME}`,
  );

  expect(workflow).toContain(
    `HOMEBREW_TAP_TOKEN: \${{ secrets.HOMEBREW_TAP_TOKEN }}`,
  );
  expect(formulaIndex).toBeGreaterThan(-1);
  expect(disabledIndex).toBeGreaterThan(formulaIndex);
  expect(workflow).toContain(
    [
      `      - name: ${FORMULA_DISABLED_STEP_NAME}`,
      "        if: env.HOMEBREW_TAP_TOKEN == ''",
    ].join("\n"),
  );
  expect(extractStepRun(workflow, FORMULA_DISABLED_STEP_NAME)).toBe(
    'echo "HOMEBREW_TAP_TOKEN is unset; Homebrew formula update is disabled"',
  );
});

test("the release workflow contains no npm packaging or publication jobs", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  expect(workflow).not.toContain("package-root:");
  expect(workflow).not.toContain("publish-npm:");
  expect(workflow).not.toContain("npm pack");
  expect(workflow).not.toContain("npm publish");
  expect(workflow).not.toContain("assemble-platform-package.ts");
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
 * BOUNDED THREE WAYS, ALL OF THEM OUTSIDE THIS THREAD. `spawnSync` blocks the
 * runner until the child is gone, so a `setTimeout` written here could not fire
 * to save it: whatever bounds this call has to be enforced by something that is
 * not the JavaScript event loop.
 *
 *   stdin is `/dev/null`, so a guard that ever waits on input reads EOF
 *     immediately rather than waiting for a keystroke that will never come.
 *     Bun's default for `spawnSync` is the same today; it is written out here
 *     because the property is load-bearing and a default is not a promise;
 *   `maxBuffer` caps the bytes the guard may write and the child is killed on
 *     the write that crosses it, so a guard that streams cannot exhaust this
 *     runner's memory;
 *   `timeout` is enforced by Bun's own child supervision, which is what makes
 *     it the one deadline that still fires while this call is blocked — the
 *     backstop for a guard that spins on the CPU without reading, writing, or
 *     exiting.
 *
 * None of the three is trusted to rescue a run: a child killed by any of them
 * is failed here, on the spot, so an unbounded guard can never pass as a bounded
 * one. `signalCode` is `undefined` exactly when the guard chose its own exit
 * rather than being killed, which is the only outcome these tests accept; both
 * the `maxBuffer` kill and the `timeout` kill leave `SIGTERM` there instead.
 */
function runGuardStep(options: {
  readonly cwd: string;
  readonly tagName?: string;
}): GuardResult {
  const result = spawnStep({ ...options, script: guardStepScript });

  expect(result.exitedDueToTimeout).toBe(false);
  expect(result.signalCode).toBe(undefined);

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * The spawn itself, with nothing asserted about how it ended.
 *
 * Split out from `runGuardStep` for one reason: the bounds above are claims, and
 * the two tests at the bottom of this file check them by handing this function a
 * step that waits and a step that spins. Every other caller runs the workflow's
 * own text, which is what `runGuardStep` exists to guarantee — `script` is not a
 * way to test something other than the real guard.
 */
function spawnStep(options: {
  readonly cwd: string;
  readonly script: string;
  readonly tagName?: string;
  readonly timeoutMs?: number;
}): SpawnedStep {
  const directory = mkdtempSync(
    join(tmpdir(), "brigadier-release-guard-step-"),
  );
  try {
    const stepPath = join(directory, "step.sh");
    writeFileSync(stepPath, `${options.script}\n`);

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
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      maxBuffer: MAX_GUARD_OUTPUT_BYTES,
      timeout: options.timeoutMs ?? GUARD_TIMEOUT_MS,
    });

    return {
      exitCode: result.exitCode,
      signalCode: result.signalCode,
      exitedDueToTimeout: result.exitedDueToTimeout,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------ */
/* The bounds, checked rather than claimed                                   */
/* ------------------------------------------------------------------------ */

test("a step that waits on input reads EOF instead of waiting with it", () => {
  const result = spawnStep({
    cwd: repositoryRoot,
    script: 'read -r line\necho "read: $line"',
  });

  // stdin is /dev/null, so `read` fails at once and `-e` ends the step there:
  // the echo never runs. A step wired to a terminal would still be sitting in
  // that `read` when the suite gave up.
  expect(result.exitCode).toBe(1);
  expect(result.signalCode).toBe(undefined);
  expect(result.exitedDueToTimeout).toBe(false);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("a step that spins is killed by a bound the event loop could not enforce", () => {
  const result = spawnStep({
    cwd: repositoryRoot,
    script: "while :; do :; done",
    // Short only so this test is fast. The mechanism is identical at 30 s.
    timeoutMs: 1_500,
  });

  // THE POINT OF THIS TEST. The loop above never yields, never writes, and
  // never exits, and `spawnSync` blocks this thread for its whole duration —
  // no `setTimeout` scheduled in this file could have run while it did. What
  // killed it was Bun's own supervision of the child, outside the event loop.
  //
  // Measured, with the three options removed: the runner's own generic
  // per-test timeout does eventually notice, and reports "this test timed out
  // after 5000ms" — a message that names no bound, no signal, and no guard.
  // The deadline set here is what turns that into an attributable failure.
  expect(result.exitedDueToTimeout).toBe(true);
  expect(result.signalCode).toBe("SIGTERM");
  expect(result.exitCode).toBe(null);
});

test("a step that streams without stopping is killed by the output cap", () => {
  const result = spawnStep({
    cwd: repositoryRoot,
    // Two orders of magnitude past MAX_GUARD_OUTPUT_BYTES, produced as fast as
    // the machine can produce it.
    script: "yes brigadier | head -c 8000000",
  });

  // Killed for writing too much, not for taking too long: this is the bound
  // that stands between a chatty guard and a runner that dies of memory, and it
  // is a bound on WORK — how many bytes were produced — so a faster machine
  // cannot slip past it. `signalCode` first, because "it was killed" is the
  // claim; which bound killed it is the follow-up.
  expect(result.signalCode).toBe("SIGTERM");
  expect(result.exitCode).toBe(null);
  expect(result.exitedDueToTimeout).toBe(false);
});

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
