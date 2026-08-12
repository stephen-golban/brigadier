# brigadier

`brigadier` is a command-line supervisor for AI coding work.

You give it a task or a plan; it decomposes the work into slices, routes each
slice to a vendor CLI by competence against that slice's declared difficulty,
gives each one its own git worktree, and runs a cross-vendor adversarial review
before a slice commits whenever the second vendor's reviewer can be reached —
[The cross-vendor gate](#the-cross-vendor-gate) is the list of times it cannot.
The resulting slice commits are merged onto one branch and reported together.

It is not a proxy and not a hosted service. It does not ask for or store model
API credentials and never talks to a model API; it spawns `claude` and `codex`
as ordinary subprocesses on your machine, under your own logins.

[![CI](https://github.com/stephen-golban/brigadier/actions/workflows/ci.yml/badge.svg)](https://github.com/stephen-golban/brigadier/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40stephen-golban%2Fbrigadier)](https://www.npmjs.com/package/@stephen-golban/brigadier)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Requirements

- **git.** Hard requirement. Isolation and integration are both git.
- **macOS or Linux.** Windows is not supported; the launcher exits with a clear
  error there.
- **At least one worker CLI** — [Claude Code](https://claude.com/claude-code)
  (`claude`) or [Codex CLI](https://developers.openai.com/codex/cli) (`codex`) —
  installed and already logged in. brigadier drives your existing login.
- **Both, if you want the cross-vendor gate.** With one vendor installed, every
  slice commits with **no adversarial review at all**. See
  [The cross-vendor gate](#the-cross-vendor-gate).
- [Bun](https://bun.com), to build from source. CI builds on 1.3.14.

## Install

The recommended path is the published npm package, installed globally:

```sh
npm install --global @stephen-golban/brigadier
```

Homebrew is not available. Building from source is the alternative, for
contributors and for anyone who wants the self-contained executable:

```sh
git clone https://github.com/stephen-golban/brigadier
cd brigadier
bun install
bun run build
```

That emits a self-contained `./brigadier` executable. Put it on your `PATH`, or
call it by path.

## Quickstart

```sh
brigadier init
brigadier run "add a --json flag to the report command"    # inside a git repo
```

`init` probes the machine for installed worker CLIs, enumerates each one's real
model catalog, proposes a default model and an effort ceiling for each, and
writes `~/.brigadier/config.json` only after you have seen the proposal. `run`
takes a task description, has a model read your repository and write a plan, and
prints that plan before any slice runs; each slice is then routed, given a
worktree, and built, and the successful slice commits are merged onto
`brigadier/<slug>`. `--plan <file>` runs a plan that already exists instead.

`--dry-run` routes every slice and reports it, creating no worktree, spawning no
slice worker, and writing no commit. Every option and every exit code is in
[docs/CLI.md](docs/CLI.md).

## What it does to your repository

- **It commits only on branches it creates.** Never your branch, never `main`.
  Slice work lands on `brigadier/<slug>/slice-N` and is combined onto
  `brigadier/<slug>`.
- **It never pushes.** Nothing leaves your machine. The approval gate is your
  own merge of `brigadier/<slug>`, reviewed as you would any contributor's.
- **Each slice runs in its own git worktree**, a sibling of your repository at
  `<repo>-brigadier/<slug>/slice-N`. Your checkout is never the worker's working
  directory unless you pass `--unsafe-in-place`.
- **Interrupting is controlled.** Ctrl-C cancels every running worker and its
  process group, attempts cleanup, and exits `130`; slices that already
  committed keep their commits and are still merged.
- **Cleanup it could not finish is reported**, not assumed. A worker that will
  not die or a worktree that will not go is named on its own `cleanup failure:`
  line rather than counted as tidy.
- **Inventoried secret values are redacted** from commit messages, the diffs
  reviewers see, and reported paths. Redaction defeats verbatim leaks only, and
  planning runs before the inventory exists: **do not put a secret in a task
  description.** Full limits in [SECURITY.md](SECURITY.md).

## The cross-vendor gate

Before a slice commits, a model from the other vendor is shown the exact diff
the commit would record — at most 98,304 characters of it; a larger diff is
truncated and says so inside the patch text — and asked whether it is correct.
A blocking finding fails the attempt, removes the worktree, and re-routes the
retry to a different model. Style, naming and formatting are explicitly out of
scope.

The review fails open. **On a single-vendor install, nothing adversarially
reviews anything.** A slice that otherwise succeeds commits unreviewed, with
`not reviewed: NO_OTHER_VENDOR` on its line — and so does one whose
adapter is missing, whose reviewer failed on quota, auth or a crash, or whose
reply could not be parsed. A skipped review always commits; cancellation is
the exception, and fails the attempt instead. That is the most important
caveat on this page for a new user. If you want the gate, install both CLIs.

**The model reviewer does not run your tests, your linter, or your build.** If a
plan supplies `verify.command`, the deterministic `tests_pass` gate runs it
before model review and a non-zero exit rejects the attempt; a command that
cannot be started is a blocking failure rather than a skip. brigadier never
invents that command, so without one nothing is run and a slice can pass and
still be wrong. `verify.command` executes a process under your own permissions
and the grant follows the file passed to `--plan`, not whoever authored it —
[docs/PLAN-FORMAT.md](docs/PLAN-FORMAT.md) states the rule in full. The full
design is in [docs/REVIEW-GATE.md](docs/REVIEW-GATE.md).

## Why cross-vendor

Brigadier **composes** vendors within one task — building with one and
adversarially reviewing with the other before the work is allowed to commit —
and never asks a builder's vendor to review its own work. Anthropic's
[system card](https://www-cdn.anthropic.com/8b8380204f74670be75e81c820ca8dda846ab289.pdf)
reports measurable favoritism in previous Claude models toward transcripts they
were told came from Claude. The routing table that decides who builds what is
published as auditable data in [docs/METHODOLOGY.md](docs/METHODOLOGY.md) for
one specific reason: a Claude-authored router drifts toward Claude unless a
reader can check the matrix without trusting its author. Vendor is never a
ranking input.

## Documentation

| Document | What is in it |
| --- | --- |
| [docs/CLI.md](docs/CLI.md) | the complete command reference: every option, every exit code |
| [docs/AGENT-SETUP.md](docs/AGENT-SETUP.md) | how an AI agent sets brigadier up for a user, step by step |
| [docs/PLAN-FORMAT.md](docs/PLAN-FORMAT.md) | the plan document: every field, every validation rule, every error code |
| [docs/REVIEW-GATE.md](docs/REVIEW-GATE.md) | the cross-vendor review gate in depth |
| [docs/HOSTS.md](docs/HOSTS.md) | what `brigadier install` writes per host, and each host's limits |
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | the routing policy, published so it can be audited for vendor bias |
| [docs/RELEASING.md](docs/RELEASING.md) | the release procedure |
| [SECURITY.md](SECURITY.md) | what redaction covers, what it does not, and how to report a vulnerability |
| [CHANGELOG.md](CHANGELOG.md) | what changed in each released version |

## Limits worth knowing

- **The model reviewer does not run anything.** No tests, no linter, no build.
  A plan's optional `verify.command` is the deterministic `tests_pass` gate;
  brigadier does not invent one, so without it no command runs.
- **A Claude worker cannot run commands.** `Bash` is withheld entirely; it gets
  `Read`, `Glob`, `Grep`, `Edit`, `Write` and nothing else.
- **Slice worktrees have no `node_modules/`**, so dependency-backed verification
  commands cannot run in a worker. In this repository `bun run typecheck` and
  `bun run check` exit 127, and must be verified by you.
- **A slice gets two attempts, total.** Not a ladder.
- **Only Claude's quota is read during a run.** A drained Codex model is routed
  to, the spawn fails, and the slice's escalation handles it.
- **The competence table is curated judgement, not benchmark data.** The scores
  in [docs/METHODOLOGY.md](docs/METHODOLOGY.md) have no sample size,
  calibration, or provenance. They are auditable, which is a different claim.

## Development

```sh
bun install
bun test
bun run typecheck
bun run check     # biome
bun run build
```

`bun run build` emits an ad-hoc-signed native `./brigadier` executable plus
Node-compatible modules under `dist/`, including the MCP server at
`dist/mcp/server.js`. See [docs/RELEASING.md](docs/RELEASING.md) for the release
procedure and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

MIT. See [LICENSE](./LICENSE).
