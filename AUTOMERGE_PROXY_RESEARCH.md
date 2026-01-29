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

## Architecture: Durable Stream as Message Bus

```
┌─────────────────┐                              ┌─────────────────┐
│   Client A      │                              │   Client B      │
│ ┌─────────────┐ │                              │ ┌─────────────┐ │
│ │    Repo     │ │                              │ │    Repo     │ │
│ └──────┬──────┘ │                              │ └──────┬──────┘ │
│        │        │                              │        │        │
│ ┌──────▼──────┐ │     ┌──────────────────┐     │ ┌──────▼──────┐ │
│ │ DurableStr- │ │────▶│  Durable Stream  │◀────│ │ DurableStr- │ │
│ │ eamsAdapter │ │     │  (append-only)   │     │ │ eamsAdapter │ │
│ └─────────────┘ │     └──────────────────┘     │ └─────────────┘ │
└─────────────────┘                              └─────────────────┘
```

Each client:
1. **Appends messages** to the stream via `send()`
2. **Reads all messages** from the stream
3. **Filters messages** - only emits messages targeted to this peer
4. **Treats all other clients as peers** discovered through the stream

## Implementation Design

### Package: `automerge-repo-network-durable-streams`

```typescript
import { NetworkAdapter, type Message, type PeerId, type PeerMetadata } from "@automerge/automerge-repo"
import { DurableStream } from "@durable-streams/client"

export interface DurableStreamsNetworkAdapterOptions {
  /** URL of the durable stream */
  url: string | URL
  /** Transport mode */
  transport?: "sse" | "long-poll"
  /** Optional headers (can be functions for dynamic values like auth tokens) */
  headers?: Record<string, string | (() => string)>
}

export class DurableStreamsNetworkAdapter extends NetworkAdapter {
  private stream: DurableStream | null = null
  private abortController: AbortController | null = null
  private unsubscribe: (() => void) | null = null
  private knownPeers: Set<PeerId> = new Set()
  private readyPromise: Promise<void>
  private resolveReady!: () => void
  private _isReady = false

  constructor(private options: DurableStreamsNetworkAdapterOptions) {
    super()
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve
    })
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.abortController = new AbortController()
    this.connectToStream()
  }

  private async connectToStream(): Promise<void> {
    const url = typeof this.options.url === "string"
      ? this.options.url
      : this.options.url.href

    // Create or connect to existing stream
    try {
      this.stream = await DurableStream.create({
        url,
        contentType: "application/octet-stream",
        headers: this.options.headers,
        signal: this.abortController!.signal,
      })
    } catch (err) {
      if (err instanceof DurableStreamError && err.code === "CONFLICT_EXISTS") {
        this.stream = new DurableStream({
          url,
          contentType: "application/octet-stream",
          headers: this.options.headers,
          signal: this.abortController!.signal,
        })
      } else {
        throw err
      }
    }

    // Announce ourselves by appending a "join" message
    await this.announcePresence()

    // Start streaming from beginning to catch up on history
    const transport = this.options.transport ?? "sse"
    const response = await this.stream.stream({
      offset: "-1",
      live: transport,
      encoding: transport === "sse" ? "base64" : undefined,
    })

    this.unsubscribe = response.subscribeBytes((chunk) => {
      this.handleChunk(chunk)
    })
  }

  private async announcePresence(): Promise<void> {
    // Append a presence announcement so other peers discover us
    const announcement: StreamEnvelope = {
      type: "announce",
      peerId: this.peerId!,
      peerMetadata: this.peerMetadata,
    }
    await this.stream!.append(encodeEnvelope(announcement))
  }

  private handleChunk(chunk: { data: Uint8Array; upToDate?: boolean }): void {
    if (chunk.data.length === 0) {
      if (chunk.upToDate && !this._isReady) {
        this._isReady = true
        this.resolveReady()
      }
      return
    }

    // Decode messages from chunk
    const envelopes = decodeEnvelopes(chunk.data)

    for (const envelope of envelopes) {
      if (envelope.type === "announce") {
        // Discovered a peer
        if (envelope.peerId !== this.peerId && !this.knownPeers.has(envelope.peerId)) {
          this.knownPeers.add(envelope.peerId)
          this.emit("peer-candidate", {
            peerId: envelope.peerId,
            peerMetadata: envelope.peerMetadata ?? {},
          })
        }
      } else if (envelope.type === "message") {
        // Only emit messages targeted to us (or broadcast)
        if (envelope.message.targetId === this.peerId) {
          // Track sender as known peer
          if (!this.knownPeers.has(envelope.message.senderId)) {
            this.knownPeers.add(envelope.message.senderId)
            this.emit("peer-candidate", {
              peerId: envelope.message.senderId,
              peerMetadata: {},
            })
          }
          this.emit("message", envelope.message)
        }
      } else if (envelope.type === "leave") {
        if (this.knownPeers.has(envelope.peerId)) {
          this.knownPeers.delete(envelope.peerId)
          this.emit("peer-disconnected", { peerId: envelope.peerId })
        }
      }
    }

    if (chunk.upToDate && !this._isReady) {
      this._isReady = true
      this.resolveReady()
    }
  }

  send(message: Message): void {
    if (!this.stream || !this._isReady) return

    const envelope: StreamEnvelope = {
      type: "message",
      message,
    }

    // Fire and forget - stream handles ordering
    this.stream.append(encodeEnvelope(envelope)).catch((err) => {
      console.error("[automerge-durable-streams] Failed to send:", err)
    })
  }

  disconnect(): void {
    // Announce departure
    if (this.stream && this.peerId) {
      const envelope: StreamEnvelope = {
        type: "leave",
        peerId: this.peerId,
      }
      this.stream.append(encodeEnvelope(envelope)).catch(() => {})
    }

    this.abortController?.abort()
    this.unsubscribe?.()
    this.stream = null
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

// Encode/decode using CBOR or MessagePack for efficiency
// Could also use lib0 encoding like y-durable-streams does
function encodeEnvelope(envelope: StreamEnvelope): Uint8Array
function decodeEnvelopes(data: Uint8Array): StreamEnvelope[]
```

