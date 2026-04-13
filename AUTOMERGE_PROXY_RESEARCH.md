# Automerge Proxy Research

This document explores adding an `automerge-repo` NetworkAdapter for Durable Streams, similar to the existing Yjs provider (`y-durable-streams`).

## What is a NetworkAdapter?

In `automerge-repo`, a **NetworkAdapter** is the abstraction for connecting to other peers. The `Repo` uses adapters to discover peers, send messages, and receive messages. Unlike Yjs which uses a Provider pattern, Automerge uses this adapter pattern that plugs into the repo infrastructure.

### NetworkAdapter Interface

```typescript
import { EventEmitter } from "eventemitter3"

interface NetworkAdapterEvents {
  close: () => void
  "peer-candidate": (payload: PeerCandidatePayload) => void
  "peer-disconnected": (payload: PeerDisconnectedPayload) => void
  message: (payload: Message) => void
}

interface PeerCandidatePayload {
  peerId: PeerId
  peerMetadata: PeerMetadata
}

interface PeerDisconnectedPayload {
  peerId: PeerId
}

interface PeerMetadata {
  storageId?: StorageId
  isEphemeral?: boolean
}

// Message types: request, sync, unavailable, ephemeral
interface Message {
  type: string
  senderId: PeerId
  targetId: PeerId
  data?: Uint8Array
  documentId?: DocumentId
}

abstract class NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId
  peerMetadata?: PeerMetadata

  // Called by Repo to start connection
  abstract connect(peerId: PeerId, peerMetadata?: PeerMetadata): void

  // Called by Repo to send a message to a peer
  abstract send(message: Message): void

  // Called by Repo to disconnect
  abstract disconnect(): void

  // Readiness checks
  abstract isReady(): boolean
  abstract whenReady(): Promise<void>
}
```

### How automerge-repo Uses NetworkAdapters

1. **Repo creates adapter** and calls `connect(peerId, peerMetadata)`
2. **Adapter emits `peer-candidate`** when it discovers another peer
3. **Repo calls `send(message)`** to transmit sync/request/ephemeral messages
4. **Adapter emits `message`** when it receives data from peers
5. **Adapter emits `peer-disconnected`** when a peer leaves

The key insight: **automerge-repo handles all the sync protocol logic internally**. The NetworkAdapter just needs to transport messages between peers.

## Architecture: One Stream Per Document

Each document gets its own Durable Stream. This keeps streams focused and prevents unbounded growth from mixing unrelated documents.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client A                                │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                         Repo                            │    │
│  └───────────────────────────┬─────────────────────────────┘    │
│                              │                                  │
│  ┌───────────────────────────▼─────────────────────────────┐    │
│  │              DurableStreamsNetworkAdapter               │    │
│  │  ┌─────────────────────────────────────────────────┐    │    │
│  │  │          streams: Map<DocumentId, Stream>       │    │    │
│  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐         │    │    │
│  │  │  │ doc-abc │  │ doc-xyz │  │ doc-123 │   ...   │    │    │
│  │  │  └────┬────┘  └────┬────┘  └────┬────┘         │    │    │
│  │  └───────┼────────────┼───────────┼───────────────┘    │    │
│  └──────────┼────────────┼───────────┼────────────────────┘    │
└─────────────┼────────────┼───────────┼──────────────────────────┘
              │            │           │
              ▼            ▼           ▼
     ┌────────────┐ ┌────────────┐ ┌────────────┐
     │  Stream    │ │  Stream    │ │  Stream    │
     │ /docs/abc  │ │ /docs/xyz  │ │ /docs/123  │
     └────────────┘ └────────────┘ └────────────┘
```

**Why one stream per document?**
- Streams are persistent - mixing unrelated doc history gets messy
- Each stream stays bounded to one document's lifecycle
- Easier permission boundaries per document
- Replay only fetches relevant messages
- Natural URL structure: `/streams/docs/{documentId}`

## Implementation Design

### Package: `automerge-repo-network-durable-streams`

```typescript
import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type DocumentId,
} from "@automerge/automerge-repo"
import { DurableStream, DurableStreamError } from "@durable-streams/client"

