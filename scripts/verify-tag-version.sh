#!/usr/bin/env bash
#
# Refuse a release whose git tag and package version do not name the same
# version.
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
