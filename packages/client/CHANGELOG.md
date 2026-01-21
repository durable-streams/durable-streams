# @durable-streams/client

## 0.2.0

### Minor Changes

- **BREAKING**: `append()` now requires pre-serialized JSON strings instead of auto-stringifying objects. ([#193](https://github.com/durable-streams/durable-streams/pull/193))

  Before:

  ```typescript
  producer.append({ message: "hello" })
  ```

  After:

  ```typescript
  producer.append(JSON.stringify({ message: "hello" }))
  ```

  This aligns with how Kafka, SQS, and other streaming APIs work - they require pre-serialized data, giving users control over serialization. If you already have JSON from an API response, you can now pass it directly without parsing and re-stringifying.

  This change affects the TypeScript, Python, Go, PHP, .NET, Ruby, and Swift clients.

### Patch Changes

- Improve client API safety and flexibility: ([#178](https://github.com/durable-streams/durable-streams/pull/178))
  - Refactor `writable()` to use `IdempotentProducer` for streaming writes with exactly-once semantics and automatic batching. Errors during writes now cause `pipeTo()` to reject instead of being silently swallowed.
  - Make `StreamResponse.offset`, `cursor`, and `upToDate` readonly via getters to prevent external mutation of internal state.
  - Allow subscriber callbacks (`subscribeJson`, `subscribeBytes`, `subscribeText`) to be sync or async (`void | Promise<void>`).
  - Fix `warnOnHttp` not being called in standalone `stream()` function.

- Remove "auto" live mode from all clients in favor of explicit mode selection. TypeScript and Python now use `live: true` for auto-select behavior. Go, Rust, Swift, Java, PHP, and Ruby clients also updated. Fix Swift by removing stub flush/close methods from DurableStream. ([#177](https://github.com/durable-streams/durable-streams/pull/177))

## 0.1.5

### Patch Changes

- Add page visibility handling to pause/resume syncing when browser tab is hidden/visible ([#149](https://github.com/durable-streams/durable-streams/pull/149))
  - Pauses stream fetching when page becomes hidden to save battery and bandwidth
  - Resumes syncing when page becomes visible again
  - Uses a 3-state machine (active, pause-requested, paused) to prevent race conditions
  - Avoids long-poll hangs when resuming by skipping the live parameter on first request after resume
  - Properly cleans up visibility event listener when stream is cancelled

## 0.1.4

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

## 0.1.3

### Patch Changes

- Add console warning when using HTTP URLs in browser environments. HTTP limits browsers to 6 concurrent connections per host (HTTP/1.1), which can cause slow streams and app freezes. The warning can be disabled with `warnOnHttp: false`. ([#126](https://github.com/durable-streams/durable-streams/pull/126))

- Add CRLF injection security tests for SSE and fix TypeScript client SSE parser to normalize line endings per SSE spec. ([#112](https://github.com/durable-streams/durable-streams/pull/112))
  - Server conformance tests now verify CRLF injection attacks in SSE payloads are properly escaped
  - TypeScript SSE parser now normalizes `\r\n` and lone `\r` to `\n` per SSE specification

## 0.1.2

### Patch Changes

- Standardize package.json exports across all packages ([`bf9bc19`](https://github.com/durable-streams/durable-streams/commit/bf9bc19ef13eb22b2c0f98a175fad02b221d7860))
  - Add dual ESM/CJS exports to all packages
  - Fix export order to have "." first, then "./package.json"
  - Add proper main/module/types fields
  - Add sideEffects: false
  - Remove duplicate fields

## 0.1.1

### Patch Changes

- new version to fix local manual release ([#97](https://github.com/durable-streams/durable-streams/pull/97))
