# @durable-streams/server

Node.js reference server implementation for the Durable Streams protocol.

## Installation

```bash
npm install @durable-streams/server
```

## Overview

This package provides a reference implementation of the Durable Streams protocol for Node.js. It supports both in-memory and file-backed storage modes, making it suitable for development, testing, and production workloads.

**Two ways to use this package:**

1. **Standalone Server** - Run a complete HTTP server with `DurableStreamTestServer` (quick start, testing)
2. **Embedded Router** - Embed `DurableStreamRouter` into your existing Express, Fastify, or vanilla Node.js server (production use)

For a standalone binary option, see the [Caddy-based server](https://github.com/durable-streams/durable-streams/releases).

## Quick Start

### Standalone Server

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 4437,
  host: "127.0.0.1",
})

await server.start()
console.log("Server running on http://127.0.0.1:4437")
```

### Embedded Router

Embed into your existing HTTP server:

```typescript
import express from "express"
import { DurableStreamRouter, StreamStore } from "@durable-streams/server"

const app = express()
const router = new DurableStreamRouter({
  store: new StreamStore(),
  baseUrl: "/api/streams", // Auto-strips this prefix
})

app.use("/api/streams", (req, res) => router.handleRequest(req, res))
app.listen(3000)

// Streams available at: http://localhost:3000/api/streams/my-stream
```

## Storage Modes

### In-Memory (Default)

Fast, ephemeral storage for development and testing:

```typescript
import { DurableStreamTestServer, StreamStore } from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 4437,
  // In-memory is the default (no dataDir specified)
})
```

### File-Backed

Persistent storage with streams stored as log files and LMDB for metadata:

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 4437,
  dataDir: "./data/streams", // Enables file-backed mode
})
```

With embedded router:

```typescript
import {
  DurableStreamRouter,
  FileBackedStreamStore,
} from "@durable-streams/server"

const router = new DurableStreamRouter({
  store: new FileBackedStreamStore({
    dataDir: "./data/streams",
  }),
})
```

## API Reference

### DurableStreamRouter

**Core router class for embedding into any Node.js HTTP server.**

```typescript
interface RouterOptions {
  store: StreamStore | FileBackedStreamStore // Required: backing store
  longPollTimeout?: number // Default: 30000ms
  compression?: boolean // Default: true (gzip/deflate)
  cors?: boolean // Default: true (CORS headers)
  baseUrl?: string // Default: undefined (path prefix to strip)
  cursorIntervalSeconds?: number // Default: 20 (CDN caching)
  cursorEpoch?: Date // Default: 2024-10-09
  onStreamCreated?: StreamLifecycleHook
  onStreamDeleted?: StreamLifecycleHook
}

class DurableStreamRouter {
  constructor(options: RouterOptions)

  // Main entry point - call from your HTTP server
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>

  // Graceful shutdown (closes SSE connections, pending long-polls)
  shutdown(): Promise<void>

  // Clear all streams
  clear(): void

  // Access to underlying store
  readonly store: StreamStore | FileBackedStreamStore
}
```

#### Usage Examples

**Vanilla Node.js HTTP Server:**

```typescript
import { createServer } from "node:http"
import { DurableStreamRouter, StreamStore } from "@durable-streams/server"

const router = new DurableStreamRouter({
  store: new StreamStore(),
})

const server = createServer((req, res) => {
  router.handleRequest(req, res).catch((err) => {
    console.error("Request error:", err)
    if (!res.headersSent) {
      res.writeHead(500)
      res.end("Internal Server Error")
    }
  })
})

server.listen(3000)

// Graceful shutdown
process.on("SIGTERM", async () => {
  await router.shutdown()
  server.close()
})
```

**Express:**

```typescript
import express from "express"
import { DurableStreamRouter, StreamStore } from "@durable-streams/server"

const app = express()
const router = new DurableStreamRouter({
  store: new StreamStore(),
  baseUrl: "/api/streams",
})

app.use("/api/streams", (req, res) => router.handleRequest(req, res))
app.listen(3000)
```

**Fastify:**

```typescript
import fastify from "fastify"
import { DurableStreamRouter, StreamStore } from "@durable-streams/server"

const app = fastify()
const router = new DurableStreamRouter({
  store: new StreamStore(),
  cors: false, // Let Fastify handle CORS
})

app.all("/streams/*", async (request, reply) => {
  await router.handleRequest(request.raw, reply.raw)
})

await app.listen({ port: 3000 })
```

**With Custom Authentication:**

```typescript
import { createServer } from "node:http"
import {
  DurableStreamRouter,
  FileBackedStreamStore,
} from "@durable-streams/server"

const router = new DurableStreamRouter({
  store: new FileBackedStreamStore({ dataDir: "./data" }),
})

const server = createServer(async (req, res) => {
  // Custom authentication
  const token = req.headers.authorization?.replace("Bearer ", "")
  if (!token || !isValidToken(token)) {
    res.writeHead(401, { "content-type": "text/plain" })
    res.end("Unauthorized")
    return
  }

  // Route to streams
  await router.handleRequest(req, res)
})

server.listen(3000)
```

