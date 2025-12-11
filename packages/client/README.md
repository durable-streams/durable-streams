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

### Async Iterators

Async iterators provide backpressure-aware consumption. The next chunk is only fetched when you're ready.

#### `byteChunks(): AsyncIterable<ByteChunk>`

Iterates raw byte chunks with metadata.

```typescript
const res = await stream({ url, live: "auto" })

for await (const chunk of res.byteChunks()) {
  console.log("Received bytes:", chunk.data.length)
  console.log("Offset:", chunk.offset)
  console.log("Up to date:", chunk.upToDate)

  // Process the data
  const text = new TextDecoder().decode(chunk.data)
  await saveToDatabase(text, chunk.offset)
}
```

#### `jsonBatches(): AsyncIterable<JsonBatch<TJson>>`

Iterates JSON batches (arrays of items per response) with metadata. Efficient for batch processing.

```typescript
const res = await stream<{ event: string }>({ url, live: "auto" })

for await (const batch of res.jsonBatches()) {
  console.log(`Received ${batch.items.length} items`)
  console.log("Batch offset:", batch.offset)

  // Process all items in the batch
  await processBatch(batch.items)
  await saveCheckpoint(batch.offset)
}
```

#### `jsonItems(): AsyncIterable<TJson>`

Iterates individual JSON items (flattened from batches). Most ergonomic for item-by-item processing.

```typescript
const res = await stream<{ type: string; payload: unknown }>({
  url,
  live: "auto",
})

for await (const item of res.jsonItems()) {
  switch (item.type) {
    case "message":
      handleMessage(item.payload)
      break
    case "notification":
      handleNotification(item.payload)
      break
  }
  // Save offset after each item
  saveOffset(res.offset)
}
```

#### `textChunks(): AsyncIterable<TextChunk>`

Iterates text chunks with metadata.

```typescript
const res = await stream({ url, live: "auto" })

for await (const chunk of res.textChunks()) {
  console.log("Text:", chunk.text)
  console.log("Offset:", chunk.offset)

  // Append to log file
  await appendToLog(chunk.text)
}
```

#### Default Iterator `[Symbol.asyncIterator]`

The response itself is iterable, yielding `ByteChunk` objects:

```typescript
const res = await stream({ url, live: false })

for await (const chunk of res) {
  console.log("Chunk:", chunk.data)
}
```

### ReadableStreams

Web Streams API for piping to other streams or using with streaming APIs.

#### `bodyStream(): ReadableStream<Uint8Array>`

Raw bytes as a ReadableStream.

```typescript
const res = await stream({ url, live: false })
const readable = res.bodyStream()

// Pipe to a file (Node.js)
import { Writable } from "node:stream"
import { pipeline } from "node:stream/promises"

await pipeline(Readable.fromWeb(readable), fs.createWriteStream("output.bin"))

// Or read manually
const reader = readable.getReader()
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  console.log("Received:", value)
}
```

#### `jsonStream(): ReadableStream<TJson>`

Individual JSON items as a ReadableStream.

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

#### `textStream(): ReadableStream<string>`

Text chunks as a ReadableStream.

```typescript
const res = await stream({ url, live: false })
const readable = res.textStream()

// Use with Response API
const textResponse = new Response(readable)
const fullText = await textResponse.text()
```

### Subscribers

Subscribers provide callback-based consumption with backpressure. The next chunk isn't fetched until your callback's promise resolves.

#### `subscribeJson(callback): () => void`

Subscribe to JSON batches. Returns an unsubscribe function.

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

Subscribe to byte chunks.

```typescript
const res = await stream({ url, live: "auto" })

const unsubscribe = res.subscribeBytes(async (chunk) => {
  await writeToFile(chunk.data)
  console.log("Written", chunk.data.length, "bytes")
})
```

#### `subscribeText(callback): () => void`

Subscribe to text chunks.

```typescript
const res = await stream({ url, live: "auto" })

const unsubscribe = res.subscribeText(async (chunk) => {
  await appendToLog(chunk.text)
})
```

### Lifecycle

#### `cancel(reason?: unknown): void`

Cancel the stream session. Aborts any pending requests.

```typescript
const res = await stream({ url, live: "auto" })

// Start consuming
const consumer = (async () => {
  for await (const chunk of res.byteChunks()) {
    console.log("Chunk:", chunk)
  }
})()

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
  auth: { token: "my-token" },
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
  auth: { token: "my-token" },
})

console.log("Content-Type:", handle.contentType)
```

#### `DurableStream.head(opts): Promise<HeadResult>`

Get stream metadata without creating a handle.

```typescript
const metadata = await DurableStream.head({
  url: "https://streams.example.com/my-stream",
  auth: { token: "my-token" },
})

console.log("Offset:", metadata.offset)
console.log("Content-Type:", metadata.contentType)
```

#### `DurableStream.delete(opts): Promise<void>`

Delete a stream without creating a handle.

```typescript
await DurableStream.delete({
  url: "https://streams.example.com/my-stream",
  auth: { token: "my-token" },
})
```

### Instance Methods

#### `head(opts?): Promise<HeadResult>`

Get metadata for this stream.

```typescript
const handle = new DurableStream({ url, auth })
const metadata = await handle.head()

console.log("Current offset:", metadata.offset)
```

#### `create(opts?): Promise<this>`

Create this stream on the server.

```typescript
const handle = new DurableStream({ url, auth })
await handle.create({
  contentType: "text/plain",
  ttlSeconds: 7200,
})
```

#### `delete(opts?): Promise<void>`

Delete this stream.

```typescript
const handle = new DurableStream({ url, auth })
await handle.delete()
```

#### `append(body, opts?): Promise<void>`

Append data to the stream.

```typescript
const handle = await DurableStream.connect({ url, auth })

// Append string
await handle.append("Hello, world!")

// Append with sequence number for ordering
await handle.append("Message 1", { seq: "writer-1-001" })
await handle.append("Message 2", { seq: "writer-1-002" })

// Append JSON (as string)
await handle.append(JSON.stringify({ event: "click", x: 100, y: 200 }))
```

#### `appendStream(source, opts?): Promise<void>`

Append streaming data from an async iterable or ReadableStream.

```typescript
const handle = await DurableStream.connect({ url, auth })

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
```

#### `stream(opts?): Promise<StreamResponse>`

Start a read session (same as standalone `stream()` function).

```typescript
const handle = await DurableStream.connect({ url, auth })

const res = await handle.stream<{ message: string }>({
  offset: savedOffset,
  live: "auto",
})

for await (const item of res.jsonItems()) {
  console.log(item.message)
}
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
