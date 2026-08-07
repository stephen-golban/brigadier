# brigadier

`brigadier` is a public CLI for orchestrating AI coding workers.

This repository contains the shared TypeScript contracts, Claude and Codex
worker adapters, quota oracles, worktree orchestration, and a fixture-driven
subprocess test harness.

## Development

```sh
bun install
bun test
bun run typecheck
bun run check
bun run build
```

The build emits a signed native `./brigadier` executable and Node-compatible
modules under `dist/`. Worker and quota subprocesses use detached POSIX process
groups under both Bun and Node so cancellation can terminate descendant
processes. Windows is not supported; the published launcher exits with a clear
error there. On supported Darwin and Linux platforms, the launcher prefers an
optional native package and uses the JavaScript fallback otherwise.

## Codex instruction-file limitation

The Codex adapter targets Codex CLI 0.145.0. For
`instructionFiles.project: "exclude"`, it sets `project_doc_max_bytes=0`, which
suppresses project and repository `AGENTS.md` discovery. For
`instructionFiles.user: "exclude"`, it passes `--ignore-user-config`, but that
flag suppresses only `$CODEX_HOME/config.toml`. Codex 0.145.0 still loads the
global `$CODEX_HOME/AGENTS.md` independently, and the CLI exposes no flag to
disable it. Therefore Codex user-instruction exclusion is not a complete
ambient-instruction isolation guarantee.