**Sub-route Mounting:**

```typescript
import { createServer } from "node:http"
import { DurableStreamRouter, StreamStore } from "@durable-streams/server"

const router = new DurableStreamRouter({
  store: new StreamStore(),
  baseUrl: "/api/v1/streams", // Automatically strips this prefix
})

const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/api/v1/streams/")) {
    // Router automatically strips "/api/v1/streams" prefix
    await router.handleRequest(req, res)
    return
  }

  // Other routes...
  res.writeHead(404)
  res.end("Not Found")
})

server.listen(3000)
```

### DurableStreamTestServer

**Complete HTTP server with fault injection for testing.**

```typescript
interface TestServerOptions {
  port?: number // Default: 4437
  host?: string // Default: "127.0.0.1"
  longPollTimeout?: number // Default: 30000ms
  dataDir?: string // If set, uses FileBackedStreamStore
  compression?: boolean // Default: true
  cursorIntervalSeconds?: number // Default: 20
  cursorEpoch?: Date // Default: 2024-10-09
  onStreamCreated?: StreamLifecycleHook
  onStreamDeleted?: StreamLifecycleHook
}

class DurableStreamTestServer {
  constructor(options?: TestServerOptions)

  // Server lifecycle
  start(): Promise<string> // Returns server URL
  stop(): Promise<void>
  get url(): string

  // Stream management
  clear(): void
  readonly store: StreamStore | FileBackedStreamStore

  // Fault injection (for testing)
  injectError(
    path: string,
    status: number,
    count?: number,
    retryAfter?: number
  ): void
  clearInjectedErrors(): void
}
```

#### Usage Example

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 4437,
  dataDir: "./data", // Persistent storage
  onStreamCreated: async (event) => {
    console.log(`Stream created: ${event.path}`)
  },
})

await server.start()
console.log(`Server running at ${server.url}`)

// Test fault injection
server.injectError("/test-stream", 503, 2) // Returns 503 twice

// Cleanup
await server.stop()
```

### FaultInjectionMiddleware

**Test-only middleware for injecting HTTP errors.**

```typescript
interface FaultInjectionOptions {
  enableTestEndpoint?: boolean // Default: false (enables POST /_test/inject-error)
}

class FaultInjectionMiddleware {
  constructor(options?: FaultInjectionOptions)

  // Middleware handler (call before router)
  handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => Promise<void>
  ): Promise<void>

  // Programmatic API
  injectError(
    path: string,
    status: number,
    count?: number,
    retryAfter?: number
  ): void
  clearInjectedErrors(): void
}
```

#### Usage Example

```typescript
import { createServer } from "node:http"
import {
  DurableStreamRouter,
  FaultInjectionMiddleware,
  StreamStore,
} from "@durable-streams/server"

const router = new DurableStreamRouter({ store: new StreamStore() })
const faultInjection = new FaultInjectionMiddleware({
  enableTestEndpoint: true, // Enables POST /_test/inject-error
})

const server = createServer((req, res) => {
  // Compose middleware: fault injection wraps router
  faultInjection.handleRequest(req, res, () => router.handleRequest(req, res))
})

server.listen(3000)

// In tests:
faultInjection.injectError("/my-stream", 503, 2) // Returns 503 twice
faultInjection.injectError("/slow-stream", 429, 1, 10) // Returns 429 with Retry-After: 10

// Or via HTTP (if enableTestEndpoint: true):
await fetch("http://localhost:3000/_test/inject-error", {
  method: "POST",
  body: JSON.stringify({
    path: "/my-stream",
    status: 503,
    count: 2,
    retryAfter: 5,
  }),
})
```

### StreamStore

In-memory stream storage:

```typescript
class StreamStore {
  create(path: string, options?: CreateOptions): Stream
  get(path: string): Stream | undefined
  has(path: string): boolean
  delete(path: string): boolean
  append(path: string, data: Uint8Array, options?: AppendOptions): StreamMessage
  read(path: string, offset?: string): ReadResult
  waitForMessages(
    path: string,
    offset: string,
    timeout: number
  ): Promise<WaitResult>
  formatResponse(path: string, messages: StreamMessage[]): Uint8Array
  getCurrentOffset(path: string): string
  clear(): void
  list(): string[]
}
```

### FileBackedStreamStore

File-backed persistent storage (log files for streams, LMDB for metadata) with the same interface as `StreamStore`.

```typescript
class FileBackedStreamStore {
  constructor(options: { dataDir: string })

  // Same interface as StreamStore
  create(path: string, options?: CreateOptions): Stream
  get(path: string): Stream | undefined
  // ... (same methods as StreamStore)

  // Additional method for cleanup
  close(): Promise<void>
}
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
  onStreamCreated: async (event) => {
    console.log(`Created: ${event.path} (${event.contentType})`)
  },
  onStreamDeleted: async (event) => {
    console.log(`Deleted: ${event.path}`)
  },
})
```

Or use the registry hook helper:

```typescript
import { createRegistryHooks } from "@durable-streams/server"

const hooks = createRegistryHooks({
  registryPath: "__registry__",
})

