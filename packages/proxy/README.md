# @durable-streams/proxy

A durable proxy server for AI streaming APIs. Routes requests through a [Durable Streams](https://github.com/durable-streams/durable-streams) backend to provide resumable, persistent streams that survive network interruptions.

## Overview

The proxy sits between your client and upstream AI services (OpenAI, Anthropic, etc.), persisting streaming responses to a durable store. If a connection drops, clients can resume from where they left off rather than losing partial responses or re-running expensive inference calls.

```
┌─────────────┐       ┌─────────────────┐       ┌──────────────┐
│   Client    │──────►│  Durable Proxy  │──────►│  Upstream    │
│             │◄──────│                 │       │  (OpenAI,    │
│  (browser,  │       │  Persists to:   │       │  Anthropic)  │
│  mobile)    │       │  ┌───────────┐  │       │              │
│             │       │  │ Durable   │  │       │              │
└─────────────┘       │  │ Streams   │  │       └──────────────┘
                      │  └───────────┘  │
                      └─────────────────┘
```

## Installation

```bash
pnpm add @durable-streams/proxy
```

## Quick Start

```typescript
import { createProxyServer } from "@durable-streams/proxy"

const server = await createProxyServer({
  port: 4440,
  durableStreamsUrl: "http://localhost:4441",
  jwtSecret: process.env.JWT_SECRET,
  allowlist: ["https://api.openai.com/**", "https://api.anthropic.com/**"],
})

console.log(`Proxy running at ${server.url}`)
```

## Server Protocol API

The proxy exposes a REST API for creating, reading, aborting, and deleting streams. See [PROXY_PROTOCOL.md](./PROXY_PROTOCOL.md) for the full specification.

| Method | Path            | Auth                  | Description          |
| ------ | --------------- | --------------------- | -------------------- |
| POST   | `/v1/proxy`     | Service JWT           | Create proxy request |
| GET    | `/v1/proxy/:id` | Pre-signed URL or JWT | Read from stream     |
| HEAD   | `/v1/proxy/:id` | Service JWT           | Get stream metadata  |
| PATCH  | `/v1/proxy/:id` | Pre-signed URL only   | Abort upstream       |
| DELETE | `/v1/proxy/:id` | Service JWT           | Delete stream        |

### Create Stream

Creates a new stream by forwarding a request to the upstream service and persisting the response.

```
POST /v1/proxy?secret={serviceSecret}
Upstream-URL: https://api.openai.com/v1/chat/completions
Upstream-Method: POST
Upstream-Authorization: Bearer sk-...
Content-Type: application/json

{"model": "gpt-4", "messages": [...], "stream": true}
```

The proxy validates authentication, checks the upstream URL against the allowlist, then fetches from upstream. On a 2xx response, it begins piping data into a durable stream in the background and returns immediately:

```http
HTTP/1.1 201 Created
Location: /v1/proxy/{streamId}?expires={ts}&signature={sig}
Upstream-Content-Type: text/event-stream
```

The `Location` header contains a pre-signed capability URL that grants both read and abort access.

**On upstream error (4xx/5xx):** returns 502 with the upstream body and an `Upstream-Status` header.

**Error Codes:**
| Status | Code | Description |
|--------|------|-------------|
| 400 | `MISSING_UPSTREAM_URL` | Missing `Upstream-URL` header |
| 400 | `MISSING_UPSTREAM_METHOD` | Missing `Upstream-Method` header |
| 400 | `INVALID_UPSTREAM_METHOD` | Method not in GET/POST/PUT/PATCH/DELETE |
| 400 | `REDIRECT_NOT_ALLOWED` | Upstream returned 3xx |
| 401 | `MISSING_SECRET` | No authentication provided |
| 401 | `INVALID_SECRET` | Service secret mismatch |
| 403 | `UPSTREAM_NOT_ALLOWED` | URL not in allowlist |
| 504 | `UPSTREAM_TIMEOUT` | Upstream didn't respond within 60s |

### Read Stream

Reads data from an existing stream. Authenticates via the pre-signed URL from the `Location` header, or via service JWT.

```
GET /v1/proxy/{streamId}?expires={ts}&signature={sig}&offset={offset}&live=sse
```

Delegates to the underlying durable stream for offset handling and live modes (`sse`, `long-poll`). Returns `Stream-*` headers from the durable stream plus `Upstream-Content-Type`.

**Error Codes:**
| Status | Code | Description |
|--------|------|-------------|
| 401 | `MISSING_SECRET` | No auth provided |
| 401 | `SIGNATURE_EXPIRED` | Pre-signed URL past expiration |
| 401 | `SIGNATURE_INVALID` | HMAC verification failed |
| 404 | `STREAM_NOT_FOUND` | Stream doesn't exist |

### Abort Stream

Aborts the upstream connection for an in-progress stream. Data piped up to the abort point remains readable.

```
PATCH /v1/proxy/{streamId}?expires={ts}&signature={sig}&action=abort
```

Requires a pre-signed URL (no service JWT fallback). Returns `204 No Content`. Idempotent.

### Head Stream

Returns stream metadata headers without a body. Requires service JWT.

```
HEAD /v1/proxy/{streamId}?secret={serviceSecret}
```

### Delete Stream

Deletes a stream and aborts any in-flight upstream connection. Requires service JWT.

```
DELETE /v1/proxy/{streamId}?secret={serviceSecret}
```

Returns `204 No Content`. Idempotent.

### Health Check

```
GET /health
```

Returns `200 OK` with `{"status":"ok"}`.

## Client Library

The package includes a client library for browser and Node.js applications, available at `@durable-streams/proxy/client`.

### createDurableSession

Session API for multi-request streams. A single session appends multiple upstream
responses to one durable stream and returns demultiplexed `ProxyResponse` objects.

```typescript
import { createDurableSession } from "@durable-streams/proxy/client"

const session = createDurableSession({
  proxyUrl: "https://my-proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  sessionId: "conversation-123",
  storage: localStorage,
})

await session.connect() // optional; auto-runs on first fetch/responses call

const response = await session.fetch(
  "https://api.openai.com/v1/chat/completions",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-...", // becomes Upstream-Authorization
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    }),
    requestId: "turn-1",
  }
)

console.log(response.responseId) // numeric stream response ID
```

### createDurableFetch

One-off wrapper for non-session usage. Each call creates a stream and returns a
demultiplexed `ProxyResponse` for that request.

```typescript
import { createDurableFetch } from "@durable-streams/proxy/client"

const durableFetch = createDurableFetch({
  proxyUrl: "https://my-proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
})

const response = await durableFetch(
  "https://api.openai.com/v1/chat/completions",
  {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    }),
    requestId: "req-abc",
  }
)
```

Everything passed to client request calls is aimed at upstream. `Authorization`
is relabeled to `Upstream-Authorization`, and method is relabeled to
`Upstream-Method`.

### createAbortFn

Creates a function to abort an in-progress stream using the pre-signed URL.

```typescript
import { createAbortFn } from "@durable-streams/proxy/client"

// streamUrl is the pre-signed URL from response.streamUrl
const abort = createAbortFn(streamUrl)

await abort() // Sends PATCH ?action=abort to stop the upstream connection
```

### Credential Storage

The client stores `requestId -> responseId` mappings for idempotent retry:

- Session key: `{prefix}{proxyUrl}:{sessionId}:{requestId} -> { responseId }`
- One-off key: `{prefix}{proxyUrl}::{requestId} -> { responseId, streamUrl }`

- **Browser**: Uses `localStorage` by default
- **Node.js**: Uses `MemoryStorage` (in-process only)
- **Custom**: Pass any object implementing `getItem`/`setItem`/`removeItem`

## AI SDK Transports

Integration adapters for popular AI SDKs, available at `@durable-streams/proxy/transports`.

### Vercel AI SDK

```typescript
import { createDurableChatTransport } from "@durable-streams/proxy/transports"
import { useChat } from "ai/react"

const transport = createDurableChatTransport({
  api: "https://api.example.com/api/chat",
  proxyUrl: "https://my-proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  getRequestId: (messages) => `chat-${conversationId}`,
})

function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    transport,
  })
  // ...
}
```

### TanStack AI

```typescript
import { createDurableAdapter } from "@durable-streams/proxy/transports"

const adapter = createDurableAdapter("https://api.example.com/api/chat", {
  proxyUrl: "https://my-proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  getRequestId: (messages, data) => data?.conversationId ?? "default",
})

// Use with TanStack AI
const connection = await adapter.connect({
  url: "https://api.example.com/api/chat",
  body: { messages },
})

// Read the stream
const reader = connection.stream.getReader()

// To abort
await adapter.abort()
```

## Configuration

### Server Options

| Option                 | Type     | Default     | Description                                        |
| ---------------------- | -------- | ----------- | -------------------------------------------------- |
| `port`                 | number   | 4440        | Port to listen on                                  |
| `host`                 | string   | "localhost" | Host to bind to                                    |
| `durableStreamsUrl`    | string   | _required_  | URL of the durable-streams backend                 |
| `jwtSecret`            | string   | _required_  | Secret for signing pre-signed URLs and service JWT |
| `allowlist`            | string[] | []          | Glob patterns for allowed upstream URLs            |
| `streamTtlSeconds`     | number   | 86400       | Stream expiration time (24 hours)                  |
| `urlExpirationSeconds` | number   | 86400       | Pre-signed URL expiration (24 hours)               |
| `maxResponseBytes`     | number   | 104857600   | Max response size (100MB)                          |

### Allowlist Patterns

The allowlist uses glob-style patterns to control which upstream URLs the proxy will forward to:

```typescript
allowlist: [
  "https://api.openai.com/**", // Any path under api.openai.com
  "https://api.anthropic.com/v1/*", // Single path segment under /v1/
  "http://localhost:*/**", // Any port on localhost
  "https://*.example.com/api/**", // Any subdomain of example.com
]
```

**Pattern Syntax:**

- `*` matches a single path segment or port
- `**` matches any number of path segments
- `*.example.com` matches any subdomain
- Default ports (443 for HTTPS, 80 for HTTP) are normalized
- Query params and fragments are stripped before matching

## Security

### Authentication Model

The proxy uses two authentication mechanisms:

| Operation       | Auth method           | Notes                           |
| --------------- | --------------------- | ------------------------------- |
| Create (POST)   | Service JWT           | Via `?secret=` or Bearer header |
| Read (GET)      | Pre-signed URL or JWT | URL from Location header        |
| Abort (PATCH)   | Pre-signed URL only   | No JWT fallback                 |
| Metadata (HEAD) | Service JWT only      | No pre-signed URL fallback      |
| Delete (DELETE) | Service JWT only      | No pre-signed URL fallback      |

**Pre-signed URLs** are capability URLs — possession grants both read and abort access. They are HMAC-SHA256 signed, bound to stream ID and expiration, and use timing-safe comparison.

**Service JWT** is a simple shared secret verified with timing-safe comparison. Sent via `?secret=` query parameter or `Authorization: Bearer` header.

### SSRF Prevention

1. **Allowlist Validation**: Only URLs matching configured patterns are proxied
2. **Redirect Blocking**: 3xx responses are rejected to prevent allowlist bypass
3. **Header Filtering**: Hop-by-hop and proxy-managed headers are stripped

## Tests

The proxy includes a comprehensive test suite. Tests can run against the included reference server or an external proxy implementation.

```bash
cd packages/proxy
pnpm test
```

To test against an external server:

```bash
PROXY_CONFORMANCE_URL=https://my-proxy.example.com pnpm test
```

External servers must have `http://localhost:*/**` in their allowlist (tests use a mock upstream).

| Category                     | Description                                |
| ---------------------------- | ------------------------------------------ |
| `allowlist.test.ts`          | URL validation and pattern matching        |
| `create-stream.test.ts`      | Stream creation, validation, SSRF blocking |
| `read-stream.test.ts`        | Stream reading, offset handling            |
| `abort-stream.test.ts`       | Stream abortion and idempotency            |
| `head-stream.test.ts`        | Stream metadata retrieval                  |
| `delete-stream.test.ts`      | Stream deletion and cleanup                |
| `headers.test.ts`            | Header forwarding and filtering            |
| `control-messages.test.ts`   | Error handling and stream lifecycle        |
| `upstream-errors.test.ts`    | Upstream failure handling                  |
| `client-integration.test.ts` | Client library functionality               |

## License

MIT
