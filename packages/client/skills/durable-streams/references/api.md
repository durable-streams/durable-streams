# Durable Streams — API Reference

## stream() — Read-only streaming

```typescript
import { stream } from "@durable-streams/client"

const response = await stream<MyType>({
  url: "https://localhost:4437/v1/stream/my-events",
  offset: "-1",
  live: true,
})
```

### StreamOptions

| Option           | Type                                                          | Default  | Description                                                         |
| ---------------- | ------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| `url`            | `string \| URL`                                               | required | Stream URL                                                          |
| `offset`         | `string`                                                      | `"-1"`   | Resume point. `"-1"` = start, `"now"` = tail, or opaque token       |
| `live`           | `false \| true \| "long-poll" \| "sse"`                       | `true`   | Live mode. `true` auto-selects (SSE for JSON, long-poll for binary) |
| `headers`        | `Record<string, string \| (() => string \| Promise<string>)>` | —        | Static strings or async functions (called per-request)              |
| `params`         | `Record<string, string \| (() => string \| Promise<string>)>` | —        | Query parameters                                                    |
| `signal`         | `AbortSignal`                                                 | —        | Abort signal                                                        |
| `fetch`          | `typeof fetch`                                                | —        | Custom fetch implementation                                         |
| `json`           | `boolean`                                                     | —        | Hint to treat as JSON                                               |
| `backoffOptions` | `BackoffOptions`                                              | —        | Retry configuration                                                 |
| `onError`        | `StreamErrorHandler`                                          | —        | Error recovery callback                                             |
| `sseResilience`  | `SSEResilienceOptions`                                        | —        | SSE fallback configuration                                          |
| `warnOnHttp`     | `boolean`                                                     | `true`   | Warn when using HTTP in browser                                     |

### SSEResilienceOptions

| Option                  | Default | Description                                         |
| ----------------------- | ------- | --------------------------------------------------- |
| `minConnectionDuration` | `1000`  | ms — connections shorter than this count as "short" |
| `maxShortConnections`   | `3`     | Short connections before falling back to long-poll  |
| `backoffBaseDelay`      | `100`   | ms — base delay for exponential backoff             |
| `backoffMaxDelay`       | `5000`  | ms — max backoff delay                              |
| `logWarnings`           | `true`  | Log fallback warnings                               |

---

## DurableStream — Read/write handle

```typescript
import { DurableStream } from "@durable-streams/client"
```

### Static methods

```typescript
// Create a new stream (PUT). Fails if stream exists.
const ds = await DurableStream.create({
  url: "https://localhost:4437/v1/stream/events",
  contentType: "application/json",
  ttlSeconds: 3600,
})

// Connect to existing stream (HEAD to validate, populates contentType)
const ds = await DurableStream.connect({
  url: "https://localhost:4437/v1/stream/events",
})

// Get metadata without creating a handle
const head = await DurableStream.head({
  url: "https://localhost:4437/v1/stream/events",
})
// head: { exists: true, contentType, offset, etag, cacheControl, streamClosed }

// Delete a stream
await DurableStream.delete({
  url: "https://localhost:4437/v1/stream/events",
})
```

### CreateOptions (extends DurableStreamOptions)

| Option        | Type                               | Description                                           |
| ------------- | ---------------------------------- | ----------------------------------------------------- |
| `contentType` | `string`                           | Immutable after creation                              |
| `ttlSeconds`  | `number`                           | Time-to-live (mutually exclusive with `expiresAt`)    |
| `expiresAt`   | `string`                           | RFC3339 expiry (mutually exclusive with `ttlSeconds`) |
| `body`        | `BodyInit \| Uint8Array \| string` | Initial data to write                                 |
| `closed`      | `boolean`                          | Start in closed state                                 |

### Instance methods

