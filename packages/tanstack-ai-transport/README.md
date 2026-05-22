# @durable-streams/tanstack-ai-transport

TanStack AI adapters for Durable Streams.

## What this package does

This package gives you:

- A TanStack-compatible client `connection` (`subscribe` + `send`)
- Server helpers to write TanStack chunks into Durable Streams
- Chat-session helpers for echoing user prompts and enforcing JSON stream format
- Snapshot materialization helpers for SSR hydration + resume offsets
- Hooks for extending write and read pipelines with custom logic

Use this when you want chat sessions that survive refreshes/reconnects and can be shared across multiple clients.

## Install

```bash
pnpm add @durable-streams/tanstack-ai-transport @durable-streams/client
```

## Quick start

### Client: create a durable session connection

```ts
import { durableStreamConnection } from "@durable-streams/tanstack-ai-transport"

const connection = durableStreamConnection({
  sendUrl: "/api/chat?id=chat_123",
  readUrl: "/api/chat-stream?id=chat_123",
  initialOffset: undefined,
})
```

Pass this connection to `useChat` from `@tanstack/ai-react`.

### Server: write model chunks to durable stream

```ts
import { toDurableChatSessionResponse } from "@durable-streams/tanstack-ai-transport"

return toDurableChatSessionResponse({
  stream: {
    writeUrl,
    headers,
  },
  newMessages: [latestUserMessage],
  responseStream, // AsyncIterable<TanStackChunk>
})
```

This appends the new user message to the durable stream, pipes AI response chunks, and returns an empty success response.

## Integration guide (recommended chat session flow)

### 1) Client connection

```ts
const connection = durableStreamConnection({
  sendUrl: `/api/chat?id=${chatId}`,
  readUrl: `/api/chat-stream?id=${encodeURIComponent(chatId)}`,
  initialOffset: resumeOffsetFromSSR,
})
```

Use with `useChat({ id: chatId, connection, live: true })`.

### 2) POST route (`/api/chat`)

- Validate chat id
- Build durable stream write URL
- Keep `newMessages` explicit (usually latest user message)
- Start your model stream (`responseStream`)
- Return `toDurableChatSessionResponse(...)`

### 3) GET proxy route (`/api/chat-stream`)

- Accept a chat `id` query param
- Build upstream durable read URL on the server from that id
- Forward query params like `offset`, `live`, etc.
- Add durable read auth headers on the server
- Return upstream body/headers to client

### 4) SSR hydrate + resume

For chat page loaders:

- `materializeSnapshotFromDurableStream({ readUrl, headers })`
- send `messages` + `offset` to client
- use that `offset` as `initialOffset` on `durableStreamConnection`

This avoids replaying entire history on first subscribe.

## API reference

### Client APIs

#### `durableStreamConnection(options)`

Creates a TanStack-compatible `connection` object with:

- `subscribe(abortSignal?) => AsyncIterable<TanStackChunk>`
- `send(messages, data?, abortSignal?) => Promise<void>`

`DurableStreamConnectionOptions`:

- `sendUrl: string` (required) — where `send(...)` POSTs
- `readUrl?: string` — where `subscribe(...)` reads from (defaults to `sendUrl`)
- `initialOffset?: string` — initial durable offset for resuming
- `emitSnapshotOnSubscribe?: boolean` (default `true`) — emit synthetic `MESSAGES_SNAPSHOT` on initial catch-up
- `headers?: HeadersInit` — applied to both read and write requests
- `fetchClient?: typeof fetch` — custom fetch implementation
- `onCustomChunk?: CustomChunkHandler` — called for each `CUSTOM` chunk during snapshot materialization; return a modified messages array or `undefined` to skip

Behavior:

- `send(...)` POSTs `{ messages, data }` to `sendUrl`
- `subscribe(...)` reads durable JSON stream batches and yields TanStack chunks
- internal offset is updated as batches arrive, so later subscribes continue from the latest seen offset

#### `materializeSnapshotFromDurableStream(options)`

Reads a non-live durable stream and materializes TanStack message state.

Input:

