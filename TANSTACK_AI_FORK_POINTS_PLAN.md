# TanStack AI fork points implementation plan

## Summary

This document proposes an opt-in fork-point feature for `packages/tanstack-ai-transport` that stores durable fork metadata in the main chat session stream.

The goal is to support chat UIs that can fork a conversation after any completed message and create a new Durable Stream fork at the exact durable offset for that message boundary.

The current shape is:

- add an opt-in `includeForkPoints` option to the TanStack transport server helper
- write fork-point markers into the main stream as `CUSTOM` chunks
- use `IdempotentProducer` to append those markers reliably
- teach snapshot materialization to read those markers and attach them to matching messages
- when creating a fork, replay inherited markers into the child stream immediately after fork creation so the child can fork again from inherited messages

This intentionally avoids protocol changes for now.

## Goals

- keep the feature opt-in
- keep existing TanStack transport behavior unchanged by default
- store fork-point metadata in the main chat session stream
- make fork points survive refresh, SSR snapshot materialization, and reconnect
- support recursive forking, including for inherited messages
- avoid requiring a sidecar metadata store

## Non-goals

- changing the Durable Streams protocol
- exposing per-item offsets from the server for arbitrary batched JSON appends
- solving generalized metadata indexing for all future use cases
- making every message part or chunk forkable

## Constraints

### Offset constraint

Fork offsets must be real durable offsets previously returned by the server.

Because the current append APIs only return one `Stream-Next-Offset` per request, the implementation cannot recover intermediate offsets for multiple logical items sent in the same JSON POST.

That means fork boundaries must be captured by forcing an acknowledged write boundary at the message boundary.

### Main-stream marker constraint

If a fork-point marker is appended after a message boundary, that marker is not automatically inherited by a child fork created at that boundary.

Therefore, if markers live in the main stream, fork creation must replay inherited markers into the new child stream before the child is considered ready.

## Proposed API changes

### Transport server option

Extend `ToDurableChatSessionResponseOptions` with:

```ts
type ForkPointOptions =
  | boolean
  | {
      enabled?: boolean
      markerName?: string
    }

type ToDurableChatSessionResponseOptions = {
  stream: DurableChatSessionStreamTarget
  newMessages: Array<DurableSessionMessage>
  responseStream: AsyncIterable<TanStackChunk>
  mode?: ToDurableStreamResponseMode
  waitUntil?: WaitUntil
  includeForkPoints?: ForkPointOptions
}
```

Recommended defaults:

- `includeForkPoints: false`
- default marker name: `durable-message-offset`

`boolean` keeps the initial API simple. The object form leaves room for future options without another breaking change.

### Materializer behavior

No new top-level function is required initially.

Instead:

- `materializeSnapshotFromDurableStream(...)` should always understand the fork-point marker chunk if present
- when no markers are present, behavior stays exactly as today

### Message metadata shape

Attach fork metadata to each message under a namespaced property:

```ts
type DurableMessageMetadata = {
  endOffset?: string
  forkPoint?: boolean
  inheritedForkPoint?: boolean
  sourceStreamPath?: string
}

type MessageMetadataEnvelope = {
  durable?: DurableMessageMetadata
}
```

At runtime this becomes:

```ts
message.metadata?.durable?.endOffset
```

Do not add a top-level `message.offset` field. The metadata should remain transport-specific and extensible.

## Marker format

Use a `CUSTOM` chunk stored in the same durable session stream.

Suggested payload:

```ts
type DurableMessageOffsetMarker = {
  type: "CUSTOM"
  timestamp: number
  name: "durable-message-offset"
  value: {
    version: 1
    messageId: string
    endOffset: string
    inherited?: boolean
    sourceStreamPath?: string
  }
}
```

Why `CUSTOM`:

- the existing TanStack transport message reducer ignores it unless we explicitly handle it
- `y-llm` already uses `CUSTOM` chunks as app-visible but message-inert side-band events
- it avoids inventing a new top-level chunk type

## Write-path design

### Core principle

A fork point is only reliable if the transport gets an acknowledged durable offset at the exact logical message boundary.

That means:

1. write all chunks for a logical message
2. wait for the final acknowledged offset for that message
3. append a fork-point marker containing that offset

### Writer implementation shape

The current `toDurableChatSessionResponse(...)` helper writes user echo chunks and assistant chunks with the plain `DurableStream` append helpers.

To support fork points, introduce a dedicated internal writer path when `includeForkPoints` is enabled.

Recommended internal structure:

