#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const platformPackage =
  {
    "darwin-arm64": "@stephen-golban/brigadier-darwin-arm64",
    "darwin-x64": "@stephen-golban/brigadier-darwin-x64",
    "linux-arm64": "@stephen-golban/brigadier-linux-arm64",
    "linux-x64": "@stephen-golban/brigadier-linux-x64",
    "win32-x64": "@stephen-golban/brigadier-win32-x64",
  }[`${process.platform}-${process.arch}`] ?? null;

const optionalBinary = resolveOptionalBinary(platformPackage);
const binary = optionalBinary;

if (binary !== null && existsSync(binary)) {
  const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 1);
}

await import("../dist/cli.js");

function resolveOptionalBinary(packageName) {
  if (packageName === null) {
    return null;
  }
  try {
    return require.resolve(packageName);
  } catch {
    return null;
  }
}
