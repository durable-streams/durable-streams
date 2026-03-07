# @durable-streams/server

Node.js reference server implementation for the Durable Streams protocol.

## Installation

```bash
npm install @durable-streams/server
```

## Overview

This package provides a reference implementation of the Durable Streams protocol for Node.js. It supports both in-memory and file-backed storage modes, making it suitable for development, testing, and production workloads.

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

Fast, ephemeral storage for development and testing:

```typescript
import { DurableStreamTestServer, MemoryStore } from "@durable-streams/server"

const storage = new MemoryStore()
const server = new DurableStreamTestServer({
  port: 4437,
  storage,
})
```

### File-Backed

Persistent storage with streams stored as log files and LMDB for metadata:

```typescript
import { DurableStreamTestServer, FileStore } from "@durable-streams/server"

const storage = new FileStore({ dataDir: "./data/streams" })
const server = new DurableStreamTestServer({
  port: 4437,
  storage,
})
```

### Custom Storage

Implement the `Store` interface for custom backends (e.g. NATS, Redis, PostgreSQL):

```typescript
import type { Store } from "@durable-streams/server"
import { DurableStreamTestServer } from "@durable-streams/server"

class MyCustomStore implements Store {
  // Implement the Store interface methods
}

const server = new DurableStreamTestServer({
  port: 4437,
  storage: new MyCustomStore(),
})
```

## Registry Hooks

Track stream lifecycle events (creation, deletion):

```typescript
import {
  DurableStreamTestServer,
  createRegistryHooks,
} from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 4437,
  hooks: createRegistryHooks({
    registryPath: "__registry__",
  }),
})
```

The registry maintains a system stream that tracks all stream creates and deletes, useful for building admin UIs or monitoring.

## API

### DurableStreamTestServer

```typescript
interface TestServerOptions {
  port?: number
  host?: string
  storage?: Store
  dataDir?: string
  onStreamCreated?: StreamLifecycleHook
  onStreamDeleted?: StreamLifecycleHook
  compression?: boolean
  cursorIntervalSeconds?: number
  cursorEpoch?: Date
}

class DurableStreamTestServer {
  constructor(options?: TestServerOptions)
  start(): Promise<string>
  stop(): Promise<void>
  get url(): string
}
```

### Store Interface

All storage backends implement the `Store` interface. See the type exports for full details.

Built-in implementations:

- **`MemoryStore`** — Fast, ephemeral in-memory storage
- **`FileStore`** — Persistent storage using LMDB + append-only log files

### StreamManager

Protocol logic layer that wraps any `Store` implementation. Handles producer validation, JSON processing, content-type matching, long-poll management, and stream closure.

## Exports

```typescript
export { DurableStreamTestServer } from "./server"
export { StreamManager } from "./stream-manager"
export { MemoryStore } from "./memory-store"
export { FileStore } from "./file-store"
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
  AppendMetadata,
  Store,
  StoreConfig,
  StreamInfo,
  StoredMessage,
  SerializableProducerState,
  ClosedByInfo,
} from "./store"
export type {
  Stream,
  StreamMessage,
  TestServerOptions,
  PendingLongPoll,
  StreamLifecycleEvent,
  StreamLifecycleHook,
} from "./types"
```

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
