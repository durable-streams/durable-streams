# Durable Streams

**Open protocol for real-time sync to client applications**

HTTP-based durable streams for streaming data reliably to web browsers, mobile apps, and native clients with offset-based resumability.

Durable Streams provides a simple, production-proven protocol for creating and consuming ordered, replayable data streams with support for catch-up reads and live tailing.

## The Missing Primitive

Modern applications frequently need ordered, durable sequences of data that can be replayed from arbitrary points and tailed in real time. Common patterns include:

- **AI conversation streaming** - Stream LLM token responses with resume capability across reconnections
- **Database synchronization** - Stream database changes to web, mobile, and native clients
- **Collaborative editing** - Sync CRDTs and operational transforms across devices
- **Real-time updates** - Push application state to clients with guaranteed delivery
- **Event sourcing** - Build event-sourced architectures with client-side replay
- **Workflow execution** - Stream workflow state changes with full history

While durable streams exist throughout backend infrastructure (database WALs, Kafka topics, event stores), they aren't available as a first-class primitive for client applications. There's no simple, HTTP-based durable stream that sits alongside databases and object storage as a standard cloud primitive.

Applications typically implement ad-hoc solutions for resumable streaming—combinations of databases, queues, polling mechanisms, and custom offset tracking. Most implementations handle reconnection poorly: streaming responses break when clients switch tabs, experience brief network interruptions, or refresh pages.

**Durable Streams addresses this gap.** It's a minimal HTTP-based protocol for durable, offset-based streaming designed for client applications across all platforms: web browsers, mobile apps, native clients, IoT devices, and edge workers. Based on 1.5 years of production use at [Electric](https://electric-sql.com/) for real-time Postgres sync.

The protocol provides:

- 🌐 **Universal** - Works anywhere HTTP works: web browsers, mobile apps, native clients, IoT devices, edge workers
- 📦 **Simple** - Built on standard HTTP with no custom protocols
- 🔄 **Resumable** - Offset-based reads let you resume from any point
- ⚡ **Real-time** - Long-poll and SSE modes for live tailing with catch-up from any offset
- 💰 **Economical** - HTTP-native design leverages CDN infrastructure for efficient scaling
- 🎯 **Flexible** - Content-type agnostic byte streams
- 🔌 **Composable** - Build higher-level abstractions on top

## Packages

This monorepo contains:

- **[@durable-streams/client](./packages/client)** - TypeScript read-only client (smaller bundle)
- **[@durable-streams/writer](./packages/writer)** - TypeScript read/write client (includes create/append/delete operations)
- **[@durable-streams/server](./packages/server)** - Node.js reference server implementation
- **[@durable-streams/cli](./packages/cli)** - Command-line tool
- **[@durable-streams/conformance-tests](./packages/conformance-tests)** - Protocol compliance test suite
- **[@durable-streams/benchmarks](./packages/benchmarks)** - Performance benchmarking suite

## Quick Start

### Read-only client (typical browser/mobile usage)

For applications that only need to read from streams:

```bash
npm install @durable-streams/client
```

```typescript
import { DurableStream } from "@durable-streams/client"

const stream = new DurableStream({
  url: "https://your-server.com/v1/stream/my-stream",
})

// Catch-up read - get all existing data
const result = await stream.read()
console.log(new TextDecoder().decode(result.data))

// Live tail - follow new data as it arrives
for await (const chunk of stream.follow({ live: "long-poll" })) {
  console.log(new TextDecoder().decode(chunk.data))
}
```

### Read/write client

For applications that need to create and write to streams:

```bash
npm install @durable-streams/writer
```

```typescript
import { DurableStream } from "@durable-streams/writer"

// Create a new stream
const stream = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-stream",
  contentType: "application/json",
})

// Append data
await stream.append(JSON.stringify({ event: "user.created", userId: "123" }))
await stream.append(JSON.stringify({ event: "user.updated", userId: "123" }))

// Writer also includes all read operations
const result = await stream.read()
```

### Resume from an offset

```typescript
// Read and save the offset
const result = await stream.read()
const savedOffset = result.offset // Save this for later

// Resume from saved offset
const resumed = await stream.read({ offset: savedOffset })

// Resume live tail from where you left off
for await (const chunk of stream.follow({
  offset: resumed.offset,
  live: "long-poll",
})) {
  console.log(new TextDecoder().decode(chunk.data))
}
```

## Protocol in 60 Seconds

Here's the protocol in action with raw HTTP:

**Create a stream:**

```bash
curl -X PUT https://your-server.com/v1/stream/my-stream \
  -H "Content-Type: application/json"
```

**Append data:**

