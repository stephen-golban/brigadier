# Releasing Brigadier

`package.json` says `0.1.1`. No Brigadier release has been cut yet, so this
runbook has not been executed end to end. GitHub Releases are the only
distribution channel: the first release will publish four compiled binaries in
per-platform archives, their checksums, and the notarized macOS disk images.
The package manifest is private and is not itself a distribution artifact.

`Formula/brigadier.rb` therefore still carries version `0.0.0` and deliberately
fake placeholder digests. Do not "fix" them before the first release exists.
The release workflow replaces them from the checksums of the artifacts it
actually built, then pushes that formula update to the default branch.

A complete release contains:

| Asset | Contents |
| --- | --- |
| `brigadier-VERSION-darwin-arm64.tar.gz` | the compiled Apple Silicon executable |
| `brigadier-VERSION-darwin-x64.tar.gz` | the compiled Intel macOS executable |
| `brigadier-VERSION-linux-arm64.tar.gz` | the compiled ARM64 Linux executable |
| `brigadier-VERSION-linux-x64.tar.gz` | the compiled x64 Linux executable |
| one `.tar.gz.sha256` beside each archive | that archive's SHA-256 digest and filename |
| `brigadier-vVERSION-darwin-arm64.dmg` | the Developer ID-signed, notarized, and stapled Apple Silicon disk image |
| `brigadier-vVERSION-darwin-x64.dmg` | the Developer ID-signed, notarized, and stapled Intel disk image |
| `checksums.txt` | SHA-256 digests for every archive, per-archive checksum file, and disk image |

Each archive contains one file named `brigadier`. The two disk images exist only
when all seven Apple secrets are present and the notarization path succeeds.

---

## The safety design, in one paragraph

The workflow triggers on any pushed `v*` tag. Every matrix job runs
`scripts/verify-tag-version.sh` before compiling and refuses a tag whose name,
after removing the leading `v`, does not equal `package.json`'s `version`.
Building and publishing are separate: the four platform artifacts are always
built, while the GitHub release and the Homebrew formula update run only when
the repository secret `RELEASE_PUBLISH_ENABLED` is exactly `true`. Apple
credentials are another independent gate. Missing any one of the seven Apple
secrets silently skips the Developer ID and notarization steps, leaving only the
initial ad-hoc signature. Before pushing a public tag, verify both gates; the
workflow does not infer that publication should wait for Apple credentials.

---

## What a tag does

`.github/workflows/release.yml` is the authority. It runs these steps in this
order.

### 1. Build four platform executables

The `build-platform` matrix has exactly four entries:

| Platform | Runner | Bun compile target |
| --- | --- | --- |
| `darwin-arm64` | `macos-latest` | `bun-darwin-arm64` |
| `darwin-x64` | `macos-latest` | `bun-darwin-x64` |
| `linux-arm64` | `ubuntu-latest` | `bun-linux-arm64` |
| `linux-x64` | `ubuntu-latest` | `bun-linux-x64` |

Each job checks out the tagged commit, installs the frozen Bun lockfile, runs
the tag guard, and then compiles `src/cli.ts`:

```sh
bun build ./src/cli.ts --compile --bytecode --minify --sourcemap \
  --target=TARGET --outfile ./release-bin/brigadier
```

The `TARGET` value comes from the table above. The workflow does not build one
portable script and relabel it; these are four native executables.

### 2. Sign and notarize the macOS executables

Every Darwin build is first ad-hoc signed and strictly verified:

```sh
codesign --force --sign - ./release-bin/brigadier
codesign --verify --strict ./release-bin/brigadier
```

When all seven Apple secrets are present, the workflow immediately proves that
this freshly ad-hoc-signed control does **not** satisfy the release requirement:

```sh
codesign --verify -R "=notarized" ./release-bin/brigadier
```

An unexpected success fails the job. This negative control is load-bearing: it
proves the later positive result did not pass on the ad-hoc input.

The workflow then decodes the Developer ID certificate, creates and unlocks a
throwaway keychain, imports the certificate and private key, grants the signing
tools access, and makes that keychain the runner's user keychain list.
`scripts/notarize.sh` performs the release signing in this exact order:

1. Copy the executable to a private payload directory.
2. Sign the payload executable with the Developer ID identity, hardened runtime,
   and a secure timestamp, then strictly verify it.
3. Create a compressed HFS+ disk image containing that signed executable.
4. Sign the disk image with the Developer ID identity and a secure timestamp,
   then strictly verify it.
5. Submit the signed disk image with `xcrun notarytool submit --wait`.
6. Staple the ticket to the disk image and validate the staple.
7. Copy the signed payload executable back over `release-bin/brigadier`.

