---
"@durable-streams/server": patch
"@durable-streams/client": patch
"@durable-streams/client-py": patch
"@durable-streams/server-conformance-tests": patch
"@durable-streams/client-conformance-tests": patch
---

Add Kafka-style idempotent producers for exactly-once write semantics.

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
