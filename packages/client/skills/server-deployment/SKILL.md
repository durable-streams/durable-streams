---
name: server-deployment
description: >
  Running durable stream servers. DurableStreamTestServer for development
  (Node.js, @durable-streams/server, not for production), Caddy plugin for
  production with Caddyfile configuration, data_dir for file-backed persistence,
  max_file_handles tuning, long_poll_timeout, server binary downloads for macOS
  Linux Windows, @durable-streams/cli tool setup, conformance test runner.
type: lifecycle
library: durable-streams
library_version: "0.2.1"
sources:
  - "durable-streams/durable-streams:packages/caddy-plugin/README.md"
  - "durable-streams/durable-streams:packages/server/README.md"
  - "durable-streams/durable-streams:packages/cli/README.md"
---

# Durable Streams — Server Deployment

Two server options: a Node.js development server for prototyping and a
Caddy-based production server with file persistence and CDN support.

## Setup

### Development server (Node.js)

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer({
  port: 4437,
  host: "127.0.0.1",
})

await server.start()
console.log(`Dev server running on ${server.url}`)
```

### Production server (Caddy binary)

Download the binary from [GitHub releases](https://github.com/durable-streams/durable-streams/releases) for your platform.

```bash
# Start the server
./durable-streams-server run --config Caddyfile
```

Caddyfile configuration:

```
:8787 {
  route /v1/stream/* {
    durable_streams {
      data_dir ./data
      max_file_handles 200
      long_poll_timeout 60s
    }
  }
}
```

## Core Patterns

### CLI for testing

```bash
# Install CLI
npm install -g @durable-streams/cli

# Set server URL
export STREAM_URL=http://localhost:4437

# Create, write, read
durable-stream create my-stream
durable-stream write my-stream "Hello, world!"
durable-stream read my-stream
```

### Running conformance tests

```bash
# Against your server
npx @durable-streams/server-conformance-tests --run http://localhost:4437

# Watch mode for development
npx @durable-streams/server-conformance-tests --watch src http://localhost:4437
```

### Programmatic dev server with stream creation

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"

const server = new DurableStreamTestServer({ port: 0 }) // Random port
await server.start()

// Streams must be created before clients can connect
await DurableStream.create({
  url: `${server.url}/v1/stream/my-app`,
  contentType: "application/json",
})

console.log(`Dev server running on ${server.url}`)
```

### Programmatic dev server in tests

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"

const server = new DurableStreamTestServer({ port: 0 }) // Random port
await server.start()

// Run your tests against server.url

await server.stop()
```

### Caddy configuration options

| Option              | Default            | Description                            |
| ------------------- | ------------------ | -------------------------------------- |
| `data_dir`          | (none — in-memory) | Directory for file-backed persistence  |
| `max_file_handles`  | 100                | Max concurrent open file handles       |
| `long_poll_timeout` | 60s                | How long to hold long-poll connections |

## Common Mistakes

### CRITICAL Using the Node.js dev server in production

Wrong:

```typescript
// production deployment
import { DurableStreamTestServer } from "@durable-streams/server"
const server = new DurableStreamTestServer({ port: 4437 })
```

Correct:

```bash
# Use the Caddy plugin binary
./durable-streams-server run --config Caddyfile
```

`DurableStreamTestServer` is explicitly not for production. It uses in-memory storage, has no CDN integration, and is single-process only.

Source: packages/server/README.md

### CRITICAL Not configuring data_dir for persistence

Wrong:

```
:8787 {
  route /v1/stream/* {
    durable_streams
  }
}
```

Correct:

```
:8787 {
  route /v1/stream/* {
    durable_streams {
      data_dir ./data
      max_file_handles 200
    }
  }
}
```

Without `data_dir`, the Caddy plugin uses in-memory storage. Server restarts lose all data.

Source: packages/caddy-plugin/README.md

### MEDIUM Setting max_file_handles too low for production

Wrong:

```
durable_streams {
  data_dir ./data
  # default 100 handles — fine for dev, low for production
}
```

Correct:

```
durable_streams {
  data_dir ./data
  max_file_handles 500  # Tune based on active stream count
}
```

Default is 100 file handles. High-throughput deployments with many concurrent streams can exhaust the pool, causing latency spikes.

Source: packages/caddy-plugin/store/filepool.go

## See also

- [getting-started](../getting-started/SKILL.md) — Connect a client to your server
- [go-to-production](../go-to-production/SKILL.md) — CDN caching, TTL, and HTTPS for production

## Version

Targets durable-streams-server v0.2.1.
