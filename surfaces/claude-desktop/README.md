# The Claude Desktop surface

**Status: MCP server. No skill, and no handoff hook — neither is possible here.**

## Why Desktop gets a different artifact from every other host

Desktop **Skills execute server-side**. They run in Anthropic's infrastructure,
not on your laptop, so a skill cannot invoke `brigadier`, cannot see your
repository, and cannot spawn `claude -p`. Installing the doctrine as a Desktop
skill would produce a model that has been told to delegate and has nothing to
delegate to.

Desktop **MCP servers run locally, with your full user privileges**. They can
spawn `claude -p`, read your working tree, and start a real run. That asymmetry
is the entire reason brigadier ships an MCP server (`src/mcp/server.ts`), and the
reason Desktop is the one host where the tiny doctrine file is not the answer.

## The handoff hook does not exist here

The transcript-watching handoff works on Claude Code. On
opencode, its event names were verified only on 1.18.16, without triggering live
compaction, and remain version-dependent. On Codex, brigadier registers it and
Codex trust-gates the registration; approval remains valid if the script at that
path changes. On Desktop it is **impossible**, not merely unimplemented:
Desktop exposes no hook surface of any kind, and an MCP server is invoked by the
model when the model chooses to invoke it — never by the transcript, and never at
the moment the context fills. There is no workaround and none is offered.

## Installing: the registration, or the bundle

`brigadier install claude-desktop` does two things.

It merges a `brigadier` entry into Desktop's own MCP configuration at
`~/Library/Application Support/Claude/claude_desktop_config.json`, under the
top-level `mcpServers` key documented at
<https://modelcontextprotocol.io/docs/develop/connect-local-servers>. Every other
server in that file is preserved byte-for-byte; only brigadier's own key is
written. **This happens only if you consented once during `brigadier init`**, and
only if Desktop's configuration directory already exists. Quit Desktop
completely and relaunch it before the server appears. This is the path that
needs no build step.

It also stages this directory to `~/.brigadier/surfaces/claude-desktop/` and
prints what to do next, for anyone who wants the packaged `.mcpb` extension
instead. brigadier does not install that bundle: Desktop installs a bundle by an
explicit user action and brigadier does not forge those.

To produce the installable `.mcpb`:

1. `bun run build:mcp` — emits `dist/mcp/server.js`; it does not populate the
   staged bundle.
2. Copy that output into the staged directory as `server/brigadier-mcp.js`, the
   path named by `manifest.json`.
3. Zip the staged directory with `manifest.json` at the archive root and rename
   it `brigadier.mcpb`.
4. Open it with Claude Desktop, or drop it into Desktop's extensions pane.

The server is zero-dependency: it speaks JSON-RPC 2.0 over stdio against the MCP
spec directly, with no SDK. There is nothing to `npm install` inside the bundle.

## The tool surface

Three tools, and they are exactly what brigadier can do today — no more:

| Tool | Effect |
| --- | --- |
| `brigadier_validate_plan` | Pure. Shape defects, scheduling defects, and the dependency waves a plan would run in. |
| `brigadier_route_plan` | Reads this machine's config. Reports the vendor, model, and effort each slice would get, or why nothing can take it. Creates no worktree, spawns no worker. |
| `brigadier_run` | The real thing: worktrees, workers, commits, one integration branch. |

The `tools` array in `manifest.json` must name exactly these three;
`test/mcp.test.ts` fails if the manifest and the server ever disagree.
