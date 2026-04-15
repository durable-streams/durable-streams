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

## Prerequisites: Durable Streams Service

Before writing any code, you need a running Durable Streams service. Two options:

### Option A: Self-hosted

Run the Caddy-based server locally or on your own infrastructure. See `node_modules/@durable-streams/client/skills/server-deployment/SKILL.md` for the full setup (dev server, production Caddyfile, persistence).

Set these env vars to point at your server:

```bash
DS_URL=http://localhost:4437/v1/stream    # your server's stream endpoint
DS_SECRET=                                 # empty for local dev, or your auth token
```

### Option B: Electric Cloud (hosted)

Provision a managed Durable Streams service via the Electric CLI:

```bash
npx @electric-sql/cli services create streams --environment <env-id> --name chat-streams
npx @electric-sql/cli services get-secret <service-id>
```

This returns a `service_id` and `secret`. Store them:

```bash
echo "DS_SERVICE_ID=<service_id>" >> .env
echo "DS_SECRET=<secret>" >> .env
echo "ELECTRIC_URL=https://api.electric-sql.cloud" >> .env
```

If you're inside the Electric Studio agent sandbox, use `set_secret` to persist them for other agents:

```
set_secret(key: "DS_SERVICE_ID", value: "<service_id>")
set_secret(key: "DS_SECRET", value: "<secret>")
```

### URL construction helper

Use this in your server routes. It works with both self-hosted (`DS_URL` set directly) and Electric Cloud (`DS_SERVICE_ID` + `ELECTRIC_URL`):

```typescript
function buildStreamUrl(streamPath: string): string {
  if (process.env.DS_URL) {
    return `${process.env.DS_URL}/${streamPath}`
  }
  const dsServiceId = process.env.DS_SERVICE_ID
  const electricUrl =
    process.env.ELECTRIC_URL || "https://api.electric-sql.cloud"
  return `${electricUrl}/v1/stream/${dsServiceId}/${streamPath}`
}

const DS_HEADERS = {
  Authorization: `Bearer ${process.env.DS_SECRET}`,
  "Content-Type": "application/json",
}
```

Without these env vars, every DS operation returns 401.

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

  const dsResponse = await toDurableChatSessionResponse({
    stream: {
      writeUrl: buildWriteStreamUrl(`chat/${id}`),
      headers: DS_WRITE_HEADERS, // Durable Streams auth — server-side only
      createIfMissing: true,
    },
    newMessages: latestUserMessage ? [latestUserMessage] : [],
    responseStream,
  })

  // Reconstruct response — strip content-length to avoid conflicts
  // with transfer-encoding (Node rejects responses with both)
  const headers = new Headers(dsResponse.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(dsResponse.body, {
    status: dsResponse.status,
    headers,
  })
}
```

**Available adapters:**

- `anthropicText("claude-sonnet-4-6")` from `@tanstack/ai-anthropic` — Anthropic Claude models
- `openaiText("gpt-4o-mini")` from `@tanstack/ai-openai` — OpenAI models

`mode: "immediate"` (default) returns `202` immediately; writes continue in background. Use `mode: "await"` when the runtime needs an active request to keep running.

### Auth: two separate concerns

There are two independent auth layers. Keep them distinct:

| Auth                | What                     | Where                                                               | How                                                                                                                              |
| ------------------- | ------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Durable Streams** | `DS_SECRET`              | Server-side only — both POST `/api/chat` and GET `/api/chat-stream` | Read from `process.env.DS_SECRET`, inject as `Authorization: Bearer` header on upstream DS requests. NEVER expose to the client. |
| **AI model**        | `ANTHROPIC_API_KEY` etc. | Server-side only                                                    | Read from `process.env`. The adapter picks it up automatically.                                                                  |

**Default pattern (recommended):** API keys are server-side env vars. The client sends only the chat message — no secrets in the browser.

**User-supplied API key pattern:** If the app lets users enter their own AI key in a settings UI (stored in localStorage), the client must send it to the server on every request. In this case:

Client — pass the key via `headers` on `durableStreamConnection` (NOT on `useChat` — those headers are not forwarded):

```typescript
const connection = useMemo(
  () =>
    durableStreamConnection({
      sendUrl: `/api/chat?id=${encodeURIComponent(id)}`,
      readUrl: `/api/chat-stream?id=${encodeURIComponent(id)}`,
      headers: { "x-api-key": apiKey }, // sent on every POST to sendUrl
    }),
  [id, apiKey]
)

const { messages, sendMessage } = useChat({ id, connection, live: true })
```

Server — read the key from the request header and set it for the adapter:

```typescript
export async function POST({ request }) {
  const apiKey = request.headers.get("x-api-key")
  if (!apiKey)
    return Response.json({ error: "Missing API key" }, { status: 401 })

  // Set for the adapter (adapter reads process.env.ANTHROPIC_API_KEY)
  process.env.ANTHROPIC_API_KEY = apiKey

  const { messages, id } = await request.json()
  // ... rest of handler same as above
}
```

Note: setting `process.env` per-request is a quick hack for single-user apps. For multi-user apps, pass the key via the adapter's constructor options instead.

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

### CRITICAL Returning toDurableChatSessionResponse directly

The response from `toDurableChatSessionResponse` may contain both `Content-Length` and `Transfer-Encoding` headers from the upstream DS service. Node's HTTP layer rejects this combination — you'll see `Parse Error: Content-Length can't be present with Transfer-Encoding`.

Wrong:

```typescript
return await toDurableChatSessionResponse({
  stream,
  newMessages,
  responseStream,
})
```

Correct — reconstruct the response, stripping content-length:

```typescript
const dsResponse = await toDurableChatSessionResponse({
  stream,
  newMessages,
  responseStream,
})
const headers = new Headers(dsResponse.headers)
headers.delete("content-length")
headers.delete("content-encoding")
return new Response(dsResponse.body, { status: dsResponse.status, headers })
```

### CRITICAL Sending full message history as newMessages

Wrong: `newMessages: messages` — echoes the entire conversation again.
Fix: only pass messages that are new since the last request:

```typescript
const latestUserMessage = messages.findLast((m) => m.role === "user")
newMessages: latestUserMessage ? [latestUserMessage] : []
```

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
