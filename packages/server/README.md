# @durable-streams/server

Node.js reference server implementation for the Durable Streams protocol.

## Installation

```bash
npm install @durable-streams/server
```

## Overview

This package provides a reference implementation of the Durable Streams protocol for Node.js. It supports both in-memory and file-backed storage modes, making it suitable for development, testing, and prototyping. For production deployments, use the [Caddy plugin](../caddy-plugin/README.md) or [Electric Cloud](https://electric-sql.com/cloud).

For a standalone binary option, see the [Caddy-based server](https://github.com/durable-streams/durable-streams/releases).

## Quick Start

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 4437,
  host: "127.0.0.1",
})

await server.start()
console.log("Server running on http://127.0.0.1:4437")
```

## Storage Modes

### In-Memory (Default)

Fast, ephemeral storage for development and testing. Omit `dataDir` to use in-memory:

```typescript
const server = new DurableStreamTestServer({ port: 4437 })
```

### File-Backed

Persistent storage with streams stored as log files and LMDB for metadata:

```typescript
const server = new DurableStreamTestServer({
  port: 4437,
  dataDir: "./data/streams",
})
```

## Lifecycle Hooks

Track stream creation and deletion events:

```typescript
const server = new DurableStreamTestServer({
  port: 4437,
  onStreamCreated: (event) => {
    console.log(`Stream created: ${event.path} (${event.contentType})`)
  },
  onStreamDeleted: (event) => {
    console.log(`Stream deleted: ${event.path}`)
  },
})
```

## API

### DurableStreamTestServer

````typescript
interface TestServerOptions {
  port?: number                          // Default: 4437
  host?: string                          // Default: "127.0.0.1"
  longPollTimeout?: number               // Default: 30000 (ms)
  dataDir?: string                       // File-backed storage; omit for in-memory
  onStreamCreated?: StreamLifecycleHook  // Hook for stream creation
  onStreamDeleted?: StreamLifecycleHook  // Hook for stream deletion
  compression?: boolean                  // Default: true
  cursorIntervalSeconds?: number         // Default: 20
  cursorEpoch?: Date                     // Epoch for cursor calculation
}

class DurableStreamTestServer {
  constructor(options?: TestServerOptions)
  start(): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string
}

## Exports

```typescript
export { DurableStreamTestServer } from "./server"
export { StreamStore } from "./store"
export { FileBackedStreamStore } from "./file-store"
export { encodeStreamPath, decodeStreamPath } from "./path-encoding"
export { createRegistryHooks } from "./registry-hook"
export {
  calculateCursor,
  handleCursorCollision,
  generateResponseCursor,
  DEFAULT_CURSOR_EPOCH,
  DEFAULT_CURSOR_INTERVAL_SECONDS,
  type CursorOptions,
} from "./cursor"
export type {
  Stream,
  StreamMessage,
  TestServerOptions,
  PendingLongPoll,
  StreamLifecycleEvent,
  StreamLifecycleHook,
} from "./types"
````

## Testing Your Implementation

Use the conformance test suite to validate protocol compliance:

```typescript
import { runConformanceTests } from "@durable-streams/server-conformance-tests"

runConformanceTests({
  baseUrl: "http://localhost:4437",
})
```

## License

Apache-2.0