The disk image must be signed **before** notarization. Signing only the
executable is insufficient: an unsigned disk image can pass both `stapler
staple` and `stapler validate` and still fail Gatekeeper's decisive check:

```sh
spctl -a -t open --context context:primary-signature PATH_TO_DMG
```

with `source=no usable signature`. A stapled ticket does not by itself prove the
disk image has a usable signature.

The copy-back in step 7 is equally load-bearing. It makes the executable placed
in the tarball byte-for-byte the Developer ID-signed executable Apple saw inside
the submitted disk image. Removing it would ship the earlier ad-hoc copy instead.

After the script returns, the workflow gates archive assembly on:

```sh
codesign --verify -R "=notarized" ./release-bin/brigadier
```

Do not replace this with a `codesign -dv` text search. A binary can be Developer
ID-signed without being notarized, and diagnostic output can expose the signer
identity. A bare Mach-O executable cannot carry a stapled ticket, so the
`=notarized` requirement may consult Apple; an Apple outage must fail the
release rather than weaken the gate. If the requirement fails, the workflow
checks only whether `Signature=adhoc` is present so it can print the precise
failure, then exits nonzero.

### 3. Assemble one archive and checksum per platform

Each successful matrix job creates
`brigadier-VERSION-PLATFORM.tar.gz` from `release-bin/brigadier`, copies its DMG
when one exists, and runs:

```sh
shasum -a 256 "brigadier-VERSION-PLATFORM.tar.gz" \
  > "brigadier-VERSION-PLATFORM.tar.gz.sha256"
```

It uploads those files as the workflow artifact `release-PLATFORM`. A Darwin
artifact contains an archive, its checksum file, and—when notarization ran—a
DMG. A Linux artifact contains the archive and checksum file.

### 4. Assemble the combined checksum manifest

The `publish-github` job waits for all four platform jobs, downloads every
`release-*` workflow artifact into one directory, and refuses an empty download.
It computes `checksums.txt` across every `.tar.gz`, `.tar.gz.sha256`, and `.dmg`:

```sh
shasum -a 256 "${release_assets[@]}" > checksums.txt
```

This means `checksums.txt` covers the per-archive checksum files as artifacts in
their own right as well as the archives and disk images.

### 5. Create the GitHub release

When `RELEASE_PUBLISH_ENABLED` is exactly `true`, the workflow creates a release
for the pushed tag with every archive, every per-archive checksum, every DMG,
and `checksums.txt`. `gh release create` uses `--verify-tag` and
`--generate-notes`.

When the secret is absent or has any other value, the job prints:

```text
RELEASE_PUBLISH_ENABLED is not true; GitHub release publication is disabled
```

It creates no release and does not update Homebrew. The assembled files remain
workflow artifacts only.

### 6. Update Homebrew from the files just released

Immediately after release creation, in the same conditional job, the workflow
runs:

```sh
version="${GITHUB_REF_NAME#v}"
bun ./scripts/update-homebrew-formula.ts "${version}" ./release-packages
```

The script's complete interface is:

```text
update-homebrew-formula.ts <version> <release-assets-directory> [formula-path]
```

The optional formula path defaults to `Formula/brigadier.rb`. The script reads
the four `brigadier-VERSION-PLATFORM.tar.gz.sha256` files, rejects a checksum
whose filename does not exactly name its expected archive, then replaces the
formula version, four release URLs, and four digests exactly once. It refuses a
missing, duplicate, malformed, or no-op replacement.

The workflow commits only `Formula/brigadier.rb` as
`Update Homebrew formula to vVERSION` and pushes that commit to the repository's
default branch. The formula is therefore derived from the real release
artifacts, not precomputed values.

---

## One-time credentials

All credentials go to **GitHub → the `brigadier` repository → Settings →
Secrets and variables → Actions → the `Secrets` tab → Repository secrets → New
repository secret**. Names are case-sensitive. Values are never echoed back, so
a typo appears only as a skipped or failed release step.

### `RELEASE_PUBLISH_ENABLED` — enables the GitHub release and formula update

Value: the literal five characters `true`—lowercase, unquoted, with no
surrounding whitespace. It is compared as a string against `'true'`; `True`,
`TRUE`, `1`, and `yes` all leave publication disabled. GitHub supplies the token
used to create the release and push the formula commit; no personal access token
is involved.

### The seven Apple secrets — enable Developer ID signing and notarization

All seven must be present. If even one is empty, all four guarded Apple steps
skip and no DMG is produced.

**You very likely already have the certificate. Do not create a new one.** Check
first:

```sh
security find-identity -v -p codesigning
```

