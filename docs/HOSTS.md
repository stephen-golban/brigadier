# Host surfaces

brigadier is one engine. `brigadier install <host>` writes a small doctrine
artifact into a host's configuration slot, or stages Desktop's MCP bundle for
manual installation, so the host hands work *to* brigadier instead of doing it
itself. The doctrine's whole message is *you are not the worker*.

It is not a package manager, it installs no plugin runtime, and it depends on
none. The shipped product spawns `claude` and `codex` as plain subprocesses.

```sh
brigadier install claude-code
brigadier install codex opencode
brigadier install --all
brigadier install --all --dry-run
```

| Option | Effect |
| --- | --- |
| `--all` | install every host |
| `--dry-run` | report what would be written and write nothing |
| `--force` | replace a regular file brigadier did not write, or that was edited after it did |
| `-h`, `--help` | print usage |

Exit codes: `0` every file is in place, `1` at least one file was refused or
could not be written, `2` usage error.

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

The manifest governs the files brigadier writes whole. `$CODEX_HOME/hooks.json`
is the one file it shares with other tools, so it is merged instead, and its
protection is different: brigadier only ever touches the one entry carrying its
own `# brigadier-managed-hook` marker, leaves everything else in the file
untouched, and refuses the whole write if the JSON does not parse. It is not
recorded in the manifest, and `--force` has no bearing on it — if you edit
brigadier's own marked entry, the next install replaces it.

A destination symlink is always refused, even with `--force`. The installer
resolves the install root, refuses writes that escape it, and opens destination
files with `O_NOFOLLOW` so a symlink swap cannot redirect the write.

## Where each host's files land

Roots come from the environment: `$CLAUDE_CONFIG_DIR` (else `$HOME/.claude`),
`$CODEX_HOME` (else `$HOME/.codex`), `$XDG_CONFIG_HOME` (else
`$HOME/.config`), and `$BRIGADIER_HOME` (else `$HOME/.brigadier`). With `$HOME`
unset and not every override supplied, the command refuses rather than guessing
a home directory.

### `claude-code`

| File | Path |
| --- | --- |
| skill | `~/.claude/skills/brigadier/SKILL.md` |
| plugin marker | `~/.claude/skills/brigadier/.claude-plugin/plugin.json` |
| hook registration | `~/.claude/skills/brigadier/hooks/hooks.json` |
| handoff hook | `~/.claude/skills/brigadier/hooks/handoff.mjs` |
| hook notes | `~/.claude/skills/brigadier/hooks/README.md` |

The skill auto-loads as the plugin `brigadier@skills-dir` in your next Claude
Code session, because of the `.claude-plugin/plugin.json` beside it. No
marketplace, and no consent dialog. The handoff hook is registered against
`PreCompact` and needs no approval on this host.

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
trusted. Until you approve it, the hook is a silent no-op: Codex exits 0, with
no warning and no hook output. That approval is bound to the registration — the
event, matcher, and command — and not to the contents of `handoff.mjs`, so the
script at an approved path can later change without Codex asking again;
re-reviewing an edited script means deliberately changing the registration and
approving it again. The README installed beside `handoff.mjs` explains the
approval step.

The earlier claim that a user has no way to determine whether hook approval was
persisted was wrong. Measured on codex-cli 0.147.0, persisted trust is readable
non-interactively from `$CODEX_HOME/config.toml` under a `[hooks.state]` table:
an entry keyed as `<hooks file>:<snake_case event>:<group index>:<hook index>`
carries a `trusted_hash`. This directly answers whether approval was persisted,
and verifies the existing claim that approval binds to the registration rather
than to the script's contents: the recorded hash matches neither the hook script
nor the hooks file. The narrower observation remains true on codex-cli 0.147.0:
there is no dedicated hook diagnostic command—`codex doctor` output contains
the string `hook` zero times, and `codex --help` lists no `hooks` subcommand.
`codex --help` does
list `--dangerously-bypass-hook-trust`, which `surfaces/codex/hooks/README.md`
documents.

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

### `claude-desktop`

`brigadier install claude-desktop` **installs nothing into Desktop.** Desktop
installs a bundle by an explicit user action, and brigadier does not forge those.
It stages the bundle at `~/.brigadier/surfaces/claude-desktop/` and prints what
to do next.

| File | Path |
| --- | --- |
| bundle manifest | `~/.brigadier/surfaces/claude-desktop/manifest.json` |
| instructions | `~/.brigadier/surfaces/claude-desktop/README.md` |

To finish, from a source checkout: run `bun run build:mcp`, copy
`dist/mcp/server.js` to `server/brigadier-mcp.js` inside the staged directory —
the path the manifest's `entry_point` names — zip that directory with
`manifest.json` at the archive root, rename it `brigadier.mcpb`, and open it with
Desktop. The build leaves no generated JavaScript under `src/`. See
[RELEASING.md](RELEASING.md).

Desktop gets an MCP server rather than a skill because Desktop **Skills execute
server-side** and cannot invoke a local binary, while Desktop **MCP servers run
locally with your full privileges** and can spawn `claude -p`. That asymmetry is
the entire reason brigadier ships an MCP server at all.

The server is zero-dependency: it speaks JSON-RPC 2.0 over stdio against the MCP
spec directly, with no SDK. There is nothing to install inside the bundle.

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

## Using brigadier over MCP directly

`brigadier mcp` serves the same three tools over stdio to any MCP client, with no
bundle involved. It takes no runtime options; `-h`/`--help` prints usage.

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
