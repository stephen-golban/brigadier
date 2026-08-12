# Releasing Brigadier

`package.json` says `0.1.1`. This release publishes all five packages to npm and
creates a GitHub release. Homebrew remains unavailable. Before this release,
the workflow had completed one secret-less tag run without publishing. The
section [What had never been proven before 0.1.1](#what-had-never-been-proven-before-011)
records what remained unproven when the `0.1.1` release began.

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

The workflow triggers on any `v*` tag. Before tagging, run `gh secret list` to
check whether `NPM_TOKEN` and `RELEASE_PUBLISH_ENABLED` are present. With both
absent, the tag builds everything and publishes nothing — run `31513095322`
measured exactly that state. With `NPM_TOKEN` present or
`RELEASE_PUBLISH_ENABLED` set to `true`, pushing the tag is the irreversible
publishing act for that path. Treat a listed publication secret as armed, and
add one only when you intend to ship.

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
- **Apple** — the four steps `Prove notarization requirement rejects ad-hoc
  binary`, `Install Developer ID certificate`, `Developer ID sign and notarize`,
  and `Verify release binary is Developer ID signed and notarized` are **skipped
  silently**. Unlike the two cases above there is no else-branch and no message;
  they show as grey skipped steps and that is the only signal. No `.dmg` is
  produced, and none is attached anywhere.

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

All seven must be present. If even one is empty, all four Apple steps skip
and you get the ad-hoc-signed binary described above.

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
hardened runtime and a secure timestamp, wraps it in a disk image, signs the disk
image with the Developer ID identity and a secure timestamp, submits it with
`xcrun notarytool submit --wait`, and staples the ticket to the disk image. A
bare Mach-O command-line executable cannot itself carry a stapled ticket, which
is why the DMG exists at all: the release tarball gets the signed executable,
and the notarized DMG rides along as evidence.

The disk image must be signed before it is submitted for notarization, not
just the executable inside it. An unsigned disk image fails
`spctl -a -t open --context context:primary-signature` with
`source=no usable signature` even after `xcrun stapler staple` and
`xcrun stapler validate` both report success — a stapled ticket does not by
itself prove the disk image will pass Gatekeeper.

---

## Moving the version, everywhere it lives

The current version appears in more places than `package.json`, and several are
enforced by `bun test` — deliberately. Move every version reference in items
1–8 from the current version to the next version. Items 9 and 10 are status
passages: review them during each release and update them only when the state
they describe has changed.

This list was first verified by the `0.0.0` → `0.1.0` bump and a full-suite run.
The `0.1.0` → `0.1.1` bump then ran the full list and all four gates: `bun test`
(817 pass, 2 skip, 0 fail), `bun run typecheck`, `bun run check`, and
`bun run build`, all with rc 0. That second pass exposed the item 9 defect: the
deferred-reword rule would have published a README saying the package was not on
npm.

**Enforced — the release or the test suite fails if you skip these:**

1. `package.json` → `version`. Move it from the current version to the next
   version. It is checked against the tag by `scripts/verify-tag-version.sh`.
2. `package.json` → all four `optionalDependencies` entries. Also checked by
   `scripts/verify-tag-version.sh`: move each pin from the current version to
   the next version. A pin that drifts names a platform package version that
   will never be published, and `npm install` would then quietly fall back to
   the slower JavaScript launcher instead of failing.
3. `test/mcp.test.ts` → `const VERSION` and the four golden JSON-RPC frames
   that embed the current version. Move both the constant and every frame to
   the next version. In the past `0.0.0` → `0.1.0` bump, applying items 1 and 2
   while leaving this file untouched made two tests fail; changing that constant
   alone does not update the golden frames.
4. `test/mcp-repository-path.test.ts` → its golden `initialize` response
   frame, which embeds the current version. Move it to the next version. This
   file was added in `4d0dd97` and was missed when this list was revised.
5. `test/mcp-entry.test.ts` → the golden `initialize` response string, which
   embeds the current version. Move it to the next version; one test fails until
   it matches.

**Not enforced — nothing will tell you, so do them by hand:**

6. `bun.lock` → the four `optionalDependencies` entries. Regenerate with
   `bun install` after moving the pins in `package.json` to the next version and
   commit the result.
   (`bun install --frozen-lockfile` tolerates the mismatch, because the platform
   packages are optional and currently unresolvable, so CI will *not* catch a
   stale lockfile here.)
7. `src/surfaces/templates.ts` → the `claude-desktop/manifest.json` template
   string. Move its version from the current version to the next version.
8. `surfaces/claude-desktop/manifest.json` → the staged copy of the same
   value. Move it from the current version to the next version too.
9. `README.md` → the two publication-status passages. Review them during each
   release and update them in the release commit only when the publication state
   they describe will change. The tagged commit is the published npm artifact,
   and npm serves that README for that version; correcting it after the release
   requires publishing another version.
10. `src/config/contracts.ts` → the comment describing what `init` does when
    config validation fails. Review it during each release and update it only if
    that behaviour has changed.

> **Items 7 and 8 are unenforced only if you skip them. Doing them turns
> `bun test` red until you also move a pin.**
>
> `test/surfaces.test.ts` pins every installable surface file by absolute
> SHA-256 *and* byte length, in the `PINNED` map near the top of that file, and
> checks the compiled template and the staged file against the same entry. Look
> up the `"claude-desktop/manifest.json"` entry before changing it. For example,
> after the past `0.0.0` → `0.1.0` bump it contains SHA-256
> `ca12f56795d0800bdd9e1cc55826e76168ff01a3c92a1a05dbfd1ba0cbb77beb` and
> `1597` bytes. Changing the version inside the manifest makes both halves wrong
> and fails two tests — *every compiled template matches its pinned hash and
> size*, and *every file on disk matches the same pinned hash and size* —
> neither of which mentions the version, so the reason is not obvious from the
> failure.
>
> Edit item 7 and item 8 together, keeping them byte-identical, then recompute:
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

11. `Formula/brigadier.rb` keeps `version "0.0.0"` and its four placeholder
   digests until *after* the release exists. The real archives must be built and
   hashed before the formula can name them, so this file is updated at the end,
   by `scripts/update-homebrew-formula.ts`, never by hand.

---

## Shipping

### Step 1 — prepare the release commit, locally

Run from a clean checkout on macOS, on a branch, with `VERSION` set to the
version you intend to ship. Nothing here is public and every line is
reversible.
Set `VERSION` to the version being released.

```sh
export VERSION=REPLACE_WITH_RELEASE_VERSION

npm pkg set "version=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-darwin-arm64]=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-darwin-x64]=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-linux-arm64]=${VERSION}" \
  "optionalDependencies[@stephen-golban/brigadier-linux-x64]=${VERSION}"
bun install
```

Then edit items 3, 4, 5, 7, and 8 from the list above by hand. Review items 9
and 10, and update them only when the state they describe has changed.

Items 7 and 8 change a pinned file, so recompute the pin before you run the gate:

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

## What has been exercised

These release-path measurements have been made, and their limits are recorded
here:

- **The tag guard has been exercised in both directions.** Against the bumped
  `0.1.1` tree, the guard returned rc `0` for
  `GITHUB_REF_NAME="v0.1.1" bash scripts/verify-tag-version.sh` and rc `1` for
  `GITHUB_REF_NAME="v0.1.0" bash scripts/verify-tag-version.sh`.
- **Owner-reported manual exercise, with no retained repository evidence:** the
  formula rewrite against real digests was reproduced by hand on a developer
  Mac.
- **The secret-less tag path has executed.** Run `31513095322`, triggered by
  pushing `v0.1.0` with `gh secret list` empty, completed all seven jobs green
  and produced five artifacts: `release-darwin-arm64` (48 MB),
  `release-darwin-x64` (54 MB), `release-linux-arm64` (74 MB),
  `release-linux-x64` (74 MB), and `release-root-npm` (1 MB). Both publication
  jobs went green by skipping: `Create GitHub release: skipped` →
  `Publication disabled`, and `Publish platform packages: skipped` →
  `Publication disabled`. Afterwards, `gh release list` returned zero releases
  and `npm view @stephen-golban/brigadier` returned `E404`. This measures the
  secret-less-tag behaviour; it does not prove either publication path.
- **Notarization rehearsal 1 ran locally on 2026-08-11, mirroring the workflow's
  steps.** `xcrun notarytool submit --wait` returned **Accepted** for submission
  `b5bd2889-2a7e-4f2d-b99a-a172d5ac5d7d` on the first attempt, with no warnings,
  in roughly four minutes. This proved that Apple accepts a bare Mach-O
  command-line executable inside a DMG. It also proved that the three
  `notarytool` credentials authenticate, that the `.p12` base64 round-trips
  byte-identically through the workflow's `base64 --decode`, and that the
  `.p12` → throwaway-keychain import path works. The import was checked by
  asking the throwaway keychain by name with
  `security find-identity -v -p codesigning <throwaway>`, so the machine's own
  copy of the same certificate could not mask a silently failed import. This
  rehearsal also found the unsigned-DMG defect: `xcrun stapler staple` and
  `xcrun stapler validate` both succeeded, but
  `spctl -a -t open --context context:primary-signature` rejected the disk image
  with `source=no usable signature`, and `codesign -dv` confirmed that the DMG
  carried no signature of its own.
- **Notarization rehearsal 2 ran on 2026-08-12 at commit `bb8305e`.** It invoked
  the real, unmodified `scripts/notarize.sh` against a real build, not a
  reimplementation. The working-tree and `HEAD` copies of that script are
  byte-identical, with SHA-256
  `d452cdc1d1ae68618f8c3f172f84007c05b6685d72732ef3b034e5337e46f3da`, and
  rehearsal 2 invoked that file at `bb8305e`, the same commit that would be
  tagged. `xcrun notarytool submit --wait` returned **Accepted** for submission
  `3b415bcb-3068-48a2-8f9e-4a884797a6c6`. The first decisive check,
  `spctl -a -t open --context context:primary-signature`, accepted the disk
  image with rc `0`; before the signing fix it rejected the image. The binary
  notarized inside the DMG is the same file that the copy-back at the end of
  `scripts/notarize.sh` writes to `ARTIFACT_PATH`, so the cdhash Apple notarized
  is the cdhash that ships. Losing that copy-back destroys this identity, which
  is why the workflow gates on it. Both decisive checks were then reproduced
  as fresh invocations against the produced artifacts, outside the rehearsal
  harness:
  `spctl -a -t open --context context:primary-signature` returned rc `0` for the
  disk image, and `codesign --verify -R "=notarized"` returned rc `0` for the
  binary. The binary is not ad-hoc. An ad-hoc baseline was checked first and
  rejected with rc `3`, so none of these passes are vacuous. Rehearsal 2 ran in
  reduced mode, which disabled both the `.p12` → throwaway-keychain import and
  the by-name keychain isolation check; signing deliberately used an ambient
  certificate already in the login keychain. It therefore proves neither the
  `.p12` import nor that signing consumed an imported artifact rather than an
  ambient one. It mirrored only the signing and notarization path once a
  certificate is present. Rehearsal 1 alone proves the runner-mirroring
  credential path.
- **Apple retains both submissions, but the history is not the discriminating
  evidence.** On the release owner's machine,
  `xcrun notarytool history --keychain-profile "brigadier-local-proof"` returns
  both as **Accepted**:
  `b5bd2889-2a7e-4f2d-b99a-a172d5ac5d7d` for
  `brigadier-v0.1.1-darwin-arm64.dmg` at `2026-08-11T17:38:33.469Z`
  (rehearsal 1), and `3b415bcb-3068-48a2-8f9e-4a884797a6c6` for the same filename
  at `2026-08-12T14:23:57.957Z` (rehearsal 2). The `brigadier-local-proof`
  keychain profile exists only on that machine, so an arbitrary reader on other
  hardware cannot retrieve this history. Apple records that a submission with
  that filename was Accepted on that date; the history does not establish which
  bytes were submitted and says nothing about whether the disk image was
  signed. Rehearsal 1 was also **Accepted**, yet its DMG failed `spctl`.
  **Accepted** was never the property in doubt. The discriminating evidence is
  the rehearsal 2 disk image's rc `0` from `spctl` against rehearsal 1's
  rejection. The rehearsal artifacts were deliberately not preserved, so this
  document is now the record of that evidence; the history remains available to
  the release owner without spending another Apple submission or re-entering an
  app-specific password.
- **The `=notarized` gate has been measured against the kind of bare executable
  Brigadier ships.** Without making another Apple submission,
  `codesign --verify -R "=notarized"` returned rc `0` for a third-party
  notarized command-line executable already on the machine, even though
  `xcrun stapler validate` reported that it had no stapled ticket. The same
  command returned rc `3` for Brigadier's own ad-hoc-signed binary. A bare
  executable cannot carry a stapled ticket, so this proves that the workflow's
  `=notarized` gate is valid for the release artifact itself, not only for the
  DMG.
- **Whether the `=notarized` check requires network access remains unsettled.**
  The rehearsal script's check 4 produced the invalid probes
  `0.163 / 0.161 / 0.165s` (all invalid): an earlier check in the same run had
  already executed `codesign --verify -R "=notarized"` against that same binary
  moments before, so every probe was warm and the cold case was never sampled.
  The cold first call of a clean re-measurement on a notarized binary that
  nothing had previously queried measured `0.3152s`. Its four warm repeats on
  the same file measured `0.3362 / 0.3222 / 0.3093 / 0.3272s`, and a second cold
  call on a different never-queried notarized binary measured `0.2779s`. The
  repeats were flat, with no cold/warm signature. That argues against a cached
  network result but is not conclusive without an offline test. The workflow
  comment therefore remains deliberately hedged: the check *may* consult Apple.
- **The workflow's wiring remains unexercised with the publication secrets
  present.** `gh run list --workflow release.yml` returns exactly one run ever:
  `31513095322`, for tag `v0.1.0`, with no secrets set. On a real runner, the
  seven-secret `if:` conditions have therefore never evaluated true, and the
  `.p12` `security import`, `scripts/notarize.sh`, and the two verification steps
  added in `bb8305e` have never run. Their first workflow execution will be the
  real release. Rehearsal 2 proved the script's behaviour. The workflow's wiring
  is a separate thing and remains unexercised. This is an acceptable risk rather
  than a blocker: `publish-npm` declares
  `needs: [build-platform, package-root]`, and `publish-github` declares
  `needs: build-platform`, so any `build-platform` failure blocks both publish
  jobs. Nothing reaches npm or Releases, the version stays free on the registry,
  and the git tag can be deleted and re-pushed. The unrecoverable act is an npm
  publish, and it cannot happen if the build gate fires.

---

## What had never been proven before 0.1.1

This is a baseline scoped to before the release. Its statements were true when
written; they do not describe the current state. Later evidence is recorded in
[What has been exercised](#what-has-been-exercised).

These were unproven when the `0.1.1` release began:

- **Notarization had never run.** `scripts/notarize.sh` had only ever been
  executed with its credentials absent, where it exited `1` naming the first
  missing variable. Every line past that check — the Developer ID `codesign`,
  `hdiutil create`, `xcrun notarytool submit --wait`, `xcrun stapler staple` —
  was unexecuted code. Apple's notary service could also reject a bare
  command-line executable in a DMG for reasons this repository could not
  anticipate.
- **The certificate import on a runner had never run.** The
  `security import ... -t cert -f pkcs12` sequence in the workflow had not been
  tested against a real `.p12`.
- **Nothing had ever been published to npm**, so the scope permissions, the
  first-publish `--access public` behaviour, and the platform-before-root
  ordering had all been reasoned about rather than observed.
- **No GitHub release had ever been created** by this workflow.
- **The Homebrew tap did not exist.** No `brew audit`, `brew install`, or
  `brew test` had ever run against this formula, and the formula still carried
  placeholder digests.

The accountable release owner reviews the workflow run, the npm package file
lists, the notarization result, the release-asset checksums, and the Homebrew
test before announcing anything.