```bash
curl -X POST https://your-server.com/v1/stream/my-stream \
  -H "Content-Type: application/json" \
  -d '{"event":"user.created","userId":"123"}'

# Server returns:
# Stream-Next-Offset: abc123xyz
```

**Read from beginning:**

```bash
curl "https://your-server.com/v1/stream/my-stream?offset=-1"

# Server returns:
# Stream-Next-Offset: abc123xyz
# Cache-Control: public, max-age=60
# [response body with data]
```

**Resume from offset:**

```bash
curl "https://your-server.com/v1/stream/my-stream?offset=abc123xyz"
```

**Live tail (long-poll):**

```bash
curl "https://your-server.com/v1/stream/my-stream?offset=abc123xyz&live=long-poll"
# Waits for new data, returns when available or times out
```

The key headers:

- `Stream-Next-Offset` - Resume point for next read (exactly-once delivery)
- `Cache-Control` - Enables CDN/browser caching for historical reads
- `Content-Type` - Set at stream creation, preserved for all reads

## Message Framing

Durable Streams operates in two modes for handling message boundaries:

### Byte Stream Mode (Default)

By default, Durable Streams is a **raw byte stream with no message boundaries**. When you append data, it's concatenated directly. Each read returns all bytes from your offset to the current end of the stream, but these boundaries don't align with application-level "messages."

```typescript
// Append multiple messages
await stream.append("hello")
await stream.append("world")

// Read from beginning - returns all data concatenated
const result = await stream.read()
// result.data = "helloworld" (complete stream from offset to end)

// If more data arrives and you read again from the returned offset
await stream.append("!")
const next = await stream.read({ offset: result.offset })
// next.data = "!" (complete new data from last offset to new end)
```

**You must implement your own framing.** For example, newline-delimited JSON (NDJSON):

```typescript
// Write with newlines
await stream.append(JSON.stringify({ event: "user.created" }) + "\n")
await stream.append(JSON.stringify({ event: "user.updated" }) + "\n")

// Parse line by line
const text = new TextDecoder().decode(result.data)
const messages = text.split("\n").filter(Boolean).map(JSON.parse)
```

### JSON Mode

When creating a stream with `contentType: "application/json"`, the server guarantees message boundaries. Each read returns a complete JSON array of the messages appended since the last offset.

```typescript
// Create a JSON-mode stream
const stream = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-stream",
  contentType: "application/json",
})

// Append individual JSON values
await stream.append(JSON.stringify({ event: "user.created", userId: "123" }))
await stream.append(JSON.stringify({ event: "user.updated", userId: "123" }))

// Read returns parsed JSON array automatically
const result = await stream.read()
// result.data = [
//   { event: "user.created", userId: "123" },
//   { event: "user.updated", userId: "123" }
// ]
```

In JSON mode:

- Each append must be a valid JSON value
- The server batches appends into JSON arrays for reads
- Message boundaries are preserved
- Ideal for structured event streams

## Offset Semantics

Offsets are opaque tokens that identify positions within a stream:

- **Opaque strings** - Treat as black boxes; don't parse or construct them
- **Lexicographically sortable** - You can compare offsets to determine ordering
- **`"-1"` means start** - Use `offset: "-1"` to read from the beginning
- **Server-generated** - Always use the `offset` value returned in responses

```typescript
// Start from beginning
const result = await stream.read({ offset: "-1" })

// Resume from last position (always use returned offset)
const next = await stream.read({ offset: result.offset })
```

The only special offset value is `"-1"` for stream start. All other offsets are opaque strings returned by the server—never construct or parse them yourself.

## Protocol

Durable Streams is built on a simple HTTP-based protocol. See [PROTOCOL.md](./PROTOCOL.md) for the complete specification.

**Core operations:**

- `PUT /stream/{path}` - Create a new stream
- `POST /stream/{path}` - Append bytes to a stream
- `GET /stream/{path}?offset=X` - Read from a stream (catch-up)
- `GET /stream/{path}?offset=X&live=long-poll` - Live tail (long-poll)
- `GET /stream/{path}?offset=X&live=sse` - Live tail (Server-Sent Events)
- `DELETE /stream/{path}` - Delete a stream
- `HEAD /stream/{path}` - Get stream metadata

**Key features:**

- Exactly-once delivery guarantee with offset-based resumption
- Opaque, lexicographically sortable offsets for resumption
- Optional sequence numbers for writer coordination
- TTL and expiry time support
- Content-type preservation
- CDN-friendly caching and request collapsing

### CDN Caching

Historical reads (catch-up from known offsets) are fully cacheable at CDNs and in browsers:

