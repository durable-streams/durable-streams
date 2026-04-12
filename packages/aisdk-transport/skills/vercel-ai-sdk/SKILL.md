---
name: vercel-ai-sdk
description: >
  Vercel AI SDK integration with Durable Streams. createDurableChatTransport()
  for useChat(), toDurableStreamResponse() for server-side streaming,
  resumable chat sessions with reconnectToStream(), read proxy pattern for
  auth. Load when building chat apps with Vercel AI SDK (@ai-sdk/react) and
  durable streams.
type: composition
library: durable-streams
library_version: "0.2.1"
requires:
  - getting-started
sources:
  - "durable-streams/durable-streams:packages/aisdk-transport/src/client.ts"
  - "durable-streams/durable-streams:packages/aisdk-transport/src/server.ts"
  - "durable-streams/durable-streams:packages/aisdk-transport/src/types.ts"
---

This skill builds on durable-streams/getting-started. Read it first for setup and offset basics.

# Durable Streams — Vercel AI SDK

Drop-in transport for `useChat()` that writes AI responses to durable streams.
Chat sessions survive page refreshes and can be resumed mid-generation.

## Setup

```typescript
// Client — React component
import { useChat } from "@ai-sdk/react"
import { createDurableChatTransport } from "@durable-streams/aisdk-transport"

const transport = createDurableChatTransport({ api: "/api/chat" })

const { messages, sendMessage, status } = useChat({
  id: chatId,
  transport,
  resume: true, // reconnect to in-flight generation on page reload
})
```

```typescript
// Server — POST /api/chat
import { streamText, convertToModelMessages } from "ai"
import { toDurableStreamResponse } from "@durable-streams/aisdk-transport"

const result = streamText({
  model: openai("gpt-4o-mini"),
  messages: await convertToModelMessages(messages),
})

const streamPath = `chat/${id}/${crypto.randomUUID()}`

return toDurableStreamResponse({
  source: result.toUIMessageStream(),
  stream: {
    writeUrl: buildWriteStreamUrl(streamPath),
    readUrl: buildReadProxyUrl(request, streamPath),
    headers: WRITE_HEADERS,
  },
})
```

## Core Patterns

### Client transport

`createDurableChatTransport()` returns a `ChatTransport` for the AI SDK's `useChat()` hook:

```typescript
import { useMemo } from "react"
import { useChat } from "@ai-sdk/react"
import { createDurableChatTransport } from "@durable-streams/aisdk-transport"

function Chat({ id, initialMessages }) {
  const transport = useMemo(
    () => createDurableChatTransport({ api: "/api/chat" }),
    []
  )

  const { messages, sendMessage, status } = useChat({
    id,
    messages: initialMessages,
    transport,
    resume: true,
  })

  // render messages...
}
```

Options:

- `api` — POST endpoint for sending messages (required)
- `reconnectApi` — GET endpoint for resume (defaults to `${api}/${chatId}/stream`)
- `headers` — default headers for all requests
- `fetchClient` — custom fetch implementation

### Server response

`toDurableStreamResponse()` writes AI SDK UI message chunks to a durable stream and returns the stream URL to the client:

```typescript
import { streamText, convertToModelMessages } from "ai"
import { toDurableStreamResponse } from "@durable-streams/aisdk-transport"

export async function POST(request: Request) {
  const { messages, id } = await request.json()

  const result = streamText({
    model: openai("gpt-4o-mini"),
    messages: await convertToModelMessages(messages),
  })

  // Each generation gets its own stream
  const streamPath = `chat/${id}/${crypto.randomUUID()}`

  // Persist active stream ID for resume
  await saveChat({ id, activeStreamId: streamPath })

  return toDurableStreamResponse({
    source: result.toUIMessageStream({
      originalMessages: messages,
      onFinish: ({ messages: finalMessages }) => {
        // Clear active stream when generation completes
        void saveChat({ id, messages: finalMessages, activeStreamId: null })
      },
    }),
    stream: {
      writeUrl: buildWriteStreamUrl(streamPath),
      readUrl: buildReadProxyUrl(request, streamPath),
      headers: WRITE_HEADERS,
    },
  })
}
```

Response modes:

- `immediate` (default) — returns `201` with `Location` header immediately; writes continue in background. Use `waitUntil` on serverless runtimes.
- `await` — returns `200` after generation completes. Use when the runtime needs an active request to keep running.

### Reconnect endpoint for resume

When `resume: true` is set on `useChat()`, the transport calls `reconnectToStream()` on mount. Add a GET endpoint that returns the active stream URL:

```typescript
// GET /api/chat/:id/stream
export async function GET(request, { params }) {
  const { id } = await params
  const chat = await loadChat(id)

  if (!chat?.activeStreamId) {
    return new Response(null, { status: 204 }) // no active generation
  }

  const streamUrl = buildReadProxyUrl(request, chat.activeStreamId)
  return Response.json(
    { streamUrl },
    { status: 200, headers: { Location: streamUrl } }
  )
}
```

204 means no in-flight generation to resume. The transport handles this gracefully.

### Read proxy

Keep durable stream credentials server-side by proxying reads through an app route:

