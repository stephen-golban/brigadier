# Host surfaces

brigadier is one engine, installed into each host's doctrine slot. The host-side
artifact is deliberately tiny. Its entire message is *you are not the worker;
hand the work to `brigadier run`*. It is not a proxy, it does not wrap the model,
and it depends on no plugin runtime: brigadier spawns `claude` and `codex` as
plain subprocesses.

Every file under this directory is a template. `brigadier install <host>` copies
it into the host's configuration directory. `src/surfaces/templates.ts` carries a
byte-for-byte copy of each file so the compiled single-file binary can write them
without this directory being present on the user's machine, and
`test/surfaces.test.ts` fails the build if the two ever diverge — in either
direction, for any file.

## The four hosts

| Host | What is installed | Where |
| --- | --- | --- |
| Claude Code | a skill, auto-loading as a plugin | `~/.claude/skills/brigadier/` |
| Codex | a skill plus global `AGENTS.md` doctrine | `~/.agents/skills/brigadier/`, `$CODEX_HOME/AGENTS.md` |
| opencode | a plugin | `~/.config/opencode/plugin/brigadier.js` |
| Claude Desktop | an MCP server bundle, staged for manual install | `~/.brigadier/surfaces/claude-desktop/` |

`~/.claude/skills/` is read natively by opencode as well as by Claude Code, and
`~/.agents/skills/` is read by both Codex and opencode. Installing the Claude
Code surface therefore already gives opencode the doctrine; the opencode plugin
exists for the handoff hook, which a skill cannot provide.

## Claude Desktop is the odd one out, and it is not an oversight

Desktop *Skills* execute server-side. They cannot invoke a binary on your laptop,
so the skill surface is worthless there no matter how it is worded. Desktop *MCP
servers* run locally with full user privileges and can spawn `claude -p`. That
asymmetry is the whole reason brigadier ships an MCP server at all
(`src/mcp/server.ts`), and the reason Desktop gets a bundle instead of a skill.

## The handoff hook, honestly

Design decision #10 asks for a transcript-watching hook that fires a handoff when
a session is about to run out of context — the moment the host model is most
tempted to keep grinding rather than delegate. It does not exist uniformly:

- **Claude Code — works.** `PreCompact` receives the transcript path and the hook
  can write a message back into the session. See `claude-code/hooks/`.
- **opencode — works.** The plugin subscribes to the session event bus. See
  `opencode/plugin/brigadier.js`.
- **Codex — trust-gated.** Hooks run only after you click to trust the hook
  definition, and the definition is hashed, so the click is required again after
  every edit to the script. This is not seamless and is not presented as such.
  See `codex/hooks/`.
- **Claude Desktop — impossible.** Desktop exposes no hook surface at all. The
  MCP server is the only local seam it has, and an MCP server is called by the
  model, never by the transcript. There is nothing to install and no workaround.
