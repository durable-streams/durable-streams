---
name: reading-streams
description: >
  All stream reading patterns for @durable-streams/client. stream() function,
  DurableStream.stream(), LiveMode (false, true, "long-poll", "sse"),
  StreamResponse state machine, .json(), .text(), .jsonStream(), .textStream(),
  .subscribeJson(), .subscribeBytes(), .subscribeText(), SSE resilience with
  auto-fallback to long-poll, visibility-based pause, binary SSE base64
  auto-decode, dynamic headers for auth token refresh, backoff config,
  StreamErrorHandler onError for error recovery.
type: core
library: durable-streams
library_version: "0.2.1"
requires:
  - getting-started
sources:
  - "durable-streams/durable-streams:packages/client/src/stream-api.ts"
  - "durable-streams/durable-streams:packages/client/src/response.ts"
  - "durable-streams/durable-streams:packages/client/src/types.ts"
  - "durable-streams/durable-streams:packages/client/src/fetch.ts"
---

This skill builds on durable-streams/getting-started. Read it first for setup and offset basics.

# Durable Streams — Reading Streams

Use `stream()` for read-only access (fetch-like API). Use `DurableStream.stream()`
when you already have a `DurableStream` handle for read/write operations. Both
return a `StreamResponse` with identical consumption methods.

## Setup

```typescript
import { stream } from "@durable-streams/client"

// Catch-up read (returns all existing data, then stops)
const res = await stream<{ event: string; userId: string }>({
  url: "https://your-server.com/v1/stream/my-stream",
  offset: "-1",
  live: false,
})
const items = await res.json()
```

## Core Patterns

### Live modes

```typescript
import { stream } from "@durable-streams/client"

// Catch-up only — stop at end of existing data
const catchUp = await stream({ url, offset: "-1", live: false })

// Auto-select best transport (SSE for JSON, long-poll for binary)
const auto = await stream({ url, offset: "-1", live: true })

// Explicit long-poll
const longPoll = await stream({ url, offset: "-1", live: "long-poll" })

// Explicit SSE
const sse = await stream({ url, offset: "-1", live: "sse" })
```

### Dynamic headers for auth token refresh

Header functions are called **per-request**, allowing token refresh during long-lived live streams:

```typescript
import { stream } from "@durable-streams/client"

const res = await stream({
  url: "https://your-server.com/v1/stream/my-stream",
  offset: "-1",
  live: true,
  headers: {
    Authorization: async () => `Bearer ${await getAccessToken()}`,
  },
})
```

### Error recovery with onError

```typescript
import { stream } from "@durable-streams/client"

const res = await stream({
  url: "https://your-server.com/v1/stream/my-stream",
  offset: "-1",
  live: true,
  onError: (error) => {
    if (error.status === 401) {
      // Refresh auth and retry with new headers
      return { headers: { Authorization: `Bearer ${newToken}` } }
    }
    if (error.status === 404) {
      return // Stop retrying (void = propagate error)
    }
    return {} // Retry with same params
  },
})
```

### SSE resilience with auto-fallback

```typescript
import { stream } from "@durable-streams/client"

const res = await stream({
  url: "https://your-server.com/v1/stream/my-stream",
  offset: "-1",
  live: "sse",
  sseResilience: {
    minConnectionDuration: 1000, // Connections under 1s are "short"
    maxShortConnections: 3, // Fall back after 3 short connections
  },
})
```

## Common Mistakes

### CRITICAL Not saving offset for resumption

Wrong:

```typescript
res.subscribeJson((batch) => {
  processItems(batch.items)
  // offset not saved!
})
```

Correct:

```typescript
res.subscribeJson((batch) => {
  processItems(batch.items)
  saveCheckpoint(batch.offset)
})
```

The whole point of durable streams is resumability. Without persisting the offset, you lose the ability to resume after disconnect.

Source: README.md resume from offset section

### HIGH Using .json() on non-JSON content type streams

Wrong:

```typescript
// Stream created with contentType: "text/plain"
const res = await stream({ url, offset: "-1", live: false })
const data = await res.json() // throws DurableStreamError!
```

Correct:

```typescript
const res = await stream({ url, offset: "-1", live: false })
const text = await res.text()
```

`.json()`, `.jsonStream()`, and `.subscribeJson()` only work on JSON-mode streams (`contentType: "application/json"`). Use `.text()` or `.body()` for other content types.

Source: packages/client/src/response.ts

### HIGH Ignoring onError handler for live streams

Wrong:

```typescript
const res = await stream({ url, offset: "-1", live: true })
// No onError — auth failures retry forever with exponential backoff
```

Correct:

```typescript
const res = await stream({
  url,
  offset: "-1",
  live: true,
  onError: (error) => {
    if (error.status === 401) return // Stop retrying
    return {} // Retry for transient errors
  },
})
```

Without `onError`, permanent errors (401, 403) silently retry forever with exponential backoff.

Source: packages/client/src/types.ts StreamErrorHandler

### HIGH Returning void from onError to retry

Wrong:

```typescript
onError: (error) => {
  console.log("retrying...")
  // Returns undefined — error propagates instead of retrying!
}
```

Correct:

```typescript
onError: (error) => {
  console.log("retrying...")
  return {} // Return an object to signal retry
}
```

The `onError` handler must return an object (`{}` or `{ headers, params }`) to signal retry. Returning `void`/`undefined` propagates the error.

Source: packages/client/src/types.ts RetryOpts

### MEDIUM Using HTTP instead of HTTPS in browser

Wrong:

```typescript
const res = await stream({ url: "http://api.example.com/v1/stream/my-stream" })
```

Correct:

```typescript
const res = await stream({ url: "https://api.example.com/v1/stream/my-stream" })
```

HTTP/1.1 in browsers limits to ~6 concurrent connections per origin. With multiple live streams, this can freeze the app.

Source: packages/client/src/utils.ts warnIfUsingHttpInBrowser

## References

- [StreamResponse consumption methods](references/stream-response-methods.md)

## See also

- [getting-started](../getting-started/SKILL.md) — Basic setup and offset concepts
- [stream-db](../../../state/skills/stream-db/SKILL.md) — StreamDB uses stream reading internally

## Version

Targets @durable-streams/client v0.2.1.