```typescript
// Append data (one-off writes only — use IdempotentProducer for repeated writes)
await ds.append(JSON.stringify(data))

// Pipe a ReadableStream or async iterable
await ds.appendStream(readableStream)

// Get a WritableStream backed by IdempotentProducer
const writable = ds.writable({
  producerId: "pipe-1",
  onError: (err) => console.error(err),
})
await source.pipeTo(writable)

// Close stream (EOF). Optional final message.
const result = await ds.close({ body: JSON.stringify({ done: true }) })
// result: { finalOffset: Offset }

// Start reading
const response = await ds.stream<MyType>({ offset: "-1", live: "sse" })
```

---

## IdempotentProducer — Exactly-once batched writes

```typescript
import { IdempotentProducer } from "@durable-streams/client"

const producer = new IdempotentProducer(ds, "producer-id", options)
```

### IdempotentProducerOptions

| Option          | Type                     | Default   | Description                                          |
| --------------- | ------------------------ | --------- | ---------------------------------------------------- |
| `epoch`         | `number`                 | `0`       | Starting epoch                                       |
| `autoClaim`     | `boolean`                | `false`   | Auto-retry with epoch+1 on 403                       |
| `maxBatchBytes` | `number`                 | `1048576` | Max bytes before sending batch                       |
| `lingerMs`      | `number`                 | `5`       | Max ms to wait before sending                        |
| `maxInFlight`   | `number`                 | `5`       | Max concurrent in-flight batches                     |
| `fetch`         | `typeof fetch`           | —         | Custom fetch                                         |
| `signal`        | `AbortSignal`            | —         | Abort signal                                         |
| `onError`       | `(error: Error) => void` | —         | Batch error callback (required for error visibility) |

### Methods

```typescript
// Fire-and-forget append (synchronous, returns void — NOT a Promise)
producer.append(JSON.stringify(data))

// Send pending batch immediately, wait for all in-flight
await producer.flush()

// Idempotent close with optional final message
const result = await producer.close(JSON.stringify({ done: true }))
// result: { finalOffset: Offset }

// Stop producer without closing stream
await producer.detach()

// Increment epoch, reset sequence (flushes first)
await producer.restart()
```

### Instance properties

```typescript
producer.epoch // Current epoch number
producer.nextSeq // Next sequence number
producer.pendingCount // Messages in pending batch
producer.inFlightCount // Batches in flight
```

---

## StreamResponse — Consumption API

StreamResponse supports exactly ONE consumption method. Pick one pattern per response.

### Promise-based (accumulate until caught up)

```typescript
const bytes = await response.body() // Uint8Array
const items = await response.json<T>() // Array<T> (JSON mode only)
const text = await response.text() // string
```

These resolve when `upToDate` is reached. With `live: false`, this means all current data. With `live: true`, this means the first time caught up.

### ReadableStream (async-iterable)

```typescript
for await (const chunk of response.bodyStream()) {
  /* Uint8Array */
}
for await (const item of response.jsonStream()) {
  /* T */
}
for await (const text of response.textStream()) {
  /* string */
}
```

### Subscriber (batch-oriented with backpressure)

```typescript
const unsubscribe = response.subscribeJson<T>((batch) => {
  batch.items // ReadonlyArray<T>
  batch.offset // Offset (opaque string)
  batch.upToDate // boolean — caught up to tail
  batch.cursor // string | undefined
  batch.streamClosed // boolean — EOF, no more data ever
})

const unsubscribe = response.subscribeBytes((chunk) => {
  chunk.data // Uint8Array
  chunk.offset // Offset
})

const unsubscribe = response.subscribeText((chunk) => {
  chunk.text // string
  chunk.offset // Offset
})
```

Async subscriber callbacks apply backpressure — the next batch waits for the previous callback to complete.

### Response properties

```typescript
response.url // string
response.contentType // string | undefined
response.live // LiveMode
response.startOffset // Offset
response.offset // Offset (updates after data delivered)
response.cursor // string | undefined
response.upToDate // boolean
response.streamClosed // boolean
response.status // number
response.headers // Headers
response.closed // Promise<void> — resolves when fully closed
```

### Lifecycle

```typescript
response.cancel(reason?)  // Abort HTTP, close SSE, stop long-polls
```
