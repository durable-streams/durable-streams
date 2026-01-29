# Automerge Proxy Research

This document explores adding an Automerge provider for Durable Streams, similar to the existing Yjs provider (`y-durable-streams`).

## Executive Summary

Automerge is a CRDT library with a well-defined sync protocol that can be adapted to work with Durable Streams. Unlike Yjs, Automerge's sync protocol is **bidirectional and stateful**, which presents unique challenges for integration with an append-only log architecture. Two implementation approaches are viable:

1. **Low-level approach**: Use Automerge's `generateSyncMessage`/`receiveSyncMessage` APIs directly
2. **High-level approach**: Implement an `automerge-repo` NetworkAdapter

## Automerge Overview

### Core Concepts

Automerge is a JSON-like CRDT library that provides:
- Multiple CRDT implementations (text, lists, maps, counters)
- Compact binary compression format
- Transport-agnostic sync protocol
- Rust core with JavaScript/WASM bindings

**Key Packages:**
- `@automerge/automerge` - Core CRDT implementation and sync protocol
- `@automerge/automerge-repo` - Higher-level document management with pluggable networking/storage

### Sync Protocol Deep Dive

Automerge's sync protocol is based on [this paper](https://arxiv.org/abs/2012.00472) and assumes **reliable, in-order message delivery** between peers.

**Key characteristics:**
- **Bidirectional**: Both peers exchange messages until fully synced
- **Stateful**: Each peer maintains a `SyncState` per connected peer
- **Efficient**: Often achieves sync in a single round-trip per direction
- **Binary**: Messages are `Uint8Array` (compact binary format)

**Core sync functions:**
```typescript
import * as Automerge from "@automerge/automerge"

// Initialize sync state for a peer
const syncState = Automerge.initSyncState()

// Generate message to send (returns [newState, message | null])
const [newState, message] = Automerge.generateSyncMessage(doc, syncState)

// Receive message from peer (returns [newDoc, newState])
const [newDoc, newState] = Automerge.receiveSyncMessage(doc, syncState, message)

// Sync state can be serialized for persistence
const encoded = Automerge.encodeSyncState(syncState)
const decoded = Automerge.decodeSyncState(encoded)
```

**Sync flow:**
1. Peer A generates sync message and sends to Peer B
2. Peer B receives message, updates doc, generates response
3. Exchange continues until both `generateSyncMessage` return `null`
4. `null` message means peers are fully synchronized

## Comparison: Yjs vs Automerge Sync

| Aspect | Yjs | Automerge |
|--------|-----|-----------|
| Sync direction | Unidirectional (updates broadcast) | Bidirectional (message exchange) |
| State per peer | None required | `SyncState` per peer |
| Message format | Update deltas | Sync messages with bloom filters |
| Merge strategy | Apply updates directly | Generate/receive sync messages |
| Update batching | `Y.mergeUpdates()` | Built into sync protocol |

### Key Challenge

Yjs works well with append-only logs because updates are **unidirectional broadcasts** - any client can append an update and all other clients apply it.

Automerge's sync protocol is **bidirectional** - it expects a back-and-forth exchange between specific peers. This doesn't naturally fit an append-only broadcast model.

## Proposed Solution: Server-Mediated Sync

### Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│   Client A   │────▶│  Durable Stream  │◀────│   Client B   │
│  (Automerge) │     │  (append-only)   │     │  (Automerge) │
└──────────────┘     └──────────────────┘     └──────────────┘
        │                    │                       │
        │                    ▼                       │
        │           ┌──────────────┐                 │
        └──────────▶│   Virtual    │◀────────────────┘
                    │  Sync Peer   │
                    └──────────────┘
```

### Approach: Client as "Virtual Peer"

Instead of clients syncing with each other directly, each client:

1. **Maintains sync state with a "virtual server peer"**
2. **Appends sync messages to the stream**
3. **Processes all stream messages as if from the virtual peer**
4. **Re-derives sync state from stream on reconnect**

This works because:
- All clients see the same ordered stream of messages
- Each client can reconstruct document state by processing all messages
- The stream acts as a shared "truth" that all clients sync against

### Message Format

Each stream entry contains:
```typescript
interface AutomergeStreamMessage {
  // The Automerge sync message (binary)
  syncMessage: Uint8Array

  // Client identifier for filtering own messages
  clientId: string

  // Optional: heads at time of send (for optimization)
  heads?: string[]
}
```

### Provider Implementation

```typescript
// Proposed package: automerge-durable-streams or am-durable-streams

export class DurableStreamsProvider {
  private doc: Automerge.Doc<T>
  private stream: DurableStream
  private syncState: Automerge.SyncState
  private clientId: string

  constructor(options: {
    doc: Automerge.Doc<T>
    streamUrl: string
    transport: "sse" | "long-poll"
  })

  async connect(): Promise<void>
  disconnect(): void
  destroy(): void

