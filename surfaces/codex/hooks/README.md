# The handoff hook on Codex

**Status: registered by brigadier, then trust-gated by Codex.**

`brigadier install codex` registers the hook, but registration is not approval.
Codex will not run a hook it has not been told to trust. Approving one is a
manual, interactive click in Codex. Approval is bound to the registration — the
event, matcher, and command configuration — not to the contents of
`handoff.mjs`. The script at that approved path can later change without Codex
asking again. To re-review an edited script, deliberately change the registration
and approve the new registration.

On Claude Code the same hook installs with no click at all. That asymmetry is
real, and it is the reason this file exists rather than a line in a table.

## The contract `handoff.mjs` implements

```
in    one JSON object on stdin, optionally carrying `transcript_path`
out   one JSON object on stdout: {"systemMessage": "<one sentence>"}
exit  always 0
```

This file is byte-for-byte identical to
`surfaces/claude-code/hooks/handoff.mjs`, and a test enforces that. Codex 0.145.0
sends `transcript_path` in the `PreCompact` payload, which is exactly what the
script reads.

## What brigadier registers

The installer copies the script to the absolute form of
`~/.agents/skills/brigadier/hooks/handoff.mjs`, then merges this entry into
`$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`):

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'<absolute path>/.agents/skills/brigadier/hooks/handoff.mjs' # brigadier-managed-hook"
          }
        ]
      }
    ]
  }
}
```

`PreCompact` is the only event brigadier registers here, and that is deliberate.
Claude Code also gets a `UserPromptSubmit` nudge; Codex does not, because Codex
binds approval to the registration — event, matcher, and command together — so
adding a second event would disarm the already-approved handoff until the user
approved the new registration. A nudge is not worth silently switching off the
handoff.

`PreCompact` is the Codex event fired before compaction. The command path is
absolute and shell-quoted. `# brigadier-managed-hook` is the stable ownership
marker, but an entry is brigadier-owned only when it has no keys other than a
`hooks` array containing exactly one `{ "type": "command", "command": "..." }`
hook whose command ends with that marker. A marked hook with siblings, a matcher,
or any other shape is foreign: brigadier preserves it and appends its own entry,
even if that leaves the marker visible twice. All other events, entries, and
unknown keys in the shared file are preserved. Malformed JSON is refused and
left byte-for-byte unchanged.

## Approval is still required

Start an interactive Codex session and approve the hook when Codex presents its
hook-trust prompt. Until that approval is persisted, the hook is a silent no-op:
Codex still exits 0, with no warning and no hook output. That persisted approval
remains valid when `handoff.mjs` changes. Only changing the registration itself —
the command string, event, or matcher — re-arms the prompt. To re-review an
edited script, deliberately change the registration and approve it again.

For vetted automation only, `codex exec --dangerously-bypass-hook-trust` runs
enabled hooks for that invocation without persisted trust. The name is
accurate: it bypasses the trust check for every enabled hook in that invocation,
not only brigadier's. Use it only when the automation has already vetted every
hook source. It does not persist approval.
