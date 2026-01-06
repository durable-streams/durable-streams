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

## Fault Injection

The server includes a comprehensive fault injection system for testing client resilience. This allows you to simulate various failure modes including HTTP errors, network delays, connection drops, and data corruption.

### Basic Usage

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer()
await server.start()

// Inject a 500 error on the next request
server.injectFault("/my-stream", { status: 500 })

// Inject multiple consecutive errors
server.injectFault("/my-stream", { status: 503, count: 3 })

// Clean up faults after test
server.clearInjectedFaults()
```

### Fault Types

#### HTTP Errors

Return specific HTTP status codes to test retry logic:

```typescript
// Server error (client should retry)
server.injectFault("/my-stream", { status: 500 })

// Service unavailable (client should retry)
server.injectFault("/my-stream", { status: 503 })

// Rate limiting with Retry-After header
server.injectFault("/my-stream", { status: 429, retryAfter: 5 })

// Client error (client should NOT retry)
server.injectFault("/my-stream", { status: 400 })
```

#### Network Delays

Simulate network latency or slow servers:

```typescript
// Fixed 500ms delay
server.injectFault("/my-stream", { delayMs: 500 })

// Variable delay: 300-600ms (300 + random 0-300)
server.injectFault("/my-stream", { delayMs: 300, jitterMs: 300 })

// Delay then error
server.injectFault("/my-stream", { delayMs: 200, status: 503 })
```

#### Connection Drops

Simulate network failures by destroying the socket:

```typescript
// Drop connection immediately
server.injectFault("/my-stream", { dropConnection: true })

// Drop after delay (mid-request timeout)
server.injectFault("/my-stream", { delayMs: 1000, dropConnection: true })

// Multiple consecutive drops
server.injectFault("/my-stream", { dropConnection: true, count: 2 })
```

#### Body Corruption

Test data integrity handling:

```typescript
// Corrupt response body (flips ~3% of bits)
server.injectFault("/my-stream", { corruptBody: true })

// Truncate response to simulate incomplete transfer
server.injectFault("/my-stream", { truncateBodyBytes: 50 })
```

### Advanced Features

#### Method-Specific Faults

Target specific HTTP methods:

```typescript
// Only fail POST (append) requests, GET (read) works normally
server.injectFault("/my-stream", { status: 503, method: "POST" })

// Only fail GET (read) requests
server.injectFault("/my-stream", { status: 500, method: "GET" })
```

#### Probabilistic Faults

Simulate intermittent failures for chaos testing:

```typescript
// 20% failure rate over next 100 requests
server.injectFault("/my-stream", {
  status: 500,
  probability: 0.2,
  count: 100,
})

// 50% chance of 200ms delay
server.injectFault("/my-stream", {
  delayMs: 200,
  probability: 0.5,
  count: 50,
})
```

### Fault Lifecycle

1. Faults are registered via `injectFault(path, config)`
2. Each matching request decrements the fault's `count`
3. When `count` reaches 0, the fault is automatically removed
4. Only one fault can be active per path (new faults replace existing ones)
5. Probabilistic faults only decrement `count` when they actually trigger

### HTTP API

Faults can also be injected via HTTP for cross-language testing:

```bash
# Inject a fault
curl -X POST http://localhost:4437/_test/inject-error \
  -H "Content-Type: application/json" \
  -d '{"path": "/my-stream", "status": 503, "count": 2}'

# Clear all faults
curl -X DELETE http://localhost:4437/_test/inject-error
```

### Test Patterns

```typescript
describe("retry behavior", () => {
  let server: DurableStreamTestServer

  beforeAll(async () => {
    server = new DurableStreamTestServer()
    await server.start()
  })

  afterEach(() => {
    // Always clean up faults between tests
    server.clearInjectedFaults()
  })

  afterAll(async () => {
    await server.stop()
  })

  test("retries on 500 error", async () => {
    // Fail first 2 requests, third succeeds
    server.injectFault("/test-stream", { status: 500, count: 2 })

    // Client should retry and eventually succeed
    const data = await client.read("/test-stream")
    expect(data).toBeDefined()
  })

  test("handles connection drops", async () => {
    server.injectFault("/test-stream", { dropConnection: true })

    // Client should retry after connection error
    const data = await client.read("/test-stream")
    expect(data).toBeDefined()
  })
})
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
