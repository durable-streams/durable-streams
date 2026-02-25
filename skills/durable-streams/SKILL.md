---
name: durable-streams
description: >
  HTTP append-only event streams with offset-based resumption. Three APIs:
  stream() for read-only, DurableStream for read/write handle,
  IdempotentProducer for exactly-once batched writes. Covers create/write/read
  lifecycle, live modes (SSE, long-poll), JSON framing, producer headers,
  zombie fencing, StreamResponse consumption, and dynamic auth headers.
type: core
library: "@durable-streams"
library_version: "pre-1.0"
sources:
  - "durable-streams:packages/client/src/durable-stream.ts"
  - "durable-streams:packages/client/src/idempotent-producer.ts"
  - "durable-streams:packages/client/src/stream.ts"
  - "durable-streams:packages/client/src/response.ts"
  - "durable-streams:PROTOCOL.md"
---

# Durable Streams — Core Streaming

Persistent, resumable, append-only event streams over HTTP. Clients write data with exactly-once producer semantics and read with offset-based resumption. The server is CDN-friendly with long-poll and SSE live modes.

## API Decision Table

| Need                                | Use                      | Why                                     |
| ----------------------------------- | ------------------------ | --------------------------------------- |
| Read-only streaming                 | `stream()` function      | Lightweight, no handle overhead         |
| Read + write to same stream         | `DurableStream` class    | Handle with append/stream/close         |
| High-throughput exactly-once writes | `IdempotentProducer`     | Batching, pipelining, dedup, auto-retry |
| One-off write (rare)                | `DurableStream.append()` | Simple but no retry safety              |

Use `IdempotentProducer` for any repeated writes. `DurableStream.append()` is for one-off writes only — it lacks retry safety, so a network failure means lost or duplicated data.

## Setup

### Create and write

```typescript
import { DurableStream, IdempotentProducer } from "@durable-streams/client"

// Create a JSON stream
const ds = await DurableStream.create({
  url: "https://localhost:4437/v1/stream/my-events",
  contentType: "application/json",
})

// Set up exactly-once producer
const producer = new IdempotentProducer(ds, "writer-1", {
  onError: (err) => console.error("batch failed:", err),
})

// Fire-and-forget writes (synchronous, returns void)
producer.append(JSON.stringify({ type: "click", x: 100, y: 200 }))
producer.append(JSON.stringify({ type: "click", x: 150, y: 250 }))

// Flush before shutdown to avoid data loss
await producer.flush()
await producer.close()
```

### Read from beginning

```typescript
import { stream } from "@durable-streams/client"

const response = await stream({
  url: "https://localhost:4437/v1/stream/my-events",
  offset: "-1",
  live: "sse",
})

response.subscribeJson<{ type: string; x: number; y: number }>((batch) => {
  for (const item of batch.items) {
    console.log(item.type, item.x, item.y)
  }
  if (batch.streamClosed) {
    console.log("stream ended")
  }
})
```

## Core Patterns

### Resume from a saved offset

```typescript
import { stream } from "@durable-streams/client"

let savedOffset = localStorage.getItem("my-stream-offset") ?? "-1"

const response = await stream({
  url: "https://localhost:4437/v1/stream/my-events",
  offset: savedOffset,
  live: true,
})

response.subscribeJson((batch) => {
  for (const item of batch.items) {
    console.log("event:", item)
  }
  savedOffset = batch.offset
  localStorage.setItem("my-stream-offset", savedOffset)
})
```

### Dynamic authorization headers

```typescript
const ds = new DurableStream({
  url: "https://api.example.com/v1/stream/my-events",
  headers: {
    Authorization: async () => `Bearer ${await getAccessToken()}`,
  },
})
```

Headers can be async functions — called per-request, so tokens refresh automatically during long-lived sessions.

### Accumulate JSON with promise API

```typescript
const response = await stream({
  url: "https://localhost:4437/v1/stream/my-events",
  offset: "-1",
  live: false,
})

const allItems = await response.json<ClickEvent>()
```

