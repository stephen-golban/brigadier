# Host surfaces

brigadier is one engine. `brigadier install <host>` writes a small doctrine
artifact into a host's configuration slot — or, for a host that reads no skill
directory, merges an MCP registration into the host's own configuration — so the
host hands work *to* brigadier instead of doing it itself. The doctrine's whole
message is *you are not the worker*.

This is the primary way brigadier is meant to be used. You keep working in the
host you already use; brigadier engages from inside that session.

It is not a package manager, it installs no plugin runtime, and it depends on
none. The shipped product spawns `claude` and `codex` as plain subprocesses.

```sh
brigadier install claude-code
brigadier install codex opencode
brigadier install --all
brigadier install --all --dry-run
```

Seven hosts, in two kinds. `claude-code` and `codex` read a skill directory, so
brigadier writes the doctrine into it. `cursor`, `windsurf`, `antigravity` and
`claude-desktop` read none, so the only door is MCP and brigadier merges one key
into the host's own configuration — which it will not do without [an explicit
yes](#registration-into-a-gui-host-needs-an-explicit-yes).

`opencode` sits across that line and is the one host whose name on the command
line is not how it gets its doctrine. It reads `~/.claude/skills` and
`~/.agents/skills` natively, so the doctrine reaches it through `brigadier
install claude-code` or `brigadier install codex`; `brigadier install opencode`
writes neither a skill nor an MCP registration, only [the compaction-handoff
plugin](#opencode) that a skill cannot be. Installing `opencode` alone leaves the
host with a hook and no doctrine.

| Option | Effect |
| --- | --- |
| `--all` | install every host |
| `--dry-run` | report what would be written and write nothing |
| `--force` | replace a regular file brigadier did not write, or that was edited after it did. It does **not** grant registration consent |
| `-h`, `--help` | print usage |

Exit codes: `0` nothing was refused and nothing failed to be written, `1` at
least one file was refused or could not be written, `2` usage error.

**`0` does not mean every file is in place.** A registration skipped for want of
consent, or for a host that is not installed, is a **skip** rather than a
refusal, and a skip does not move the exit code — so `brigadier install --all` on
a machine that has recorded no consent skips all four GUI registrations and still
exits `0`. Every skip is named on its own line in the output and counted in the
closing `… written, … unchanged, … skipped, … refused.` summary. **Automation
must read that report, not the exit code alone.**

## Idempotent, and it never silently overwrites your edits

Those two properties pull against each other, and content comparison alone
cannot satisfy both — "differs from the template" covers *you edited it* and
*brigadier shipped a new version* equally well, and guessing wrong either loses
your work or freezes you on stale doctrine.

So a manifest at `$BRIGADIER_HOME/surfaces.json` records the SHA-256 of what
brigadier last wrote to each path:

- A file matching its recorded hash is one brigadier wrote and nobody touched:
  safe to replace on upgrade.
- A file matching nothing is somebody's work: **refused**, named, and left
  exactly as it is, with `--force` spelled out as the way to say otherwise.
- An unreadable or unrecognizable manifest is treated as empty, which fails
  safe: with no record, every pre-existing file is refused rather than replaced.

Running `brigadier install` twice does nothing the second time.

The manifest governs the files brigadier writes **whole**. Files it shares with
other tools are merged instead, and their protection is different: brigadier
touches only its own entry, leaves every other byte alone, refuses the whole
write if the JSON does not parse, records nothing in the manifest, and gives
`--force` no bearing on the outcome — if you edit brigadier's own entry, the next
install replaces it.

There are two kinds of such file. `$CODEX_HOME/hooks.json`, where brigadier's
entry is the one carrying a `# brigadier-managed-hook` marker in its command
string; and each of the four GUI hosts' MCP configurations, where it is the
`brigadier` key under `mcpServers`.

A destination symlink is always refused, even with `--force`. The installer
resolves the install root, refuses writes that escape it, and opens destination
files with `O_NOFOLLOW` so a symlink swap cannot redirect the write.

## Where each host's files land

Roots come from the environment: `$CLAUDE_CONFIG_DIR` (else `$HOME/.claude`),
`$CODEX_HOME` (else `$HOME/.codex`), `$XDG_CONFIG_HOME` (else
`$HOME/.config`), and `$BRIGADIER_HOME` (else `$HOME/.brigadier`). The four GUI
hosts are anchored under `$HOME` directly. With `$HOME` unset and not every
override supplied, the command refuses rather than guessing a home directory.

### `claude-code`

| File | Path |
| --- | --- |
| skill | `~/.claude/skills/brigadier/SKILL.md` |
| plugin marker | `~/.claude/skills/brigadier/.claude-plugin/plugin.json` |
| hook registration | `~/.claude/skills/brigadier/hooks/hooks.json` |
| handoff hook | `~/.claude/skills/brigadier/hooks/handoff.mjs` |
| nudge hook | `~/.claude/skills/brigadier/hooks/nudge.mjs` |
| hook notes | `~/.claude/skills/brigadier/hooks/README.md` |

The skill auto-loads as the plugin `brigadier@skills-dir` in your next Claude
Code session, because of the `.claude-plugin/plugin.json` beside it. No
marketplace, and no consent dialog. Both hooks are registered in that one
`hooks.json` — `handoff.mjs` against `PreCompact` with a `"*"` matcher, and
`nudge.mjs` against `UserPromptSubmit`, which takes no matcher on this host so
the registration carries none. **Neither needs approval on this host.** The
command strings use `${CLAUDE_PLUGIN_ROOT}`, which Claude Code expands to the
installed skill directory, so the registrations survive being installed anywhere.

### `codex`

| File | Path |
| --- | --- |
| skill | `~/.agents/skills/brigadier/SKILL.md` |
| handoff hook | `~/.agents/skills/brigadier/hooks/handoff.mjs` |
| hook notes | `~/.agents/skills/brigadier/hooks/README.md` |
| global doctrine | `$CODEX_HOME/AGENTS.md` |
| hook registration | `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`) |

`~/.agents/skills` is read by both Codex and opencode, so this one skill serves
both.

`brigadier install codex` **does** register the handoff hook: it merges one
`PreCompact` entry naming the absolute path of the installed `handoff.mjs` into
`$CODEX_HOME/hooks.json`. That file is shared with every other tool you have
registered, so it is merged rather than written over — other events, other
entries, and keys brigadier does not recognize are preserved byte-for-byte, and
a `hooks.json` whose JSON does not parse is refused with nothing written. The
entry carries a `# brigadier-managed-hook` marker in its command string, which
is how a second install finds its own entry to replace instead of appending a
duplicate.

**Registration is not approval.** Codex will not run a hook you have not
trusted. Until you approve it, the hook is a silent no-op: Codex exits 0,
with no warning and no hook output. Codex documents and expects approval to
be bound to the registration — the event, matcher, and command — rather than
to the contents of `handoff.mjs`, so the script at an approved path can
later change without Codex asking again; re-reviewing an edited script
means deliberately changing the registration and approving it again. The
README installed beside `handoff.mjs` explains the approval step.

The earlier claim that a user has no way to determine whether hook approval was
persisted was wrong. Measured on codex-cli 0.147.0, persisted trust is readable
non-interactively from `$CODEX_HOME/config.toml` under a `[hooks.state]` table:
an entry keyed as `<hooks file>:<snake_case event>:<group index>:<hook index>`
carries a `trusted_hash`. This directly answers whether approval was persisted,
and is consistent with the documented claim that approval binds to the
registration rather than to the script's contents: the recorded hash matches
neither the SHA-256 of `handoff.mjs` nor the SHA-256 of the hooks file. That
claim has limited direct evidence: on codex-cli 0.147.0, changing the script
without changing its registration left `$CODEX_HOME/config.toml`, including the
recorded trust entry and its recorded hash, and `$CODEX_HOME/hooks.json`
byte-identical. This is consistent with approval binding to the registration,
but whether Codex re-prompts at the next interactive session start was not
observed, and the converse — that changing the registration revokes trust —
remains untested. The narrower observation remains true on codex-cli 0.147.0:
there is no dedicated hook diagnostic command — `codex doctor` output
contains the string `hook` zero times, and `codex --help` lists no `hooks`
subcommand. `codex --help` does list `--dangerously-bypass-hook-trust`, which
`surfaces/codex/hooks/README.md` documents.

`$CODEX_HOME/AGENTS.md` is loaded by Codex CLI 0.145.0 into **every** session,
including brigadier's own workers, and no flag suppresses it. Keep it doctrine.

### `opencode`

| File | Path |
| --- | --- |
| plugin | `~/.config/opencode/plugin/brigadier.js` |
| notes | `~/.config/opencode/brigadier.README.md` |

opencode reads `~/.claude/skills` and `~/.agents/skills` natively, so installing
the Claude Code or Codex surface already gave it the doctrine. This plugin adds
the one thing a skill cannot be: the handoff hook.

The plugin reacts to the bus events named in its `HANDOFF_EVENT_TYPES` array.
Those names are now verified against a running opencode 1.18.16. The exact names
and what each one means live next to the plugin, in
`surfaces/opencode/plugin/brigadier.js` and the README installed beside it, so
there is one place to read them rather than two that can disagree. If the hook
never fires on your build, that array is still the one line to change.

## The hosts that read no skill directory

Cursor, Windsurf, Antigravity and Claude Desktop read none of the skill
directories above. MCP is the only door brigadier has into them, so what
`brigadier install <host>` does for these four is merge a single `brigadier` key
into the host's own `mcpServers` object. **Every other byte of that file is
preserved** — the merge splices brigadier's own range into the existing text
rather than reserializing the document, so your formatting, key order and
comment-free whitespace survive. A file whose JSON does not parse, or whose top
level or `mcpServers` value is not an object, is **refused** with nothing
written and the reason named.

| Host | File | Entry written under `mcpServers.brigadier` |
| --- | --- | --- |
| `cursor` | `~/.cursor/mcp.json` | `{"type":"stdio","command":<command>,"args":["mcp"]}` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `{"command":<command>,"args":["mcp"]}` |
| `antigravity` | `~/.gemini/config/mcp_config.json` | `{"command":<command>,"args":["mcp"]}` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `{"command":<command>,"args":["mcp"]}` |

Each path and entry shape was read from that host's own documentation rather
than inferred from a sibling, and `brigadier install` **prints the citation it
used** so you can audit the path instead of trusting it:
[Cursor](https://cursor.com/docs/context/mcp),
[Windsurf](https://docs.devin.ai/desktop/cascade/mcp),
[Antigravity](https://antigravity.google/docs/mcp),
[Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

Two of those deserve a note. **Cursor alone gets `"type": "stdio"`**, because
Cursor alone documents that field as required for stdio servers while its own
examples omit it; writing it satisfies the table and contradicts nothing in the
examples. And **Antigravity's widely-cited path is wrong** — third-party guides
name `~/.gemini/antigravity/mcp_config.json`, but Antigravity's own
documentation puts only `mcp_oauth_tokens.json` there.

Windsurf's path is correct for Cascade today and is a shrinking surface:
Cognition folded Windsurf into Devin, and its documentation now describes Cascade
as the legacy agent while the Devin Local agent configures MCP through the Devin
CLI instead. Windsurf documents no project-scoped MCP file, so this global one is
the only option.

**There is no hook surface on any of these four.** Nothing watches the
transcript; the server is invoked only when the model chooses to invoke it. The
tool descriptions are therefore the entire doctrine those hosts will ever see,
which is why they carry when to delegate, that the work goes to brigadier rather
than inline, the plan shape, and the rule that a worker must never call back in.

### Registration into a GUI host needs an explicit yes

Every one of the four registrations is gated on `guiRegistrationConsent === true`
in your own brigadier config. **No consent, no byte.** Every other answer — a
missing config, an unparseable one, an unreadable one, and an explicit `false` —
counts as no.

That consent is recorded in exactly one place: the question *"Register
brigadier's MCP server with detected GUI hosts"*, asked once during an
**interactive** `brigadier init`, and only when at least one GUI host was
detected. Nothing else grants it. Not `brigadier init --yes`, not
`--print-config`, not the `postinstall` probe, not the lazy config that
`brigadier run` writes, and not `brigadier install --force`. This is the one
thing `brigadier init` is still genuinely for; the doctrine brigadier installs
into every host says the same, and tells an agent to hand the sentence to the
user rather than run `init` on their behalf.

A skipped registration says which of the two gates stopped it. The second gate is
a host whose configuration directory does not exist, which is skipped rather than
conjured — creating `~/.cursor/` on a machine with no Cursor leaves a stranger's
directory holding a file nothing will ever read.

### `BRIGADIER_MCP_COMMAND`

The registration has to name a command for the host to spawn, and **a
Finder-launched application does not inherit a login shell's `PATH`**. When
brigadier is running as its own compiled binary, `process.execPath` is an honest
absolute path and that is what gets written. Running from source under `bun`, or
as `node dist/cli.js`, there is no honest absolute path to offer, so the bare
name `brigadier` is written — and `install` prints a warning saying so, because
the failure mode is silent: the host cannot find the command, the server never
starts, nothing reports it, and the user blames their editor.

Set `BRIGADIER_MCP_COMMAND` to an absolute path and run `install` again to write
that instead. It overrides both defaults.

### `claude-desktop` also stages an `.mcpb` bundle

Desktop is the one GUI host with a second, older route. Alongside the MCP
registration above, `brigadier install claude-desktop` stages a bundle — and
**installs nothing into Desktop itself**, because Desktop installs a bundle by an
explicit user action and brigadier does not forge those.

| File | Path |
| --- | --- |
| bundle manifest | `~/.brigadier/surfaces/claude-desktop/manifest.json` |
| instructions | `~/.brigadier/surfaces/claude-desktop/README.md` |

The registration is the path that needs no build step; the bundle is there for
anyone who wants the packaged extension instead. To finish it, from a source
checkout: run `bun run build:mcp`, copy `dist/mcp/server.js` to
`server/brigadier-mcp.js` inside the staged directory — the path the manifest's
`entry_point` names — zip that directory with `manifest.json` at the archive
root, rename it `brigadier.mcpb`, and open it with Desktop. The build leaves no
generated JavaScript under `src/`. See [RELEASING.md](RELEASING.md).

**Quit Desktop completely and relaunch it** before a registered server appears;
it reads `claude_desktop_config.json` only at startup.

Desktop gets an MCP server rather than a skill because Desktop **Skills execute
server-side** and cannot invoke a local binary, while Desktop **MCP servers run
locally with your full privileges** and can spawn `claude -p`. That asymmetry is
the entire reason brigadier ships an MCP server at all.

The server is zero-dependency: it speaks JSON-RPC 2.0 over stdio against the MCP
spec directly, with no SDK. There is nothing to install inside the bundle.

## The doctrine

Three things are what brigadier installs into a host, and they are worth stating
here because they changed:

1. **You are not the worker.** The host agent plans the slices and invokes
   `brigadier run` itself, from inside its own session, then reviews what comes
   back. It does not hand the user a command to type.
2. **There is no setup step.** Configuration is automatic; `brigadier init` is
   never to be run to make a config appear. The single carve-out is recording GUI
   registration consent, which belongs to a human — an agent passes the sentence
   on rather than running the command.
3. **A brigadier worker must never invoke brigadier.** Re-entry spends the whole
   slice and lands nothing. This has actually happened, which is why it is
   guarded twice: by this prose, and by `BRIGADIER_WORKER=1`.

Not every surface carries all three at the same length, because they are not the
same kind of artifact:

| Surface | Carries |
| --- | --- |
| each installed `SKILL.md`, and `$CODEX_HOME/AGENTS.md` | all three, at length, with the reasoning |
| the `brigadier_run` MCP tool description | all three, compressed to a clause each. It is the only place a GUI host can ever learn any of them, so none may be left out |
| the `brigadier_validate_plan` and `brigadier_route_plan` descriptions | neither delegation nor setup nor re-entry: they say what the tool does and that it is worth calling before `brigadier_run`. `brigadier_run` is where a model that is about to start work is standing |

The three MCP strings are pinned byte-for-byte in `test/mcp.test.ts`, and
`test/surfaces.test.ts` holds the staged `.mcpb` manifest to exactly the same
bytes, so the two cannot drift apart.

## The nudge hook

**Claude Code only.** The skill's own description fires only when the host model
happens to notice it, which is the wrong thing to depend on at the moment a
multi-part task arrives. `nudge.mjs` runs on `UserPromptSubmit` instead — on the
prompt itself — and, when it speaks at all, says one sentence: that this looks
like more than one independent piece of work, that the skill should be loaded and
the work written as a plan and run through `brigadier run`, and that a worker
already running a slice should ignore it. The same sentence is returned twice, as
`systemMessage` so you see it and as `additionalContext` so the model does.

**Restraint is the design constraint, not coverage.** A hook that speaks every
turn gets uninstalled within a day, and an uninstalled hook nudges nobody. So it
is silent:

- for **any question**, however it is formatted — a trailing `?`, a question mark
  before the first sentence ends, or an opening interrogative word **whether or
  not the prompt is punctuated at all**. A bug report that opens "why is this
  failing?" and then lists three symptoms is three bullets about **one** thing,
  so this refusal runs before the list is counted; and *"How do I refactor every
  module across the codebase and migrate all the call sites"* is somebody asking
  how to do the work, not assigning it, even though it carries every word the
  matcher fires on;
- for anything **under 120 characters**, because below that a prompt is a request
  rather than a plan;
- for material **inside fenced blocks**, terminated or not. A pasted config or
  diff is something you are showing, not assigning, so every fence is stripped
  before a bullet or a keyword is read;
- **for the rest of the session once it has spoken** — at most one nudge per
  session, ever;
- when **`BRIGADIER_NUDGE=off`** is set, which silences it entirely;
- when **`BRIGADIER_WORKER=1`** is set, checked before stdin is even read;
- and on every unrecognised, unparseable, or unbounded input, because silence is
  always a legal hook response.

What is left fires on one of three shapes: three or more enumerated list items; a
short list of two plus a breadth or scope word; or a structural verb
(`refactor`, `migrate`, `rename`, `rewrite`, `overhaul`, `backfill`, `scaffold`)
**and** a breadth word (`every`, `each`, `across`, `throughout`, `codebase`,
`call sites`, `multiple`, `several`, `all the`, `one by one`, `in parallel`)
**and** several targets actually named — two or more distinct files with
extensions, or a quantified plural such as "every module" or "all the call
sites". That last conjunct is what keeps ordinary English about one function out:
*"refactor `parseCsv` to handle multiple delimiters across quoted fields"* is one
function in one file and does not fire. Only the first 20,000 characters are
scanned, so a pasted log cannot cost a session its nudge. Fourteen matcher cases
are pinned byte-for-byte in the test suite, and ten of them are prompts that
must **not** fire.

Once-per-session is enforced by an exclusive create of a marker file under the
system temp directory, named by a SHA-256 of the host-supplied `session_id` — the
id is hashed rather than interpolated so it can never become a path segment. The
exclusive create **is** the lock, so two racing hooks cannot both speak. A session
with no id, and a marker that cannot be written, both answer silence rather than
risk a hook that speaks every turn.

**It is deliberately not registered on Codex.** Codex binds hook approval to the
registration — event, matcher, and command together — so adding a second event
would disarm the already-approved handoff until the user approved again. A nudge
is not worth silently switching off the handoff.

### Why a worker never hears it

A slice prompt is long, enumerated, and full of exactly the words this hook looks
for. A worker runs `claude -p`, which executes your `UserPromptSubmit` hooks — so
without a guard the hook would tell a worker to start a second orchestrator from
inside its own slice. `workerEnvironment` stamps `BRIGADIER_WORKER=1` at the
spawn, after the spec's own environment is spread, so a spec cannot override it
and an ancestor process cannot supply it into a genuine top-level session. The
hook reads it before it reads stdin. The doctrine paragraph in every installed
`SKILL.md` is the other half; belt and braces is deliberate.

## The handoff hook, honestly

The intended behaviour is a transcript-watching hook that fires a handoff when a
session is about to run out of context — the moment the host model is most
tempted to keep grinding rather than delegate. **It does not exist uniformly.**

| Host | Status |
| --- | --- |
| Claude Code | **Works.** `PreCompact` receives the transcript path and the hook can write a message back into the session |
| opencode | **Event names verified.** The plugin subscribes to the session event bus against event names verified on a running opencode 1.18.16 |
| Codex | **Registered, then trust-gated.** `brigadier install codex` writes the `PreCompact` registration, but hooks run only after you click to trust it, and until then it is a silent no-op. Approval binds to the registration, not to the script's contents, so an approved script can change later without another click. This is not seamless and is not presented as such |
| Claude Desktop | **Impossible.** Desktop exposes no hook surface at all, and an MCP server is called by the model, never by the transcript. There is no workaround |
| Cursor, Windsurf, Antigravity | **Impossible.** None exposes a hook surface either. The MCP tool descriptions are the only doctrine they get, and they are read only when the model reaches for a tool |

## Using brigadier over MCP directly

`brigadier mcp` serves the same three tools over stdio to any MCP client, with no
bundle involved. It takes no runtime options; `-h`/`--help` prints usage. This is
the command the four GUI registrations above name in their `args`.

The two tools that read a config use the same lazy path `brigadier run` does, so
a tool call on an unconfigured machine configures it rather than demanding an
interactive step of a client with no keyboard. Diagnostics go to stderr; stdout
is JSON-RPC only. No worker CLI at all is still an error, and the tool says so
rather than pointing at a command that no longer needs running.

| Tool | Effect |
| --- | --- |
| `brigadier_validate_plan` | Pure. Shape defects, scheduling defects, and the dependency waves a plan would run in |
| `brigadier_route_plan` | Reads this machine's config. Reports the vendor, model and effort each slice would get, or why nothing can take it. Creates no worktree, spawns no worker |
| `brigadier_run` | The real thing: worktrees, workers, commits, one integration branch |

`brigadier_run` takes a `repositoryPath` plus the same `slug`, `maxWorkers`,
`dryRun` and `unsafeInPlace` options the CLI does. The path **must name exactly
one location by itself**, in the advertised schema and in the implementation
alike, and the rule is platform-aware: on POSIX, a path beginning with `/`,
exactly as before; on Windows, a path that also names its volume, either
drive-qualified like `C:\repo` or `C:/repo` or UNC like `\\server\share`. A
relative path is refused rather than resolved, and so is a leading `~`, which
nothing in the server expands. An MCP client gives nobody control over the
server process's working directory, so anything the server would have to resolve
against state of its own could silently target the wrong repository. That is also why the Windows
check does not use `node:path`'s `isAbsolute`: it answers **true** for `/repo`,
which — like `\repo` and `C:repo` — is drive-relative and resolves against a
current drive the caller cannot see, so all three are refused.

`brigadier_route_plan` routes against an empty quota snapshot, which the routing
pipeline reads as "unknown" and therefore as available — so a drained model is
not avoided there. It prints that caveat in its own output. A real run learns the
limit from the worker and escalates.
