---
"@durable-streams/state": minor
---

feat(state)!: move the TanStack DB-backed surface to a `@durable-streams/state/db` subpath

The main `@durable-streams/state` entry is now free of `@tanstack/db`. It exposes only the db-free protocol surface — `createStateSchema` and its change-event helpers, `MaterializedState`, and the state-event types/guards — so producers and backends (e.g. `@durable-streams/server`) can depend on it without the `@tanstack/db` peer dependency installed. Previously the entry eagerly re-exported `@tanstack/db`, so importing anything from the package forced that peer to be resolvable, breaking publishable dependents that don't use the reactive layer.

The reactive, TanStack DB-backed layer now lives at `@durable-streams/state/db`:

- `createStreamDB`, `getStreamDBCollectionId`, and the `StreamDB*` / `Action*` types
- the convenience re-exports of `@tanstack/db` (`createCollection`, `createOptimisticAction`, `eq`, `and`, `count`, …)

The subpath is a strict superset of the main entry (it also re-exports `createStateSchema`), so existing reactive consumers only change the import path:

```diff
-import { createStateSchema, createStreamDB } from "@durable-streams/state"
+import { createStateSchema, createStreamDB } from "@durable-streams/state/db"
```

BREAKING CHANGE: `createStreamDB`, `getStreamDBCollectionId`, the StreamDB/Action types, and the `@tanstack/db` re-exports are no longer exported from `@durable-streams/state`. Import them from `@durable-streams/state/db` instead. The db-free APIs (`createStateSchema`, `MaterializedState`, event types/guards) are unchanged on the main entry.
