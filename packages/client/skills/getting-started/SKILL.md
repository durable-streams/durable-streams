---
name: getting-started
description: >
  First-time setup for Durable Streams. Install @durable-streams/client,
  create a stream with DurableStream.create(), read with stream(), subscribe
  to live updates, resume from saved offsets. Covers offset semantics ("-1",
  "now", opaque tokens), LiveMode (false, true, "long-poll", "sse"), and
  StreamResponse consumption (.json(), .text(), .subscribeJson()).
type: lifecycle
library: durable-streams
library_version: "0.2.1"
sources:
  - "durable-streams/durable-streams:README.md"
  - "durable-streams/durable-streams:packages/client/src/stream-api.ts"
  - "durable-streams/durable-streams:packages/client/src/stream.ts"
---

# Durable Streams — Getting Started

Durable Streams is an HTTP-based protocol for persistent, resumable, append-only
event streams. Use `stream()` for reading and `DurableStream` when you also need
to create or write to streams.

## Setup

```typescript
import { stream, DurableStream } from "@durable-streams/client"

// Create a JSON stream (use DurableStream for write operations)
const handle = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-stream",
  contentType: "application/json",
})

// Write some data
await handle.append(JSON.stringify({ event: "user.created", userId: "123" }))
await handle.append(JSON.stringify({ event: "user.updated", userId: "123" }))

// Read all data (use stream() for read-only access)
const res = await stream({
  url: "https://your-server.com/v1/stream/my-stream",
  offset: "-1",
  live: false,
})
const items = await res.json()
// [{ event: "user.created", userId: "123" }, { event: "user.updated", userId: "123" }]
```

## Core Patterns

### Read all existing data (catch-up)

```typescript
import { stream } from "@durable-streams/client"

const res = await stream({
  url: "https://your-server.com/v1/stream/my-stream",
  offset: "-1", // Start from beginning
  live: false, // Stop after catching up
})
const data = await res.json()
const savedOffset = res.offset // Save for resumption
```

### Subscribe to live updates

```typescript
import { stream } from "@durable-streams/client"

const res = await stream({
  url: "https://your-server.com/v1/stream/my-stream",
  offset: "-1", // Catch up first, then continue live
  live: true, // Auto-selects best transport (SSE for JSON, long-poll for binary)
})

res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log("Received:", item)
  }
  saveCheckpoint(batch.offset) // Persist for resumption
})
```

### Resume from a saved offset

```typescript
import { stream } from "@durable-streams/client"

const savedOffset = loadCheckpoint() // Load previously saved offset

const res = await stream({
  url: "https://your-server.com/v1/stream/my-stream",
  offset: savedOffset, // Resume from where we left off
  live: true,
})

res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    processItem(item)
  }
  saveCheckpoint(batch.offset)
})
```

### Create and write to a stream

```typescript
import { DurableStream, IdempotentProducer } from "@durable-streams/client"

const handle = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-stream",
  contentType: "application/json",
})

// For simple one-off writes, use append() directly
await handle.append(JSON.stringify({ event: "hello" }))

// For sustained writes, use IdempotentProducer (faster, exactly-once)
const producer = new IdempotentProducer(handle, "my-service", {
  autoClaim: true,
  onError: (err) => console.error("Write failed:", err),
})

producer.append(JSON.stringify({ event: "world" })) // Fire-and-forget
await producer.flush() // Ensure delivery before shutdown
await producer.close()
```

## Common Mistakes

### CRITICAL Parsing or constructing offsets manually

Wrong:

```typescript
const nextOffset = `${parseInt(offset.split("_")[0]) + 1}_0`
```

Correct:

```typescript
const nextOffset = response.offset // Always use server-returned offset
```

Offsets are opaque tokens. The internal format is an implementation detail that may change between server versions.

Source: PROTOCOL.md section 6 (Offsets)

### CRITICAL Using offset 0 instead of "-1" for stream start

Wrong:

```typescript
const res = await stream({ url, offset: "0" })
```

Correct:

```typescript
const res = await stream({ url, offset: "-1" })
```

The special start-of-stream offset is the string `"-1"`, not `"0"`. Using `"0"` may miss data or return 400.

Source: README.md offset semantics section

### HIGH Calling multiple consumption methods on same response

Wrong:

```typescript
const res = await stream({ url, offset: "-1" })
const data = await res.json()
res.subscribeJson((batch) => {
  /* ... */
}) // throws ALREADY_CONSUMED!
```

Correct:

```typescript
const res = await stream({ url, offset: "-1", live: true })
res.subscribeJson((batch) => {
  for (const item of batch.items) {
    /* process */
  }
})
```

StreamResponse enforces single consumption. Choose one consumption method per response.

Source: packages/client/src/response.ts

### HIGH Setting live mode for one-shot reads

Wrong:

```typescript
const res = await stream({ url, offset: "-1", live: true })
const data = await res.json() // hangs until stream closes
```

Correct:

```typescript
const res = await stream({ url, offset: "-1", live: false })
const data = await res.json() // returns immediately with existing data
```

Use `live: false` for catch-up reads. `live: true` keeps the connection open waiting for new data.

Source: packages/client/src/types.ts LiveMode type

## See also

- [writing-data](../writing-data/SKILL.md) — IdempotentProducer for production-grade writes
- [server-deployment](../server-deployment/SKILL.md) — Setting up a server to develop against

Note: Streams must be created with `DurableStream.create()` before they can be read. See the writing-data skill for stream creation.

## Version

Targets @durable-streams/client v0.2.1.
