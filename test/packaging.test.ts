import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const assembler = join(
  repositoryRoot,
  "scripts",
  "assemble-platform-package.ts",
);
const TIMEOUT_MS = 5_000;

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