Read the output for an identity beginning `Developer ID Application:`. The list
commonly contains several valid identities—`Apple Development:`, Apple or mobile
distribution identities, and others. Only `Developer ID Application` can sign
software distributed outside the App Store. Signing with a different identity
produces an artifact Apple will refuse to notarize.

If, and only if, no `Developer ID Application:` identity appears, create one at
<https://developer.apple.com/account/resources/certificates/list> → **+** →
**Developer ID** → **Developer ID Application**. Otherwise use the existing
identity.

**Exporting the certificate you already have:**

1. Open **Keychain Access**.
2. Select the **login** keychain and **My Certificates**.
3. Find the row beginning `Developer ID Application:`.
4. Expand it and confirm a private key is nested underneath. Without the private
   key, the export produces a certificate-only file and runner signing fails.
5. Right-click the certificate row and choose **Export**.
6. Select **Personal Information Exchange (`.p12`)** and save it temporarily.
7. Choose an export password. That password is
   `APPLE_CERTIFICATE_PASSWORD`. The later prompt for the login keychain
   password is not a repository secret.
8. Delete the exported file after its encoded contents and password are safely
   stored in GitHub.

The seven values are:

- **`DEVELOPER_ID_IDENTITY`** — the complete identity string between the quotes
  printed by `security find-identity`, without adding quotes. It has the form
  `Developer ID Application: Name (TEAM_ID)`.
- **`APPLE_TEAM_ID`** — the 10-character code inside the final parentheses of
  that identity, with no parentheses or name. It is also shown under Apple
  Developer account membership details.
- **`APPLE_ID`** — the email address of the Apple Account holding the Developer
  Program membership.
- **`APPLE_APP_PASSWORD`** — an app-specific password from
  <https://account.apple.com> → **Sign-In and Security** → **App-Specific
  Passwords**. Keep the hyphens. This is neither the Apple Account password nor
  the Mac login password. The account needs two-factor authentication before
  Apple offers app-specific passwords.
- **`APPLE_CERTIFICATE_P12`** — the base64 encoding of the exported file:

  ```sh
  base64 -i /path/to/DeveloperIDApplication.p12 | pbcopy
  ```

  On macOS this produces one unwrapped line. The workflow reverses it with
  `base64 --decode`.
- **`APPLE_CERTIFICATE_PASSWORD`** — the export password chosen above.
- **`KEYCHAIN_PASSWORD`** — a fresh random string used only for the runner's
  throwaway keychain. Generate one with:

  ```sh
  openssl rand -base64 24
  ```

Before the first public tag, use `gh secret list` and confirm all eight names—
the publication switch plus all seven Apple secrets—are present. Presence does
not prove the values are correct; the first workflow execution remains the
decisive test.

---

## Moving the version everywhere it lives

The release guard compares only `package.json` with the tag. Other version
copies are enforced by tests or are human-maintained release records. Search
the tree before each release instead of trusting a frozen list:

```sh
rg -n '0\.1\.1' \
  package.json src test surfaces docs CHANGELOG.md SECURITY.md
```

Replace `0.1.1` with the version currently in `package.json` when running that
search. Classify every hit before changing it: examples and historical evidence
may deliberately retain an older version.

These current-version copies move together:

1. `package.json` → `version`. This is the value guarded against the tag.
2. `test/mcp.test.ts` → `const VERSION` and the golden JSON-RPC responses that
   embed the current server version.
3. `test/mcp-repository-path.test.ts` → the golden `initialize` response.
4. `test/mcp-entry.test.ts` → the golden `initialize` response produced by the
   real built Desktop entry.
5. `src/surfaces/templates.ts` → the Claude Desktop manifest template version.
6. `surfaces/claude-desktop/manifest.json` → the staged copy of that version.
7. `CHANGELOG.md` and `SECURITY.md` → the release record and supported-version
   statement, when the release state they describe actually changes.

Items 5 and 6 must remain byte-identical in meaning. They also change the pinned
surface bytes. Recompute:

```sh
shasum -a 256 surfaces/claude-desktop/manifest.json
wc -c surfaces/claude-desktop/manifest.json
```

and update the `sha256` and `bytes` values for
`"claude-desktop/manifest.json"` in the `PINNED` map in
`test/surfaces.test.ts`. The pin is deliberate: update it; never delete it.

Do **not** move the formula's `0.0.0` or placeholder digests in the release
commit. The workflow updates them only after it has created the release from
real artifacts.

---

## Shipping

### Step 1 — prepare the release commit locally

Start from a clean macOS checkout on a branch. Set `VERSION` to the version you
intend to ship, update the version copies above, and review all public status
language for truth at the moment the tag will be pushed.

