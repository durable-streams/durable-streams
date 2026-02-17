# RFC 0001: Proxy Stream Reuse

**Status:** Accepted (incorporated into [PROXY_PROTOCOL.md](../../packages/proxy/PROXY_PROTOCOL.md))
**Created:** 2026-02-01
**Package:** `@durable-streams/proxy`

## Summary

This RFC proposes adding stream reuse, session management, and binary framing capabilities to the proxy package. It specifies three operations — **create**, **append**, and **connect** — all dispatched via `POST /v1/proxy` using header-based routing. This enables session-based streaming where a client can initialize a session (connect), consume and resume a single stream across an entire conversation (append), and obtain fresh signed URLs when they expire (reconnect via connect).

All upstream response data is written using a binary framing format that encapsulates response metadata and body data, allowing multiple responses to be multiplexed onto a single stream and reconstructed independently by readers. The framing format is defined in the [Proxy Protocol Specification](../../packages/proxy/PROXY_PROTOCOL.md) Section 5.

## Requirements

### Functional Requirements

1. **Stream Reuse**: The proxy server MUST support appending upstream responses to an existing stream instead of always creating a new stream.

2. **Session Identification**: The client MUST be able to specify a session identifier that groups multiple requests into a single stream.

3. **Connect Operation**: The proxy MUST support a connect operation that derives a stream ID deterministically from a session ID, ensures the stream exists, optionally authorizes the client via a developer-provided auth endpoint, and returns a signed stream URL. Connect does not return a response body — all stream data is read via the signed URL.

4. **Deterministic Stream IDs**: When a `Session-Id` is provided, the stream ID MUST be derived deterministically from the session ID (e.g., UUIDv5 with a fixed namespace). This MUST be stateless and reproducible — the same session ID always yields the same stream ID.

5. **Header-Based Dispatch**: All write operations MUST be dispatched via `POST /v1/proxy` using header presence to determine the operation (create, append, or connect).

6. **Binary Framing**: All upstream response data MUST be written using a binary framing format that encapsulates response metadata and body, enabling multiplexing of multiple responses onto a single stream.

7. **Client-Side Idempotency**: The `requestId` mechanism MUST prevent duplicate upstream requests on retry. When a `requestId` has a stored `responseId` mapping, the client MUST skip the POST and read the existing response from the stream. The server returns a `Stream-Response-Id` header on create and append responses to enable this mapping.

8. **Security**: Stream reuse MUST validate that the caller has permission to append to the stream using the existing pre-signed URL mechanism.

### Non-Functional Requirements

1. **Stateless Proxy**: The proxy server MUST remain stateless. Session-to-stream mapping is achieved via deterministic derivation (UUIDv5), not stored mappings.

2. **Minimal API Surface**: The feature should add minimal new API surface while being explicit about behavior.

## Background

### Current Architecture

The `@durable-streams/proxy` package provides:

1. **Server** (`handleCreateStream`): Accepts `POST /v1/proxy` requests, fetches from upstream, creates a new durable stream, pipes the response to the stream, and returns a pre-signed URL.

2. **Client** (`createDurableFetch`): A fetch wrapper that routes requests through the proxy and supports resuming interrupted streams.

### Current Flow

```
Client                          Proxy                         Upstream
  |                               |                               |
  |  POST /v1/proxy               |                               |
  |  Upstream-URL: api.example    |                               |
  |------------------------------>|                               |
  |                               |  POST api.example/chat        |
  |                               |------------------------------>|
  |                               |                               |
  |                               |<-- 200 OK (streaming body) ---|
  |                               |                               |
  |<-- 201 Created                |                               |
  |    Location: /v1/proxy/{id}   |                               |
  |    ?expires=X&signature=Y     |                               |
  |                               |                               |
  |  GET /v1/proxy/{id}?...       |   (background: pipe to stream)|
  |------------------------------>|                               |
  |                               |                               |
  |<-- SSE stream of body --------|                               |
```

### Current `requestId` Mechanism

When `requestId` is provided:

1. Client checks if credentials exist for `{proxyUrl}:{requestId}`
2. If credentials exist and URL not expired: **skip POST**, resume reading from stored `streamUrl` at `offset`
3. If no credentials: make POST, create new stream, store credentials

The `requestId` enables **resuming reads** of an interrupted response.

### Limitation

Currently, each `POST /v1/proxy` creates a **new stream**. There is no way to:

- Append multiple upstream responses to the same stream
- Create a session-level stream that accumulates all responses
- Initialize a session (connect, authorize) or derive a stream ID from a session identity

## Proposal

### New Concept: `sessionId`

Introduce `sessionId` as a distinct concept from `requestId`:

| Concept     | Purpose                                          | Affects                                                                      |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `requestId` | Client-side idempotency (prevent duplicate POST) | Client-side (maps requestId → responseId in storage, skips POST on retry)    |
| `sessionId` | Group multiple requests into one stream          | Server-side (append vs create)                                               |
| `connect`   | Initialize/reconnect a session                   | Server-side (derive stream, optionally auth via endpoint, return signed URL) |

They are orthogonal and can be used together.

**Session Lifecycle**: A typical session follows this sequence: **connect** (first operation — initializes the session, optionally authorizes via auth endpoint, returns signed URL) → **subscribe** (GET the signed stream URL — SSE stream for real-time updates) → **send** (append POST — writes new messages to the stream). When a signed URL expires, the client simply **connects** again with the same `Session-Id` to obtain a fresh URL.

### Client API Changes

The previous `createDurableFetch` API is replaced entirely by a session-centric model. The new API has two entry points:

1. **`createDurableProxySession`** — creates a session that manages a single durable stream, supporting multiple requests (append), response demultiplexing, and client-side idempotent retry via `requestId`.
2. **`createDurableFetch`** — a thin wrapper with a fetch-like API for one-off requests that don't need session semantics.

#### `ProxySessionOptions` (session instantiation)

```typescript
interface ProxySessionOptions {
  /** Full base URL of the proxy endpoint */
  proxyUrl: string

  /** Authorization for the proxy (service secret) */
  proxyAuthorization: string

  /** Session ID. Used to derive a deterministic stream ID via UUIDv5. */
  sessionId: string

  /**
   * Optional URL for the auth endpoint.
   * When a session connects, the proxy forwards a POST to this URL
   * with a Stream-Id header. The endpoint authorizes the session
   * by returning 2xx (approved) or non-2xx (rejected).
   * If not configured, the proxy trusts service authentication alone.
   */
  connectUrl?: string

  /**
   * Optional TTL in seconds for signed URLs.
   * Sent as Stream-Signed-URL-TTL header.
   * Default: server-configured (implementation-defined).
   */
  streamSignedUrlTtl?: number

  /** Storage for persisting requestId -> responseId mappings (default: localStorage) */
  storage?: DurableStorage

  /** Prefix for storage keys (default: 'durable-streams:') */
  storagePrefix?: string

  /** Custom fetch implementation */
  fetch?: typeof fetch
}
```

#### `ProxyFetchOptions` (per-request)

