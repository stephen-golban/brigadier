# The opencode surface

**Status: plugin and event names verified on opencode 1.18.16; no live
compaction was triggered.**

opencode reads `~/.claude/skills/` natively — the same directory Claude Code
reads — and also reads `~/.agents/skills/`. So the doctrine is already installed
on an opencode machine the moment you run either of:

```sh
brigadier install claude-code   # writes ~/.claude/skills/brigadier/
brigadier install codex         # writes ~/.agents/skills/brigadier/
```

`brigadier install opencode` adds the one thing a skill cannot be: a plugin that
watches the session and reports automatic or manual compaction. It writes
`plugin/brigadier.js` to `~/.config/opencode/plugin/brigadier.js` and nothing
else.

## The verified line, stated precisely

`plugin/brigadier.js` reacts to the bus events named in `HANDOFF_EVENT_TYPES`,
currently `session.compacted` and `session.next.compaction.started`. On
2026-08-10, both names and their payload schemas were verified against a running
opencode 1.18.16 darwin-arm64 by fetching `GET /doc` and enumerating its 89-event
OpenAPI union. A probe plugin also verified that opencode loads this ESM factory,
calls its `event` handler with `{ event }`, and provides
`client.tui.showToast`.

No live compaction was triggered, so emission of these events during an actual
compaction was not observed. Only opencode 1.18.16 was tested, and its event
vocabulary is version-dependent. If a future build renames either event,
`HANDOFF_EVENT_TYPES` remains the one line to change.

## What the plugin does when it fires

For an automatic compaction start, it says the session is out of context. For a
manual compaction start, it says the compaction was requested. The completed
event has no reason, so its message only says the session was compacted. No
compaction event carries a turn count, and the plugin does not invent one.

The plugin writes one line to stderr, then attempts a toast through
`client.tui.showToast`. Both paths are contained so the handler never throws: a
plugin that throws takes the session's event loop with it, and a doctrine
reminder is not worth anybody's session.
