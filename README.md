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

**What you get:**

- **Refresh-safe** - Users refresh the page, switch tabs, or background the app—they pick up exactly where they left off
- **Share links** - A stream is a URL. Multiple viewers can watch the same stream together in real-time
- **Never re-run** - Don't repeat expensive work because a client disconnected mid-stream
- **Multi-device** - Start on your phone, continue on your laptop, watch from a shared link—all in sync
- **Multi-tab** - Works seamlessly across browser tabs without duplicating connections or missing data
- **Massive fan-out** - CDN-friendly design means one origin can serve millions of concurrent viewers

The protocol is:

- 🌐 **Universal** - Works anywhere HTTP works: web browsers, mobile apps, native clients, IoT devices, edge workers
- 📦 **Simple** - Built on standard HTTP with no custom protocols
- 🔄 **Resumable** - Offset-based reads let you resume from any point
- ⚡ **Real-time** - Long-poll and SSE modes for live tailing with catch-up from any offset
- 💰 **Economical** - HTTP-native design leverages CDN infrastructure for efficient scaling
- 🎯 **Flexible** - Content-type agnostic byte streams
- 🔌 **Composable** - Build higher-level abstractions on top (like Electric's real-time Postgres sync engine)

## Installation

### npm packages

```bash
npm install @durable-streams/client   # TypeScript client
npm install @durable-streams/server   # Reference Node.js server
npm install @durable-streams/state    # State Protocol primitives
npm install @durable-streams/cli      # Development & testing CLI
```

### Other languages

```bash
# Go
go get github.com/durable-streams/durable-streams/packages/client-go

# Python
pip install durable-streams
```

### Server binary

For production use, download the Caddy-based server binary from [GitHub releases](https://github.com/durable-streams/durable-streams/releases). Available for macOS (Intel & ARM), Linux (AMD64 & ARM64), and Windows.

```bash
# Start the server
./durable-streams-server dev
# Server runs on http://localhost:4437
```

## Packages

This monorepo contains:

- **[@durable-streams/client](./packages/client)** - TypeScript client with full read/write support and automatic batching
- **[@durable-streams/server](./packages/server)** - Node.js reference server implementation
- **[@durable-streams/cli](./packages/cli)** - Command-line tool
- **[Test UI](./examples/test-ui)** - Visual web interface for testing and exploring streams
- **[@durable-streams/server-conformance-tests](./packages/server-conformance-tests)** - Server protocol compliance tests (124 tests)
- **[@durable-streams/client-conformance-tests](./packages/client-conformance-tests)** - Client protocol compliance tests (110 tests)
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

pnpm build

# Terminal 1: Start the local server
pnpm start:dev

# Terminal 2: Launch the Test UI
cd examples/test-ui
pnpm dev
```

Open `http://localhost:3000` to:

- Create and manage streams with different content types (text/plain, application/json, binary)
- Write messages with keyboard shortcuts
- Monitor real-time stream updates
- View the stream registry to see all active streams
- Inspect stream metadata and content-type rendering

See the [Test UI README](./examples/test-ui/README.md) for details.

### Option 2: CLI

```bash
# Clone and install
git clone https://github.com/durable-streams/durable-streams.git
cd durable-streams
pnpm install

pnpm build

# Terminal 1: Start the local server
pnpm start:dev

# Terminal 2: Link the CLI globally (one-time setup)
pnpm link:dev

# Set the server URL
export STREAM_URL=http://localhost:4437

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

### Full read/write client

The `@durable-streams/client` package provides full read/write support with automatic batching for high-throughput writes:

```typescript
import { DurableStream } from "@durable-streams/client"

// Create a new stream
const handle = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-stream",
  contentType: "application/json",
})

// Append data (automatically batched for high throughput)
await handle.append({ event: "user.created", userId: "123" })
await handle.append({ event: "user.updated", userId: "123" })

// Read with the streaming API
const res = await handle.stream<{ event: string; userId: string }>({
  live: false,
})
const items = await res.json()
console.log(items) // [{ event: "user.created", userId: "123" }, ...]
```

### Resume from an offset

```typescript
// Read and save the offset
const res = await handle.stream({ live: false })
const text = await res.text()
const savedOffset = res.offset // Save this for later