```typescript
interface ProxyFetchOptions extends Omit<RequestInit, "method"> {
  /** HTTP method for the upstream request (default: POST) */
  method?: string

  /**
   * Client-side idempotency key.
   * If provided, the client checks local storage for a stored responseId
   * mapped to this key. If found, the POST is skipped and the existing
   * response is read from the stream. If not found, the POST proceeds
   * and the returned Stream-Response-Id is stored for future retries.
   */
  requestId?: string
}
```

#### `ProxyResponse`

`ProxyResponse` extends the standard [Fetch API `Response`](https://developer.mozilla.org/en-US/docs/Web/API/Response), adding the `responseId` from the stream framing. All standard `Response` properties and methods are available: `.status`, `.ok`, `.headers`, `.body`, `.json()`, `.text()`, `.blob()`, `.clone()`, etc.

The `Response` is constructed from the Start frame's status code and headers, with the body being a `ReadableStream` of the demultiplexed Data frames for this response ID only.

```typescript
interface ProxyResponse extends Response {
  /** The numeric response ID within the stream (from framing) */
  responseId: number
}
```

#### `DurableProxySession`

```typescript
interface DurableProxySession {
  /**
   * Send a new request through the proxy.
   * Returns the demultiplexed response for THIS request only.
   *
   * On first call, automatically calls connect() to initialize the
   * session and obtain a signed URL. The connect operation creates
   * the stream, so all fetch() calls send an append POST (with
   * Use-Stream-URL header) — never a create POST.
   *
   * If requestId is provided and credentials exist in storage,
   * skips the POST and reads the existing response from the stream.
   */
  fetch(url: string | URL, options?: ProxyFetchOptions): Promise<ProxyResponse>

  /**
   * Subscribe to ALL responses on the stream.
   * Yields a ProxyResponse as soon as each response's Start frame
   * arrives — multiple responses can be in flight concurrently.
   * Each response's body is an independent ReadableStream that
   * receives data as its interleaved frames arrive.
   */
  responses(): AsyncIterable<ProxyResponse>

  /**
   * Connect/reconnect to obtain a fresh signed URL.
   * Called automatically on first fetch() or responses(), but can
   * be called manually. The connect operation ensures the stream
   * exists (creating it if necessary) and returns a signed URL.
   */
  connect(): Promise<void>

  /** Current signed stream URL (null before first connect) */
  readonly streamUrl: string | null

  /** Session ID */
  readonly sessionId: string

  /**
   * Derived stream ID (UUIDv5 from sessionId).
   * Computed locally using deterministic derivation — available
   * immediately after construction, before connect() is called.
   */
  readonly streamId: string

  /**
   * Abort ALL active upstream requests for this stream.
   * Sends PATCH {streamUrl}?action=abort to the proxy, which cancels
   * all in-flight upstream connections and writes Abort frames.
   * Idempotent — safe to call when no requests are active.
   */
  abort(): Promise<void>

  /** Tear down the session (close subscriptions, clean up) */
  close(): void
}
```

#### One-Off Usage (`createDurableFetch`)

For simple single-request usage without session semantics, `createDurableFetch` provides a thin wrapper with a fetch-like API. Configure it once, call it many times — each call creates a new stream.

```typescript
interface DurableFetchOptions {
  /** Full base URL of the proxy endpoint */
  proxyUrl: string

  /** Authorization for the proxy (service secret) */
  proxyAuthorization: string

  /** Storage for persisting requestId -> responseId mappings (default: localStorage) */
  storage?: DurableStorage

  /** Prefix for storage keys (default: 'durable-streams:') */
  storagePrefix?: string

  /** Custom fetch implementation */
  fetch?: typeof fetch
}

type DurableFetch = (
  url: string | URL,
  options?: ProxyFetchOptions
) => Promise<ProxyResponse>

function createDurableFetch(options: DurableFetchOptions): DurableFetch
```

Each call to the returned function sends a Create POST (no `Session-Id`, no `Use-Stream-URL`) and returns the single demultiplexed `ProxyResponse`. The `requestId` option works the same way — if stored credentials exist, the POST is skipped and the existing response is read from the stream. Since there is no session, the stored value includes the `streamUrl` so the client can read the response without a connect step (see storage format below).

#### `requestId` Flow (Client-Side Idempotency)

`requestId` is a client-side only mechanism. No server-side deduplication is involved.

**Session usage (`createDurableProxySession`):**

1. `session.fetch(url, { requestId: 'turn-3' })` is called
2. Client checks storage for key `{prefix}{proxyUrl}:{sessionId}:turn-3`
3. **If found**: stored value contains `{ responseId: 3 }`. Client skips the POST, reads response ID 3 from the stream (using `session.streamUrl`, connecting first if needed), and returns it as a `ProxyResponse`
4. **If not found**: Client POSTs to proxy (append). Server returns `Stream-Response-Id: 3` header. Client stores `{ responseId: 3 }` under the `requestId` key, then reads response 3 from the stream

Storage key: `{storagePrefix}{proxyUrl}:{sessionId}:{requestId}` → `{ responseId: number }`

**One-off usage (`createDurableFetch`):**

1. `durableFetch(url, { requestId: 'req-abc' })` is called
2. Client checks storage for key `{prefix}{proxyUrl}::req-abc`
3. **If found**: stored value contains `{ responseId: 1, streamUrl: "..." }`. Client skips the POST, reads the stream directly using the stored `streamUrl`, and returns the demultiplexed `ProxyResponse`
4. **If not found**: Client POSTs to proxy (create). Server returns `Stream-Response-Id: 1` and `Location` headers. Client stores `{ responseId: 1, streamUrl }` under the `requestId` key, then reads from the stream

Storage key: `{storagePrefix}{proxyUrl}::{requestId}` → `{ responseId: number, streamUrl: string }`

The double colon (`::`) in the one-off key indicates the absence of a `sessionId` component.

#### Concurrent Response Consumption

Multiple upstream responses may be in flight simultaneously (e.g., a multi-agent AI chat session where several LLM generations emit into the same session stream). Their frames are interleaved on the stream:

```
S(ID=3) → D(ID=3) → S(ID=4) → D(ID=3) → D(ID=4) → D(ID=3) → C(ID=3) → D(ID=4) → C(ID=4)
```

The demuxer handles this by yielding each `ProxyResponse` as soon as its **Start frame** arrives — it does not wait for one response to complete before yielding the next. Each `ProxyResponse.body` is an independent `ReadableStream` backed by a per-response buffer in the demuxer. As interleaved Data frames arrive, the demuxer routes each frame to the correct response's body stream by response ID.

This means consumers can read multiple response bodies concurrently:

```typescript
for await (const response of session.responses()) {
  // Don't await — start processing each response body immediately
  processResponse(response)
}

async function processResponse(response: ProxyResponse) {
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // Process chunks as they arrive (interleaved with other responses)
  }
}
```

**Backpressure:** If a consumer does not read a response's body, its Data frames accumulate in the demuxer's per-response buffer. This does not block other responses — the demuxer continues routing frames to other response streams. Implementations **SHOULD** bound the per-response buffer size and apply backpressure to the underlying SSE connection when any buffer is full, preventing memory exhaustion.

When `fetch()` and `responses()` are used concurrently, the body can be consumed from either reference (they are the same `ProxyResponse` object). If a `fetch()` caller drains the body, the `responses()` consumer can skip it (checking `response.bodyUsed`).

#### `AbortSignal` Support

`ProxyFetchOptions` inherits `signal` from `RequestInit`. The `signal` controls client-side cancellation only:

- **On `session.fetch()`**: Aborting the signal cancels the client's read of the demultiplexed response body. It does **not** send a PATCH abort to the proxy — the upstream request continues piping to the stream. Use `session.abort()` to cancel upstream requests.
- **On `createDurableFetch`**: Aborting the signal cancels both the POST request (if still in flight) and the subsequent stream read.

This separation is intentional: the stream is durable, so other consumers may still be reading it. Client-side cancellation is a local concern; upstream cancellation requires explicit `abort()`.

### Server API Changes

#### New Request Header: `Use-Stream-URL`

When `POST /v1/proxy` includes this header, the server appends to the existing stream instead of creating a new one.

**Header Format:**

```
Use-Stream-URL: <pre-signed-stream-url>
```

**Example:**

```
POST /v1/proxy?secret=xxx HTTP/1.1
Upstream-URL: https://api.openai.com/v1/chat/completions
Upstream-Method: POST
Use-Stream-URL: http://proxy.example.com/v1/proxy/abc-123?expires=1234567890&signature=xyz
Content-Type: application/json

{"messages": [...]}
```

#### New Request Header: `Stream-Signed-URL-TTL`

Optional header specifying the TTL in seconds for the generated signed URL.

**Header Format:**

```
Stream-Signed-URL-TTL: <seconds>
```

**Server Behavior:**

- If provided, the server uses this value as the expiry duration for the signed URL it generates.
- Default: server-configured (implementation-defined).
- Servers MAY enforce a maximum TTL, clamping to the maximum rather than rejecting the request.

#### Header-Based Dispatch

All write operations use `POST /v1/proxy`. The proxy determines the operation by checking headers in priority order:

| Header Present                          | Operation   |
| --------------------------------------- | ----------- |
| `Use-Stream-URL`                        | **Append**  |
| `Session-Id` (without `Use-Stream-URL`) | **Connect** |
| None of the above                       | **Create**  |

Headers are checked in this order. For example, a request with both `Session-Id` and `Use-Stream-URL` is an **append** (not a connect), because `Use-Stream-URL` takes priority.

#### Server Validation (Append)

When `Use-Stream-URL` header is present:

1. **Parse URL**: Extract `streamId`, `expires`, and `signature` from the URL
2. **Validate HMAC**: Verify the signature is valid (reject if invalid)
3. **Ignore Expiry**: On write paths, expiry is NOT enforced - only HMAC validity matters
4. **Check Stream Exists**: HEAD request to underlying durable streams server to verify stream exists
5. **Check Stream Open**: Ensure stream is not closed (can still accept writes)
6. **Append**: Use POST (not PUT) to append upstream response to existing stream

**HMAC vs Expiry Validation by Path:**

| Path                                            | HMAC                         | Expiry      |
| ----------------------------------------------- | ---------------------------- | ----------- |
| `POST /v1/proxy` with `Use-Stream-URL` (append) | Validate (reject if invalid) | **Ignore**  |
| `GET /v1/proxy/{id}` (read)                     | Validate (reject if invalid) | **Enforce** |
| `PATCH /v1/proxy/{id}` (abort)                  | Validate (reject if invalid) | **Enforce** |

**Rationale**: On write paths, the real authorization is the upstream accepting the forwarded request. The HMAC proves the client received this URL from the proxy (prior legitimate access). Expiry is irrelevant because the upstream is the authority. On read and abort paths, the signed URL is the sole authorization — both HMAC and expiry must be valid.

#### Connect Operation (`Session-Id` header)

When `POST /v1/proxy` includes a `Session-Id` header (without `Use-Stream-URL`), the proxy performs a **connect** operation. This initializes or reconnects a session by deriving a stream ID, optionally authorizing the client via a developer-provided auth endpoint, and returning a pre-signed URL. Connect does not return a response body — all stream data is read by the client via the pre-signed URL.

This operation serves as both the initial session setup and the mechanism for obtaining fresh signed URLs — when a URL expires, the client simply connects again with the same `Session-Id`.

The proxy always uses the `POST` method when calling the auth endpoint. The `Upstream-Method` header is not used for connect operations.

**Request:**

```
POST /v1/proxy?secret=xxx HTTP/1.1
Session-Id: <session-id>
Upstream-URL: <auth-endpoint-url>       (optional)
Upstream-Authorization: <client-auth>   (optional)
Stream-Signed-URL-TTL: <seconds>        (optional)

{...optional body forwarded to auth endpoint...}
```

**Server behavior:**

1. **Authenticate**: Validate service authentication (existing proxy auth)
2. **Derive Stream ID**: `streamId = UUIDv5(NAMESPACE, sessionId)` — deterministic, stateless, reproducible
3. **Authorize** (if `Upstream-URL` is provided):
   - Forward a POST request to `Upstream-URL` with:
     - `Stream-Id: <derived-stream-id>` header
     - Client's original auth headers (e.g., `Authorization` via `Upstream-Authorization`)
     - Original request body
   - If auth endpoint returns non-2xx: return `401 Unauthorized` with `CONNECT_REJECTED`
4. **Ensure Stream Exists**: Check if stream exists; create it if not
5. **Generate URL**: Generate a fresh pre-signed URL for the stream
6. **Return**: Return the signed URL to the client

**Response (`200 OK` for existing session, `201 Created` for new session):**

```
HTTP/1.1 201 Created
Location: <fresh-pre-signed-stream-url>
```

- **`201 Created`** when the stream was newly created, **`200 OK`** when reconnecting to an existing stream.
- **`Location`**: A fresh pre-signed URL for the stream.
- **No response body**.

##### Auth Endpoint Contract

The developer-provided auth endpoint (the `Upstream-URL` for connect operations) is responsible for deciding whether the client is allowed to access this session. The proxy calls it with a `POST` request containing:

- The client's auth headers (e.g., `Authorization` via `Upstream-Authorization`)
- A `Stream-Id` header identifying the durable stream
- The original request body (if any)

The auth endpoint returns:

- **2xx**: Approved — proxy generates a signed URL
- **Non-2xx**: Rejected — proxy returns `401 Unauthorized` with `CONNECT_REJECTED` to the client

The auth endpoint's response body is discarded by the proxy. Only the status code matters.

Implementers **SHOULD NOT** return `200` unconditionally from their auth endpoint. The auth endpoint is the developer's opportunity to revoke access to a session. An auth endpoint that always approves effectively grants permanent access, regardless of the signed URL's expiration.

If `Upstream-URL` is omitted, the proxy trusts service authentication alone (suitable for simple deployments without user-level authorization).

#### Response Codes

| Status             | Condition                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `200 OK`           | Append: response appended to existing stream. Connect: existing session reconnected. Fresh signed URL in `Location`. |
| `201 Created`      | Create: new stream created. Connect: new session initialized. Fresh signed URL in `Location`.                        |
| `400 Bad Request`  | `Use-Stream-URL` header malformed                                                                                    |
| `401 Unauthorized` | HMAC signature invalid (expired HMAC is accepted on write paths), or auth endpoint rejected the request (connect)    |
| `404 Not Found`    | Specified stream does not exist                                                                                      |
| `409 Conflict`     | Stream has been closed (via the base protocol) and cannot accept new data (`STREAM_CLOSED`, append only)             |

#### Response Headers

On successful create (`201 Created`), append (`200 OK`), and connect (`201 Created` / `200 OK`):

```
Location: <fresh-pre-signed-url>
Upstream-Content-Type: <content-type>   (create and append only)
Stream-Response-Id: <response-id>      (create and append only)
```

The server MUST return a fresh pre-signed URL in the `Location` header on every response. The TTL clock starts at response time. This ensures that active sessions automatically have their read tokens extended on every successful operation.

The `Upstream-Content-Type` and `Stream-Response-Id` headers are only returned on create and append responses (where an upstream request was made). They are not returned on connect responses. The `Stream-Response-Id` contains the numeric response ID assigned to the upstream response within the stream, enabling clients to associate a `requestId` with a specific response for idempotent retry.

#### Read Path Error Response for Expired URLs

When a `GET /v1/proxy/{id}` request fails due to an expired (but HMAC-valid) signature, the response includes structured information:

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": {
    "code": "SIGNATURE_EXPIRED",
    "message": "Pre-signed URL has expired",
    "renewable": true,
    "streamId": "<stream-id>"
  }
}
```

The `renewable` field indicates whether the client can obtain a fresh URL:

- **`true`** for streams created via a `Session-Id` (connect) — client can reconnect via `POST /v1/proxy` with `Session-Id` to obtain a fresh URL
- **`false`** for streams created without a `Session-Id` — client has no mechanism to obtain a fresh URL

This distinguishes between three failure modes:

- **Expired and renewable**: Valid HMAC, expired timestamp — client can reconnect via `POST /v1/proxy` with `Session-Id`
- **Expired but not renewable**: Valid HMAC, expired timestamp — no recovery possible
- **Invalid**: Bad HMAC — no recovery possible, return `SIGNATURE_INVALID`

The client uses this signal to trigger auto-renewal if a `connectUrl` is configured.

### Binary Framing Format

All data written to proxy streams uses a binary framing format. Each upstream response is encapsulated as a sequence of frames carrying a response ID, enabling multiple responses to be multiplexed onto a single stream and reconstructed independently by readers. The full specification is in the [Proxy Protocol Specification](../../packages/proxy/PROXY_PROTOCOL.md) Section 5.

**Frame structure** — every frame has a fixed 9-byte header followed by a variable-length payload:

```
┌──────────┬─────────────────┬────────────────────┬─────────────────┐
│ Type     │ Response ID     │ Payload Length      │ Payload         │
│ (1 byte) │ (4 bytes, BE)   │ (4 bytes, BE)      │ (variable)      │
└──────────┴─────────────────┴────────────────────┴─────────────────┘
```

**Frame types:**

| Type     | Byte   | ASCII | Payload            | Description                                  |
| -------- | ------ | ----- | ------------------ | -------------------------------------------- |
| Start    | `0x53` | `S`   | JSON object        | Upstream response metadata (status, headers) |
| Data     | `0x44` | `D`   | Raw bytes          | Upstream response body chunk                 |
| Complete | `0x43` | `C`   | Empty (length `0`) | Response completed successfully              |
| Abort    | `0x41` | `A`   | Empty (length `0`) | Response was aborted by the client           |
| Error    | `0x45` | `E`   | JSON object        | Response failed due to an error              |

**Response lifecycle**: `Start (S) → Data (D)* → Complete (C) | Abort (A) | Error (E)`

Response IDs are assigned sequentially starting from `1`. The framing applies to all proxy streams, so the format is consistent regardless of whether the stream contains one response or many.

**Key design decisions:**

- ASCII type bytes (inspired by PostgreSQL's wire protocol) for human-readable debugging
- 4-byte response IDs (future-proof for long-running sessions)
- Always-present payload length (even for empty payloads) for uniform parsing
- Start frame carries status + headers as JSON for easy cross-language parsing
- Data frames carry raw bytes (not JSON-wrapped) for zero-copy efficiency

### Storage Changes

Storage is used for client-side `requestId` → `responseId` mappings, enabling idempotent retry without duplicate upstream calls. Two key formats are used:

**Session usage (`createDurableProxySession`):**

```
{storagePrefix}{proxyUrl}:{sessionId}:{requestId} → { responseId: number }
```

The session itself holds `streamUrl` in memory (obtained via `connect()`). Only the `requestId` mappings are persisted to storage.

**One-off usage (`createDurableFetch`):**

```
{storagePrefix}{proxyUrl}::{requestId} → { responseId: number, streamUrl: string }
```

Since there is no session, the `streamUrl` is stored alongside the `responseId` so the client can read the response without a connect step. The double colon (`::`) indicates the absence of a `sessionId`.

The client does not proactively track URL expiry — it reacts to `401` responses with `renewable: true` on the read path and auto-renews via `connect()` when possible.

### Session Lifecycle

```
1. Connect   → POST /v1/proxy (Session-Id header)      → signed URL
2. Subscribe → GET signed-url                           → SSE stream
3. Send      → POST /v1/proxy (Use-Stream-URL header)   → fresh URL
4. Reconnect → POST /v1/proxy (Session-Id header)       → fresh URL (same as step 1)
```

Stream closure is not managed by the proxy protocol — each response has its own terminal frame, so readers always know when a response is complete. Closing or deleting a stream is an application-level concern. Clients can use the base Durable Streams Protocol to close a stream when it is no longer needed, or delete it via the proxy's DELETE operation.

### Client Flow

#### `session.fetch(url, options)` Flow

```
session.fetch(url, { requestId, body })
         │
         ▼
