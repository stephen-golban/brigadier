# The handoff hook on Claude Code

**Status: works, with no click and no trust prompt.**

`PreCompact` fires when the session is about to compact — which is to say, when
it has run out of context. That is the exact moment the doctrine is most needed
and least likely to be followed, so it is where the hook lives. The event carries
`transcript_path`, which is what makes the hook *transcript-watching* rather than
merely periodic: it reports how many assistant turns were spent before the
handoff.

`hooks.json` registers `handoff.mjs` against `PreCompact` with matcher `*`.
`${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code to the installed skill
directory, so the registration survives being installed anywhere.

## The contract `handoff.mjs` implements

```
in    one JSON object on stdin, optionally carrying `transcript_path`
out   one JSON object on stdout: {"systemMessage": "<one sentence>"}
exit  always 0
```

Nothing about that contract is Claude-Code-specific, which is why the identical
file is shipped under `surfaces/codex/hooks/`. A host that wants a different
payload shape needs one line changed, not a rewrite.

## What it deliberately does not do

- It does not block, veto, or rewrite anything. It says one sentence.
- It does not exit non-zero, ever. A hook that fails, fails inside somebody
  else's session.
- It does not walk a transcript larger than 8 MB, and it does not wait longer
  than 2 seconds for stdin to end. Both degrade to the shorter message rather
  than to a stall.

## Where this hook does not exist

- **Codex** — trust-gated. See `surfaces/codex/hooks/README.md`.
- **Claude Desktop** — impossible. Desktop exposes no hook surface at all.
- **opencode** — provided instead by `surfaces/opencode/plugin/brigadier.js`,
  because opencode's seam is the plugin event bus rather than a hook process.
