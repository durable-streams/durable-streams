# @durable-streams/client

TypeScript client for the Durable Streams protocol.

## Installation

```bash
npm install @durable-streams/client
```

## Overview

The Durable Streams client provides two main APIs:

1. **`stream()` function** - A fetch-like read-only API for consuming streams
2. **`DurableStream` class** - A handle for read/write operations on a stream

## Key Features

- **Automatic Batching**: Multiple `append()` calls are automatically batched together when a POST is in-flight, significantly improving throughput for high-frequency writes
- **Streaming Reads**: `stream()` and `DurableStream.stream()` provide rich consumption options (promises, ReadableStreams, subscribers)
- **Resumable**: Offset-based reads let you resume from any point
- **Real-time**: Long-poll and SSE modes for live tailing with catch-up from any offset

## Usage

### Read-only: Using `stream()` (fetch-like API)

The `stream()` function provides a simple, fetch-like interface for reading from streams:

```typescript
import { stream } from "@durable-streams/client"

// Connect and get a StreamResponse
const res = await stream<{ message: string }>({
  url: "https://streams.example.com/my-account/chat/room-1",
  headers: {
    Authorization: `Bearer ${process.env.DS_TOKEN!}`,
  },
  offset: savedOffset, // optional: resume from offset
  live: "auto", // default: behavior driven by consumption method
})

// Accumulate all JSON items until up-to-date
const items = await res.json()
console.log("All items:", items)

// Or stream live with a subscriber
res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log("item:", item)
    saveOffset(batch.offset) // persist for resumption
  }
})
```

### StreamResponse consumption methods

The `StreamResponse` object returned by `stream()` offers multiple ways to consume data:

```typescript
// Promise helpers (accumulate until first upToDate)
const bytes = await res.body() // Uint8Array
const items = await res.json() // Array<TJson>
const text = await res.text() // string

// ReadableStreams
const byteStream = res.bodyStream() // ReadableStream<Uint8Array>
const jsonStream = res.jsonStream() // ReadableStream<TJson>
const textStream = res.textStream() // ReadableStream<string>

// Subscribers (with backpressure)
const unsubscribe = res.subscribeJson(async (batch) => {
  await processBatch(batch.items)
})
const unsubscribe2 = res.subscribeBytes(async (chunk) => {
  await processBytes(chunk.data)
})
const unsubscribe3 = res.subscribeText(async (chunk) => {
  await processText(chunk.text)
})
```

### Read/Write: Using `DurableStream`

For write operations or when you need a persistent handle:

```typescript
import { DurableStream } from "@durable-streams/client"

// Create a new stream
const handle = await DurableStream.create({
  url: "https://streams.example.com/my-account/chat/room-1",
  headers: {
    Authorization: `Bearer ${process.env.DS_TOKEN!}`,
  },
  contentType: "application/json",
  ttlSeconds: 3600,
})

// Append data
await handle.append(JSON.stringify({ type: "message", text: "Hello" }), {
  seq: "writer-1-000001",
})

// Read using the new stream() API
const res = await handle.stream<{ type: string; text: string }>()
res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log("message:", item.text)
  }
})
```

### Read from "now" (skip existing data)

```typescript
// HEAD gives you the current tail offset if the server exposes it
const handle = await DurableStream.connect({
  url,
  headers: { Authorization: `Bearer ${token}` },
})
const { offset } = await handle.head()

// Read only new data from that point on
const res = await handle.stream({ offset })
res.subscribeBytes(async (chunk) => {
  console.log("new data:", new TextDecoder().decode(chunk.data))
})
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
  url: string | URL,              // Stream URL
  headers?: HeadersRecord,        // Headers (static or function-based)
  params?: ParamsRecord,          // Query params (static or function-based)
  signal?: AbortSignal,           // Cancellation
  fetch?: typeof fetch,           // Custom fetch implementation
  backoffOptions?: BackoffOptions,// Retry backoff configuration
  offset?: Offset,                // Starting offset (default: start of stream)
  live?: LiveMode,                // Live mode (default: "auto")
  json?: boolean,                 // Force JSON mode
  onError?: StreamErrorHandler,   // Error handler
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
// - Streams/subscribers: continue with long-poll

// false: catch-up only, stop at first upToDate
const res = await stream({ url, live: false })

// "long-poll": explicit long-poll mode for live updates
const res = await stream({ url, live: "long-poll" })

// "sse": explicit SSE mode for live updates
const res = await stream({ url, live: "sse" })
```