┌───────────────────────────┐
│ session.streamUrl exists? │
└───────────────────────────┘
       │           │
      YES          NO
       │           │
       │           ▼
       │  ┌───────────────────┐
       │  │ session.connect() │
       │  │ → signed URL      │
       │  └───────────────────┘
       │           │
       ▼           ▼
┌───────────────────────────┐
│ requestId provided?       │
└───────────────────────────┘
       │           │
      YES          NO
       │           │
       ▼           │
┌───────────────────────────┐
│ Check storage for         │
│ requestId → responseId    │
└───────────────────────────┘
       │           │
    FOUND       NOT FOUND
       │           │
       ▼           │
┌──────────────────┐  │
│ SKIP POST        │  │
│ Read responseId  │  │
│ from stream via  │  │
│ demultiplexer    │  │
└──────────────────┘  │
       │              │
       │              ▼
       │  ┌───────────────────────────┐
       │  │ POST to proxy with        │
       │  │ Use-Stream-URL (append)   │
       │  │ ← Stream-Response-Id hdr  │
       │  │ ← Location hdr            │
       │  └───────────────────────────┘
       │              │
       │              ▼
       │  ┌───────────────────────────┐
       │  │ Store requestId →         │
       │  │ { responseId } if         │
       │  │ requestId was provided    │
       │  └───────────────────────────┘
       │              │
       └──────┬───────┘
              ▼
