# The handoff hook on Codex

**Status: trust-gated. It is a click, and the click comes back.**

Codex will not run a hook it has not been told to trust. Approving one is a
manual, interactive click. The hook *definition is hashed*, so the approval is
bound to the exact bytes of what you approved: edit `handoff.mjs` by one
character and Codex asks again. That is a deliberate safety property of Codex and
brigadier neither works around it nor pretends it is not there. If you want the
handoff hook on Codex, you are signing up for a click now and another click after
every upgrade of brigadier that touches this file.

On Claude Code the same hook installs with no click at all. That asymmetry is
real, and it is the reason this file exists rather than a line in a table.

## The contract `handoff.mjs` implements

```
in    one JSON object on stdin, optionally carrying `transcript_path`
out   one JSON object on stdout: {"systemMessage": "<one sentence>"}
exit  always 0
```

This file is byte-for-byte identical to
`surfaces/claude-code/hooks/handoff.mjs`, and a test enforces that. The payload
shape above is Claude Code's. If your Codex version wants a different response
shape, the change is the one `JSON.stringify` call at the top of `main`.

## Registering it — the part brigadier does not do for you

`brigadier install codex` copies this script to
`~/.agents/skills/brigadier/hooks/handoff.mjs` and stops there. **It does not
write a Codex hook registration, on purpose.** The configuration key and the
event name differ across Codex releases, and brigadier's Codex support is pinned
to CLI 0.145.0 for the *worker* protocol only — the hook surface was not verified
against a running Codex. Writing a guessed key into your `config.toml` would be a
silent no-op at best.

Take the event name and the registration syntax from the hook documentation for
the Codex version you have installed, point it at the path above, and click
through the trust prompt. If your Codex has no hook surface, you have the skill
and `AGENTS.md`, which carry the same doctrine without the handoff trigger.
