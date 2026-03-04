# @durable-streams/aisdk-transport

Vercel AI SDK transport adapters for Durable Streams.

## Goal

Use Durable Streams with AI SDK `useChat` so generations can survive refreshes and reconnect cleanly.

This guide moves from:

1. No integration (regular AI SDK chat)
2. Basic Durable Streams integration
3. Optimal resumable generations (recommended)

## 0) Starting point (no Durable Streams)

Client:

```ts
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"

const transport = new DefaultChatTransport({ api: "/api/chat" })
const chat = useChat({ transport })
```

Server:

```ts
return result.toUIMessageStreamResponse()
```

This works, but refreshing during generation can lose the in-flight stream.

## 1) Basic Durable Streams integration

### Client

Swap to `createDurableChatTransport`:

```ts
import { useChat } from "@ai-sdk/react"
import { createDurableChatTransport } from "@durable-streams/aisdk-transport"

const transport = createDurableChatTransport({ api: "/api/chat" })
const chat = useChat({ transport })
```

### Server

Wrap your UI message stream with `toDurableStreamResponse`:

```ts
import { toDurableStreamResponse } from "@durable-streams/aisdk-transport"

return toDurableStreamResponse(result.toUIMessageStream(), {
  stream: {
    writeUrl: buildWriteStreamUrl(streamPath),
    readUrl: buildReadProxyUrl(request, streamPath),
    headers: DURABLE_STREAMS_WRITE_HEADERS,
  },
})
```

At this point you get durable writes + durable reads, but no automatic resume after refresh yet.

## 2) Optimal setup: resumable generations

This is the recommended production flow.

### A. Persist active stream id per chat

When a generation starts, save `activeStreamId = streamPath`.
When it finishes, save final messages and clear `activeStreamId`.

```ts
await saveChat({ id, activeStreamId: streamPath })

return toDurableStreamResponse(
  result.toUIMessageStream({
    originalMessages: messages,
    onFinish: ({ messages: finalMessages }) => {
      void saveChat({ id, messages: finalMessages, activeStreamId: null })
    },
  }),
  { stream: { writeUrl, readUrl, headers } }
)
```

### B. Add reconnect endpoint

Implement `GET /api/chat/:id/stream`:

- Return `204` when there is no active generation.
- Return `200` with `Location` and `{ streamUrl }` when there is one.

```ts
if (!chat.activeStreamId) return new Response(null, { status: 204 })

const streamUrl = buildReadProxyUrl(request, chat.activeStreamId)
return Response.json(
  { streamUrl },
  { status: 200, headers: { Location: streamUrl } }
)
```

### C. Enable `resume` on `useChat`

```ts
const transport = createDurableChatTransport({ api: "/api/chat" })
const chat = useChat({ id, transport, resume: true })
```

On page load, AI SDK will call `reconnectToStream` automatically. This transport resolves the stream URL from `Location` first (or `{ streamUrl }` fallback), then reconnects to the durable stream.

## API reference

### `createDurableChatTransport({ api, reconnectApi?, headers?, fetchClient? })`

Creates an AI SDK `ChatTransport` that:

1. `POST`s messages to `api`
2. Resolves read URL from:
   - `Location` header (preferred)
   - JSON body `{ streamUrl }` fallback
3. Reads the durable stream as JSON+SSE and returns `ReadableStream<UIMessageChunk>`
4. Supports reconnect via `GET reconnectApi` (or default `${api}/${chatId}/stream`)

### `toDurableStreamResponse(source, options)`

Writes AI SDK UI message chunks into Durable Streams and returns a pointer response.

Options:

- `stream.writeUrl`: required durable write URL
- `stream.readUrl`: optional URL exposed to clients (`Location` + JSON body)
- `stream.headers`: optional write headers
- `mode`:
  - `immediate` (default): return once stream is prepared
  - `await`: return after generation/write completes
- `waitUntil`: optional runtime keep-alive hook (useful in worker runtimes)

## Response contract

### `mode: "immediate"`

The initial response returns only stream location metadata, not generated content:

- `Location: <read-url>`
- `{ "streamUrl": "<read-url>" }`

The client then connects to that read URL to consume generated chunks, while generation continues in the background.
Use `waitUntil` when your runtime needs an explicit keep-alive signal so the worker stays alive until streaming work is complete.

- Status: `201`
- Header: `Location: <read-url>`
- Body: `{ "streamUrl": "<read-url>" }`

### `mode: "await"`

Headers are still sent immediately, so clients can read `Location` and start consuming the stream early, but the HTTP connection stays open until generation/write completes.
This is useful on runtimes that only allow long-running work while an inbound request remains active.

- Status: `200`
- Header: `Location: <read-url>`
- Body: `{ "streamUrl": "<read-url>", "finalOffset": "<offset>" }`