export interface DurableStreamsNetworkAdapterOptions {
  /** Base URL for document streams. DocumentId will be appended. */
  baseUrl: string | URL
  /** Transport mode */
  transport?: "sse" | "long-poll"
  /** Optional headers (can be functions for dynamic values like auth tokens) */
  headers?: Record<string, string | (() => string)>
}

interface DocumentStream {
  stream: DurableStream
  unsubscribe: () => void
  peers: Set<PeerId>
  ready: boolean
}

export class DurableStreamsNetworkAdapter extends NetworkAdapter {
  private readonly baseUrl: string
  private readonly transport: "sse" | "long-poll"
  private readonly headers?: Record<string, string | (() => string)>

  private streams: Map<DocumentId, DocumentStream> = new Map()
  private knownPeers: Set<PeerId> = new Set()
  private abortController: AbortController | null = null
  private _isReady = false
  private readyPromise: Promise<void>
  private resolveReady!: () => void

  constructor(options: DurableStreamsNetworkAdapterOptions) {
    super()
    this.baseUrl = typeof options.baseUrl === "string"
      ? options.baseUrl.replace(/\/$/, "")  // Remove trailing slash
      : options.baseUrl.href.replace(/\/$/, "")
    this.transport = options.transport ?? "sse"
    this.headers = options.headers
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve
    })
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.abortController = new AbortController()

    // Adapter is ready immediately - streams are created lazily per document
    this._isReady = true
    this.resolveReady()
  }

  send(message: Message): void {
    if (!this._isReady || !message.documentId) return

    // Get or create stream for this document
    const docStream = this.streams.get(message.documentId)
    if (docStream?.ready) {
      // Stream exists and is ready - send directly
      this.sendToStream(docStream, message)
    } else if (!docStream) {
      // No stream yet - create it, then send
      this.getOrCreateStream(message.documentId).then((ds) => {
        if (ds) this.sendToStream(ds, message)
      })
    }
    // If stream exists but not ready, message will be handled after ready
  }

  private sendToStream(docStream: DocumentStream, message: Message): void {
    const envelope: StreamEnvelope = { type: "message", message }
    docStream.stream.append(encodeEnvelope(envelope)).catch((err) => {
      console.error("[automerge-durable-streams] Failed to send:", err)
    })
  }

  private async getOrCreateStream(documentId: DocumentId): Promise<DocumentStream | null> {
    // Check again in case another call created it
    const existing = this.streams.get(documentId)
    if (existing) return existing

    const url = `${this.baseUrl}/${documentId}`

    try {
      let stream: DurableStream

      // Create or connect to existing stream
      try {
        stream = await DurableStream.create({
          url,
          contentType: "application/octet-stream",
          headers: this.headers,
          signal: this.abortController!.signal,
        })
      } catch (err) {
        if (err instanceof DurableStreamError && err.code === "CONFLICT_EXISTS") {
          stream = new DurableStream({
            url,
            contentType: "application/octet-stream",
            headers: this.headers,
            signal: this.abortController!.signal,
          })
        } else {
          throw err
        }
      }

      const docStream: DocumentStream = {
        stream,
        unsubscribe: () => {},
        peers: new Set(),
        ready: false,
      }

      this.streams.set(documentId, docStream)

      // Announce presence on this document's stream
      const announcement: StreamEnvelope = {
        type: "announce",
        peerId: this.peerId!,
        peerMetadata: this.peerMetadata,
      }
      await stream.append(encodeEnvelope(announcement))

      // Subscribe to the stream
      const response = await stream.stream({
        offset: "-1",
        live: this.transport,
        encoding: this.transport === "sse" ? "base64" : undefined,
      })

      docStream.unsubscribe = response.subscribeBytes((chunk) => {
        this.handleChunk(documentId, docStream, chunk)
      })

      return docStream
    } catch (err) {
      console.error(`[automerge-durable-streams] Failed to connect to stream for ${documentId}:`, err)
      this.streams.delete(documentId)
      return null
    }
  }

  private handleChunk(
    documentId: DocumentId,
    docStream: DocumentStream,
    chunk: { data: Uint8Array; upToDate?: boolean }
  ): void {
    if (chunk.data.length > 0) {
      const envelopes = decodeEnvelopes(chunk.data)

      for (const envelope of envelopes) {
        if (envelope.type === "announce") {
          // Discovered a peer on this document
          if (envelope.peerId !== this.peerId) {
            docStream.peers.add(envelope.peerId)

            // Emit peer-candidate if we haven't seen this peer globally yet
            if (!this.knownPeers.has(envelope.peerId)) {
              this.knownPeers.add(envelope.peerId)
              this.emit("peer-candidate", {
                peerId: envelope.peerId,
                peerMetadata: envelope.peerMetadata ?? {},
              })
            }
          }
        } else if (envelope.type === "message") {
          // Only emit messages targeted to us
          if (envelope.message.targetId === this.peerId) {
            // Track sender as known peer
            if (!this.knownPeers.has(envelope.message.senderId)) {
              this.knownPeers.add(envelope.message.senderId)
              docStream.peers.add(envelope.message.senderId)
              this.emit("peer-candidate", {
                peerId: envelope.message.senderId,
                peerMetadata: {},
              })
            }
            this.emit("message", envelope.message)
          }
        } else if (envelope.type === "leave") {
          docStream.peers.delete(envelope.peerId)
          // Only emit peer-disconnected if peer is not on any other stream
          if (this.knownPeers.has(envelope.peerId) && !this.isPeerOnAnyStream(envelope.peerId)) {
            this.knownPeers.delete(envelope.peerId)
            this.emit("peer-disconnected", { peerId: envelope.peerId })
          }
        }
      }
    }

    if (chunk.upToDate && !docStream.ready) {
      docStream.ready = true
    }
  }

  private isPeerOnAnyStream(peerId: PeerId): boolean {
    for (const [, docStream] of this.streams) {
      if (docStream.peers.has(peerId)) return true
    }
    return false
  }

  disconnect(): void {
    // Announce departure on all streams
    if (this.peerId) {
      const leaveEnvelope: StreamEnvelope = {
        type: "leave",
        peerId: this.peerId,
      }
      const encoded = encodeEnvelope(leaveEnvelope)

      for (const [, docStream] of this.streams) {
        docStream.stream.append(encoded).catch(() => {})
        docStream.unsubscribe()
      }
    }

    this.abortController?.abort()
    this.streams.clear()
    this.knownPeers.clear()
    this._isReady = false
    this.emit("close")
  }

  isReady(): boolean {
    return this._isReady
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }
}
```

### Wire Format

Messages are wrapped in an envelope for the stream:

```typescript
type StreamEnvelope =
  | { type: "announce"; peerId: PeerId; peerMetadata?: PeerMetadata }
  | { type: "message"; message: Message }
  | { type: "leave"; peerId: PeerId }

