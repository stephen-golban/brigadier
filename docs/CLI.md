# The commands

brigadier has four commands and no others. Each one resolves an exit code
rather than throwing, and the codes are an interface a script may branch on;
they are listed at the bottom of this page and printed by `brigadier --help`.

| Command | What it does |
| --- | --- |
| `brigadier init` | scan this machine for installed worker CLIs and write a config, interactively. **Not a setup step** — see below |
| `brigadier run` | run a task or a plan: decompose it, route every slice, spawn a worker for each, commit what it produced, and merge the lot |
| `brigadier install` | write brigadier's host-side doctrine into each host |
| `brigadier mcp` | serve brigadier's tools over stdio MCP |

`brigadier --version` (`-V`) and `brigadier --help` (`-h`) are recognized only
when they are the **sole** argument. Inside `init` and `run`, `-h`/`--help`
prints the usage text wherever it appears in the argument list, so the one
command with options is not the one command whose options cannot be looked up.
An unknown command, or no command at all, is a usage error: exit `2`, with the
usage text on stderr.

## Configuration is automatic

**`brigadier run` does not need a config to exist, and never asks you for one.**
It calls `ensureConfig`, which runs the same probe `init` runs, accepts the
proposed defaults, writes the file, and carries on. It reads no stdin, so an
agent with no keyboard attached can be the first thing that ever runs brigadier.
Every diagnostic goes to **stderr**; stdout stays the run report, which is
parsed.

Four cases, and **every one of them proceeds**. What differs is what ends up on
disk:

| What is on disk | What happens |
| --- | --- |
| nothing | the machine is probed, a config is written, and each detection is reported: `brigadier: detected codex codex-cli 0.147.0 at /usr/local/bin/codex`, then `brigadier: wrote config to <path>` |
| a config at the current version that parses | reused exactly as it is. Nothing is probed and nothing is printed |
| a config at a **different** version | re-probed and rewritten in place, printing `has version 2; re-probing this machine and preserving compatible settings`. Tuned per-model effort ceilings, `secretsConsent`, `linkedSecretPaths` and `allowDegradedRouting` are carried across |
| a config at the **current** version that will not parse or will not validate | left **byte-for-byte alone**. The run proceeds on a configuration detected in memory that is **not saved**, and says so: `could not be parsed: …; leaving it untouched and proceeding with a detected configuration that will not be saved` |

The last row is the point: a typo in a hand-edited config must not cost you the
config. The same in-memory fallback covers a config home that cannot be written
at all, which prints `using the detected configuration in memory for this run`.

**Nothing about the config file is fatal any more.** What is still fatal is the
machine around it, and two of those conditions belong to this section:

- **No installed worker CLI.** With nothing to route to, `run` exits `1` with
  `no installed worker CLI reported a selectable model. Install Claude Code or
  Codex, then try again.` and writes no file.
- **No resolvable config home.** With neither `$BRIGADIER_HOME` nor `$HOME` set,
  there is no directory to put a config in and none to look for one in, so the
  lazy path cannot run at all and `run` exits `1` before it starts.

