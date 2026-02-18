# Deployment

This page covers production deployment of Durable Streams. For server installation and getting started, see [Servers](servers.md).

There are two ways to run Durable Streams in production: self-hosted with the Caddy plugin, or fully managed on [Electric Cloud](https://electric-sql.com/cloud).

- [Self-Hosted with Caddy](#self-hosted-with-caddy)
- [Electric Cloud (Hosted)](#electric-cloud-hosted)
- [CDN Integration](#cdn-integration)

## Self-Hosted with Caddy

The [Caddy plugin](servers.md#caddy-plugin-production-server) is the recommended server for production. See the [Servers page](servers.md#caddy-plugin-production-server) for installation and quick start.

### Production Caddyfile

For production, create a `Caddyfile` with persistent storage and your domain. Caddy automatically provisions and renews TLS certificates via Let's Encrypt:

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

### Configuration Reference

All configuration directives for the `durable_streams` block:

| Directive | Default | Description |
|-----------|---------|-------------|
| `data_dir` | _(none -- in-memory)_ | Path to persistent storage directory (LMDB) |
| `long_poll_timeout` | `30s` | How long the server holds long-poll connections open |
| `sse_reconnect_interval` | `60s` | How often SSE connections are closed for CDN collapsing |
| `max_file_handles` | `100` | Maximum number of cached open file handles (file store only) |

Example with all options:

```caddyfile
route /v1/stream/* {
	durable_streams {
		data_dir ./data
		long_poll_timeout 30s
		sse_reconnect_interval 120s
		max_file_handles 200
	}
}
```

### Authentication

The protocol leaves authentication out of scope -- use Caddy's native mechanisms. Here are common patterns:

**Bearer token with forward auth** (recommended for production):

```caddyfile
api.example.com {
	route /v1/stream/* {
		forward_auth localhost:3001 {
			uri /auth/verify
			copy_headers Authorization
		}
		durable_streams {
			data_dir ./data
		}
	}
}
```

**Static API key** (simple, good for internal services):

```caddyfile
api.example.com {
	@unauthorized {
		not header Authorization "Bearer my-secret-key"
	}
	route /v1/stream/* {
		respond @unauthorized 401
		durable_streams {
			data_dir ./data
		}
	}
}
```

See Caddy's [authentication documentation](https://caddyserver.com/docs/caddyfile/directives/forward_auth) for more options including basic auth, JWT validation, and OAuth2 integration.

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

### Running as a Service

**systemd:**

```ini
[Unit]
Description=Durable Streams Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/durable-streams-server run --config /etc/durable-streams/Caddyfile
Restart=always
RestartSec=5
User=durable-streams
Group=durable-streams

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable durable-streams
sudo systemctl start durable-streams
```

**Docker:**

```dockerfile
FROM debian:bookworm-slim
COPY durable-streams-server /usr/local/bin/
COPY Caddyfile /etc/durable-streams/Caddyfile
VOLUME /data
EXPOSE 4437
CMD ["durable-streams-server", "run", "--config", "/etc/durable-streams/Caddyfile"]
```

```bash
docker run -d -p 4437:4437 -v durable-streams-data:/data my-durable-streams
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

- **Sync CDN**: all reads are served from the edge and don't hit origin
- **Scale**: tested to 1M concurrent connections per stream
- **Throughput**: 240K writes/second for small messages, 15-25 MB/sec sustained
- **Unlimited streams**: no cap on the number of streams per service
- **Simple pricing**: reads are free, 5M writes/month included, then pay as you scale

Electric Cloud also hosts [Postgres sync](https://electric-sql.com/products/postgres-sync), so you can combine real-time streams with synced relational data in the same app.

## CDN Integration

The Durable Streams protocol is designed for CDN-friendly fan-out. You don't need Electric Cloud to benefit from this -- the same properties apply when self-hosting behind any CDN.

**Cache-friendly historical reads.** Catch-up reads from a given offset return immutable content. A request for "everything after offset X" always returns the same response, making these requests safe to cache indefinitely at the edge.

**Cursor-based collapsing.** In live mode, multiple clients waiting at the same offset can be collapsed into fewer upstream connections by CDN edge nodes. This means read-heavy workloads scale horizontally without overwhelming origin servers.

**Conditional requests.** ETag support allows clients to make conditional requests, reducing unnecessary data transfer when content hasn't changed.

This architecture means a single origin server can serve a large number of concurrent readers through CDN fan-out, with the CDN absorbing the connection and bandwidth costs of the read path.

---

See also: [Servers](servers.md) | [Core Concepts](concepts.md) | [Getting Started](getting-started.md)
