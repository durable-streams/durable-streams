# @durable-streams/client-py

## 0.1.3

### Patch Changes

- Fix SSE event field parsing to comply with spec ([#209](https://github.com/durable-streams/durable-streams/pull/209))

  Per the SSE specification, parsers should strip only a single leading space
  after the colon in field values, not all whitespace. This fixes the `event:`
  field parsing in all three client implementations to use the same correct
  behavior already used for `data:` fields.

- added support for base64 encoding over sse ([#223](https://github.com/durable-streams/durable-streams/pull/223))

## 0.1.2

### Patch Changes

- Remove "auto" live mode from all clients in favor of explicit mode selection. TypeScript and Python now use `live: true` for auto-select behavior. Go, Rust, Swift, Java, PHP, and Ruby clients also updated. Fix Swift by removing stub flush/close methods from DurableStream. ([#177](https://github.com/durable-streams/durable-streams/pull/177))

## 0.1.1

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