### Headers and Params

Headers and params support both static values and functions (sync or async) for dynamic values like authentication tokens.

```typescript
// Static headers
{
  headers: {
    Authorization: "Bearer my-token",
    "X-Custom-Header": "value",
  }
}

// Function-based headers (sync)
{
  headers: {
    Authorization: () => `Bearer ${getCurrentToken()}`,
    "X-Tenant-Id": () => getCurrentTenant(),
  }
}

// Async function headers (for refreshing tokens)
{
  headers: {
    Authorization: async () => {
      const token = await refreshToken()
      return `Bearer ${token}`
    }
  }
}

// Mix static and function headers
{
  headers: {
    "X-Static": "always-the-same",
    Authorization: async () => `Bearer ${await getToken()}`,
  }
}

// Query params work the same way
{
  params: {
    tenant: "static-tenant",
    region: () => getCurrentRegion(),
    token: async () => await getSessionToken(),
  }
}
```

### Error Handling

```typescript
import { stream, FetchError, DurableStreamError } from "@durable-streams/client"

const res = await stream({
  url: "https://streams.example.com/my-stream",
  headers: {
    Authorization: "Bearer my-token",
  },
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

## StreamResponse Methods

The `StreamResponse` object provides multiple ways to consume stream data. All methods respect the `live` mode setting.

### Promise Helpers

These methods accumulate data until the stream is up-to-date, then resolve.

#### `body(): Promise<Uint8Array>`

Accumulates all bytes until up-to-date.

```typescript
const res = await stream({ url, live: false })
const bytes = await res.body()
console.log("Total bytes:", bytes.length)

// Process as needed
const text = new TextDecoder().decode(bytes)
```

#### `json(): Promise<Array<TJson>>`

Accumulates all JSON items until up-to-date. Only works with JSON content.

```typescript
const res = await stream<{ id: number; name: string }>({
  url,
  live: false,
})
const items = await res.json()

for (const item of items) {
  console.log(`User ${item.id}: ${item.name}`)
}
```

#### `text(): Promise<string>`

Accumulates all text until up-to-date.

```typescript
const res = await stream({ url, live: false })
const text = await res.text()
console.log("Full content:", text)
```

### ReadableStreams

Web Streams API for piping to other streams or using with streaming APIs. ReadableStreams can be consumed using either `getReader()` or `for await...of` syntax.

> **Safari/iOS Compatibility**: The client ensures all returned streams are async-iterable by defining `[Symbol.asyncIterator]` on stream instances when missing. This allows `for await...of` consumption without requiring a global polyfill, while preserving `instanceof ReadableStream` behavior.
>
> **Derived streams**: Streams created via `.pipeThrough()` or similar transformations are NOT automatically patched. Use the exported `asAsyncIterableReadableStream()` helper:
>
> ```typescript
> import { asAsyncIterableReadableStream } from "@durable-streams/client"
>
> const derived = res.bodyStream().pipeThrough(myTransform)
> const iterable = asAsyncIterableReadableStream(derived)
> for await (const chunk of iterable) { ... }
> ```

#### `bodyStream(): ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>`

Raw bytes as a ReadableStream.

**Using `getReader()`:**

```typescript
const res = await stream({ url, live: false })
const readable = res.bodyStream()

const reader = readable.getReader()
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  console.log("Received:", value.length, "bytes")
}
```

**Using `for await...of`:**

```typescript
const res = await stream({ url, live: false })

for await (const chunk of res.bodyStream()) {
  console.log("Received:", chunk.length, "bytes")
}
```

**Piping to a file (Node.js):**

```typescript
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

const res = await stream({ url, live: false })
await pipeline(
  Readable.fromWeb(res.bodyStream()),
  fs.createWriteStream("output.bin")
)
```

#### `jsonStream(): ReadableStream<TJson> & AsyncIterable<TJson>`

Individual JSON items as a ReadableStream.

**Using `getReader()`:**

```typescript
const res = await stream<{ id: number }>({ url, live: false })
const readable = res.jsonStream()

const reader = readable.getReader()
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  console.log("Item:", value)
}
```

**Using `for await...of`:**

```typescript
const res = await stream<{ id: number; name: string }>({ url, live: false })

