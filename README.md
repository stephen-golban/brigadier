# brigadier

`brigadier` is a command-line supervisor for AI coding work. Give it a task or
a plan and it decomposes the work into slices, routes each slice to a suitable
worker CLI, gives every worker its own git worktree, and merges the resulting
commits onto one branch.

It is not a proxy or hosted service. It uses the Claude Code and Codex CLIs
already logged in on your machine; it does not ask for or store model API
credentials.

[![CI](https://github.com/stephen-golban/brigadier/actions/workflows/ci.yml/badge.svg)](https://github.com/stephen-golban/brigadier/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/stephen-golban/brigadier/blob/main/LICENSE)

## Requirements

- macOS or Linux. Windows is not supported.
- git, for isolation and integration.
- At least one worker CLI: [Claude Code](https://claude.com/claude-code)
  (`claude`) or [Codex CLI](https://developers.openai.com/codex/cli) (`codex`),
  installed and signed in. Having both enables cross-vendor review when a
  compatible reviewer is available.

## Install

The primary install path is the release installer:

```sh
curl -fsSL https://raw.githubusercontent.com/stephen-golban/brigadier/main/install.sh | sh
```

**This command does not work yet: no GitHub release has been cut.** It is the
install path for the first release and will work once that release exists. The
POSIX `sh` script detects macOS or Linux and its architecture, downloads the
matching GitHub-release archive, verifies its SHA-256 checksum, and installs
`brigadier` to `~/.local/bin` (or `$BRIGADIER_INSTALL_DIR`). It never uses
`sudo`. It stages the executable in a temporary directory inside the install
directory, replaces a destination symlink safely, refuses to overwrite a real
directory, and warns when the install directory is absent from `$PATH`.

The script gives `brigadier init` access to `/dev/tty`, so the setup questions
still work when the script is piped from `curl`.

Homebrew will also be available from the first release:

```sh
brew install stephen-golban/tap/brigadier
```

**This command does not work yet: no GitHub release has been cut, and the
formula intentionally has placeholder checksums.** It will work once the first
release publishes real archives and updates the formula.

## Set up once

Run the one setup command after installing:

```sh
brigadier init
```

It finds supported AI hosts on this machine, shows the absolute path and kind
of evidence for each one, asks which detected hosts should use brigadier, saves
that choice, and then installs the selected host integrations. Skill hosts
default to yes; GUI hosts default to no because their configuration needs an
explicit human approval. See the [CLI manual](docs/CLI.md#brigadier-init) for
the full prompt flow and detection rules.

## First run

From the repository you want to change:

```sh
brigadier run "Add input validation to the CSV importer"
```

For work you have already decomposed, run a plan instead:

```sh
brigadier run --plan plan.json
```

`brigadier run` creates isolated worktrees by default. Start with the complete
[CLI manual](docs/CLI.md) for planning, flags, exit codes, host integration,
and MCP use.

## The four commands

| Command | Purpose |
| --- | --- |
| `brigadier init` | choose and install integrations for detected hosts |
| `brigadier run` | plan and run a task, or run a plan you already have |
| `brigadier install` | install or refresh selected host integrations |
| `brigadier mcp` | serve brigadier tools over stdio MCP |

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/CLI.md](docs/CLI.md) | the complete command reference: every option and exit code |
| [docs/AGENT-SETUP.md](docs/AGENT-SETUP.md) | setting brigadier up for a user |
| [docs/PLAN-FORMAT.md](docs/PLAN-FORMAT.md) | the plan document and its validation rules |
| [docs/REVIEW-GATE.md](docs/REVIEW-GATE.md) | cross-vendor review in depth |
| [docs/HOSTS.md](docs/HOSTS.md) | what each host integration writes and its limits |
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | the routing policy |
| [docs/RELEASING.md](docs/RELEASING.md) | release artifacts and procedure |

## Development

Contributors need [Bun](https://bun.com). The normal local gate is:

```sh
bun install --frozen-lockfile
bun run check
bun run typecheck
bun test
```

`bun run build` emits a local native `./brigadier` executable and the MCP
bundle entry at `dist/mcp/server.js`.

## License

MIT. See [LICENSE](LICENSE).
