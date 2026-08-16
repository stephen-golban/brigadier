# Setting up brigadier (a guide for AI agents)

The setup is binary-first and has one host-setup step: make the `brigadier`
binary available, then run `brigadier init`. Do not create host directories or
edit consent into the configuration by hand.

## 1. Install the binary

The primary release command is:

```sh
curl -fsSL https://raw.githubusercontent.com/stephen-golban/brigadier/main/install.sh | sh
```

**This command cannot work today because no GitHub release exists yet.** The
installer needs a platform archive and its `.sha256` file from a GitHub release,
and there is no release to download.

The Homebrew formula is in the separate public
`stephen-golban/homebrew-tap` tap. Homebrew 6 hard-fails on an untrusted
third-party tap, so the complete sequence is:

```sh
brew tap stephen-golban/tap
brew trust stephen-golban/tap
brew install brigadier
```

**These commands cannot produce a working install today because no GitHub
release exists yet.** The formula cannot point at usable release artifacts and
checksums until the first release is published.

The release installer itself is the component that refuses unsupported
operating systems. It accepts `Darwin` and `Linux` from `uname -s`. For
`MINGW*`, `MSYS*`, or `CYGWIN*` it says `Windows is not supported.`; for any
other unsupported value it says
`Unsupported operating system: <value>. Windows is not supported.` These are
installer messages, not CLI messages.

## 2. Run the single host-setup step

Run:

```sh
brigadier init
```

Plain `init` discovers the installed Claude Code and Codex worker CLIs and
builds a model configuration. It then performs one read-only host-detection
pass, asks which detected hosts to enable, writes the configuration, and calls
the installer for the chosen hosts using the just-written configuration and
the same detection result.

The host prompt includes the kind of evidence and its absolute path. Skill
hosts default to yes; GUI hosts default to no unless already recorded in
`enabledHosts`. The GUI-registration question is separate from the per-host
choice because it grants permission to modify another application's
configuration.

Keep this step interactive when GUI integration is wanted. Only an interactive
yes to
`Register brigadier's MCP server with detected GUI hosts`
can record GUI-registration consent. `init --yes` enables detected skill hosts
and retains a detected GUI host already recorded in `enabledHosts`, but it does
not newly enable a GUI host or manufacture consent.

If no supported host is detected, or if the user declines every offered host,
`init` still writes the configuration and exits `0`. It returns immediately
after that write: it never calls the installer and therefore prints no install
report.

### The fatal `init` failure

Ordinary `init` cannot finish without a usable worker. When no installed worker
CLI reports a selectable model, `runInit` writes exactly:

```text
brigadier init: no installed worker CLI reported a selectable model. Install Claude Code or Codex, then re-run `brigadier init`.
```

and exits `1`. Before retrying setup, make at least one of those worker CLIs
report a selectable model. This failure occurs before host detection and before
any configuration write.

`init --print-config` is deliberately different: in the same no-model case it
prints the proposed configuration and exits `0`. Do not treat that successful
preview as evidence that a worker is available.

## 3. Know what a run configures lazily

Host setup and run configuration are distinct. `brigadier init` is the one step
that selects and installs host integrations, but a run does not require that
step to have happened. `brigadier run` calls `ensureConfig` without reading
stdin. The MCP route and run tools call that same function.

If a current valid configuration exists, `ensureConfig` returns it unchanged.
Otherwise it discovers worker CLIs and constructs a usable configuration. When
it auto-writes that configuration, it explicitly writes
`"guiRegistrationConsent": false`; the field is not absent pending a human
answer. Lazy configuration never grants GUI-registration consent.

If lazy discovery finds no selectable worker model, it raises:

```text
no installed worker CLI reported a selectable model. Install Claude Code or Codex, then try again.
```

The CLI run reports that as a start failure, and the MCP route and run tools
cannot obtain a configuration. Running `init` cannot compensate for an
unavailable worker CLI; the worker must be installed and usable.

Lazy configuration does not select or install host integrations. Use
interactive `brigadier init` for that setup.

## 4. Read host-install failures precisely

The detailed candidate list and per-host write list are in
[HOSTS.md](HOSTS.md). Three messages that look related represent different
checks:

### Presence failed

```text
not detected on this machine
```

This comes from host detection. Install the host itself so one of its own
executables or marker paths exists. Running `brigadier init` only probes again;
it does not make an absent host present.

An explicitly named, undetected host is skipped with exit `0`. If the user
really intends to target it anyway, `brigadier install <host> --force` bypasses
presence for that named host only.

### GUI consent is missing

For a detected GUI host, parsed configuration must contain
`"guiRegistrationConsent": true`. The remedy is an interactive
`brigadier init`, answered by the human, with yes to
`Register brigadier's MCP server with detected GUI hosts`. `--force` does not
grant this consent.

### The host configuration directory is missing

After GUI presence and consent have passed, brigadier separately checks the
host's configuration root. A GUI application bundle can prove presence even
when that root has not been created. The later check then says:

```text
<root> does not exist, so this host is not installed on this machine. brigadier does not create another product's configuration directory.
```

This is not the `not detected on this machine` failure, and rerunning `init`
does not create the other product's directory.

## 5. Refresh integrations later

After `init` has recorded at least one host, bare `brigadier install` refreshes
the recorded hosts that are still detected. Do not claim that every install
invocation probes the machine: if no enabled hosts are recorded, the bare form
prints

```text
brigadier install: no enabled hosts are recorded; run `brigadier init` to choose which detected hosts to install.
```

and exits `1` before detection is called.

`brigadier install --all` considers every detected supported host. An explicit
`brigadier install <host>` checks that name; without `--force`, an undetected
name is skipped and the command exits `0` if nothing else fails. Always read the
per-host output as well as the exit code.
