---
title: TypeScript client
description: >-
  TypeScript client for Durable Streams. Fetch-like stream() for reads and IdempotentProducer for exactly-once writes with batching and retries.
outline: [2, 3]
---

# TypeScript client

Use `@durable-streams/client` when you want direct read and write access to Durable Streams from TypeScript.

It gives you:

- `stream()` for fetch-like reads
- `DurableStream` for create, append, read, close, and delete
- `IdempotentProducer` for exactly-once writes with batching and retries

<IntentLink intent="create" serviceType="streams" serviceVariant="json" />

## Key features

- Exactly-once writes with `IdempotentProducer`
- Automatic batching and pipelining for high-throughput producers
- Streaming reads with promise helpers, `ReadableStream`s, and subscribers
- Offset-based resumability and configurable live modes
- Works with JSON, text, and raw byte streams

## Install

```bash
npm install @durable-streams/client
```

## Read-only API

The `stream()` function is the fetch-like API for consuming streams:

```typescript
import { stream } from "@durable-streams/client"

const res = await stream<{ message: string }>({
  url: "https://streams.example.com/my-account/chat/room-1",
  offset: savedOffset,
  live: true,
})

const items = await res.json()
console.log(items)
```

Use `stream()` when your app only needs to consume a stream.

### StreamResponse helpers

`StreamResponse` supports multiple consumption patterns:

```typescript
const bytes = await res.body()
const items = await res.json()
const text = await res.text()

const byteStream = res.bodyStream()
const jsonStream = res.jsonStream()
const textStream = res.textStream()

const unsubscribe = res.subscribeJson(async (batch) => {
  await processBatch(batch.items)
})
```

Save the returned offset from subscriber batches if you want to resume from the same place later.

## Server-side HTTP caching

Durable Streams reads are ordinary HTTP responses with cache headers such as `Cache-Control` and `ETag`. On a Node.js server, you can use Undici's cache interceptor as a cache-aware `fetch` implementation and pass it to the TypeScript client.

Install Undici if your app does not already depend on it:

```bash
npm install undici
```

Create a cached fetch with an in-memory 100 MiB cache:

```typescript
import { Agent, cacheStores, interceptors } from "undici"
import { stream } from "@durable-streams/client"

const dispatcher = new Agent().compose(
  interceptors.cache({
    store: new cacheStores.MemoryCacheStore({
      maxSize: 100 * 1024 * 1024, // 100 MiB, in bytes
    }),
  })
)

const cachedFetch: typeof fetch = (input, init) => {
  return fetch(input, {
    ...init,
    dispatcher,
  } as RequestInit)
}

const res = await stream<{ message: string }>({
  url: "https://streams.example.com/my-account/chat/room-1",
  fetch: cachedFetch,
  live: false,
})

const items = await res.json()
```

Undici handles the HTTP cache semantics for you, including `Cache-Control`, `ETag` validation, `304 Not Modified`, `Expires`, `Last-Modified`, and `Vary`. This works well for catch-up reads because the TypeScript client intentionally sends the initial catch-up request without a `live` query parameter, allowing standard HTTP caches to store it when the server marks it cacheable.

You can also install the cached dispatcher globally for all Undici-backed fetch calls in the process:

```typescript
import { Agent, cacheStores, interceptors, setGlobalDispatcher } from "undici"

setGlobalDispatcher(
  new Agent().compose(
    interceptors.cache({
      store: new cacheStores.MemoryCacheStore({
        maxSize: 100 * 1024 * 1024,
      }),
    })
  )
)
```

For streams that contain user-specific or confidential data, make sure your server returns appropriate `Cache-Control` headers such as `private` or `no-store`. Shared caches should only store responses that are safe to share between users.

## Exactly-once writes

For reliable, high-throughput writes with exactly-once semantics, use `IdempotentProducer`:

```typescript
import { DurableStream, IdempotentProducer } from "@durable-streams/client"

const stream = await DurableStream.create({
  url: "https://streams.example.com/events",
  contentType: "application/json",
})

const producer = new IdempotentProducer(stream, "event-processor-1", {
  autoClaim: true,
  onError: (err) => console.error("Batch failed:", err),
})

for (const event of events) {
  producer.append(event)
}

await producer.flush()
await producer.close()
```

This is the recommended write path when you need safe retries and duplicate prevention.

## Read/write API

Use `DurableStream` when you want a persistent handle for create, append, and read operations:

```typescript
import { DurableStream } from "@durable-streams/client"

const handle = await DurableStream.create({
  url: "https://streams.example.com/my-account/chat/room-1",
  contentType: "application/json",
  ttlSeconds: 3600,
})

await handle.append(JSON.stringify({ type: "message", text: "Hello" }))

const res = await handle.stream<{ type: string; text: string }>()
res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log(item.text)
  }
})
```

## Live modes

- `true` uses the default live behavior for the stream type
- `false` reads catch-up data only
- `"sse"` forces Server-Sent Events
- `"long-poll"` forces long-polling

## When to use it

- Use the TypeScript client when you are building directly on the protocol.
- Use [JSON mode](json-mode.md) when your stream payloads are structured messages.
- Use [Vercel AI SDK](vercel-ai-sdk.md) or [TanStack AI](tanstack-ai.md) when you want higher-level AI integrations.

## More

- [TypeScript client README](https://github.com/durable-streams/durable-streams/blob/main/packages/client/README.md)
- [Client libraries](clients.md) for the other official language clients
