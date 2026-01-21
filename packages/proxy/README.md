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
import { createProxyServer } from "@durable-streams/proxy/server"

const server = await createProxyServer({
  port: 4440,
  durableStreamsUrl: "http://localhost:4441",
  jwtSecret: process.env.JWT_SECRET,
  allowlist: ["https://api.openai.com/**", "https://api.anthropic.com/**"],
})

console.log(`Proxy running at ${server.url}`)
```

## Server Protocol API

The proxy exposes a REST API for creating, reading, and aborting streams.

### Create Stream

Creates a new stream and begins proxying the upstream response.

```
POST /v1/proxy/{service}?stream_key={key}&upstream={url}
```

**URL Parameters:**

- `service` - Logical service name (e.g., "chat", "completions")
- `stream_key` - Unique identifier for this stream
- `upstream` - URL of the upstream service to proxy

**Request Body:** Forwarded as-is to the upstream service.

**Request Headers:** Forwarded to upstream (except hop-by-hop headers).

**Response (201 Created):**

```json
{
  "path": "/v1/streams/chat/my-stream-key",
  "readToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response Headers:**

- `Durable-Streams-Path` - Path to read the stream
- `Durable-Streams-Read-Token` - JWT token for reading/aborting

**Error Codes:**
| Status | Code | Description |
|--------|------|-------------|
| 400 | `MISSING_STREAM_KEY` | `stream_key` query parameter not provided |
| 400 | `MISSING_UPSTREAM` | `upstream` query parameter not provided |
| 400 | `INVALID_UPSTREAM` | Upstream URL is malformed |
| 400 | `INVALID_STREAM_KEY` | Stream key contains invalid characters (`..`, `/`, `\`) |
| 400 | `INVALID_SERVICE_NAME` | Service name contains invalid characters |
| 403 | `UPSTREAM_NOT_ALLOWED` | Upstream URL not in allowlist |
| 409 | `STREAM_EXISTS` | Stream with this key already exists |

### Read Stream

Reads data from an existing stream. Returns SSE events for live streaming.

```
GET /v1/proxy/{service}/streams/{key}?offset={offset}&live={mode}
Authorization: Bearer {readToken}
```

**Query Parameters:**

- `offset` - Position to start reading from (`-1` for beginning)
- `live` - Live mode: `sse` for Server-Sent Events, `poll` for long-polling

**Response:** Server-Sent Events stream with the proxied content.

**SSE Event Format:**

```
id: 42
data: {"choices":[{"delta":{"content":"Hello"}}]}

id: 43
event: control
data: {"type":"close","reason":"complete"}
```

**Response Headers:**

- `Stream-Next-Offset` - Offset for next read request
- `Stream-Cursor` - Current position in stream
- `Stream-Up-To-Date` - Whether client has received all available data

**Error Codes:**
| Status | Code | Description |
|--------|------|-------------|
| 401 | `UNAUTHORIZED` | Missing or invalid read token |
| 403 | `FORBIDDEN` | Token doesn't authorize this stream |
| 404 | `STREAM_NOT_FOUND` | Stream doesn't exist |

### Abort Stream

Aborts an in-progress stream, stopping the upstream connection.

```
POST /v1/proxy/{service}/streams/{key}/abort
Authorization: Bearer {readToken}
```

**Response (200 OK):**

```json
{
  "aborted": true
}
```

**Error Codes:**
| Status | Code | Description |
|--------|------|-------------|
| 401 | `UNAUTHORIZED` | Missing or invalid read token |
| 403 | `FORBIDDEN` | Token doesn't authorize this stream |
| 404 | `STREAM_NOT_FOUND` | Stream doesn't exist |

### Health Check

```
GET /health
```

**Response (200 OK):**

```json
{
  "status": "ok"
}
```

## Control Messages

The proxy appends control messages to streams to signal completion, errors, or aborts:

```typescript
// Stream completed successfully
{ "type": "close", "reason": "complete" }

// Stream was aborted by client
{ "type": "close", "reason": "aborted" }

// Stream encountered an error
{
  "type": "close",
  "reason": "error",
  "error": {
    "code": "UPSTREAM_ERROR",
    "status": 500,
    "message": "Upstream connection failed"
  }
}
```

**Error Codes in Control Messages:**
| Code | Description |
|------|-------------|
| `UPSTREAM_ERROR` | Upstream returned non-2xx status |
| `UPSTREAM_TIMEOUT` | Upstream connection timed out |
| `REDIRECT_NOT_ALLOWED` | Upstream attempted a redirect (blocked for SSRF prevention) |

## Client Library

The package includes a client library for browser and Node.js applications.

### createDurableFetch

A fetch-like wrapper that handles stream creation, credential storage, and automatic resumption.

```typescript
import { createDurableFetch } from "@durable-streams/proxy/client"

const durableFetch = createDurableFetch({
  proxyUrl: "https://my-proxy.example.com/v1/proxy/chat",
  storage: localStorage, // or sessionStorage, or custom
  autoResume: true, // automatically resume interrupted streams
})

const response = await durableFetch(
  "https://api.openai.com/v1/chat/completions",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-...",
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    }),
    stream_key: "conversation-123", // Required: unique key for this stream
  }
)

