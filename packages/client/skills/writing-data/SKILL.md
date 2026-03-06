---
name: writing-data
description: >
  Writing data to durable streams. DurableStream.create() with contentType,
  DurableStream.append() for simple writes, IdempotentProducer for
  high-throughput exactly-once delivery with autoClaim, fire-and-forget
  append(), flush(), close(), StaleEpochError handling, JSON mode vs byte
  stream mode, stream closure. Load when writing, producing, or appending
  data to a durable stream.
type: core
library: durable-streams
library_version: "0.2.1"
requires:
  - getting-started
sources:
  - "durable-streams/durable-streams:packages/client/src/stream.ts"
  - "durable-streams/durable-streams:packages/client/src/idempotent-producer.ts"
  - "durable-streams/durable-streams:packages/client/src/types.ts"
---

This skill builds on durable-streams/getting-started. Read it first for setup and offset basics.

# Durable Streams — Writing Data

Two write APIs: `DurableStream.append()` for simple writes, `IdempotentProducer`
for sustained high-throughput writes with exactly-once delivery. Use the producer
for anything beyond a few one-off appends.

## Setup

```typescript
import {
  DurableStream,
  IdempotentProducer,
  StaleEpochError,
} from "@durable-streams/client"

// Create a JSON-mode stream
const handle = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-stream",
  contentType: "application/json",
})

// Set up IdempotentProducer for reliable writes
const producer = new IdempotentProducer(handle, "my-service", {
  autoClaim: true,
  onError: (err) => {
    if (err instanceof StaleEpochError) {
      console.log("Another producer took over")
    } else {
      console.error("Write error:", err)
    }
  },
})

// Fire-and-forget writes — automatically batched and deduplicated
for (const event of events) {
  producer.append(JSON.stringify(event))
}

// Ensure all pending writes are delivered
await producer.flush()
await producer.close()
```

## Core Patterns

### Simple writes with append()

For writing a few items and waiting for completion, `append()` is straightforward:

```typescript
import { DurableStream } from "@durable-streams/client"

const handle = await DurableStream.create({
  url: "https://your-server.com/v1/stream/events",
  contentType: "application/json",
})

// Each append waits for server confirmation
await handle.append({ type: "order.created", orderId: "123" })
await handle.append({ type: "order.paid", orderId: "123" })
```

### High-throughput writes with IdempotentProducer

For sustained writes, the producer batches, pipelines, and deduplicates automatically:

```typescript
import { DurableStream, IdempotentProducer } from "@durable-streams/client"

const handle = await DurableStream.create({
  url: "https://your-server.com/v1/stream/tokens",
  contentType: "text/plain",
})

const producer = new IdempotentProducer(handle, "llm-worker", {
  autoClaim: true,
  lingerMs: 10, // Batch window (default: 5ms)
  maxBatchBytes: 65536, // Max batch size (default: 1MB)
  maxInFlight: 4, // Concurrent HTTP requests (default: 5)
  onError: (err) => console.error(err),
})

for await (const token of llm.stream(prompt)) {
  producer.append(token) // Fire-and-forget — don't await
}

await producer.flush() // Wait for all batches to land
await producer.close() // Clean up
```

### Closing a stream

Mark a stream as permanently closed (no more writes accepted):

```typescript
// Close with optional final message
await handle.close({ body: JSON.stringify({ type: "stream.complete" }) })

// Or close without a final message
await handle.close()
```

### Byte stream mode with custom framing

For non-JSON streams, use your own framing (e.g., newline-delimited JSON):

```typescript
const handle = await DurableStream.create({
  url: "https://your-server.com/v1/stream/logs",
  contentType: "text/plain",
})

const producer = new IdempotentProducer(handle, "logger", { autoClaim: true })

producer.append(JSON.stringify({ level: "info", msg: "started" }) + "\n")
producer.append(JSON.stringify({ level: "error", msg: "failed" }) + "\n")

await producer.flush()
```

## Common Mistakes

### CRITICAL Using raw append() for sustained writes

