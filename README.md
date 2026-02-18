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
> Read the [Announcing Durable Streams](https://electric-sql.com/blog/2025/12/09/announcing-durable-streams) post on the Electric blog.

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

Read more in the [Introduction](docs/introduction.md) and [Use Cases](docs/use-cases.md).

## Quick Start

Install the TypeScript client and a development server:

```bash
npm install @durable-streams/client @durable-streams/server
```

Start a server and write/read a stream:

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"

// Start a dev server
const server = new DurableStreamTestServer({ port: 4437 })
await server.start()

// Create a stream
const stream = await DurableStream.create({
  url: "http://localhost:4437/v1/stream/my-stream",
  contentType: "application/json",
})

// Append data
await stream.append({ event: "user.created", userId: "123" })

// Read it back
const res = await stream.stream({ live: false })
const items = await res.json()
console.log(items) // [{ event: "user.created", userId: "123" }]
```

Or try it with curl:

```bash
# Create
curl -X PUT http://localhost:4437/v1/stream/my-stream \
  -H "Content-Type: application/json"

# Append
curl -X POST http://localhost:4437/v1/stream/my-stream \
  -H "Content-Type: application/json" \
  -d '{"event":"user.created","userId":"123"}'

# Read from beginning
curl "http://localhost:4437/v1/stream/my-stream?offset=-1"

# Live tail
curl "http://localhost:4437/v1/stream/my-stream?offset=-1&live=long-poll"
```

See the [Getting Started guide](docs/getting-started.md) for a full walkthrough.

## Documentation

| Guide | Description |
|-------|-------------|
| [Introduction](docs/introduction.md) | What Durable Streams is and why it exists |
| [Getting Started](docs/getting-started.md) | Set up a server and start streaming |
| [Core Concepts](docs/concepts.md) | Offsets, live modes, JSON mode, idempotent producers |
| [Use Cases](docs/use-cases.md) | AI streaming, database sync, event sourcing, and more |
| [Client Libraries](docs/clients.md) | All 10 official client libraries |
| [Servers](docs/servers.md) | Dev server and Caddy plugin |
| [CLI Reference](docs/cli.md) | Command-line tool for stream management |
| [Deployment](docs/deployment.md) | Production deployment with Caddy or Electric Cloud |
| [State Protocol](docs/state.md) | Structured state sync (insert/update/delete) over streams |
| [Building a Client](docs/building-a-client.md) | Implement a client and run conformance tests |
| [Building a Server](docs/building-a-server.md) | Implement a server and run conformance tests |
| [Benchmarking](docs/benchmarking.md) | Measure server latency and throughput |
| [Protocol Specification](PROTOCOL.md) | Full protocol spec |

## Packages

### Client Libraries

| Package | Language | Description |
| ------- | -------- | ----------- |
| [@durable-streams/client](./packages/client) | TypeScript | Reference client with full read/write support |
| [client-py](./packages/client-py) | Python | Python client library |
| [client-go](./packages/client-go) | Go | Go client library |
| [client-elixir](./packages/client-elixir) | Elixir | Elixir client library |
| [client-dotnet](./packages/client-dotnet) | C#/.NET | .NET client library |
| [client-swift](./packages/client-swift) | Swift | Swift client library |
| [client-php](./packages/client-php) | PHP | PHP client library |
| [client-java](./packages/client-java) | Java | Java client library |
| [client-rust](./packages/client-rust) | Rust | Rust client library |
| [client-rb](./packages/client-rb) | Ruby | Ruby client library |

### Servers & Tools

| Package | Description |
| ------- | ----------- |
| [@durable-streams/server](./packages/server) | Node.js reference server (development/testing) |
| [caddy-plugin](./packages/caddy-plugin) | Production Caddy server plugin |
| [@durable-streams/cli](./packages/cli) | Command-line tool |
| [@durable-streams/state](./packages/state) | State Protocol (insert/update/delete over streams) |

### Testing & Benchmarks

| Package | Description |
| ------- | ----------- |
| [@durable-streams/server-conformance-tests](./packages/server-conformance-tests) | Server protocol compliance tests |
| [@durable-streams/client-conformance-tests](./packages/client-conformance-tests) | Client protocol compliance tests |
| [@durable-streams/benchmarks](./packages/benchmarks) | Performance benchmarking suite |

### Community Implementations

- [ahimsalabs/durable-streams-go](https://github.com/ahimsalabs/durable-streams-go) -- alternative Go client and server
- [Clickin/durable-streams-java](https://github.com/Clickin/durable-streams-java) -- alternative Java client with framework adapters

## Contributing

We welcome contributions! This project follows the [Contributor Covenant](https://www.contributor-covenant.org/) code of conduct.

```bash
# Clone and install
git clone https://github.com/durable-streams/durable-streams.git
cd durable-streams
pnpm install

# Build all packages
pnpm build

# Run all conformance tests
pnpm test:run

# Lint and format
pnpm lint:fix
pnpm format
```

We use [changesets](https://github.com/changesets/changesets) for version management. Run `pnpm changeset` to add a changeset before submitting a PR.

## License

Apache 2.0 -- see [LICENSE](./LICENSE)