// Resume from saved offset (catch-up mode returns immediately)
const resumed = await handle.stream({ offset: savedOffset, live: false })
```

### Live streaming

```typescript
// Subscribe to live updates
const res = await handle.stream({ live: "auto" })

res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log("Received:", item)
  }
  saveCheckpoint(batch.offset) // Persist for resumption
})
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
await handle.append("hello")
await handle.append("world")

// Read from beginning - returns all data concatenated
const res = await handle.stream({ live: false })
const text = await res.text()
// text = "helloworld" (complete stream from offset to end)

// If more data arrives and you read again from the returned offset
await handle.append("!")
const next = await handle.stream({ offset: res.offset, live: false })
const newText = await next.text()
// newText = "!" (complete new data from last offset to new end)
```

**You must implement your own framing.** For example, newline-delimited JSON (NDJSON):

```typescript
// Write with newlines
await handle.append(JSON.stringify({ event: "user.created" }) + "\n")
await handle.append(JSON.stringify({ event: "user.updated" }) + "\n")

// Parse line by line
const res = await handle.stream({ live: false })
const text = await res.text()
const messages = text.split("\n").filter(Boolean).map(JSON.parse)
```

### JSON Mode

When creating a stream with `contentType: "application/json"`, the server guarantees message boundaries. Each read returns a complete JSON array of the messages appended since the last offset.

```typescript
// Create a JSON-mode stream
const handle = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-stream",
  contentType: "application/json",
})

// Append individual JSON values
await handle.append({ event: "user.created", userId: "123" })
await handle.append({ event: "user.updated", userId: "123" })

