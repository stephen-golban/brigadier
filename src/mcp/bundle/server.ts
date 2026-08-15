/**
 * The program behind `dist/mcp/server.js` — the file Claude Desktop launches.
 *
 * WHY THIS IS A SEPARATE FILE FROM `../server.ts`. The Desktop manifest runs
 * `node ${__dirname}/server/brigadier-mcp.js`, and that file is a byte-for-byte
 * copy of `dist/mcp/server.js`. A PURE MODULE at that path loads, exports, and
 * exits 0 without answering a single request, which is precisely what Desktop
 * got for as long as the only thing that ever STARTED the server was a separate
 * `bin/` shim that imported the bundle. The shim is gone, so the start lives
 * here and is built straight to the path the manifest, the surface README, and
 * `brigadier install claude-desktop` all already name.
 *
 * IT IS NOT A GUARD INSIDE `../server.ts` because that module is imported by the
 * test suite, by `dist/`, and by the compiled binary's `mcp` subcommand. Any
 * guard of the `process.argv[1] === import.meta.url` family has to be false in
 * every one of those and true here, and inside a `--compile`d binary both sides
 * of that comparison are whatever the bundler decided they are — one quirk away
 * from `brigadier init` silently becoming an MCP server eating its own stdin.
 * Nothing imports THIS module, so nothing can start it by accident.
 *
 * STDOUT IS THE PROTOCOL. See `../server.ts`; nothing here may write to it.
 */

import { runMcpServer } from "../server.js";

// The code the server resolves to: 0 when the client closed the pipe, which for
// a stdio server is an ordinary shutdown, and the interrupt code when a signal
// cut the session short. Set rather than passed to `process.exit`, so a stdout
// write still in flight is flushed before the process goes.
process.exitCode = await runMcpServer();
