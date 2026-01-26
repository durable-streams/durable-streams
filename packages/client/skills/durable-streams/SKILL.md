---
name: durable-streams
description: Guide for working with Durable Streams - HTTP-based append-only logs with offset-based resumability. Use when creating streams, writing data with exactly-once semantics, reading with catch-up and live tailing, or debugging sync issues.
triggers:
  - "durable stream"
  - "stream"
  - "append"
  - "offset"
  - "resumable"
  - "exactly-once"
  - "IdempotentProducer"
metadata:
  sources:
    - "src/stream.ts"
    - "src/stream-api.ts"
    - "src/response.ts"
    - "src/idempotent-producer.ts"
    - "src/types.ts"
    - "README.md"
    - "../../README.md"
    - "../../PROTOCOL.md"
---

# Durable Streams

HTTP-based durable streams for reliable data delivery with offset-based resumability. Think "append-only log as a service" with exactly-once semantics.

## When to Use Durable Streams

- **AI token streaming** - Stream LLM responses with resume capability across reconnections
- **Real-time sync** - Stream database changes to web, mobile, and native clients
- **Event sourcing** - Build event-sourced architectures with client-side replay
- **Collaborative apps** - Multiple users sync to the same document or workspace

## Installation

```bash
npm install @durable-streams/client
```

## Three APIs

The client provides three main APIs with increasing levels of control:

| API | Use Case |
|-----|----------|
| `stream()` | Read-only, fetch-like interface |
| `DurableStream` | Read/write handle for a stream |
| `IdempotentProducer` | High-throughput exactly-once writes (recommended for production) |

## Quick Start

### Reading with `stream()`

```typescript
import { stream } from "@durable-streams/client"

const res = await stream<{ event: string }>({
  url: "https://streams.example.com/my-stream",
  offset: "-1",  // Start from beginning
  live: true,    // Continue with live updates
})

// Accumulate all data until caught up
const items = await res.json()

// Or subscribe to live updates
res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log("Received:", item)
  }
  saveCheckpoint(batch.offset) // Persist for resumption
})
```

### Writing with `IdempotentProducer` (Recommended)

For reliable, high-throughput writes:

```typescript
import { DurableStream, IdempotentProducer } from "@durable-streams/client"

const stream = await DurableStream.create({
  url: "https://streams.example.com/events",
  contentType: "application/json",
})

const producer = new IdempotentProducer(stream, "my-service-1", {
  autoClaim: true,
  onError: (err) => console.error("Batch failed:", err),
})

// Fire-and-forget - errors go to onError callback
for (const event of events) {
  producer.append(JSON.stringify(event))
}

// IMPORTANT: Always flush before shutdown
await producer.flush()
await producer.close()
```

### Simple Writes with `DurableStream`

For simpler cases without exactly-once guarantees:

```typescript
const handle = await DurableStream.create({
  url: "https://streams.example.com/my-stream",
  contentType: "application/json",
})

await handle.append(JSON.stringify({ message: "Hello" }))
```

## Key Concepts

### Offsets

Offsets are opaque tokens identifying positions within a stream:

- `"-1"` - Start of stream (read from beginning)
- `"now"` - Current tail (skip existing data)
- Any other offset - Returned by server, use as-is

```typescript
// Resume from saved offset
const res = await stream({ url, offset: savedOffset })
// After processing, save res.offset for next resume
```

### Live Modes

Control real-time behavior:

| Mode | Behavior |
|------|----------|
| `true` | Auto-select best mode (SSE for JSON, long-poll for binary) |
| `false` | Catch-up only, stop when up-to-date |
| `"long-poll"` | Explicit long-poll for live updates |
| `"sse"` | Explicit SSE for live updates |

### Content Types

**JSON mode** (`application/json`): Message boundaries preserved, server returns JSON arrays.

```typescript
const handle = await DurableStream.create({
  url,
  contentType: "application/json",
})
await handle.append({ event: "click" }) // Objects serialized automatically
```

**Byte mode** (default): Raw concatenated bytes, implement your own framing.

```typescript
// Use newline-delimited JSON for framing
await handle.append(JSON.stringify({ event: "click" }) + "\n")
```

## Consumption Methods

`StreamResponse` offers multiple ways to consume data:

### Promise Helpers (accumulate until up-to-date)

```typescript
const bytes = await res.body()   // Uint8Array
const items = await res.json()   // T[]
const text = await res.text()    // string
```

### ReadableStreams (pipeable)

```typescript
for await (const item of res.jsonStream()) {
  console.log(item)
}
```

