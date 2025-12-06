# durable-stream

TypeScript client for the Electric Durable Streams protocol.

## Installation

```bash
npm install durable-stream
```

## Overview

The Durable Streams client exposes a single class: `DurableStream`.

A `DurableStream` instance is a **handle to a remote stream**, similar to a file handle:

- It refers to one stream URL
- It carries the auth and transport configuration needed to talk to that stream
- It exposes methods to: create/delete the stream, append data, and read from the stream

The handle is **lightweight** and **reusable**. It does not represent a single read session.

## Usage

### Create and append

```typescript
import { DurableStream } from "durable-stream"

const stream = await DurableStream.create({
  url: "https://streams.example.com/my-account/chat/room-1",
  auth: { token: process.env.DS_TOKEN! },
  contentType: "application/json",
  ttlSeconds: 3600,
})

// Append UTF-8 encoded JSON
await stream.append(JSON.stringify({ type: "message", text: "Hello" }), {
  seq: "writer-1-000001",
})
```

### Read with live updates (default)

```typescript
const stream = await DurableStream.connect({
  url: "https://streams.example.com/my-account/chat/room-1",
  auth: { token: process.env.DS_TOKEN! },
})

// Read from the stream with live updates (default behavior)
for await (const chunk of stream.read()) {
  // chunk.data is Uint8Array
  const text = new TextDecoder().decode(chunk.data)
  console.log("chunk:", text)

  // Persist the offset if you want to resume later:
  saveOffset(chunk.offset)

  if (chunk.upToDate) {
    // Safe to flush/apply accumulated messages
    flush()
  }
}
```

### Read from "now" (skip existing data)

```typescript
// HEAD gives you the current tail offset if the server exposes it
const { offset } = await stream.head()

// Read only new data from that point on
for await (const chunk of stream.read({ offset })) {
  console.log("new data:", new TextDecoder().decode(chunk.data))
}
```

### Read catch-up only (no live updates)

```typescript
// Read existing data only, stop when up-to-date
for await (const chunk of stream.read({ live: false })) {
  console.log("existing data:", new TextDecoder().decode(chunk.data))
}
// Iteration completes when stream is up-to-date
```

### Pipe via ReadableStream

```typescript
const rs = stream.toReadableStream({ offset: savedOffset })

await rs
  .pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk.data)
      },
    })
  )
  .pipeTo(someWritableStream)
```

### Get raw bytes

```typescript
// toByteStream() returns ReadableStream<Uint8Array>
const byteStream = stream.toByteStream({ offset: savedOffset })
await byteStream.pipeTo(destination)
```

## API

### `DurableStream`

```typescript
class DurableStream {
  readonly url: string
  readonly contentType?: string

  constructor(opts: DurableStreamOptions)

  // Static methods
  static create(opts: CreateOptions): Promise<DurableStream>
  static connect(opts: StreamOptions): Promise<DurableStream>
  static head(opts: StreamOptions): Promise<HeadResult>
  static delete(opts: StreamOptions): Promise<void>

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
  read(opts?: ReadOptions): AsyncIterable<StreamChunk>
  toReadableStream(opts?: ReadOptions): ReadableStream<StreamChunk>
  toByteStream(opts?: ReadOptions): ReadableStream<Uint8Array>
  json<T>(opts?: ReadOptions): AsyncIterable<T>
  text(opts?: ReadOptions): AsyncIterable<string>
}
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
import { DurableStream, FetchError, DurableStreamError } from "durable-stream"

const stream = new DurableStream({
  url: "https://streams.example.com/my-stream",
  auth: { token: "my-token" },
  onError: async (error) => {
    if (error instanceof FetchError) {
      // Transport error
      if (error.status === 401) {
        const newToken = await refreshAuthToken()
        return { headers: { Authorization: `Bearer ${newToken}` } }
      }
    }
    if (error instanceof DurableStreamError) {
      // Protocol error
      console.error(`Stream error: ${error.code}`)
    }
    return {} // Retry with same params
  },
})
```

### Live Modes

```typescript
// Default: catch-up then auto-select SSE or long-poll for live updates
for await (const chunk of stream.read()) { ... }

// Catch-up only (no live updates, stop at upToDate)
for await (const chunk of stream.read({ live: false })) { ... }

// Long-poll mode for live updates
for await (const chunk of stream.read({ live: 'long-poll' })) { ... }

// SSE mode for live updates (throws if content-type doesn't support SSE)
for await (const chunk of stream.read({ live: 'sse' })) { ... }
```

## Types

Key types exported from the package:

- `Offset` - Opaque string for stream position
- `StreamChunk` / `ReadResult` - Data returned from reads
- `HeadResult` - Metadata from HEAD requests
- `DurableStreamError` - Protocol-level errors with codes
- `FetchError` - Transport/network errors

## License

Apache-2.0
