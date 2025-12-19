# durable-stream

TypeScript client for the Electric Durable Streams protocol.

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

### Read as bytes (streaming)

```typescript
const stream = await DurableStream.connect({
  url: "https://streams.example.com/my-account/chat/room-1",
  auth: { token: process.env.DS_TOKEN! },
})

// Like response.body - get ReadableStream of bytes
for await (const chunk of stream.body()) {
  console.log("chunk:", chunk) // Uint8Array

  // Check stream.offset to persist position
  saveOffset(stream.offset)
}
```

### Read as text

```typescript
// Like response.text() - read all as text (catch-up only)
const text = await stream.text()
console.log(text)

// Or stream text chunks
for await (const chunk of stream.textStream()) {
  console.log("text:", chunk)
}
```

### Read as JSON

```typescript
// Like response.json() - read all as JSON (catch-up only)
const data = await stream.json()
console.log(data)

// Or stream JSON items
for await (const item of stream.jsonStream()) {
  console.log("item:", item)
}
```

### Read from "now" (skip existing data)

```typescript
// HEAD gives you the current tail offset
const { offset } = await stream.head()

// Read only new data from that point on
for await (const chunk of stream.body({ offset })) {
  console.log("new data:", chunk)
}
```

### Catch-up only (no live updates)

```typescript
// Stop when up-to-date instead of waiting for new data
const text = await stream.text()
console.log("all existing data:", text)
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
  body(opts?: ReadOptions): ReadableStream<Uint8Array>
  textStream(opts?: ReadOptions): ReadableStream<string>
  jsonStream<T>(opts?: ReadOptions): ReadableStream<T>
  subscribeJson<T>(
    callback: (data: Array<T>, metadata) => void,
    opts?: ReadOptions
  ): () => void
  json(): Promise<Array<unknown>>
  text(): Promise<string>
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
// Default: catch-up then live updates via long-poll
for await (const chunk of stream.body()) { ... }

// Catch-up only (no live updates, stop when up-to-date)
for await (const chunk of stream.body({ live: false })) { ... }

// Force long-poll mode for live updates
for await (const chunk of stream.body({ live: 'long-poll' })) { ... }

// Force SSE mode for live updates (throws if content-type doesn't support SSE)
for await (const chunk of stream.body({ live: 'sse' })) { ... }
```

## Types

Key types exported from the package:

- `Offset` - Opaque string for stream position
- `ResponseMetadata` - Metadata from stream responses
- `HeadResult` - Metadata from HEAD requests
- `DurableStreamError` - Protocol-level errors with codes
- `FetchError` - Transport/network errors

## License

Apache-2.0
