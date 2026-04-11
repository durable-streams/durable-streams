---
name: yjs-sync
description: >
  Yjs CRDT sync over durable streams with @durable-streams/y-durable-streams.
  YjsProvider setup with baseUrl + docId, optional Awareness for presence,
  liveMode (sse vs long-poll), provider lifecycle (connect, disconnect,
  destroy), synced/status/error events, dynamic auth headers, lib0
  VarUint8Array framing. Requires yjs, y-protocols, lib0 peer dependencies.
  Load when integrating Yjs collaborative editing with durable streams.
type: composition
library: durable-streams
library_version: "0.2.3"
sources:
  - "durable-streams/durable-streams:packages/y-durable-streams/src/yjs-provider.ts"
  - "durable-streams/durable-streams:packages/y-durable-streams/src/index.ts"
  - "durable-streams/durable-streams:packages/y-durable-streams/README.md"
  - "durable-streams/durable-streams:packages/y-durable-streams/YJS-PROTOCOL.md"
---

# Durable Streams — Yjs Sync

Sync Yjs documents over HTTP durable streams. No WebSocket infrastructure
needed — uses standard HTTP with SSE or long-poll transport. Built-in
persistence through stream history, optional presence via an awareness
instance.

## Setup

```typescript
import { YjsProvider } from "@durable-streams/y-durable-streams"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"

const doc = new Y.Doc()
const awareness = new Awareness(doc)

const provider = new YjsProvider({
  doc,
  baseUrl: "https://your-server.com/v1/yjs/my-service",
  docId: "my-doc",
  awareness,
})

provider.on("synced", (synced) => {
  console.log("Synced:", synced)
})

provider.on("status", (status) => {
  console.log("Status:", status) // "disconnected" | "connecting" | "connected"
})

provider.on("error", (err) => {
  console.error("Provider error:", err)
})
```

`baseUrl` is the service root (e.g. `.../v1/yjs/{service}`). The provider
appends `/docs/{docId}` internally — do not include `/docs/` in `baseUrl`.
`docId` may contain forward slashes (e.g. `"project/chapter-1"`).

## Core Patterns

### Document-only sync (no presence)

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl: "https://your-server.com/v1/yjs/my-service",
  docId: "my-doc",
})
```

Omit `awareness` when you don't need presence. Awareness is a single
top-level option — the provider creates and manages the awareness stream
internally via `?awareness=default` on the same document URL.

### Manual connect/disconnect

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl,
  docId,
  awareness,
  connect: false, // Don't auto-connect
})

// Wire listeners first, then connect
provider.on("synced", handleSync)
provider.on("error", handleError)
await provider.connect()

// Temporarily disconnect (can reconnect later)
provider.disconnect()

// Permanently destroy (full cleanup)
provider.destroy()
```

Use `connect: false` when you need listeners attached before the initial
sync completes — otherwise you may miss the first `synced` event.

### Long-poll instead of SSE

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl,
  docId,
  liveMode: "long-poll", // default is "sse"
})
```

SSE is the default. Switch to `"long-poll"` only if your infrastructure
(proxies, CDNs, firewalls) buffers or drops server-sent event streams.

### Dynamic auth headers

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl,
  docId,
  awareness,
  headers: {
    Authorization: () => `Bearer ${getAccessToken()}`,
  },
})
```

`headers` is a top-level option and is sent on every underlying request
(document PUT, snapshot discovery, updates, awareness). Values can be
static strings or functions returning `string | Promise<string>` — the
function is called fresh for each request, so token refresh works without
reconnecting.

This is a generic Bearer-token example. The package has no Electric
Cloud-specific header support — if your auth gateway needs special
headers (e.g. tenant IDs, source IDs), add them as additional `headers`
entries alongside `Authorization`.

### React lifecycle

