# brigadier

`brigadier` is a public CLI for orchestrating AI coding workers.

This repository currently contains the shared TypeScript contracts and the
fixture-driven subprocess test harness. Worker adapters and orchestration logic
are intentionally out of scope.

## Development

```sh
bun install
bun test
bun run typecheck
bun run check
bun run build
```

The build emits a signed native `./brigadier` executable and a Node-compatible
`dist/cli.js` fallback. The published launcher prefers an optional native
package for the current platform and uses the JavaScript fallback otherwise.
