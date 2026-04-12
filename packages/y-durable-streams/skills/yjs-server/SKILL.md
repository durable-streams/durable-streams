---
name: yjs-server
description: >
  Deploy Yjs collaborative editing. YjsServer setup with compaction threshold,
  Caddy reverse proxy with flush_interval -1 for SSE, 3-layer architecture
  (Browser → Caddy → YjsServer → DS Server), Electric Cloud managed
  alternative with @electric-sql/cli provisioning. Load when deploying
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

Three deployment options: dev server for prototyping, Caddy for self-hosted
production, Electric Cloud for managed hosting.

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

### YjsServer options

| Option | Default | Description |
|--------|---------|-------------|
| `port` | — | Listen port |
| `host` | `"127.0.0.1"` | Listen host |
| `dsServerUrl` | — | Backing DS server URL |
| `compactionThreshold` | `1048576` (1MB) | Trigger compaction after this many bytes of updates |
| `dsServerHeaders` | `{}` | Headers sent to the DS server (e.g. auth) |

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

## Managed with Electric Cloud

Skip infrastructure setup entirely. Provision a Yjs service via the
Electric Cloud CLI:

```bash
# Install and authenticate
npx @electric-sql/cli auth login

# Create a Yjs service
npx @electric-sql/cli services create yjs --json

# Get the service URL and secret
npx @electric-sql/cli services get-secret <service-id> --json
```

Then point YjsProvider at the cloud URL:

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl: "https://api.electric-sql.cloud/v1/yjs/<service-id>",
  docId: "my-doc",
  headers: {
    Authorization: `Bearer <secret>`,
  },
})
```

### Server-side proxy (required for browser apps)

Do NOT expose the Electric Cloud secret to browser clients. Use a
server-side proxy route that injects the Authorization header:

```typescript
// Server route: /api/yjs/*
app.all("/api/yjs/*", async (req, res) => {
  const targetUrl = `https://api.electric-sql.cloud/v1/yjs/<service-id>${req.path.replace("/api/yjs", "")}`
  const response = await fetch(targetUrl, {
    method: req.method,
    headers: {
      ...req.headers,
      Authorization: `Bearer ${process.env.YJS_SECRET}`,
    },
    body: req.method !== "GET" ? req.body : undefined,
    duplex: "half",
  })

  // Block-list headers that break when proxied
  const skipHeaders = new Set([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
  ])

  for (const [key, value] of response.headers) {
    if (!skipHeaders.has(key.toLowerCase())) {
      res.setHeader(key, value)
    }
  }

  res.status(response.status)
  response.body.pipe(res)
})
```

Key proxy rules:
- Use a **block-list** for response headers — Yjs protocol uses custom
  headers like `stream-next-offset` that an allow-list would miss
- Block `content-encoding` and `content-length` — Node's `fetch`
  auto-decompresses gzip but leaves the headers, causing
  `ERR_CONTENT_DECODING_FAILED`
- Use `duplex: "half"` when forwarding request bodies

Then point the provider at your proxy:

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl: "/api/yjs",  // Must be absolute — use window.location.origin + path
  docId: "my-doc",
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

Source: examples/yjs-demo/Caddyfile

### HIGH Exposing Electric Cloud secret to browser clients

Wrong:

```typescript
new YjsProvider({
  doc,
  baseUrl: "https://api.electric-sql.cloud/v1/yjs/<service-id>",
  headers: { Authorization: `Bearer ${cloudSecret}` },  // Leaked!
})
```

Correct: Use a server-side proxy that injects the secret. See the proxy
section above.

### MEDIUM Not configuring compaction threshold

Default is 1MB. For documents with frequent small edits (collaborative text),
this is reasonable. For documents with large binary content (images, files),
increase it to avoid excessive compaction I/O.

## See also

- [yjs-getting-started](../yjs-getting-started/SKILL.md) — Dev server setup
- [yjs-sync](../yjs-sync/SKILL.md) — Provider configuration and events
- [server-deployment](../../../client/skills/server-deployment/SKILL.md) — DS server Caddy config
- [go-to-production](../../../client/skills/go-to-production/SKILL.md) — HTTPS, TTL, CDN checklist
