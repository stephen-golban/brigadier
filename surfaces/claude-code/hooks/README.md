# The hooks on Claude Code

**Status: both work, with no click and no trust prompt.**

`hooks.json` registers two commands, and `${CLAUDE_PLUGIN_ROOT}` is expanded by
Claude Code to the installed skill directory, so both registrations survive being
installed anywhere.

| Script | Event | Fires when |
| --- | --- | --- |
| `handoff.mjs` | `PreCompact` | the session is about to compact |
| `nudge.mjs` | `UserPromptSubmit` | a prompt describes more than one piece of work |

## The handoff hook

`PreCompact` fires when the session is about to compact — which is to say, when
it has run out of context. That is the exact moment the doctrine is most needed
and least likely to be followed, so it is where the hook lives. The event carries
`transcript_path`, which is what makes the hook *transcript-watching* rather than
merely periodic: it reports how many assistant turns were spent before the
handoff.

## The nudge hook

The skill's own description only fires when the model happens to notice it, which
is the wrong thing to depend on at the moment a multi-part task arrives.
`UserPromptSubmit` fires on the prompt itself. `UserPromptSubmit` takes no
matcher on this host, so the registration carries none.

**Restraint is the design constraint, not coverage.** A hook that speaks every
turn gets uninstalled within a day, and an uninstalled hook nudges nobody. So
`nudge.mjs` is silent for an ordinary prompt, silent for anything under 120
characters, and silent for the rest of the session once it has spoken.

Two refusals come before anything is counted. **A question is never enough**,
however many bullets of symptoms follow it — an opening question with three
bulleted symptoms is one bug report, not three pieces of work. **A fenced block
is quoted material**, so every fence is removed before a bullet or a keyword is
read; a pasted config that happens to list three steps is the user showing you
something, not assigning it.

What is left fires on one of three shapes: three or more enumerated items; two
enumerated items plus a breadth or scope word; or a structural verb (`refactor`,
`migrate`, `rename`, `rewrite`, `overhaul`, `backfill`, `scaffold`) together with
a breadth word (`every`, `each`, `across`, `throughout`, `codebase`,
`call sites`, `multiple`, `several`, `all the`, `one by one`, `in parallel`)
**and** several targets actually named — two or more files with extensions, or a
quantified plural such as "every module" or "all the call sites". That last
conjunct is the difference between work with independent pieces and ordinary
English about one function: "refactor `parseCsv` to handle multiple delimiters
across quoted fields" is one function in one file and does not fire. It would
rather miss a multi-part task than become noise.

Once per session is enforced by an exclusive create of a marker file under the
system temp directory, named by a hash of `session_id`. The exclusive create is
the lock, so two racing hooks cannot both speak. A session with no id, and a
marker that cannot be written, both mean silence rather than a hook that might
speak every turn. `BRIGADIER_NUDGE=off` silences it entirely, and so does
`BRIGADIER_WORKER=1`, which brigadier stamps into every worker's environment: a
slice prompt is long and full of exactly these words, and a worker must never be
told to run brigadier. That check is read before stdin is.

## The contract both scripts implement

```
in    one JSON object on stdin
out   one JSON object on stdout, or nothing at all
exit  always 0
```

`handoff.mjs` answers `{"systemMessage": "<one sentence>"}`. `nudge.mjs` answers
the same sentence under two keys: `systemMessage`, so the user sees that
brigadier spoke, and `additionalContext`, which is the field the model actually
reads. A nudge that only reached the human would not make the skill fire, which
is the whole job.

Nothing about that contract is Claude-Code-specific, which is why `handoff.mjs`
is shipped byte-for-byte under `surfaces/codex/hooks/` as well.

## What they deliberately do not do

- They do not block, veto, or rewrite anything. `UserPromptSubmit` can erase a
  prompt by exiting 2. Neither script ever exits non-zero, so neither can.
- They do not exit non-zero, ever. A hook that fails, fails inside somebody
  else's session.
- `handoff.mjs` does not walk a transcript larger than 8 MB, and neither script
  waits longer than 2 seconds for stdin to end. `nudge.mjs` scans at most the
  first 20,000 characters of a prompt. All three degrade to a weaker answer or to
  silence rather than to a stall.

## How other hosts differ

- **Codex** — `brigadier install codex` registers `handoff.mjs` against
  `PreCompact`, then Codex requires the user to approve it. The nudge is **not**
  registered there: Codex binds hook approval to the registration, so adding an
  event would silently disarm the approved handoff until the user approved again.
  See `surfaces/codex/hooks/README.md`.
- **Claude Desktop, Cursor, Windsurf, Antigravity** — impossible. None exposes a
  hook surface, and an MCP server is called by the model rather than by the
  transcript. Those hosts get the doctrine through MCP tool descriptions instead.
- **opencode** — provided instead by `surfaces/opencode/plugin/brigadier.js`,
  because opencode's seam is the plugin event bus rather than a hook process.
