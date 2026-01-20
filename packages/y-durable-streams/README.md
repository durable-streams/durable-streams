# @durable-streams/y-durable-streams

Yjs provider for Durable Streams - sync Yjs documents over HTTP with automatic server-side compaction and optional awareness (presence) support.

## Overview

This package provides a Yjs provider that syncs documents using the Yjs Durable Streams Protocol. Unlike WebSocket-based providers, it uses HTTP long-polling with automatic server-side compaction, making it simpler to deploy and scale.

Key benefits:

- **No WebSocket infrastructure** - Works with standard HTTP load balancers and CDNs
- **Automatic compaction** - Server manages document snapshots to keep sync fast
- **Scalable** - Stateless server design, documents stored in durable streams
- **Presence support** - Optional awareness for cursors, selections, and user status

## Installation

```bash
npm install @durable-streams/y-durable-streams yjs y-protocols lib0
```

## Quick Start

```typescript
import { YjsProvider } from "@durable-streams/y-durable-streams"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"

const doc = new Y.Doc()
const awareness = new Awareness(doc)

const provider = new YjsProvider({
  doc,
  baseUrl: "http://localhost:4438/v1/yjs/my-service",
  docId: "my-document",
  awareness,
})

provider.on("synced", (synced) => {
  console.log("Synced:", synced)
})
```

## Usage

### Document Only (No Presence)

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl: "http://localhost:4438/v1/yjs/my-service",
  docId: "my-document",
})
```

### With Authentication

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl: "http://localhost:4438/v1/yjs/my-service",
  docId: "my-document",
  awareness,
  headers: {
    Authorization: "Bearer your-token",
  },
})
```

### Manual Connection

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl,
  docId,
  connect: false, // Don't connect automatically
})

// Set up listeners first
provider.on("synced", handleSync)
provider.on("error", handleError)

// Then connect
await provider.connect()
```

### Event Handling

```typescript
// Sync state changes
provider.on("synced", (synced: boolean) => {
  if (synced) {
    console.log("Document is synced with server")
  }
})

// Connection status changes
provider.on("status", (status: YjsProviderStatus) => {
  console.log("Status:", status) // "disconnected" | "connecting" | "connected"
})

// Error handling
provider.on("error", (error: Error) => {
  console.error("Provider error:", error)
})
```

### Cleanup

```typescript
// Disconnect temporarily
provider.disconnect()

// Reconnect
await provider.connect()

// Destroy permanently
provider.destroy()
```

## API

### YjsProvider

```typescript
class YjsProvider {
  constructor(options: YjsProviderOptions)

  // Properties
  readonly doc: Y.Doc
  readonly synced: boolean
  readonly connected: boolean
  readonly connecting: boolean

  // Methods
  connect(): Promise<void>
  disconnect(): void
  destroy(): void

  // Events
  on(event: "synced", handler: (synced: boolean) => void): void
  on(event: "status", handler: (status: YjsProviderStatus) => void): void
  on(event: "error", handler: (error: Error) => void): void
}
```

### Options

```typescript
interface YjsProviderOptions {
  doc: Y.Doc
  baseUrl: string // Yjs server URL, e.g. "http://localhost:4438/v1/yjs/my-service"
  docId: string // Document identifier
  awareness?: Awareness // Optional awareness for presence
  headers?: HeadersRecord // Optional auth headers
  connect?: boolean // Auto-connect on construction (default: true)
  debug?: boolean // Enable debug logging (default: false)
}
```

## Server

The package includes a Yjs server that implements the protocol. For development/testing:

```typescript
import { YjsServer } from "@durable-streams/y-durable-streams/server"

const server = new YjsServer({
  port: 4438,
  dsServerUrl: "http://localhost:4437", // Durable streams server
})

await server.start()
console.log(`Yjs server running at ${server.url}`)
```

## Conformance Tests

The package includes conformance tests to verify Yjs server implementations. By default, tests run against local test servers. To test against an external server:

```bash
# Run tests against an external Yjs server
YJS_CONFORMANCE_URL=http://localhost:4438/v1/yjs/test pnpm vitest run --project y-durable-streams

