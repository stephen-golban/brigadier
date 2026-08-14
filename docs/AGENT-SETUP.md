# Setting up brigadier (a guide for AI agents)

This page is written for an AI assistant installing and configuring brigadier on
a user's machine, not for the user. Every step below is a command with an
expected exit code and an observable result, in the order they must run.

**If any check fails, or returns something this page does not describe, stop and
ask the user.** Do not guess a path, do not invent a flag, and do not work
around a failed precondition. brigadier spawns the user's own logged-in vendor
CLIs and writes to their repository; a wrong guess costs them real tokens and
real branches.

## Before you start

Run all five checks before installing anything.

| # | Check | Command | Expected |
| --- | --- | --- | --- |
| 1 | git is present | `git --version` | exit `0`, a version string |
| 2 | you are inside a git repository | `git rev-parse --is-inside-work-tree` | exit `0`, output `true` |
| 3 | the platform is supported | `uname -s` | `Darwin` or `Linux` |
| 4 | a worker CLI is present | `command -v claude`, `command -v codex` | exit `0` for at least one |
| 5 | that CLI is logged in | see below | see below |

Check 1 is a hard requirement: isolation and integration are both git.

Check 3: **Windows is not supported.** The published launcher exits `1` with
`brigadier: Windows is not supported` before doing anything else. If `uname` is
unavailable or reports a Windows environment, stop and tell the user.

Check 5 has no single command, because brigadier never handles credentials
itself — it drives whatever login the vendor CLI already has. For Codex,
`codex doctor --json` reports an `auth.credentials` status (`ok` when a
credential file was found under `$CODEX_HOME`, `fail` when it was not); that is
a probe, not a token spend. For Claude Code there is no equivalent free probe
documented here — either ask the user to confirm they are logged in, or ask them
before spending a trivial prompt on it. Do not assume.

### If only one vendor is installed, say so

brigadier's review gate is **cross-vendor**: a slice built by Claude is reviewed
by Codex, and a slice built by Codex is reviewed by Claude. With only one vendor
installed there is no second vendor to ask, so **the gate does not run at all
and every slice commits unreviewed**, marked `review: not run (NO_OTHER_VENDOR)`
on its report line. The run still succeeds; nothing fails.

Surface this to the user before you continue. Do not let a single-vendor setup
proceed silently: the user is very likely to believe reviews are happening.

## Step 1 — install brigadier

### Primary path: npm global install

```sh
npm install --global @stephen-golban/brigadier
```

Verify, and do not proceed until both succeed:

```sh
command -v brigadier      # exit 0, prints a path
brigadier --version       # exit 0, prints a bare version such as 0.1.1
```

The published launcher prefers an optional native package for the current
platform and falls back to a JavaScript build; both answer `--version`
identically, so the check above is sufficient. Homebrew is **not** available —
there is no published tap.

### Alternative path: build from source

For contributors, or for a user who wants the self-contained executable:

```sh
git clone https://github.com/stephen-golban/brigadier
cd brigadier
bun install
```

**The build script you run depends on the platform**, and picking the wrong one
fails the step. On macOS:

```sh
bun run build             # includes build:codesign
```

On Linux:

```sh
bun run build:unsigned    # dist + binary only
```

`bun run build` ends in `build:codesign`, which runs `codesign` — a macOS-only
tool. On Linux that command exits nonzero and the build fails after the binary
has already been produced, which reads like a broken build and is not one.
`build:unsigned` runs the same `build:dist` and `build:binary` steps and stops
before signing, so the Linux executable simply carries no ad-hoc signature. Do
not run `bun run build` on Linux, and do not "fix" a `codesign: command not
found` by installing something.

Verify:

```sh
test -x ./brigadier        # exit 0
./brigadier --version     # exit 0, prints the version
```

Either script emits the self-contained `./brigadier` executable plus
Node-compatible modules under `dist/`; `build:unsigned` additionally skips
`build:mcp`, so it writes no `dist/mcp/`. That affects only the Node
`brigadier-mcp` launcher — the executable serves `brigadier mcp` itself. This
path requires Bun. The executable is not on `PATH` — either move it somewhere
on `PATH` or call it by path, and use that same form in every command below.

## Step 2 — there is nothing to configure

**Do not run `brigadier init`. It is not a setup step and has not been a
prerequisite for a run.** A turn spent on it is a turn wasted.

`brigadier run` configures the machine itself, without reading stdin. It probes
for installed worker CLIs, writes `$BRIGADIER_HOME/config.json`, reports each
detection on **stderr**, and carries on:

```text
brigadier: detected codex codex-cli 0.147.0 at /usr/local/bin/codex
brigadier: wrote config to /Users/you/.brigadier/config.json
```

