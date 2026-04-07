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

The example app is the main motivation for this work. This section is intentionally more specific than the package sections above and should be treated as an implementation spec for the demo.

### Primary objective

Build a polished example app that demonstrates:

- one durable stream per chat session
- exact message-boundary fork points surfaced in the UI
- recursive conversation branching
- a left-hand fork tree stored in browser localStorage
- resilient reload behavior, where both the active chat and the fork tree survive page refresh

The demo should make the value of Durable Streams for branching AI sessions obvious within a few seconds of use.

### Target example

Create a new example:

- `examples/chat-tanstack-forks`

Base it on:

- `examples/chat-tanstack` for transport, route structure, and SSR snapshot behavior
- `y-llm` for shell layout, visual style, and plain-CSS structure

### Product story the demo should tell

The demo should present a single clear workflow:

1. user opens the app and lands in a root chat
2. user sends one or more messages
3. completed messages become forkable
4. user clicks `Fork chat` after a message
5. a new branch appears in the tree on the left
6. the new branch opens with inherited history up to the fork point
7. the user continues the conversation differently in the child
8. the user can switch between branches and fork again from inherited history

If this full loop is easy to understand, the underlying transport work has succeeded.

### App information architecture

The app should have a simple two-pane layout:

1. Left pane: fork tree and chat navigation
2. Right pane: active chat session

The right pane should itself contain:

1. a compact top header with current chat title and ancestry hint
2. a scrollable message timeline
3. a composer at the bottom

The left pane should make the tree structure obvious even before the user reads any explanatory copy.

### Visual and interaction requirements

The example should feel like a real product demo, not a raw protocol test page.

Use:

- a clean sidebar tree with indentation and clear active-node styling
- message bubbles similar in spirit to `examples/chat-tanstack`
- subtle metadata affordances for branch ancestry
- UI spacing, tones, and structure inspired by `y-llm`

The app should avoid:

- debug-looking JSON dumps in the main UI
- transport jargon in user-facing labels
- exposing offsets directly except optionally in a small developer/debug disclosure

### Required user-facing features

The demo must include all of the following:

- automatic creation of a root chat on first visit
- a persistent fork tree in localStorage
- a visible `Fork chat` action after each completed forkable message
- immediate creation and navigation to a child branch after fork
- inherited message history in the child branch
- ability to fork again from inherited messages in the child
- branch switching from the left-hand tree
- chat titles derived from the first user message

Optional but valuable if cheap:

- a small ancestry breadcrumb in the header
- a `New root chat` button
- a lightweight debug panel showing `messageId` and `endOffset` for the currently hovered message

### Explicit non-requirements for v1 of the demo

Do not block the demo on:

- rename chat
- delete chat
- drag-and-drop tree editing
- multi-user synchronization of the tree model
- tool calling or advanced non-text assistant parts
- generalized metadata browsers

### Storage split

Use two distinct storage layers.

1. Durable Streams main session stream
   - user message echo chunks
   - assistant chunks
   - fork-point `CUSTOM` markers

2. Browser localStorage
   - chat tree structure
   - active chat id
   - local title cache
   - parent/child relationships
   - fork ancestry metadata for navigation

The stream remains the source of truth for message history.

localStorage is the source of truth for the tree UI.

### Local storage schema

Use a versioned local storage document so future demo iterations can migrate safely.

Suggested shape:

```ts
type ChatNode = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  parentId: string | null
  childIds: Array<string>
  forkedFromMessageId: string | null
  forkOffset: string | null
  sourceStreamPath: string
  depth: number
}

type ChatTreeState = {
  version: 1
  activeChatId: string | null
  rootChatIds: Array<string>
  chatsById: Record<string, ChatNode>
}
```

Behavioral requirements:

- localStorage updates must be atomic from the point of view of the app
- a malformed stored payload should fall back to a fresh tree instead of breaking the app
- `updatedAt` should be touched when a branch becomes active or receives a new title

### Durable stream path conventions

The example should use a predictable stream path convention, for example:

```ts
chat/<chatId>
```

The child branch should always have its own durable stream path even when it inherits all visible data up to the fork point.

### Routing model

Recommended routes:

