# The opencode surface

**Status: plugin installs; handoff event names are unverified.**

opencode reads `~/.claude/skills/` natively — the same directory Claude Code
reads — and also reads `~/.agents/skills/`. So the doctrine is already installed
on an opencode machine the moment you run either of:

```sh
brigadier install claude-code   # writes ~/.claude/skills/brigadier/
brigadier install codex         # writes ~/.agents/skills/brigadier/
```

`brigadier install opencode` adds the one thing a skill cannot be: a plugin that
watches the session and fires the handoff when it runs out of context. It writes
`plugin/brigadier.js` to `~/.config/opencode/plugin/brigadier.js` and nothing
else.

## The unverified line, stated plainly

`plugin/brigadier.js` reacts to the bus events named in `HANDOFF_EVENT_TYPES`,
currently `session.compacted` and `session.compacting`. **Those two names were
not verified against a running opencode.** What was verified about opencode is
narrower and is about the doctrine rather than the bus: `~/.claude/skills/` and
`~/.agents/skills/` are both read natively.

If the hook never fires on your machine, the event is named something else in
your build. Read the real name off opencode's debug log and change that one
array. Everything below it — the sentence, the turn count, the toast — is
independent of the name.

## What the plugin does when it fires

Writes one line to stderr, then attempts a toast through `client.tui.showToast`
if that API exists. The stderr line is the guarantee; the toast is a courtesy and
its failure is swallowed. The plugin never throws: a plugin that throws takes the
session's event loop with it, and a doctrine reminder is not worth anybody's
session.
