# @durable-streams/client-effect

Effect-based client for the Durable Streams protocol.

## Installation

```bash
npm install @durable-streams/client-effect
```

**Peer dependencies:**

- `effect` (^3.19.15)
- `@effect/platform` (^0.94.2)
- `@effect/platform-node` (^0.104.1)

## Overview

This package provides an Effect-based implementation of the Durable Streams client with full type safety, composability, and seamless integration with the Effect ecosystem.

**Key Features:**

- **Type-safe**: All operations return typed `Effect` values with explicit error channels
- **Composable**: Build complex streaming pipelines using Effect and Stream combinators
- **Exactly-once writes**: `IdempotentProducer` provides Kafka-style deduplication
- **Multiple consumption patterns**: Accumulate, stream, or batch JSON/text/bytes

**Three main APIs:**

1. **`DurableStreamClient`** - Main service for stream operations (create, append, read, delete)
2. **`StreamSession`** - Read session with multiple consumption patterns
3. **`IdempotentProducer`** - Exactly-once writes with automatic batching and pipelining

## Quick Start

```typescript
import { Effect } from "effect"
import {
  DurableStreamClient,
  DurableStreamClientLiveNode,
} from "@durable-streams/client-effect"

const program = Effect.gen(function* () {
  const client = yield* DurableStreamClient

  // Create a stream
  yield* client.create("https://example.com/streams/my-stream", {
    contentType: "application/json",
  })

  // Append data
  yield* client.append(
    "https://example.com/streams/my-stream",
    JSON.stringify({ message: "hello" })
  )

  // Read stream
  const session = yield* client.stream("https://example.com/streams/my-stream")
  const items = yield* session.json()
  console.log(items)
})

Effect.runPromise(program.pipe(Effect.provide(DurableStreamClientLiveNode())))
```

## Usage

### Creating Streams

```typescript
yield* client.create(url, {
  contentType: "application/json",
  ttlSeconds: 3600, // Optional: auto-delete after 1 hour
  body: JSON.stringify({ initial: "data" }), // Optional: initial data
})
```

### Appending Data

```typescript
// Simple append
yield* client.append(url, JSON.stringify({ event: "data" }))

// With sequence number for ordering
yield* client.append(url, data, { seq: "writer-1-001" })
```

### Reading Data

The `StreamSession` provides multiple consumption patterns:

#### Accumulation (Promise-like)

```typescript
const session = yield* client.stream<{ message: string }>(url)

// Accumulate all bytes until up-to-date
const bytes = yield* session.body()

// Accumulate all text until up-to-date
const text = yield* session.text()

// Accumulate all JSON items until up-to-date
const items = yield* session.json()
```

#### Streaming with Effect.Stream

```typescript
import { Stream } from "effect"

const session = yield* client.stream<{ id: number }>(url)

// Stream of individual JSON items
const jsonStream = session.jsonStream()
yield* Stream.runForEach(jsonStream, (item) =>
  Effect.log(`Received: ${item.id}`)
)

// Stream of batches with metadata (offset, upToDate, cursor)
const batchStream = session.jsonBatches()
yield* Stream.runForEach(batchStream, (batch) =>
  Effect.gen(function* () {
    for (const item of batch.items) {
      yield* Effect.log(`Item: ${item.id}`)
    }
    yield* Effect.log(`Offset: ${batch.offset}, Up-to-date: ${batch.upToDate}`)
  })
)

// Stream of byte chunks
const byteStream = session.bodyStream()

// Stream of text chunks
const textStream = session.textStream()
```

### Idempotent Producer

For high-throughput writes with exactly-once semantics:

```typescript
const producer = yield* client.producer(url, "my-producer-id", {
  maxBatchBytes: 1024 * 1024, // 1MB batches
  maxInFlight: 5, // 5 concurrent batches
  lingerMs: 5, // Wait 5ms for more messages
})

// Append data (waits for acknowledgment)
yield* producer.append(JSON.stringify({ event: "click" }))
yield* producer.append(JSON.stringify({ event: "scroll" }))

// Flush pending batch and wait for all in-flight
yield* producer.flush

// Close producer (flushes first)
yield* producer.close
```

**Why use IdempotentProducer?**

- **Exactly-once delivery**: Server deduplicates using `(producerId, epoch, seq)` tuple
- **Automatic batching**: Multiple writes batched into single HTTP requests
- **Pipelining**: Multiple batches in flight concurrently
- **Zombie fencing**: Stale producers are rejected, preventing split-brain scenarios

## API Reference

### DurableStreamClient

The main service, accessed via `yield* DurableStreamClient`:

| Method | Description |
|--------|-------------|
| `create(url, options?)` | Create a new stream |
| `head(url, options?)` | Get stream metadata |
| `delete(url, options?)` | Delete a stream |
| `append(url, data, options?)` | Append data to a stream |
| `stream(url, options?)` | Start a read session |
| `producer(url, producerId, options?)` | Create an idempotent producer |

### StreamSession

Returned by `client.stream()`:

**Accumulation methods:**

| Method | Return Type | Description |
|--------|-------------|-------------|
| `body()` | `Effect<Uint8Array>` | All bytes until up-to-date |
| `text()` | `Effect<string>` | All text until up-to-date |
| `json()` | `Effect<T[], ParseError>` | All JSON items until up-to-date |

**Streaming methods:**

| Method | Return Type | Description |
|--------|-------------|-------------|
| `bodyStream()` | `Stream<ByteChunk>` | Stream of byte chunks with metadata |
| `textStream()` | `Stream<string>` | Stream of text chunks |
| `jsonStream()` | `Stream<T, ParseError>` | Stream of individual JSON items |
| `jsonBatches()` | `Stream<Batch<T>, ParseError>` | Stream of JSON batches with metadata |

