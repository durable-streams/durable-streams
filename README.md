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

Read more on the docs site:

- [Quick Start](docs/quick-start.md)
- [TypeScript client](docs/typescript-client.md)
- [JSON Streams](docs/json-streams.md)
- [Vercel AI SDK](docs/vercel-ai-sdk.md)
- [TanStack AI](docs/tanstack-ai.md)
- [State Streams](docs/state.md)
- [Durable Proxy](docs/proxy.md)

## Quick Start

Download the latest `durable-streams-server` binary from the [GitHub releases page](https://github.com/durable-streams/durable-streams/releases/latest) and start it in dev mode:

```bash
./durable-streams-server dev
```

Then create, append to, and read a stream with curl:

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

See the [Quick Start guide](docs/quick-start.md) for the minimal setup path.

## Documentation

### Quick Start

- [Quick Start](docs/quick-start.md) -- start the server and create your first stream

### Usage

- [CLI](docs/cli.md) -- work with streams from the terminal
- [TypeScript client](docs/typescript-client.md) -- use the TypeScript client directly
- [JSON Streams](docs/json-streams.md) -- structured message streams
- [TanStack AI](docs/tanstack-ai.md) -- durable TanStack AI transport
- [Vercel AI SDK](docs/vercel-ai-sdk.md) -- durable Vercel AI SDK transport
- [State Streams](docs/state.md) -- typed state sync over streams
- [Durable Proxy](docs/proxy.md) -- durable proxy for existing AI streaming APIs
- [Stream FS](docs/streamfs.md) -- file-like byte stream patterns

### Reference

- [Servers](docs/servers.md) -- official server implementations
- [Protocol](PROTOCOL.md) -- full protocol specification

## Packages

### Client Libraries

| Package                                      | Language   | Description                                   |
| -------------------------------------------- | ---------- | --------------------------------------------- |
| [@durable-streams/client](./packages/client) | TypeScript | Reference client with full read/write support |
| [client-py](./packages/client-py)            | Python     | Python client library                         |
| [client-go](./packages/client-go)            | Go         | Go client library                             |
| [client-elixir](./packages/client-elixir)    | Elixir     | Elixir client library                         |
| [client-dotnet](./packages/client-dotnet)    | C#/.NET    | .NET client library                           |
| [client-swift](./packages/client-swift)      | Swift      | Swift client library                          |
| [client-php](./packages/client-php)          | PHP        | PHP client library                            |
| [client-java](./packages/client-java)        | Java       | Java client library                           |
| [client-rust](./packages/client-rust)        | Rust       | Rust client library                           |
| [client-rb](./packages/client-rb)            | Ruby       | Ruby client library                           |

### Servers & Tools

| Package                                      | Description                                        |
| -------------------------------------------- | -------------------------------------------------- |
| [@durable-streams/server](./packages/server) | Node.js reference server (development/testing)     |
| [caddy-plugin](./packages/caddy-plugin)      | Production Caddy server plugin                     |
| [@durable-streams/cli](./packages/cli)       | Command-line tool                                  |
| [@durable-streams/state](./packages/state)   | State Protocol (insert/update/delete over streams) |

### Testing & Benchmarks

| Package                                                                          | Description                      |
| -------------------------------------------------------------------------------- | -------------------------------- |
| [@durable-streams/server-conformance-tests](./packages/server-conformance-tests) | Server protocol compliance tests |
| [@durable-streams/client-conformance-tests](./packages/client-conformance-tests) | Client protocol compliance tests |
| [@durable-streams/benchmarks](./packages/benchmarks)                             | Performance benchmarking suite   |

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
