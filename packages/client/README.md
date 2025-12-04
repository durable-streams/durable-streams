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
- It exposes methods to: create/delete the stream, append data, read a slice, follow the stream as it grows

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

### Follow from "now"

```typescript
const stream = await DurableStream.connect({
  url: "https://streams.example.com/my-account/chat/room-1",
  auth: { token: process.env.DS_TOKEN! },
})

// HEAD gives you the current tail offset if the server exposes it
const { offset } = await stream.head()

// Follow only new data from that point on
for await (const chunk of stream.follow({ offset })) {
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
  read(opts?: ReadOptions): Promise<ReadResult>
  follow(opts?: ReadOptions): AsyncIterable<StreamChunk>
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
// Default: catch-up then auto-select SSE or long-poll
for await (const chunk of stream.follow()) { ... }

// Catch-up only (stop at upToDate)
for await (const chunk of stream.follow({ live: 'catchup' })) { ... }

// Long-poll only (skip catch-up)
for await (const chunk of stream.follow({ live: 'long-poll' })) { ... }

// SSE only (throws if content-type doesn't support SSE)
for await (const chunk of stream.follow({ live: 'sse' })) { ... }
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
