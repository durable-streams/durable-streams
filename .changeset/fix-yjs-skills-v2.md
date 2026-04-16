---
"@durable-streams/y-durable-streams": patch
---

docs(yjs): inline example snippets, remove broken examples/ refs

- `yjs-editors`: add an inlined "Sharing doc/awareness via Context" section
  showing the full `YjsRoomProvider` pattern (provider with `connect: false`,
  listeners before connect, `status` + `synced` + `error` events, Strict
  Mode-safe awareness re-seeding via ref, merge-not-overwrite `setUsername`).
  Previously this pattern pointed at `examples/yjs-demo/...` which doesn't
  ship in the npm package.
- `yjs-server`: add an inlined "Single-origin dev server" section showing
  how to spawn Caddy alongside `YjsServer` and the matching dev Caddyfile
  (DS route, Yjs route with `flush_interval -1`, Vite reverse proxy). Drops
  prose "Source: examples/yjs-demo/Caddyfile" pointers.
