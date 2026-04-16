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

# Durable Streams — TanStack AI

Connection adapter for TanStack AI's `useChat()`. Uses one stream per chat session: user messages are echoed into the stream alongside model responses, making it a complete transcript that supports multi-client sync and SSR hydration.

## The two auth layers — keep them separate

| Auth                | What                                   | Where                                                   | How                                                         |
| ------------------- | -------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| **Durable Streams** | `DS_SECRET`                            | Server-only — POST `/api/chat` + GET `/api/chat-stream` | `Authorization: Bearer <DS_SECRET>` on upstream DS requests |
| **AI model**        | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Server-only (read by the adapter)                       | `process.env.ANTHROPIC_API_KEY` is picked up automatically  |

NEVER mix these. The DS secret authenticates your server to the DS service. The AI key authenticates your server to Anthropic/OpenAI. The client NEVER sees either.

For apps that let users supply their own AI key, see "User-supplied AI key" below.

## Prerequisites

Install the DS client + this package:

```bash
pnpm add @durable-streams/client @durable-streams/tanstack-ai-transport @tanstack/ai-react @tanstack/ai-anthropic
```

Set env vars. You need a running Durable Streams service — self-hosted (see `server-deployment` skill) or Electric Cloud (see blog post for setup).

```bash
ELECTRIC_URL=          # e.g. https://api.electric-sql.cloud (root API URL)
DS_SERVICE_ID=         # Durable Streams service id, e.g. svc-abc-123
DS_SECRET=             # Bearer token for DS auth
ANTHROPIC_API_KEY=     # AI model auth (OR let user supply their own, see below)
```

Build the stream base URL from `ELECTRIC_URL + DS_SERVICE_ID` rather than trusting a single `DS_URL` env var — different environments populate it differently, and a mismatch silently 404s your PUT.

```ts
// src/lib/ds-stream.ts
const electricUrl = process.env.ELECTRIC_URL || "https://api.electric-sql.cloud"
const serviceId = process.env.DS_SERVICE_ID
if (!serviceId) throw new Error("DS_SERVICE_ID is required")
export const DS_BASE = `${electricUrl.replace(/\/+$/, "")}/v1/stream/${serviceId}`
export const DS_AUTH = { Authorization: `Bearer ${process.env.DS_SECRET}` }
```

## Client

```tsx
import { useMemo } from "react"
import { useChat } from "@tanstack/ai-react"
import { durableStreamConnection } from "@durable-streams/tanstack-ai-transport"

function Chat({
  id,
  initialMessages,
  resumeOffset,
}: {
  id: string
  initialMessages?: Array<any>
  resumeOffset?: string
}) {
  const connection = useMemo(
    () =>
      durableStreamConnection({
        sendUrl: `/api/chat?id=${encodeURIComponent(id)}`,
        readUrl: `/api/chat-stream?id=${encodeURIComponent(id)}`,
        initialOffset: resumeOffset, // from SSR loader, skips replay
      }),
    [id, resumeOffset]
  )

  const { messages, sendMessage } = useChat({
    id,
    initialMessages,
    connection,
    live: true, // keeps read subscription open for multi-client sync
  })

  // TanStack AI UIMessage has `parts: Array<MessagePart>`. TextPart uses
  // `.content` (NOT `.text` — that silently renders empty strings).
  return (
    <>
      {messages.map((m) => (
        <div key={m.id}>
          {m.parts
            .filter((p) => p.type === "text")
            .map((p, i) => (
              <span key={i}>{p.content}</span>
            ))}
        </div>
      ))}
    </>
  )
}
```

## Server — POST /api/chat

```ts
import { chat } from "@tanstack/ai"
import { anthropicText } from "@tanstack/ai-anthropic"
import { toDurableChatSessionResponse } from "@durable-streams/tanstack-ai-transport"

export async function POST(request: Request) {
  const url = new URL(request.url)
  const body = await request.json()
  const id = url.searchParams.get("id") ?? body.id
  if (!id) return Response.json({ error: "Missing chat id" }, { status: 400 })

  const latestUserMessage = body.messages.findLast(
    (m: any) => m.role === "user"
  )

  const responseStream = chat({
    adapter: anthropicText("claude-sonnet-4-6"),
    messages: body.messages,
  })

  return await toDurableChatSessionResponse({
    stream: {
      writeUrl: `${DS_BASE}/chat-${id}`,
      headers: DS_AUTH,
      createIfMissing: true,
    },
    newMessages: latestUserMessage ? [latestUserMessage] : [],
    responseStream,
  })
}
```

