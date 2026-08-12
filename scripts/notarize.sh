#!/usr/bin/env bash

set -euo pipefail

required_variables=(
  APPLE_ID
  APPLE_TEAM_ID
  APPLE_APP_PASSWORD
  DEVELOPER_ID_IDENTITY
  ARTIFACT_PATH
  NOTARIZED_DMG_PATH
)

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "notarize: required environment variable ${variable_name} is unset or empty" >&2
    exit 1
  fi
done

if [[ ! -f "${ARTIFACT_PATH}" ]]; then
  echo "notarize: ARTIFACT_PATH is not a file: ${ARTIFACT_PATH}" >&2
  exit 1
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/brigadier-notarize.XXXXXX")"
cleanup() {
  if [[ -d "${temporary_directory}" ]]; then
    find "${temporary_directory}" -depth -delete
  fi
}
trap cleanup EXIT

payload_directory="${temporary_directory}/payload"
mkdir -p "${payload_directory}"
cp "${ARTIFACT_PATH}" "${payload_directory}/brigadier"
chmod 755 "${payload_directory}/brigadier"

codesign \
  --force \
  --options runtime \
  --timestamp \
  --sign "${DEVELOPER_ID_IDENTITY}" \
  "${payload_directory}/brigadier"
codesign --verify --strict --verbose=2 "${payload_directory}/brigadier"

hdiutil create \
  -fs HFS+ \
  -srcfolder "${payload_directory}" \
  -volname Brigadier \
  -format UDZO \
  -ov \
  "${NOTARIZED_DMG_PATH}"

codesign --sign "${DEVELOPER_ID_IDENTITY}" --timestamp "${NOTARIZED_DMG_PATH}"
codesign --verify --strict --verbose=2 "${NOTARIZED_DMG_PATH}"

xcrun notarytool submit "${NOTARIZED_DMG_PATH}" \
  --apple-id "${APPLE_ID}" \
  --team-id "${APPLE_TEAM_ID}" \
  --password "${APPLE_APP_PASSWORD}" \
  --wait
xcrun stapler staple "${NOTARIZED_DMG_PATH}"
xcrun stapler validate "${NOTARIZED_DMG_PATH}"

cp "${payload_directory}/brigadier" "${ARTIFACT_PATH}"
echo "notarize: signed binary written to ${ARTIFACT_PATH}"
echo "notarize: notarized and stapled disk image written to ${NOTARIZED_DMG_PATH}"
