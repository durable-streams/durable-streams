---
"@durable-streams/state": minor
---

**BREAKING**: Make `@tanstack/db` a peer dependency instead of a regular dependency.

This fixes TypeScript type compatibility issues when using StreamDB collections with TanStack DB's query utilities like `useLiveQuery` from `@tanstack/react-db`.

**Migration**: Users must now install `@tanstack/db` alongside `@durable-streams/state`:

```bash
pnpm add @durable-streams/state @tanstack/db
```

**Why this change?**

The `Collection` class in `@tanstack/db` has private properties. TypeScript uses nominal typing for private properties, meaning when two packages bundle the same class, TypeScript treats them as distinct types. This caused type errors like:

```
Type 'Collection<...>' is not assignable to type 'CollectionImpl<...>'.
Types have separate declarations of a private property '_events'.
```

By making `@tanstack/db` a peer dependency, there's only one copy installed, and all packages reference the same module - making the types compatible.

**Convenience re-exports**: Key utilities from `@tanstack/db` are now re-exported for convenience:
- Types: `Collection`, `SyncConfig`
- Comparison operators: `eq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `inArray`
- Logical operators: `and`, `or`, `not`
- Null checking: `isNull`, `isUndefined`
- Aggregate functions: `count`, `sum`, `avg`, `min`, `max`