`live: false` reads until caught up, then resolves. Use `live: true` or `"sse"` for continuous tailing.

### High-throughput producer with tuning

```typescript
const producer = new IdempotentProducer(ds, "ingest-1", {
  maxBatchBytes: 1_048_576,
  lingerMs: 5,
  maxInFlight: 5,
  autoClaim: true,
  onError: (err) => {
    if (err instanceof StaleEpochError) {
      console.warn("another producer claimed the epoch")
    }
  },
})
```

## Common Mistakes

### CRITICAL Awaiting IdempotentProducer.append()

Wrong:

```typescript
try {
  await producer.append(JSON.stringify(data))
} catch (err) {
  console.error("write failed:", err)
}
```

Correct:

```typescript
const producer = new IdempotentProducer(ds, "writer-1", {
  onError: (err) => console.error("batch failed:", err),
})
producer.append(JSON.stringify(data))
```

`append()` is synchronous and returns `void`. Errors surface via `onError`, not try/catch. Wrapping in await silently discards batch-level failures.

Source: packages/client/src/idempotent-producer.ts — append() signature

### CRITICAL Not calling flush() before shutdown

Wrong:

```typescript
producer.append(JSON.stringify(data))
process.exit(0)
```

Correct:

```typescript
producer.append(JSON.stringify(data))
await producer.flush()
await producer.close()
```

IdempotentProducer batches messages. Exiting without `flush()` silently loses the pending batch.

Source: packages/client/src/idempotent-producer.ts — flush() docs

### CRITICAL Treating Stream-Up-To-Date as EOF

Wrong:

```typescript
response.subscribeJson((batch) => {
  processItems(batch.items)
  if (batch.upToDate) {
    response.cancel() // WRONG: more data may arrive
  }
})
```

Correct:

```typescript
response.subscribeJson((batch) => {
  processItems(batch.items)
  if (batch.streamClosed) {
    console.log("EOF — no more data ever")
  }
})
```

`upToDate` means "caught up to current tail" — more data MAY arrive. Only `streamClosed: true` means EOF.

Source: PROTOCOL.md Section 5.6 — Stream-Up-To-Date vs Stream-Closed

### CRITICAL Content-Type is immutable after creation

Wrong:

```typescript
const ds = await DurableStream.create({
  url: "https://localhost:4437/v1/stream/data",
})
await ds.append("some text", { contentType: "text/plain" }) // 409 Conflict
```

Correct:

```typescript
const ds = await DurableStream.create({
  url: "https://localhost:4437/v1/stream/data",
  contentType: "text/plain",
})
await ds.append("some text")
```

Content-Type is locked at stream creation. All subsequent appends must match or the server returns 409.

Source: PROTOCOL.md Section 5.2 — Content-Type matching

### CRITICAL Not specifying contentType for JSON streams

Wrong:

```typescript
const ds = await DurableStream.create({
  url: "https://localhost:4437/v1/stream/events",
})
await ds.append(JSON.stringify({ event: "click" }))
// No message boundaries — bytes concatenate
```

Correct:

```typescript
const ds = await DurableStream.create({
  url: "https://localhost:4437/v1/stream/events",
  contentType: "application/json",
})
await ds.append(JSON.stringify({ event: "click" }))
```

Without `application/json`, the stream is raw bytes with no message framing. JSON objects concatenate without boundaries.

Source: PROTOCOL.md Section 7 — JSON Mode

### HIGH Using DurableStream.append() for repeated writes

Wrong:

```typescript
for (const event of events) {
  await ds.append(JSON.stringify(event))
}
```

Correct:

```typescript
const producer = new IdempotentProducer(ds, "writer-1", {
  onError: (err) => console.error("batch failed:", err),
})
for (const event of events) {
  producer.append(JSON.stringify(event))
}
await producer.flush()
```