┌───────────────────────────────┐
│ Read demultiplexed response   │
│ for this responseId from the  │
│ stream → return ProxyResponse │
└───────────────────────────────┘
```

#### `session.responses()` Flow

```
session.responses()
         │
         ▼
┌───────────────────────────┐
│ session.streamUrl exists? │
└───────────────────────────┘
       │           │
      YES          NO
       │           │
       │           ▼
       │  ┌───────────────────┐
       │  │ session.connect() │
       │  │ → signed URL      │
       │  └───────────────────┘
       │           │
       ▼           ▼
┌───────────────────────────────┐
│ GET signed URL (SSE live)     │
│ → raw framed byte stream      │
└───────────────────────────────┘
         │
         ▼
┌───────────────────────────────┐
│ Frame demultiplexer:          │
│ Parse S/D/C/A/E frames,      │
│ yield ProxyResponse on each   │
│ Start frame (concurrent)      │
└───────────────────────────────┘
```

#### Shared Demuxer Architecture

A `DurableProxySession` maintains a single SSE connection to the durable stream and a shared frame demultiplexer. Both `session.fetch()` and `session.responses()` consume from this shared demuxer, not from separate connections.

```
                   ┌──────────────────────────────────────┐
                   │        DurableProxySession           │
                   │                                      │
                   │  ┌──────────────────────────────┐    │
                   │  │ Single SSE connection         │    │
                   │  │ GET {streamUrl}?live=sse      │    │
                   │  └──────────┬───────────────────┘    │
                   │             │ raw framed bytes       │
                   │             ▼                        │
                   │  ┌──────────────────────────────┐    │
                   │  │ Shared Frame Demultiplexer    │    │
                   │  │ Parses S/D/C/A/E frames,     │    │
                   │  │ creates one ProxyResponse per │    │
                   │  │ response lifecycle            │    │
                   │  └──────────┬───────────────────┘    │
                   │             │                        │
                   │             │ same ProxyResponse     │
                   │             │ object instance        │
                   │         ┌───┴───┐                    │
                   │         │       │                    │
                   │         ▼       ▼                    │
                   │     fetch()  responses()             │
                   │     (by ID)  (all)                   │
                   └──────────────────────────────────────┘
