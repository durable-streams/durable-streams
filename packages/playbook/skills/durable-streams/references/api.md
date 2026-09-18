# Durable Streams API Reference

## stream(options): Promise<StreamResponse>

Creates a fetch-like streaming session.

```typescript
const res = await stream<TJson>({
  url: string | URL,              // Stream URL
  headers?: HeadersRecord,        // Headers (static or function)
  params?: ParamsRecord,          // Query params (static or function)
  signal?: AbortSignal,           // Cancellation
  fetch?: typeof fetch,           // Custom fetch
  backoffOptions?: BackoffOptions,// Retry config
  offset?: Offset,                // Starting offset (default: "-1")
  live?: LiveMode,                // Live mode (default: true)
  json?: boolean,                 // Force JSON mode
  onError?: StreamErrorHandler,   // Error handler
})
```

### Live Modes

- `true` (default) - Auto-select (SSE for JSON, long-poll for binary)
- `false` - Catch-up only, stop at first upToDate
- `"long-poll"` - Explicit long-poll
- `"sse"` - Explicit SSE

## DurableStream

```typescript
class DurableStream {
  readonly url: string
  readonly contentType?: string

  // Static methods
  static create(opts: CreateOptions): Promise<DurableStream>
  static connect(opts: DurableStreamOptions): Promise<DurableStream>
  static head(opts: DurableStreamOptions): Promise<HeadResult>
  static delete(opts: DurableStreamOptions): Promise<void>

  // Instance methods
  head(opts?): Promise<HeadResult>
  create(opts?): Promise<this>
  delete(opts?): Promise<void>
  append(
    body: Uint8Array | string | Promise<Uint8Array | string>,
    opts?: AppendOptions
  ): Promise<void>
  appendStream(source: AsyncIterable<Uint8Array | string>, opts?): Promise<void>
  writable(opts?): WritableStream<Uint8Array | string>
  stream<TJson>(opts?): Promise<StreamResponse<TJson>>
}
```

### CreateOptions

```typescript
interface CreateOptions {
  url: string | URL
  headers?: HeadersRecord
  contentType?: string // "application/json" for JSON mode
  ttlSeconds?: number // Auto-delete after N seconds
  signal?: AbortSignal
}
```

### AppendOptions

```typescript
interface AppendOptions {
  seq?: string // Sequence number for ordering
  signal?: AbortSignal
}
```

### writable(opts?)

Creates a `WritableStream` for piping data to the stream. Uses `IdempotentProducer` internally.

```typescript
writable(opts?: {
  producerId?: string       // Producer ID (auto-generated if omitted)
  lingerMs?: number         // Batch wait time
  maxBatchBytes?: number    // Max batch size
  onError?: (err: Error) => void  // Error callback
  signal?: AbortSignal      // Cancellation
}): WritableStream<Uint8Array | string>
```

**Usage:**

```typescript
// Pipe from any ReadableStream
await someReadableStream.pipeTo(handle.writable())

// Pipe through a transform
const readable = inputStream.pipeThrough(new TextEncoderStream())
await readable.pipeTo(handle.writable())

// With options
await source.pipeTo(
  handle.writable({
    lingerMs: 10,
    maxBatchBytes: 64 * 1024,
  })
)
```

## StreamResponse

Response object from `stream()` with multiple consumption methods.

### Promise Helpers (accumulate until upToDate)

```typescript
res.body(): Promise<Uint8Array>
res.json(): Promise<T[]>
res.text(): Promise<string>
```

### ReadableStreams

```typescript
res.bodyStream(): ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>
res.jsonStream(): ReadableStream<T> & AsyncIterable<T>
res.textStream(): ReadableStream<string> & AsyncIterable<string>
```

### Subscribers (backpressure-aware)

```typescript
res.subscribeJson(callback: (batch: JsonBatch<T>) => Promise<void>): () => void
res.subscribeBytes(callback: (chunk: ByteChunk) => Promise<void>): () => void
res.subscribeText(callback: (chunk: TextChunk) => Promise<void>): () => void
```

### Lifecycle

```typescript
res.cancel(reason?: unknown): void  // Cancel session
res.closed: Promise<void>           // Resolves when complete
```

### State Properties

```typescript
res.url: string              // Stream URL
res.contentType: string      // Content-Type
res.live: LiveMode           // Live mode
res.startOffset: Offset      // Starting offset
res.offset: Offset           // Current offset
res.cursor?: string          // Cursor for collapsing
res.upToDate: boolean        // Caught up to head
```

## IdempotentProducer

Kafka-style exactly-once producer with batching and pipelining.

```typescript
new IdempotentProducer(
  stream: DurableStream,
  producerId: string,
  opts?: IdempotentProducerOptions
)
```

### Options

```typescript
interface IdempotentProducerOptions {
  epoch?: number // Starting epoch (default: 0)
  autoClaim?: boolean // On 403, retry with epoch+1 (default: false)
  maxBatchBytes?: number // Max bytes per batch (default: 1MB)
  lingerMs?: number // Wait time for batching (default: 5ms)
  maxInFlight?: number // Concurrent batches (default: 5)
  signal?: AbortSignal // Cancellation
  fetch?: typeof fetch // Custom fetch
  onError?: (error: Error) => void // Error callback
}
```

### Methods

```typescript
append(body: string | Uint8Array): void  // Fire-and-forget, use JSON.stringify() for objects
flush(): Promise<void>     // Send pending, wait for all
close(): Promise<void>     // Flush and close
restart(): Promise<void>   // Increment epoch, reset seq
```

### Properties

```typescript
epoch: number // Current epoch
nextSeq: number // Next sequence number
pendingCount: number // Messages in pending batch
inFlightCount: number // Batches in flight
```

## Types

```typescript
type Offset = string

interface ByteChunk {
  data: Uint8Array
  offset: Offset
  upToDate: boolean
  cursor?: string
}

interface JsonBatch<T> {
  items: T[]
  offset: Offset
  upToDate: boolean
  cursor?: string
}

interface TextChunk {
  text: string
  offset: Offset
  upToDate: boolean
  cursor?: string
}

interface HeadResult {
  exists: true // Always true (throws if stream doesn't exist)
  contentType?: string // Stream's content type
  offset?: Offset // Tail offset (next offset after end of stream)
  etag?: string // ETag for the stream
  cacheControl?: string // Cache-Control header value
}
```

## Headers and Params

Support static values and functions:

```typescript
// Static
{ Authorization: "Bearer token" }

// Sync function
{ Authorization: () => `Bearer ${getCurrentToken()}` }

// Async function
{ Authorization: async () => `Bearer ${await refreshToken()}` }

// Mixed
{
  "X-Static": "value",
  Authorization: async () => `Bearer ${await getToken()}`,
}
```
