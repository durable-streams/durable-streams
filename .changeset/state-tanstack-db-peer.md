---
"@durable-streams/state": minor
---

Move `@tanstack/db` from a regular dependency to a peer dependency (`>=0.6.0 <1.0.0`).

`@tanstack/db` is a singleton: collections, transactions, and live queries rely on `instanceof` checks and module-level shared state, so two copies in a dependency tree don't interoperate. Pinning it as a regular dependency (`^0.6.0`) meant that as soon as a consuming app upgraded `@tanstack/react-db` (which pins `@tanstack/db` at an exact version per release) past the `0.6` line, the app's copy and `state`'s copy diverged into two instances — breaking StreamDB collections at runtime.

Declaring it as a peer dependency makes `state` bind to the single `@tanstack/db` the consuming app already has, and the permissive range keeps that binding valid as the app moves across `0.x` minors.

**Breaking change:** consumers must now install `@tanstack/db` themselves (any `>=0.6.0 <1.0.0`). Apps already depending on `@tanstack/db` or `@tanstack/react-db` are unaffected.
