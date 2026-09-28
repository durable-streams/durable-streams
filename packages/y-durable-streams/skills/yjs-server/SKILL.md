---
name: yjs-server
description: >
  Deploy Yjs collaborative editing. YjsServer setup with compaction threshold,
  Caddy reverse proxy with flush_interval -1 for SSE, 3-layer architecture
  (Browser → Caddy → YjsServer → DS Server). Load when deploying
  y-durable-streams to production or configuring server infrastructure.
type: core
library: durable-streams
library_version: "0.2.3"
requires:
  - yjs-getting-started
sources:
  - "durable-streams/durable-streams:packages/y-durable-streams/src/server/yjs-server.ts"
  - "durable-streams/durable-streams:packages/y-durable-streams/src/server/compaction.ts"
  - "durable-streams/durable-streams:examples/yjs-demo/server.ts"
  - "durable-streams/durable-streams:examples/yjs-demo/Caddyfile"
---

This skill builds on durable-streams/yjs-getting-started. Read it first for
basic setup.

# Durable Streams — Yjs Server Deployment

Two deployment options: dev server for prototyping, Caddy for self-hosted
production.

## Architecture

```
Browser (YjsProvider)
    │ HTTPS
    ▼
Caddy reverse proxy (:443)
    ├─ /v1/stream/* → Durable Streams storage
    └─ /v1/yjs/*   → YjsServer (flush_interval -1)
                         │ HTTP
                         ▼
                    DS Server (storage)
```

YjsServer implements the Yjs wire protocol (snapshot discovery, compaction,
awareness routing) and proxies all storage operations to a Durable Streams
server.

## Development

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"
import { YjsServer } from "@durable-streams/y-durable-streams/server"

const dsServer = new DurableStreamTestServer({ port: 4437 })
await dsServer.start()

const yjsServer = new YjsServer({
  port: 4438,
  host: "127.0.0.1",
  dsServerUrl: "http://localhost:4437",
  compactionThreshold: 1024 * 1024, // 1MB (default)
})
await yjsServer.start()
```

### Single-origin dev server (HTTP/2 multiplexing)

For local development you usually want one origin the browser hits so HTTP/2
can multiplex the DS stream, Yjs stream, and the Vite dev server over a
single connection. Spawn Caddy from a Node script alongside YjsServer:

```typescript
// server.ts
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { YjsServer } from "@durable-streams/y-durable-streams/server"

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0" // trust Caddy's self-signed cert

const CADDY_PORT = 4443
const YJS_PORT = 4438

const yjsServer = new YjsServer({
  port: YJS_PORT,
  host: "127.0.0.1",
  dsServerUrl: `https://localhost:${CADDY_PORT}`, // go through Caddy for TLS
  compactionThreshold: 1024 * 1024,
})
await yjsServer.start()

const caddy = spawn(
  resolve(import.meta.dirname, "./durable-streams-server"),
  ["run", "--config", resolve(import.meta.dirname, "./Caddyfile")],
  { stdio: ["ignore", "pipe", "pipe"] }
)

// Wait for Caddy's ready line before returning control
await new Promise<void>((ok, fail) => {
  const t = setTimeout(() => fail(new Error("Caddy start timeout")), 10_000)
  caddy.stderr.on("data", (buf: Buffer) => {
    if (buf.toString().includes("serving initial configuration")) {
      clearTimeout(t)
      ok()
    }
  })
  caddy.on("exit", (code) => {
    clearTimeout(t)
    if (code && code !== 0) fail(new Error(`Caddy exited ${code}`))
  })
})

process.on("SIGINT", async () => {
  await yjsServer.stop()
  caddy.kill("SIGTERM")
  process.exit(0)
})
```

And the matching dev Caddyfile — DS at `/v1/stream/*`, Yjs proxied to the
internal YjsServer, everything else to Vite:

```caddy
{
  admin off
}

localhost:4443 {
  route /v1/stream/* {
    durable_streams
  }

  route /v1/yjs/* {
    reverse_proxy localhost:4438 {
      flush_interval -1
    }
  }

  reverse_proxy localhost:3001   # Vite dev server
}
```

The `flush_interval -1` on the Yjs route is mandatory (see Common Mistakes
below). Keep the dev and production Caddyfiles consistent on this flag.

### YjsServer options

| Option                | Default         | Description                                         |
| --------------------- | --------------- | --------------------------------------------------- |
| `port`                | —               | Listen port                                         |
| `host`                | `"127.0.0.1"`   | Listen host                                         |
| `dsServerUrl`         | —               | Backing DS server URL                               |
| `compactionThreshold` | `1048576` (1MB) | Trigger compaction after this many bytes of updates |
| `dsServerHeaders`     | `{}`            | Headers sent to the DS server (e.g. auth)           |

### Compaction

When accumulated updates for a document exceed `compactionThreshold`, the
server automatically creates a snapshot. New clients load the snapshot
instead of replaying all updates — keeps initial sync fast. Connected clients
are unaffected.

## Production with Caddy

Download the Caddy binary with the durable_streams plugin from
[GitHub releases](https://github.com/durable-streams/durable-streams/releases).

### Caddyfile

```
:443 {
  route /v1/stream/* {
    durable_streams {
      data_dir ./data
      max_file_handles 200
    }
  }

  route /v1/yjs/* {
    reverse_proxy localhost:4438 {
      flush_interval -1
    }
  }
}
```

**`flush_interval -1` is mandatory** — without it, Caddy buffers SSE
responses and live updates stop working. This is the #1 production
deployment mistake.

### Production YjsServer

Point YjsServer at the Caddy server (not the raw DS server) if Caddy handles
TLS:

```typescript
const yjsServer = new YjsServer({
  port: 4438,
  dsServerUrl: "https://localhost:443",
  compactionThreshold: 1024 * 1024,
})
```

## Common Mistakes

### CRITICAL Missing `flush_interval -1` in Caddy config

Wrong:

```
route /v1/yjs/* {
  reverse_proxy localhost:4438
}
```

Correct:

```
route /v1/yjs/* {
  reverse_proxy localhost:4438 {
    flush_interval -1
  }
}
```

Without this, Caddy buffers SSE responses. Live updates appear to hang —
clients connect but never receive data.

### MEDIUM Not configuring compaction threshold

Default is 1MB. For documents with frequent small edits (collaborative text),
this is reasonable. For documents with large binary content (images, files),
increase it to avoid excessive compaction I/O.

## See also

- [yjs-getting-started](../yjs-getting-started/SKILL.md) — Dev server setup
- [yjs-sync](../yjs-sync/SKILL.md) — Provider configuration and events
- [server-deployment](../../../client/skills/server-deployment/SKILL.md) — DS server Caddy config
- [go-to-production](../../../client/skills/go-to-production/SKILL.md) — HTTPS, TTL, CDN checklist