for await (const item of res.jsonStream()) {
  console.log(`User ${item.id}: ${item.name}`)
}
```

#### `textStream(): ReadableStream<string> & AsyncIterable<string>`

Text chunks as a ReadableStream.

**Using `getReader()`:**

```typescript
const res = await stream({ url, live: false })
const readable = res.textStream()

const reader = readable.getReader()
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  console.log("Text chunk:", value)
}
```

**Using `for await...of`:**

```typescript
const res = await stream({ url, live: false })

for await (const text of res.textStream()) {
  console.log("Text chunk:", text)
}
```

**Using with Response API:**

```typescript
const res = await stream({ url, live: false })
const textResponse = new Response(res.textStream())
const fullText = await textResponse.text()
```

### Subscribers

Subscribers provide callback-based consumption with backpressure. The next chunk isn't fetched until your callback's promise resolves. Returns an unsubscribe function.

#### `subscribeJson(callback): () => void`

Subscribe to JSON batches with metadata. Provides backpressure-aware consumption.

```typescript
const res = await stream<{ event: string }>({ url, live: "auto" })

const unsubscribe = res.subscribeJson(async (batch) => {
  // Process items - next batch waits until this resolves
  for (const item of batch.items) {
    await processEvent(item)
  }
  await saveCheckpoint(batch.offset)
})

// Later: stop receiving updates
setTimeout(() => {
  unsubscribe()
}, 60000)
```

#### `subscribeBytes(callback): () => void`

Subscribe to byte chunks with metadata.

```typescript
const res = await stream({ url, live: "auto" })

const unsubscribe = res.subscribeBytes(async (chunk) => {
  console.log("Received bytes:", chunk.data.length)
  console.log("Offset:", chunk.offset)
  console.log("Up to date:", chunk.upToDate)

  await writeToFile(chunk.data)
  await saveCheckpoint(chunk.offset)
})
```

#### `subscribeText(callback): () => void`

Subscribe to text chunks with metadata.

```typescript
const res = await stream({ url, live: "auto" })

const unsubscribe = res.subscribeText(async (chunk) => {
  console.log("Text:", chunk.text)
  console.log("Offset:", chunk.offset)

  await appendToLog(chunk.text)
})
```

### Lifecycle

#### `cancel(reason?: unknown): void`

Cancel the stream session. Aborts any pending requests.

```typescript
const res = await stream({ url, live: "auto" })

// Start consuming
res.subscribeBytes(async (chunk) => {
  console.log("Chunk:", chunk)
})

// Cancel after 10 seconds
setTimeout(() => {
  res.cancel("Timeout")
}, 10000)
```

#### `closed: Promise<void>`

Promise that resolves when the session is complete or cancelled.

```typescript
const res = await stream({ url, live: false })

// Start consuming in background
const consumer = res.text()

// Wait for completion
await res.closed
console.log("Stream fully consumed")
```

### State Properties

```typescript
const res = await stream({ url })

res.url // The stream URL
res.contentType // Content-Type from response headers
res.live // The live mode ("auto", "long-poll", "sse", or false)
res.startOffset // The starting offset passed to stream()
res.offset // Current offset (updates as data is consumed)
res.cursor // Cursor for collapsing (if provided by server)
res.upToDate // Whether we've caught up to the stream head
```

---

## DurableStream Methods

### Static Methods

#### `DurableStream.create(opts): Promise<DurableStream>`

Create a new stream on the server.

```typescript
const handle = await DurableStream.create({
  url: "https://streams.example.com/my-stream",
  headers: {
    Authorization: "Bearer my-token",
  },
  contentType: "application/json",
  ttlSeconds: 3600, // Optional: auto-delete after 1 hour
})

await handle.append('{"hello": "world"}')
```

#### `DurableStream.connect(opts): Promise<DurableStream>`

Connect to an existing stream (validates it exists via HEAD).

```typescript
const handle = await DurableStream.connect({
  url: "https://streams.example.com/my-stream",
  headers: {
    Authorization: "Bearer my-token",
  },
})

console.log("Content-Type:", handle.contentType)
```

#### `DurableStream.head(opts): Promise<HeadResult>`

Get stream metadata without creating a handle.

```typescript
const metadata = await DurableStream.head({
  url: "https://streams.example.com/my-stream",
  headers: {
    Authorization: "Bearer my-token",
  },
})

