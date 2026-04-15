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

Connection adapter for TanStack AI's `useChat()`. Uses one stream per chat session: user messages are echoed into the stream alongside model responses, making it a complete transcript that supports multi-client sync and SSR hydration.

## Setup

### Client

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
        initialOffset: resumeOffset, // from SSR loader, prevents replay
      }),
    [id, resumeOffset]
  )

  const { messages, sendMessage, isLoading } = useChat({
    id,
    initialMessages,
    connection,
    live: true, // keep subscription open for multi-client sync
  })
}
```

**Custom headers** (e.g. API keys from the client) go on `durableStreamConnection`, NOT on `useChat`:

```typescript
// WRONG — useChat headers are NOT forwarded by the connection
const { messages } = useChat({
  connection,
  headers: { "x-api-key": apiKey }, // ❌ not sent to sendUrl
})

// RIGHT — headers on the connection are sent with every sendUrl POST
const connection = useMemo(
  () =>
    durableStreamConnection({
      sendUrl: `/api/chat?id=${encodeURIComponent(id)}`,
      readUrl: `/api/chat-stream?id=${encodeURIComponent(id)}`,
      headers: { "x-api-key": apiKey }, // ✅ sent on every request
    }),
  [id, apiKey]
)
```

### Server — POST /api/chat

Use `chat()` from `@tanstack/ai` with the appropriate adapter. **Do NOT call LLM SDKs (Anthropic, OpenAI) directly** — the adapter handles message format conversion, streaming chunks, and error mapping.

```typescript
import { chat } from "@tanstack/ai"
import { anthropicText } from "@tanstack/ai-anthropic"
import { toDurableChatSessionResponse } from "@durable-streams/tanstack-ai-transport"

export async function POST(request: Request) {
  const { messages, id } = await request.json()
  const latestUserMessage = messages.findLast((m) => m.role === "user")

  const responseStream = chat({
    adapter: anthropicText("claude-sonnet-4-6"),
    messages,
  })

  return toDurableChatSessionResponse({
    stream: {
      writeUrl: buildWriteStreamUrl(`chat/${id}`),
      headers: WRITE_HEADERS,
    },
    newMessages: latestUserMessage ? [latestUserMessage] : [],
    responseStream,
  })
}
```

**Available adapters:**

- `anthropicText("claude-sonnet-4-6")` from `@tanstack/ai-anthropic` — Anthropic Claude models
- `openaiText("gpt-4o-mini")` from `@tanstack/ai-openai` — OpenAI models

The adapter reads credentials from standard env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Do NOT pass API keys from the client.

`mode: "immediate"` (default) returns `202` immediately; writes continue in background. Use `mode: "await"` when the runtime needs an active request to keep running.

### SSR hydration

Use `materializeSnapshotFromDurableStream()` in your server loader to build initial state and capture a resume offset:

```typescript
import { materializeSnapshotFromDurableStream } from "@durable-streams/tanstack-ai-transport"

export async function loader({ params }) {
  const snapshot = await materializeSnapshotFromDurableStream({
    readUrl: buildReadStreamUrl(`chat/${params.id}`),
    headers: READ_HEADERS,
  })

  return {
    messages: snapshot.messages,
    resumeOffset: snapshot.offset, // pass as initialOffset to skip replay
  }
}
```

### Read proxy — GET /api/chat-stream

Always proxy reads through an app route so credentials stay server-side. The `readUrl` in `durableStreamConnection` points here.

```typescript
// Build the upstream DS URL from env vars
function buildReadStreamUrl(streamPath: string): string {
  const dsServiceId = process.env.DS_SERVICE_ID
  const electricUrl =
    process.env.ELECTRIC_URL || "https://api.electric-sql.cloud"
  return `${electricUrl}/v1/stream/${dsServiceId}/${streamPath}`
}

export async function GET({ request }: { request: Request }) {
  const url = new URL(request.url)
  const chatId = url.searchParams.get("id")
  if (!chatId)
    return Response.json({ error: "Missing chat id" }, { status: 400 })

  const streamPath = `chat/${chatId}`
  const upstream = new URL(buildReadStreamUrl(streamPath))

  // Forward query params (offset, live, etc.) from the browser's DS client
  for (const [key, value] of url.searchParams) {
    if (key === "id") continue
    upstream.searchParams.set(key, value)
  }

  const response = await fetch(upstream, {
    headers: {
      Authorization: `Bearer ${process.env.DS_SECRET}`,
      ...(request.headers.get("accept")
        ? { Accept: request.headers.get("accept")! }
        : {}),
    },
  })

  // Strip hop-by-hop headers, always drop content-length + content-encoding
  const headers = new Headers()
  for (const [key, value] of response.headers) {
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

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
```

Use the chat id as a **query parameter** (`/api/chat-stream?id=...`), not a dynamic route segment. Dynamic segments like `/api/ds-stream/$streamId` cause issues with TanStack Router when the stream path contains slashes.

## Common Mistakes

### CRITICAL Not awaiting toDurableChatSessionResponse

Wrong — returns a Promise object, causing header conflicts (500):

```typescript
return toDurableChatSessionResponse({ stream, newMessages, responseStream })
```

Correct — await the response:

```typescript
return await toDurableChatSessionResponse({
  stream,
  newMessages,
  responseStream,
})
```

In TanStack Start server handlers, returning an unresolved Promise causes Node to serialize it incorrectly, producing both `Content-Length` and `Transfer-Encoding: chunked` headers simultaneously — which HTTP/1.1 forbids.

### CRITICAL Sending full message history as newMessages

Wrong: `newMessages: messages` — echoes the entire conversation again.
Fix: only pass messages that are new since the last request:

```typescript
const latestUserMessage = messages.findLast((m) => m.role === "user")
newMessages: latestUserMessage ? [latestUserMessage] : []
```

Source: examples/chat-tanstack/src/routes/api/chat.ts

### CRITICAL Exposing write URLs to the client

Wrong: setting `readUrl` to the durable stream write URL with credentials.
Fix: always use a read proxy route for `readUrl` in the connection options.

Source: packages/tanstack-ai-transport/src/client.ts

### HIGH Not passing initialOffset for SSR hydration

Without `initialOffset`, the subscriber replays the entire stream history on first subscribe and materializes a `MESSAGES_SNAPSHOT` from scratch. For long conversations this wastes bandwidth and processing. Pass the offset from `materializeSnapshotFromDurableStream()`.

Source: packages/tanstack-ai-transport/src/client.ts

### HIGH Not using waitUntil on serverless runtimes

In `immediate` mode, the response returns before writes finish. Without `waitUntil`, serverless runtimes may kill the process and drop chunks.

Fix: pass `waitUntil: ctx.waitUntil.bind(ctx)` to `toDurableChatSessionResponse()`.

Source: packages/tanstack-ai-transport/src/server.ts

### MEDIUM Using readUrl as sendUrl

`sendUrl` is the POST endpoint that triggers model generation. `readUrl` is the GET/SSE endpoint for subscribing. These are different routes. Swapping them causes silent failures.

Source: packages/tanstack-ai-transport/src/client.ts

## See also

- [getting-started](../../client/skills/getting-started/SKILL.md) — Stream creation and reading basics
- [writing-data](../../client/skills/writing-data/SKILL.md) — Low-level append and IdempotentProducer
- [go-to-production](../../client/skills/go-to-production/SKILL.md) — Production readiness checklist

## Version

Targets @durable-streams/tanstack-ai-transport v0.2.1.