// response.body is a ReadableStream
// response.wasResumed indicates if this was a resume
// response.durableStreamPath is the path for manual operations
```

### createAbortFn

Creates a function to abort an in-progress stream.

```typescript
import { createAbortFn, loadCredentials } from "@durable-streams/proxy/client"

const credentials = loadCredentials(
  localStorage,
  "durable-streams:",
  scope,
  streamKey
)
const abort = createAbortFn(proxyUrl, streamKey, credentials.readToken)

await abort() // Stops the upstream connection
```

### TanStack Query Adapter

Integration with TanStack Query's `useChat` hook.

```typescript
import { createDurableAdapter } from "@durable-streams/proxy/transports/tanstack"

const adapter = createDurableAdapter(
  "https://api.openai.com/v1/chat/completions",
  {
    proxyUrl: "https://my-proxy.example.com/v1/proxy/chat",
    storage: localStorage,
    getStreamKey: (messages) => `chat-${conversationId}`,
  }
)

// Use with TanStack's useChat
const { messages, sendMessage } = useChat({
  transport: adapter,
})
```

## Configuration

### Server Options

| Option              | Type     | Default     | Description                             |
| ------------------- | -------- | ----------- | --------------------------------------- |
| `port`              | number   | 4440        | Port to listen on                       |
| `host`              | string   | "localhost" | Host to bind to                         |
| `durableStreamsUrl` | string   | _required_  | URL of the durable-streams backend      |
| `allowlist`         | string[] | []          | Glob patterns for allowed upstream URLs |
| `jwtSecret`         | string   | _required_  | Secret for signing read tokens          |
| `streamTtlSeconds`  | number   | 86400       | Stream expiration time (24 hours)       |
| `maxResponseBytes`  | number   | 104857600   | Max response size (100MB)               |
| `idleTimeoutMs`     | number   | 300000      | Upstream idle timeout (5 min)           |

### Allowlist Patterns

The allowlist uses glob-style patterns:

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
- Hostnames are case-insensitive
- Default ports (443 for HTTPS, 80 for HTTP) are normalized

## Security

### SSRF Prevention

The proxy blocks several SSRF attack vectors:

1. **Allowlist Validation**: Only URLs matching allowlist patterns are proxied
2. **Redirect Blocking**: Upstream redirects are blocked to prevent allowlist bypass
3. **Path Traversal Prevention**: Stream keys and service names are validated

### Token Security

Read tokens are JWTs with:

- Short expiration (matches `streamTtlSeconds`)
- Path-scoped authorization
- HMAC-SHA256 signature

## Conformance Tests

The proxy includes a comprehensive test suite. Tests can run against the included reference server or an external proxy implementation.

### Running Tests Locally

```bash
cd packages/proxy
pnpm test
```

### Running Against External Server

Set `PROXY_CONFORMANCE_URL` to test against an external proxy:

```bash
PROXY_CONFORMANCE_URL=https://my-proxy.example.com pnpm test
```

**Requirements for external servers:**

- Must have `http://localhost:*/**` in its allowlist (tests use a mock upstream)
- Must be configured with a durable-streams backend

### Test Categories

| Category                     | Description                                               |
| ---------------------------- | --------------------------------------------------------- |
| `allowlist.test.ts`          | URL validation and pattern matching                       |
| `create-stream.test.ts`      | Stream creation, path traversal prevention, SSRF blocking |
| `read-stream.test.ts`        | Stream reading, SSE format, offset handling               |
| `abort-stream.test.ts`       | Stream abortion and control messages                      |
| `headers.test.ts`            | Header forwarding and response headers                    |
| `control-messages.test.ts`   | Error handling and stream lifecycle                       |
| `client-integration.test.ts` | Client library functionality                              |

## License

MIT
