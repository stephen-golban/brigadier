# brigadier

`brigadier` is a command-line supervisor for AI coding work. You give it a task
or a plan; it decomposes the work into slices, routes each slice to a model,
gives each one its own git worktree, and spawns the vendor CLI you already have
installed. When a cross-vendor review can run it happens before the commit; the
resulting slice commits are merged onto one branch and reported together.

It is not a proxy and not a hosted service. It does not ask for or store model
API credentials, and never talks to a model API. It spawns `claude` and `codex`
as ordinary subprocesses on your machine, under your own logins.

## Why another one

Brigadier **composes** vendors within one task — building with one and
adversarially reviewing with the other before the work is allowed to commit.
That composition is the entire point. Anthropic's
[system card](https://www-cdn.anthropic.com/8b8380204f74670be75e81c820ca8dda846ab289.pdf)
reports measurable favoritism in previous Claude models toward transcripts they
were told came from Claude. Brigadier therefore does not ask a builder's vendor
to supply its adversarial review: every review it runs crosses the vendor line.
A slice built by Claude is reviewed by Codex, and a slice built by Codex is
reviewed by Claude.

The routing table that decides who builds what is published as auditable data in
[docs/METHODOLOGY.md](docs/METHODOLOGY.md), for one specific reason: a
Claude-authored router drifts toward Claude unless a reader can check the
matrix without trusting its author. Vendor is never a ranking input. Disagree
with every score in that document without taking anybody's word for it.

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

**The package is not published.** Version is `0.1.0`, it is not on npm, and it
is not on Homebrew. Both of those paths exist in the repository and neither is
available yet. Build it from source:

```sh
git clone https://github.com/stephen-golban/brigadier
cd brigadier
bun install
bun run build
```

That emits a self-contained `./brigadier` executable. Put it on your `PATH`, or
call it by path.

## First run

```sh
brigadier init
```

`init` probes the machine for installed worker CLIs, enumerates each one's real
model catalog, proposes a default model and an effort ceiling for each, and asks
you to confirm. It writes `~/.brigadier/config.json` (or
`$BRIGADIER_HOME/config.json`). Nothing is written until you have seen the
proposal. `--yes` accepts every default; `--print-config` prints the resolved
config as JSON and writes nothing.

Then, from inside a git repository:

```sh
brigadier run "add a --json flag to the report command"
```

A model reads your repository and writes a plan. The plan is printed before any
slice runs. Then every slice is routed, given a worktree, and built. When a
reviewer is available its review runs before the slice commit; successful slice
commits are merged onto `brigadier/<slug>`.

If the task is genuinely ambiguous, brigadier does not guess. After the planner
returns its questions, brigadier spawns no slice worker, creates no ref or
worktree, and exits `4`:

```text
brigadier run: this task is ambiguous enough that planning it would mean guessing, so nothing was planned, nothing was created, and no worker was spawned.

Answer these and run it again:
  1. Should --json replace the human-readable output or be an alternative to it?
  2. Which of the three report subcommands should accept it?
{"status":"needs_human","questions":["Should --json replace…","Which of the three…"]}
```

The last line is machine-readable on purpose, so a host-side skill can re-invoke
with the answers folded in.

### Before you spend a worker

`--dry-run` routes every slice and reports it, creating no worktree, spawning no
slice worker, and writing no commit. With `--plan` it launches no model at all;
with a task description it still launches the planner. This is real output from
a two-slice plan:

```text
run csv-export: 2 slice(s) in 2 wave(s)

dry run csv-export: 2 slice(s) in 1ms
  writer  would run
      attempt 1  codex/gpt-5.6-terra effort=high  routed
  writer-tests  would run
      attempt 1  claude/claude-haiku-4-5-20251001 effort=medium  routed
  integration branch: (none: a dry run writes no ref)
  merges: (none)
```

Two different vendors, chosen by competence against each slice's declared
difficulty — not by preference, and not by who wrote the router.

## The commands

### `brigadier init`

Probe, propose, confirm, write.

| Option | Effect |
| --- | --- |
| `-y`, `--yes` | accept every proposed default without prompting |
| `--print-config` | print the resolved config as JSON and exit without writing |
| `-h`, `--help` | print usage |

It asks four things: the default model per vendor, the effort ceiling per model
(default `high`), whether a slice may run on a model below its difficulty floor
rather than failing, and whether brigadier may link secret files into worker
worktrees (default **no**). An existing config supplies the defaults on a
re-run; when discovery has not changed, pressing enter through it changes
nothing.

### `brigadier run`

```sh
brigadier run "<task description>"    # plan the task, then run the plan
brigadier run --plan <file>           # run a plan that already exists
brigadier run --plan -                # read the plan from stdin
```

A task description and `--plan` are mutually exclusive. Quote the whole task as
a single argument — a second bare argument is refused rather than joined,
because silently concatenating them accepts a command whose shell quoting is
wrong.

| Option | Effect |
| --- | --- |
| `--plan <file>` | the plan JSON to run; `-` reads it from stdin |
| `--max-workers <n>` | slices to run at once (default `1`). For a task description this is also the largest number of slices the planner may propose |
| `--slug <name>` | names this run's branches (default: derived from the plan id) |
| `--dry-run` | route every slice and report it; create no worktree, spawn no slice worker, write no commit. A task description still launches the planner |
| `--unsafe-in-place` | run workers in this checkout instead of isolated worktrees |
| `-h`, `--help` | print usage |

Fan-out is earned: the default is one worker. If you ask a task to be planned
with a budget of one and the planner proposes three slices, the run is refused
and tells you to pass `--max-workers 3` — brigadier will not spend worktrees you
did not authorize, and will not silently drop the slices you did not get.

`--unsafe-in-place` cannot be combined with `--max-workers` above 1, because
isolated worktrees are the only thing that makes concurrent slices safe.

### `brigadier install <host>...`

Writes brigadier's host-side doctrine into each CLI host, or stages Desktop's MCP
bundle for manual installation, so the host hands work *to* brigadier instead of
doing it itself. The doctrine's whole message is *you are not the worker*.

| Host | What lands | Where |
| --- | --- | --- |
| `claude-code` | a skill that auto-loads as a plugin, plus a `PreCompact` handoff hook | `~/.claude/skills/brigadier/` |
| `codex` | a skill, a handoff hook, its `PreCompact` registration, and global doctrine | `~/.agents/skills/brigadier/`, `$CODEX_HOME/AGENTS.md`, `$CODEX_HOME/hooks.json` |
| `opencode` | a plugin (for the handoff hook a skill cannot provide) | `~/.config/opencode/plugin/brigadier.js` |
| `claude-desktop` | an MCP bundle, **staged** for manual install | `~/.brigadier/surfaces/claude-desktop/` |

`--all` installs every host, `--dry-run` reports what would be written, and
`--force` replaces a regular file brigadier did not write. It is idempotent and
it never silently overwrites your edits: a manifest at
`~/.brigadier/surfaces.json` records the SHA-256 of everything brigadier wrote.
Without `--force`, a file that no longer matches its recorded hash is refused,
named, and left alone. A destination symlink is always refused, even with
`--force`; writes use `O_NOFOLLOW` and may not escape the resolved install
directory.

`$CODEX_HOME/hooks.json` is shared with your other tools, so it is merged rather
than replaced: brigadier's entry is marked, every other entry and event is
preserved, and a file whose JSON does not parse is refused with nothing written.

Full detail, including the honest limits of each host, is in
[docs/HOSTS.md](docs/HOSTS.md). The headline is that **the handoff hook is not
uniform**: it works on Claude Code; on opencode it binds to event names verified
against a running opencode 1.18.16; on Codex brigadier registers it but Codex
trust-gates it — a click, and a silent no-op until you give it, with the
approval bound to the registration rather than to the script's contents — and it
is **impossible on Claude Desktop**, which exposes no hook surface at all.

### `brigadier mcp`

Serves brigadier's tools over stdio MCP. It takes no runtime options;
`-h`/`--help` prints usage, and any other argument is a usage error rather than
an ignored argument.

| Tool | What it does |
| --- | --- |
| `brigadier_validate_plan` | check a plan for shape and scheduling defects, and report its dependency waves. Touches nothing |
| `brigadier_route_plan` | report which vendor, model and effort this machine would give each slice. Creates no worktree, spawns no worker |
| `brigadier_run` | the real thing: worktrees, workers, commits, merges |

`brigadier_route_plan` routes against an empty quota snapshot, so a drained
model is not avoided there; it says so in its own output.

## The plan document

A plan is JSON. Every slice is one unit of work handed to one worker running
alone in its own copy of the repository, with **exclusive** ownership of a set
of files.

```json
{
  "id": "csv-export",
  "goal": "Add CSV export to the report command",
  "slices": [
    {
      "id": "writer",
      "title": "CSV writer",
      "prompt": "Add a CSV writer in src/csv.ts that quotes fields containing commas or quotes. Export writeCsv(rows: string[][]): string.",
      "ownedPaths": ["src/csv.ts"],
      "difficulty": "standard"
    },
    {
      "id": "writer-tests",
      "title": "Tests for the CSV writer",
      "prompt": "Write tests in test/csv.test.ts covering quoting, embedded newlines, and the empty table.",
      "ownedPaths": ["test/csv.test.ts"],
      "dependsOn": ["writer"],
      "difficulty": "routine"
    }
  ]
}
```

`id`, `title`, `prompt`, `ownedPaths` and `difficulty` are required on every
slice. `difficulty` is `routine`, `standard`, or `hard`, and it has **no
default** — it sets the competence floor a model must clear, so a plan that does
not say how hard a slice is has not been planned. `dependsOn` and `requires` are
optional.

A slice's prompt is its only task-specific brief. The supervisor prepends the
write-lane boundary, and repository project instructions may still load, so
write the prompt self-contained rather than assuming plan or conversation
context.

Two slices may not claim the same path, and no slice's path may sit inside a
directory another claims. Paths must be literal — no globs — because a glob
cannot be proven disjoint against a filesystem that does not exist yet. The
complete field reference, every validation rule, and every error code are in
[docs/PLAN-FORMAT.md](docs/PLAN-FORMAT.md).

A model-authored plan and a hand-written one pass through **the same unmodified
validator**. There is no planner-only path into the supervisor: whatever the
planner proposes is parsed by the function that reads your plan files, and
validated by the function that validates them, before a single ref is written.

## Reading a run

The report is one line per slice, then one line per attempt beneath it, then the
gate's verdict beneath that. Printing only the last attempt would hide the
escalation, which is the single most interesting thing a run produces.

Running the same two-slice plan for real produces the progress log first and the
report last. Slice numbers and durations differ every run; every line's shape is
exactly what the logger and the report renderer emit.

```text
run csv-export: 2 slice(s) in 2 wave(s)
slice writer attempt 1: routed to codex/gpt-5.6-terra at high effort
slice writer attempt 1: reviewing codex/gpt-5.6-terra's work with claude/claude-opus-5 at high effort
slice writer attempt 1: review rejected by claude/claude-opus-5 (1 blocking, 0 concern(s)) in 41200ms
slice writer attempt 2: routed to claude/claude-sonnet-5 at high effort
slice writer attempt 2: reviewing claude/claude-sonnet-5's work with codex/gpt-5.6-sol at high effort
slice writer attempt 2: review approved by codex/gpt-5.6-sol (0 blocking, 1 concern(s)) in 38400ms
slice writer: ok brigadier/csv-export/slice-2 8f3c9a2 (review: approved by codex/gpt-5.6-sol)
accumulate writer: merged
slice writer-tests attempt 1: routed to claude/claude-haiku-4-5-20251001 at medium effort
slice writer-tests attempt 1: reviewing claude/claude-haiku-4-5-20251001's work with codex/gpt-5.6-sol at high effort
slice writer-tests attempt 1: review approved by codex/gpt-5.6-sol (0 blocking, 0 concern(s)) in 22100ms
slice writer-tests: ok brigadier/csv-export/slice-3 1b77e05 (review: approved by codex/gpt-5.6-sol)
merge writer: merged
merge writer-tests: merged

run csv-export: 2 slice(s) in 512300ms
  writer  ok  brigadier/csv-export/slice-2  8f3c9a2
      attempt 1  codex/gpt-5.6-terra effort=high  REVIEW_REJECTED: slice writer attempt 1: claude/claude-opus-5 found 1 blocking issue(s) in codex/gpt-5.6-terra's work: a field containing a quote is emitted unescaped
        review: rejected by claude/claude-opus-5 effort=high in 41200ms
          blocking src/csv.ts:31: a field containing a quote is emitted unescaped
      attempt 2  claude/claude-sonnet-5 effort=high  ok 8f3c9a2
        review: approved by codex/gpt-5.6-sol effort=high in 38400ms
          concern src/csv.ts:12: writeCsv allocates the whole table before writing
  writer-tests  ok  brigadier/csv-export/slice-3  1b77e05
      attempt 1  claude/claude-haiku-4-5-20251001 effort=medium  ok 1b77e05
        review: approved by codex/gpt-5.6-sol effort=high in 22100ms
  integration branch: brigadier/csv-export
  merges:
    writer: merged 3d90f14
    writer-tests: merged 6a2b881
```

Things to notice, because each is a deliberate design decision:

- **A rejection is not the end of the slice.** The rejected model goes on an
  exclusion list and the retry re-routes to a different one. Each slice gets
  exactly one such escalation — two failures on two different models is evidence
  the *slice* is wrong, not the model, and no third model fixes that.
- **Concerns are printed under approvals.** They did not stop the commit, and
  they are the half of a review a human can still act on.
- **When a reviewer runs, its model and elapsed time are shown.** They are the
  only evidence you have about how much reading actually happened. A
  `NO_OTHER_VENDOR` skip has no reviewer identity to show.
- **A skipped review says so, with its reason**, and never renders as a pass.

## The cross-vendor gate

Before a slice commits, a model from the other vendor is shown the exact diff
the commit would record and asked whether it is correct. A blocking finding
fails the attempt, removes the worktree, and re-routes the retry to a different
model. Style, naming and formatting are explicitly out of scope.

### What it reviews

> brigadier's cross-vendor gate reviews **the change**, not the codebase. The
> reviewer is shown the exact diff the commit would record and told to judge the
> lines the diff adds or changes, in the context of the files they land in. Code
> the diff does not touch is in scope **only when the changed code depends on
> it** — calls it, reads its result, or extends it — so that the change itself
> misbehaves when it runs. Anything else the reviewer notices in untouched code
> is reported as a **concern** and never blocks.

### What it therefore does not catch

> A pre-existing defect in a file a slice touches will not stop the commit; at
> best it appears as a non-blocking concern. Nothing outside the diff and its
> surrounding files is examined. **The gate does not run your tests, your
> linter, or your build** — a slice can pass it and still be wrong.

### It fails open

If no second vendor is installed, if the adapter is missing, if the reviewer
fails, or if its reply cannot be parsed, the review is **skipped and the slice
commits anyway**. Cancellation is the exception: cancelling mid-review fails the
attempt without committing it.

This is deliberate. `brigadier init` produces a single-vendor config whenever it
finds one CLI, and failing closed would fail every slice of every such run for
reasons that have nothing to do with the user's code. The price is stated
plainly rather than hidden:

**On a single-vendor install, nothing adversarially reviews anything.** A slice
that otherwise succeeds commits unreviewed, with
`review: not run (NO_OTHER_VENDOR)` on its line. That is the most important
caveat on this page for a new user. If you want the gate, install both CLIs.

### Nothing proves a reviewer looked

`{"findings":[]}` from a model that studied the diff and `{"findings":[]}` from
one that glanced at it are byte-identical. There is no proof-of-work check,
reviewer quality is not uniform, and a confident hallucination marked
`blocking` costs a slice its escalation with nothing here able to catch it. The
report shows the reviewer's model and elapsed time so you can form your own
judgement.

The full design — the scope policy and the measured failure that produced it,
the adjudication rule, every skip reason, and the bounds on what a reviewer is
shown — is in [docs/REVIEW-GATE.md](docs/REVIEW-GATE.md).

## What it does to your repository

- **It commits only on branches it creates.** Never your branch, never `main`.
  Slice work lands on `brigadier/<slug>/slice-N`, is combined onto
  `brigadier/<slug>`, and cleanup attempts to retire the intermediate refs when
  the run ends.
- **It never pushes.** Nothing leaves your machine. The approval gate is your
  own merge of `brigadier/<slug>`, which is the point: you review a branch, as
  you would any contributor's.
- **Each slice runs in its own git worktree**, created as a sibling of your
  repository at `<repo>-brigadier/<slug>/slice-N`, and removed when the run
  ends when cleanup succeeds. Your checkout is never the worker's working
  directory unless you pass `--unsafe-in-place`.
- **Interrupting is controlled.** Ctrl-C cancels every running worker along with
  its whole process group, attempts to remove worktrees and retire the refs the
  run created, and exits `130`. This same cancellation path reaches a run started
  through MCP. A second Ctrl-C skips the remaining cleanup and exits at once.
  Slices that already committed keep their commits and are still merged —
  stopping a run is not a request to throw away finished work.
- **Cleanup it could not finish is reported**, not assumed. If a worker will not
  die or a worktree will not go, the report says so under `cleanup failures:`
  rather than claiming everything was tidy.

## Secrets

Redaction is **mandatory and not optional** once the worktree session has built
its inventory. Commit messages, diffs shown to reviewers, git output in error
messages, the reviewer's prompt, and paths and summaries returned by the
reviewer have inventoried secret values replaced with `[REDACTED]`, whether or
not you consented to anything. Planning happens before that inventory exists, so
a task description and the printed model-authored plan are not covered by this
redaction pass.

**It defeats verbatim leaks only.** The inventory is a best-effort read of raw,
dotenv, JSON, and common YAML files, and it matches exact byte sequences. The
exact multiline value is still caught when git prefixes each diff line, but a
value a model transforms, summarises, base64-encodes, separates arbitrarily, or
truncates is **not** caught. Do not treat redaction as a guarantee that a secret
cannot escape a worktree.

Making secret files *visible* to workers at all is a separate, explicit consent
recorded at `init`, defaulting to **No**. With consent off, no `.env` is linked
into any worktree. Linked secret paths are additionally refused at commit time,
so a worker cannot commit one back.

`--unsafe-in-place` bypasses worktree isolation and the linked-file visibility
boundary: the worker runs in your checkout, where every file you can see is a
file it can see, whatever the consent policy says. It does not disable artifact
redaction or the configured linked-secret commit refusal.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | the command succeeded |
| `1` | brigadier could not enter the supervisor — no config, an unreadable plan document, an environment missing `HOME`, `PATH` or `USER`, or a planner that could not produce a plan. No ref or worktree was created |
| `2` | usage error |
| `3` | the supervisor returned an unsuccessful report, including a syntactically valid plan that cannot be scheduled. The `run failed:` line names the stage that stopped it, and cleanup failures are printed |
| `4` | the task was too ambiguous to plan. The planner ran, but no slice worker, ref, or worktree was created; the questions are printed. Not a failed run — answer them and run it again |
| `130` | interrupted with SIGINT (Ctrl-C); running workers are terminated and cleanup is attempted. Any cleanup failure is printed; a second interrupt skips the rest |
| `143` | interrupted with SIGTERM; the same handling as `130`, for the other signal |

`brigadier install` has its own smaller scheme: `0` every file is in place, `1`
at least one file was refused or could not be written, `2` usage error.

## Limits worth knowing before you rely on it

- **The gate does not run anything.** No tests, no linter, no build. See above.
- **A Claude worker cannot run commands.** Its lane is enforced by `Edit` and
  `Write` tool rules rather than an OS sandbox, so `Bash` is withheld
  entirely — granting it would silently widen the lane to the whole filesystem.
  Claude workers get `Read`, `Glob`, `Grep`, `Edit`, `Write` and nothing else.
  Codex workers run under a real filesystem sandbox profile instead. A slice
  that requires running the test suite should go to Codex only when it does not
  need installed dependencies, or be verified by you.
- **Dependency-provided verification commands are unavailable.** Slice
  worktrees have no `node_modules/`: it is ignored, and brigadier does not
  provision, copy, or symlink it. In this repository, `bun test` succeeds while
  `bun run typecheck` and `bun run check` exit 127 because `tsc` and `biome`
  are not found. This applies to every worker vendor.
- **A worker cannot fetch a missing dependency.** A Codex worker's sandbox
  disables networking, so it cannot fetch anything; a Claude worker has no shell
  at all. Independently, a worker's write lane is exactly its slice's
  `ownedPaths`, so it cannot create `node_modules/` at the repository root
  unless a slice explicitly owns that path. Consequently, `bun run typecheck`
  and `bun run check` cannot be made to work inside a worker and must be
  verified by the human running brigadier.
- **Only Claude's quota is read during a run.** Codex's quota oracle needs a
  `codex app-server` subprocess, and starting one on every run — including dry
  runs, including runs that touch no Codex model — would let an unrelated vendor
  problem hang the supervisor before it did any work. The cost: a drained Codex
  model is not avoided up front. It is routed to, the spawn fails, and the
  slice's escalation handles it.
- **A slice gets two attempts, total.** Not a ladder.
- **Bounds.** A worker gets one hour; a reviewer or planner gets fifteen minutes
  and forty turns. A reviewer is shown at most 96 KiB of diff, and a truncated
  diff carries its own truncation notice inside the text so the reviewer cannot
  believe it saw the whole change.
- **The competence table is curated judgement, not benchmark data.** The scores
  in [docs/METHODOLOGY.md](docs/METHODOLOGY.md) have no sample size, calibration,
  or provenance. They are auditable, which is a different claim.
- **Codex instruction isolation is incomplete.** For
  `instructionFiles.user: "exclude"`, the adapter passes `--ignore-user-config`,
  which suppresses only `$CODEX_HOME/config.toml`. Codex CLI 0.145.0 still loads
  `$CODEX_HOME/AGENTS.md` and exposes no flag to disable it, so a Codex worker
  can never be fully isolated from ambient user instructions.
- **Not published.** `0.1.0`, no npm, no Homebrew.

## Documentation

- [docs/PLAN-FORMAT.md](docs/PLAN-FORMAT.md) — the complete plan document
  reference: every field, every validation rule, every error code.
- [docs/REVIEW-GATE.md](docs/REVIEW-GATE.md) — the cross-vendor gate in depth.
- [docs/HOSTS.md](docs/HOSTS.md) — what `brigadier install` writes, per host,
  and the honest limits of each.
- [docs/METHODOLOGY.md](docs/METHODOLOGY.md) — the routing policy, published so
  it can be audited for vendor bias by someone who does not trust its author.
- [docs/RELEASING.md](docs/RELEASING.md) — the release procedure.

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
`dist/mcp/server.js`. `bun run build:mcp` builds that MCP bundle directly and
leaves no generated JavaScript under `src/`. See
[docs/RELEASING.md](docs/RELEASING.md).

Worker and quota subprocesses run in detached POSIX process groups under both
Bun and Node, so cancelling a run terminates descendants rather than orphaning
them. On Darwin and Linux the published launcher prefers an optional native
package and falls back to JavaScript; on Windows it exits with a clear error.

## License

MIT.
