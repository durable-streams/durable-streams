<picture>
  <source media="(prefers-color-scheme: dark)"
      srcset="docs/img/icon-128.png"
  />
  <source media="(prefers-color-scheme: light)"
      srcset="docs/img/icon-128.black.png"
  />
  <img alt="Memento polaroid icon"
      src="docs/img/icon-128.png"
      width="64"
      height="64"
  />
</picture>

# Durable Streams

**The open protocol for real-time sync to client applications**

HTTP-based durable streams for streaming data reliably to web browsers, mobile apps, and native clients with offset-based resumability.

Durable Streams provides a simple, production-proven protocol for creating and consuming ordered, replayable data streams with support for catch-up reads and live tailing.

> [!TIP]
> Read the [Annoucing Durable Streams](https://electric-sql.com/blog/2025/12/09/announcing-durable-streams) post on the Electric blog.

## The Missing Primitive

Modern applications frequently need ordered, durable sequences of data that can be replayed from arbitrary points and tailed in real time. Common patterns include:

- **AI conversation streaming** - Stream LLM token responses with resume capability across reconnections
- **Agentic apps** - Stream tool outputs and progress events with replay and clean reconnect semantics
- **Database synchronization** - Stream database changes to web, mobile, and native clients
- **Collaborative editing** - Sync CRDTs and operational transforms across devices
- **Real-time updates** - Push application state to clients with guaranteed delivery
- **Event sourcing** - Build event-sourced architectures with client-side replay
- **Workflow execution** - Stream workflow state changes with full history

While durable streams exist throughout backend infrastructure (database WALs, Kafka topics, event stores), they aren't available as a first-class primitive for client applications. There's no simple, HTTP-based durable stream that sits alongside databases and object storage as a standard cloud primitive.

WebSocket and SSE connections are easy to start, but they're fragile in practice: tabs get suspended, networks flap, devices switch, pages refresh. When that happens, you either lose in-flight data or build a bespoke backend storage and client resume protocol on top.

AI products make this painfully visible. Token streaming is the UI for chat and copilots, and agentic apps stream progress events, tool outputs, and partial results over long-running sessions. When the stream fails, the product fails—even if the model did the right thing.

**Durable Streams addresses this gap.** It's a minimal HTTP-based protocol for durable, offset-based streaming designed for client applications across all platforms: web browsers, mobile apps, native clients, IoT devices, and edge workers. Based on 1.5 years of production use at [Electric](https://electric-sql.com/) for real-time Postgres sync, reliably delivering millions of state changes every day.

The protocol provides:

- 🌐 **Universal** - Works anywhere HTTP works: web browsers, mobile apps, native clients, IoT devices, edge workers
- 📦 **Simple** - Built on standard HTTP with no custom protocols
- 🔄 **Resumable** - Offset-based reads let you resume from any point
- ⚡ **Real-time** - Long-poll and SSE modes for live tailing with catch-up from any offset
- 💰 **Economical** - HTTP-native design leverages CDN infrastructure for efficient scaling
- 🎯 **Flexible** - Content-type agnostic byte streams
- 🔌 **Composable** - Build higher-level abstractions on top (like Electric's real-time Postgres sync engine)

## Packages

This monorepo contains:

- **[@durable-streams/client](./packages/client)** - TypeScript read-only client (smaller bundle)
- **[@durable-streams/writer](./packages/writer)** - TypeScript read/write client (includes create/append/delete operations)
- **[@durable-streams/server](./packages/server)** - Node.js reference server implementation
- **[@durable-streams/cli](./packages/cli)** - Command-line tool
- **[@durable-streams/test-ui](./packages/test-ui)** - Visual web interface for testing and exploring streams
- **[@durable-streams/conformance-tests](./packages/conformance-tests)** - Protocol compliance test suite
- **[@durable-streams/benchmarks](./packages/benchmarks)** - Performance benchmarking suite

## Try It Out Locally

<img width="5088" height="3820" alt="524000540-460eb79d-3970-4882-b39a-50bfd9d4c63d" src="https://github.com/user-attachments/assets/39090c01-38b1-4e7d-9b39-a8a13cec14d2" />

Run the local server and use either the web-based Test UI or the command-line CLI:

### Option 1: Test UI

```bash
# Clone and install
git clone https://github.com/durable-streams/durable-streams.git
cd durable-streams
pnpm install

# Terminal 1: Start the local server
pnpm start:dev

# Terminal 2: Launch the Test UI
cd packages/test-ui
pnpm dev
```

Open `http://localhost:3000` to:

- Create and manage streams with different content types (text/plain, application/json, binary)
- Write messages with keyboard shortcuts
- Monitor real-time stream updates
- View the stream registry to see all active streams
- Inspect stream metadata and content-type rendering

See the [Test UI README](./packages/test-ui/README.md) for details.

### Option 2: CLI

```bash
# Clone and install
git clone https://github.com/durable-streams/durable-streams.git
cd durable-streams
pnpm install

# Terminal 1: Start the local server
pnpm start:dev

# Terminal 2: Link the CLI globally (one-time setup)
pnpm link:dev

# Set the server URL
export STREAM_URL=http://localhost:8787

# Create a stream
durable-stream-dev create my-stream

# Terminal 3: Start reading (will show data as it arrives)
durable-stream-dev read my-stream

# Back in Terminal 2: Write data and watch it appear in Terminal 3
durable-stream-dev write my-stream "Hello, world!"
durable-stream-dev write my-stream "More data..."
echo "Piped content!" | durable-stream-dev write my-stream
```

See the [CLI README](./packages/cli/README.md) for details.

The Test UI and CLI share the same `__registry__` system stream, so streams created in one are visible in the other.

## Quick Start

### Read-only client (typical browser/mobile usage)

For applications that only need to read from streams:

**The API mirrors the Fetch Response API** with methods like `.json()`, `.text()`, `.body()`, and uses standard Web Streams for all streaming operations:

```typescript
import { DurableStream } from "@durable-streams/client"

const stream = new DurableStream({
  url: "https://your-server.com/v1/stream/my-stream",
})

// Like response.text() - read all existing data as text
const text = await stream.text()
console.log(text)

// Like response.json() - read all data as parsed JSON
const data = await stream.json()

// Like response.body - get a ReadableStream for streaming
for await (const chunk of stream.body()) {
  console.log(chunk) // Uint8Array chunks
}
```

### Read/write client

For applications that need to create and write to streams:

```typescript
import { DurableStream } from "@durable-streams/writer"

// Create a new stream
const stream = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-stream",
  contentType: "application/json",
})

// Append data
await stream.append({ event: "user.created", userId: "123" })
await stream.append({ event: "user.updated", userId: "123" })

// Writer also includes all read operations
const data = await stream.json()
console.log(data) // Array of JSON objects
```

### Resume from an offset

```typescript
// Read all data and get the offset
await stream.text()
const savedOffset = stream.offset // Save this for later

// Resume from saved offset using textStream
const reader = stream
  .textStream({ offset: savedOffset, live: false })
  .getReader()
const { value } = await reader.read()
reader.releaseLock()
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
const text = await stream.text()
// text = "helloworld" (complete stream from offset to end)

// If more data arrives and you read again from the saved offset
await stream.append("!")
const reader = stream
  .textStream({ offset: stream.offset, live: false })
  .getReader()
const { value } = await reader.read()
reader.releaseLock()
// value = "!" (complete new data from last offset to new end)
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
await stream.append({ event: "user.created", userId: "123" })
await stream.append({ event: "user.updated", userId: "123" })

// Read all messages at once (like response.json())
const messages = await stream.json()
console.log(messages) // [{ event: "user.created", ... }, { event: "user.updated", ... }]

// Or stream messages one at a time (Web Streams API - async iterable)
for await (const message of stream.jsonStream({ live: false })) {
  console.log(message)
  // { event: "user.created", userId: "123" }
  // { event: "user.updated", userId: "123" }
}
```

In JSON mode:

- Each `append()` stores one message
- Supports all JSON types: objects, arrays, strings, numbers, booleans, null
- Message boundaries are preserved across reads
- Reads return JSON arrays of all messages
- Ideal for structured event streams

## Offset Semantics

Offsets are opaque tokens that identify positions within a stream:

- **Opaque strings** - Treat as black boxes; don't parse or construct them
- **Lexicographically sortable** - You can compare offsets to determine ordering
- **`"-1"` means start** - Use `offset: "-1"` to read from the beginning
- **Server-generated** - Always use the `offset` value returned in responses

```typescript
// Start from beginning - .text() always starts from beginning by default
const allText = await stream.text()

// Resume from last position (stream.offset updated after reads)
const savedOffset = stream.offset

// Later, resume from saved offset using textStream
for await (const chunk of stream.textStream({
  offset: savedOffset,
  live: false,
})) {
  console.log(chunk)
}
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

## Performance

Durable Streams is built for production scale:

- **Low latency** - Sub-15ms end-to-end delivery in production deployments
- **High concurrency** - Tested with millions of concurrent clients subscribed to a single stream without degradation
- **Minimal overhead** - The protocol itself adds minimal overhead; throughput scales with your infrastructure
- **Horizontal scaling** - Offset-based design enables aggressive caching at CDN edges, so read-heavy workloads (common in sync and AI scenarios) scale horizontally without overwhelming origin servers

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

## Why Not SSE or WebSockets?

Server-Sent Events (SSE) and WebSockets provide real-time communication, but both share fundamental limitations for durable streaming:

- **No durability** - Both are ephemeral; disconnect and data is lost
- **No standardized resumption** - No standard way to resume from a specific position after reconnection
- **No catch-up protocol** - No defined way to retrieve historical data before switching to live mode
- **Custom implementation required** - You must build your own storage, replay, and reconnection logic
- **Poor caching integration** - Neither integrates well with HTTP caching infrastructure

SSE is also text-only. WebSockets require stateful connection management, sticky sessions for load balancing, and custom message framing.

**Durable Streams addresses all of these:**

- **Durable storage** - Data persists across server restarts and client disconnections
- **Standardized resumption** - Opaque, lexicographically sortable offsets with defined semantics
- **Unified catch-up and live protocol** - Same offset-based API for historical and real-time data
- **Simple protocol** - Standard HTTP methods and headers, no custom framing required
- **Caching-friendly** - Offset-based requests enable efficient CDN and browser caching
- **Stateless servers** - No connection state to manage; clients track their own offsets
- **Binary support** - Content-type agnostic byte streams
- **Conformance tests** - Standardized test suite ensures consistent behavior

Durable Streams can use SSE as a transport mechanism (via `live=sse` mode) while providing the missing durability layer on top.

## Building Your Own Implementation

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
  await stream.append(change)
}

// Client: receive and apply changes (works in browsers, React Native, native apps)
for await (const line of stream.textStream({ offset: lastSeenOffset })) {
  const change = JSON.parse(line)
  applyChange(change)
}
```

### Event Sourcing

Build event-sourced systems with durable event logs:

```typescript
// Append events (JSON mode)
await stream.append({ type: "OrderCreated", orderId: "123" })
await stream.append({ type: "OrderPaid", orderId: "123" })

// Replay from beginning - .json() returns all events as array
const events = await stream.json()
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
for await (const chunk of stream.textStream({ offset: lastSeenOffset })) {
  renderTokens(chunk)
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
