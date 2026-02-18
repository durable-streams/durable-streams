# Deployment

There are two ways to run Durable Streams in production: self-hosted with the Caddy plugin, or fully managed on Electric Cloud.

For local development, see the [Dev Server](servers.md#dev-server-durable-streamsserver) or use the Caddy plugin's built-in [dev mode](#development-mode).

## Self-Hosted with Caddy

The Caddy plugin is a production-ready Durable Streams server built on [Caddy v2](https://caddyserver.com/). It provides the full protocol implementation with automatic TLS, persistent storage, and battle-tested HTTP serving.

### Installation

#### Install script (recommended)

**macOS and Linux:**

```bash
curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh
```

Install a specific version:

```bash
curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh -s v0.1.0
```

Install to a custom directory:

```bash
INSTALL_DIR=~/.local/bin curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh
```

#### Pre-built binaries

Download the latest release for your platform from [GitHub Releases](https://github.com/durable-streams/durable-streams/releases/latest). Binaries are available for macOS (Intel and Apple Silicon), Linux (AMD64 and ARM64), and Windows (AMD64).

**macOS (Apple Silicon):**

```bash
curl -L https://github.com/durable-streams/durable-streams/releases/latest/download/durable-streams-server_<VERSION>_darwin_arm64.tar.gz | tar xz
sudo mv durable-streams-server /usr/local/bin/
```

**macOS (Intel):**

```bash
curl -L https://github.com/durable-streams/durable-streams/releases/latest/download/durable-streams-server_<VERSION>_darwin_amd64.tar.gz | tar xz
sudo mv durable-streams-server /usr/local/bin/
```

**Linux (x86_64):**

```bash
curl -L https://github.com/durable-streams/durable-streams/releases/latest/download/durable-streams-server_<VERSION>_linux_amd64.tar.gz | tar xz
sudo mv durable-streams-server /usr/local/bin/
```

**Windows:** download the `.zip` file from releases and extract to your PATH.

#### Build from source

Requires Go:

```bash
go build -o durable-streams-server ./cmd/caddy
```

### Development Mode

Run the server with zero configuration:

```bash
durable-streams-server dev
```

This starts an in-memory server at `http://localhost:4437` with the stream endpoint at `/v1/stream/*`. No Caddyfile required. Good for local development and testing.

### Production Caddyfile

Create a `Caddyfile` for production with persistent storage and your domain:

```caddyfile
{
	admin off
}

streams.example.com {
	route /v1/stream/* {
		durable_streams {
			data_dir /var/lib/durable-streams/data
		}
	}
}
```

Caddy automatically provisions and renews TLS certificates for your domain via Let's Encrypt. No additional TLS configuration is needed.

To listen on a specific port without automatic TLS (e.g. behind a load balancer):

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

**In-memory (default)** -- fast, ephemeral storage that resets on restart. Suitable for development and testing:

```caddyfile
route /v1/stream/* {
	durable_streams
}
```

**File-backed (LMDB)** -- persistent storage for production. Data survives restarts:

```caddyfile
route /v1/stream/* {
	durable_streams {
		data_dir ./data
	}
}
```

### Timeouts

Configure long-poll and SSE behavior:

```caddyfile
route /v1/stream/* {
	durable_streams {
		data_dir ./data
		long_poll_timeout 30s
		sse_reconnect_interval 120s
	}
}
```

### Reverse Proxy

Caddy has built-in reverse proxy support. You can combine Durable Streams with proxied routes in the same Caddyfile:

```caddyfile
api.example.com {
	route /v1/stream/* {
		durable_streams {
			data_dir ./data
		}
	}

	route /api/* {
		reverse_proxy localhost:3000
	}
}
```

### Known Limitations

**File store crash-atomicity.** The file-backed store does not atomically commit producer state with data appends. Data is written to segment files first, then producer state is updated separately. If a crash occurs between these steps, producer state may be stale on recovery.

The practical impact is low. The likely failure mode is a false `409` (sequence gap) on restart, not duplicate data. Clients can recover by incrementing their epoch. See [issue #143](https://github.com/durable-streams/durable-streams/issues/143) for details.

## Electric Cloud (Hosted)

[Electric Cloud](https://electric-sql.com/cloud) provides fully managed Durable Streams hosting. No server to deploy or manage.

### Getting Started

1. Sign up at [electric-sql.com/cloud](https://electric-sql.com/cloud) and create a service
2. Create streams using the API with your service credentials:

```bash
curl -X PUT \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  "https://api.electric-sql.cloud/v1/stream/<your-service-id>/my-stream"
```

3. Point your clients at the stream URL and start reading and writing

### What You Get

- **Sync CDN**: reads are served from the edge and don't hit origin
- **Scale**: tested to 1M concurrent connections per stream
- **Throughput**: 240K writes/second, 15-25 MB/sec sustained
- **Unlimited streams**: no cap on the number of streams per service
- **Simple pricing**: reads are free, 5M writes/month included, pay as you scale beyond that

## CDN Integration

The Durable Streams protocol is designed for CDN-friendly fan-out. You don't need Electric Cloud to benefit from this -- the same properties apply when self-hosting behind any CDN.

**Cache-friendly historical reads.** Catch-up reads from a given offset return immutable content. A request for "everything after offset X" always returns the same response, making these requests safe to cache indefinitely at the edge.

**Cursor-based collapsing.** In live mode, multiple clients waiting at the same offset can be collapsed into fewer upstream connections by CDN edge nodes. This means read-heavy workloads scale horizontally without overwhelming origin servers.

**Conditional requests.** ETag support allows clients to make conditional requests, reducing unnecessary data transfer when content hasn't changed.

This architecture means a single origin server can serve a large number of concurrent readers through CDN fan-out, with the CDN absorbing the connection and bandwidth costs of the read path.
