---
"@durable-streams/state": patch
---

Mark `@tanstack/db` as an optional peer dependency. The TanStack DB surface lives behind the `@durable-streams/state/db` subpath and the main entry is db-free, so consumers that don't use the reactive layer no longer get unmet-peer warnings (or errors under strict pnpm).
