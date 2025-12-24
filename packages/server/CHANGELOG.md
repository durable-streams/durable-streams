# @durable-streams/server

## 0.1.3

### Patch Changes

- Add TTL expiration conformance tests and implement expiration in stores ([#101](https://github.com/durable-streams/durable-streams/pull/101))
  - Add 7 new conformance tests verifying streams return 404 after TTL/Expires-At passes
  - Add "recreate after expiry" test ensuring expired streams don't block new stream creation
  - Add 4 new TTL format validation tests (leading zeros, plus sign, decimal, scientific notation)
  - Implement expiration checking in both in-memory and file-backed stores
  - Fix: expired streams no longer block PUT to recreate at same path
  - Fix: malformed Expires-At dates now treated as expired (fail closed)

- Updated dependencies []:
  - @durable-streams/client@0.1.2
  - @durable-streams/state@0.1.2

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
  - @durable-streams/state@0.1.2

## 0.1.1

### Patch Changes

- new version to fix local manual release ([#97](https://github.com/durable-streams/durable-streams/pull/97))

- Updated dependencies [[`1873789`](https://github.com/durable-streams/durable-streams/commit/187378923ed743255ba741252b1617b13cbbab16)]:
  - @durable-streams/client@0.1.1
  - @durable-streams/state@0.1.1