```

**How it works:**

- The demuxer reads frames sequentially from the single underlying stream.
- When a Start frame arrives, the demuxer constructs a single `ProxyResponse` object for that response ID. The `ProxyResponse` body is an independent `ReadableStream` backed by a per-response buffer. Subsequent Data frames for that response ID are routed to this buffer.
- `session.responses()` yields each `ProxyResponse` immediately when its Start frame is parsed — it does not wait for the response to complete. Multiple responses can be in flight concurrently, with their frames interleaved on the stream.
- `session.fetch()` awaits the `ProxyResponse` for the specific response ID it triggered (returned via the `Stream-Response-Id` header after the append POST).

**Same object, no duplication:**

When both `fetch()` and `responses()` are active, the demuxer creates exactly one `ProxyResponse` per response lifecycle. The **same object instance** is both returned from `session.fetch()` and yielded by `session.responses()`. Since both references point to the same `Response` object:

- There is only one `body` ReadableStream — the user reads it from whichever reference they prefer.
- `response.bodyUsed` reflects whether the body has been read, regardless of which reference was used.
- No data is duplicated or tee'd. No special null-body handling is needed.

This means the consumer iterating `responses()` can check `response.bodyUsed` to determine whether a `fetch()` call already consumed the body. This is standard `Response` semantics.

**Concurrent `fetch()` calls:**

Multiple concurrent `fetch()` calls are supported — each registers for its own response ID and receives the corresponding `ProxyResponse` when its Start frame arrives.

#### Client Auto-Renewal Behavior

When the client encounters an expired read URL (401 with `renewable: true`):

1. Automatically `POST /v1/proxy` with `Session-Id` header (reconnect)
2. If `connectUrl` is configured, the proxy calls the auth endpoint to verify the client is still authorized
3. On success: update `session.streamUrl` with fresh signed URL, retry the read
4. On failure (auth endpoint rejected): surface error to caller

Session streams can always auto-renew by reconnecting with `Session-Id`. The `connectUrl` is optional — without it, the proxy trusts service authentication alone and the reconnect always succeeds. With `connectUrl`, the auth endpoint provides an opportunity to revoke access.

For non-session streams (created via `createDurableFetch` with no `Session-Id`), the `renewable` field is `false` and there is no auto-renewal mechanism — the expiry error is surfaced to the caller.

This auto-renewal is transparent — both `session.fetch()` and `session.responses()` handle it internally.

### Usage Examples

#### Example 1: Session with Multiple Requests

```typescript
import { createDurableProxySession } from "@durable-streams/proxy/client"

const session = createDurableProxySession({
  proxyUrl: "https://proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  sessionId: "conversation-123",
})

// First request: connects, creates stream, appends response
const res1 = await session.fetch(
  "https://api.openai.com/v1/chat/completions",
  {
    requestId: "turn-1",
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    }),
  }
)

// Read the demultiplexed response body
const reader = res1.body.getReader()
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  // Process chunk (only data for this response, not other responses)
}

// Second request: appends to same stream
const res2 = await session.fetch(
  "https://api.openai.com/v1/chat/completions",
  {
    requestId: "turn-2",
    body: JSON.stringify({ messages: [...], stream: true }),
  }
)
// res2.responseId === 2 (sequential)
```

#### Example 2: Resume After Interruption (requestId)

```typescript
const session = createDurableProxySession({
  proxyUrl: "https://proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  sessionId: "conversation-123",
})

// Request is interrupted mid-stream
const res = await session.fetch(apiUrl, {
  requestId: "turn-2",
  body: JSON.stringify({ messages: [...] }),
})
// ... app crashes while reading res.body ...

// After restart: same session, same requestId
const session2 = createDurableProxySession({
  proxyUrl: "https://proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  sessionId: "conversation-123",
})

// requestId 'turn-2' is found in storage with responseId 2
// Skips POST, reads response 2 from the stream directly
const resRetry = await session2.fetch(apiUrl, {
  requestId: "turn-2",
  body: JSON.stringify({ messages: [...] }),
})
// resRetry.responseId === 2, no duplicate upstream call
```

#### Example 3: Subscribing to All Responses

```typescript
const session = createDurableProxySession({
  proxyUrl: "https://proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  sessionId: "conversation-123",
})

// Subscribe to ALL responses on the stream (history + live)
for await (const response of session.responses()) {
  console.log(
    `Response ${response.responseId}:`,
    response.headers.get("content-type")
  )

  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // Process each response's body independently
  }
}
```

#### Example 4: Connect with Auth Endpoint (Concurrent Read + Write)

```typescript
const session = createDurableProxySession({
  proxyUrl: "https://proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  sessionId: "conversation-123",
  connectUrl: "https://api.example.com/auth/check-access",
})

