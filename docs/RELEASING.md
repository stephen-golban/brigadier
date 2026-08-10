# Releasing Brigadier

Nothing has ever been published. `package.json` says `0.0.0`, no version exists
on npm, no GitHub release exists, no Homebrew tap exists, and
`.github/workflows/release.yml` has never run because no `v*` tag has ever been
pushed. Everything below describes a path that has been exercised locally, step
by mechanical step, but never end to end against a real registry. The section
[What has never been proven](#what-has-never-been-proven) says exactly where the
proof stops.

A release ships five npm packages and four archives:

- `@stephen-golban/brigadier` — the JavaScript launchers, the typed `dist/`
  build, and the MCP server bundle.
- `@stephen-golban/brigadier-{darwin,linux}-{arm64,x64}` — one native executable
  each, installed as an `optionalDependency` of the root package so `npm i`
  fetches only the binary for the current machine.
- `brigadier-VERSION-PLATFORM.tar.gz` (plus a `.sha256` beside each) — the
  archives Homebrew downloads.

---

## The safety design, in one paragraph

The workflow triggers on any `v*` tag, but **every outward-facing step is gated
on a secret that does not exist yet**. Push a tag today and the workflow builds
everything and publishes nothing. That is deliberate: the missing secret *is* the
safety catch. Adding a secret is therefore the irreversible act, not pushing the
tag. Add them only when you intend to ship.

---

## What a tag does today, with no secrets set

Every one of these artifacts is built, and none of them leave GitHub. They land
in the **Artifacts** panel at the bottom of the workflow run page
(`github.com/stephen-golban/brigadier/actions` → the `Release` run), under
GitHub's default 90-day artifact retention. Nothing reaches npm, nothing reaches
the Releases page, nothing touches Homebrew.

| Uploaded artifact | Contents |
| --- | --- |
| `release-darwin-arm64` | `brigadier-VERSION-darwin-arm64.tar.gz`, its `.tar.gz.sha256`, `stephen-golban-brigadier-darwin-arm64-VERSION.tgz` |
| `release-darwin-x64` | the same three files for `darwin-x64` |
| `release-linux-arm64` | the same three files for `linux-arm64` |
| `release-linux-x64` | the same three files for `linux-x64` |
| `release-root-npm` | `stephen-golban-brigadier-VERSION.tgz` |

Which steps announce that they are disabled, and which merely vanish:

- **npm** — the job `Publish npm packages` runs to completion and its step
  `Publication disabled` prints `NPM_TOKEN is unset; npm publication is
  disabled`. The job is green. Nothing was published.
- **GitHub release** — the job `Publish GitHub release` runs and its step
  `Publication disabled` prints `RELEASE_PUBLISH_ENABLED is not true; GitHub
  release publication is disabled`. The job is green. No release was created.
- **Apple** — the two steps `Install Developer ID certificate` and
  `Developer ID sign and notarize` are **skipped silently**. Unlike the two
  cases above there is no else-branch and no message; they show as grey skipped
  steps and that is the only signal. No `.dmg` is produced, and none is attached
  anywhere.

The Darwin executables are still signed, but only **ad-hoc** (`codesign --force
--sign -`). That satisfies the arm64 requirement that a Mach-O binary carry some
signature, so the binary runs. It is not notarized, so a tarball downloaded
through a browser carries a quarantine attribute and Gatekeeper refuses it until
the user clears it.

The tag guard runs inside the four platform builds, not ahead of the workflow.
`scripts/verify-tag-version.sh` is the `Verify tag matches package version` step
of the `build-platform` job, after checkout and `bun install` and before anything
is compiled, and it fails that job unless the tag, `package.json`'s `version`,
and all four platform pins in `optionalDependencies` name the same version.

`package-root` runs in parallel with no guard of its own, so on a mismatched tag
that job still packs the root tarball and uploads it as the `release-root-npm`
artifact. Nothing reaches a registry or a release page, because `publish-npm`
waits on both build jobs and `publish-github` waits on `build-platform`, and a
failed guard skips both. The cost of a mismatched tag is therefore one stray
workflow artifact, never a publication.

`test/release-guard.test.ts` executes that step's own text out of the workflow
file, so the guard cannot rot unnoticed.

---

## One-time credentials

All of these are pasted in the same place:

**GitHub → the `brigadier` repository → Settings → Secrets and variables →
Actions → the `Secrets` tab → `Repository secrets` → `New repository secret`.**
Enter the exact `Name` below, paste the value into `Secret`, click
`Add secret`. Names are case-sensitive. Values are never echoed back, so a
typo shows up only as a failed release.

### `NPM_TOKEN` — enables npm publication

1. Sign in at <https://www.npmjs.com> as the owner of the `@stephen-golban`
   scope.
2. Click your profile picture, upper right → **Access Tokens**.
3. **Generate New Token** → choose **Granular Access Token**.
4. Name it something like `brigadier-release`, and set an **Expiration**. Note
   the date; the release breaks silently-ish on the day it lapses.
5. Under **Packages and scopes**, set **Permissions** to **Read and write**.
6. Still under **Packages and scopes**, choose **Only select packages and
   scopes** and select the **scope** `@stephen-golban` — *not* individual
   packages. This matters on the first release: none of the five packages exist
   on the registry yet, and a token scoped to specific packages cannot create a
   package that does not exist. A scope-level token can.
7. If the account has two-factor authentication required for publishing, tick
   **Bypass two-factor authentication**. A non-interactive CI publish cannot
   answer an OTP prompt. (The equivalent with the older token type is a
   **Classic Token → Automation**, which bypasses 2FA by design; either works.)
8. **Generate Token**, then copy the value shown once.

Format: the raw token string, which begins `npm_`. Paste it exactly — no
`Bearer` prefix, no quotes, no base64, no trailing newline.

Two facts about this package that matter and are already handled in the
repository, so you do not need to configure them: `package.json` carries
`"publishConfig": { "access": "public" }`, and the workflow also passes
`--access public`, which is what a *scoped* package needs on its first publish
to avoid defaulting to private. And the workflow publishes the **four platform
packages before the root package**, because the root package declares them as
`optionalDependencies` at the exact same version — publishing the root first
would leave a window where `npm install @stephen-golban/brigadier` resolves no
binary.

### `RELEASE_PUBLISH_ENABLED` — enables the GitHub release

Value: the literal five characters `true` — lowercase, unquoted, no surrounding
whitespace. It is compared as a string against `'true'`; `True`, `TRUE`, `1`,
and `yes` all leave publication disabled. There is nothing to obtain from
anywhere: you type it. GitHub supplies the `GITHUB_TOKEN` the release step uses,
so no personal access token is involved.

### The seven Apple secrets — enable Developer ID signing and notarization

All seven must be present. If even one is empty, both Apple steps skip and you
get the ad-hoc-signed binary described above.

**You very likely already have the certificate. Do not create a new one.**
Check first:

```sh
security find-identity -v -p codesigning
```

Read the output for a line whose quoted identity begins with
`Developer ID Application:`. The list commonly contains several valid identities
— an `Apple Development:` one, an `Apple Distribution:` or mobile-distribution
one, and so on. **Only `Developer ID Application` can sign software distributed
outside the App Store**, which is what a downloadable CLI is. Signing with any
of the others produces a binary Apple will refuse to notarize. This is the single
most common mistake in this whole document; the certificate types are genuinely
distinct, not interchangeable labels.

If, and only if, no `Developer ID Application:` line appears, create one at
<https://developer.apple.com/account/resources/certificates/list> → **+** →
**Developer ID** → **Developer ID Application**. Otherwise skip straight to the
export.

**Exporting the certificate you already have:**

1. Open **Keychain Access**.
2. Select the **login** keychain, then the **My Certificates** category.
3. Find the row beginning `Developer ID Application:`.
4. Click its disclosure triangle and confirm a **private key** is nested
   underneath. Without the private key the export produces a certificate-only
   `.p12` and signing on the runner fails with a misleading error.
5. Right-click the certificate row → **Export "Developer ID Application: …"**.
6. Set **File Format** to **Personal Information Exchange (.p12)** and save it,
   for example to `~/Desktop/DeveloperIDApplication.p12`.
7. Choose an export password when prompted. **That password is
   `APPLE_CERTIFICATE_PASSWORD`.** macOS then asks for your login keychain
   password to release the key; that one is not a secret you record anywhere.
8. Delete the `.p12` from disk once both secrets below are saved in GitHub.

Now the seven values:

- **`DEVELOPER_ID_IDENTITY`** — the full identity string exactly as
  `security find-identity -v -p codesigning` prints it *between the quotes*, with
  no quotes of your own. It has the shape
  `Developer ID Application: <Your Name> (<TEAM_ID>)`. Copy it verbatim,
  including the spaces and the parentheses.
- **`APPLE_TEAM_ID`** — the 10-character alphanumeric code inside the
  parentheses at the end of that identity string. It is the same value shown at
  <https://developer.apple.com/account> → **Membership details** → **Team ID**.
  Ten characters, nothing else — no parentheses, no name.
- **`APPLE_ID`** — the email address of the Apple Account that holds the
  Developer Program membership. A plain email address.
- **`APPLE_APP_PASSWORD`** — an **app-specific password**, not your Apple
  Account password and not your Mac's password. Create it at
  <https://account.apple.com> → **Sign-In and Security** → **App-Specific
  Passwords** → **Generate an app-specific password**. The account must have
  two-factor authentication enabled or the option does not appear. The value has
  the shape `xxxx-xxxx-xxxx-xxxx`; paste it with the hyphens, as shown.
  `xcrun notarytool` authenticates with this and will reject the account
  password.
- **`APPLE_CERTIFICATE_P12`** — the base64 encoding of the `.p12` you exported:

  ```sh
  base64 -i ~/Desktop/DeveloperIDApplication.p12 | pbcopy
  ```

  On macOS this produces one long unwrapped line, already on the clipboard;
  paste it straight into the secret. (Verified: `base64 -i` emits a single line
  and round-trips cleanly through the `base64 --decode` the workflow runs.)
- **`APPLE_CERTIFICATE_PASSWORD`** — the export password from step 7 above.
- **`KEYCHAIN_PASSWORD`** — a fresh random string with no other purpose. It only
  unlocks a throwaway keychain created and discarded inside the runner. Generate
  one with `openssl rand -base64 24` and paste it.

What the workflow then does with them: decodes the `.p12`, imports it into a
temporary keychain, signs the executable with the Developer ID identity using a
hardened runtime and a secure timestamp, wraps it in a disk image, submits the
disk image with `xcrun notarytool submit --wait`, and staples the ticket to the
disk image. A bare Mach-O command-line executable cannot itself carry a stapled
ticket, which is why the DMG exists at all: the release tarball gets the signed
executable, and the notarized DMG rides along as evidence.

---

## Moving the version, everywhere it lives

`0.0.0` appears in more places than `package.json`, and two of them will fail
`bun test` if you miss them — deliberately. This list was produced by actually
bumping the version to `0.1.0` in a scratch tree and running the full suite.

**Enforced — the release or the test suite fails if you skip these:**

1. `package.json` → `version`. Checked against the tag by
   `scripts/verify-tag-version.sh`.
2. `package.json` → all four `optionalDependencies` entries. Also checked by
   `scripts/verify-tag-version.sh`: a pin that drifts names a platform package
   version that will never be published, and `npm install` would then quietly
   fall back to the slower JavaScript launcher instead of failing.
3. `test/mcp.test.ts` → `const VERSION`. Two tests fail until it matches.
4. `test/mcp-entry.test.ts` → the golden `initialize` response string, which
   embeds `"version":"0.0.0"`. One test fails until it matches.

**Not enforced — nothing will tell you, so do them by hand:**

5. `bun.lock` → the four `optionalDependencies` entries. Regenerate with
   `bun install` after editing `package.json` and commit the result.
   (`bun install --frozen-lockfile` tolerates the mismatch, because the platform
   packages are optional and currently unresolvable, so CI will *not* catch a
   stale lockfile here.)
6. `src/surfaces/templates.ts` → the `claude-desktop/manifest.json` template
   string contains `"version": "0.0.0"`.
7. `surfaces/claude-desktop/manifest.json` → the staged copy of the same value.
8. `README.md` → the two passages stating the package is unpublished at `0.0.0`.
   They stop being true the moment the release lands.

> **Items 6 and 7 are unenforced only if you skip them. Doing them turns
> `bun test` red until you also move a pin.**
>
> `test/surfaces.test.ts` pins every installable surface file by absolute
> SHA-256 *and* byte length, in the `PINNED` map near the top of that file, and
> checks the compiled template and the staged file against the same entry. The
> `"claude-desktop/manifest.json"` entry currently reads
> `3c59451856ffbcc451e6fa1ea31572951d95317ec1d382b7dab87b6952f03f5f` and
> `1597` bytes. Changing the version inside the manifest makes both halves wrong
> and fails two tests — *every compiled template matches its pinned hash and
> size*, and *every file on disk matches the same pinned hash and size* —
> neither of which mentions the version, so the reason is not obvious from the
> failure.
>
> Edit item 6 and item 7 together, keeping them byte-identical, then recompute:
>
> ```sh
> shasum -a 256 surfaces/claude-desktop/manifest.json
> wc -c surfaces/claude-desktop/manifest.json
> ```
>
> Paste the hash into `sha256` and the byte count into `bytes` in the
> `"claude-desktop/manifest.json"` entry of `PINNED`. The pin is deliberate — it
> is what stops a regeneration script from corrupting a template and the
> constant describing it in the same pass — so update it, never delete it.

**Deliberately left behind:**

9. `Formula/brigadier.rb` keeps `version "0.0.0"` and its four placeholder
   digests until *after* the release exists. The real archives must be built and
   hashed before the formula can name them, so this file is updated at the end,
   by `scripts/update-homebrew-formula.ts`, never by hand.

---

## Shipping

### Step 1 — prepare the release commit, locally

Run from a clean checkout on macOS, on a branch, with `VERSION` set to the
version you intend to ship. Nothing here is public and every line is
reversible.

```sh
export VERSION=0.1.0

npm pkg set "version=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-darwin-arm64]=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-darwin-x64]=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-linux-arm64]=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-linux-x64]=${VERSION}"
bun install
```

Then edit items 3, 4, 6, 7, and 8 from the list above by hand.

Items 6 and 7 change a pinned file, so recompute the pin before you run the gate:

```sh
shasum -a 256 surfaces/claude-desktop/manifest.json
wc -c surfaces/claude-desktop/manifest.json
```

and put those two values into `sha256` and `bytes` of the
`"claude-desktop/manifest.json"` entry in the `PINNED` map in
`test/surfaces.test.ts`. Skip this and the `bun test` below fails on two surface
assertions that say nothing about versions.

Now run the full gate:

```sh
bun test
bun run typecheck
bun run check
bun run build
npm pack --dry-run
```

`bun test` covers the tag guard against the version you just set, and covers the
`brigadier-mcp` launcher against the real built bundle with a real MCP
`initialize` exchange. `bun run build` produces `dist/`, `dist/mcp/server.js`,
and the ad-hoc-signed `./brigadier`; all three are ignored by git.

Commit and push the branch, get it onto `main` the usual way, and check out the
commit you intend to tag.

### Step 2 — tag it

```sh
git tag -a "v${VERSION}" -m "v${VERSION}"
```

Signing is optional and requires a configured signing key; use `-s` if that is
already set up. Without a signing key, `git tag -s` fails instead of creating the
tag.

A local tag is still private and still deletable (`git tag -d`).

### Step 3 — the command that ships

**This is the one irreversible command. Everything before it is local;
everything after it is a consequence of it.**

```sh
git push origin "v${VERSION}"
```

That push, and nothing else, starts `.github/workflows/release.yml`. What
actually goes public is decided entirely by which secrets are present at that
moment:

| Secrets present | Result |
| --- | --- |
| none | four platform builds + five packed tarballs, all as workflow artifacts only |
| `NPM_TOKEN` | the above, plus all five packages published to npm |
| `RELEASE_PUBLISH_ENABLED=true` | the above, plus a GitHub release carrying the `.tar.gz`, `.sha256`, and any `.dmg` files |
| all seven Apple secrets | the Darwin binaries are Developer ID signed and notarized rather than ad-hoc signed |

An npm version, once published, cannot be republished. Deleting it is possible
for 72 hours and leaves the version permanently unusable afterwards. Treat the
push as final.

### Step 4 — verify what actually happened

```sh
gh run list --workflow release.yml --limit 1
gh run view --log-failed

gh release view "v${VERSION}"
npm view "@stephen-golban/brigadier@${VERSION}" version
npm view "@stephen-golban/brigadier@${VERSION}" optionalDependencies
```

Confirm by eye that the run's Apple steps ran rather than skipped, if you meant
them to, and that the `Publication disabled` steps did *not* appear.

### Step 5 — fill in the Homebrew formula

Only now do the placeholder digests become fillable.

```sh
mkdir -p "release-assets-${VERSION}"
gh release download "v${VERSION}" \
  --pattern "brigadier-${VERSION}-*.tar.gz" \
  --pattern "brigadier-${VERSION}-*.tar.gz.sha256" \
  --dir "release-assets-${VERSION}"

(cd "release-assets-${VERSION}" && shasum -a 256 -c ./*.sha256)

bun scripts/update-homebrew-formula.ts "${VERSION}" "release-assets-${VERSION}"
git add Formula/brigadier.rb
git commit -m "Update Homebrew formula to v${VERSION}"
```

The script rewrites the formula's `version`, all four download URLs, and all
four `sha256` lines, and refuses to touch the file unless it finds exactly one
of each block. It will also refuse a version that is already in the formula: the
replacement would be a no-op and the script reports
`failed to replace formula version block`. That is what you will see if you run
it twice for the same version, or run it for `0.0.0`.

Then prove the tap before pushing it:

```sh
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

### Step 6 — install from both public paths, from scratch

```sh
scratch="$(mktemp -d /tmp/brigadier-release-check.XXXXXX)"
npm install --prefix "${scratch}" "@stephen-golban/brigadier@${VERSION}"
"${scratch}/node_modules/.bin/brigadier" --version

brew uninstall brigadier
brew install stephen-golban/brigadier/brigadier
brigadier --version
```

The npm check is the one that proves the platform-package plumbing: if the
`optionalDependencies` pins are wrong, this still prints a version — it just
silently used the JavaScript fallback instead of the native binary. Confirm the
native package landed:

```sh
ls "${scratch}/node_modules/@stephen-golban/"
```

---

## What has never been proven

Be honest with yourself about which of these you are doing for the first time.

- **Notarization has never run.** `scripts/notarize.sh` has only ever been
  executed with its credentials absent, where it exits `1` naming the first
  missing variable. Every line past that check — the Developer ID `codesign`,
  `hdiutil create`, `xcrun notarytool submit --wait`, `xcrun stapler staple` —
  is unexecuted code. Apple's notary service may also reject a bare
  command-line executable in a DMG for reasons this repository cannot anticipate.
- **The certificate import on a runner has never run.** The
  `security import ... -t cert -f pkcs12` sequence in the workflow is untested
  against a real `.p12`.
- **Nothing has ever been published to npm**, so the scope permissions, the
  first-publish `--access public` behaviour, and the platform-before-root
  ordering are all reasoned about rather than observed.
- **No GitHub release has ever been created** by this workflow.
- **The Homebrew tap does not exist.** No `brew audit`, `brew install`, or
  `brew test` has ever run against this formula, and the formula still carries
  placeholder digests.
- **The workflow itself has never executed**, on any runner, for any tag. Only
  its individual steps have been reproduced by hand on a developer Mac: the
  cross-compile for all four targets, the tar and `shasum`, the platform package
  assembly, `npm pack`, the tag guard in both directions, and the formula
  rewrite against real digests.

The accountable release owner reviews the workflow run, the npm package file
lists, the notarization result, the release-asset checksums, and the Homebrew
test before announcing anything.
