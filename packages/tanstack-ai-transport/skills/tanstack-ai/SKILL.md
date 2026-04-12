---
name: tanstack-ai
description: >
  TanStack AI integration with Durable Streams. durableStreamConnection()
  for useChat(), toDurableChatSessionResponse() for server-side streaming,
  SSR hydration with materializeSnapshotFromDurableStream(), multi-client
  sync with live: true, chunk sanitization, read proxy pattern. Load when
  building chat apps with TanStack AI (@tanstack/ai-react) and durable
  streams.
type: composition
library: durable-streams
library_version: "0.2.1"
requires:
  - getting-started
sources:
  - "durable-streams/durable-streams:packages/tanstack-ai-transport/src/client.ts"
  - "durable-streams/durable-streams:packages/tanstack-ai-transport/src/server.ts"
  - "durable-streams/durable-streams:packages/tanstack-ai-transport/src/types.ts"
---

This skill builds on durable-streams/getting-started. Read it first for setup and offset basics.

# Durable Streams — TanStack AI

Connection adapter for TanStack AI's `useChat()` that writes all messages and
AI responses to a single append-only durable stream per chat session. Sessions
are resumable, collaborative (multi-client), and support SSR hydration.

Key difference from the Vercel AI SDK transport: TanStack AI uses one stream per
chat (not one stream per generation). User messages are echoed into the stream
as chunks alongside model responses. This makes the stream a complete transcript
that any number of clients can subscribe to in real time.

## Setup

```typescript
// Client — React component
import { useChat } from "@tanstack/ai-react"
import { durableStreamConnection } from "@durable-streams/tanstack-ai-transport"

const connection = durableStreamConnection({
  sendUrl: `/api/chat?id=${chatId}`,
  readUrl: `/api/chat-stream?id=${chatId}`,
  initialOffset: resumeOffset, // from SSR loader, prevents replay
})

const { messages, sendMessage, isLoading } = useChat({
  id: chatId,
  initialMessages,
  connection,
  live: true, // keep subscription open for multi-client sync
})
```

```typescript
// Server — POST /api/chat
import { chat } from "@tanstack/ai"
import { openaiText } from "@tanstack/ai-openai"
import { toDurableChatSessionResponse } from "@durable-streams/tanstack-ai-transport"

const latestUserMessage = messages.findLast((m) => m.role === "user")

const responseStream = chat({
  adapter: openaiText("gpt-4o-mini"),
  messages,
})

return toDurableChatSessionResponse({
  stream: {
    writeUrl: buildWriteStreamUrl(`chat/${id}`),
    headers: WRITE_HEADERS,
  },
  newMessages: [latestUserMessage],
  responseStream,
})
```

## Core Patterns

### Client connection

`durableStreamConnection()` returns a connection adapter for `useChat()`:

```typescript
import { useMemo } from "react"
import { useChat } from "@tanstack/ai-react"
import { durableStreamConnection } from "@durable-streams/tanstack-ai-transport"

function Chat({ id, initialMessages, resumeOffset }) {
  const connection = useMemo(
    () =>
      durableStreamConnection({
        sendUrl: `/api/chat?id=${encodeURIComponent(id)}`,
        readUrl: `/api/chat-stream?id=${encodeURIComponent(id)}`,
        initialOffset: resumeOffset,
      }),
    [id, resumeOffset]
  )

  const { messages, sendMessage, isLoading } = useChat({
    id,
    initialMessages,
    connection,
    live: true,
  })

  // render messages...
}
```

Options:

- `sendUrl` — POST endpoint for sending messages (required)
- `readUrl` — SSE read endpoint for subscribing (defaults to `sendUrl`)
- `initialOffset` — resume from this offset, skipping earlier messages (SSR hydration)
- `emitSnapshotOnSubscribe` — emit a `MESSAGES_SNAPSHOT` on first subscribe (default: `true`)
- `headers` — default headers for all requests
- `fetchClient` — custom fetch implementation

### Server response

`toDurableChatSessionResponse()` echoes user messages into the stream, then pipes model response chunks:

```typescript
import { chat } from "@tanstack/ai"
import { openaiText } from "@tanstack/ai-openai"
import { toDurableChatSessionResponse } from "@durable-streams/tanstack-ai-transport"

export async function POST(request: Request) {
  const { messages, id } = await request.json()

  const latestUserMessage = messages.findLast((m) => m.role === "user")

  const responseStream = chat({
    adapter: openaiText("gpt-4o-mini"),
    messages,
  })

  return toDurableChatSessionResponse({
    stream: {
      writeUrl: buildWriteStreamUrl(`chat/${id}`),
      headers: WRITE_HEADERS,
    },
    newMessages: latestUserMessage ? [latestUserMessage] : [],
    responseStream,
    mode: "immediate", // default; returns 202 immediately
  })
}
```

The function:

1. Ensures the durable stream exists (creates it if missing, `application/json`)
2. Converts `newMessages` to echo chunks via `toMessageEchoChunks()`
3. Appends echo chunks (sanitized to reduce payload)
4. Pipes model response chunks (also sanitized)

Response modes:

- `immediate` (default) — returns `202 Accepted` immediately; writes continue in background. Use `waitUntil` on serverless runtimes.
- `await` — returns `200` after all chunks are written.

### SSR hydration

Use `materializeSnapshotFromDurableStream()` in your server loader to build the initial message state and capture the resume offset:

```typescript
import { materializeSnapshotFromDurableStream } from "@durable-streams/tanstack-ai-transport"

export async function loader({ params }) {
  const snapshot = await materializeSnapshotFromDurableStream({
    readUrl: buildReadStreamUrl(`chat/${params.id}`),
    headers: READ_HEADERS,
  })

  return {
    messages: snapshot.messages,
    resumeOffset: snapshot.offset,
  }
}
```

