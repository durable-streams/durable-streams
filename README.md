# Durable Stream

**HTTP-based durable, append-only byte streams for the web**

Durable Stream provides a simple, web-native protocol for creating and consuming ordered, replayable data streams with support for catch-up reads and live tailing.

## Why Durable Streams?

Modern applications frequently need ordered, durable sequences of data that can be replayed from arbitrary points and tailed in real time:

- **Database synchronization** - Stream database changes to clients
- **Event sourcing** - Build event-sourced architectures
- **Collaborative editing** - Sync CRDTs and operational transforms
- **AI conversations** - Stream and replay LLM interactions
- **Workflow execution** - Track state changes over time
- **Real-time updates** - Push application state to clients

While these patterns are widespread, the web platform lacks a simple, first-class primitive for durable streams. Applications typically implement ad-hoc solutions using combinations of databases, queues, and polling mechanisms.

Durable Stream provides a **minimal HTTP-based protocol** that's:

- 🌐 **Web-native** - Built on standard HTTP with no custom protocols
- 📦 **Simple** - Just URLs, standard HTTP methods, and a few headers
- 🔄 **Resumable** - Offset-based reads let you resume from any point
- ⚡ **Real-time** - Long-poll and SSE modes for live tailing
- 🎯 **Flexible** - Content-type agnostic byte streams
- 🔌 **Composable** - Build higher-level abstractions on top

## Packages

This monorepo contains:

- **[@durable-stream/client](./packages/client)** - TypeScript client library
- **[@durable-stream/server](./packages/server)** - Node.js reference server implementation
- **[@durable-stream/cli](./packages/cli)** - Command-line tool
- **[@durable-stream/conformance-tests](./packages/conformance-tests)** - Protocol compliance test suite
- **[@durable-stream/benchmarks](./packages/benchmarks)** - Performance benchmarking suite

## Quick Start

### Install the client

```bash
npm install @durable-stream/client
```

### Create and append to a stream

```typescript
import { DurableStream } from "@durable-stream/client"

// Create a new stream
const stream = await DurableStream.create({
  url: "https://your-server.com/v1/stream/my-stream",
  contentType: "application/json",
})

// Append data
await stream.append(JSON.stringify({ event: "user.created", userId: "123" }))
await stream.append(JSON.stringify({ event: "user.updated", userId: "123" }))
```

### Read from a stream

```typescript
// Catch-up read - get all existing data
const result = await stream.read()
console.log(new TextDecoder().decode(result.data))

// Live tail - follow new data as it arrives
for await (const chunk of stream.follow({ live: "long-poll" })) {
  console.log(new TextDecoder().decode(chunk.data))
}
```

### Resume from an offset

```typescript
// Read from a specific offset
const result = await stream.read({ offset: "0_100" })

// Resume live tail from where you left off
for await (const chunk of stream.follow({
  offset: result.offset,
  live: "long-poll",
})) {
  console.log(new TextDecoder().decode(chunk.data))
}
```

## Protocol

Durable Stream is built on a simple HTTP-based protocol. See [PROTOCOL.md](./PROTOCOL.md) for the complete specification.

**Core operations:**

- `PUT /stream/{path}` - Create a new stream
- `POST /stream/{path}` - Append bytes to a stream
- `GET /stream/{path}?offset=X` - Read from a stream (catch-up)
- `GET /stream/{path}?offset=X&live=long-poll` - Live tail (long-poll)
- `GET /stream/{path}?offset=X&live=sse` - Live tail (Server-Sent Events)
- `DELETE /stream/{path}` - Delete a stream
- `HEAD /stream/{path}` - Get stream metadata

**Key features:**

- Opaque, lexicographically sortable offsets for resumption
- Optional sequence numbers for writer coordination
- TTL and expiry time support
- Content-type preservation
- CDN-friendly caching and request collapsing

## Running Your Own Server

### Node.js Reference Implementation

```bash
npm install @durable-stream/server
```

```typescript
import { createDurableStreamServer } from "@durable-stream/server"

const server = createDurableStreamServer({
  port: 8787,
  // In-memory storage (for development)
  // Add file-backed storage for production
})

await server.start()
```

See [@durable-stream/server](./packages/server) for more details.

### Other Implementations

The protocol is implementation-agnostic. You can:

- Build your own server in any language
- Use [@durable-stream/conformance-tests](./packages/conformance-tests) to verify compliance
- Run [@durable-stream/benchmarks](./packages/benchmarks) to measure performance

## CLI Tool

```bash
npm install -g @durable-stream/cli
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

Stream database changes to clients for real-time synchronization:

```typescript
// Server: stream database changes
for (const change of db.changes()) {
  await stream.append(JSON.stringify(change))
}

// Client: receive and apply changes
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
const result = await stream.read({ offset: "0_0" })
const events = parseEvents(result.data)
const state = events.reduce(applyEvent, initialState)
```

### AI Conversation Streaming

Stream LLM responses with full conversation history:

```typescript
// Stream AI response chunks
for await (const token of llm.stream(prompt)) {
  await stream.append(token)
}

// Client can resume from any point
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
import { runConformanceTests } from "@durable-stream/conformance-tests"

runConformanceTests({
  baseUrl: "http://localhost:8787",
})
```

## Benchmarking

Measure your server's performance:

```typescript
import { runBenchmarks } from "@durable-stream/benchmarks"

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
git clone https://github.com/durable-stream/durable-stream.git
cd durable-stream

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
- [GitHub Repository](https://github.com/durable-stream/durable-stream)
- [NPM Organization](https://www.npmjs.com/org/durable-stream)

---

**Status:** Early development - API subject to change
