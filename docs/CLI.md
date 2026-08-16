# The commands

brigadier has four commands: `init`, `run`, `install`, and `mcp`. `init` is the
one setup step: install the binary, run it once, then use `run` for work.

| Command | What it does |
| --- | --- |
| `brigadier init` | detects supported hosts, records your choices, then installs them |
| `brigadier run` | plans and runs a task, or runs a plan document |
| `brigadier install` | writes or refreshes brigadier's integration in selected hosts |
| `brigadier mcp` | serves brigadier's tools over stdio MCP |

`brigadier --version` (`-V`) and `brigadier --help` (`-h`) work only as the
sole argument. No command, an unknown command, or an unknown option is a usage
error (exit `2`). `-h` and `--help` are accepted anywhere in the argument list
for `init`, `run`, and `install`; help exits `0`.

## Install the binary

The release installer is the primary path:

```sh
curl -fsSL https://raw.githubusercontent.com/stephen-golban/brigadier/main/install.sh | sh
```

The POSIX `sh` installer detects its platform with `uname`, downloads the
matching GitHub release archive, verifies its SHA-256 checksum, and installs to
`~/.local/bin` or `$BRIGADIER_INSTALL_DIR`. It never requires `sudo`.

Installation is atomic and symlink-safe. The script stages the binary in a
`mktemp -d` directory inside the install directory, applies its executable
mode there, unlinks a destination symlink, and renames the staged binary into
place. It refuses to replace a real directory and warns when the install
directory is not on `$PATH`. It also hands stdin to `/dev/tty`, so the `init`
questions can still be answered when the installer is run through a pipe.

The Homebrew path is:

Homebrew 6 requires third-party taps to be trusted before it will load their
formulae.

```sh
brew tap stephen-golban/tap
brew trust stephen-golban/tap
brew install brigadier
```

## `brigadier init`

```sh
brigadier init [--yes] [--print-config]
```

`init` is the single setup step. It probes worker CLIs for a usable model
configuration, detects supported AI hosts, records the host selections as
`enabledHosts`, writes the configuration, and only then installs the selected
hosts using the exact configuration it just wrote.

The configuration path is `$BRIGADIER_HOME/config.json` when
`BRIGADIER_HOME` is non-empty; otherwise it is `$HOME/.brigadier/config.json`.
If neither can resolve a home, `init` exits `1`. The configuration directory is
created with mode `0700`; its file is written with mode `0600` and renamed into
place.

### Interactive flow

`init` first reports the discovered Claude Code and Codex worker CLIs and their
available models. For each usable vendor it asks for a default model and whether
to change its per-model effort ceilings. It then asks, once each, whether to:

1. run a slice on a model below its difficulty floor rather than fail it;
2. register brigadier's MCP server with detected GUI hosts, if any;
3. link secret files into worker worktrees, and, if yes, which
   repository-relative paths to link as a JSON array.

It next lists only the supported hosts it detected and asks once per host:

```text
Set brigadier up for <host>? (detected by <kind> <absolute path>)
```

The prompt includes the evidence that proved the host is present: an absolute
path and whether it is an executable, file, or directory. Skill hosts default
to yes; GUI hosts default to no. A host already in `enabledHosts` defaults to
yes on a later run, so pressing Enter does not discard an earlier selection.

If no supported host is detected, `init` says so plainly, still writes the
configuration, and completes. It does not offer absent hosts.

| Option | Effect |
| --- | --- |
| `-y`, `--yes` | accepts defaults without prompting. It enables detected skill hosts, does not newly enable a GUI host, and retains a GUI host already recorded in `enabledHosts`. |
| `--print-config` | prints the resolved configuration JSON to stdout and exits without writing or installing. It is non-interactive and keeps notices on stderr. |
| `-h`, `--help` | prints usage and exits `0`. |

`--yes` accepts defaults; it does not manufacture consent to modify another
product's configuration. Only an interactive yes to the GUI-registration
question records `guiRegistrationConsent`.

### What counts as a detected host

The supported hosts are:

| Kind | Hosts | Integration |
| --- | --- | --- |
| Skill hosts | `claude-code`, `codex`, `opencode` | read a skill or host-side file from disk |
| GUI hosts | `cursor`, `windsurf`, `antigravity`, `claude-desktop` | get an MCP server registration merged into their own configuration |

For Claude Code, Codex, and opencode, detection first looks for the executable
on `$PATH` and tests it with `access(X_OK)`. It does not infer executability
from permission bits. If no executable is found, it checks only host-owned
markers that brigadier never writes:

