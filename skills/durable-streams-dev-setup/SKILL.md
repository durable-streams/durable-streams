---
name: durable-streams-dev-setup
description: >
  Install and run the Durable Streams server for local development.
  durable-streams-server binary (Caddy-based), zero-config dev mode,
  HTTPS with Caddyfile for HTTP/2 multiplexing, persistent file-backed
  storage, running alongside app with concurrently, @durable-streams/cli
  for stream management (create, write, read, delete), STREAM_URL env var,
  port 4437, certificate trust troubleshooting.
type: lifecycle
library: "@durable-streams"
library_version: "pre-1.0"
sources:
  - "durable-streams:README.md"
  - "durable-streams:packages/caddy-plugin/README.md"
  - "durable-streams:packages/cli/README.md"
---

# Durable Streams — Development Environment Setup

Install the server binary, configure for local development, and manage streams with the CLI.

## Setup

### Install the server binary

```bash
curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh
```

Custom install directory:

```bash
INSTALL_DIR=~/.local/bin curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh
```

### Start the zero-config dev server

```bash
durable-streams-server dev
```

Starts an in-memory server at `http://localhost:4437`. Streams at `/v1/stream/*`. Data is lost on restart — use for development only.

### Install the client and CLI

```bash
pnpm add @durable-streams/client
pnpm add -D @durable-streams/cli
```

## Core Patterns

### HTTPS with Caddyfile for HTTP/2

Create a `Caddyfile` in your project root:

```caddyfile
{
  admin off
}

localhost:4437 {
  route /v1/stream/* {
    durable_streams {
      data_dir .durable-streams
    }
  }
}
```

Run with HTTPS:

```bash
durable-streams-server run --config Caddyfile
```

On first run, Caddy generates a local CA certificate. Trust it:

```bash
# macOS — Caddy usually auto-trusts, but if browser shows warnings:
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \
  ~/Library/Application\ Support/Caddy/pki/authorities/local/root.crt
```

Add `.durable-streams/` to `.gitignore`:

```bash
echo ".durable-streams/" >> .gitignore
```

### Caddyfile options

| Option                   | Default     | Description                            |
| ------------------------ | ----------- | -------------------------------------- |
| `data_dir`               | (in-memory) | Path for persistent LMDB storage       |
| `long_poll_timeout`      | `30s`       | How long to wait for data in long-poll |
| `sse_reconnect_interval` | `120s`      | SSE client reconnection interval       |

### Run alongside your app

```json
{
  "scripts": {
    "dev": "concurrently \"durable-streams-server dev\" \"vite dev\"",
    "dev:https": "concurrently \"durable-streams-server run --config Caddyfile\" \"vite dev\""
  }
}
```

Install concurrently: `pnpm add -D concurrently`

### CLI commands

Set the stream URL:

```bash
export STREAM_URL=http://localhost:4437
```

```bash
# Create a JSON stream
durable-stream create my-events --json

# Write data
durable-stream write my-events '{"type":"click","x":100}'

# Read all data (follows live)
durable-stream read my-events

# Delete a stream
durable-stream delete my-events
```

CLI options: `--url` overrides `STREAM_URL`, `--auth` sets Authorization header.

### Stream URL construction in code

```typescript
const streamUrl = "http://localhost:4437/v1/stream/my-events"

// Or from environment
const baseUrl = process.env.STREAM_URL || "http://localhost:4437"
const streamUrl = `${baseUrl}/v1/stream/my-events`
```

## Common Mistakes

### HIGH Using HTTP with many concurrent streams in browser

Wrong:

```bash
durable-streams-server dev
# 7+ concurrent live streams in browser — connections queue
```

Correct:

```bash
durable-streams-server run --config Caddyfile
# HTTPS enables HTTP/2 — unlimited concurrent streams over one connection
```

Browsers limit HTTP/1.1 to 6 concurrent connections per origin. With multiple live SSE/long-poll streams, connections queue. HTTPS enables HTTP/2 multiplexing.

Source: Browser HTTP/1.1 connection limits

### HIGH Using @durable-streams/server (Node.js) instead of the binary

Wrong:

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"
const server = new DurableStreamTestServer()
await server.start()
```

Correct:

```bash
durable-streams-server dev
# Or with persistence:
durable-streams-server run --config Caddyfile
```

`@durable-streams/server` is a reference implementation for development and testing only. The `durable-streams-server` binary (Caddy plugin) is the production server with TLS, file persistence, and performance.

Source: README.md — Server & Tools

### MEDIUM Not adding .durable-streams/ to .gitignore

Wrong:

```
# No .gitignore entry → binary LMDB files committed to repo
```

Correct:

```bash
echo ".durable-streams/" >> .gitignore
```

The `data_dir` creates LMDB database files. Without `.gitignore`, binary files get committed.

Source: Caddyfile setup pattern

### MEDIUM Forgetting to trust Caddy CA certificate

On first HTTPS run, Caddy generates a local CA. If auto-trust fails (permissions), browsers show certificate warnings. Check the Caddy log output for trust instructions, or manually trust the root cert at `~/Library/Application Support/Caddy/pki/authorities/local/root.crt`.

Source: Caddy documentation

### HIGH Tension: CDN cacheability vs real-time freshness

Aggressive CDN caching improves fan-out economics, but clients must echo the `Stream-Cursor` header to avoid stale responses. The client library handles cursor echoing automatically, but when deploying behind a CDN, verify that cursor headers are forwarded correctly.

See also: durable-streams/SKILL.md § Common Mistakes — "Ignoring cursor in CDN deployments"
