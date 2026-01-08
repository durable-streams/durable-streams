# @durable-streams/server-conformance-tests

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

- Add browser security headers per Protocol Section 10.7: ([#113](https://github.com/durable-streams/durable-streams/pull/113))
  - `X-Content-Type-Options: nosniff` on all responses
  - `Cross-Origin-Resource-Policy: cross-origin` on all responses
  - `Cache-Control: no-store` on HEAD responses

  Includes conformance tests for security header presence on GET, PUT, POST, HEAD, SSE, long-poll, and error responses.

- Standardize HTTP status codes for protocol operations ([#106](https://github.com/durable-streams/durable-streams/pull/106))
  - Append (POST): Now mandates `204 No Content` (previously allowed 200 or 204)
  - Idempotent create (PUT): Now mandates `200 OK` (previously allowed 200 or 204)

  This removes ambiguity from the protocol. Clients should already accept these status codes.

- Add CRLF injection security tests for SSE and fix TypeScript client SSE parser to normalize line endings per SSE spec. ([#112](https://github.com/durable-streams/durable-streams/pull/112))
  - Server conformance tests now verify CRLF injection attacks in SSE payloads are properly escaped
  - TypeScript SSE parser now normalizes `\r\n` and lone `\r` to `\n` per SSE specification

- Updated dependencies [[`8d06625`](https://github.com/durable-streams/durable-streams/commit/8d06625eba26d79b7c5d317adf89047f6b44c8ce), [`8f500cf`](https://github.com/durable-streams/durable-streams/commit/8f500cf720e59ada83188ed67f244a40c4b04422)]:
  - @durable-streams/client@0.1.3

## 0.1.5

### Patch Changes

- Increase timeout for long poll tests and make timeout configurable ([#136](https://github.com/durable-streams/durable-streams/pull/136))

## 0.1.4

### Patch Changes

- Fix npx executable discovery for all CLI packages. When running `npx @durable-streams/<package>`, npm now correctly finds the executable. Also fixes vitest binary path resolution in server-conformance-tests for scoped packages installed via npx. ([#103](https://github.com/durable-streams/durable-streams/pull/103))

- Upgrade vitest from v3 to v4 for improved performance and compatibility with the latest testing features. ([#105](https://github.com/durable-streams/durable-streams/pull/105))

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