```typescript
// GET /api/chat-stream?path=chat/123/uuid
export async function GET(request: Request) {
  const streamPath = new URL(request.url).searchParams.get("path")

  const upstreamUrl = new URL(buildReadStreamUrl(streamPath))
  // Forward query params (offset, live mode, etc.)
  for (const [key, value] of new URL(request.url).searchParams.entries()) {
    if (key === "path") continue
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

Pass this proxy URL as `readUrl` in `toDurableStreamResponse()`.

### Worker runtimes (Cloudflare, Vercel Edge)

Use `waitUntil` so writes continue after the response is sent:

```typescript
return toDurableStreamResponse({
  source: result.toUIMessageStream(),
  stream: { writeUrl, readUrl, headers },
  waitUntil: ctx.waitUntil.bind(ctx), // runtime-provided keep-alive
})
```

## Common Mistakes

### CRITICAL Not persisting activeStreamId for resume

Wrong:

```typescript
return toDurableStreamResponse({
  source: result.toUIMessageStream(),
  stream: { writeUrl, readUrl, headers },
})
// No activeStreamId saved — reconnect endpoint can never find the stream
```

Correct:

```typescript
const streamPath = `chat/${id}/${crypto.randomUUID()}`
await saveChat({ id, activeStreamId: streamPath })

return toDurableStreamResponse({
  source: result.toUIMessageStream({
    onFinish: () => {
      void saveChat({ id, activeStreamId: null }) // clear when done
    },
  }),
  stream: { writeUrl, readUrl, headers },
})
```

Without persisting the active stream path, the reconnect endpoint has nothing to return and `resume: true` silently fails.

Source: examples/chat-aisdk/app/api/chat/route.ts

### CRITICAL Exposing write URLs to the client

Wrong:

```typescript
return toDurableStreamResponse({
  source: result.toUIMessageStream(),
  stream: {
    writeUrl: buildWriteStreamUrl(streamPath),
    // readUrl omitted — defaults to writeUrl, leaking credentials
  },
})
```

Correct:

```typescript
return toDurableStreamResponse({
  source: result.toUIMessageStream(),
  stream: {
    writeUrl: buildWriteStreamUrl(streamPath),
    readUrl: buildReadProxyUrl(request, streamPath), // app route
    headers: WRITE_HEADERS,
  },
})
```

The `readUrl` is returned to the client in the `Location` header and JSON body. Always use a read proxy so write credentials stay server-side.

Source: packages/aisdk-transport/src/server.ts

### HIGH Not using waitUntil on serverless runtimes

Wrong:

```typescript
// Cloudflare Worker or Vercel Edge — no waitUntil
return toDurableStreamResponse({
  source: result.toUIMessageStream(),
  stream: { writeUrl, readUrl, headers },
  mode: "immediate",
})
// Worker may terminate before writes complete!
```

Correct:

```typescript
return toDurableStreamResponse({
  source: result.toUIMessageStream(),
  stream: { writeUrl, readUrl, headers },
  mode: "immediate",
  waitUntil: ctx.waitUntil.bind(ctx),
})
```

In `immediate` mode, the response returns before writes finish. Without `waitUntil`, serverless runtimes may kill the process and drop the remaining chunks.

Source: packages/aisdk-transport/src/server.ts

### HIGH Not clearing activeStreamId on finish

Wrong:

```typescript
await saveChat({ id, activeStreamId: streamPath })

return toDurableStreamResponse({
  source: result.toUIMessageStream(),
  stream: { writeUrl, readUrl, headers },
})
// activeStreamId is never cleared
```

Correct:

```typescript
await saveChat({ id, activeStreamId: streamPath })

return toDurableStreamResponse({
  source: result.toUIMessageStream({
    onFinish: ({ messages: finalMessages }) => {
      void saveChat({ id, messages: finalMessages, activeStreamId: null })
    },
  }),
  stream: { writeUrl, readUrl, headers },
})
```

A stale `activeStreamId` causes the reconnect endpoint to return a completed stream, which the client will connect to and immediately see as closed. Clear it in `onFinish`.

Source: examples/chat-aisdk/app/api/chat/route.ts

### MEDIUM Missing reconnect endpoint

Wrong:

```typescript
// Client sets resume: true
const transport = createDurableChatTransport({ api: "/api/chat" })
useChat({ transport, resume: true })
// But no GET /api/chat/:id/stream endpoint exists → 404 on reconnect
```

Correct:

Add a `GET /api/chat/:id/stream` endpoint that returns the active stream URL or 204. See the "Reconnect endpoint for resume" pattern above.

The transport defaults to `${api}/${chatId}/stream` for reconnection. If your routing differs, pass `reconnectApi` explicitly.

Source: packages/aisdk-transport/src/client.ts

## See also

- [getting-started](../../client/skills/getting-started/SKILL.md) — Stream creation and reading basics
- [writing-data](../../client/skills/writing-data/SKILL.md) — Low-level append and IdempotentProducer
- [go-to-production](../../client/skills/go-to-production/SKILL.md) — Production readiness checklist

## Version

Targets @durable-streams/aisdk-transport v0.2.1.