| Host | File markers |
| --- | --- |
| `claude-code` | `$CLAUDE_CONFIG_DIR/settings.json`, then `~/.claude/settings.json` and `~/.claude.json` |
| `codex` | `$CODEX_HOME/config.toml` or `$CODEX_HOME/auth.json`, then `~/.codex/config.toml` or `~/.codex/auth.json` |
| `opencode` | `$XDG_CONFIG_HOME/opencode/opencode.json`, then `~/.config/opencode/opencode.json` |

The environment roots are additive, not replacements: the override is checked
first and the home fallback is checked afterwards. A file marker must actually
be a file; a directory at that path proves nothing. GUI detection similarly
uses the application's bundle or its own configuration directory, never a
directory brigadier creates.

`~/.agents/skills` is never detection evidence: Codex and opencode both read
it, and brigadier itself creates it. Bare `~/.claude`, `~/.codex`, and
`~/.config/opencode` are not evidence either. Any error while probing a path
means “not present; keep looking,” not “present.”

### `init` exit codes

| Code | Meaning |
| --- | --- |
| `0` | configuration was printed, or was written and the selected integrations completed |
| `1` | discovery backend, configuration, write, or follow-on installation failed; ordinary `init` also exits `1` when no worker CLI reports a selectable model |
| `2` | usage error |

## `brigadier run`

```sh
brigadier run "<task description>"
brigadier run --plan <file>
brigadier run --plan -
```

Use one form at a time. A task description asks brigadier to create a plan and
then run it; `--plan <file>` runs an existing JSON plan; `--plan -` reads that
plan from standard input until EOF. Quote a task description as one argument.
An empty task, more than one bare task argument, or both a task and `--plan` is
a usage error.

By default, each slice runs in an isolated git worktree. The resulting slice
commits are integrated on a branch named from the plan ID, or from `--slug`.

| Option | Effect |
| --- | --- |
| `--plan <file>` | selects an existing plan; `-` reads it from standard input. It is mutually exclusive with a task description. `--plan=<file>` also works. |
| `--max-workers <n>` | positive whole-number concurrency limit; default `1`. For a task description it is also the largest number of slices the planner may propose. `--max-workers=<n>` also works. |
| `--slug <name>` | names the run's branches. Defaults to a branch-safe form of the plan ID. The value must start with a letter or digit and otherwise use only letters, digits, `.`, `_`, or `-`. `--slug=<name>` also works. |
| `--dry-run` | plans and routes every slice, reports the result, and creates no worktree or ref, spawns no worker, and writes no commit. A task-backed dry run still invokes the planner. |
| `--verbose` | prints the full per-attempt report and verbose progress instead of the compact summary. |
| `--unsafe-in-place` | runs workers in the current checkout instead of isolated worktrees. It cannot be combined with `--max-workers` above `1`. |
| `-h`, `--help` | prints usage and exits `0`. |

For a plan file, `--max-workers` limits concurrency within a dependency wave;
it does not reject a plan merely because it has more slices than workers. For a
task description, a planner proposal wider than the requested worker limit is
refused before workers start. `--unsafe-in-place` deliberately makes every file
in the checkout visible to every worker.

If the planner finds the task too ambiguous to plan, brigadier prints its
questions and exits `4`. It creates no slice worker, worktree, ref, or commit.

### `run` exit codes

| Code | Meaning |
| --- | --- |
| `0` | the run succeeded |
| `1` | brigadier could not start: no usable worker CLI, no resolvable config home, an unreadable or invalid plan, a missing required launch variable (`HOME`, `PATH`, or `USER`), or a planner that could not produce a plan |
| `2` | usage error, including invalid option values or incompatible invocation forms |
| `3` | the run started but did not succeed; the report identifies the stage and affected slices |
| `4` | the planner needs human answers; no worker, worktree, ref, or commit was created |
| `130` | interrupted by SIGINT. Brigadier attempts to cancel workers, remove worktrees, and retire refs; a second interrupt exits immediately. Read reported cleanup failures. |
| `143` | interrupted by SIGTERM; otherwise the same as `130` |

## `brigadier install`

```sh
brigadier install [<host>...] [--all] [--dry-run] [--force]
```

`install` installs brigadier's integration for one or more supported hosts. It
does not install a runtime or package manager. With no host names and no
`--all`, it selects the intersection of currently detected hosts and the
`enabledHosts` written by `brigadier init`.