```bash
# Request
GET /v1/stream/my-stream?offset=abc123

# Response
HTTP/1.1 200 OK
Cache-Control: public, max-age=60, stale-while-revalidate=300
ETag: "stream-id:abc123:xyz789"
Stream-Next-Offset: xyz789
Content-Type: application/json

[response body]
```

**How it works:**

- **Offset-based URLs** - Same offset = same data, perfect for caching
- **Cache-Control** - Historical data cached for 60s, stale content served during revalidation
- **ETag** - Efficient revalidation for unchanged data
- **Request collapsing** - Multiple clients requesting same offset collapsed to single upstream request

## Relationship to Backend Streaming Systems

Backend streaming systems like Kafka, RabbitMQ, and Kinesis excel at server-to-server messaging and backend event processing. Durable Streams complements these systems by solving a different problem: **reliably streaming data to client applications**.

The challenges of streaming to clients are distinct from server-to-server streaming:

- **Client diversity** - Supporting web browsers, mobile apps, native clients, each with different capabilities and constraints
- **Network unreliability** - Clients disconnect constantly (backgrounded tabs, network switches, page refreshes)
- **Resumability requirements** - Clients need to pick up exactly where they left off without data loss
- **Economics** - Per-connection costs make dedicated connections to millions of clients prohibitive
- **Protocol compatibility** - Kafka/AMQP protocols don't run in browsers or on most mobile platforms
- **Data shaping and authorization** - Backend streams typically contain raw, unfiltered events; client streams need per-user filtering, transformation, and authorization applied

**Complementary architecture:**

```
Kafka/RabbitMQ → Application Server → Durable Streams → Clients
(server-to-server)   (shapes data,      (server-to-client)
                      authorizes)
```

Your application server consumes from backend streaming systems, applies authorization logic, shapes data for specific clients, and fans out via Durable Streams. This separation allows:

- Backend systems to optimize for throughput, partitioning, and server-to-server reliability
- Application servers to enforce authorization boundaries and transform data
- Durable Streams to optimize for HTTP compatibility, CDN leverage, and client resumability
- Each layer to use protocols suited to its environment

## Why Not SSE?

Server-Sent Events (SSE) provides basic real-time streaming over HTTP, but lacks the durability and robust resumability needed for production applications:

- **No durable storage** - SSE is ephemeral; disconnect and data is lost. Servers must implement their own storage and replay logic
- **Limited resumability** - SSE's `Last-Event-ID` mechanism lacks standardized offset semantics and requires custom server-side replay implementation
- **No catch-up protocol** - No defined way to efficiently retrieve historical data before switching to live mode
- **Text-only** - SSE is text-only
- **No caching support** - Without durable offsets, CDN and browser caching are difficult to implement correctly
- **Implementation variability** - No standard for how servers should handle reconnection, leading to fragile custom solutions

**Durable Streams provides:**

- **Durable storage** - Data persists across server restarts and client disconnections
- **Opaque offset semantics** - Lexicographically sortable offsets with standardized resumption behavior
- **Unified catch-up and live protocol** - Same offset-based API for historical and real-time data
- **Binary support** - Content-type agnostic byte streams
- **Caching-friendly** - Offset-based requests with Cache-Control headers enable efficient caching in CDNs and browsers
- **Conformance tests** - Standardized test suite ensures consistent implementation behavior

Durable Streams can use SSE as a transport mechanism (via `live=sse` mode) while providing the missing durability and resumability layer on top.

## Why Not WebSockets?

WebSockets provide full-duplex communication, but are poorly suited for durable streaming:

- **No built-in durability** - WebSockets are ephemeral connections with no persistence guarantees
- **No offset-based resumption** - No standard mechanism for clients to resume from a specific position after reconnection
- **Connection state complexity** - Servers must manage long-lived stateful connections for every client
- **Poor CDN/proxy support** - WebSocket connections bypass HTTP caching infrastructure entirely
- **Complex load balancing** - Sticky sessions or connection state synchronization required across servers
- **Binary protocol overhead** - Custom framing and reconnection logic must be implemented for every application

**Durable Streams provides:**

- **Durable storage** - Data persists across server restarts and client disconnections
- **Opaque offset semantics** - Lexicographically sortable offsets with standardized resumption behavior
- **HTTP-native** - Leverages standard HTTP caching, load balancing, and CDN infrastructure
- **Stateless servers** - No connection state to manage; clients track their own offsets
- **Simple protocol** - Standard HTTP methods and headers, no custom framing required

## Implementations

This repository provides reference implementations in TypeScript and Node.js:

