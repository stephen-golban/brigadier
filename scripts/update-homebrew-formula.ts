#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;

export function assetName(version: string, platform: (typeof platforms)[number]) {
  return `brigadier-${version}-${platform}.tar.gz`;
}

export function releaseDownloadUrl(
  version: string,
  platform: (typeof platforms)[number],
) {
  return `https://github.com/stephen-golban/brigadier/releases/download/v${version}/${assetName(version, platform)}`;
}

export function checksumFromContents(contents: string, asset: string): string {
  const match = contents.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
  if (match?.[1] === undefined || match[2] !== asset) {
    throw new Error(`invalid SHA-256 checksum file for ${asset}`);
  }
  return match[1].toLowerCase();
}

export function rewriteFormula(
  formula: string,
  version: string,
  checksums: Record<(typeof platforms)[number], string>,
) {
  let updatedFormula = replaceExactlyOnce(
    formula,
    /^ {2}version "[^"]+"$/m,
    `  version "${version}"`,
    "formula version",
  );

  for (const platform of platforms) {
    const blockPattern = new RegExp(
      `(      url ")[^"]*brigadier-[^"]*-${platform}\\.tar\\.gz("\\n      sha256 ")[0-9a-f]{64}(")`,
      "m",
    );
    updatedFormula = replaceExactlyOnce(
      updatedFormula,
      blockPattern,
      `$1${releaseDownloadUrl(version, platform)}$2${checksums[platform]}$3`,
      platform,
    );
  }

  return updatedFormula;
}

export async function updateFormula(
  version: string,
  checksumDirectory: string,
  formulaPath: string,
) {
  const formula = await readFile(formulaPath, "utf8");
  const checksums = {} as Record<(typeof platforms)[number], string>;

  for (const platform of platforms) {
    const asset = assetName(version, platform);
    const checksumPath = join(checksumDirectory, `${asset}.sha256`);
    checksums[platform] = checksumFromContents(
      await readFile(checksumPath, "utf8"),
      asset,
    );
  }

  await writeFile(formulaPath, rewriteFormula(formula, version, checksums));
}

async function main() {
  const [version, checksumDirectoryArgument, formulaPathArgument] = process.argv.slice(2);
  if (version === undefined || checksumDirectoryArgument === undefined) {
    fail(
      "usage: update-homebrew-formula.ts <version> <release-assets-directory> [formula-path]",
    );
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`invalid release version: ${version}`);
  }

  const checksumDirectory = resolve(checksumDirectoryArgument);
  const formulaPath = resolve(formulaPathArgument ?? "Formula/brigadier.rb");
  await updateFormula(version, checksumDirectory, formulaPath);
  console.log(`updated ${formulaPath} for v${version}`);
}

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

if (import.meta.main) {
  await main();
}
