# Servers

Durable Streams has two official server implementations: a Node.js development server and a production-ready Caddy plugin. Both fully implement the [Durable Streams protocol](../PROTOCOL.md).

If you want to build your own server implementation, see [Building a Server](building-a-server.md).

- [Dev Server (`@durable-streams/server`)](#dev-server-durable-streamsserver)
- [Caddy Plugin (Production Server)](#caddy-plugin-production-server)
- [Which Server Should I Use?](#which-server-should-i-use)

## At a Glance

| Server                                 | Language             | Best for                          |
| -------------------------------------- | -------------------- | --------------------------------- |
| Dev Server (`@durable-streams/server`) | Node.js / TypeScript | Development, testing, prototyping |
| Caddy Plugin                           | Go                   | Production deployments            |

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

**In-memory (default)** -- fast, ephemeral storage that resets on restart. Just omit `dataDir`:

```typescript
const server = new DurableStreamTestServer({ port: 4437 })
```

**File-backed** -- persistent storage using log files and LMDB for metadata:

```typescript
const server = new DurableStreamTestServer({
  port: 4437,
  dataDir: "./data/streams",
})
```

### Configuration

| Option                  | Type                  | Default       | Description                                                |
| ----------------------- | --------------------- | ------------- | ---------------------------------------------------------- |
| `port`                  | `number`              | `4437`        | Port to listen on                                          |
| `host`                  | `string`              | `"127.0.0.1"` | Host to bind to                                            |
| `dataDir`               | `string`              | —             | Data directory for file-backed storage; omit for in-memory |
| `longPollTimeout`       | `number`              | `30000`       | Long-poll timeout in milliseconds                          |
| `onStreamCreated`       | `StreamLifecycleHook` | —             | Hook called when a stream is created                       |
| `onStreamDeleted`       | `StreamLifecycleHook` | —             | Hook called when a stream is deleted                       |
| `compression`           | `boolean`             | `true`        | Enable gzip/deflate compression                            |
| `cursorIntervalSeconds` | `number`              | `20`          | Cursor interval for CDN cache collapsing                   |

### Lifecycle Hooks

Track stream creation and deletion events:

````typescript
const server = new DurableStreamTestServer({
  port: 4437,
  onStreamCreated: (event) => {
    console.log(`Stream created: ${event.path} (${event.contentType})`)
  },
  onStreamDeleted: (event) => {
    console.log(`Stream deleted: ${event.path}`)
  },
})

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
````

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
