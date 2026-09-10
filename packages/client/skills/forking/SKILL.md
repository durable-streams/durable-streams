---
name: forking
description: >
  Creating and using forked streams. Fork a source stream at a specific offset
  using Stream-Forked-From and Stream-Fork-Offset headers via
  DurableStream.create(). Reads transparently stitch inherited and fork data.
  Covers fork creation, fresh handle pattern, TTL/expiry inheritance,
  content-type inheritance, and deletion lifecycle. Load when forking,
  branching, or creating a stream variant from an existing stream.
type: core
library: durable-streams
library_version: "0.2.1"
requires:
  - getting-started
sources:
  - "durable-streams/durable-streams:packages/client/src/stream.ts"
  - "durable-streams/durable-streams:PROTOCOL.md"
---

This skill builds on durable-streams/getting-started. Read it first for setup and offset basics.

# Durable Streams — Forking

Fork creates a new stream that references the data of a source stream up to a
specified offset, without copying it. The fork is independent: it has its own
URL, TTL, closure state, and deletion lifecycle.

## Setup

```typescript
import { DurableStream } from "@durable-streams/client"

// Create a fork by passing fork headers via the headers option
await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-fork",
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
    "Stream-Fork-Offset": "1024", // optional; defaults to source tail
  },
})

// Use a fresh handle for ongoing reads/writes
const fork = await DurableStream.connect({
  url: "https://your-server.com/v1/stream/my-fork",
})

// Read — transparently returns inherited data followed by fork's own appends
const res = await fork.stream({ json: true })
const items = await res.json()

// Write — appends go only to the fork, source is untouched
await fork.append(JSON.stringify({ role: "user", text: "what if instead..." }))
```

## Core Patterns

### Create a fork at the source's current tail

```typescript
await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-fork",
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
    // Stream-Fork-Offset omitted — defaults to source's current tail
  },
})
```

### Create a fork at a specific offset

Use a server-returned offset from a previous `HEAD`, `GET`, or `POST` response:

```typescript
const source = await DurableStream.connect({
  url: "https://your-server.com/v1/stream/my-source",
})
const head = await source.head()

// Fork at an offset you previously saved or received from the server
await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-fork",
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
    "Stream-Fork-Offset": savedOffset,
  },
})
```

### Read a fork

Reading a fork is identical to reading any stream. The fork transparently
stitches inherited data from the source with the fork's own appends:

```typescript
import { stream } from "@durable-streams/client"

const res = await stream({
  url: "https://your-server.com/v1/stream/my-fork",
  offset: "-1",
  live: true,
})

res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log(item) // inherited + fork's own data, in offset order
  }
})
```

### Write to a fork

Appends work the same as any stream. Data goes only to the fork:

```typescript
const fork = await DurableStream.connect({
  url: "https://your-server.com/v1/stream/my-fork",
})

await fork.append(JSON.stringify({ event: "branched" }))
```

### Delete a fork

```typescript
await DurableStream.delete({
  url: "https://your-server.com/v1/stream/my-fork",
})
```

Deleting a fork decrements the source's reference count. If the source was
soft-deleted and this was its last fork, the source is cleaned up too.

### TTL and expiry

A fork has its own TTL and expiry. If the fork request provides `Stream-TTL`
or `Stream-Expires-At`, the fork uses those values. If omitted, the fork
inherits from the source: a source with a TTL passes its value on (the fork
runs its own sliding window), a source with `Expires-At` passes its hard
deadline on.

```typescript
await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-fork",
  ttlSeconds: 3600, // fork's own TTL, independent of source
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
  },
})
```

## Common Mistakes

### CRITICAL Reusing the create handle for reads and writes

Wrong:

```typescript
const fork = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-fork",
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
    "Stream-Fork-Offset": "1024",
  },
})

// Fork headers are resent on every request from this handle
await fork.append(JSON.stringify({ event: "data" }))
```

Correct:

```typescript
await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-fork",
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
    "Stream-Fork-Offset": "1024",
  },
})

// Fresh handle — no fork headers on subsequent requests
const fork = await DurableStream.connect({
  url: "https://your-server.com/v1/stream/my-fork",
})
await fork.append(JSON.stringify({ event: "data" }))
```

`options.headers` applies to every request on a handle. The fork headers are only meaningful on the initial `PUT`. Servers ignore them on reads and appends, but using a fresh handle keeps requests clean.

Source: packages/client/src/stream.ts

### CRITICAL Fabricating offset values for Stream-Fork-Offset

Wrong:

```typescript
await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-fork",
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
    "Stream-Fork-Offset": "100", // made-up value
  },
})
```

Correct:

```typescript
// Use a server-returned offset
const source = await DurableStream.connect({
  url: "https://your-server.com/v1/stream/my-source",
})
const head = await source.head()

await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-fork",
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
    "Stream-Fork-Offset": head.offset!, // server-returned offset
  },
})
```

Offsets are opaque tokens. Fabricated values may return `400 Bad Request`. Always use an offset from a previous `HEAD`, `GET`, or `POST` response.

Source: PROTOCOL.md section 6 (Offsets), section 4.2 (Stream forking)

### HIGH Mismatched Content-Type on fork creation

Wrong:

```typescript
// Source is application/json
await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-fork",
  contentType: "text/plain", // 409 Conflict!
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
  },
})
```

Correct:

```typescript
// Omit Content-Type to inherit from source
await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-fork",
  headers: {
    "Stream-Forked-From": "/v1/stream/my-source",
  },
})
```

When forking, omit `Content-Type` to inherit it from the source. If provided, it must match the source's content type exactly or the server returns `409 Conflict`.

Source: PROTOCOL.md section 4.2 (Stream forking)

### MEDIUM Not handling 410 Gone for soft-deleted sources

Wrong:

```typescript
try {
  const res = await stream({ url: sourceUrl, offset: "-1", live: false })
  const data = await res.json()
} catch (err) {
  // Only checks for 404
  if (err.statusCode === 404) console.log("Not found")
}
```

Correct:

```typescript
try {
  const res = await stream({ url: sourceUrl, offset: "-1", live: false })
  const data = await res.json()
} catch (err) {
  if (err.statusCode === 404) console.log("Not found")
  if (err.statusCode === 410) console.log("Soft-deleted — has active forks")
}
```

When a source stream with active forks is deleted, it returns `410 Gone` for all client operations. The source's data is retained internally for fork reads, but the source URL is no longer directly accessible.

Source: PROTOCOL.md section 4.2 (Soft-delete and lifecycle)

## See also

- [getting-started](../getting-started/SKILL.md) — Stream creation and offset basics
- [writing-data](../writing-data/SKILL.md) — IdempotentProducer for writes to forked streams
- [reading-streams](../reading-streams/SKILL.md) — Reading patterns (works identically on forks)

## Version

Targets @durable-streams/client v0.2.1.