```typescript
useEffect(() => {
  const provider = new YjsProvider({
    doc,
    baseUrl,
    docId,
    awareness,
    connect: false,
  })

  provider.on("synced", setSynced)
  provider.on("error", setError)
  provider.connect()

  return () => {
    provider.destroy() // Full cleanup — see common mistakes below
  }
}, [doc, awareness, baseUrl, docId])
```

## Common Mistakes

### HIGH Forgetting peer dependencies for Yjs

Wrong:

```bash
npm install @durable-streams/y-durable-streams
```

Correct:

```bash
npm install @durable-streams/y-durable-streams yjs y-protocols lib0
```

`yjs`, `y-protocols`, and `lib0` are peer dependencies. Missing them
causes import errors at runtime.

Source: packages/y-durable-streams/package.json peerDependencies

### HIGH Including `/docs/` in `baseUrl`

Wrong:

```typescript
new YjsProvider({
  doc,
  baseUrl: "https://server.com/v1/yjs/my-service/docs/my-doc",
  docId: "my-doc",
})
```

Correct:

```typescript
new YjsProvider({
  doc,
  baseUrl: "https://server.com/v1/yjs/my-service",
  docId: "my-doc",
})
```

`baseUrl` is the service root. The provider builds document URLs as
`{baseUrl}/docs/{docId}` internally. Doubling up `/docs/` produces 404s
on snapshot discovery and updates.

Source: packages/y-durable-streams/src/yjs-provider.ts docUrl()

### HIGH Using `disconnect()` instead of `destroy()` on unmount

Wrong:

```typescript
useEffect(() => {
  const provider = new YjsProvider({ doc, baseUrl, docId, awareness })
  return () => provider.disconnect() // Leaks doc/awareness update listeners
}, [])
```

Correct:

```typescript
useEffect(() => {
  const provider = new YjsProvider({ doc, baseUrl, docId, awareness })
  return () => provider.destroy()
}, [])
```

`disconnect()` tears down the network connection, aborts in-flight
requests, and clears the awareness heartbeat — but it leaves the
`doc.on("update", ...)` and `awareness.on("update", ...)` listeners
attached. If the component re-mounts (common in React strict mode),
those stale listeners accumulate. `destroy()` calls `disconnect()` and
then removes both listeners and the observable's event handlers.

Source: packages/y-durable-streams/src/yjs-provider.ts disconnect() and destroy()

### MEDIUM Setting awareness state with `setLocalStateField` on a fresh instance

Wrong:

```typescript
const awareness = new Awareness(doc)
awareness.setLocalStateField("user", { name: "Alice" }) // no-op
```

Correct:

```typescript
const awareness = new Awareness(doc)
awareness.setLocalState({ user: { name: "Alice" } })
```

A new `Awareness` instance starts with `null` local state.
`setLocalStateField` mutates an existing state object and silently does
nothing when the state is null. Use `setLocalState` for the first write,
then `setLocalStateField` for subsequent updates. This bites hardest in
React strict mode, where the provider's cleanup can reset state to null
between mounts — re-check with `awareness.getLocalState() === null`
before reconnecting.

Source: y-protocols Awareness API, examples/yjs-demo/src/components/yjs-provider.tsx

### LOW Listening for a `snapshot` event

Wrong:

```typescript
provider.on("snapshot", handleSnapshot) // not an event
```

Correct: the only events are `synced`, `status`, and `error`. Snapshot
loading happens automatically during `connect()` — use the `synced`
event to know when the initial state (snapshot + catch-up updates) has
been applied.

Source: packages/y-durable-streams/src/yjs-provider.ts YjsProviderEvents

## API reference

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
`application/octet-stream` for Yjs binary encoding (lib0 VarUint8Array
framing). Don't try to override it.

## See also

- [reading-streams](../../../client/skills/reading-streams/SKILL.md) — SSE/long-poll transport used under the hood
- [YJS-PROTOCOL.md](../../YJS-PROTOCOL.md) — Yjs Durable Streams wire protocol

## Version

Targets @durable-streams/y-durable-streams v0.2.3.
