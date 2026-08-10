#!/usr/bin/env bun

import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const supportedPlatforms = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
]);

const [platform, binaryArgument, outputArgument] = process.argv.slice(2);

if (
  platform === undefined ||
  binaryArgument === undefined ||
  outputArgument === undefined
) {
  fail(
    "usage: assemble-platform-package.ts <platform> <binary> <output-directory>",
  );
}
if (!supportedPlatforms.has(platform)) {
  fail(`unsupported platform: ${platform}`);
}

const binaryPath = resolve(binaryArgument);
const outputDirectory = resolve(outputArgument);
const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  version: string;
};
const [os, cpu] = platform.split("-") as [string, string];
const packageName = `@stephen-golban/brigadier-${platform}`;
const stagingDirectory = join(outputDirectory, `stage-${platform}`);
const stagingBinDirectory = join(stagingDirectory, "bin");
const stagedBinary = join(stagingBinDirectory, "brigadier");
const stagedPackageJson = join(stagingDirectory, "package.json");

await requireRegularFile(binaryPath);
await createFreshStagingDirectory(stagingDirectory);

try {
  await mkdir(stagingBinDirectory);
  await copyFile(binaryPath, stagedBinary);
  await chmod(stagedBinary, 0o755);
  await Bun.write(
    stagedPackageJson,
    `${JSON.stringify(
      {
        name: packageName,
        version: packageJson.version,
        description: `Native ${platform} binary for @stephen-golban/brigadier`,
        license: "MIT",
        os: [os],
        cpu: [cpu],
        main: "./bin/brigadier",
        files: ["bin/brigadier"],
        publishConfig: { access: "public" },
      },
      null,
      2,
    )}\n`,
  );

  const processResult = Bun.spawnSync(
    ["npm", "pack", stagingDirectory, "--pack-destination", outputDirectory],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (processResult.exitCode !== 0) {
    throw new Error(`npm pack failed with exit code ${processResult.exitCode}`);
  }
} finally {
  await removeCreatedStagingDirectory({
    stagingDirectory,
    stagingBinDirectory,
    stagedBinary,
    stagedPackageJson,
  });
}

console.log(
  `assembled ${packageName}@${packageJson.version} from ${basename(binaryPath)}`,
);

async function requireRegularFile(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) {
      fail(`binary is not a regular file: ${path}`);
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      fail(`binary does not exist: ${path}`);
    }
    throw error;
  }
}

async function createFreshStagingDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      fail(`staging directory already exists; refusing to remove it: ${path}`);
    }
    throw error;
  }
}

interface StagingPaths {
  readonly stagingDirectory: string;
  readonly stagingBinDirectory: string;
  readonly stagedBinary: string;
  readonly stagedPackageJson: string;
}

/**
 * Remove only paths created by this invocation. `rmdir` is deliberate: if any
 * other file appears in staging, cleanup must preserve it and fail safely.
 */
async function removeCreatedStagingDirectory(
  paths: StagingPaths,
): Promise<void> {
  await unlinkIfPresent(paths.stagedBinary);
  await rmdirIfPresent(paths.stagingBinDirectory);
  await unlinkIfPresent(paths.stagedPackageJson);
  await rmdirIfPresent(paths.stagingDirectory);
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function rmdirIfPresent(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function fail(message: string): never {
  console.error(`assemble-platform-package: ${message}`);
  process.exit(1);
}