```sh
export VERSION=REPLACE_WITH_RELEASE_VERSION
bun install --frozen-lockfile
bun run format
bun run check
bun run typecheck
bun test
bun run build
```

`bun run build` produces the Node distribution, the runnable Desktop MCP entry
at `dist/mcp/server.js`, and one compiled executable for the local machine. The
release workflow—not this local build—produces the four release executables.

Commit and push the branch, get it onto the default branch through the usual
review, then check out the exact commit you intend to tag. Confirm the worktree
is clean.

### Step 2 — arm and verify the release gates

Run:

```sh
gh secret list
```

Confirm the `RELEASE_PUBLISH_ENABLED` name and all seven Apple secret names above
are present. Secret values cannot be read back; if the publication switch was
not recorded as the literal `true` or there is any doubt, set it again before
tagging. If any Apple secret is missing, stop: the workflow would still be able
to create a public release, but its Darwin archives would contain only
ad-hoc-signed executables and it would upload no DMGs.

### Step 3 — create the tag locally

```sh
git tag -a "v${VERSION}" -m "v${VERSION}"
```

Signing is optional and requires an already configured signing key; use `-s`
instead of `-a` only when that setup is known to work. A local tag is still
private and can be deleted with `git tag -d "v${VERSION}"`.

### Step 4 — push the tag

```sh
git push origin "v${VERSION}"
```

That push starts `.github/workflows/release.yml`. With publication enabled, a
successful run creates the GitHub release and then commits and pushes the
Homebrew formula update. Treat the push as the publication boundary.

### Step 5 — watch every workflow step

```sh
gh run list --workflow release.yml --limit 1
gh run watch RUN_ID --exit-status
```

Inspect the run as well as its final status. Confirm:

- all four `Verify tag matches package version` steps passed;
- both ad-hoc negative-control steps ran and rejected their inputs;
- both certificate installation and both notarization steps ran rather than
  appearing grey and skipped;
- both `=notarized` positive gates passed before archive assembly;
- all four `release-PLATFORM` artifacts were uploaded;
- `Assemble combined checksums` ran after all four downloads;
- `Create GitHub release` ran rather than `Publication disabled`; and
- `Update Homebrew formula from release artifacts` committed and pushed.

Any failed `build-platform` job blocks the publish job entirely. A failure after
`Create GitHub release` but during the formula update is different: the release
already exists and the formula needs the manual recovery below.

### Step 6 — verify the public release assets

```sh
gh release view "v${VERSION}"
mkdir -p "release-assets-${VERSION}"
gh release download "v${VERSION}" --dir "release-assets-${VERSION}"
(
  cd "release-assets-${VERSION}"
  shasum -a 256 -c ./*.tar.gz.sha256
  shasum -a 256 -c checksums.txt
  for archive in ./*.tar.gz; do
    tar -tzf "${archive}"
  done
)
```

There must be four archives, four per-archive checksum files, two DMGs, and one
`checksums.txt`. Every checksum must pass, and every archive listing must be the
single path `brigadier`.

Extract the two Darwin archives separately and verify their executables with the
same requirement the workflow uses:

```sh
codesign --verify -R "=notarized" PATH_TO_EXTRACTED_BRIGADIER
```

Verify both downloaded disk images with Gatekeeper:

```sh
spctl -a -t open --context context:primary-signature PATH_TO_DMG
```

### Step 7 — verify or recover the Homebrew formula update

Confirm the default branch now contains `Formula/brigadier.rb` at `VERSION`,
with four `vVERSION` release URLs and four non-placeholder digests matching the
downloaded `.sha256` files.

If the GitHub release exists but the workflow failed before pushing the formula
commit, recover from the downloaded release artifacts:

```sh
bun ./scripts/update-homebrew-formula.ts \
  "${VERSION}" "release-assets-${VERSION}"
git add Formula/brigadier.rb
git commit -m "Update Homebrew formula to v${VERSION}"
git push origin HEAD
```

The optional third argument may name a formula elsewhere; omit it for this
repository's `Formula/brigadier.rb`.

### Step 8 — verify both public installation paths

**Not operational today:** no GitHub release exists yet, so this command has no
tarball to download. It is the primary install path and will work only after the
first release is cut:

```sh
curl -fsSL https://raw.githubusercontent.com/stephen-golban/brigadier/main/install.sh | sh
```

