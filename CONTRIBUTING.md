# Contributing

## Prerequisites

- [Bun](https://bun.com). CI builds on 1.3.14.
- git.
- macOS or Linux. Windows is not supported.

## Setup

```sh
git clone https://github.com/stephen-golban/brigadier
cd brigadier
bun install
```

## Before you open a pull request

Run these, in this repository, from the root:

```sh
bun test
bun run typecheck
bun run check     # biome
bun run format
bun run build     # on Linux, run `bun run build:unsigned` instead
```

All five must pass. `bun run check` and `bun run typecheck` run against the
whole repository, not just the files you touched; a pre-existing failure
elsewhere is still a failure. `bun run format` rewrites files in place —
run it before you check in, not after. `bun run build` finishes with
`build:codesign`, which calls the macOS-only `codesign` tool; on Linux use
`bun run build:unsigned`, which compiles the same binary without that step.

## Project layout

| Directory | What's there |
| --- | --- |
| `src/` | the supervisor, planner, worker adapters, routing, quota, config, MCP server, and CLI entry |
| `test/` | the test suite, run with `bun test` |
| `test/fixtures/` | `.jsonl` / `.json` / `.txt` captures of real vendor CLI output, used to drive tests without a live `claude` or `codex` |
| `docs/` | the documentation set — see [docs/README.md](docs/README.md) |
| `surfaces/` | per-host doctrine templates that `brigadier install` writes into a host's configuration slot |
| `scripts/` | build and release scripts: packaging, notarization, tag verification, the Homebrew formula updater |
| `bin/` | the published CLI and MCP entry points (`brigadier.js`, `brigadier-mcp.js`) |
| `Formula/` | the Homebrew formula (not yet published to a tap) |

## Code style

[Biome](https://biomejs.dev) governs both formatting and linting, configured
in `biome.json`: the formatter is enabled with space indentation, the linter
is enabled with its default rule set, and both run over the whole tree except
`node_modules`, the compiled `brigadier` binary, and `dist/`. Run
`bun run format` rather than hand-formatting, and run `bun run check` before
you push — it is the same check CI runs.

## Tests

Tests live in `test/`, one file per subsystem, and run under `bun test`.
Fixtures in `test/fixtures/` are captures of real `claude` and `codex` CLI
output — JSONL transcripts, quota responses, and debug dumps — so the suite
can exercise vendor-specific parsing without a live login. Add a fixture
alongside a test when you're covering a new vendor output shape; do not hand-
write a fixture that doesn't correspond to something a real CLI produced.

## Pull requests

Keep each pull request small and about one concern. Explain what changed and
why, not just what. If the change alters observable behavior — a flag, an
exit code, a file `brigadier install` writes, the plan format — update the
relevant file under `docs/` in the same pull request; a behavioral change
without a doc update will be asked to add one.

## Releases

Releases are the maintainer's job, not a contributor's. See
[docs/RELEASING.md](docs/RELEASING.md) for the procedure if you're curious,
but you should not need it to contribute.
