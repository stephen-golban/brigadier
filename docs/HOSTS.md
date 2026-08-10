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

`~/.agents/skills` is read by both Codex and opencode, so this one skill serves
both.

brigadier does **not** write a Codex hook registration. The configuration key
differs across Codex releases, and a guessed one is a silent no-op. Register the
hook yourself against the installed `handoff.mjs`; the README next to it explains
how.

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
Those names were **not** verified against a running opencode. If the hook never
fires, that array is the one line to change.

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
| opencode | **Event binding unverified.** The plugin subscribes to the session event bus, but its event names have not been verified on a running opencode |
| Codex | **Trust-gated.** Hooks run only after you click to trust the hook definition, and the definition is hashed — so the click is required again after every edit to the script. This is not seamless and is not presented as such |
| Claude Desktop | **Impossible.** Desktop exposes no hook surface at all, and an MCP server is called by the model, never by the transcript. There is no workaround |

## Using brigadier over MCP directly

`brigadier mcp` serves the same three tools over stdio to any MCP client, with no
bundle involved. It takes no runtime options; `-h`/`--help` prints usage.

| Tool | Effect |
| --- | --- |
| `brigadier_validate_plan` | Pure. Shape defects, scheduling defects, and the dependency waves a plan would run in |
| `brigadier_route_plan` | Reads this machine's config. Reports the vendor, model and effort each slice would get, or why nothing can take it. Creates no worktree, spawns no worker |
| `brigadier_run` | The real thing: worktrees, workers, commits, one integration branch |

`brigadier_run` takes a non-empty `repositoryPath` plus the same `slug`,
`maxWorkers`, `dryRun` and `unsafeInPlace` options the CLI does. Its schema calls
the path absolute, but the current implementation enforces only that it is a
non-empty string. Clients should pass an absolute path to avoid making the MCP
server's working directory part of the request.

`brigadier_route_plan` routes against an empty quota snapshot, which the routing
pipeline reads as "unknown" and therefore as available — so a drained model is
not avoided there. It prints that caveat in its own output. A real run learns the
limit from the worker and escalates.