```ts
async function writeChatSessionWithForkPoints(...) {
  const stream = await ensureDurableChatSessionStream(...)
  const producer = new IdempotentProducer(stream, producerId, { autoClaim: true })

  // Write new user message echo chunks
  // Flush at TEXT_MESSAGE_END
  // Append CUSTOM fork-point marker for that message

  // Pipe assistant response chunks
  // Flush at assistant TEXT_MESSAGE_END
  // Append CUSTOM fork-point marker for that message
}
```

### User message handling

For each user message in `newMessages`:

1. convert the message into `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END`
2. append those chunks through `IdempotentProducer`
3. at `TEXT_MESSAGE_END`, await the acknowledged offset for that specific boundary
4. append a `CUSTOM` marker with that offset

### Assistant message handling

For `responseStream`:

1. pass chunks through normally
2. track assistant message lifecycle by `messageId`
3. when `TEXT_MESSAGE_END` arrives, capture the acknowledged offset for that boundary
4. append the fork-point marker immediately after

If multiple assistant messages occur in one response stream, each completed assistant message gets its own marker.

### Required client package support

Using `IdempotentProducer` cleanly here likely requires one or both of:

1. a public way to await the ack result for a specific appended logical item or flushed batch
2. a public `flush()` API that returns the final acknowledged offset for everything written so far

Recommended package-level addition:

```ts
class IdempotentProducer {
  append(body: Uint8Array | string): void
  flush(): Promise<{ offset: string; duplicate: boolean }>
}
```

`flush()` should:

- force the current buffered batch to be sent immediately
- resolve when the server ack is available
- return the ack offset for that flushed batch

This lets the transport create exact barriers at message boundaries without exposing low-level queue state.

## Materialization design

### Reducer updates

Extend `applyChunksToMessages(...)` in `packages/tanstack-ai-transport/src/client.ts` to handle `CUSTOM` fork-point markers.

Behavior:

1. detect `chunk.type === "CUSTOM"` and `chunk.name === "durable-message-offset"`
2. validate `chunk.value.messageId` and `chunk.value.endOffset`
3. find the matching message by id
4. merge metadata into `message.metadata.durable`

Example merge:

```ts
message.metadata = {
  ...(message.metadata ?? {}),
  durable: {
    ...(message.metadata?.durable ?? {}),
    endOffset,
    forkPoint: true,
    inheritedForkPoint: inherited === true,
    sourceStreamPath,
  },
}
```

If the marker arrives before the message exists in the reducer, buffer it in a temporary map keyed by `messageId` and apply it once the message is created.

### Snapshot behavior

`materializeSnapshotFromDurableStream(...)` should continue to return:

```ts
{
  ;(messages, offset)
}
```

but now `messages` may include:

```ts
message.metadata?.durable?.endOffset
```

This keeps the public API additive and backward-compatible.

### Live subscribe behavior

The same reducer should apply in live subscribe mode, so newly written fork points appear on messages without a page reload.

## Fork creation flow

### Required input

The fork UI should fork from:

- source chat id
- source stream path
- message id
- message end offset from `message.metadata.durable.endOffset`

### Server-side fork route

Add a dedicated example-app route for fork creation, for example:

```ts
POST / api / chat - forks
```

Input:

```ts
{
  sourceChatId: string
  sourceMessageId: string
  forkOffset: string
}
```

The route should:

1. create a new chat id
2. create the new durable stream via `PUT` with:
   - `Stream-Forked-From`
   - `Stream-Fork-Offset`
3. read the parent snapshot up to the fork offset
4. collect all fork-point markers for inherited messages up to that offset
5. replay those markers into the new child stream using `IdempotentProducer`
6. return the new child chat id plus minimal metadata

### Why replay all inherited markers

If the child only receives the marker for the single message it forked from, the child can only fork again from that one inherited boundary.

Replaying all inherited markers ensures:

- the child can fork after any inherited message
- the left-hand session tree can keep working recursively
- snapshot materialization for the child remains self-contained

## Example app plan

Target new example:

- `examples/chat-tanstack-forks`

Base it on:

- `examples/chat-tanstack` for transport and route structure
- `y-llm` for UI styling and layout ideas

### Storage split

Use:

1. Durable Streams main session stream
   - messages
   - fork-point markers

2. Browser localStorage
   - chat tree structure
   - active chat id
   - local titles and fork ancestry

Suggested local shape:

```ts
type ChatNode = {
  id: string
  title: string
  createdAt: string
  parentId: string | null
  forkedFromMessageId: string | null
  forkOffset: string | null
}
```

### UI behavior

On the right:

- render messages as normal
- if `message.metadata?.durable?.endOffset` exists, show `Fork chat`

On the left:

- render a tree of local chat sessions
- selecting a node navigates to that chat

### Fork UX

When the user clicks `Fork chat`:

1. POST to `/api/chat-forks`
2. receive the child chat id
3. write the tree node into localStorage
4. navigate to the child route

## Package-level implementation steps

### Phase 1: client support

1. Extend `IdempotentProducer` with `flush()`
2. Add tests for:
   - flush returns final ack offset
   - flush after buffered JSON appends
   - flush with duplicate/idempotent success behavior

### Phase 2: transport writer support

1. Extend `ToDurableChatSessionResponseOptions`
2. Implement the opt-in fork-point writer path
3. Emit `CUSTOM durable-message-offset` markers
4. Add tests for:
   - user message fork marker written
   - assistant message fork marker written
   - no markers when `includeForkPoints` is disabled

### Phase 3: transport materializer support

1. Extend reducer to consume `CUSTOM durable-message-offset`
2. Attach metadata to messages
3. Buffer out-of-order markers if needed
4. Add tests for:
   - snapshot materializes end offsets
   - live subscribe updates message metadata
   - unknown `CUSTOM` chunks remain ignored

### Phase 4: fork example app

1. scaffold `examples/chat-tanstack-forks`
2. add localStorage-backed tree model
3. add fork route
4. replay inherited markers into child stream
5. render tree UI and fork buttons
6. add smoke verification

## File-level plan

Likely package files:

- `packages/client/src/idempotent-producer.ts`
- `packages/client/README.md`
- `packages/tanstack-ai-transport/src/types.ts`
- `packages/tanstack-ai-transport/src/server.ts`
- `packages/tanstack-ai-transport/src/client.ts`
- `packages/tanstack-ai-transport/README.md`
- `packages/tanstack-ai-transport/test/session-transport.test.ts`

Likely example files:

- `examples/chat-tanstack-forks/package.json`
- `examples/chat-tanstack-forks/src/components/chat.tsx`
- `examples/chat-tanstack-forks/src/components/sidebar.tsx`
- `examples/chat-tanstack-forks/src/lib/chat-tree.ts`
- `examples/chat-tanstack-forks/src/lib/chat-session.server.ts`
- `examples/chat-tanstack-forks/src/routes/api/chat.ts`
- `examples/chat-tanstack-forks/src/routes/api/chat-stream.ts`
- `examples/chat-tanstack-forks/src/routes/api/chat-forks.ts`
- `examples/chat-tanstack-forks/src/routes/chat.tsx`
- `examples/chat-tanstack-forks/src/routes/chat/$id.tsx`
- `examples/chat-tanstack-forks/src/styles.css`

## Testing plan

### Client package tests

- `IdempotentProducer.flush()` returns ack offset for JSON mode
- flush remains safe after duplicate/idempotent retry cases
- flush does not reorder pending writes

### Transport tests

- message snapshot contains `message.metadata.durable.endOffset`
- `CUSTOM durable-message-offset` does not create visible messages
- fork-point markers are omitted unless `includeForkPoints` is enabled
- fork-point markers survive snapshot materialization and live streaming

### Example-app verification

- create root chat
- send two or more messages
- fork after the first message
- child chat shows inherited messages
- child chat can fork again from inherited messages
- localStorage tree survives page refresh

## Open questions

### Should marker replay use the original or child stream path?

Recommendation:

- store `sourceStreamPath` as the original source when replaying inherited markers
- keep the child stream self-sufficient, but preserve ancestry for debugging and future tooling

### Should incomplete messages get fork points?

Recommendation:

- no
- only completed messages with a known message boundary should get `endOffset`

### Should the marker rewrite happen synchronously during fork creation?

Recommendation:

- yes
- do not return the new child chat until inherited markers are replayed

### Should the example app expose all messages as forkable or only user/assistant text messages?

Recommendation:

- start with user and assistant text messages only
- leave tool and metadata-heavy messages for a later pass

## Recommended implementation order

1. add `IdempotentProducer.flush()`
2. implement opt-in `includeForkPoints` in `packages/tanstack-ai-transport`
3. update materialization to attach `message.metadata.durable.endOffset`
4. build the fork demo app on top of that

This order keeps the package changes narrow and gives the example app a stable base to build on.