// Stream individual JSON messages
const res = await handle.stream({ live: false })
for await (const message of res.jsonStream()) {
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
- **Unique** - Each offset is unique within a stream
- **Monotonically increasing** - All offsets are monotonically increasing within a stream

```typescript
// Start from beginning (catch-up mode)
const res = await stream({
  url: "https://your-server.com/v1/stream/my-stream",
  offset: "-1",
  live: false,
})

// Resume from last position (always use returned offset)
const next = await stream({
  url: "https://your-server.com/v1/stream/my-stream",
  offset: res.offset,
  live: false,
})
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

### CDN Caching and Fan-Out

This is where the economics change. Because reads are offset-based URLs, CDNs can cache and collapse requests—meaning **one origin can serve millions of concurrent viewers** without breaking a sweat.

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

- **Shared streams** - Backends write to a stream, multiple clients subscribe to it in real-time
- **Offset-based URLs** - Same offset = same data, perfect for caching
- **Request collapsing** - 10,000 viewers at the same offset become one upstream request
- **Edge delivery** - CDN edges serve catch-up reads; origin only handles new writes

**What this enables:**

- **Live dashboards** - Thousands of viewers watch the same metrics stream
- **Collaborative apps** - Multiple users sync to the same document or workspace
- **Shared debugging** - Watch a user's session in real-time to troubleshoot together

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

## Relationship to SSE and WebSockets

SSE and WebSockets are good transports for real-time delivery. Durable Streams uses SSE as one of its delivery modes (`live=sse`). The difference isn't the transport, it's what sits behind it.

**SSE/WebSockets give you a connection. Durable Streams gives you a log.**

SSE can reconnect (via `Last-Event-ID`), but it doesn't standardize what happens on the server side: there's no defined log format, no retention semantics, no catch-up protocol, no multi-reader coordination. Most real-world SSE endpoints don't persist history—if you disconnect, the data is gone.

Durable Streams standardizes the durable log underneath:

- **Persistent storage** - Data survives disconnections, refreshes, and server restarts
- **Offset-based resumption** - Resume from any position with well-defined semantics
- **Unified catch-up and live** - Same API for historical replay and real-time tailing
- **Multi-reader support** - Multiple clients can subscribe to the same stream
- **CDN-friendly** - Offset-based URLs enable aggressive caching and request collapsing
- **Stateless servers** - Clients track their own offsets; no connection state to manage
- **Standard protocol** - Reusable clients and framework integrations that work with any conforming server

The result: SSE (or long-poll) for the last mile, durable log semantics everywhere else. You get the simplicity of HTTP streaming with the reliability of an append-only log.

## Building Your Own Implementation

The protocol is designed to support implementations in any language or platform. A conforming server implementation requires:

1. **HTTP API** - Implement the protocol operations (PUT, POST, GET, DELETE, HEAD) as defined in [PROTOCOL.md](./PROTOCOL.md)
2. **Durable storage** - Persist stream data with offset tracking (in-memory, file-based, database, object storage, etc.)
3. **Offset management** - Generate opaque, lexicographically sortable offset tokens

Client implementations need only support standard HTTP requests and offset tracking.

We encourage implementations in other languages and environments (Go, Rust, Python, Java, C#, Swift, Kotlin, etc.). Use the conformance test suite to verify protocol compliance:

```typescript
import { runConformanceTests } from "@durable-streams/server-conformance-tests"

runConformanceTests({
  baseUrl: "http://localhost:4437",
})
```

### Node.js Reference Server

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 4437,
  host: "127.0.0.1",
})

await server.start()
console.log(`Server running on ${server.baseUrl}`)
```

See [@durable-streams/server](./packages/server) for more details.

### Community implementations

**Go**

- [ahimsalabs/durable-streams-go](https://github.com/ahimsalabs/durable-streams-go): A client and server implementation with full conformance test coverage.

**Java**

- [Clickin/durable-streams-java](https://github.com/Clickin/durable-streams-java): A client and server and famous framework adapters with full conformace test coverage.

## CLI Tool

```bash
# Set the server URL (defaults to http://localhost:4437)
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
  await handle.append(change) // JSON objects batched automatically
}

// Client: receive and apply changes (works in browsers, React Native, native apps)
const res = await handle.stream<Change>({
  offset: lastSeenOffset,
  live: "auto",
})
res.subscribeJson(async (batch) => {
  for (const change of batch.items) {
    applyChange(change)
  }
  saveOffset(batch.offset)
})
```

### Event Sourcing

Build event-sourced systems with durable event logs:

```typescript
// Append events
await handle.append({ type: "OrderCreated", orderId: "123" })
await handle.append({ type: "OrderPaid", orderId: "123" })

// Replay from beginning (catch-up mode for full replay)
const res = await handle.stream<Event>({ offset: "-1", live: false })
const events = await res.json()
const state = events.reduce(applyEvent, initialState)
```

### AI Conversation Streaming

LLM inference is expensive. When a user's tab gets suspended, their network flaps, or they refresh the page, you don't want to re-run the generation—you want them to pick up exactly where they left off.

```typescript
// Server: stream tokens to a durable stream (continues even if client disconnects)
const handle = await DurableStream.create({
  url: `https://your-server.com/v1/stream/generation/${generationId}`,
  contentType: "text/plain",
})

for await (const token of llm.stream(prompt)) {
  await handle.append(token) // Persisted immediately
}

// Client: resume from last seen position (refresh-safe)
const res = await handle.stream({ offset: lastSeenOffset, live: "auto" })
res.subscribe((chunk) => {
  renderTokens(chunk.data)
  saveOffset(chunk.offset) // Persist for next resume
})
```

**What this gives you:**

- **Tab suspended?** User comes back, catches up from saved offset—no re-generation
- **Page refresh?** Continues from last token, not from the beginning
- **Share the generation?** Multiple viewers watch the same stream in real-time
- **Switch devices?** Start on mobile, continue on desktop, same stream

## Testing Your Implementation

Use the conformance test suite to verify your server implements the protocol correctly:

### Using the CLI

The easiest way to run conformance tests against your server:

```bash
# Run tests once (for CI)
npx @durable-streams/server-conformance-tests --run http://localhost:4437

# Watch mode - reruns tests when source files change (for development)
npx @durable-streams/server-conformance-tests --watch src http://localhost:4437
```

### Programmatic Usage

You can also run the tests programmatically in your own test suite:

```typescript
import { runConformanceTests } from "@durable-streams/server-conformance-tests"

runConformanceTests({
  baseUrl: "http://localhost:4437",
})
```

## Benchmarking

Measure your server's performance:

```typescript
import { runBenchmarks } from "@durable-streams/benchmarks"

runBenchmarks({
  baseUrl: "http://localhost:4437",
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