**Available adapters:**

- `anthropicText("claude-sonnet-4-6")` from `@tanstack/ai-anthropic`
- `openaiText("gpt-4o-mini")` from `@tanstack/ai-openai`

Both read credentials from their standard env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

## Server — GET /api/chat-stream (read proxy)

Never expose the DS write URL to the client. Proxy reads through your server so the DS secret stays server-side.

```ts
export async function GET(request: Request) {
  const url = new URL(request.url)
  const id = url.searchParams.get("id")
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 })

  const upstream = new URL(`${DS_BASE}/chat-${id}`)
  // Forward offset/live/sse params from the browser's DS client
  for (const [k, v] of url.searchParams) {
    if (k !== "id") upstream.searchParams.set(k, v)
  }

  const response = await fetch(upstream, {
    headers: {
      ...DS_AUTH,
      ...(request.headers.get("accept") && {
        Accept: request.headers.get("accept")!,
      }),
    },
  })

  // Strip hop-by-hop headers before forwarding
  const headers = new Headers()
  for (const [k, v] of response.headers) {
    const lk = k.toLowerCase()
    if (
      lk === "connection" ||
      lk === "transfer-encoding" ||
      lk === "content-length" ||
      lk === "content-encoding"
    )
      continue
    headers.set(k, v)
  }
  return new Response(response.body, { status: response.status, headers })
}
```

Use the chat id as a **query parameter** — not a dynamic route segment. Segments like `/api/chat-stream/$id` break when the stream path contains slashes.

## SSR hydration + resume

In your route loader, materialize the snapshot server-side and pass the offset down:

```ts
import { materializeSnapshotFromDurableStream } from "@durable-streams/tanstack-ai-transport"

export const loader = async ({ params }: { params: { id: string } }) => {
  const snapshot = await materializeSnapshotFromDurableStream({
    readUrl: `${DS_BASE}/chat-${params.id}`,
    headers: DS_AUTH,
  })
  return { messages: snapshot.messages, resumeOffset: snapshot.offset }
}
```

Pass `resumeOffset` to `durableStreamConnection` — this skips replaying the history on first subscribe.

## User-supplied AI key

If users enter their own AI key in a settings UI:

