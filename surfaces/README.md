# Host surfaces

brigadier is one engine, installed into each host's doctrine slot. The host-side
artifact is deliberately tiny. Its entire message is *you are not the worker;
hand the work to `brigadier run`*. It is not a proxy, it does not wrap the model,
and it depends on no plugin runtime: brigadier spawns `claude` and `codex` as
plain subprocesses.

This README is review-only and is never installed. Every other file under
this directory is an installable template. `brigadier install <host>` copies
those files into the host's configuration directory.
`src/surfaces/templates.ts` carries a byte-for-byte copy of each installable file
so the compiled single-file binary can write them without this directory being
present on the user's machine, and `test/surfaces.test.ts` fails the build if the
two ever diverge — in either direction, for any installable file.

## The seven hosts, in two groups

The split is not cosmetic. Claude Code, Codex, and opencode read skill
directories off disk, so the doctrine can be a file. **Cursor, Windsurf,
Antigravity, and Claude Desktop read none of them.** For those four, MCP is the
only door into the session, and the MCP tool descriptions are the doctrine.

| Host | What is installed | Where |
| --- | --- | --- |
| Claude Code | a skill, auto-loading as a plugin, with two hooks | `~/.claude/skills/brigadier/` |
| Codex | a skill, global `AGENTS.md` doctrine, and a handoff hook registration | `~/.agents/skills/brigadier/`, `$CODEX_HOME/AGENTS.md`, `$CODEX_HOME/hooks.json` |
| opencode | a plugin | `~/.config/opencode/plugin/brigadier.js` |
| Cursor | an MCP server registration | `~/.cursor/mcp.json` |
| Windsurf | an MCP server registration | `~/.codeium/windsurf/mcp_config.json` |
| Antigravity | an MCP server registration | `~/.gemini/config/mcp_config.json` |
| Claude Desktop | an MCP server registration, plus a staged `.mcpb` bundle | `~/Library/Application Support/Claude/claude_desktop_config.json`, `~/.brigadier/surfaces/claude-desktop/` |

`~/.claude/skills/` is read natively by opencode as well as by Claude Code, and
`~/.agents/skills/` is read by both Codex and opencode. Installing the Claude
Code surface therefore already gives opencode the doctrine; the opencode plugin
exists for the handoff hook, which a skill cannot provide.

## Registering into somebody else's application takes a yes

Every registration in the four MCP rows above is gated on
`guiRegistrationConsent` in `~/.brigadier/config.json`, which only interactive
`brigadier init` sets. Without an explicit yes, `brigadier install` names each
registration it did not write and says how to enable it, and writes nothing into
any of those applications. A host whose configuration directory does not exist is
skipped as well: brigadier does not create another product's config directory to
put a file in it.

Each path was read from that host's own documentation:
[Cursor](https://cursor.com/docs/context/mcp),
[Windsurf](https://docs.devin.ai/desktop/cascade/mcp),
[Antigravity](https://antigravity.google/docs/mcp),
[Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers).
All four nest servers under a top-level `mcpServers` object; only Cursor
documents a required `"type": "stdio"`.

## Claude Desktop still gets a bundle as well, and it is not an oversight

Desktop *Skills* execute server-side. They cannot invoke a binary on your laptop,
so the skill surface is worthless there no matter how it is worded. Desktop *MCP
servers* run locally with full user privileges and can spawn `claude -p`. That
asymmetry is the whole reason brigadier ships an MCP server at all
(`src/mcp/server.ts`). The registration in `claude_desktop_config.json` is the
path that works today with no build step; the staged `.mcpb` bundle remains for
anyone who wants the packaged extension instead.

## The handoff hook, honestly

Brigadier wants a transcript-watching hook that fires a handoff when
a session is about to run out of context — the moment the host model is most
tempted to keep grinding rather than delegate. It does not exist uniformly:

- **Claude Code — works.** `PreCompact` receives the transcript path and the hook
  can write a message back into the session. A second hook, `UserPromptSubmit`,
  nudges once per session when a prompt describes multi-part work. See
  `claude-code/hooks/`.
- **opencode — event binding verified, with limits.** The plugin's event names
  were verified against opencode 1.18.16, but no live compaction was triggered,
  only that version was tested, and its event vocabulary is version-dependent.
  See `opencode/plugin/brigadier.js` and `opencode/README.md`.
- **Codex — registered, then trust-gated.** `brigadier install codex` merges a
  `PreCompact` registration into `$CODEX_HOME/hooks.json`, but Codex runs it only
  after you approve the registration. Approval is bound to the registration, not
  to the contents of `handoff.mjs`, so editing the script does not prompt again.
  The nudge is deliberately not registered there, because adding an event would
  disarm the approved handoff. See `codex/hooks/`.
- **Claude Desktop, Cursor, Windsurf, Antigravity — impossible.** None exposes a
  hook surface at all. The MCP server is the only local seam they have, and an
  MCP server is called by the model, never by the transcript. There is nothing to
  install and no workaround.
