# @durable-streams/state

## 0.2.0

### Minor Changes

- **BREAKING**: Make `@tanstack/db` a peer dependency instead of a regular dependency. ([#187](https://github.com/durable-streams/durable-streams/pull/187))

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

### Patch Changes

- Updated dependencies [[`447e102`](https://github.com/durable-streams/durable-streams/commit/447e10235a1732ec24e1d906487d6b2750a16063), [`095944a`](https://github.com/durable-streams/durable-streams/commit/095944a5fefdef0cbc87eef532c871cdd46ee7d8), [`e47081e`](https://github.com/durable-streams/durable-streams/commit/e47081e553e1e98466bca25faf929ac346816e6b)]:
  - @durable-streams/client@0.2.0

## 0.1.5

### Patch Changes

- Updated dependencies [[`a5ce923`](https://github.com/durable-streams/durable-streams/commit/a5ce923bf849bdde47a651be8200b560053f4997)]:
  - @durable-streams/client@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [[`67b5a4d`](https://github.com/durable-streams/durable-streams/commit/67b5a4dcaae69dbe651dc6ede3cac72d3390567f)]:
  - @durable-streams/client@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [[`8d06625`](https://github.com/durable-streams/durable-streams/commit/8d06625eba26d79b7c5d317adf89047f6b44c8ce), [`8f500cf`](https://github.com/durable-streams/durable-streams/commit/8f500cf720e59ada83188ed67f244a40c4b04422)]:
  - @durable-streams/client@0.1.3

## 0.1.2

### Patch Changes

- Standardize package.json exports across all packages ([`bf9bc19`](https://github.com/durable-streams/durable-streams/commit/bf9bc19ef13eb22b2c0f98a175fad02b221d7860))
  - Add dual ESM/CJS exports to all packages
  - Fix export order to have "." first, then "./package.json"
  - Add proper main/module/types fields
  - Add sideEffects: false
  - Remove duplicate fields

- Updated dependencies [[`bf9bc19`](https://github.com/durable-streams/durable-streams/commit/bf9bc19ef13eb22b2c0f98a175fad02b221d7860)]:
  - @durable-streams/client@0.1.2

## 0.1.1

### Patch Changes

- new version to fix local manual release ([#97](https://github.com/durable-streams/durable-streams/pull/97))

- Updated dependencies [[`1873789`](https://github.com/durable-streams/durable-streams/commit/187378923ed743255ba741252b1617b13cbbab16)]:
  - @durable-streams/client@0.1.1