1. Store the key in a shared store (Context, Zustand, Jotai) — NOT per-hook `useState`, otherwise different components see different values.
2. Pass it via `headers` on `durableStreamConnection` (NOT on `useChat` — those headers aren't forwarded):

```tsx
const { apiKey } = useSettings() // from Context/store, shared across components
const connection = useMemo(
  () =>
    durableStreamConnection({
      sendUrl: `/api/chat?id=${encodeURIComponent(id)}`,
      readUrl: `/api/chat-stream?id=${encodeURIComponent(id)}`,
      headers: { "x-api-key": apiKey },
    }),
  [id, apiKey]
)
```

Server reads the header and sets it for the adapter:

```ts
const apiKey = request.headers.get("x-api-key")
if (!apiKey) return Response.json({ error: "Missing API key" }, { status: 401 })
process.env.ANTHROPIC_API_KEY = apiKey
// ... rest of handler
```

## Common Mistakes

### CRITICAL Sending full message history as newMessages

Wrong: `newMessages: messages` — echoes the entire conversation every request.

Correct: only pass what's new since the last request:

```ts
const latestUserMessage = messages.findLast((m) => m.role === "user")
newMessages: latestUserMessage ? [latestUserMessage] : []
```

### CRITICAL Exposing the DS write URL to the client

Setting `readUrl` on the server stream config to the durable stream's write URL leaks the secret in the `Location` header. Always use a read proxy route for `readUrl`.

### CRITICAL First assistant response invisible until refresh — dead subscription

`durableStreamConnection` opens its live SSE read on mount. If the stream doesn't exist yet (new conversation), the read fails with `STREAM_NOT_FOUND` and **the subscription terminates — it does NOT retry on 404**. When the user's first POST then creates the stream and the server streams chunks, nothing is listening. After a refresh, the subscription is re-opened against an existing stream and everything works — which is exactly what the user describes when they say "the first response only shows after refresh".

**Fix**: create the stream eagerly when you create the conversation row, so the client's subscription has something to attach to. PUT is idempotent — catch `CONFLICT_EXISTS` / `CONFLICT_SEQ` and treat as success.

```ts
// src/routes/api/conversations.ts — after inserting the conversation row
import { DurableStream, DurableStreamError } from "@durable-streams/client"

async function ensureChatStream(streamId: string): Promise<void> {
  try {
    const stream = new DurableStream({
      url: `${DS_BASE}/chat-${streamId}`,
      headers: DS_AUTH,
      contentType: "application/json",
    })
    await stream.create({ contentType: "application/json" })
  } catch (err) {
    if (
      err instanceof DurableStreamError &&
      err.status === 409 &&
      (err.code === "CONFLICT_EXISTS" || err.code === "CONFLICT_SEQ")
    ) {
      return // already exists — fine
    }
    throw err
  }
}
```

Do NOT rely on `toDurableChatSessionResponse`'s `createIfMissing` to cover this case. That handler runs during the first POST, which is AFTER the client's read subscription has already died.

### CRITICAL Switching conversations shows stale data — missing useLiveQuery deps + missing component key

Two separate React pitfalls compound into the same symptom (header/messages don't update when the user clicks a different conversation):

1. `useLiveQuery` needs explicit deps — without them, the query closure captures the initial id and never re-runs:

   ```ts
   // WRONG — no deps, closure captures initial conversationId forever
   const { data } = useLiveQuery((q) =>
     q.from({ conv }).where(({ conv }) => eq(conv.id, conversationId))
   )

   // RIGHT — deps array pins re-evaluation to the param
   const { data } = useLiveQuery(
     (q) => q.from({ conv }).where(({ conv }) => eq(conv.id, conversationId)),
     [conversationId]
   )
   ```

2. `useChat`'s internal `ChatClient` is memoized per-hook and keeps previous messages in a ref even when the `id` prop changes. Force a full remount by keying the component on the stream id:

   ```tsx
   return (
     <ChatInner key={streamId} streamId={streamId} connection={connection} />
   )
   ```

### CRITICAL Wrong field on UIMessage parts — empty bubbles

TanStack AI's `UIMessage` has `parts: Array<MessagePart>`. The `TextPart` interface puts the text in `.content` — **not** `.text`, **not** `message.content`. Reading the wrong field renders empty strings silently (no error), so bubbles just show "…" or blank.

```ts
// WRONG — message.content does not exist on UIMessage
message.content.slice(0, 50)

// WRONG — p.text is undefined on TextPart (silently empty)
message.parts
  .filter((p) => p.type === "text")
  .map((p) => p.text)
  .join("")

// RIGHT
const text = message.parts
  .filter((p) => p.type === "text")
  .map((p) => p.content)
  .join("")
```

Reference: `@tanstack/ai` `TextPart { type: "text"; content: string }` in `src/types.ts`.

### HIGH useChat headers are not forwarded

`headers` on `useChat({ headers })` are NOT sent by `durableStreamConnection`. Put them on the connection:

```ts
durableStreamConnection({ sendUrl, readUrl, headers: { "x-api-key": key } })
```

### HIGH Missing initialOffset for SSR

Without `initialOffset`, the client replays the entire stream history on first subscribe and re-materializes a `MESSAGES_SNAPSHOT`. For long conversations this wastes bandwidth. Always pass the offset from `materializeSnapshotFromDurableStream()` to the connection.

### HIGH Missing waitUntil on serverless

In `immediate` mode (default), the response returns before background writes finish. Without `waitUntil`, serverless runtimes kill the process and drop chunks:

```ts
return await toDurableChatSessionResponse({
  stream,
  newMessages,
  responseStream,
  waitUntil: ctx.waitUntil.bind(ctx),
})
```

### MEDIUM Swapping readUrl and sendUrl

`sendUrl` is the POST endpoint that triggers model generation. `readUrl` is the GET/SSE endpoint for subscribing. Different routes — swapping causes silent failures.

## Response contract

- `toDurableChatSessionResponse({ mode: "immediate" })` (default) → `202`, empty body, writes continue in background
- `toDurableChatSessionResponse({ mode: "await" })` → `200`, empty body, returns after writes finish

## See also

- [getting-started](../../client/skills/getting-started/SKILL.md) — Stream creation and reading basics
- [writing-data](../../client/skills/writing-data/SKILL.md) — Low-level append and IdempotentProducer
- [go-to-production](../../client/skills/go-to-production/SKILL.md) — Production readiness checklist

## Version

Targets @durable-streams/tanstack-ai-transport v0.2.1.