### Usage Example

```typescript
import { Repo } from "@automerge/automerge-repo"
import { DurableStreamsNetworkAdapter } from "automerge-repo-network-durable-streams"

const repo = new Repo({
  network: [
    new DurableStreamsNetworkAdapter({
      url: "https://example.com/v1/streams/my-document",
      transport: "sse",
      headers: {
        Authorization: () => `Bearer ${getToken()}`,
      },
    }),
  ],
})

// Create or find a document
const handle = repo.create()
handle.change((doc) => {
  doc.text = "Hello, world!"
})
```

## Key Design Decisions

### 1. Peer Discovery via Stream

Unlike WebSocket adapters that have explicit connection handshakes, we discover peers by reading their "announce" messages from the stream. This means:
- All peers see each other's announcements
- Late-joining peers see historical announcements and can catch up
- No separate signaling channel needed

### 2. Message Targeting

automerge-repo messages have `targetId` - we only emit messages addressed to us. This provides logical point-to-point communication over the broadcast stream.

### 3. Reliable In-Order Delivery

Durable Streams guarantee:
- Messages are persisted and ordered
- All clients see the same sequence
- Exactly-once delivery with idempotent producers

This matches automerge-repo's requirements perfectly.

### 4. Reconnection Handling

On reconnect:
1. Stream from offset `-1` (beginning) to replay history
2. All "announce" messages rebuild peer set
3. All "message" envelopes replay sync state
4. Document converges to correct state

The stream acts as the source of truth.

## Comparison to Existing Adapters

| Aspect | WebSocket | BroadcastChannel | Durable Streams |
|--------|-----------|------------------|-----------------|
| Persistence | No | No | Yes |
| Offline support | No | No | Yes (via replay) |
| Server required | Yes | No | Yes |
| Peer discovery | Server-mediated | Broadcast | Stream history |
| Message ordering | Per-connection | Broadcast | Global ordering |

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
2. **Presence/ephemeral data**: automerge-repo has ephemeral messages - how to handle them with durable streams? (Maybe a separate non-durable stream?)
3. **Stream per document vs shared stream**: One stream per documentId, or multiplex?
4. **Peer timeout**: How long to keep peers in `knownPeers` without hearing from them?

## References

- [automerge-repo GitHub](https://github.com/automerge/automerge-repo)
- [NetworkAdapter API](https://automerge.org/automerge-repo/classes/_automerge_automerge-repo.NetworkAdapter.html)
- [automerge-repo Networking Docs](https://automerge.org/docs/reference/repositories/networking/)
- [BroadcastChannel Adapter Source](https://github.com/automerge/automerge-repo/tree/main/packages/automerge-repo-network-broadcastchannel)
