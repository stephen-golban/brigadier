import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";

const repositoryRoot = resolve(import.meta.dir, "..");
const assembler = join(
  repositoryRoot,
  "scripts",
  "assemble-platform-package.ts",
);
const TIMEOUT_MS = 5_000;

/**
 * `npm pack --dry-run` is local work over an already-checked-out tree, and
 * `--ignore-scripts` keeps `prepack`'s full build out of it, so this is
 * sub-second in practice. The bound exists for the pack that wedges, not for
 * the pack that is merely slow.
 */
const PACK_TIMEOUT_MS = 120_000;

/**
 * The release-only scripts. Each is developer or CI tooling with no business in
 * a user's `node_modules`, and the natural wrong fix for shipping the
 * postinstall hook — adding `scripts` to `files` — ships all of them.
 */
const RELEASE_ONLY_SCRIPT_PATHS = [
  "scripts/assemble-platform-package.ts",
  "scripts/notarize.sh",
  "scripts/update-homebrew-formula.ts",
  "scripts/verify-tag-version.sh",
];

test("a pre-existing staging directory and its bystander survive invalid input", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "brigadier-package-"));
  const outputDirectory = join(scratch, "output");
  const stagingDirectory = join(outputDirectory, "stage-linux-x64");
  const bystander = join(stagingDirectory, "notes.txt");
  const missingBinary = join(scratch, "mistyped-brigadier");
  await mkdir(stagingDirectory, { recursive: true });
  await writeFile(bystander, "DO NOT DELETE ME\n", "utf8");

  try {
    const process = Bun.spawn({
      cmd: ["bun", assembler, "linux-x64", missingBinary, outputDirectory],
      cwd: repositoryRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(process.stdout).text();
    const stderr = new Response(process.stderr).text();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill(9);
    }, TIMEOUT_MS);
    const exitCode = await process.exited;
    clearTimeout(timer);

    expect(timedOut).toBe(false);
    expect(await readFile(bystander, "utf8")).toBe("DO NOT DELETE ME\n");
    expect(await stdout).toBe("");
    expect(await stderr).toBe(
      `assemble-platform-package: binary does not exist: ${missingBinary}\n`,
    );
    expect(exitCode).toBe(1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ */
/* The published tarball                                                     */
/* ------------------------------------------------------------------------ */

/**
 * THE TRAP THIS CLOSES. `scripts.postinstall` names a file npm runs on every
 * published install, and `files` decides whether that file is in the tarball at
 * all. Ship the hook without the file and node cannot resolve the module, the
 * hook exits nonzero, and `npm install` fails for everyone — a defect no test of
 * the script's own behaviour can see, because the script is perfect and simply
 * absent.
 *
 * So the list asserted here is the list npm itself produces from the real
 * `files` field, and the path looked for is read out of the real
 * `scripts.postinstall`. Nothing about the packaging is transcribed into this
 * file: change either field and this test sees the change.
 */
test(
  "the published tarball contains the postinstall script the hook runs",
  async () => {
    const scriptPath = postinstallScriptPath();
    const packed = await packedFilePaths();

    expect(packed).toContain(scriptPath);
    // The hook is only as real as the file it names, and `files` can ship a
    // path that no longer exists without npm objecting.
    expect(await readFile(join(repositoryRoot, scriptPath), "utf8")).toContain(
      "brigadier",
    );
  },
  PACK_TIMEOUT_MS,
);

/**
 * The other half of the same decision: ship the hook, and only the hook.
 * Widening `files` to the whole `scripts` directory would satisfy the test
 * above while putting the notarization script, the release assembler, the tag
 * guard, the Homebrew updater, and the test fakes into every user's
 * `node_modules`.
 */
test(
  "the published tarball ships no release-only script",
  async () => {
    const packed = await packedFilePaths();

    for (const releaseOnly of RELEASE_ONLY_SCRIPT_PATHS) {
      expect(packed).not.toContain(releaseOnly);
    }
    expect(packed.filter((path) => path.startsWith("scripts/fakes/"))).toEqual(
      [],
    );
  },
  PACK_TIMEOUT_MS,
);

/**
 * The path `scripts.postinstall` actually runs, recovered from the command
 * rather than restated. A hook that stops naming exactly one script file is a
 * failure here rather than a silently unchecked packaging assumption.
 */
function postinstallScriptPath(): string {
  const command = packageJson.scripts.postinstall;
  const scriptFiles = command
    .split(/\s+/)
    .filter((token) => /^scripts\/\S+\.(?:mjs|cjs|js)$/.test(token));
  expect(scriptFiles).toHaveLength(1);
  return scriptFiles[0] as string;
}

/**
 * The file list npm itself would publish, asked of npm.
 *
 * `--ignore-scripts` keeps `prepack`'s full build out of a unit test; it changes
 * which files happen to exist on disk, never which patterns `files` selects, and
 * the postinstall script is checked into the repository rather than built. A
 * pack that fails or writes nothing parseable fails the test rather than
 * returning an empty list that every `not.toContain` below would sail through.
 */
async function packedFilePaths(): Promise<readonly string[]> {
  const process = Bun.spawn({
    cmd: ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
    cwd: repositoryRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(process.stdout).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill(9);
  }, PACK_TIMEOUT_MS);
  const exitCode = await process.exited;
  clearTimeout(timer);

  expect(timedOut).toBe(false);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(await stdout) as readonly {
    readonly files: readonly { readonly path: string }[];
  }[];
  const files = parsed[0]?.files ?? [];
  expect(files.length).toBeGreaterThan(0);
  return files.map((file) => file.path);
}