# Run tests with local test servers (default)
pnpm vitest run --project y-durable-streams
```

Note: The "Server Restart" test is skipped when using an external URL since it requires starting/stopping local servers.

## Server Protocol API

To build a compatible Yjs server, implement the following endpoints. All streams use the [Durable Streams protocol](../README.md) for reads (offset-based, long-polling/SSE) and writes (append-only).

### Base URL Structure

```
{baseUrl}/docs/{docId}/{streamType}[/{streamId}]
```

Where `baseUrl` is typically `http://host:port/v1/yjs/{service}`.

### Endpoints

#### Index Stream

```
GET {baseUrl}/docs/{docId}/index
```

Returns the document's current state pointer as JSON. The provider fetches this first to discover where to read data.

**Response body** (`application/json`):

```typescript
interface YjsIndex {
  // Snapshot stream ID, or null if no snapshot exists
  // e.g., "snapshot-550e8400-e29b-41d4-a716-446655440000"
  snapshot_stream: string | null

  // Updates stream ID where updates are written
  // e.g., "updates-001"
  updates_stream: string

  // Offset to start reading updates from
  // "-1" means read from beginning, otherwise a padded offset string
  update_offset: string
}
```

**Default for new documents**: Return `{ snapshot_stream: null, updates_stream: "updates-001", update_offset: "-1" }` or 404 (provider handles both).

#### Updates Stream

```
GET  {baseUrl}/docs/{docId}/updates/{streamId}
POST {baseUrl}/docs/{docId}/updates/{streamId}
```

Binary stream of Yjs updates, framed using lib0 `VarUint8Array` encoding.

**Content-Type**: `application/octet-stream`

**Read (GET)**:

- Query params: `offset`, `live` (supports `auto` for long-polling)
- Returns lib0-framed updates: each update is prefixed with its length as a varint

**Write (POST)**:

- Body: lib0-framed Yjs update(s)
- Supports idempotent producer headers for exactly-once delivery

**Framing format**:

```
[varint length][update bytes][varint length][update bytes]...
```

#### Snapshots Stream

```
GET {baseUrl}/docs/{docId}/snapshots/{snapshotId}
```

Binary Yjs document state (result of `Y.encodeStateAsUpdate(doc)`).

**Content-Type**: `application/octet-stream`

**Read (GET)**:

- Query param: `offset=-1` (read full snapshot)
- Returns raw Yjs state vector, no framing

Snapshots are created by the server during compaction. The `snapshotId` comes from the index's `snapshot_stream` field.

#### Awareness Stream

```
GET  {baseUrl}/docs/{docId}/awareness
POST {baseUrl}/docs/{docId}/awareness
```

Ephemeral presence data (cursors, selections, user info).

**Content-Type**: `text/plain`

**Read (GET)**:

- Query params: `offset=now`, `live=sse` (Server-Sent Events)
- Returns base64-encoded awareness updates

**Write (POST)**:

- Body: base64-encoded awareness update (from `y-protocols/awareness`)

### Compaction

Servers should periodically compact documents by:

1. Reading current snapshot (if any) + all updates since `update_offset`
2. Merging into a new Yjs document state
3. Writing new snapshot to `snapshots/{new-uuid}`
4. Updating index with new `snapshot_stream` and `update_offset`
5. Deleting old snapshot (optional)

The updates stream is **never rotated** - only the offset advances. This allows existing long-poll connections to continue uninterrupted.

### Error Responses

| Status | Meaning                   |
| ------ | ------------------------- |
| 404    | Stream/document not found |
| 409    | Conflict (stream exists)  |
| 401    | Unauthorized              |
| 403    | Forbidden                 |
| 500    | Server error              |

## How It Works

The provider connects to a Yjs server which manages document storage using durable streams:

1. **Index** - Tracks current snapshot and updates stream locations
2. **Snapshots** - Full document state at a point in time
3. **Updates** - Incremental Yjs updates since last snapshot (long-polling)
4. **Presence** - Ephemeral awareness data via SSE (cursors, selections, user info)

The server automatically compacts documents by creating new snapshots when updates exceed a threshold. This keeps sync fast for new clients joining.

## License

Apache-2.0
