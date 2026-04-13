---
name: yjs-sync
description: >
  YjsProvider deep-dive for @durable-streams/y-durable-streams. Provider
  options, connection lifecycle (connect, disconnect, destroy), synced/status/error
  events, connection state machine, dynamic auth headers, liveMode (sse vs
  long-poll), error recovery behavior. Load when configuring provider behavior
  beyond basic setup.
type: composition
library: durable-streams
library_version: "0.2.3"
requires:
  - yjs-getting-started
sources:
  - "durable-streams/durable-streams:packages/y-durable-streams/src/yjs-provider.ts"
  - "durable-streams/durable-streams:packages/y-durable-streams/src/index.ts"
  - "durable-streams/durable-streams:packages/y-durable-streams/YJS-PROTOCOL.md"
---

This skill builds on durable-streams/yjs-getting-started. Read it first for
install and basic setup.

# Durable Streams — Yjs Sync

YjsProvider configuration, lifecycle, and error handling beyond the basics.

## Provider options

```typescript
interface YjsProviderOptions {
  doc: Y.Doc
  baseUrl: string // e.g. "http://host:port/v1/yjs/{service}"
  docId: string // e.g. "my-doc" or "project/chapter-1"
  awareness?: Awareness // optional presence
  headers?: HeadersRecord // static or () => string | Promise<string>
  liveMode?: "sse" | "long-poll" // default "sse"
  connect?: boolean // default true
}

class YjsProvider {
  readonly doc: Y.Doc
  readonly awareness?: Awareness
  readonly synced: boolean
  readonly connected: boolean
  readonly connecting: boolean

  connect(): Promise<void>
  disconnect(): Promise<void>
  destroy(): void

  on(event: "synced", handler: (synced: boolean) => void): void
  on(event: "status", handler: (status: YjsProviderStatus) => void): void
  on(event: "error", handler: (error: Error) => void): void
}
```

There is no `contentType` option — the provider always uses
`application/octet-stream` (lib0 VarUint8Array framing).

## Connection state machine

```
disconnected → connecting → connected → disconnected
                   ↓
              disconnected (on error)
```

Connection steps:

1. Ensure document exists (PUT)
2. Discover snapshot offset
3. Create idempotent producer for writes
4. Start updates stream (SSE or long-poll)
5. Start awareness stream (if configured)

The `synced` flag is set to `true` when the server reports `upToDate` —
meaning all existing data has been delivered. It resets to `false` when
local updates are sent, and back to `true` when those updates echo back.

## Core Patterns

### Dynamic auth headers

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl,
  docId,
  headers: {
    Authorization: () => `Bearer ${getAccessToken()}`,
  },
})
```

Header functions are called per-request. Token refresh works without
reconnecting.

### Long-poll instead of SSE

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl,
  docId,
  liveMode: "long-poll", // default is "sse"
})
```

Switch to long-poll only if your infrastructure buffers or drops SSE streams.

### Deferred connection

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl,
  docId,
  connect: false,
})

// Configure before connecting
provider.on("synced", handleSync)
provider.on("error", handleError)
await provider.connect()
```

**In React, always use `connect: false`.** The provider's async connection
flow starts immediately in the constructor, which means events like `synced`
can fire before React's `useEffect` attaches listeners. With `connect: false`,
you attach listeners first, then call `connect()` — see the yjs-editors
skill for the canonical React pattern.

## Error recovery

The provider auto-reconnects on transient errors:

- Network errors → retry with 1s delay
- 5xx server errors → retry with backoff
- Snapshot 404 → rediscover snapshot offset

Errors that do NOT trigger reconnect:

- 401/403 auth errors → emits `error` event, stays disconnected
- Provider was explicitly disconnected → no reconnect

## Common Mistakes

### HIGH Using `disconnect()` instead of `destroy()` on unmount

Wrong:

```typescript
return () => provider.disconnect() // Leaks doc/awareness listeners
```

Correct:

```typescript
return () => provider.destroy()
```

`disconnect()` tears down the network connection but leaves `doc.on("update")`
and `awareness.on("update")` listeners attached. `destroy()` calls
`disconnect()` then removes all listeners.

Source: packages/y-durable-streams/src/yjs-provider.ts disconnect() and destroy()

### MEDIUM Listening for events that don't exist

The only events are `synced`, `status`, and `error`. There is no `snapshot`,
`connected`, or `disconnected` event. Use the `status` event for connection
state changes.

Source: packages/y-durable-streams/src/yjs-provider.ts YjsProviderEvents

### HIGH Tension: raw durable streams vs YjsProvider

Use YjsProvider when you need CRDT conflict resolution (collaborative editing,
shared state). Use raw `stream()` from `@durable-streams/client` when you
have append-only data (logs, events, chat messages) where ordering is
sufficient and CRDT overhead isn't needed.

## See also

- [yjs-getting-started](../yjs-getting-started/SKILL.md) — Install and setup
- [yjs-editors](../yjs-editors/SKILL.md) — TipTap and CodeMirror integration
- [yjs-server](../yjs-server/SKILL.md) — Deployment and infrastructure
- [reading-streams](../../../client/skills/reading-streams/SKILL.md) — Raw stream reading (non-CRDT)
- [YJS-PROTOCOL.md](../../YJS-PROTOCOL.md) — Wire protocol specification