- **[@durable-streams/client](./packages/client)** - TypeScript read-only client
- **[@durable-streams/writer](./packages/writer)** - TypeScript read/write client
- **[@durable-streams/server](./packages/server)** - Node.js reference server implementation
- **[@durable-streams/conformance-tests](./packages/conformance-tests)** - Protocol compliance test suite
- **[@durable-streams/benchmarks](./packages/benchmarks)** - Performance benchmarking suite

### Building Your Own Implementation

The protocol is designed to support implementations in any language or platform. A conforming server implementation requires:

1. **HTTP API** - Implement the protocol operations (PUT, POST, GET, DELETE, HEAD) as defined in [PROTOCOL.md](./PROTOCOL.md)
2. **Durable storage** - Persist stream data with offset tracking (in-memory, file-based, database, object storage, etc.)
3. **Offset management** - Generate opaque, lexicographically sortable offset tokens

Client implementations need only support standard HTTP requests and offset tracking.

We encourage implementations in other languages and environments (Go, Rust, Python, Java, C#, Swift, Kotlin, etc.). Use the conformance test suite to verify protocol compliance:

```typescript
import { runConformanceTests } from "@durable-streams/conformance-tests"

runConformanceTests({
  baseUrl: "http://localhost:8787",
})
```

### Node.js Reference Server

```bash
npm install @durable-streams/server
```

```typescript
import { createDurableStreamServer } from "@durable-streams/server"

const server = createDurableStreamServer({
  port: 8787,
  // In-memory storage (for development)
  // Add file-backed storage for production
})

await server.start()
```

See [@durable-streams/server](./packages/server) for more details.

## CLI Tool

```bash
npm install -g @durable-streams/cli

# Set the server URL (defaults to http://localhost:8787)
export STREAM_URL=https://your-server.com
```

```bash
# Create a stream
durable-stream create my-stream

# Write to a stream
echo "hello world" | durable-stream write my-stream

# Read from a stream
durable-stream read my-stream

# Delete a stream
durable-stream delete my-stream
```

## Use Cases

### Database Sync

Stream database changes to web and mobile clients for real-time synchronization:

```typescript
// Server: stream database changes
for (const change of db.changes()) {
  await stream.append(JSON.stringify(change))
}

// Client: receive and apply changes (works in browsers, React Native, native apps)
for await (const chunk of stream.follow({ live: "long-poll" })) {
  const change = JSON.parse(new TextDecoder().decode(chunk.data))
  applyChange(change)
}
```

### Event Sourcing

Build event-sourced systems with durable event logs:

```typescript
// Append events
await stream.append(JSON.stringify({ type: "OrderCreated", orderId: "123" }))
await stream.append(JSON.stringify({ type: "OrderPaid", orderId: "123" }))

// Replay from beginning
const result = await stream.read({ offset: "-1" })
const events = parseEvents(result.data)
const state = events.reduce(applyEvent, initialState)
```

### AI Conversation Streaming

Stream LLM responses with full conversation history accessible across devices:

```typescript
// Stream AI response chunks
for await (const token of llm.stream(prompt)) {
  await stream.append(token)
}

// Client can resume from any point (switch devices, refresh page, reconnect)
for await (const chunk of stream.follow({
  offset: lastSeenOffset,
  live: "sse",
})) {
  renderToken(new TextDecoder().decode(chunk.data))
}
```

## Testing Your Implementation

Use the conformance test suite to verify your server implements the protocol correctly:

```typescript
import { runConformanceTests } from "@durable-streams/conformance-tests"

runConformanceTests({
  baseUrl: "http://localhost:8787",
})
```

## Benchmarking

Measure your server's performance:

```typescript
import { runBenchmarks } from "@durable-streams/benchmarks"

runBenchmarks({
  baseUrl: "http://localhost:8787",
  environment: "local",
})
```

## Contributing

We welcome contributions! This project follows the [Contributor Covenant](https://www.contributor-covenant.org/) code of conduct.

### Development

```bash
# Clone the repository
git clone https://github.com/durable-streams/durable-streams.git
cd durable-streams

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test:run

# Lint and format
pnpm lint:fix
pnpm format
```

### Changesets

We use [changesets](https://github.com/changesets/changesets) for version management:

```bash
# Add a changeset
pnpm changeset

# Version packages (done by CI)
pnpm changeset:version

# Publish (done by CI)
pnpm changeset:publish
```

## License

Apache 2.0 - see [LICENSE](./LICENSE)

## Links

- [Protocol Specification](./PROTOCOL.md)
- [GitHub Repository](https://github.com/durable-streams/durable-streams)
- [NPM Organization](https://www.npmjs.com/org/durable-streams)

---

**Status:** Early development - API subject to change
