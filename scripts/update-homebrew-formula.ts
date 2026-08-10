#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [version, checksumDirectoryArgument] = process.argv.slice(2);
if (version === undefined || checksumDirectoryArgument === undefined) {
  fail(
    "usage: update-homebrew-formula.ts <version> <release-assets-directory>",
  );
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`invalid release version: ${version}`);
}

const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;
const checksumDirectory = resolve(checksumDirectoryArgument);
const formulaPath = resolve("Formula/brigadier.rb");
let formula = await readFile(formulaPath, "utf8");

formula = replaceExactlyOnce(
  formula,
  /^ {2}version "[^"]+"$/m,
  `  version "${version}"`,
  "formula version",
);

for (const platform of platforms) {
  const checksumPath = join(
    checksumDirectory,
    `brigadier-${version}-${platform}.tar.gz.sha256`,
  );
  const checksumContents = await readFile(checksumPath, "utf8");
  const checksum = checksumContents.trim().split(/\s+/)[0];
  if (checksum === undefined || !/^[0-9a-f]{64}$/.test(checksum)) {
    fail(`invalid SHA-256 digest in ${checksumPath}`);
  }

  const blockPattern = new RegExp(
    `(      url ")[^"]*brigadier-[^"]*-${platform}\\.tar\\.gz("\\n      sha256 ")[0-9a-f]{64}("$)`,
    "m",
  );
  formula = replaceExactlyOnce(
    formula,
    blockPattern,
    `$1https://github.com/stephen-golban/brigadier/releases/download/v${version}/brigadier-${version}-${platform}.tar.gz$2${checksum}$3`,
    platform,
  );
}

await Bun.write(formulaPath, formula);
console.log(`updated Formula/brigadier.rb for v${version}`);

function replaceExactlyOnce(
  contents: string,
  pattern: RegExp,
  replacement: string,
  label: string,
): string {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const matches = contents.match(new RegExp(pattern.source, flags)) ?? [];
  if (matches.length !== 1) {
    fail(
      `expected one ${label} block in Formula/brigadier.rb, found ${matches.length}`,
    );
  }
  const replaced = contents.replace(pattern, replacement);
  if (replaced === contents) {
    fail(`failed to replace ${label} block in Formula/brigadier.rb`);
  }
  return replaced;
}

function fail(message: string): never {
  console.error(`update-homebrew-formula: ${message}`);
  process.exit(1);
}
