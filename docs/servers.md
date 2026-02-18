# Servers

Durable Streams has two official server implementations: a Node.js development server and a production-ready Caddy plugin. Both fully implement the [Durable Streams protocol](../PROTOCOL.md).

If you want to build your own server implementation, see [Building a Server](building-a-server.md).

- [Dev Server (`@durable-streams/server`)](#dev-server-durable-streamsserver)
- [Caddy Plugin (Production Server)](#caddy-plugin-production-server)
- [Which Server Should I Use?](#which-server-should-i-use)

## At a Glance

| Server | Language | Best for |
|--------|----------|----------|
| Dev Server (`@durable-streams/server`) | Node.js / TypeScript | Development, testing, prototyping |
| Caddy Plugin | Go | Production deployments |

## Dev Server (`@durable-streams/server`)

A reference server implementation for Node.js. Ideal for development, testing, and CI pipelines.

### Installation

```bash
npm install @durable-streams/server
```

### Quick Start

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 4437,
  host: "127.0.0.1",
})

await server.start()
console.log("Server running on http://127.0.0.1:4437")
```

### Storage Options

**In-memory (default)** -- fast, ephemeral storage that resets on restart:

```typescript
import { DurableStreamTestServer, StreamStore } from "@durable-streams/server"

const store = new StreamStore()
const server = new DurableStreamTestServer({ port: 4437, store })
```

**File-backed** -- persistent storage using log files and LMDB for metadata:

```typescript
import {
  DurableStreamTestServer,
  FileBackedStreamStore,
} from "@durable-streams/server"

const store = new FileBackedStreamStore({ path: "./data/streams" })
const server = new DurableStreamTestServer({ port: 4437, store })
```

### Configuration

The server accepts the following options:

| Option | Type | Description |
|--------|------|-------------|
| `port` | `number` | Port to listen on |
| `host` | `string` | Host to bind to |
| `store` | `StreamStore \| FileBackedStreamStore` | Storage backend |
| `hooks` | `StreamLifecycleHook[]` | Lifecycle hooks (e.g. registry) |
| `cors` | `boolean` | Enable CORS headers |
| `cursorOptions` | `CursorOptions` | Cursor configuration |

### Registry Hooks

Track stream lifecycle events such as creation and deletion:

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

The registry maintains a system stream that records all stream creates and deletes, useful for building admin UIs or monitoring.

### When to Use

- Local development and prototyping
- Automated testing and CI
- Embedding a Durable Streams server in a Node.js application

Full documentation: [Dev Server README](../packages/server/README.md)

## Caddy Plugin (Production Server)

A production-ready Durable Streams server built as a [Caddy v2](https://caddyserver.com/) plugin. It inherits Caddy's battle-tested HTTP server, automatic TLS, reverse proxy, and more.

### Installation

Install using the quick-install script:

```bash
curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh
```

Or download a pre-built binary for your platform from [GitHub Releases](https://github.com/durable-streams/durable-streams/releases).

To build from source:

```bash
go build -o durable-streams-server ./cmd/caddy
```

### Quick Start

Run the server in dev mode with zero configuration:

```bash
durable-streams-server dev
```

This starts an in-memory server at `http://localhost:4437` with the stream endpoint at `/v1/stream/*`. No Caddyfile required.

### Production Setup

Create a `Caddyfile` with persistent file-backed storage:

```caddyfile
{
	admin off
}

:4437 {
	route /v1/stream/* {
		durable_streams {
			data_dir ./data
		}
	}
}
```

Start the server:

```bash
durable-streams-server run --config Caddyfile
```

### Storage Options

**In-memory (default)** -- no persistence, suitable for development:

```caddyfile
route /v1/stream/* {
	durable_streams
}
```

**File-backed (LMDB)** -- persistent storage for production:

```caddyfile
route /v1/stream/* {
	durable_streams {
		data_dir ./data
	}
}
```

See the [Deployment guide](deployment.md) for production Caddyfile examples, configuration reference, authentication, reverse proxy, systemd/Docker, and known limitations.

### When to Use

- Production deployments
- Anything beyond local development where you need persistence, TLS, or operational reliability

Full documentation: [Caddy Plugin README](../packages/caddy-plugin/README.md)

## Which Server Should I Use?

- **Just getting started or developing locally?** Use the [Dev Server](#dev-server-durable-streamsserver). It installs via npm and runs in-process with your Node.js app.
- **Deploying to production?** Use the [Caddy Plugin](#caddy-plugin-production-server) for self-hosted, or [Electric Cloud](https://electric-sql.com/cloud) for a fully managed service. See [Deployment](deployment.md) for details.
- **Building your own server?** See [Building a Server](building-a-server.md) for protocol implementation guidance.

---

See also: [Deployment](deployment.md) | [Getting Started](getting-started.md) | [Building a Server](building-a-server.md)