A config already there at the current version is reused untouched and prints
nothing. A config at a **different** version is re-probed and rewritten in place,
carrying across tuned effort ceilings, `secretsConsent`, `linkedSecretPaths` and
`allowDegradedRouting`. A **current**-version config that will not parse is left
byte-for-byte alone; the run proceeds on a detected configuration held in memory
that is not saved, and says so on stderr. **Report that line to the user** — their
config file has a defect and brigadier deliberately did not overwrite it.

An `npm install` may have run a probe already, but assume it did not: that script
skips whenever `CI` is set or stdout is not a TTY, which covers a plain
`npm install`. Never treat a missing config as a defect or a reason to intervene.

The one failure that is still fatal: **no installed worker CLI at all**. The run
exits `1` with `no installed worker CLI reported a selectable model. Install
Claude Code or Codex, then try again.` and nothing is written. That is a real
precondition failure — stop and tell the user.

### Inspecting the config without changing anything

```sh
brigadier init --print-config
```

`--print-config` prints the resolved config as JSON on stdout and **writes no
file**. It also suppresses the discovery report and the proposal block, sends
discovery notices to stderr, and prompts for nothing. This is the one `init`
invocation an agent may make freely, because it changes nothing. Use it to show
the user what would be recorded.

The ceiling it proposes is not `high` for every model. It is the highest rung
brigadier proposes that the model itself reported: `high` where the model allows
it, otherwise `medium`, and never above `high`. A model that reports neither is
excluded from the proposal rather than recorded at an effort its vendor would
reject, so do not report a `medium` ceiling or a missing model as a defect.

One asymmetry to know: with **no** installed CLI reporting a selectable model,
`--print-config` still prints a config and exits `0`, while plain
`brigadier init` prints an error naming Claude Code and Codex and exits `1`.
Never read a successful `--print-config` as proof that a worker CLI was found —
check its `vendors` array.

### The one time a human runs `brigadier init`

Registering brigadier's MCP server into a GUI application's own configuration
(Cursor, Windsurf, Antigravity, Claude Desktop) takes an explicit yes, and only
the interactive question can ask for it. Nothing else grants it — not `--yes`,
not `--print-config`, not the install-time probe, not the lazy config a run
writes, and not `brigadier install --force`.

So if `brigadier install` reports a registration skipped for want of consent,
**pass that sentence to the user and let them run `brigadier init` once
themselves.** Do not run it for them, and do not hand-edit
`guiRegistrationConsent` into their config. This is a consent decision, exactly
like `secretsConsent` below.

### Where the config lands

`$BRIGADIER_HOME/config.json` when `BRIGADIER_HOME` is set and non-empty,
otherwise `$HOME/.brigadier/config.json`. The directory is created mode `0700`
and the file mode `0600`. With neither variable set, brigadier refuses rather
than guessing a home directory — that is one of the two remaining exit-`1`
config failures.

### Do not turn on secret-file visibility

`secretsConsent` controls whether brigadier may link secret files (for example
`.env`) into worker worktrees. It defaults to **No**, and `--yes` keeps it No on
a fresh config.

**An agent must not enable it on the user's behalf.** If a slice appears to need
a secret file, say so and ask; do not edit the config, and do not re-run `init`
interactively to flip it. This is a consent decision, and the default is the
safe one.

## Step 3 — verify the install

Run these in order. All three are free of model calls.

```sh
brigadier --version                       # exit 0
brigadier --help                          # exit 0, lists init/run/install/mcp
```

Then a dry run against a tiny plan, from inside the user's repository. Write the
plan to a scratch file:

```json
{
  "id": "setup-check",
  "goal": "Verify that brigadier routes a slice on this machine",
  "slices": [
    {
      "id": "probe",
      "title": "Routing probe",
      "prompt": "This slice is never executed; it exists to prove routing works.",
      "ownedPaths": ["docs/never-written.md"],
      "difficulty": "routine"
    }
  ]
}
```

```sh
brigadier run --plan ./setup-check.json --dry-run
```

Expected: exit `0`, a `dry run setup-check: 1 slice(s) in <n>ms` heading, a
`probe  would run` line, an attempt line beneath it naming the vendor, model and
effort that would take the slice and ending in `routed`, and
`integration branch: (none: a dry run writes no ref)`.

**A `--plan` dry run launches no model and costs no tokens.** It routes against
the saved config and returns before any worktree, ref, worker, or commit exists.
It is the correct verification step for exactly that reason. Delete the scratch
plan afterwards.

**A dry run from a task description is not free.** `brigadier run "<task>"
--dry-run` still runs the planner model to produce the plan it then routes, and
that costs the user tokens. Never substitute it for the check above.