`install.sh` is POSIX `sh`. It detects the platform with `uname`, downloads the
matching GitHub release archive and its `.sha256`, verifies SHA-256, and installs
to `~/.local/bin` unless `BRIGADIER_INSTALL_DIR` overrides it. It never uses
`sudo`. It stages in a `mktemp -d` directory inside the install directory,
marks the staged binary executable, unlinks a destination symlink instead of
following it, then renames the staged file over the destination. It refuses with
a named error when the destination is a real directory and warns when the
install directory is absent from `PATH`. Finally, it hands `brigadier init` to
`/dev/tty`, so the host-selection prompt still works through `curl | sh`.

**Not operational today:** the formula intentionally contains placeholder
digests because no release exists. This is the second install path and will work
only after the first release workflow fills the formula from real artifacts:

```sh
brew install stephen-golban/tap/brigadier
```

After the release and formula commit both exist, run both commands on clean
machines for every supported operating-system and architecture pair. Confirm
`brigadier --version` prints `VERSION`, then run `brigadier init` and exercise a
real host installation.

---

## The Claude Desktop `.mcpb` bundle

The Desktop bundle is not a GitHub release asset and Brigadier never installs it
into Desktop. Desktop installs it only after an explicit user action.

To build it from a checkout:

1. Run `bun run build:mcp`. This emits the runnable program
   `dist/mcp/server.js`.
2. In the staged bundle directory beside `manifest.json`, create `server/` and
   copy that output to `server/brigadier-mcp.js`, the manifest's entry point.
3. Zip the staged directory with `manifest.json` at the archive root.
4. Rename the archive to `brigadier.mcpb` and open it with Claude Desktop.

The emitted entry is a real program: when Desktop launches it, it starts the
JSON-RPC server and answers requests over standard input and output. Keep the
manifest at the archive root and the copied program at the exact nested path it
names.

---

## What has been exercised

These release-path measurements have been made, and their limits matter:

- **The tag guard is covered in both directions.**
  `test/release-guard.test.ts` runs the workflow's guard against the real
  package version, a mismatched version, and an absent tag name. The script now
  compares only the tag with `package.json`'s version.
- **The formula rewrite is exercised without network access.**
  `test/installer.test.ts` checks all four deterministic asset names and URLs,
  rejects a checksum naming the wrong archive, and proves the formula rewrite
  replaces the version, URLs, and digests.
- **Notarization rehearsal 1 ran locally on 2026-08-11, mirroring the credential
  path.** `xcrun notarytool submit --wait` returned **Accepted** for submission
  `b5bd2889-2a7e-4f2d-b99a-a172d5ac5d7d` in roughly four minutes. It proved the
  three notary credentials authenticate, the exported certificate round-trips
  through the workflow's base64 decode, and the certificate plus private key
  import into a throwaway keychain works. Querying that keychain by name kept an
  ambient certificate from masking a failed import. This rehearsal exposed the
  unsigned-DMG defect: stapling and staple validation both succeeded, but
  `spctl -a -t open --context context:primary-signature` rejected the image with
  `source=no usable signature`.
- **Notarization rehearsal 2 ran on 2026-08-12 at commit `bb8305e` against the
  real `scripts/notarize.sh`.** Submission
  `3b415bcb-3068-48a2-8f9e-4a884797a6c6` returned **Accepted**.
  Gatekeeper accepted the signed disk image with exit code `0`, and
  `codesign --verify -R "=notarized"` accepted the copied-back executable with
  exit code `0`. The ad-hoc baseline was rejected with exit code `3`. This
  rehearsal used an ambient certificate, so it proves the signing and
  notarization path once an identity is present; rehearsal 1 is the evidence for
  the runner-style certificate import.
- **Apple still retains both accepted submissions, but history is not the
  discriminating evidence.** The first accepted submission's unsigned disk
  image still failed Gatekeeper. The decisive evidence is rehearsal 2's
  Gatekeeper acceptance after signing the DMG, plus the positive `=notarized`
  result for the exact executable copied back for shipping.
- **The `=notarized` gate has been measured against a bare command-line
  executable.** It returned `0` for an existing notarized command-line tool with
  no stapled ticket and `3` for Brigadier's ad-hoc-signed baseline. This is why
  the workflow checks the executable directly instead of trying to staple it.
- **Whether the executable gate needs network access remains unsettled.** Cold
  and warm measurements showed no useful timing distinction. The workflow
  therefore deliberately says the check *may* consult Apple and treats an
  outage as a release failure.
- **No release has been cut.** The current four-binary publication workflow,
  its live seven-secret runner path, GitHub release creation, formula push, and
  both public installation paths have never completed together. This runbook is
  the procedure for that first end-to-end execution, not a report that it has
  already succeeded.

The accountable release owner reviews the workflow run, notarization gates,
release-asset checksums, formula commit, and clean-machine installs before
announcing the release.
