#!/usr/bin/env bun

import packageJson from "../package.json";

const args = Bun.argv.slice(2);

if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
  console.log(packageJson.version);
} else {
  console.error("Usage: brigadier --version");
  process.exitCode = 2;
}
