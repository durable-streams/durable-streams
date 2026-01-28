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

For the complete protocol specification, see [PROTOCOL.md](./PROTOCOL.md).

### Base URL Structure

Each document is accessed via a single URL with query parameters:

```
{baseUrl}/docs/{docPath}?{queryParams}
```

Where:

- `baseUrl` is typically `http://host:port/v1/yjs/{service}`
- `docPath` can include forward slashes (e.g., `project/chapter-1`)

### Key Operations

#### Snapshot Discovery

```
GET {baseUrl}/docs/{docPath}?offset=snapshot
```

Returns a **307 redirect** to either:

- `?offset={N}_snapshot` if a snapshot exists
- `?offset=-1` if no snapshot (read from beginning)

#### Read Snapshot

```
GET {baseUrl}/docs/{docPath}?offset={N}_snapshot
```

Returns binary Yjs snapshot with `stream-next-offset` header indicating where to continue reading updates.

#### Read/Write Updates

```
GET  {baseUrl}/docs/{docPath}?offset={N}&live=true
POST {baseUrl}/docs/{docPath}
```

- **Read**: Get updates from offset, optionally with `live=true` for long-polling
- **Write**: POST raw Yjs update bytes (server handles lib0 framing)

#### Awareness (Presence)

```
GET  {baseUrl}/docs/{docPath}?awareness=default&offset=now&live=true
POST {baseUrl}/docs/{docPath}?awareness=default
```

Named awareness streams via query parameter. Uses SSE for real-time delivery.

### Compaction

The server automatically compacts documents when updates exceed a threshold:

1. Read current state (snapshot + updates)
2. Create new snapshot at current offset
3. Update internal index stream
4. Delete old snapshot

Compaction is transparent to clients - existing connections continue uninterrupted.

### Error Responses

| Status | Code                 | Meaning                  |
| ------ | -------------------- | ------------------------ |
| 400    | `INVALID_REQUEST`    | Invalid path or offset   |
| 401    | `UNAUTHORIZED`       | Missing/invalid auth     |
| 404    | `SNAPSHOT_NOT_FOUND` | Snapshot deleted (retry) |
| 404    | `DOCUMENT_NOT_FOUND` | Document doesn't exist   |
| 410    | `OFFSET_EXPIRED`     | Offset too old           |

## How It Works

The provider connects to a Yjs server which manages document storage using durable streams:

1. **Snapshot Discovery** - Client requests `?offset=snapshot`, server redirects to current snapshot or beginning
2. **Snapshot Loading** - Binary Yjs state with `stream-next-offset` header for where to continue
3. **Live Updates** - Long-poll for incremental updates from the offset
4. **Awareness** - Optional SSE stream for presence (cursors, selections, user info)

The server automatically compacts documents when updates exceed a threshold, creating new snapshots. This keeps initial sync fast for new clients. The protocol uses a single URL per document with query parameters for different operations.

## License

Apache-2.0
