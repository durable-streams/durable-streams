# @durable-streams/client

TypeScript client for the Electric Durable Streams protocol.

## Overview

The Durable Streams client provides two main APIs:

1. **`stream()` function** - A fetch-like read-only API for consuming streams
2. **`DurableStream` class** - A handle for read/write operations on a stream

## Usage

### Read-only: Using `stream()` (fetch-like API)

The `stream()` function provides a simple, fetch-like interface for reading from streams:

```typescript
import { stream } from "@durable-streams/client"

// Connect and get a StreamResponse
const res = await stream<{ message: string }>({
  url: "https://streams.example.com/my-account/chat/room-1",
  auth: { token: process.env.DS_TOKEN! },
  offset: savedOffset, // optional: resume from offset
  live: "auto", // default: behavior driven by consumption method
})

// Accumulate all JSON items until up-to-date
const items = await res.json()
console.log("All items:", items)

// Or iterate live
for await (const item of res.jsonItems()) {
  console.log("item:", item)
  saveOffset(res.offset) // persist for resumption
}
```

### StreamResponse consumption methods

The `StreamResponse` object returned by `stream()` offers multiple ways to consume data:

```typescript
// Promise helpers (accumulate until first upToDate)
const bytes = await res.body()        // Uint8Array
const items = await res.json()        // Array<TJson>
const text = await res.text()         // string

// ReadableStreams
const byteStream = res.bodyStream()   // ReadableStream<Uint8Array>
const jsonStream = res.jsonStream()   // ReadableStream<TJson>
const textStream = res.textStream()   // ReadableStream<string>

// AsyncIterators
for await (const chunk of res.byteChunks()) { ... }
for await (const batch of res.jsonBatches()) { ... }
for await (const item of res.jsonItems()) { ... }
for await (const chunk of res.textChunks()) { ... }

// Subscribers (with backpressure)
const unsubscribe = res.subscribeJson(async (batch) => {
  await processBatch(batch.items)
})
```

### Read/Write: Using `DurableStream`

For write operations or when you need a persistent handle:

```typescript
import { DurableStream } from "@durable-streams/client"

// Create a new stream
const handle = await DurableStream.create({
  url: "https://streams.example.com/my-account/chat/room-1",
  auth: { token: process.env.DS_TOKEN! },
  contentType: "application/json",
  ttlSeconds: 3600,
})

// Append data
await handle.append(JSON.stringify({ type: "message", text: "Hello" }), {
  seq: "writer-1-000001",
})

// Read using the new stream() API
const res = await handle.stream<{ type: string; text: string }>()
for await (const item of res.jsonItems()) {
  console.log("message:", item.text)
}
```

### Read from "now" (skip existing data)

```typescript
// HEAD gives you the current tail offset if the server exposes it
const handle = await DurableStream.connect({ url, auth })
const { offset } = await handle.head()

// Read only new data from that point on
const res = await handle.stream({ offset })
for await (const chunk of res.byteChunks()) {
  console.log("new data:", new TextDecoder().decode(chunk.data))
}
```

### Read catch-up only (no live updates)

```typescript
// Read existing data only, stop when up-to-date
const res = await stream({
  url: "https://streams.example.com/my-stream",
  live: false,
})

const text = await res.text()
console.log("All existing data:", text)
```

## API

### `stream(options): Promise<StreamResponse>`

Creates a fetch-like streaming session:

```typescript
const res = await stream<TJson>({
  url: string | URL,         // Stream URL
  auth?: Auth,               // Authentication
  headers?: HeadersInit,     // Additional headers
  signal?: AbortSignal,      // Cancellation
  fetchClient?: typeof fetch,// Custom fetch implementation
  offset?: Offset,           // Starting offset (default: start of stream)
  live?: LiveMode,           // Live mode (default: "auto")
  json?: boolean,            // Force JSON mode
  onError?: StreamErrorHandler, // Error handler
})
```

### `DurableStream`

```typescript
class DurableStream {
  readonly url: string
  readonly contentType?: string

  constructor(opts: DurableStreamConstructorOptions)

  // Static methods
  static create(opts: CreateOptions): Promise<DurableStream>
  static connect(opts: DurableStreamOptions): Promise<DurableStream>
  static head(opts: DurableStreamOptions): Promise<HeadResult>
  static delete(opts: DurableStreamOptions): Promise<void>

  // Instance methods
  head(opts?: { signal?: AbortSignal }): Promise<HeadResult>
  create(opts?: CreateOptions): Promise<this>
  delete(opts?: { signal?: AbortSignal }): Promise<void>
  append(
    body: BodyInit | Uint8Array | string,
    opts?: AppendOptions
  ): Promise<void>
  appendStream(
    source: AsyncIterable<Uint8Array | string>,
    opts?: AppendOptions
  ): Promise<void>

  // Fetch-like read API
  stream<TJson>(opts?: StreamOptions): Promise<StreamResponse<TJson>>
}
```

### Live Modes

```typescript
// "auto" (default): behavior driven by consumption method
// - Promise helpers (body/json/text): stop after upToDate
// - Iterators/streams/subscribers: continue with long-poll

// false: catch-up only, stop at first upToDate
const res = await stream({ url, live: false })

// "long-poll": explicit long-poll mode for live updates
const res = await stream({ url, live: "long-poll" })

// "sse": explicit SSE mode for live updates
const res = await stream({ url, live: "sse" })
```

### Authentication

```typescript
// Fixed token (sent as Bearer token in Authorization header)
{ auth: { token: 'my-token' } }

// Custom header name
{ auth: { token: 'my-token', headerName: 'x-api-key' } }

// Static headers
{ auth: { headers: { 'Authorization': 'Bearer my-token' } } }

// Async headers (for refreshing tokens)
{
  auth: {
    getHeaders: async () => {
      const token = await refreshToken()
      return { Authorization: `Bearer ${token}` }
    }
  }
}
```

### Error Handling

```typescript
import { stream, FetchError, DurableStreamError } from "@durable-streams/client"

const res = await stream({
  url: "https://streams.example.com/my-stream",
  auth: { token: "my-token" },
  onError: async (error) => {
    if (error instanceof FetchError) {
      if (error.status === 401) {
        const newToken = await refreshAuthToken()
        return { headers: { Authorization: `Bearer ${newToken}` } }
      }
    }
    if (error instanceof DurableStreamError) {
      console.error(`Stream error: ${error.code}`)
    }
    return {} // Retry with same params
  },
})
```

## Types

Key types exported from the package:

- `Offset` - Opaque string for stream position
- `StreamResponse` - Response object from stream()
- `ByteChunk` / `JsonBatch` / `TextChunk` - Data types for consumption
- `HeadResult` - Metadata from HEAD requests
- `DurableStreamError` - Protocol-level errors with codes
- `FetchError` - Transport/network errors

## License

Apache-2.0
