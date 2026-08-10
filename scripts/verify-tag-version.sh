#!/usr/bin/env bash
#
# Refuse a release whose git tag, root package version, and platform dependency
# pins do not all name the same version.
#
# `./package.json` is read relative to the working directory, exactly as the
# inline workflow step this replaced did. The release job runs from the checkout
# root, so CI behaviour is unchanged, and cwd-relative resolution is what lets
# test/release-guard.test.ts drive this against a synthetic manifest instead of
# mutating the repository's own package.json.

set -euo pipefail

if [[ -z "${GITHUB_REF_NAME:-}" ]]; then
  echo "verify-tag-version: GITHUB_REF_NAME is unset or empty" >&2
  exit 1
fi

if [[ ! -f ./package.json ]]; then
  echo "verify-tag-version: ./package.json is not a file" >&2
  exit 1
fi

package_version="$(bun -e 'console.log(require("./package.json").version)')"
tag_version="${GITHUB_REF_NAME#v}"

if [[ "${package_version}" != "${tag_version}" ]]; then
  echo "verify-tag-version: tag ${GITHUB_REF_NAME} does not match package version ${package_version}" >&2
  exit 1
fi

# The four platform packages are published from this same tag at this same
# version, and their tarballs take their version from package.json. A pin that
# drifts therefore names a version that will never exist on the registry: npm
# resolves no binary, silently falls back to the slower dist/cli.js launcher,
# and nothing fails loudly. Catch the drift here, before anything is published.
pin_problem="$(bun -e '
const manifest = require("./package.json");
const pins = manifest.optionalDependencies ?? {};
const problems = [];
for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
  const name = `@stephen-golban/brigadier-${platform}`;
  const pinned = pins[name];
  if (pinned === undefined) {
    problems.push(`${name} is not pinned`);
  } else if (pinned !== manifest.version) {
    problems.push(`${name} is pinned to ${pinned}`);
  }
}
if (problems.length > 0) {
  console.log(
    `optionalDependencies must pin every platform package to ${manifest.version}: ${problems.join(", ")}`,
  );
}
')"

if [[ -n "${pin_problem}" ]]; then
  echo "verify-tag-version: ${pin_problem}" >&2
  exit 1
fi