If the dry run reports the slice as `failed ROUTING_FAILED`, read the `rejected
<vendor>/<model> [<stage>]: <reason>` lines printed under it — they name every
model that was considered and why each was refused — and report them to the user
rather than retrying blindly.

## Step 4 — install host doctrine

`brigadier install <host>` writes brigadier's doctrine into a host so that host
hands work to brigadier instead of doing it itself. Nothing in Step 3 depends on
it, but **this is how brigadier is primarily meant to be used**: the user keeps
working in the host they already have, and brigadier engages from inside that
session. Install it into the host you are running in, at least.

**Always dry-run first:**

```sh
brigadier install --all --dry-run     # reports what would be written, writes nothing
brigadier install claude-code codex   # then the real thing
```

Seven hosts, in two kinds. `claude-code` and `codex` read a skill directory and
get the doctrine written into it. `cursor`, `windsurf`, `antigravity` and
`claude-desktop` read none, so brigadier merges one `brigadier` key into that
host's own MCP configuration instead — **and every one of those four is skipped
unless the user has recorded registration consent.** A skip is not a failure and
does not move the exit code. When you see one, relay its message; the remedy is
the user running `brigadier init` once, and it is not yours to perform.

**`opencode` is the exception, and installing it alone is a trap.** opencode
reads `~/.claude/skills` and `~/.agents/skills` natively, so it gets the doctrine
from `brigadier install claude-code` or `brigadier install codex` — never from
its own name. `brigadier install opencode` writes only the compaction-handoff
plugin, which is the one thing a skill cannot be. If the user is on opencode,
install `codex` (or `claude-code`) for the doctrine and `opencode` for the hook;
`opencode` by itself leaves the host with a hook and nothing telling it to
delegate.

On Claude Code the install also registers a `UserPromptSubmit` nudge hook beside
the `PreCompact` handoff hook. Neither needs approval on that host. The nudge
says one sentence, at most once per session, only for a prompt that describes
more than one independent piece of work, and `BRIGADIER_NUDGE=off` silences it.
It is deliberately **not** registered on Codex, because Codex binds hook approval
to the exact registration and adding an event would disarm the approved handoff.

Exit `0` means nothing was refused and nothing failed to be written; `1` means at
least one file was refused or could not be written; `2` is a usage error. **`0`
does not mean every file is in place.** A skip does not move the exit code, so
`brigadier install --all` with no recorded consent skips all four GUI
registrations and still exits `0`. Read the per-file lines and the closing
`… written, … unchanged, … skipped, … refused.` summary rather than the code
alone; you are the one telling the user what actually landed.

A refusal is not a crash — the
destination is left exactly as it is. **Read the refusal message, because there
are two kinds and only one of them has a remedy.**

*Ownership refusals* — a file brigadier has no record of writing, or one edited
after brigadier wrote it. The message ends in `Re-run with --force to replace
it.` or `Re-run with --force to discard those edits.` These are the user's call:
report them and let the user decide. `--force` is theirs to authorize, never
yours.

*Path-safety refusals* — the destination is a symbolic link, its real path
cannot be established, the install root cannot be resolved, or the real path
lands outside the install root. Their messages begin `refusing to write <path>:`
and each one ends by saying that `--force` replaces edited files and does not
override this refusal. **`--force` cannot make these succeed.** It is not a
permission the user can grant; the check is not about ownership at all. Never
offer it as the remedy, and never suggest the
user re-run with it: the answer is to tell the user what the path actually is
and stop.

State plainly to the user: **the handoff hook is not uniform across hosts.** It
works on Claude Code, binds to verified event names on opencode, is registered
but trust-gated on Codex (a silent no-op until the user approves it), and is
**impossible on Claude Desktop**, which exposes no hook surface at all. Per-host
files, roots, and limits are in [HOSTS.md](HOSTS.md).

## Handing work to brigadier

Two forms, mutually exclusive:

```sh
brigadier run "<task description>"    # a model writes the plan, then it runs
brigadier run --plan <file>           # run a plan that already exists
brigadier run --plan -                # read that plan from stdin
```

Quote the whole task as **one** argument. A second bare argument is refused, not
joined — brigadier will not accept a command whose shell quoting is wrong.

A plan is JSON. Do not restate or invent its schema: the complete field
reference, every validation rule, and every error code are in
[PLAN-FORMAT.md](PLAN-FORMAT.md). Four rules matter most when an agent writes a
plan:

- **`difficulty` is required on every slice and has no default.** It is
  `routine`, `standard`, or `hard`, and it sets the competence floor a model must
  clear. A plan that does not say how hard a slice is has not been planned.