Three further conditions exit `1` for reasons unrelated to configuration — an
unreadable or invalid plan document, an environment missing `HOME`, `PATH` or
`USER`, and a planner that could not produce a plan. [Exit
codes](#exit-codes) lists all five together, and is the authority.

Lazy config **never grants consent for anything**. `guiRegistrationConsent` is
written `false` on every path that creates or rewrites a config this way — even
when a wrong-version file on disk happened to contain `true`, because that file
did not validate and its consent is not evidence a human answered a question. An
existing, valid, current config that already records `true` is reused untouched
and keeps it.

### The install-time probe, and why you must not rely on it

`npm install` invokes `scripts/postinstall.mjs`, which *would* spawn `brigadier
init --yes` to get the probe out of the way before the first run rather than
during it. **In practice it usually does not run at all**, and a plain `npm
install` is one of the cases where it does not. It is a convenience with no
guarantee attached, and it declines far more often than it acts:

- it skips when `CI` is set, by presence and not by value;
- it skips when `process.stdout.isTTY` is not `true` — and npm does not run
  lifecycle scripts in the foreground by default, so stdout is normally a pipe
  and this is normally false. **A plain `npm install` therefore usually skips it
  too**, not merely `--ignore-scripts`, CI and container builds;
- it skips when a config already exists, and when it cannot tell whether one
  does;
- it abandons a probe that takes longer than 5 seconds, killing the whole
  process group.

It exits `0` unconditionally, on every path including its own internal defects,
because a postinstall that exits nonzero fails `npm install` for the entire
dependency tree. It prints nothing on success or failure, and it registers
nothing into any third-party application: it spawns the ordinary CLI with the
ordinary `--yes` flag, whose default for registration consent is No.

Nothing downstream may depend on it having run. **Lazy config is the guarantee.**

## brigadier init

Probe, propose, confirm, write.

**`init` is not a setup step, and has not been a prerequisite for a run since
lazy config landed.** Never run it to make a config appear; the section above is
what actually does that. It remains the interactive way to *choose* — a different
default model, a different effort ceiling, degraded routing, secret-file
visibility — and it has exactly one job nothing else can do: recording the
explicit yes that lets `brigadier install` write into a GUI application's own
configuration. That question can only be asked interactively, so a human runs
`init` once for it. The doctrine brigadier installs into every host says the same
thing, so an agent that reads a consent-skipped message should hand it to the
user rather than run `init` itself.

`init` resolves each vendor's executable from
`$PATH`, runs `<executable> --version`, and reads that vendor's model catalog.
There is no flag and no environment variable that points `init` at a different
executable: the discoverer does accept per-vendor overrides, but only when it is
constructed from library code, so from the CLI `$PATH` is the whole story.
Claude's catalog comes from a static table compiled into brigadier, reported as
`catalog: static-table`; Codex's comes from `codex debug models`, reported as
`catalog: probe`. Each probe command is bounded at 15 seconds. A vendor that is
absent, unprobeable, or unparseable becomes a `not installed` line or a warning
rather than an error — a machine with one broken CLI must still be able to
configure the other one.

It then prints the proposal: per vendor, a default model with the rationale that
chose it, and every model's effort ceiling. A model's proposed ceiling is the
highest rung brigadier proposes that the model itself reported — `high` where
the model allows it, otherwise `medium`, and never above `high`. A model that
reports neither is left out of the proposal entirely rather than recorded at an
effort its vendor would reject. **Nothing is written until you have seen that
proposal.**

Interactively it asks, in this order:

1. the default model for each vendor;
2. whether to change any per-model effort ceiling for that vendor (the default
   is the proposed ceiling above, and only the effort rungs the vendor itself
   reported are offered);
3. whether a slice may run on a model below its difficulty floor rather than
   failing (`allowDegradedRouting`);
4. whether brigadier may register its MCP server with the GUI hosts it detected
   (`guiRegistrationConsent`) — **asked only when at least one was detected**,
   and naming the ones it found;
5. whether brigadier may link secret files into worker worktrees
   (`secretsConsent`), and if so, the repository-relative paths as a JSON array.

Questions 3, 4 and 5 all default to **No** on a fresh config. On a re-run the
existing value is the default, so pressing enter through the whole flow changes
nothing. The secret-path prompt accepts three malformed answers before it gives
up and keeps the current list.

Question 4 is the one question in brigadier that no non-interactive path may
answer yes. `--yes`, `--print-config`, the postinstall script and lazy config all
leave it as it was, and `brigadier install --force` does not grant it either.
Detection itself writes nothing: `init` looks for each GUI host's usual
directories and application bundles purely to decide whether the question is
worth asking, and persists no result. Preserving a yes a human already gave is
not the same as forging one, so `--yes` and a re-run carry an existing `true`
forward rather than silently revoking it — exactly as they have always done for
`secretsConsent`.

| Option | Effect |
| --- | --- |
| `-y`, `--yes` | accept every proposed default without prompting, then write |
| `--print-config` | print the resolved config as JSON on stdout and exit **without writing** |
| `-h`, `--help` | print the usage text and exit `0` |

Any other argument is a usage error (exit `2`).

`--print-config` is quiet: it suppresses the discovery report and the proposal
block, sends discovery notices to stderr instead of stdout, prompts for nothing,
and writes no file. It is the flag to use from a script. It also differs from
the interactive path in one place worth knowing: with **no** vendor reporting a
selectable model, `--print-config` still prints the resolved config and exits
`0`, while an ordinary `init` prints an error naming the two CLIs and exits `1`.

`--yes` and `--print-config` are independent, and either one is enough to make
the run non-interactive; prompting also requires a stdin to read.

### Where the config lands

`$BRIGADIER_HOME/config.json` when `BRIGADIER_HOME` is set to a non-empty value,
otherwise `$HOME/.brigadier/config.json`. With neither variable set, `init`
refuses rather than guessing a home directory. The directory is created mode
`0700` and re-chmodded if it already granted anything to group or other; the
file is written mode `0600` and moved into place by `rename`, so a partial write
never replaces a good config.

## brigadier run

Two invocation forms, and they are mutually exclusive:

```sh
brigadier run "<task description>"   # a model writes the plan, then it runs
brigadier run --plan <file>          # run a plan that already exists
brigadier run --plan -               # read that plan from stdin, until EOF
```

Passing both is a usage error. `--plan` runs a plan that already exists and a
task description asks brigadier to write one; a run that accepted both would
have to decide which wins, and either answer silently discards something you
typed.

**Quote the whole task as a single argument.** `brigadier run fix the parser`
arrives as three arguments, and the second bare argument is refused rather than
joined onto the first. Concatenating them would silently accept a command whose
shell quoting is wrong, which is how a task description ends up missing whatever
the shell ate. An empty or whitespace-only task description is refused too.

| Option | Effect |
| --- | --- |
| `--plan <file>` | the plan JSON to run; `-` reads it from stdin. Mutually exclusive with a task description |
| `--max-workers <n>` | slices to run at once (default `1`). For a task description this is also the largest number of slices the planner may propose |
| `--slug <name>` | names this run's branches (default: derived from the plan id) |
| `--dry-run` | route every slice and report it; create no worktree or ref, spawn no slice worker, write no commit |
| `--verbose` | print the full per-attempt report and verbose progress log instead of the compact run summary |
| `--unsafe-in-place` | run workers in this checkout instead of isolated worktrees; every file here becomes visible to every worker |
| `-h`, `--help` | print the usage text and exit `0` |

`--plan`, `--slug` and `--max-workers` each take their value as the next
argument or inline as `--plan=x`. `--max-workers` accepts digits only — `3abc`
and `1e9` are refused rather than silently truncated — and must be a positive
whole number. `--slug` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`; without it the
slug is derived from the plan id, and a plan id from which nothing branch-safe
survives is refused rather than given a fallback. See
[PLAN-FORMAT.md](PLAN-FORMAT.md) for the refs a slug names.

Any other argument beginning with `-` is a usage error.

### Fan-out is earned

The default is one worker. For a task description, `--max-workers` is also the
planner's slice budget: ask for a plan with a budget of one, and a planner that
proposes three slices does not run. The run stops with

```text
brigadier run: the planner proposed 3 slices but the fan-out budget is 1; fan-out is earned, so pass --max-workers 3 to authorize it.
```

and exits `1`. brigadier will not spend worktrees you did not authorize, and
will not silently drop the slices you did not get.

For a plan file, `--max-workers` throttles concurrency **within** a dependency
wave; it does not change the plan's structural width and does not reject a plan
for having more slices than workers.

`--unsafe-in-place` cannot be combined with `--max-workers` above 1. Isolated
worktrees are the only thing that makes concurrent slices safe, so the
combination is refused before anything is created, reported as a `PLAN_INVALID`
run failure, and exits `3`.

### When the task is too ambiguous to plan

The planner may answer with questions instead of a plan. brigadier then refuses
to guess: no slice worker, worktree, ref, or commit is created, the questions
are printed, and the run exits `4`.

```text
brigadier run: the planner model ran, but this task is ambiguous enough that producing a plan would mean guessing. No slice worker, worktree, ref, or commit was created.

Answer these and run it again:
  1. Should --json replace the human-readable output or be an alternative to it?
  2. Which of the three report subcommands should accept it?
{"status":"needs_human","questions":["Should --json replace…","Which of the three…"]}
```

The last line is machine-readable JSON on purpose, so a host-side skill can
re-invoke brigadier with the answers folded in rather than parsing prose to
recover the question list. The planner model has already run and cost tokens by
this point; that is why the message says so.

## brigadier install

Writes brigadier's host-side doctrine into each host's configuration slot, or
stages Claude Desktop's MCP bundle for manual installation, so the host hands
work *to* brigadier instead of doing it itself.

Hosts that read a skill directory:

| Host | Where its files land |
| --- | --- |
| `claude-code` | `~/.claude/skills/brigadier/` (a skill that auto-loads as a plugin, plus a `PreCompact` handoff hook and a `UserPromptSubmit` nudge hook) |
| `codex` | `~/.agents/skills/brigadier/`, plus `$CODEX_HOME/AGENTS.md` and a merged registration in `$CODEX_HOME/hooks.json` |
| `opencode` | `~/.config/opencode/plugin/brigadier.js` |

Hosts that read none, and reach brigadier only over MCP. Each merges one
`brigadier` key into the host's own `mcpServers` object, and **every one of them
is skipped unless `guiRegistrationConsent` is recorded in your brigadier
config**:

| Host | Where the registration lands |
| --- | --- |
| `cursor` | `~/.cursor/mcp.json` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| `antigravity` | `~/.gemini/config/mcp_config.json` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json`, plus an `.mcpb` bundle **staged only** at `~/.brigadier/surfaces/claude-desktop/` |

| Option | Effect |
| --- | --- |
| `--all` | install every host above |
| `--dry-run` | report what would be written and write nothing |
| `--force` | replace a file brigadier did not write, or that was edited after brigadier wrote it (written with mode 0644 or 0755, not the replaced file's mode). **It does not grant registration consent, and nothing here does** |
| `-h`, `--help` | print usage |

A registration that is skipped for want of consent prints the sentence that says
how to enable it, and that sentence addresses the person, not the agent: run
`brigadier init` yourself and answer yes to *"Register brigadier's MCP server
with detected GUI hosts"*. A host whose configuration directory does not exist is
skipped rather than conjured — creating `~/.cursor/` on a machine with no Cursor
leaves a stranger's directory holding a file nothing will read. Each
registration also prints the host documentation its path and entry shape were
read from, so the path is auditable rather than trusted.

A manifest at `$BRIGADIER_HOME/surfaces.json` records the SHA-256 of everything
brigadier last wrote. A file matching its recorded hash is brigadier's own and
is replaced on upgrade; a file matching nothing is somebody's work and is
**refused**, named, and left exactly as it is.

A manifest that is absent, is not valid JSON, or does not carry a shape
brigadier recognizes is treated as an empty record, which fails safe: with no
record, every pre-existing file is refused. A manifest that exists but cannot be
read — a permission error, a directory in its place, any I/O failure that is not
"no such file" — is a different case and is not treated as empty: `install`
prints `could not safely read <path>` and exits `1` before it considers a single
placement, so nothing is written.

A destination symlink is always refused, even with `--force`. Writes are opened
with `O_NOFOLLOW` and may not escape the resolved install root.

`$CODEX_HOME/hooks.json` is the one file brigadier shares with other tools, so
it is merged rather than written whole: only the entry carrying brigadier's own
`# brigadier-managed-hook` marker is touched, every other event and entry is
preserved, and a `hooks.json` whose JSON does not parse is refused with nothing
written. It is not recorded in the manifest and `--force` has no bearing on it.

Per-host detail, and each host's honest limits — including that the handoff hook
is not uniform and is impossible on Claude Desktop — are in
[HOSTS.md](HOSTS.md).

## brigadier mcp

Serves brigadier's tools over stdio MCP, speaking JSON-RPC 2.0 against the spec
directly with no SDK. It takes **no runtime options**: `-h`/`--help` prints the
usage text and exits `0`, and any other argument is a usage error (exit `2`)
rather than an ignored argument, because the server otherwise blocks on stdin
until the client closes the pipe and a stray flag would look like a hang.

| Tool | What it touches |
| --- | --- |
| `brigadier_validate_plan` | nothing. Checks a plan for shape and scheduling defects and reports the dependency waves it would run in |
| `brigadier_route_plan` | reads this machine's config. Reports the vendor, model and effort each slice would get, or why nothing can take it. Creates no worktree, spawns no worker |
| `brigadier_run` | the real thing: worktrees, workers, commits, one integration branch |

`brigadier_run` requires `plan` and `repositoryPath` and accepts the same `slug`,
`maxWorkers`, `dryRun` and `unsafeInPlace` options the CLI does. The repository
path must name exactly one location by itself — an MCP client gives nobody
control over the server process's working directory, so a relative path, a
leading `~`, and a drive-relative Windows path are refused rather than resolved.

**`brigadier_route_plan` routes against an empty quota snapshot.** The routing
pipeline reads an absent snapshot as "unknown" and therefore as available, so a
drained model is not avoided there. The tool prints that caveat in its own
output. A real run learns the limit from the worker and escalates.

The two tools that read a config go through the same lazy path `run` does, so a
tool call on an unconfigured machine configures it instead of demanding an
interactive step of a client that has no keyboard. Diagnostics go to stderr,
because stdout is JSON-RPC only. No worker CLI at all is still an error, and the
tool now says that rather than pointing at a command that no longer needs
running. The result shapes are unchanged.

The tool **descriptions** are doctrine, not decoration. Cursor, Windsurf,
Antigravity and Claude Desktop read no skill directory, so this metadata is the
only thing brigadier ever gets to say to those hosts: when to reach for it, that
the work goes here rather than inline, enough of the plan shape to build a valid
document including exclusive `ownedPaths`, and that a brigadier worker must never
call back in. `surfaces/claude-desktop/manifest.json` declares the same three
strings and `test/surfaces.test.ts` fails the build if they disagree.

## Reading a run

By default the report is one compact line per slice. It still names interrupts,
cleanup failures, a run failure, plan issues, retries, and skipped reviews; a
skipped review is rendered as `not reviewed: <reason>`, never as a pass. A run
that has a verification command prints it as argv, so a command that ran is
visible in the output of the run that ran it; a dry run with no command says so
instead.

Running a two-slice plan produces this. The duration, commits, and record name
are illustrative; every line's shape is what the report renderer emits.

```text
run csv-export: 2 slices, 8m32s → brigadier/csv-export
  verify command: ["bun","test"]
  writer        ok  8f3c9a2  (retried once, approved by codex)
  writer-tests  ok  1b77e05  (approved by codex)
  full detail: /Users/you/.brigadier/runs/csv-export-<run-id>.json
```

- **A rejection is not the end of the slice.** The rejected model goes on an
  exclusion list and the retry re-routes to a different one. Each slice gets
  exactly one such escalation — two failures on two different models is evidence
  the *slice* is wrong, not the model, and no third model fixes that.
- **A skipped review says so, with its reason**, and never renders as a pass.
- **Every completed non-dry run attempts to write a JSON record** under
  `$BRIGADIER_HOME/runs/`, named `<slug>-<run-id>.json`. The `full detail:` line
  gives its path on success. If redaction cannot be prepared or the write fails,
  that line reports the failure and the run still succeeds; the work has already
  landed. A dry run writes no record.
- **Cleanup failures each get their own `cleanup failure:` line.** `--verbose`
  groups them under a single `cleanup failures:` heading instead. Neither form
  claims everything was tidy.

### `--verbose`

`--verbose` restores the full per-attempt report and the verbose progress log:
one line per slice, then one line per attempt beneath it, then the gate's
verdict beneath that. Printing only the last attempt would hide the escalation,
which is the single most interesting thing a run produces. It is the only way to
see rejected attempts, findings, concerns, reviewer models, and elapsed time in
the terminal; the run record carries the same detail as JSON.

`brigadier_run` over MCP always returns the compact report and has no verbose
option. MCP output enters a host model's context window, so per-attempt detail
would be a token cost on every run.

Slice numbers and durations differ every run; every line's shape below is
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

Things to notice in this form, because each is a deliberate design decision:

- **Concerns are printed under approvals.** They did not stop the commit, and
  they are the half of a review a human can still act on.
- **When a reviewer runs, its model and elapsed time are shown.** They are the
  only evidence you have about how much reading actually happened. A
  `NO_OTHER_VENDOR` skip has no reviewer identity to show.
- **Every attempt is kept, not overwritten.** The rejected attempt above is the
  evidence that justified the retry's escalation.

Under `--verbose` a dry run prints the same attempt lines under a
`dry run <slug>:` heading, with each routed slice reading `would run` and the
integration branch reading `(none: a dry run writes no ref)`. A slice that failed
to route during a dry run still reads `failed`, because a refusal is the answer
you asked for and labelling it "would run" would report it as a plan. The
compact form of a dry run reads `dry run <slug>: N slices, … → (none)`, annotates
each routed slice `not reviewed: dry run`, and states that the `tests_pass` gate
will be skipped when the plan carries no `verify.command`.

`interrupted:`, `plan issues:` and `run failed:` lines appear in both forms only
when they have something to say, as do cleanup failures — grouped under
`cleanup failures:` with `--verbose`, one `cleanup failure:` line each without
it. The clean interruption wording is a claim about cancellation, worktree
removal and ref release all having succeeded, and it is printed only when they
did.

## Exit codes

**A missing, wrong-version, or unparseable config is no longer among the exit-`1`
causes.** Each of those is handled by [Configuration is
automatic](#configuration-is-automatic) and the run proceeds. Only having no
worker CLI to route to, or no directory to resolve a config in, still stops it.

`brigadier run`, and the top-level dispatch:

| Code | Meaning |
| --- | --- |
| `0` | the command succeeded |
| `1` | brigadier could not start the run: no installed worker CLI at all, no resolvable config home (neither `BRIGADIER_HOME` nor `HOME`), an unreadable or invalid plan document, an environment missing `HOME`, `PATH` or `USER`, or a planner that could not produce a plan. No ref and no worktree was created |
| `2` | usage error: an unknown command or option, a missing or malformed option value, a bad `--slug` or `--max-workers`, both a task description and `--plan`, or a second bare argument |
| `3` | the run started and did not succeed. The `run failed:` line names the stage that stopped it, and each slice's line names what happened to it |
| `4` | the planner model ran but found the task too ambiguous to plan. No slice worker, worktree, ref, or commit was created; the questions are printed. Not a failed slice run — answer them and run it again |
| `130` | interrupted with SIGINT (Ctrl-C): brigadier *attempted* to terminate every running worker along with its whole process group, remove the worktrees, and retire the refs the run created. A second interrupt skips the remaining cleanup and exits at once |
| `143` | interrupted with SIGTERM; identical to `130` in every respect but the signal |

`130` and `143` are 128 plus the signal number, and they outrank the report's
own verdict — including a report that came back successful because the abort
landed after the last merge.

**Neither code says cleanup succeeded.** They are returned whether it worked or
not. The report is where you find out: a clean interruption prints
`interrupted: workers were cancelled and worktrees removed`, and anything else
prints `interrupted: cleanup did not finish` followed by a `cleanup failures:`
block naming each one. Read that block before you walk away — a worker that
outlived the cancellation is still running and still spending paid quota, and a
worktree that would not be removed is still on disk.

`brigadier install` has its own smaller scheme:

| Code | Meaning |
| --- | --- |
| `0` | nothing was refused and nothing failed to be written. **Not** a claim that every file is in place: a skip does not move the exit code |
| `1` | at least one file was refused or could not be written |
| `2` | usage error |

A registration skipped for want of GUI consent, or for a host that is not
installed, is a skip rather than a refusal, so `brigadier install --all` on a
machine with no recorded consent skips all four GUI registrations and still exits
`0`. Skips are named in the output and counted in its closing summary line; a
script that needs to know what landed must read the report.

## Bounds and worker limits

### Time and turns

| Actor | Total bound | Idle bound | Turn cap |
| --- | --- | --- | --- |
| slice worker | 1 hour (3,600,000 ms) | 15 minutes | none |
| planner | 15 minutes (900,000 ms) | 15 minutes | 40 turns |

One hour is long enough for a substantial coding slice while still ensuring that
a wedged worker cannot hold the supervisor forever. The idle bound is deliberately
above Claude Code's 600-second stall boundary, so a healthy silent run is not
mistaken for a stalled one. A slice gets two attempts in total, not a ladder.

The reviewer's time, turn, and diff bounds are covered in
[REVIEW-GATE.md](REVIEW-GATE.md#bounds), which also explains what a truncated
diff carries with it. The worker's one-hour bound is documented only here.

### A worker cannot fetch a missing dependency

Three independent facts add up to one consequence:

- a Codex worker runs under a sandbox profile declaring `network={enabled=false}`,
  so it cannot fetch anything;
- a Claude worker has no shell at all, so it cannot run a package manager;
- a worker's write lane is exactly its slice's `ownedPaths`, so it cannot create
  `node_modules/` at the repository root unless a slice owns that path.

**Consequently `bun run typecheck` and `bun run check` cannot be made to work
inside a worker and must be verified by the human running brigadier.** In this
repository, a slice worktree has no `node_modules/`, and brigadier does not
provision, copy, or symlink one.

### The two lanes are not enforced the same way

A Claude worker's lane is built from `Edit(<path>)` and `Write(<path>)` tool
rules, one pair per owned path — not an OS sandbox. `Bash` sits outside those
rules and could write anywhere on the machine, so **it is withheld entirely**:
granting it would silently widen the lane to the whole filesystem. A Claude
worker gets `Read`, `Glob`, `Grep`, `Edit`, `Write` and nothing else, with
`WebFetch` and `WebSearch` explicitly disallowed. Re-adding `Bash` would require
a different enforcement mechanism, not a one-line tool-list edit.

A Codex worker runs under a real filesystem sandbox profile instead: the
worktree root is readable, each owned path is writable, and the network is off.

### Codex instruction isolation is incomplete

Every worker spec sets `instructionFiles.user: "exclude"`, and for Codex the
adapter implements that by passing `--ignore-user-config`. **That flag suppresses
only `$CODEX_HOME/config.toml`.** Codex CLI 0.145.0 still loads
`$CODEX_HOME/AGENTS.md` into every session, including brigadier's own workers,
and exposes no flag to disable it. A Codex worker therefore can never be fully
isolated from ambient user instructions.

`brigadier install codex` writes `$CODEX_HOME/AGENTS.md` itself, so that file is
read by brigadier's workers as well as by your interactive Codex sessions. Keep
it short, keep it doctrine, and put nothing in it that a worker running one
slice should not see.

Project instructions are a separate policy and are deliberately **included** —
they are legitimate repository-local conventions. Suppressing them for Codex
would mean passing `project_doc_max_bytes=0`, which brigadier does only when a
spec asks for project exclusion.

## Environment

Variables the CLI itself reads:

| Variable | Read by | Effect |
| --- | --- | --- |
| `BRIGADIER_HOME` | every command | the config home. Non-empty overrides `$HOME/.brigadier`; also where `surfaces.json` and the staged Desktop bundle live |
| `HOME` | every command | required unless `BRIGADIER_HOME` is set for config resolution, and unless every one of `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` is set for `install`. `run` requires it unconditionally, and passes it to every worker so vendor credential files can be found |
| `PATH` | `init`, `run` | resolves each vendor's executable during discovery, and is required by `run` and passed to every worker |
| `USER` | `run` | required by `run` and passed to every worker: Claude Code resolves its OAuth credentials through it, and `LOGNAME` does not substitute |
| `CODEX_HOME` | `run`, `install` | forwarded to a Codex worker when set, because Codex resolves its credentials relative to it rather than to `HOME`; and the root for `AGENTS.md` and `hooks.json` during `install`. Never defaulted by brigadier — Codex falls back to `$HOME/.codex` itself |
| `CLAUDE_CONFIG_DIR` | `install` | the Claude Code config root; defaults to `$HOME/.claude` |
| `XDG_CONFIG_HOME` | `install` | the opencode config root; defaults to `$HOME/.config` |
| `BRIGADIER_MCP_COMMAND` | `install` | the command a GUI host's MCP registration is told to spawn. Defaults to this executable when brigadier is running as its own compiled binary, and to the bare name `brigadier` otherwise. Set it to an absolute path when the bare name would not resolve |
| `CI` | `scripts/postinstall.mjs` | present at any value, the install-time probe skips |

`run` refuses a machine missing any of `HOME`, `PATH` or `USER` before it writes
a ref, rather than rediscovering the problem once per slice. A task-backed run
refuses it one step earlier still, before the planner launches.

Worker processes get a deliberately minimal environment — `HOME`, `PATH`,
`USER`, `SHELL=/bin/sh`, `BRIGADIER_WORKER=1`, plus `CODEX_HOME` for a Codex
worker and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` for a Claude one. No other
ambient variable of yours enters a worker.

Two more variables belong to the hook scripts `brigadier install` writes rather
than to the CLI. `BRIGADIER_HANDOFF_STDIN_TIMEOUT_MS` bounds how long either hook
waits on stdin, and `BRIGADIER_NUDGE=off` silences the `UserPromptSubmit` nudge
entirely. See [HOSTS.md](HOSTS.md#the-nudge-hook).

`BRIGADIER_WORKER=1` is set **by** brigadier rather than read from you. Every
worker is spawned with it, stamped at the spawn after the spec's own environment
is spread so a spec cannot override it and an ancestor process cannot supply it.
The nudge hook checks it before it reads stdin and stays silent, which is what
stops a slice worker from being told to start a second orchestrator inside its
own slice.
