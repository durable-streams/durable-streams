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

## How It Works

The provider connects to a Yjs server which manages document storage using durable streams:

1. **Index** - Tracks current snapshot and updates stream locations
2. **Snapshots** - Full document state at a point in time
3. **Updates** - Incremental Yjs updates since last snapshot (long-polling)
4. **Presence** - Ephemeral awareness data via SSE (cursors, selections, user info)

The server automatically compacts documents by creating new snapshots when updates exceed a threshold. This keeps sync fast for new clients joining.

## License

Apache-2.0