console.log("Offset:", metadata.offset)
console.log("Content-Type:", metadata.contentType)
```

#### `DurableStream.delete(opts): Promise<void>`

Delete a stream without creating a handle.

```typescript
await DurableStream.delete({
  url: "https://streams.example.com/my-stream",
  headers: {
    Authorization: "Bearer my-token",
  },
})
```

### Instance Methods

#### `head(opts?): Promise<HeadResult>`

Get metadata for this stream.

```typescript
const handle = new DurableStream({
  url,
  headers: { Authorization: `Bearer ${token}` },
})
const metadata = await handle.head()

console.log("Current offset:", metadata.offset)
```

#### `create(opts?): Promise<this>`

Create this stream on the server.

```typescript
const handle = new DurableStream({
  url,
  headers: { Authorization: `Bearer ${token}` },
})
await handle.create({
  contentType: "text/plain",
  ttlSeconds: 7200,
})
```

#### `delete(opts?): Promise<void>`

Delete this stream.

```typescript
const handle = new DurableStream({
  url,
  headers: { Authorization: `Bearer ${token}` },
})
await handle.delete()
```

#### `append(body, opts?): Promise<void>`

Append data to the stream. By default, **automatic batching is enabled**: multiple `append()` calls made while a POST is in-flight will be batched together into a single request. This significantly improves throughput for high-frequency writes.

```typescript
const handle = await DurableStream.connect({
  url,
  headers: { Authorization: `Bearer ${token}` },
})

// Append string
await handle.append("Hello, world!")

// Append with sequence number for ordering
await handle.append("Message 1", { seq: "writer-1-001" })
await handle.append("Message 2", { seq: "writer-1-002" })

// For JSON streams, append objects directly (serialized automatically)
await handle.append({ event: "click", x: 100, y: 200 })

// Batching happens automatically - these may be sent in a single request
await Promise.all([
  handle.append({ event: "msg1" }),
  handle.append({ event: "msg2" }),
  handle.append({ event: "msg3" }),
])
```

**Batching behavior:**

- **JSON mode** (`contentType: "application/json"`): Multiple values are sent as a JSON array `[val1, val2, ...]`
- **Byte mode**: Binary data is concatenated

**Disabling batching:**

If you need to ensure each append is sent immediately (e.g., for precise timing or debugging):

```typescript
const handle = new DurableStream({
  url,
  batching: false, // Disable automatic batching
})
```

#### `appendStream(source, opts?): Promise<void>`

Append streaming data from an async iterable or ReadableStream. This method supports piping from any source.

```typescript
const handle = await DurableStream.connect({
  url,
  headers: { Authorization: `Bearer ${token}` },
})

// From async generator
async function* generateData() {
  for (let i = 0; i < 100; i++) {
    yield `Line ${i}\n`
  }
}
await handle.appendStream(generateData())

// From ReadableStream
const readable = new ReadableStream({
  start(controller) {
    controller.enqueue("chunk 1")
    controller.enqueue("chunk 2")
    controller.close()
  },
})
await handle.appendStream(readable)

// Pipe from a fetch response body
const response = await fetch("https://example.com/data")
await handle.appendStream(response.body!)
```

#### `writable(opts?): WritableStream<Uint8Array | string>`

Create a WritableStream that can receive piped data. Useful for stream composition:

```typescript
const handle = await DurableStream.connect({ url, auth })

// Pipe from any ReadableStream
await someReadableStream.pipeTo(handle.writable())

// Pipe through a transform
const readable = inputStream.pipeThrough(new TextEncoderStream())
await readable.pipeTo(handle.writable())
```

#### `stream(opts?): Promise<StreamResponse>`

Start a read session (same as standalone `stream()` function).

```typescript
const handle = await DurableStream.connect({
  url,
  headers: { Authorization: `Bearer ${token}` },
})

const res = await handle.stream<{ message: string }>({
  offset: savedOffset,
  live: "auto",
})

res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log(item.message)
  }
})
```

---

## Types

Key types exported from the package:

- `Offset` - Opaque string for stream position
- `StreamResponse` - Response object from stream()
- `ByteChunk` - `{ data: Uint8Array, offset: Offset, upToDate: boolean, cursor?: string }`
- `JsonBatch<T>` - `{ items: T[], offset: Offset, upToDate: boolean, cursor?: string }`
- `TextChunk` - `{ text: string, offset: Offset, upToDate: boolean, cursor?: string }`
- `HeadResult` - Metadata from HEAD requests
- `DurableStreamError` - Protocol-level errors with codes
- `FetchError` - Transport/network errors

## License

Apache-2.0