Pass `resumeOffset` as `initialOffset` to the client connection. This tells the subscriber to skip historical chunks and only receive new ones, avoiding a full replay on first render.

### Read proxy

Keep durable stream credentials server-side by proxying reads through an app route:

```typescript
// GET /api/chat-stream?id=abc123
export async function GET(request: Request) {
  const chatId = new URL(request.url).searchParams.get("id")
  const streamPath = `chat/${chatId}`

  const upstreamUrl = new URL(buildReadStreamUrl(streamPath))
  // Forward query params (offset, live mode, etc.)
  for (const [key, value] of new URL(request.url).searchParams.entries()) {
    if (key === "id") continue
    upstreamUrl.searchParams.append(key, value)
  }

  const response = await fetch(upstreamUrl, {
    headers: { ...READ_HEADERS },
  })

  return new Response(response.body, {
    status: response.status,
    headers: copyHeaders(response),
  })
}
```

### Multi-client sync

Setting `live: true` on `useChat()` keeps the SSE subscription open. Multiple clients reading the same chat stream see new messages in real time, including messages sent by other clients and model responses:

```typescript
const { messages } = useChat({
  id: chatId,
  connection,
  live: true, // stays subscribed after catching up
})
```

### Worker runtimes (Cloudflare, Deno Deploy)

Use `waitUntil` so writes continue after the response is sent:

```typescript
return toDurableChatSessionResponse({
  stream: { writeUrl, headers },
  newMessages,
  responseStream,
  waitUntil: ctx.waitUntil.bind(ctx),
})
```

## Common Mistakes

### CRITICAL Sending full message history as newMessages

Wrong:

```typescript
return toDurableChatSessionResponse({
  stream: { writeUrl, headers },
  newMessages: messages, // entire conversation echoed again!
  responseStream,
})
```

Correct:

```typescript
const latestUserMessage = messages.findLast((m) => m.role === "user")

return toDurableChatSessionResponse({
  stream: { writeUrl, headers },
  newMessages: latestUserMessage ? [latestUserMessage] : [],
  responseStream,
})
```

`newMessages` are echoed into the durable stream as chunks. Passing the full history duplicates every prior message. Only pass the messages that are new since the last request.

Source: examples/chat-tanstack/src/routes/api/chat.ts

### CRITICAL Exposing write URLs to the client

Wrong:

```typescript
const connection = durableStreamConnection({
  sendUrl: "/api/chat",
  readUrl: buildWriteStreamUrl(`chat/${id}`), // write URL with credentials!
})
```

Correct:

```typescript
const connection = durableStreamConnection({
  sendUrl: "/api/chat",
  readUrl: `/api/chat-stream?id=${id}`, // proxy route
})
```

The `readUrl` is used by the client to subscribe via SSE. Always use a read proxy route so write credentials stay server-side.

Source: packages/tanstack-ai-transport/src/client.ts

### HIGH Not passing initialOffset for SSR hydration

Wrong:

```typescript
// SSR loader provides messages but no offset
const connection = durableStreamConnection({
  sendUrl: `/api/chat?id=${id}`,
  readUrl: `/api/chat-stream?id=${id}`,
  // no initialOffset — replays entire stream on first subscribe
})
```

Correct:

```typescript
const connection = durableStreamConnection({
  sendUrl: `/api/chat?id=${id}`,
  readUrl: `/api/chat-stream?id=${id}`,
  initialOffset: resumeOffset, // from materializeSnapshotFromDurableStream()
})
```

Without `initialOffset`, the subscriber starts from the beginning and materializes a `MESSAGES_SNAPSHOT` from the full stream history. For long conversations, this causes unnecessary data transfer and processing. Pass the offset from `materializeSnapshotFromDurableStream()` to skip already-loaded messages.

Source: packages/tanstack-ai-transport/src/client.ts

### HIGH Not using waitUntil on serverless runtimes

Wrong:

```typescript
return toDurableChatSessionResponse({
  stream: { writeUrl, headers },
  newMessages,
  responseStream,
  mode: "immediate",
})
// Worker may terminate before all chunks are written
```

Correct:

```typescript
return toDurableChatSessionResponse({
  stream: { writeUrl, headers },
  newMessages,
  responseStream,
  mode: "immediate",
  waitUntil: ctx.waitUntil.bind(ctx),
})
```

In `immediate` mode, the response returns before writes finish. Without `waitUntil`, serverless runtimes may kill the process and drop the remaining chunks.

Source: packages/tanstack-ai-transport/src/server.ts

### MEDIUM Using readUrl as sendUrl

Wrong:

```typescript
const connection = durableStreamConnection({
  sendUrl: `/api/chat-stream?id=${id}`, // read proxy, not the chat endpoint!
  readUrl: `/api/chat-stream?id=${id}`,
})
```

Correct:

```typescript
const connection = durableStreamConnection({
  sendUrl: `/api/chat?id=${id}`, // POST endpoint that runs the model
  readUrl: `/api/chat-stream?id=${id}`, // GET endpoint that proxies reads
})
```

`sendUrl` receives POST requests with messages and triggers model generation. `readUrl` is an SSE/streaming GET endpoint for subscribing. These are different routes with different responsibilities.

Source: packages/tanstack-ai-transport/src/client.ts

## See also

- [getting-started](../../client/skills/getting-started/SKILL.md) — Stream creation and reading basics
- [writing-data](../../client/skills/writing-data/SKILL.md) — Low-level append and IdempotentProducer
- [go-to-production](../../client/skills/go-to-production/SKILL.md) — Production readiness checklist

## Version

Targets @durable-streams/tanstack-ai-transport v0.2.1.
