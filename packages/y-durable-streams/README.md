# @durable-streams/y-durable-streams

Yjs provider for Durable Streams - sync Yjs documents over append-only streams with optional awareness (presence) support.

## Overview

This package provides a Yjs provider that syncs documents using the Durable Streams protocol. Unlike WebSocket-based providers, it uses HTTP long-polling over append-only streams, making it simpler to deploy and scale.

Key benefits:

- **No WebSocket infrastructure** - Works with standard HTTP load balancers and CDNs
- **Built-in persistence** - Document history is stored in the stream itself
- **Scalable** - Clients connect directly to streams, no central sync server needed
- **Presence support** - Optional awareness stream for cursors, selections, and user status

## Installation

```bash
npm install @durable-streams/y-durable-streams yjs y-protocols lib0
```

## Quick Start

```typescript
import { DurableStreamsProvider } from "@durable-streams/y-durable-streams"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"

const doc = new Y.Doc()
const awareness = new Awareness(doc)

const provider = new DurableStreamsProvider({
  doc,
  documentStream: {
    url: "https://your-server.com/v1/stream/rooms/my-room",
  },
  awarenessStream: {
    url: "https://your-server.com/v1/stream/presence/my-room",
    protocol: awareness,
  },
})

provider.on("synced", (synced) => {
  console.log("Synced:", synced)
})
```

## Usage

### Document Only (No Presence)

```typescript
const provider = new DurableStreamsProvider({
  doc,
  documentStream: {
    url: "https://your-server.com/v1/stream/rooms/my-room",
  },
})
```

### With Authentication

```typescript
const provider = new DurableStreamsProvider({
  doc,
  documentStream: {
    url: "https://your-server.com/v1/stream/rooms/my-room",
    headers: {
      Authorization: "Bearer your-token",
    },
  },
  awarenessStream: {
    url: "https://your-server.com/v1/stream/presence/my-room",
    protocol: awareness,
    headers: {
      Authorization: "Bearer your-token",
    },
  },
})
```

### Manual Connection

```typescript
const provider = new DurableStreamsProvider({
  doc,
  documentStream: { url },
  connect: false, // Don't connect automatically
})

// Set up listeners first
provider.on("synced", handleSync)
provider.on("error", handleError)

// Then connect
provider.connect()
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
provider.on("status", (status: ProviderStatus) => {
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
provider.connect()

// Destroy permanently
provider.destroy()
```

## API

### DurableStreamsProvider

```typescript
class DurableStreamsProvider {
  constructor(options: DurableStreamsProviderOptions)

  // Properties
  readonly doc: Y.Doc
  readonly synced: boolean
  readonly connected: boolean
  readonly connecting: boolean
  readonly status: ProviderStatus

  // Methods
  connect(): void
  disconnect(): void
  destroy(): void

  // Events
  on(event: "synced", handler: (synced: boolean) => void): void
  on(event: "status", handler: (status: ProviderStatus) => void): void
  on(event: "error", handler: (error: Error) => void): void
}
```

### Options

```typescript
interface DurableStreamsProviderOptions {
  doc: Y.Doc
  documentStream: StreamConfig
  awarenessStream?: AwarenessConfig
  connect?: boolean // default: true
  debug?: boolean // default: false
}

interface StreamConfig {
  url: string | URL
  headers?: Record<string, string | (() => string)>
}

interface AwarenessConfig extends StreamConfig {
  protocol: Awareness
}
```

## How It Works

The provider uses two separate durable streams:

1. **Document Stream** - Stores Yjs document updates. Reads from the beginning to replay full document history on connect.

2. **Awareness Stream** - Syncs presence data (cursors, selections, user info). Reads from current position since historical presence is not needed.

Both streams use long-polling for real-time updates. Updates are encoded using lib0's VarUint8Array framing.

## License

Apache-2.0