**State properties:**

| Property | Type | Description |
|----------|------|-------------|
| `offset` | `Effect<Offset>` | Current offset |
| `upToDate` | `Effect<boolean>` | Whether caught up to stream head |
| `status` | `number` | HTTP status from initial response |
| `contentType` | `string \| undefined` | Content type of the stream |

**Control:**

| Method | Description |
|--------|-------------|
| `cancel()` | Cancel the session |

### IdempotentProducer

Returned by `client.producer()`:

| Method/Property | Type | Description |
|-----------------|------|-------------|
| `append(data)` | `Effect<void, Error>` | Append data (waits for ack) |
| `flush` | `Effect<void, Error>` | Send pending batch, wait for in-flight |
| `close` | `Effect<void, Error>` | Flush and close producer |
| `restart` | `Effect<void, Error>` | Increment epoch, reset sequence |
| `epoch` | `Effect<number>` | Current epoch |
| `nextSeq` | `Effect<number>` | Next sequence number |
| `pendingCount` | `Effect<number>` | Messages in pending batch |

## Configuration

### DurableStreamClientConfig

```typescript
interface DurableStreamClientConfig {
  // Default headers for all requests
  headers?: HeadersRecord

  // Default query parameters
  params?: ParamsRecord

  // Default content type for new streams
  defaultContentType?: string
}
```

### CreateOptions

```typescript
interface CreateOptions {
  contentType?: string // Stream content type
  ttlSeconds?: number // TTL in seconds
  expiresAt?: string // Absolute expiry (ISO 8601)
  body?: Uint8Array | string // Initial data
  headers?: HeadersRecord
  params?: ParamsRecord
}
```

### StreamOptions

```typescript
interface StreamOptions {
  offset?: Offset // Starting offset ("-1" for beginning)
  live?: LiveMode // Live mode (see below)
  json?: boolean // Force JSON parsing
  headers?: HeadersRecord
  params?: ParamsRecord
}
```

### ProducerOptions

```typescript
interface ProducerOptions {
  epoch?: number // Starting epoch (default: 0)
  autoClaim?: boolean // Auto-claim on 403 (default: false)
  maxBatchBytes?: number // Max bytes per batch (default: 1MB)
  maxInFlight?: number // Concurrent batches (default: 5)
  lingerMs?: number // Batch delay (default: 5ms)
  headers?: HeadersRecord
  params?: ParamsRecord
}
```

## Live Modes

Control real-time behavior with the `live` option:

| Value | Description |
|-------|-------------|
| `false` | Catch-up only, stop when up-to-date |
| `true` | Auto-select best mode (SSE for JSON, long-poll for binary) |
| `"long-poll"` | Explicit HTTP long-polling |
| `"sse"` | Explicit Server-Sent Events |

```typescript
// Catch-up only - stop when up-to-date
const session = yield* client.stream(url, { live: false })

// Live updates with auto-selection
const session = yield* client.stream(url, { live: true })

// Explicit SSE mode
const session = yield* client.stream(url, { live: "sse" })
```

## Error Handling

All errors use Effect's `Schema.TaggedError` pattern with a `_tag` property:

| Error | `_tag` | Description |
|-------|--------|-------------|
| `StreamNotFoundError` | `"StreamNotFoundError"` | Stream does not exist (404) |
| `StreamConflictError` | `"StreamConflictError"` | Stream exists with different config (409) |
| `ContentTypeMismatchError` | `"ContentTypeMismatchError"` | Content-type mismatch |
| `InvalidOffsetError` | `"InvalidOffsetError"` | Invalid offset format |
| `SequenceConflictError` | `"SequenceConflictError"` | Sequence regression |
| `StaleEpochError` | `"StaleEpochError"` | Producer epoch is stale (403) |
| `SequenceGapError` | `"SequenceGapError"` | Producer sequence gap (409) |
| `ProducerClosedError` | `"ProducerClosedError"` | Producer is closed |
| `HttpError` | `"HttpError"` | HTTP error with status |
| `NetworkError` | `"NetworkError"` | Network failure |
| `TimeoutError` | `"TimeoutError"` | Request timeout |
| `ParseError` | `"ParseError"` | JSON parsing failed |

**Example error handling:**

```typescript
import { StreamNotFoundError, HttpError } from "@durable-streams/client-effect"

const program = Effect.gen(function* () {
  const client = yield* DurableStreamClient
  const result = yield* client.head(url)
  return result
}).pipe(
  Effect.catchTag("StreamNotFoundError", (error) =>
    Effect.log(`Stream not found: ${error.url}`)
  ),
  Effect.catchTag("HttpError", (error) =>
    Effect.log(`HTTP ${error.status}: ${error.statusText}`)
  )
)
```

## Layers

| Layer | Provides | Requires |
|-------|----------|----------|
| `DurableStreamClientLive(config?)` | `DurableStreamClient` | `DurableStreamsHttpClient` |
| `DurableStreamClientLiveNode(config?)` | `DurableStreamClient` | Nothing (complete layer) |

**Basic usage (Node.js):**

```typescript
const program = Effect.gen(function* () {
  const client = yield* DurableStreamClient
  // ...
})

Effect.runPromise(program.pipe(Effect.provide(DurableStreamClientLiveNode())))
```

**Custom HTTP client:**

```typescript
import { DurableStreamClientLive, DurableStreamsHttpClientLive } from "@durable-streams/client-effect"

const customLayer = DurableStreamClientLive().pipe(
  Layer.provide(DurableStreamsHttpClientLive({
    headers: {
      Authorization: () => `Bearer ${getToken()}`,
    },
  }))
)
```

## License

Apache-2.0
