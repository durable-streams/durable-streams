# TanStack AI

Use `@durable-streams/tanstack-ai-transport` when you want [TanStack AI](https://tanstack.com/ai) chat sessions with resumability, resilience, and built-in support for multi-tab, multi-device, and multi-user sharing.

This transport writes chat session state into Durable Streams and reads it back through a durable connection, so subscribers can resume from offsets and keep multiple clients attached to the same session state. It plugs into TanStack AI's [streaming connection adapter](https://tanstack.com/ai/latest/docs/guides/streaming#connection-adapters) layer.

## Install

```bash
pnpm add @durable-streams/tanstack-ai-transport @durable-streams/client
```

## Client

Create a durable TanStack connection:

```typescript
import { durableStreamConnection } from "@durable-streams/tanstack-ai-transport"

const connection = durableStreamConnection({
  sendUrl: "/api/chat?id=chat_123",
  readUrl: "/api/chat-stream?id=chat_123",
  initialOffset: undefined,
})
```

Pass this connection to `useChat` from `@tanstack/ai-react`.

## Server

Write model chunks to a durable chat session stream:

```typescript
import { toDurableChatSessionResponse } from "@durable-streams/tanstack-ai-transport"

return toDurableChatSessionResponse({
  stream: {
    writeUrl,
    headers,
  },
  newMessages: [latestUserMessage],
  responseStream,
})
```

This appends the new user message, pipes TanStack AI chunks into the durable stream, and returns an empty success response.

## Recommended chat session flow

### 1. Client connection

```typescript
const connection = durableStreamConnection({
  sendUrl: `/api/chat?id=${chatId}`,
  readUrl: `/api/chat-stream?id=${encodeURIComponent(chatId)}`,
  initialOffset: resumeOffsetFromSSR,
})
```

Use it with `useChat`, following the same pattern as TanStack AI's [connection adapters](https://tanstack.com/ai/latest/docs/guides/streaming#connection-adapters):

```typescript
useChat({ id: chatId, connection, live: true })
```

### 2. POST route

Your `POST /api/chat` route should:

- validate the chat id
- build a durable stream write URL
- keep `newMessages` explicit, usually just the latest prompt
- start the model `responseStream`
- return `toDurableChatSessionResponse(...)`

### 3. GET proxy route

Your `GET /api/chat-stream` route should:

- accept a chat `id`
- build the upstream durable read URL on the durable stream server
- forward read query params like `offset` and `live`
- add durable stream server-side read auth headers
- return the upstream body and headers

### 4. SSR hydrate and resume

For page loaders, use:

```typescript
const { messages, offset } = await materializeSnapshotFromDurableStream({
  readUrl,
  headers,
})
```

Then send `messages` and `offset` to the client, and use that `offset` as `initialOffset` when creating the durable connection.

This avoids replaying the entire session during first subscribe.

## Example

- [Package README](https://github.com/durable-streams/durable-streams/blob/samwillis/transport-tanstack-ai/packages/tanstack-ai-transport/README.md)
- [Chat example README](https://github.com/durable-streams/durable-streams/blob/samwillis/transport-tanstack-ai/examples/chat-tanstack/README.md)