- `/`
  - redirect to the active chat if it exists in localStorage
  - otherwise create a new root chat and redirect there

- `/chat`
  - layout route that renders sidebar plus outlet

- `/chat/$id`
  - active chat page
  - SSR-loads the materialized snapshot for that chat id

- `/api/chat`
  - POST new user message and stream assistant output

- `/api/chat-stream`
  - read proxy for the durable stream

- `/api/chat-forks`
  - create a child branch from a specific message boundary

- `/api/chats/root`
  - optional helper to create a new root chat session if keeping root creation server-driven is simpler

### Server route contracts

#### `POST /api/chat`

Responsibilities:

- validate chat id
- ensure the session stream exists
- call `toDurableChatSessionResponse(..., { includeForkPoints: true })`
- update lightweight metadata if needed for title derivation

Input:

```ts
{
  id?: string
  messages: Array<unknown>
}
```

The route should keep the example aligned with the existing `chat-tanstack` structure unless there is a strong reason to diverge.

#### `GET /api/chat-stream`

Responsibilities:

- resolve the durable stream path for the chat id
- proxy read requests with server-side auth
- forward offset/live params

This route should stay as close as possible to the existing `examples/chat-tanstack` implementation.

#### `POST /api/chat-forks`

This route is the core of the demo and should be fully specified.

Input:

```ts
type CreateForkRequest = {
  sourceChatId: string
  sourceMessageId: string
  forkOffset: string
}
```

Response:

```ts
type CreateForkResponse = {
  chat: {
    id: string
    title: string
    createdAt: string
    parentId: string
    forkedFromMessageId: string
    forkOffset: string
    sourceStreamPath: string
    depth: number
  }
}
```

Route responsibilities:

1. validate request body
2. derive source stream path from `sourceChatId`
3. allocate a new child chat id
4. create the child durable stream using:
   - `Stream-Forked-From`
   - `Stream-Fork-Offset`
5. materialize the parent snapshot up to `forkOffset`
6. collect every inherited fork-point marker up to that boundary
7. replay those markers into the child stream using `IdempotentProducer`
8. return child chat metadata for insertion into localStorage

Failure requirements:

- invalid `forkOffset` should return a clear `400`
- missing source chat should return `404`
- if child stream creation succeeds but marker replay fails, the route should return an error and the UI should not insert the child node into localStorage

### Client state model

The client should maintain two separate but connected pieces of state:

1. route-driven active chat session state
2. localStorage-backed tree state

The tree state should be managed by a dedicated small library or hook, not scattered across components.

Suggested responsibilities for `chat-tree.ts`:

- load and validate local storage
- create root node
- insert fork child node
- set active chat id
- update cached title
- expose helpers for tree traversal and ancestry lookup

### Chat page loader behavior

For `/chat/$id`, the loader should:

1. ensure the chat exists in local tree state or can be treated as a direct deep-link
2. load the durable snapshot from the server
3. pass `messages` and `resumeOffset` into the chat component
4. include enough metadata for the header to show branch ancestry

If a chat id exists in the URL but not in localStorage:

- the page should still load the durable stream if it exists
- the client should backfill a minimal node into localStorage on mount

This makes shared links and manual refreshes more robust.

### Sidebar tree specification

The left pane should show a real tree, not a flat list.

Requirements:

- root chats render at depth 0
- child chats are indented under parents
- active chat is visually obvious
- sibling branches are easy to compare
- the tree scrolls independently of the message pane

Each node should show:

- title
- optional compact branch label, for example `Fork`
- optional timestamp if there is room

Interaction requirements:

- clicking a node navigates to `/chat/$id`
- active chat is highlighted
- keyboard focus styles should be present

### Message timeline specification

Each visible message row should support:

- role styling for user vs assistant
- normal message content rendering
- an optional footer action area

Fork action eligibility:

- show `Fork chat` only when `message.metadata?.durable?.endOffset` exists
- do not show a fork action for incomplete assistant messages
- do not show a fork action while the message boundary is still being written

Recommended action placement:

- render the button in a small footer below the bubble
- align it with the message bubble rather than the full container

Optional developer affordance:

- a collapsed metadata disclosure that shows `messageId` and `endOffset`