// Connect — initializes session, authorizes via auth endpoint
await session.connect()
// session.streamUrl is a fresh signed URL

// Subscribe to live updates in a separate async task.
// responses() is a long-lived iterator that follows the stream,
// so it must run concurrently with fetch() calls.
const readTask = (async () => {
  for await (const response of session.responses()) {
    console.log(`Response ${response.responseId}:`, response.status)
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // Process each response's body
    }
  }
})()

// Send messages (appends to the stream) — runs concurrently with readTask
const res = await session.fetch("https://api.openai.com/v1/chat/completions", {
  requestId: "turn-1",
  body: JSON.stringify({
    messages: [{ role: "user", content: "Hello" }],
  }),
})
// res is the demultiplexed response for turn-1 only

// Clean up when done
session.close()
```

#### Example 5: Short TTL with Auto-Renewal

```typescript
const session = createDurableProxySession({
  proxyUrl: "https://proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  sessionId: "conversation-123",
  streamSignedUrlTtl: 300, // 5 minute signed URLs
  connectUrl: "https://api.example.com/auth/check-access",
})

// Signed URLs expire after 5 minutes
// When reading an expired stream, the client automatically:
// 1. POSTs to /v1/proxy with Session-Id header (reconnect)
// 2. The proxy calls api.example.com/auth/check-access
// 3. If the user is still authorized, receives a fresh signed URL
// 4. Retries the read transparently
for await (const response of session.responses()) {
  // Auto-renewal is transparent — the iterator handles reconnects
}
```

#### Example 6: One-Off Request (`createDurableFetch`)

```typescript
import { createDurableFetch } from "@durable-streams/proxy/client"

// Configure once
const durableFetch = createDurableFetch({
  proxyUrl: "https://proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
})

// Each call creates a new stream (no session reuse)
const response = await durableFetch(
  "https://api.openai.com/v1/chat/completions",
  {
    requestId: "req-abc",
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    }),
  }
)

// response.responseId === 1 (always 1 for single-request streams)
const reader = response.body.getReader()
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  // Process chunk
}
```

## Implementation Plan

### Phase 1: Server-Side Changes

#### File: `packages/proxy/src/server/tokens.ts`

Add helper to parse pre-signed URL from header value:

```typescript
interface ParsedPreSignedUrl {
  streamId: string
  expires: string
  signature: string
}

function parsePreSignedUrl(url: string): ParsedPreSignedUrl | null
```

Modify HMAC validation to separate concerns:

- `validateHmac(url)`: Validates signature only, returns boolean
- `validatePreSignedUrl(url)`: Validates signature + expiry, returns validation result

#### File: `packages/proxy/src/server/create-stream.ts`

Modify `handleCreateStream` to:

1. Check for `Use-Stream-URL` header
2. If present:
   - Parse and validate the HMAC (ignore expiry)
   - Verify stream exists (HEAD to durable streams server)
   - Check stream is not closed
   - Skip stream creation (no PUT)
   - Pipe upstream response to existing stream (POST)
   - Return `200 OK` with fresh signed URL in `Location` header and `Stream-Response-Id` header
3. If not present: existing behavior (create new stream, return `201 Created` with `Stream-Response-Id: 1`)

Support `Stream-Signed-URL-TTL` header:

- Pass TTL value to URL generation
- Default: 7 days (604800 seconds)
- Support infinite TTL (no expiry)

#### File: `packages/proxy/src/server/proxy-handler.ts`

Update request dispatch to check headers in priority order:

1. `Use-Stream-URL` present → route to append handler (existing `handleCreateStream` with append logic)
2. `Session-Id` present → route to connect handler
3. None → route to create handler (existing `handleCreateStream`)

#### File: `packages/proxy/src/server/connect-stream.ts` (new)

Add `handleConnectStream` handler:

1. Extract `Session-Id` header
2. Derive `streamId = UUIDv5(NAMESPACE, sessionId)` using `deriveStreamId()` utility
3. If `Upstream-URL` is provided:
   - Forward POST request to `Upstream-URL` with `Stream-Id` header + client auth headers + body
   - If auth endpoint returns non-2xx: return `401 Unauthorized` with `CONNECT_REJECTED`
4. Check if stream exists; create if needed
5. Generate fresh signed URL
6. Return `201 Created` for new sessions, `200 OK` for existing sessions (no response body)

#### File: `packages/proxy/src/server/derive-stream-id.ts` (new)

Add `deriveStreamId(sessionId: string): string` utility:

- Uses UUIDv5 with a fixed namespace UUID
- Deterministic: same session ID always produces same stream ID
- Stateless: no lookup tables or stored mappings

#### File: `packages/proxy/src/server/read-stream.ts`

Update read handler error responses:

- When HMAC is valid but URL is expired, return structured JSON error response with `code: "SIGNATURE_EXPIRED"`
- Set `renewable: true` for streams created via `Session-Id`, `false` for streams created without
- Include `streamId` in the error response for convenience
- Distinguish between "expired" (valid HMAC) and "invalid" (bad HMAC)

### Phase 2: Client-Side Changes

#### File: `packages/proxy/src/client/types.ts`

Replace existing types with the session-based API:

```typescript
// Session options
interface ProxySessionOptions {
  proxyUrl: string
  proxyAuthorization: string
  sessionId: string
  connectUrl?: string
  streamSignedUrlTtl?: number
  storage?: DurableStorage
  storagePrefix?: string
  fetch?: typeof fetch
}

// Per-request options (used by both session.fetch and createDurableFetch)
interface ProxyFetchOptions extends Omit<RequestInit, "method"> {
  method?: string
  requestId?: string
}

// Demultiplexed response — extends standard Fetch API Response
interface ProxyResponse extends Response {
  responseId: number
}

// One-shot wrapper options
interface DurableFetchOptions {
  proxyUrl: string
  proxyAuthorization: string
  storage?: DurableStorage
  storagePrefix?: string
  fetch?: typeof fetch
}

type DurableFetch = (
  url: string | URL,
  options?: ProxyFetchOptions
) => Promise<ProxyResponse>

// Session interface
interface DurableProxySession {
  fetch(url: string | URL, options?: ProxyFetchOptions): Promise<ProxyResponse>
  responses(): AsyncIterable<ProxyResponse>
  connect(): Promise<void>
  readonly streamUrl: string | null
  readonly sessionId: string
  readonly streamId: string // Computed locally from sessionId, available immediately
  abort(): Promise<void> // Aborts ALL active upstream requests for this stream
  close(): void
}
```

#### File: `packages/proxy/src/client/storage.ts`

Update storage functions for the new `requestId` → `responseId` mapping:

```typescript
// Session-scoped requestId storage
function createRequestIdStorageKey(
  prefix: string,
  proxyUrl: string,
  sessionId: string,
  requestId: string
): string

function saveRequestIdMapping(
  storage: DurableStorage,
  prefix: string,
  proxyUrl: string,
  sessionId: string,
  requestId: string,
  responseId: number
): void

