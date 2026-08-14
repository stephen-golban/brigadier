# brigadier

`brigadier` is a command-line supervisor for AI coding work.

You give it a task or a plan; it decomposes the work into slices, routes each
slice to a vendor CLI by competence against that slice's declared difficulty,
gives each one its own git worktree, and runs a cross-vendor adversarial review
before a slice commits whenever the second vendor's reviewer can be reached —
[The cross-vendor gate](https://github.com/stephen-golban/brigadier#the-cross-vendor-gate) is the list of times it cannot.
The resulting slice commits are merged onto one branch and reported together.

It is not a proxy and not a hosted service. It does not ask for or store model
API credentials and never talks to a model API; it spawns `claude` and `codex`
as ordinary subprocesses on your machine, under your own logins.

[![CI](https://github.com/stephen-golban/brigadier/actions/workflows/ci.yml/badge.svg)](https://github.com/stephen-golban/brigadier/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40stephen-golban%2Fbrigadier)](https://www.npmjs.com/package/@stephen-golban/brigadier)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/stephen-golban/brigadier/blob/main/LICENSE)

## Requirements

- **git.** Hard requirement. Isolation and integration are both git.
- **macOS or Linux.** Windows is not supported; the launcher exits with a clear
  error there.
- **At least one worker CLI** — [Claude Code](https://claude.com/claude-code)
  (`claude`) or [Codex CLI](https://developers.openai.com/codex/cli) (`codex`) —
  installed and already logged in. brigadier drives your existing login.
- **Both, if you want the cross-vendor gate.** With one vendor installed, every
  slice commits with **no adversarial review at all**. See
  [The cross-vendor gate](https://github.com/stephen-golban/brigadier#the-cross-vendor-gate).
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

**There is no setup step.** brigadier configures itself the first time it is
used: it probes the machine for installed worker CLIs, writes
`~/.brigadier/config.json`, says on stderr what it found, and carries on. It
never prompts, so an agent with no keyboard attached can be the first thing that
ever runs it. A `postinstall` script tries to do that probe at install time as a
convenience, but **it usually does not run** — it skips whenever `CI` is set or
stdout is not a TTY, and npm normally pipes a lifecycle script's output, so an
ordinary `npm install` skips it too. Nothing depends on it; the lazy path is the
real guarantee. Details in [docs/CLI.md](https://github.com/stephen-golban/brigadier/blob/main/docs/CLI.md#configuration-is-automatic).

## Quickstart

You do not have to drive brigadier yourself. The primary path is to keep working
in whatever AI coding host you already use, and let brigadier engage from inside
that session. Install its doctrine into that host once:

```sh
brigadier install claude-code       # or: codex
brigadier install --all --dry-run   # see everything it would write, first
```

Those two are what write the doctrine, because they are what write the skill
directories. **opencode is not a third choice here**: it reads `~/.claude/skills`
and `~/.agents/skills` natively, so `brigadier install claude-code` or `brigadier
install codex` is what gives opencode its doctrine, and `brigadier install
opencode` on its own writes only the compaction-handoff plugin — a hook, and no
doctrine at all. Run it *in addition to* one of the two, never instead of them.

From then on, work normally. When you ask that session for something with more
than one independent piece in it — a feature, a cross-file refactor, a migration,
a bug with several call sites, a batch of mechanical edits — the doctrine tells
it to stop being the worker: plan the slices, run `brigadier run` itself, and
review what comes back. On Claude Code a `UserPromptSubmit` hook nudges it when
the prompt itself looks like a plan, so this does not depend on the model
noticing a skill description. Per-host detail, and each host's real limits, are
in [docs/HOSTS.md](https://github.com/stephen-golban/brigadier/blob/main/docs/HOSTS.md).

Hosts that read no skill directory — Cursor, Windsurf, Antigravity, Claude
Desktop — reach brigadier over MCP instead, and their tool descriptions carry the
same doctrine. Registering into another application's own configuration takes an
explicit yes that only a human can give, so that is the one thing `brigadier
init` is still for; run it once yourself and answer yes when it asks.

### Driving it directly

The command line is fully supported and unchanged; it is no longer the headline.

```sh
brigadier run "add a --json flag to the report command"    # inside a git repo
brigadier run --plan plan.json --max-workers 3
```

A task description has a model read your repository and write a plan, printed
before any slice runs; each slice is then routed, given a worktree, and built,
and the successful slice commits are merged onto `brigadier/<slug>`. `--plan
<file>` runs a plan that already exists instead.

`--dry-run` routes every slice and reports it, creating no worktree, spawning no
slice worker, and writing no commit. Every option and every exit code is in
[docs/CLI.md](https://github.com/stephen-golban/brigadier/blob/main/docs/CLI.md).

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
  description.** Full limits in [SECURITY.md](https://github.com/stephen-golban/brigadier/blob/main/SECURITY.md).

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
[docs/PLAN-FORMAT.md](https://github.com/stephen-golban/brigadier/blob/main/docs/PLAN-FORMAT.md) states the rule in full. The full
design is in [docs/REVIEW-GATE.md](https://github.com/stephen-golban/brigadier/blob/main/docs/REVIEW-GATE.md).

## Why cross-vendor

Brigadier **composes** vendors within one task — building with one and
adversarially reviewing with the other before the work is allowed to commit —
and never asks a builder's vendor to review its own work. Anthropic's
[system card](https://www-cdn.anthropic.com/8b8380204f74670be75e81c820ca8dda846ab289.pdf)
reports measurable favoritism in previous Claude models toward transcripts they
were told came from Claude. The routing table that decides who builds what is
published as auditable data in [docs/METHODOLOGY.md](https://github.com/stephen-golban/brigadier/blob/main/docs/METHODOLOGY.md) for
one specific reason: a Claude-authored router drifts toward Claude unless a
reader can check the matrix without trusting its author. Vendor is never a
ranking input.

## Documentation

| Document | What is in it |
| --- | --- |
| [docs/CLI.md](https://github.com/stephen-golban/brigadier/blob/main/docs/CLI.md) | the complete command reference: every option, every exit code |
| [docs/AGENT-SETUP.md](https://github.com/stephen-golban/brigadier/blob/main/docs/AGENT-SETUP.md) | how an AI agent sets brigadier up for a user, step by step |
| [docs/PLAN-FORMAT.md](https://github.com/stephen-golban/brigadier/blob/main/docs/PLAN-FORMAT.md) | the plan document: every field, every validation rule, every error code |
| [docs/REVIEW-GATE.md](https://github.com/stephen-golban/brigadier/blob/main/docs/REVIEW-GATE.md) | the cross-vendor review gate in depth |
| [docs/HOSTS.md](https://github.com/stephen-golban/brigadier/blob/main/docs/HOSTS.md) | what `brigadier install` writes per host, and each host's limits |
| [docs/METHODOLOGY.md](https://github.com/stephen-golban/brigadier/blob/main/docs/METHODOLOGY.md) | the routing policy, published so it can be audited for vendor bias |
| [docs/RELEASING.md](https://github.com/stephen-golban/brigadier/blob/main/docs/RELEASING.md) | the release procedure |
| [SECURITY.md](https://github.com/stephen-golban/brigadier/blob/main/SECURITY.md) | what redaction covers, what it does not, and how to report a vulnerability |
| [CHANGELOG.md](https://github.com/stephen-golban/brigadier/blob/main/CHANGELOG.md) | what changed in each released version |

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
  in [docs/METHODOLOGY.md](https://github.com/stephen-golban/brigadier/blob/main/docs/METHODOLOGY.md) have no sample size,
  calibration, or provenance. They are auditable, which is a different claim.
- **The install-time config probe usually does not run.** It skips on `CI` and
  on a non-TTY stdout, which covers a plain `npm install`. Configuration is
  guaranteed by the lazy path inside the product, not by that script.
- **The Codex handoff hook is registered but not approved.** Until you approve
  it in Codex it is a silent no-op, and Codex binds that approval to the exact
  registration. Claude Code needs no approval for the same hook.
- **Nothing is written into a GUI application's config without an explicit
  yes**, given once during an interactive `brigadier init`. Neither `--yes`, nor
  the postinstall script, nor lazy config, nor `--force` grants it.

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
`dist/mcp/server.js`. See [docs/RELEASING.md](https://github.com/stephen-golban/brigadier/blob/main/docs/RELEASING.md) for the release
procedure and [CONTRIBUTING.md](https://github.com/stephen-golban/brigadier/blob/main/CONTRIBUTING.md) before opening a pull request.

## License

MIT. See [LICENSE](https://github.com/stephen-golban/brigadier/blob/main/LICENSE).