### Composer behavior

The composer should follow the existing `chat-tanstack` pattern:

- multiline or single-line input is acceptable
- submit on button press
- disable while busy if that remains the simplest path

The important requirement is that, after a send completes, the newly completed user or assistant messages gain fork buttons once their fork-point markers are available.

### Header specification

The header should help orient the user in the tree.

Recommended contents:

- current chat title
- a small badge such as `Root` or `Fork`
- an ancestry label such as `Forked from "What if we..."` when applicable

This should reinforce the branching model without requiring the user to inspect the left-hand tree every time.

### Initial load behavior

On first visit with empty localStorage:

1. create a root chat
2. insert it into localStorage
3. navigate to it
4. show an empty-state message inviting the user to begin

On revisit with existing localStorage:

1. restore the previous active chat id if present
2. navigate there automatically
3. render the restored tree immediately

### Fork creation UX specification

When the user clicks `Fork chat`:

1. disable the clicked fork button
2. show an in-place pending state such as `Forking...`
3. POST to `/api/chat-forks`
4. if successful:
   - insert the returned child node into localStorage
   - update the parent node's `childIds`
   - set the child as active
   - navigate to `/chat/$id`
5. if failed:
   - restore the button state
   - show a small inline or toast error
   - do not mutate localStorage

### Title derivation rules

Titles should be lightweight and deterministic.

Recommended rules:

- default title: `New chat`
- once the first user message exists, derive title from that message
- truncate to a reasonable length, for example 40 characters
- child branches should initially inherit a title derived from their own first visible user message if available
- if the child has no unique first user message yet, use a temporary label like `Fork of <parent title>`

### Deep-link and refresh behavior

The demo should behave well when:

- the user refreshes on a child branch
- the user opens a child branch directly in a new tab
- the localStorage tree is present but slightly stale

Requirements:

- the route should still load the durable snapshot for the branch
- the local tree should be repaired if the node is missing
- the active chat id in localStorage should update to match the route

### Tree reconstruction expectations

The example is intentionally using localStorage for tree structure, not the durable stream itself.

That means:

- localStorage loss loses the tree organization
- but the individual chat streams still exist and remain readable if the ids are known

This trade-off is acceptable for the demo, but the README should state it explicitly so the example is honest about what is and is not durable.

### Example app README requirements

The example README should explain:

- what the demo shows
- that message history lives in Durable Streams
- that tree state lives in browser localStorage
- why fork-point markers exist in the main stream
- how to run the demo locally
- how forking works at a high level

### Demo acceptance criteria

The demo is complete when all of the following are true:

1. A new root chat is created automatically on first visit.
2. Sending messages produces forkable completed messages.
3. Clicking `Fork chat` creates a child branch and navigates to it.
4. The child shows inherited history up to the selected message boundary.
5. The child can fork again from inherited messages.
6. The left-hand tree survives page refresh.
7. Reloading directly on a child route restores the child session correctly.
8. Unknown `CUSTOM` chunks do not leak into visible chat UI.
9. The fork flow is fast and feels intentional rather than debuggy.

### Example-specific implementation notes

Recommended internal helper modules:

- `src/lib/chat-tree.ts`
  - localStorage model
  - validation
  - inserts and updates

- `src/lib/fork-points.ts`
  - small helpers for reading `message.metadata.durable.endOffset`
  - type guards for forkable messages

- `src/lib/chat-session.server.ts`
  - create root chat
  - load snapshot
  - create fork child

- `src/components/chat-tree.tsx`
  - recursive node rendering

- `src/components/chat-header.tsx`
  - title and ancestry

- `src/components/chat-message-actions.tsx`
  - fork button and pending state

### Example-specific testing and verification

In addition to package-level tests, the example should be manually verified against the full product story:

1. Start from an empty browser storage state.
2. Create a root conversation with at least three messages.
3. Fork after the first message.
4. Continue the child conversation.
5. Return to the parent and confirm it is unchanged.
6. Fork again from the child using an inherited message.
7. Refresh on both parent and child routes.
8. Confirm the tree and active branch are restored.

If time permits, add a small integration-style test or scripted smoke path around the fork API contract and tree insertion logic.

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