| Option | Effect |
| --- | --- |
| `--all` | selects every *detected* supported host, not every host brigadier knows. If combined with names, `--all` determines the selection. |
| `--dry-run` | reports every selection, skip, write, and refusal decision without writing files or the manifest. |
| `--force` | replaces a file brigadier did not write or that was edited after brigadier wrote it. For explicitly named hosts only, it also bypasses failed host detection. It never grants GUI-registration consent and does not widen the bare or `--all` selection. |
| `-h`, `--help` | prints usage and exits `0`. |

The host names are `claude-code`, `codex`, `opencode`, `cursor`, `windsurf`,
`antigravity`, and `claude-desktop`. An unknown host or option is a usage error.
Repeated host names are harmless.

### Selection and detection gates

- With no names and no `--all`, no recorded `enabledHosts` exits `1` and tells
  you to run `brigadier init`. If enabled hosts are recorded but none is
  currently detected, it exits `1` and names them.
- `--all` considers every detected host. If none is detected, it exits `1`.
- A named host that is not detected is reported as skipped and exits `0`.
  Add `--force` to install that named host anyway.
- `--force` changes presence only for named hosts. It never makes `--all` or
  the bare form consider an undetected host.
- `--dry-run` follows the same gates and reports the result, but writes nothing.

Each GUI host has two independent requirements: it must be detected, and
`guiRegistrationConsent` must be `true` in brigadier's parsed configuration.
Only an interactive `brigadier init` can record that consent. `--force` does
not substitute for it. Without consent, the GUI registration is skipped with
instructions to run `brigadier init`; without presence, it is also skipped.

Writes are guarded. brigadier records hashes of what it has written in
`$BRIGADIER_HOME/surfaces.json`; an unrecognized or edited destination is
refused unless `--force` is given. Destination symlinks are always refused,
including with `--force`, and writes cannot escape their resolved install root.

### Claude Desktop bundle

`brigadier install claude-desktop` can stage the bundle material, but it never
installs a Desktop bundle. Desktop installation is an explicit user action.
To make the bundle, run `bun run build:mcp`, copy `dist/mcp/server.js` to
`server/brigadier-mcp.js` beside `manifest.json`, zip the directory with
`manifest.json` at the archive root, rename the archive `brigadier.mcpb`, and
open it with Claude Desktop. That bundle entry starts the MCP server.

### `install` exit codes

| Code | Meaning |
| --- | --- |
| `0` | no file was refused or failed. A named undetected host can still be skipped under this code. |
| `1` | selection could not proceed, or at least one file was refused or could not be written |
| `2` | usage error |

## `brigadier mcp`

```sh
brigadier mcp
```

This starts a stdio MCP server. Standard output is JSON-RPC only; diagnostics
go to standard error. The server has no runtime options. `brigadier mcp -h` or
`brigadier mcp --help` prints usage and exits `0`; any other argument exits `2`
instead of being ignored.

The server exposes three tools:

| Tool | What it does |
| --- | --- |
| `brigadier_validate_plan` | validates a plan's shape and scheduling and reports dependency waves without changing anything |
| `brigadier_route_plan` | reads the local configuration and reports the vendor, model, and effort each slice would receive; it creates no worktree or worker |
| `brigadier_run` | runs a supplied plan in an absolute repository path, with `slug`, `maxWorkers`, `dryRun`, and `unsafeInPlace` equivalents of the CLI options |

`brigadier_route_plan` routes without a quota snapshot, so it does not avoid a
model merely because it is currently drained. A real run learns quota state from
the worker and can escalate. `brigadier_run` accepts a plan document; it does
not turn a task description into a plan.

### `mcp` exit codes

| Code | Meaning |
| --- | --- |
| `0` | the MCP client closed standard input normally |
| `1` | the server could not start or encountered an unhandled operational error |
| `2` | unexpected command argument |
| `130` | interrupted by SIGINT while serving |
| `143` | interrupted by SIGTERM while serving |

## Release distribution

GitHub releases are brigadier's only distribution channel. A `v*` tag push
first verifies that the tag matches the package version, then builds compiled
binaries for `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`. The
Apple signing, notarization, and DMG steps run only on macOS when all seven Apple
secrets are present; without them, a release can still publish with ad-hoc-signed
Darwin binaries and no DMGs.

Release `v0.2.0` contains one `.tar.gz` archive and one `.sha256` file per
platform, a combined `checksums.txt`, and two DMGs. Its published
`darwin-arm64` binary passes
`codesign --verify --strict -R "=notarized"`. The workflow also updated
`stephen-golban/homebrew-tap/Formula/brigadier.rb` to `0.2.0`; its four digests
match the published archives.
