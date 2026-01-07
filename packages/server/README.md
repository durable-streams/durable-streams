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
import { DurableStreamTestServer, StreamStore } from "@durable-streams/server"

const store = new StreamStore()
const server = new DurableStreamTestServer({
  port: 4437,
  store,
})
```

### File-Backed

Persistent storage with streams stored as log files and LMDB for metadata:

```typescript
import {
  DurableStreamTestServer,
  FileBackedStreamStore,
} from "@durable-streams/server"

const store = new FileBackedStreamStore({
  path: "./data/streams",
})
const server = new DurableStreamTestServer({
  port: 4437,
  store,
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
  store?: StreamStore | FileBackedStreamStore
  hooks?: StreamLifecycleHook[]
  cors?: boolean
  cursorOptions?: CursorOptions
}

class DurableStreamTestServer {
  constructor(options?: TestServerOptions)
  start(): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string
}
```

### StreamStore

In-memory stream storage:

```typescript
class StreamStore {
  create(path: string, contentType: string, options?: CreateOptions): Stream
  get(path: string): Stream | undefined
  delete(path: string): boolean
  append(path: string, data: Uint8Array, seq?: string): void
  read(path: string, offset: string): ReadResult
}
```

### FileBackedStreamStore

File-backed persistent storage (log files for streams, LMDB for metadata) with the same interface as `StreamStore`.

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