const server = new DurableStreamTestServer({
  port: 4437,
  onStreamCreated: hooks.onStreamCreated,
  onStreamDeleted: hooks.onStreamDeleted,
})
```

The registry maintains a system stream that tracks all stream creates and deletes, useful for building admin UIs or monitoring.

## Configuration Options

### RouterOptions

| Option                  | Type                                   | Default      | Description                              |
| ----------------------- | -------------------------------------- | ------------ | ---------------------------------------- |
| `store`                 | `StreamStore \| FileBackedStreamStore` | Required     | Backing store for streams                |
| `longPollTimeout`       | `number`                               | `30000`      | Long-poll timeout in milliseconds        |
| `compression`           | `boolean`                              | `true`       | Enable gzip/deflate compression          |
| `cors`                  | `boolean`                              | `true`       | Enable CORS headers                      |
| `baseUrl`               | `string`                               | `undefined`  | Path prefix to automatically strip       |
| `cursorIntervalSeconds` | `number`                               | `20`         | Cursor interval for CDN cache collapsing |
| `cursorEpoch`           | `Date`                                 | `2024-10-09` | Epoch for cursor calculation             |
| `onStreamCreated`       | `StreamLifecycleHook`                  | `undefined`  | Hook called when a stream is created     |
| `onStreamDeleted`       | `StreamLifecycleHook`                  | `undefined`  | Hook called when a stream is deleted     |

### TestServerOptions

| Option                  | Type                  | Default       | Description                                |
| ----------------------- | --------------------- | ------------- | ------------------------------------------ |
| `port`                  | `number`              | `4437`        | Port to listen on                          |
| `host`                  | `string`              | `"127.0.0.1"` | Host to bind to                            |
| `dataDir`               | `string`              | `undefined`   | If set, enables file-backed mode with LMDB |
| `longPollTimeout`       | `number`              | `30000`       | Long-poll timeout in milliseconds          |
| `compression`           | `boolean`             | `true`        | Enable gzip/deflate compression            |
| `cursorIntervalSeconds` | `number`              | `20`          | Cursor interval for CDN cache collapsing   |
| `cursorEpoch`           | `Date`                | `2024-10-09`  | Epoch for cursor calculation               |
| `onStreamCreated`       | `StreamLifecycleHook` | `undefined`   | Hook called when a stream is created       |
| `onStreamDeleted`       | `StreamLifecycleHook` | `undefined`   | Hook called when a stream is deleted       |

## Exports

```typescript
// Main classes
export { DurableStreamTestServer } from "./server"
export { DurableStreamRouter } from "./router"
export {
  FaultInjectionMiddleware,
  type InjectedError,
  type FaultInjectionOptions,
} from "./fault-injection"

// Storage
export { StreamStore } from "./store"
export { FileBackedStreamStore } from "./file-store"

// Utilities
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

// Types
export type {
  Stream,
  StreamMessage,
  TestServerOptions,
  RouterOptions,
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

## Complete Examples

### Production Server with Auth and File Storage

```typescript
import { createServer } from "node:http"
import {
  DurableStreamRouter,
  FileBackedStreamStore,
} from "@durable-streams/server"

// Create persistent storage
const store = new FileBackedStreamStore({
  dataDir: process.env.DATA_DIR || "./data",
})

// Create router
const router = new DurableStreamRouter({
  store,
  compression: true,
  cors: false, // Handle CORS at load balancer level
  baseUrl: "/api/v1/streams",
  onStreamCreated: async (event) => {
    console.log(`[STREAM] Created: ${event.path}`)
    // Send to monitoring/analytics
  },
  onStreamDeleted: async (event) => {
    console.log(`[STREAM] Deleted: ${event.path}`)
  },
})

// Create HTTP server with auth
const server = createServer(async (req, res) => {
  // Authentication
  const token = req.headers.authorization?.replace("Bearer ", "")
  if (!token || !isValidToken(token)) {
    res.writeHead(401, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "Unauthorized" }))
    return
  }

  // Route to streams API
  if (req.url?.startsWith("/api/v1/streams/")) {
    await router.handleRequest(req, res)
    return
  }

  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: "ok" }))
    return
  }

  // 404
  res.writeHead(404)
  res.end("Not Found")
})

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...")
  await router.shutdown() // Close SSE connections
  await store.close() // Close LMDB database
  server.close()
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

// Start server
const port = parseInt(process.env.PORT || "3000")
server.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
```

### Test Server with Fault Injection

```typescript
import {
  DurableStreamTestServer,
  FaultInjectionMiddleware,
} from "@durable-streams/server"

// Create test server
const server = new DurableStreamTestServer({
  port: 0, // Random port
})

await server.start()
console.log(`Test server running at ${server.url}`)

// Test resilience
test("client handles 503 errors", async () => {
  // Inject error for next 2 requests
  server.injectError("/test-stream", 503, 2, 5) // 503 with Retry-After: 5

  // Client should retry and eventually succeed
  const stream = client.stream("/test-stream")
  await stream.append("test data")

  server.clearInjectedErrors()
})

await server.stop()
```

## License

Apache-2.0
