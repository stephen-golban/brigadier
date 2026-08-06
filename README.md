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

