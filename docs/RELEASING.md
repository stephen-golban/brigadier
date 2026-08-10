# Releasing Brigadier

This repository ships five npm packages and four GitHub release archives:

- `@stephen-golban/brigadier` contains the JavaScript launchers and fallback
  build.
- `@stephen-golban/brigadier-{darwin,linux}-{arm64,x64}` each contain one
  native executable.
- `brigadier-VERSION-PLATFORM.tar.gz` archives are consumed by Homebrew.

The release workflow builds on a `v*` tag, but its npm and GitHub publication
steps are disabled unless their explicit secrets are configured. Missing Apple
credentials also skip Developer ID notarization and leave an ad-hoc-signed
Darwin binary, so a dry run can still build every artifact.

## One-time credentials

Add repository secrets at **GitHub repository → Settings → Secrets and
variables → Actions**.

### npm

- `NPM_TOKEN`: create a granular access token at
  <https://www.npmjs.com/settings/~/tokens>. It needs publish permission for
  `@stephen-golban/brigadier` and all four platform packages. The scope must
  already exist or the account must be allowed to create public packages in
  `@stephen-golban`. npm trusted publishing is preferable after the packages
  exist, but this workflow deliberately uses a missing secret as its publication
  safety gate.

### GitHub release

- `RELEASE_PUBLISH_ENABLED`: set this exact value to `true` only when tagged
  builds should create a public GitHub release. GitHub supplies `GITHUB_TOKEN`
  to the workflow automatically; no personal access token is required.

### Apple Developer ID and notarization

The owner needs an active Apple Developer Program membership and a **Developer
ID Application** certificate. This is distinct from a Mac App Distribution,
iOS Distribution, or other mobile distribution certificate. Export the
Developer ID Application certificate and private key from Keychain Access as a
password-protected `.p12` file. Create the certificate at
<https://developer.apple.com/account/resources/certificates/list> by choosing
the Developer ID certificate type and then **Developer ID Application**.

- `APPLE_ID`: the Apple Account email used for the developer membership.
- `APPLE_TEAM_ID`: the Team ID shown at
  <https://developer.apple.com/account> under Membership details.
- `APPLE_APP_PASSWORD`: an app-specific password created at
  <https://account.apple.com/sign-in> under Sign-In and Security. This is not
  the normal Apple Account password.
- `DEVELOPER_ID_IDENTITY`: the full codesigning identity shown by
  `security find-identity -v -p codesigning`, for example
  `Developer ID Application: Name (TEAMID)`.
- `APPLE_CERTIFICATE_P12`: the base64 encoding of the exported `.p12`, produced
  with `base64 -i DeveloperIDApplication.p12 | pbcopy` on macOS.
- `APPLE_CERTIFICATE_PASSWORD`: the password chosen while exporting the `.p12`.
- `KEYCHAIN_PASSWORD`: a new strong random password used only for the temporary
  GitHub Actions signing keychain.

The workflow signs each Darwin command-line executable with the Developer ID
Application identity, places it in a disk image, submits the disk image with
`xcrun notarytool submit --wait`, and staples the ticket to the disk image. A
bare Mach-O command-line executable cannot carry a stapled ticket, so the
release tarball contains the signed executable and the notarized DMG is retained
as workflow evidence when Apple credentials are present.

## Release commands, in order

Run these commands from a clean checkout on macOS. Replace `0.1.0` with the
intended version; do not include the leading `v` in `VERSION`.

```sh
export VERSION=0.1.0

npm pkg set "version=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-darwin-arm64]=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-darwin-x64]=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-linux-arm64]=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-linux-x64]=${VERSION}"

bun install
bun run build:mcp
bun test
bun run typecheck
bun run check
bun run build
npm pack --dry-run

git add package.json bun.lock dist bin docs scripts Formula .github
git commit -m "Release v${VERSION}"
git tag -s "v${VERSION}" -m "v${VERSION}"
git push origin HEAD
git push origin "v${VERSION}"
```

`bun run build:mcp` writes `dist/mcp/server.js` and its source map, and leaves no
generated JavaScript under `src/`. `bun run build` invokes `build:mcp` as part of
the ordinary package build.

```sh
bun run build:mcp
bun run check
```

`bun test` exercises the declared `brigadier-mcp` launcher against the built
bundle and requires a real MCP `initialize` response. Before releasing, repeat
that check from an installed tarball as the packaging-specific proof; the source
checkout test cannot prove the tarball's file list by itself.

The tag starts `.github/workflows/release.yml`. Before pushing it, confirm all
secrets above are present. If `NPM_TOKEN` is absent, npm publication is skipped.
If `RELEASE_PUBLISH_ENABLED` is absent or not exactly `true`, GitHub release
creation is skipped. If any Apple secret is absent, notarization is skipped.

After the workflow succeeds, verify both registries and download the exact
release archives:

```sh
gh run list --workflow release.yml --limit 1
gh release view "v${VERSION}"
npm view "@stephen-golban/brigadier@${VERSION}" version

mkdir -p "release-assets-${VERSION}"
gh release download "v${VERSION}" \
  --pattern "brigadier-${VERSION}-*.tar.gz" \
  --pattern "brigadier-${VERSION}-*.tar.gz.sha256" \
  --dir "release-assets-${VERSION}"

cd "release-assets-${VERSION}"
shasum -a 256 -c ./*.sha256
cd ..
```

Update the formula version, URLs, and four placeholder checksums from the downloaded files.
Then prove the tap and publish the formula update:

```sh
bun scripts/update-homebrew-formula.ts \
  "${VERSION}" "release-assets-${VERSION}"
git add Formula/brigadier.rb
git commit -m "Update Homebrew formula to v${VERSION}"

brew untap stephen-golban/brigadier 2>/dev/null || true
brew tap stephen-golban/brigadier "file://$(pwd)"
brew audit --strict stephen-golban/brigadier/brigadier
brew style stephen-golban/brigadier/brigadier
brew uninstall brigadier 2>/dev/null || true
brew install stephen-golban/brigadier/brigadier
brigadier --version
brew test stephen-golban/brigadier/brigadier

git push origin HEAD
```

Finally, install both public distribution paths into clean scratch locations:

```sh
scratch="$(mktemp -d /tmp/brigadier-release-check.XXXXXX)"
npm install --prefix "${scratch}" "@stephen-golban/brigadier@${VERSION}"
"${scratch}/node_modules/.bin/brigadier" --version

brew uninstall brigadier
brew install stephen-golban/brigadier/brigadier
brigadier --version
```

The accountable release owner must review the workflow run, npm package file
lists, Apple notarization result, release-asset checksums, and Homebrew test
before announcing the release.