`DurableStream.append()` is for one-off writes only. `IdempotentProducer` is faster (batching + pipelining), idempotent (exactly-once via dedup), and resilient (auto-retry on failure).

Source: Maintainer interview

### HIGH Parsing or constructing offset values

Wrong:

```typescript
const nextOffset = String(parseInt(currentOffset) + 1)
```

Correct:

```typescript
const nextOffset = batch.offset // Use server-returned value as-is
```

Offsets are opaque tokens. Only use server-returned values or the special values `"-1"` (start) and `"now"` (tail).

Source: PROTOCOL.md Section 6 — Offsets

### HIGH Calling multiple consumption methods on StreamResponse

Wrong:

```typescript
const items = await response.json()
response.subscribeJson((batch) => {
  /* ... */
}) // throws ALREADY_CONSUMED
```

Correct:

```typescript
// Pick ONE consumption method per response
response.subscribeJson((batch) => {
  for (const item of batch.items) processItem(item)
})
```

StreamResponse supports exactly one consumption method. Calling a second throws `ALREADY_CONSUMED`.

Source: packages/client/src/response.ts — consumption guard

### HIGH Starting new epoch with seq != 0

Wrong:

```typescript
const producer = new IdempotentProducer(ds, "writer-1", { epoch: 2 })
// Internal seq continues from previous epoch — 400 Bad Request
```

Correct:

```typescript
const producer = new IdempotentProducer(ds, "writer-1", { epoch: 2 })
// Seq automatically starts at 0 for new epoch when using the class
```

When incrementing Producer-Epoch, Producer-Seq must restart at 0. The `IdempotentProducer` class handles this automatically — this mistake occurs when implementing producer headers manually.

Source: PROTOCOL.md Section 5.2.1 — Validation Logic

### HIGH Using autoClaim without understanding zombie risk

Wrong:

```typescript
// Multiple workers with autoClaim — fencing storm
const producer1 = new IdempotentProducer(ds, "shared-id", { autoClaim: true })
const producer2 = new IdempotentProducer(ds, "shared-id", { autoClaim: true })
```

Correct:

```typescript
// Each worker gets a unique producer ID
const producer1 = new IdempotentProducer(ds, "worker-1")
const producer2 = new IdempotentProducer(ds, "worker-2")
```

`autoClaim` auto-increments epoch on 403, fencing the previous producer. Multiple workers sharing an ID with `autoClaim` fight for the epoch in a fencing storm. Use unique producer IDs for concurrent writers.

Source: PROTOCOL.md Section 5.2.1 — Auto-claim Flow

### HIGH Confusing Stream-Seq with Producer-Seq

Stream-Seq is application-layer writer coordination (lexicographic, optional). Producer-Seq is transport-layer retry safety (numeric, part of idempotent producer headers). They serve different purposes and are validated independently. Source: PROTOCOL.md Section 5.2.1

### HIGH Sending producer headers partially

All three producer headers (`Producer-Id`, `Producer-Epoch`, `Producer-Seq`) must be sent together or not at all. Partial headers return 400. Use `IdempotentProducer` to manage this automatically. Source: PROTOCOL.md Section 5.2.1

### HIGH Not persisting offsets for resumption

Wrong:

```typescript
response.subscribeJson((batch) => {
  processItems(batch.items)
  // offset not saved anywhere
})
// On reconnect: must replay entire stream
```

Correct:

```typescript
response.subscribeJson((batch) => {
  processItems(batch.items)
  saveOffset(batch.offset)
})
```

Without persisting offsets, reconnection requires replaying the entire stream from the beginning.

Source: PROTOCOL.md Section 6

### HIGH Ignoring cursor in CDN deployments

Wrong:

```typescript
const response = await stream({
  url: "https://cdn.example.com/v1/stream/events",
  offset: savedOffset,
  live: "long-poll",
})
```

Correct:

```typescript
const response = await stream({
  url: "https://cdn.example.com/v1/stream/events",
  offset: savedOffset,
  live: "long-poll",
  // cursor is echoed automatically by the client library
})
```

The `Stream-Cursor` header prevents CDN cache collisions during long-poll. The client library handles cursor echoing automatically, but if implementing the protocol directly, you must echo the cursor on subsequent requests.

Source: PROTOCOL.md Section 8.1 — Cursor mechanism

### HIGH Resuming from saved offset after stream delete and recreate

Wrong:

```typescript
const offset = loadSavedOffset("my-stream") // from before delete
const response = await stream({
  url: "https://localhost:4437/v1/stream/my-stream",
  offset, // points into old stream's address space
})
```

Offsets contain no stream identity. When a stream is deleted and recreated at the same path, offsets reset. A stale offset from the old stream causes silent data corruption or skipped messages in the new stream.

Source: PROTOCOL.md Section 4, Section 6

### MEDIUM Using json() on non-JSON streams

Wrong:

```typescript
const ds = await DurableStream.create({
  url: "https://localhost:4437/v1/stream/binary",
  contentType: "application/octet-stream",
})
// Later...
const response = await ds.stream()
const items = await response.json() // throws BAD_REQUEST
```

`json()`, `jsonStream()`, and `subscribeJson()` require a JSON content type. Use `body()`, `bodyStream()`, or `subscribeBytes()` for non-JSON streams.

Source: packages/client/src/response.ts — JSON consumption guard

### MEDIUM Using TTL and Expires-At together

Wrong:

```typescript
const ds = await DurableStream.create({
  url: "https://localhost:4437/v1/stream/temp",
  contentType: "application/json",
  ttlSeconds: 3600,
  expiresAt: "2026-03-01T00:00:00Z", // 400 Bad Request
})
```

`ttlSeconds` and `expiresAt` are mutually exclusive. Use one or the other.

Source: PROTOCOL.md Section 5.1 — Create Stream

### HIGH Tension: Fire-and-forget throughput vs error visibility

IdempotentProducer's `append()` is fire-and-forget for maximum throughput, but batch errors only surface via the `onError` callback. Agents wrap `append()` in try/catch and believe errors are handled, when batch-level failures are silently lost without `onError`.

### HIGH Tension: Exactly-once semantics vs operational complexity

IdempotentProducer provides exactly-once delivery but requires understanding epoch lifecycle, `onError` callbacks, and `flush()` discipline. Agents default to `DurableStream.append()` when they need idempotency, or set up IdempotentProducer without `flush()` and `onError`, silently losing data.

See also: durable-streams § Common Mistakes — "Not calling flush() before shutdown"

### HIGH Tension: Protocol simplicity vs structured data needs

The base protocol is a raw byte stream — minimal and flexible. The State Protocol (`@durable-streams/state`) adds typed events, collections, and materialization on top. Agents use raw `append()` with `JSON.stringify` for structured data when they should use the State Protocol, losing type routing, upsert semantics, and reactive queries.

See also: durable-state/SKILL.md

### HIGH Tension: CDN cacheability vs real-time freshness

Aggressive CDN caching improves fan-out but clients must echo the `Stream-Cursor` header to avoid stale responses. Agents omit cursor handling because it seems optional, leading to stale CDN data or infinite redirect loops.

See also: durable-streams-dev-setup/SKILL.md, durable-streams § "Ignoring cursor in CDN deployments"

### CRITICAL Not knowing @durable-streams/state exists

When building features like presence tracking, chat rooms, or synced key/value stores, use `@durable-streams/state` with `createStreamDB()` instead of building ad-hoc state on raw streams. StreamDB provides typed collections, reactive queries via TanStack DB, and optimistic updates out of the box.

See: durable-state/SKILL.md

## References

- [Full API reference](references/api.md) — stream(), DurableStream, IdempotentProducer, StreamResponse
- [Error types and handling](references/errors.md) — Error classes, HTTP status codes, backoff, onError patterns