function loadRequestIdMapping(
  storage: DurableStorage,
  prefix: string,
  proxyUrl: string,
  sessionId: string,
  requestId: string
): { responseId: number } | null
```

For `createDurableFetch` (no session), use a double-colon key format (`{prefix}{proxyUrl}::{requestId}`) and store both `responseId` and `streamUrl` in the value, since there is no session to derive a stream URL from.

#### File: `packages/proxy/src/client/proxy-session.ts` (new)

Implement `createDurableProxySession`:

1. Manages a single stream for the session lifetime
2. `connect()`: POST with `Session-Id` header, store signed URL
3. `fetch(url, options)`:
   - If no `streamUrl`, call `connect()` first (connect creates the stream)
   - If `requestId` provided, check storage for existing `responseId` mapping
   - If mapping found: skip POST, read that response from the stream (connect first if no `streamUrl`)
   - If not found: POST with `Use-Stream-URL` header (always append — connect already created the stream), read `Stream-Response-Id` from response header, store mapping if `requestId` provided
   - Return `ProxyResponse` by demultiplexing the stream
4. `responses()`: Subscribe to the full stream via GET (SSE), demultiplex frames, yield `ProxyResponse` for each response lifecycle
5. Auto-renewal: on 401 with `renewable: true`, automatically reconnect and retry

#### File: `packages/proxy/src/client/frame-demuxer.ts` (new)

Implement the frame demultiplexer:

1. Parse the binary framing format (S/D/C/A/E frames) from the raw stream
2. On Start frame: construct a single `ProxyResponse` object (extends `Response`) with status, headers from the Start frame payload, and a `ReadableStream` body fed by subsequent Data frames
3. Route the same `ProxyResponse` object to both `fetch()` (by registered response ID) and `responses()` (all responses)
4. On terminal frame (C/A/E): close the response's body stream and signal completion

#### File: `packages/proxy/src/client/durable-fetch.ts`

Rewrite `createDurableFetch` as a thin wrapper:

1. Each call creates a new stream (no `Session-Id`, no `Use-Stream-URL`)
2. POST to proxy, read `Stream-Response-Id` and `Location` from response
3. Read the stream, demultiplex the single response, return `ProxyResponse`
4. If `requestId` provided: check storage first (skip POST if mapping exists), store mapping on POST

### Phase 3: Tests

#### File: `packages/proxy/src/__tests__/stream-reuse.test.ts`

New test file covering:

1. First request creates stream, stores session credentials
2. Second request with same sessionId appends to stream (200 OK)
3. Fresh signed URL returned on every `200` and `201`
4. `Stream-Response-Id` header returned on create and append
5. `Stream-Signed-URL-TTL` respected in generated URLs
6. Expired HMAC accepted on write path when upstream returns 2xx
7. Expired HMAC rejected on read path with `renewable: true` in response
8. Invalid HMAC rejected on all paths
9. Non-existent stream returns 404
10. Resume (requestId) works within session stream — skips POST, reads existing responseId

#### File: `packages/proxy/src/__tests__/connect-stream.test.ts`

New test file covering:

1. First connect creates stream and returns signed URL (`201 Created`)
2. Reconnect to existing session returns signed URL (`200 OK`)
3. Connect with auth endpoint — 2xx approval returns signed URL
4. Connect with auth endpoint — non-2xx rejection returns `401 CONNECT_REJECTED`
5. Connect without auth endpoint (no `Upstream-URL`) — trusts service auth alone
6. Auth endpoint receives `Stream-Id` header and client's auth headers
7. Auth endpoint called before stream creation (reject doesn't leak resources)
8. Deterministic stream ID: same session ID always yields same stream ID
9. Fresh signed URL generated in `Location` header
10. No response body returned on connect
11. Client auto-renewal via reconnect with `connectUrl` configured
12. Client error surfacing without `connectUrl` configured

#### File: `packages/proxy/src/__tests__/proxy-session.test.ts` (new)

New test file covering:

1. `session.fetch()` auto-connects and appends on first call
2. `session.fetch()` appends on subsequent calls (already connected)
3. `session.fetch()` with `requestId` skips POST when mapping exists
4. `session.fetch()` stores `requestId` → `responseId` mapping on POST
5. `session.responses()` yields all responses from the stream
6. `session.connect()` called automatically on first `fetch()`
7. Auto-renewal on expired URLs
8. `session.close()` cleans up subscriptions

### Phase 4: Export Updates

#### File: `packages/proxy/src/client/index.ts`

Export:

- `createDurableProxySession` function
- `createDurableFetch` function
- `ProxySessionOptions`, `ProxyFetchOptions`, `ProxyResponse`, `DurableFetchOptions`, `DurableFetch`, `DurableProxySession` types
- `DurableStorage` interface

## Security Considerations

1. **Authorization Separation**: Write authorization flows through the upstream backend. The proxy does not make authorization decisions for writes - it validates HMAC for proof of prior access and defers to the upstream. Read authorization uses time-limited signed URLs.

2. **Capability-Based Access**: The pre-signed URL acts as a capability token. Possession of a valid HMAC proves the client received this URL from the proxy (prior legitimate access).

3. **Signature Validation**: The `Use-Stream-URL` header value is validated using timing-safe HMAC comparison.

4. **HMAC-Without-Expiry on Writes**: An attacker would need both:
   - A valid HMAC (proving they once received the URL from the proxy)
   - Valid upstream credentials (the upstream must accept their request)

   Both are required. Stream IDs are UUIDs - unguessable.

5. **Auth Endpoint Security**: The auth endpoint used in connect operations is the developer's opportunity to enforce access control decisions (e.g., revoke access to a conversation). Implementers SHOULD NOT return 200 unconditionally from their auth endpoint. An auth endpoint that always approves effectively grants permanent access, regardless of the signed URL's expiration.

6. **No Cross-Tenant Access**: Stream IDs are UUIDs with signed URLs. A client cannot guess or forge access to another client's stream.

7. **Infinite TTL**: When TTL is set to infinite, signed URLs never expire. This is appropriate for trusted environments or when the signed URL is stored securely. The HMAC still prevents forgery. Simple deployments can use long/infinite TTL with no auth endpoint.

8. **Connect Authorization**: The proxy validates service authentication (existing proxy auth) and optionally defers session-level authorization to the auth endpoint. The auth endpoint receives the client's original auth headers and decides whether to permit the session. The auth endpoint's response body is discarded — only the status code matters. This two-layer model (proxy auth + auth endpoint) is consistent with the append path.

9. **Deterministic Stream IDs**: Stream IDs for sessions are derived via UUIDv5 (SHA-1 based). The derivation is one-way — knowing a stream ID does not reveal the session ID. Security does not rely on stream ID unguessability; it relies on HMAC-signed URLs for access control.

## Alternatives Considered

### Alternative 1: Session-to-Stream Mapping on Server

The server could maintain a mapping of `sessionId -> streamId` and accept a simple `Session-Id` header.

**Rejected because:**

- Adds server-side state (violates stateless requirement)
- Requires session cleanup/TTL management
- Less explicit about which stream is being reused

### Alternative 2: Reuse `requestId` for Sessions

Overload `requestId` to serve both purposes with a mode flag.

**Rejected because:**

- Conflates two distinct concepts
- Makes behavior harder to reason about
- Breaking change to existing semantics

### Alternative 3: `Use-Stream-Id` Header (Without Signature)

Send just the stream ID and rely on service JWT for authorization.

**Rejected because:**

- Bypasses capability-based security model
- Any authenticated client could append to any stream
- Less granular access control

### Alternative 4: Separate `/v1/proxy/connect` Endpoint

Add a dedicated endpoint for the connect operation.

**Rejected because:**

- Header-based dispatch on `POST /v1/proxy` is consistent with the existing pattern (append uses `Use-Stream-URL` header, not a separate endpoint)
- Reduces the number of routes the proxy must handle
- Simplifies client configuration (single proxy URL)

### Alternative 5: Client-Side Session→Stream Mapping for Connect

Let the client derive stream IDs and manage the connect flow.

**Rejected because:**

- No cold start support — client cannot derive stream ID without prior state
- Deterministic server-side derivation is stateless and requires no stored mappings
- Centralizing derivation in the proxy ensures consistency across client implementations

### Alternative 6: Separate Renew Operation (`Renew-Stream-URL` header)

Add a dedicated renew operation that validates an expired signed URL's HMAC, forwards to a `renewUrl` for authorization, and returns a fresh signed URL without writing to the stream.

**Rejected because:**

- Connect already serves this purpose — the client reconnects with the same `Session-Id` to obtain a fresh URL
- Adds a fourth operation (renew) when three (create, append, connect) are sufficient
- Requires a separate `renewUrl` client configuration option alongside `connectUrl`
- The auth endpoint in connect handles both initial authorization and re-authorization on the same code path

### Alternative 7: Connect Returns Message History

Have the connect handler return message history in the response body, along with a `Stream-Offset` header for SSE subscription.

**Rejected because:**

- Conflates two concerns: authorization/URL-generation and data delivery
- All stream data should flow through the read path (GET with pre-signed URL) for consistency
- The auth endpoint contract is simpler when it only needs to return a status code
- History materialization is a framework-specific concern better handled outside the proxy protocol

## Resolved Questions

### URL Refresh and Expiry

- The server returns a fresh signed URL on every response (both `200` and `201`).
- TTL is configurable via `Stream-Signed-URL-TTL` header, defaulting to a server-configured value. Servers MAY enforce a maximum TTL.
- On write paths (`POST /v1/proxy` with `Use-Stream-URL`), HMAC is validated but expiry is ignored. Authorization flows through the upstream.
- On read paths (`GET /v1/proxy/{id}`), both HMAC and expiry are enforced. Expired-but-valid-HMAC responses include `renewable: true` (for streams created via `Session-Id`) or `renewable: false` (for streams created without).
- URL renewal uses the connect operation — the client simply reconnects with the same `Session-Id` to obtain a fresh URL. No separate renew operation is needed.
- Client-side: optional `connectUrl` and `streamSignedUrlTtl` configuration. Simple deployments use long TTLs with no auth endpoint. Security-sensitive deployments use short TTL + auth endpoint.

### Header-Based Dispatch

All operations (create, append, connect) use `POST /v1/proxy`. The operation is determined by header presence, checked in priority order: `Use-Stream-URL` → `Session-Id` → none.

### Header Naming

- `Use-Stream-URL` (not `Use-Stream-Url`) — consistent with HTTP convention for acronyms (URL, not Url)
- `Stream-Signed-URL-TTL` (not `X-Stream-TTL`) — descriptive, avoids deprecated `X-` prefix

### Deterministic Stream ID

Stream IDs for session-based operations are derived via UUIDv5 from the session ID using a fixed namespace. For stream-per-request operations (no session), a random UUID is used. This maintains the stateless proxy requirement.

### Stream Closure

Stream closure is not managed by the proxy protocol. Each response has its own terminal frame (Complete, Abort, or Error), so readers always know when a response is complete regardless of the stream's open/closed state. Closing or deleting a stream is an application-level concern — clients can use the base Durable Streams Protocol to close a stream when it is no longer needed.

### Connect vs Renew (Unified)

The original design had a separate `Renew-Stream-URL` operation for obtaining fresh signed URLs. This was unified into the connect operation — when a signed URL expires, the client simply reconnects with the same `Session-Id`. This simplifies the protocol (3 operations instead of 4) and eliminates the need for a separate `renewUrl` client option.

### Connect Does Not Return Body

The original design had the connect handler returning message history in the response body. This was changed so that connect is purely an auth + URL-generation operation with no response body. All stream data is read by the client via the pre-signed URL. This simplifies the connect contract and separates concerns: the auth endpoint decides access, the stream provides data.

### Binary Framing Format

All proxy streams use a binary framing format to encapsulate upstream responses, solving the problem of byte interleaving when multiple responses are written to the same stream. The format uses ASCII type bytes (S/D/C/A/E), 4-byte response IDs, and always-present payload lengths. See the [Proxy Protocol Specification](../../packages/proxy/PROXY_PROTOCOL.md) Section 5 for the full format.

### Session-Based Client API

The original `createDurableFetch` API was designed for single-request streams. With the introduction of multi-request streams and binary framing, the client API was redesigned around sessions:

- `createDurableProxySession` is the primary API for multi-request usage, managing a single durable stream with `fetch()` for sending requests and `responses()` for subscribing to demultiplexed responses.
- `createDurableFetch` is retained as a thin wrapper for one-shot fetch-to-stream usage (no session semantics).
- `requestId` is preserved as a client-side idempotency mechanism that maps to a `responseId` (the framing response number), preventing duplicate upstream calls on retry.
- The `Stream-Response-Id` response header was added to the protocol (Sections 4.2 and 4.3) so the client can associate a `requestId` with the assigned response ID without parsing the stream.

## Open Questions

1. **UUIDv5 Namespace**: What fixed namespace UUID should be used for deriving stream IDs from session IDs? Options include a well-known UUID specific to the durable-streams project or a configurable namespace.

2. **Concurrent Appends**: What happens if two requests try to append to the same stream simultaneously? The underlying durable streams protocol handles this via sequencing, but should the proxy add any coordination? The framing format supports interleaved frames from different response IDs, so concurrent appends are safe at the protocol level.

## References

- `packages/proxy/PROXY_PROTOCOL.md` - The Durable Streams Proxy Protocol specification (authoritative)
- `packages/proxy/src/server/create-stream.ts` - Current stream creation logic
- `packages/proxy/src/server/tokens.ts` - Pre-signed URL generation and validation
- `packages/proxy/src/server/proxy-handler.ts` - Request dispatch logic
- `packages/proxy/src/server/connect-stream.ts` - Connect operation handler (new)
- `packages/proxy/src/server/derive-stream-id.ts` - Deterministic stream ID derivation (new)
- `packages/proxy/src/client/proxy-session.ts` - Session-based client implementation (new)
- `packages/proxy/src/client/frame-demuxer.ts` - Frame demultiplexer for response extraction (new)
- `packages/proxy/src/client/durable-fetch.ts` - One-shot fetch wrapper (rewritten)
- `packages/proxy/src/client/types.ts` - Client type definitions (rewritten)
- `packages/proxy/src/client/storage.ts` - Credential and requestId storage utilities