- `readUrl: string`
- `headers?: HeadersInit`
- `offset?: string`
- `onCustomChunk?: CustomChunkHandler` — called for each `CUSTOM` chunk; return a modified messages array or `undefined` to skip

Returns:

- `{ messages: Array<any>; offset?: string }`

#### `sanitizeChunkForStorage(chunk)`

Removes duplicated `content` on `TEXT_MESSAGE_CONTENT` chunks (keeps `delta`) to reduce stored payload size.

### Server APIs

#### `toDurableChatSessionResponse(options)`

High-level helper for chat session writes.

`ToDurableChatSessionResponseOptions`:

- `stream: DurableChatSessionStreamTarget` (`writeUrl`, `headers`, `createIfMissing`)
- `newMessages: DurableSessionMessage[]` — explicitly appended prompt messages
- `responseStream: AsyncIterable<TanStackChunk>` — model chunk source
- `mode?: "immediate" | "await"` (default `immediate`)
- `waitUntil?: (promise: Promise<unknown>) => void`
- `onMessageWritten?: OnMessageWritten` — called after each complete message is written with `{ messageId, role, offset, append, flush }`. When provided, the write pipeline uses an `IdempotentProducer` with per-message flushes for precise offset tracking. The `append` and `flush` callbacks let you write additional data (e.g. `CUSTOM` marker chunks) after each message. Without this hook, chunks are appended directly for lower overhead.

Notes:

- chat session streams are always `application/json`
- appends `newMessages` using `toMessageEchoChunks(...)`
- sanitizes chunks before writing

#### `toDurableStreamResponse(source, options)`

Lower-level generic writer for arbitrary async chunk sources.

`ToDurableStreamResponseOptions`:

- `stream: DurableStreamTarget`
- `mode?: "immediate" | "await"`
- `waitUntil?: (promise: Promise<unknown>) => void`
- `exposeLocationHeader?: boolean`

#### `ensureDurableChatSessionStream(streamTarget)`

Ensures a durable stream exists for chat-session usage, enforcing `application/json`.

#### `toMessageEchoChunks(message)`

Converts a user/system/assistant message into:

- `TEXT_MESSAGE_START`
- `TEXT_MESSAGE_CONTENT` (if text exists)
- `TEXT_MESSAGE_END`

This preserves explicit message IDs when provided.

#### `appendSanitizedChunksToStream(stream, chunks, contentType?)`

Appends chunk array with `sanitizeChunkForStorage` applied.

#### `pipeSanitizedChunksToStream(source, stream, contentType?)`

Pipes async chunk source with `sanitizeChunkForStorage` applied.

### Shared types

- `TanStackChunk`
- `DurableSessionConnection`
- `DurableStreamConnection` (alias)
- `DurableStreamConnectionOptions`
- `DurableChatSessionStreamTarget`
- `DurableStreamTarget`
- `ToDurableStreamResponseMode`
- `ToDurableStreamResponseOptions`
- `ToDurableChatSessionResponseOptions`
- `DurableSessionMessage`
- `DurableSessionMessagePart`
- `WaitUntil`
- `OnMessageWritten`
- `MessageWrittenInfo`
- `CustomChunkHandler`

## Response contract

### `toDurableStreamResponse(..., { mode: "immediate" })`

- Status: `201`
- Header: `Location: <read-url>`
- Body: `{ "streamUrl": "<read-url>" }`

### `toDurableStreamResponse(..., { mode: "await" })`

- Status: `200`
- Header: `Location: <read-url>`
- Body: `{ "streamUrl": "<read-url>", "finalOffset": "<offset>" }`

### `toDurableChatSessionResponse(..., { mode: "immediate" })`

- Status: `202`
- Body: empty

### `toDurableChatSessionResponse(..., { mode: "await" })`

- Status: `200`
- Body: empty

## `waitUntil` usage

```ts
return toDurableChatSessionResponse({
  stream: { writeUrl, headers },
  newMessages,
  responseStream,
  waitUntil: ctx.waitUntil.bind(ctx),
})
```

Use `waitUntil` in worker-style runtimes so background writes continue after the pointer response is returned.