  // Events
  on(event: "synced", handler: (synced: boolean) => void): void
  on(event: "change", handler: (doc: Automerge.Doc<T>) => void): void
  on(event: "error", handler: (error: Error) => void): void
}
```

### Sync Algorithm

**On connect (replay history):**
```typescript
async connect() {
  // Create fresh doc and sync state
  this.doc = Automerge.init()
  this.syncState = Automerge.initSyncState()

  // Stream from beginning
  const response = await this.stream.stream({ offset: "-1", live: transport })

  response.subscribeBytes((chunk) => {
    const messages = decode(chunk.data)
    for (const msg of messages) {
      // Skip our own messages
      if (msg.clientId === this.clientId) continue

      // Apply sync message
      const [newDoc, newState] = Automerge.receiveSyncMessage(
        this.doc, this.syncState, msg.syncMessage
      )
      this.doc = newDoc
      this.syncState = newState
    }

    if (chunk.upToDate) {
      // Generate any sync messages we need to send
      this.generateAndSendSyncMessages()
      this.emit("synced", true)
    }
  })
}
```

**On local change:**
```typescript
onChange(newDoc: Automerge.Doc<T>) {
  this.doc = newDoc
  this.generateAndSendSyncMessages()
}

async generateAndSendSyncMessages() {
  const [newState, message] = Automerge.generateSyncMessage(this.doc, this.syncState)
  this.syncState = newState

  if (message) {
    await this.stream.append(encode({
      syncMessage: message,
      clientId: this.clientId,
    }))
  }
}
```

## Alternative: Raw Changes Approach

A simpler approach that bypasses the sync protocol entirely:

**Instead of sync messages, append raw changes:**
```typescript
// On local change
const changes = Automerge.getChanges(oldDoc, newDoc)
for (const change of changes) {
  await stream.append(change) // Each change is already a Uint8Array
}

// On receive
const [newDoc] = Automerge.applyChanges(doc, [change])
```

**Pros:**
- Simpler - no sync state management
- Each change is self-contained
- Natural fit for append-only log

**Cons:**
- Less efficient for large documents with lots of history
- No bloom filter optimization
- May send redundant changes

This approach is similar to how Yjs works - just broadcast changes.

## Recommended Implementation Path

### Phase 1: MVP with Raw Changes

Start with the simpler "raw changes" approach:

```typescript
// Package: am-durable-streams
export class DurableStreamsSync {
  private doc: Automerge.Doc<T>
  private stream: DurableStream

  // Frame changes with length prefix (like Yjs uses lib0)
  private frameChange(change: Uint8Array): Uint8Array
  private unframeChanges(data: Uint8Array): Uint8Array[]
}
```

**Package structure:**
```
packages/am-durable-streams/
├── src/
│   ├── index.ts
│   ├── types.ts
│   └── durable-streams-sync.ts
├── test/
│   └── durable-streams-sync.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

### Phase 2: automerge-repo NetworkAdapter

For users already using `automerge-repo`, provide a NetworkAdapter:

```typescript
// Package: @durable-streams/automerge-repo-network-adapter
import { NetworkAdapter } from "@automerge/automerge-repo"

export class DurableStreamsNetworkAdapter extends NetworkAdapter {
  connect(peerId: string): void
  disconnect(): void
  send(message: Message): void
  isReady(): boolean
  whenReady(): Promise<void>
}
```

This would integrate with the automerge-repo ecosystem while using Durable Streams as the transport.

### Phase 3: Optimizations

- Sync state persistence between sessions
- Bloom filter optimization for initial sync
- Batching multiple changes before append
- Compression for large documents

## Dependencies

```json
{
  "peerDependencies": {
    "@automerge/automerge": "^3.0.0"
  },
  "devDependencies": {
    "@automerge/automerge": "^3.2.0"
  }
}
```

## Open Questions

1. **Framing format**: Use lib0 like Yjs, or custom length-prefixed format?
2. **Client ID generation**: UUID, or derived from Automerge actor ID?
3. **Awareness/Presence**: Automerge doesn't have built-in presence like Yjs's Awareness protocol. Should we add a separate presence stream?
4. **Document recovery**: How to handle corrupted stream entries?
5. **Multiple documents**: Support multiple docs per stream, or one stream per doc?

## References

- [Automerge GitHub](https://github.com/automerge/automerge)
- [Automerge Documentation](https://automerge.org/docs/hello/)
- [Automerge Sync Protocol (Rust docs)](https://automerge.org/automerge/automerge/sync/index.html)
- [Binary Format Specification](https://automerge.org/automerge-binary-format-spec/)
- [Automerge-Repo](https://automerge.org/blog/automerge-repo/)
- [automerge-repo Networking](https://automerge.org/docs/reference/repositories/networking/)
- [Sync Protocol Paper](https://arxiv.org/abs/2012.00472)

## Conclusion

Adding Automerge support to Durable Streams is feasible with two main approaches:

1. **Raw changes** (recommended MVP): Simpler, broadcast-style like Yjs
2. **Sync protocol**: More complex but potentially more efficient for large docs

The raw changes approach provides the best starting point as it closely mirrors the successful Yjs implementation pattern while requiring minimal adaptation of Automerge's architecture.