### Subscribers (backpressure-aware)

```typescript
const unsubscribe = res.subscribeJson(async (batch) => {
  // Next batch waits until this resolves
  await processBatch(batch.items)
  saveCheckpoint(batch.offset)
})

// Later: stop receiving
unsubscribe()
```

## IdempotentProducer Details

Provides Kafka-style exactly-once semantics:

- **Automatic batching** - Multiple writes batched into single HTTP requests
- **Pipelining** - Up to 5 concurrent batches in flight
- **Zombie fencing** - Stale producers rejected via epoch validation
- **Safe retries** - Server deduplicates using `(producerId, epoch, seq)` tuple

```typescript
const producer = new IdempotentProducer(stream, "producer-id", {
  epoch: 0,              // Starting epoch
  autoClaim: true,       // Auto-recover from 403
  maxBatchBytes: 1_000_000,  // 1MB max batch
  lingerMs: 5,           // Wait up to 5ms for more messages
  maxInFlight: 5,        // Concurrent batches
  onError: (err) => {},  // Error callback
})

producer.append(data)    // Fire-and-forget
await producer.flush()   // Wait for all batches
await producer.close()   // Cleanup
```

## Error Handling

```typescript
import { stream, FetchError, DurableStreamError } from "@durable-streams/client"

const res = await stream({
  url,
  onError: async (error) => {
    if (error instanceof FetchError && error.status === 401) {
      const newToken = await refreshToken()
      return { headers: { Authorization: `Bearer ${newToken}` } }
    }
    return {} // Retry with same params
  },
})
```

For `IdempotentProducer`, handle errors via callback:

```typescript
import { StaleEpochError, SequenceGapError } from "@durable-streams/client"

const producer = new IdempotentProducer(stream, "id", {
  onError: (error) => {
    if (error instanceof StaleEpochError) {
      // Another producer has higher epoch - this one is "fenced"
      console.log("Fenced by epoch", error.currentEpoch)
    }
  },
})
```

## Dynamic Headers

Headers support static values or functions for dynamic tokens:

```typescript
const res = await stream({
  url,
  headers: {
    Authorization: async () => `Bearer ${await refreshToken()}`,
    "X-Tenant": () => getCurrentTenant(),
  },
})
```

## Common Mistakes

### Not flushing before shutdown

```typescript
// WRONG - data may be lost
for (const event of events) {
  producer.append(event)
}
process.exit(0)
```

```typescript
// CORRECT - ensure delivery
for (const event of events) {
  producer.append(event)
}
await producer.flush()
await producer.close()
```

### Parsing or constructing offsets

```typescript
// WRONG - never parse offsets
const nextOffset = parseInt(offset) + 1
```

```typescript
// CORRECT - treat as opaque tokens
const nextOffset = res.offset // Use server-returned value
```

### Ignoring content type for JSON

```typescript
// WRONG - no message boundaries
const handle = await DurableStream.create({ url })
await handle.append({ event: "click" }) // Will serialize wrong
```

```typescript
// CORRECT - specify content type
const handle = await DurableStream.create({
  url,
  contentType: "application/json",
})
```

### Awaiting fire-and-forget appends

```typescript
// WRONG - defeats batching, hurts throughput
for (const event of events) {
  await producer.append(event) // append() returns void!
}
```

```typescript
// CORRECT - fire-and-forget, then flush
for (const event of events) {
  producer.append(event)
}
await producer.flush()
```

## Protocol Reference

The protocol uses standard HTTP:

| Operation | Method | Description |
|-----------|--------|-------------|
| Create | `PUT /stream/{path}` | Create new stream |
| Append | `POST /stream/{path}` | Append data |
| Read | `GET /stream/{path}?offset=X` | Read from offset |
| Live | `GET /stream/{path}?offset=X&live=long-poll` | Live tail |
| Delete | `DELETE /stream/{path}` | Delete stream |
| Metadata | `HEAD /stream/{path}` | Get stream info |

Key headers:
- `Stream-Next-Offset` - Resume point for next read
- `Content-Type` - Set at creation, preserved for all reads
- `Cache-Control` - Enables CDN caching for historical reads

## CDN-Friendly Design

Offset-based URLs enable aggressive caching:

- Same offset = same data = cacheable
- 10,000 viewers at same offset = 1 upstream request
- CDN edges serve catch-up reads; origin handles live

## Additional Resources

- [Full API reference](references/api.md)
- [Protocol specification](../../PROTOCOL.md)
- [Error types](references/errors.md)