// Encode/decode using CBOR, MessagePack, or lib0 encoding
function encodeEnvelope(envelope: StreamEnvelope): Uint8Array {
  // Implementation: CBOR.encode() or msgpack.encode() or lib0 encoding
}

function decodeEnvelopes(data: Uint8Array): StreamEnvelope[] {
  // Implementation: decode framed messages from chunk
}
```

### Usage Example

```typescript
import { Repo } from "@automerge/automerge-repo"
import { DurableStreamsNetworkAdapter } from "automerge-repo-network-durable-streams"

const repo = new Repo({
  network: [
    new DurableStreamsNetworkAdapter({
      baseUrl: "https://example.com/v1/streams/docs",
      transport: "sse",
      headers: {
        Authorization: () => `Bearer ${getToken()}`,
      },
    }),
  ],
})

// Documents automatically get their own streams:
// - doc "abc-123" -> https://example.com/v1/streams/docs/abc-123
// - doc "xyz-789" -> https://example.com/v1/streams/docs/xyz-789

const handle = repo.create()
handle.change((doc) => {
  doc.text = "Hello, world!"
})
```

## Key Design Decisions

### 1. Lazy Stream Creation

Streams are created on-demand when `send()` is called with a new `documentId`. This means:
- No upfront cost for documents you haven't accessed
- Streams are created as the Repo requests them
- Natural cleanup when documents are no longer used

### 2. Per-Document Peer Discovery

Peers are discovered within the context of documents:
- Peer A opens doc1 → announces on doc1's stream
- Peer B opens doc1 → sees A's announcement, emits `peer-candidate`
- Peer A opens doc2 → announces on doc2's stream
- Peer B hasn't opened doc2 → doesn't see A there

This matches automerge-repo's model where sync happens per-document.

### 3. Global Peer Tracking

While peers are discovered per-document, we track them globally to avoid duplicate `peer-candidate` events:
- First time we see a peer on any stream → emit `peer-candidate`
- `peer-disconnected` only emitted when peer leaves all streams

### 4. Reliable In-Order Delivery

Durable Streams guarantee:
- Messages are persisted and ordered
- All clients see the same sequence per stream
- Exactly-once delivery with idempotent producers

### 5. Reconnection Handling

On reconnect to a document stream:
1. Stream from offset `-1` (beginning) to replay history
2. All "announce" messages rebuild peer set for that document
3. All "message" envelopes replay sync state
4. Document converges to correct state

## Comparison to Existing Adapters

| Aspect | WebSocket | BroadcastChannel | Durable Streams |
|--------|-----------|------------------|-----------------|
| Persistence | No | No | Yes |
| Offline support | No | No | Yes (via replay) |
| Server required | Yes | No | Yes |
| Peer discovery | Server-mediated | Broadcast | Per-document stream |
| Message ordering | Per-connection | Broadcast | Per-document ordering |
| Stream per doc | N/A | No (shared) | Yes |

## Package Structure

```
packages/automerge-repo-network-durable-streams/
├── src/
│   ├── index.ts                    # Main export
│   ├── adapter.ts                  # DurableStreamsNetworkAdapter
│   ├── encoding.ts                 # Envelope encode/decode
│   └── types.ts                    # Type definitions
├── test/
│   ├── adapter.test.ts             # Unit tests
│   └── integration.test.ts         # Integration with real streams
├── package.json
├── tsconfig.json
└── README.md
```

### Dependencies

```json
{
  "peerDependencies": {
    "@automerge/automerge-repo": "^2.0.0"
  },
  "dependencies": {
    "@durable-streams/client": "workspace:*"
  }
}
```

## Open Questions

1. **Encoding format**: Use CBOR, MessagePack, or lib0 VarUint8Array framing?
2. **Ephemeral messages**: automerge-repo has ephemeral messages for cursor positions etc. These probably shouldn't be persisted. Options:
   - Filter them out (don't append to stream)
   - Use a separate non-durable channel
   - Append but mark as ephemeral for cleanup
3. **Stream cleanup**: When should old announce/leave messages be compacted?
4. **Peer timeout**: Should we emit `peer-disconnected` after inactivity, or only on explicit "leave"?

## References

- [automerge-repo GitHub](https://github.com/automerge/automerge-repo)
- [NetworkAdapter API](https://automerge.org/automerge-repo/classes/_automerge_automerge-repo.NetworkAdapter.html)
- [automerge-repo Networking Docs](https://automerge.org/docs/reference/repositories/networking/)
- [BroadcastChannel Adapter Source](https://github.com/automerge/automerge-repo/tree/main/packages/automerge-repo-network-broadcastchannel)
