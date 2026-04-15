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

### Client

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
    resume: true, // reconnect to in-flight generation on page reload
  })
}
```

### Server — POST /api/chat

```typescript
import { streamText, convertToModelMessages } from "ai"
import { toDurableStreamResponse } from "@durable-streams/aisdk-transport"

export async function POST(request: Request) {
  const { messages, id } = await request.json()

  const result = streamText({
    model: openai("gpt-4o-mini"),
    messages: await convertToModelMessages(messages),
  })

  const streamPath = `chat/${id}/${crypto.randomUUID()}`
  await saveChat({ id, activeStreamId: streamPath })

  return toDurableStreamResponse({
    source: result.toUIMessageStream({
      originalMessages: messages,
      onFinish: ({ messages: finalMessages }) => {
        void saveChat({ id, messages: finalMessages, activeStreamId: null })
      },
    }),
    stream: {
      writeUrl: buildWriteStreamUrl(streamPath),
      readUrl: buildReadProxyUrl(request, streamPath), // never expose writeUrl
      headers: WRITE_HEADERS,
    },
  })
}
```

`mode: "immediate"` (default) returns `201` immediately; writes continue in background. Use `mode: "await"` when the runtime needs an active request to keep running.

### Reconnect endpoint — GET /api/chat/:id/stream

Required for `resume: true`. Returns the active stream URL or 204 if no generation is in flight:

```typescript
export async function GET(request, { params }) {
  const { id } = await params
  const chat = await loadChat(id)

  if (!chat?.activeStreamId) {
    return new Response(null, { status: 204 })
  }

  const streamUrl = buildReadProxyUrl(request, chat.activeStreamId)
  return Response.json(
    { streamUrl },
    { status: 200, headers: { Location: streamUrl } }
  )
}
```

The transport defaults to `${api}/${chatId}/stream`. Pass `reconnectApi` to override.

### Read proxy

Always proxy reads through an app route so write credentials stay server-side. Pass the proxy URL as `readUrl` in `toDurableStreamResponse()`.

```typescript
// app/api/chat-stream/route.ts (Next.js) or equivalent server route
function copyHeaders(response: Response): Headers {
  const headers = new Headers()
  for (const [key, value] of response.headers.entries()) {
    const k = key.toLowerCase()
    if (
      k === "connection" ||
      k === "transfer-encoding" ||
      k === "content-encoding" ||
      k === "content-length"
    )
      continue
    headers.set(key, value)
  }
  headers.set("Cache-Control", "no-store")
  return headers
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const streamPath = url.searchParams.get("path")
  if (!streamPath)
    return Response.json({ error: "Missing stream path" }, { status: 400 })

  const upstreamUrl = new URL(buildReadStreamUrl(streamPath))
  for (const [key, value] of url.searchParams) {
    if (key === "path") continue
    upstreamUrl.searchParams.append(key, value)
  }

  const response = await fetch(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${process.env.DS_SECRET}`,
      ...(request.headers.get("accept")
        ? { Accept: request.headers.get("accept")! }
        : {}),
    },
  })

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: copyHeaders(response),
  })
}
```

## Common Mistakes

### CRITICAL Not persisting activeStreamId for resume

Save the active stream path before returning and clear it in `onFinish`. Without it, the reconnect endpoint has nothing to return and `resume: true` silently fails. See the server setup above for the correct pattern.

### CRITICAL Exposing write URLs to the client

Wrong: omitting `readUrl` — defaults to `writeUrl`, leaking credentials in the `Location` header.
Fix: always set `readUrl` to a read proxy route.

Source: packages/aisdk-transport/src/server.ts

### HIGH Not using waitUntil on serverless runtimes

In `immediate` mode, the response returns before writes finish. Without `waitUntil`, serverless runtimes may kill the process and drop chunks.

Fix: pass `waitUntil: ctx.waitUntil.bind(ctx)` to `toDurableStreamResponse()`.

Source: packages/aisdk-transport/src/server.ts

### HIGH Not clearing activeStreamId on finish

A stale `activeStreamId` causes the reconnect endpoint to return a completed stream. Always clear it in `onFinish`. See the server setup above.

### MEDIUM Missing reconnect endpoint

`resume: true` calls `GET ${api}/${chatId}/stream` on mount. If this endpoint doesn't exist, reconnection fails silently with a 404. See the reconnect endpoint setup above.

Source: packages/aisdk-transport/src/client.ts

## See also

- [getting-started](../../client/skills/getting-started/SKILL.md) — Stream creation and reading basics
- [writing-data](../../client/skills/writing-data/SKILL.md) — Low-level append and IdempotentProducer
- [go-to-production](../../client/skills/go-to-production/SKILL.md) — Production readiness checklist

## Version

Targets @durable-streams/aisdk-transport v0.2.1.