- **`ownedPaths` must be disjoint and literal.** No two slices may claim the same
  path, and no slice's path may sit inside a directory another claims. Globs are
  refused outright, because a glob cannot be proven disjoint against a filesystem
  that does not exist yet.
- **A slice prompt must be self-contained.** The worker sees no plan, no sibling
  slices, and no host conversation — only its own prompt with the write-lane
  boundary prepended. Name the files, the interfaces, the constraints, and the
  definition of done.
- **A worker cannot write outside its owned paths.** A prompt asking it to is a
  prompt that cannot succeed; that is a re-slicing signal, not a wording problem.

Fan-out is earned. `--max-workers` defaults to `1`, and for a task description it
is also the planner's slice budget: if the planner proposes more slices than the
budget, the run refuses and names the number to pass. Do not raise
`--max-workers` past what the user authorized.

## Failure modes

| Symptom | Exit | What to do |
| --- | --- | --- |
| `no installed worker CLI reported a selectable model` | `1` | there is nothing to route to. Ask the user to install Claude Code or Codex and log in. Do not retry |
| `config at <path> could not be parsed: …; leaving it untouched` | *(none)* | **not a failure.** The run proceeds on a detected config held in memory. Relay the line so the user knows their config file has a defect brigadier refused to overwrite |
| `could not read the plan file <path>` / `is not valid JSON` | `1` | fix the path or the JSON. Nothing was created |
| `is not a valid plan document (<n> issue(s))` | `1` | every defect is listed at once; repair them all in one pass, then retry |
| a missing `HOME`, `PATH`, or `USER` | `1` | the environment cannot launch any worker. Do not patch it silently — tell the user which variable is missing |
| `the planner proposed N slices but the fan-out budget is M` | `1` | ask the user whether to authorize `--max-workers N`; do not raise it yourself |
| `unknown option`, `requires a value`, `only one task description is accepted`, both a task and `--plan` | `2` | a malformed command line. Re-read this page; do not retry with a guessed flag |
| `run failed: <reason> — <message>` | `3` | the run started and did not succeed. Slices that landed are on the integration branch; report the reason and each slice's line to the user |
| `unsafeInPlace=true cannot be combined with maxWorkers=<n>` | `3` | drop `--unsafe-in-place` or set `--max-workers 1`; never both |
| `{"status":"needs_human","questions":[...]}` on the last line | `4` | the planner ran but the task is ambiguous. **Relay the printed questions to the user verbatim**, get answers, and re-run with the answers folded into the task description. The last line is machine-readable JSON for exactly this. No worktree, ref, or worker was created |
| interrupted by Ctrl-C or SIGTERM | `130` / `143` | the user stopped it. Workers were cancelled and cleanup attempted; check for a `cleanup failures:` block and report it. Do not restart without asking |

An exit `4` is **not** a failed run. Treating it as one, and retrying with the
same task, will produce the same questions and spend the planner's tokens again.

## What an agent must never do silently

- **Never pass `--unsafe-in-place` without the user's explicit consent.** It
  drops worktree isolation: the worker runs in the user's own checkout, where
  every file they can see is a file it can see, whatever the secret-visibility
  consent says.
- **Never enable `secretsConsent` on the user's behalf.** It defaults to No. If
  a slice seems to need it, ask.
- **Never grant `guiRegistrationConsent` on the user's behalf.** It authorizes
  brigadier to write into another application's configuration. Only the
  interactive question in `brigadier init` may record it, and hand-editing the
  config to fake it is the same violation as answering it for them.
- **Never run `brigadier init` to make a config appear.** It is not a setup
  step; `brigadier run` configures the machine itself. The only `init` an agent
  may run freely is `--print-config`, which writes nothing.
- **Never claim a slice was reviewed when the report says
  `review: not run (NO_OTHER_VENDOR)`.** That line means nothing adversarially
  reviewed the change. Report it as unreviewed.
- **Never assume the gate ran tests, a linter, or a build.** It runs none of
  them. It reads a diff. A slice can pass the gate and still be wrong; see
  [REVIEW-GATE.md](REVIEW-GATE.md).
- **Never report a worker's own claim as evidence.** Read the diff on
  `brigadier/<slug>` before telling the user the work is done.
- **Never claim `bun run typecheck`, `bun run check`, or any other
  dependency-backed command passed inside a worker.** A worker cannot install
  dependencies: a Codex worker has no network, a Claude worker has no shell, and
  a worker's write lane is only its slice's `ownedPaths`. Those commands must be
  run by the human. See [CLI.md](CLI.md#bounds-and-worker-limits).
- **Never invent a command.** brigadier has exactly four: `init`, `run`,
  `install`, and `mcp`. Every option each accepts is listed in
  [CLI.md](CLI.md).
