# @durable-streams/client-conformance-tests

## 0.1.7

### Patch Changes

- Add Kafka-style idempotent producers for exactly-once write semantics. ([#140](https://github.com/durable-streams/durable-streams/pull/140))

  **Server:**
  - Producer state tracking with `Producer-Id`, `Producer-Epoch`, `Producer-Seq` headers
  - Duplicate detection returns 204 (idempotent success)
  - Zombie fencing via epoch validation (403 on stale epoch)
  - Sequence gap detection (409 with expected/received seq)
  - Per-producer serialization for concurrent request handling

  **Client:**
  - New `IdempotentProducer` class with batching and pipelining
  - Fire-and-forget API with automatic deduplication
  - Configurable `maxBatchBytes`, `lingerMs`, `maxInFlight`
  - Auto-claim flow for ephemeral producers
  - `StaleEpochError` and `SequenceGapError` for error handling

  **Protocol:**
  - New section 5.2.1 documenting idempotent producer semantics

- Updated dependencies [[`67b5a4d`](https://github.com/durable-streams/durable-streams/commit/67b5a4dcaae69dbe651dc6ede3cac72d3390567f)]:
  - @durable-streams/server@0.1.5
  - @durable-streams/client@0.1.4

## 0.1.6

### Patch Changes

- Add advanced fault injection and conformance tests ([#119](https://github.com/durable-streams/durable-streams/pull/119))

  Server fault injection improvements:
  - Extended fault injection with new capabilities: delayMs, dropConnection, truncateBodyBytes, probability, method filtering, corruptBody, and jitterMs
  - Updated /\_test/inject-error endpoint to accept all new fault parameters
  - Added body modification support for response truncation and corruption

  New server conformance tests:
  - Concurrent writer stress tests (seq conflicts, racing writers, mixed readers/writers)
  - State hash verification tests (replay consistency, deterministic ordering)

  New client conformance tests:
  - 8 fault injection test cases covering delay recovery, connection drops, method-specific faults, and retry scenarios

- Updated dependencies [[`615ea5f`](https://github.com/durable-streams/durable-streams/commit/615ea5f64002a711598f9ee9f7461484fa8c74c0), [`0252af8`](https://github.com/durable-streams/durable-streams/commit/0252af86362569f875c7866c41b57b1201ecb94c), [`411512c`](https://github.com/durable-streams/durable-streams/commit/411512ce910f31958957bf4fda08b8fb45ce31b9), [`8d06625`](https://github.com/durable-streams/durable-streams/commit/8d06625eba26d79b7c5d317adf89047f6b44c8ce), [`8f500cf`](https://github.com/durable-streams/durable-streams/commit/8f500cf720e59ada83188ed67f244a40c4b04422)]:
  - @durable-streams/server@0.1.4
  - @durable-streams/client@0.1.3

## 0.1.5

### Patch Changes

- Add conformance tests for Unicode line separator preservation in SSE parsing. Per the HTML Living Standard, SSE parsers must only split on CRLF, LF, or CR. Other Unicode line separators (U+0085 NEL, U+2028 Line Separator, U+2029 Paragraph Separator) must be preserved as data characters. ([#118](https://github.com/durable-streams/durable-streams/pull/118))

- Updated dependencies []:
  - @durable-streams/server@0.1.3

## 0.1.4

### Patch Changes

- Fix npx executable discovery for all CLI packages. When running `npx @durable-streams/<package>`, npm now correctly finds the executable. Also fixes vitest binary path resolution in server-conformance-tests for scoped packages installed via npx. ([#103](https://github.com/durable-streams/durable-streams/pull/103))

- Updated dependencies []:
  - @durable-streams/server@0.1.3

## 0.1.3

### Patch Changes

- Updated dependencies [[`c17d571`](https://github.com/durable-streams/durable-streams/commit/c17d571d8ad5bbc17466cda15bbd3c8979353781)]:
  - @durable-streams/server@0.1.3
  - @durable-streams/client@0.1.2

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
  - @durable-streams/server@0.1.2

## 0.1.1

### Patch Changes

- new version to fix local manual release ([#97](https://github.com/durable-streams/durable-streams/pull/97))

- Updated dependencies [[`1873789`](https://github.com/durable-streams/durable-streams/commit/187378923ed743255ba741252b1617b13cbbab16)]:
  - @durable-streams/client@0.1.1
  - @durable-streams/server@0.1.1
