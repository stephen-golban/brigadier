# The handoff hook on Codex

**Status: registered by brigadier, then trust-gated by Codex.**

`brigadier install codex` registers the hook, but registration is not approval.
Codex will not run a hook it has not been told to trust. Approving one is a
manual, interactive click in Codex. The hook *definition is hashed*, so approval
is bound to the exact definition you approved: edit `handoff.mjs` by one
character and Codex requires approval again. That is a deliberate safety
property of Codex. brigadier neither works around it nor pretends the hook is
live immediately after installation.

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

`PreCompact` is the Codex event fired before compaction. The command path is
absolute and shell-quoted. `# brigadier-managed-hook` is the stable ownership
marker: another install replaces or deduplicates only command hooks carrying
that marker. All other events, entries, and unknown keys in the shared file are
preserved. Malformed JSON is refused and left byte-for-byte unchanged.

## Approval is still required

Start an interactive Codex session and approve the hook when Codex presents its
hook-trust prompt. Until that approval is persisted, the hook is a silent no-op:
Codex still exits 0, with no warning and no hook output. Because approval is
bound to a hash of the hook definition, approve it again after any edit to
`handoff.mjs`.

For vetted automation only, `codex exec --dangerously-bypass-hook-trust` runs
enabled hooks for that invocation without persisted trust. The name is
accurate: it bypasses the trust check for every enabled hook in that invocation,
not only brigadier's. Use it only when the automation has already vetted every
hook source. It does not persist approval.
