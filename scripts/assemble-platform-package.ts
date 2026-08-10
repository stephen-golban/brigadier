#!/usr/bin/env bun

import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
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
const stagedBinary = join(stagingDirectory, "bin", "brigadier");

await rm(stagingDirectory, { recursive: true, force: true });
await mkdir(join(stagingDirectory, "bin"), { recursive: true });
await copyFile(binaryPath, stagedBinary);
await chmod(stagedBinary, 0o755);
await Bun.write(
  join(stagingDirectory, "package.json"),
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
  fail(`npm pack failed with exit code ${processResult.exitCode}`);
}
await rm(stagingDirectory, { recursive: true, force: true });

console.log(
  `assembled ${packageName}@${packageJson.version} from ${basename(binaryPath)}`,
);

function fail(message: string): never {
  console.error(`assemble-platform-package: ${message}`);
  process.exit(1);
}