Wrong:

```typescript
const handle = await DurableStream.create({
  url,
  contentType: "application/json",
})
for (const event of events) {
  await handle.append(JSON.stringify(event)) // No dedup, no batching, sequential
}
```

Correct:

```typescript
const handle = await DurableStream.create({
  url,
  contentType: "application/json",
})
const producer = new IdempotentProducer(handle, "my-service", {
  autoClaim: true,
  onError: (err) => console.error(err),
})
for (const event of events) {
  producer.append(JSON.stringify(event)) // Fire-and-forget, batched, deduplicated
}
await producer.flush()
```

Raw `append()` has no deduplication — on retry after network error, data may be duplicated. `IdempotentProducer` handles batching, pipelining, and exactly-once delivery.

Source: packages/client/src/idempotent-producer.ts

### CRITICAL Not calling flush() before shutdown

Wrong:

```typescript
for (const event of events) {
  producer.append(event)
}
// Process exits — pending batch lost!
```

Correct:

```typescript
for (const event of events) {
  producer.append(event)
}
await producer.flush()
await producer.close()
```

`IdempotentProducer` batches writes. Without `flush()`, pending messages in the buffer are lost when the process exits.

Source: packages/client/src/idempotent-producer.ts

### HIGH Awaiting each producer.append() call

Wrong:

```typescript
for (const event of events) {
  await producer.append(JSON.stringify(event)) // Defeats pipelining!
}
```

Correct:

```typescript
for (const event of events) {
  producer.append(JSON.stringify(event)) // Fire-and-forget
}
await producer.flush() // Wait for all to complete
```

`append()` is fire-and-forget by design. Awaiting it serializes every write and defeats batching and pipelining. Errors go to the `onError` callback.

Source: packages/client/src/idempotent-producer.ts

### HIGH Passing objects to append instead of strings

Wrong:

```typescript
producer.append({ event: "user.created" }) // throws!
```

Correct:

```typescript
producer.append(JSON.stringify({ event: "user.created" }))
```

`IdempotentProducer.append()` accepts only `string` or `Uint8Array` — it does **not** auto-serialize objects, even for JSON-mode streams. Always call `JSON.stringify()` before appending.

Source: packages/client/src/idempotent-producer.ts

### HIGH Not handling StaleEpochError for multi-worker scenarios

Wrong:

```typescript
const producer = new IdempotentProducer(handle, "worker", {
  onError: (err) => console.error(err), // Logs but doesn't stop
})
```

Correct:

```typescript
let fenced = false
const producer = new IdempotentProducer(handle, "worker", {
  onError: (err) => {
    if (err instanceof StaleEpochError) {
      fenced = true // Stop producing
    }
  },
})

for await (const token of source) {
  if (fenced) break
  producer.append(token)
}
```

When another producer claims a higher epoch, the current producer gets fenced. Without checking, your write loop continues appending to a dead producer.

Source: packages/client/src/idempotent-producer.ts

### HIGH Manually managing epoch numbers

Wrong:

```typescript
const producer = new IdempotentProducer(handle, "worker", { epoch: 2 })
```

Correct:

```typescript
const producer = new IdempotentProducer(handle, "worker", {
  autoClaim: true, // Handles epoch transitions automatically
})
```

Epoch and sequence management is an internal protocol detail. Use `autoClaim: true` and let the producer handle transitions automatically.

Source: maintainer guidance

### HIGH Tension: Simplicity vs. reliability in writes

This skill's patterns conflict with getting-started. Getting-started simplicity favors `append()` for quick demos, but production code should use `IdempotentProducer` for exactly-once guarantees. Agents optimizing for a quick setup may use `append()` and miss deduplication and batching.

See also: durable-streams/getting-started/SKILL.md § Common Mistakes

## See also

- [getting-started](../getting-started/SKILL.md) — Basic stream creation and reading
- [go-to-production](../go-to-production/SKILL.md) — TTL configuration and production concerns

## Version

Targets @durable-streams/client v0.2.1.
