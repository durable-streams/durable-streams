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

7. **Resume Compatibility**: The existing `requestId`-based resume mechanism MUST continue to work, including for requests that are part of a session stream.

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

| Concept     | Purpose                                 | Affects                                                                      |
| ----------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `requestId` | Resume reading an interrupted response  | Client-side (skip POST, read from offset)                                    |
| `sessionId` | Group multiple requests into one stream | Server-side (append vs create)                                               |
| `connect`   | Initialize/reconnect a session          | Server-side (derive stream, optionally auth via endpoint, return signed URL) |

They are orthogonal and can be used together.

**Session Lifecycle**: A typical session follows this sequence: **connect** (first operation — initializes the session, optionally authorizes via auth endpoint, returns signed URL) → **subscribe** (GET the signed stream URL — SSE stream for real-time updates) → **send** (append POST — writes new messages to the stream). When a signed URL expires, the client simply **connects** again with the same `Session-Id` to obtain a fresh URL.

### Client API Changes

#### `DurableFetchOptions` (client instantiation)

```typescript
interface DurableFetchOptions {
  // ... existing options ...

  /**
   * Static session ID for stream reuse.
   * All requests made with this client will append to the same stream.
   */
  sessionId?: string

  /**
   * Derive session ID from request parameters.
   * Called for each request to determine the session ID.
   * Takes precedence over static sessionId if both are provided.
   *
   * @param upstreamUrl - The upstream URL being requested
   * @param init - The request options
   * @returns Session ID string, or undefined to create a new stream
   */
  getSessionId?: (
    upstreamUrl: string,
    init?: DurableFetchRequestOptions
  ) => string | undefined

  /**
   * Optional TTL in seconds for signed URLs.
   * Sent as Stream-Signed-URL-TTL header. Server uses this as the expiry
   * duration for generated signed URLs.
   * Default: server-configured (typically 7 days).
   */
  streamSignedUrlTtl?: number

  /**
   * Optional URL for the auth endpoint.
   * When a session connects, the proxy forwards a POST request to this
   * URL with a Stream-Id header. The endpoint authorizes the session
   * by returning 2xx (approved) or non-2xx (rejected). The response
   * body is discarded — only the status code matters.
   *
   * If not configured, the proxy trusts service authentication alone.
   *
   * When a signed URL expires, the client automatically reconnects
   * with the same Session-Id, which re-invokes this auth endpoint
   * to verify the client still has access before issuing a fresh URL.
   */
  connectUrl?: string
}
```

#### `DurableFetchRequestOptions` (per-request)

```typescript
interface DurableFetchRequestOptions {
  // ... existing options ...

  /**
   * Override session ID for this specific request.
   * Takes precedence over client-level sessionId/getSessionId.
   * Set to undefined to explicitly create a new stream.
   */
  sessionId?: string
}
```

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

#### Response Headers

On successful create (`201 Created`), append (`200 OK`), and connect (`201 Created` / `200 OK`):

```
Location: <fresh-pre-signed-url>
Upstream-Content-Type: <content-type>   (create and append only)
```

The server MUST return a fresh pre-signed URL in the `Location` header on every response. The TTL clock starts at response time. This ensures that active sessions automatically have their read tokens extended on every successful operation.

The `Upstream-Content-Type` header is only returned on create and append responses (where an upstream request was made). It is not returned on connect responses.

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

Two storage key patterns:

```typescript
// Session storage: stream URL shared across requests in a session
`{prefix}session:{scope}:{sessionId}` → SessionCredentials

// Request storage: per-request resume point (existing, with modifications)
`{prefix}{scope}:{requestId}` → StreamCredentials
```

#### Type: `SessionCredentials`

```typescript
interface SessionCredentials {
  /** The pre-signed stream URL (may be expired - still valid for writes) */
  streamUrl: string
  /** The stream ID */
  streamId: string
}
```

The client doesn't need to proactively track expiry - it reacts to 401 responses from the read path.

The existing `StreamCredentials` remains unchanged and continues to store per-request resume state including `offset`.

### Session Lifecycle

```
1. Connect   → POST /v1/proxy (Session-Id header)      → signed URL
2. Subscribe → GET signed-url                           → SSE stream
3. Send      → POST /v1/proxy (Use-Stream-URL header)   → fresh URL
4. Reconnect → POST /v1/proxy (Session-Id header)       → fresh URL (same as step 1)
```

Stream closure is not managed by the proxy protocol — each response has its own terminal frame, so readers always know when a response is complete. Closing or deleting a stream is an application-level concern. Clients can use the base Durable Streams Protocol to close a stream when it is no longer needed, or delete it via the proxy's DELETE operation.

### Client Flow

```
durableFetch(url, { requestId, sessionId, body })
                    │
                    ▼
       ┌───────────────────────────┐
       │ Resolve sessionId:        │
       │ 1. init.sessionId         │
       │ 2. getSessionId(url,init) │
       │ 3. options.sessionId      │
       └───────────────────────────┘
                    │
                    ▼
       ┌───────────────────────────┐
       │ connectUrl configured     │
       │ && no session credentials?│
       └───────────────────────────┘
              │           │
             YES          NO
              │           │
              ▼           │
    ┌──────────────────┐  │
    │ POST /v1/proxy   │  │
    │ Session-Id hdr   │  │
    │ (connect)        │  │
    │ → signed URL     │  │
    └──────────────────┘  │
              │           │
              ▼           ▼
       ┌───────────────────────────┐
       │ requestId credentials     │
       │ exist?                    │
       └───────────────────────────┘
              │           │
             YES          NO
              │           │
              ▼           ▼
    ┌──────────────┐  ┌───────────────────────────┐
    │ SKIP POST    │  │ sessionId credentials     │
    │ Resume read  │  │ exist?                    │
    │ from offset  │  └───────────────────────────┘
    │ (existing)   │         │           │
    └──────────────┘        YES          NO
                             │           │
                             ▼           ▼
                   ┌──────────────┐  ┌──────────────┐
                   │ POST with    │  │ POST without │
                   │ Use-Stream-  │  │ URL header   │
                   │ URL header   │  │ (create new) │
                   │ → 200 OK     │  │ → 201 Created│
                   └──────────────┘  └──────────────┘
                             │           │
                             └─────┬─────┘
                                   ▼
                   ┌───────────────────────────────┐
                   │ Store/update credentials:     │
                   │ - Session: streamUrl          │
                   │ - Request: streamUrl + offset │
                   └───────────────────────────────┘
                                   │
                                   ▼
                   ┌───────────────────────────────┐
                   │ Read from stream using        │
                   │ @durable-streams/client       │
                   └───────────────────────────────┘
```

#### Client Auto-Renewal Behavior

When the client encounters an expired read URL (401 with `renewable: true`):

1. **If `connectUrl` is configured and `sessionId` is available:**
   - Automatically `POST /v1/proxy` with `Session-Id` header and `connectUrl` as `Upstream-URL` (reconnect)
   - On success: update stored session credentials with fresh signed URL, retry the read
   - On failure: surface error to caller (auth endpoint rejected — user no longer authorized)

2. **If `connectUrl` is not configured or stream is not session-based:**
   - Surface the expiry error to the caller

This auto-renewal is transparent to the consumer reading the stream.

### Usage Examples

#### Example 1: Static Session ID

```typescript
const durableFetch = createDurableFetch({
  proxyUrl: 'https://proxy.example.com/v1/proxy',
  proxyAuthorization: 'service-secret',
  sessionId: 'conversation-123',  // All requests use this session
})

// First request: creates stream, stores session credentials
const res1 = await durableFetch('https://api.openai.com/v1/chat/completions', {
  requestId: 'turn-1',
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
})

// Second request: appends to same stream
const res2 = await durableFetch('https://api.openai.com/v1/chat/completions', {
  requestId: 'turn-2',
  body: JSON.stringify({ messages: [...] }),
})

// Both responses read from the same stream
// A consumer following res1.streamUrl sees all responses in sequence
```

#### Example 2: Derived Session ID

```typescript
const durableFetch = createDurableFetch({
  proxyUrl: 'https://proxy.example.com/v1/proxy',
  proxyAuthorization: 'service-secret',
  getSessionId: (url, init) => {
    // Extract conversation ID from request body
    const body = JSON.parse(init?.body as string)
    return body.conversationId
  },
})

// Session ID derived from each request's body
await durableFetch(apiUrl, {
  body: JSON.stringify({ conversationId: 'conv-456', messages: [...] }),
})
```

#### Example 3: Resume After Interruption

```typescript
// Request 2 is interrupted mid-stream
const res2 = await durableFetch(apiUrl, {
  requestId: 'turn-2',
  sessionId: 'conversation-123',
  body: JSON.stringify({ messages: [...] }),
})
// ... connection drops ...

// Retry - requestId credentials exist, so we SKIP POST and resume reading
const res2Retry = await durableFetch(apiUrl, {
  requestId: 'turn-2',
  sessionId: 'conversation-123',
  body: JSON.stringify({ messages: [...] }),
})
// res2Retry.wasResumed === true
// Continues reading from stored offset, no new POST made
```

#### Example 4: Override Session Per-Request

```typescript
const durableFetch = createDurableFetch({
  proxyUrl: "...",
  proxyAuthorization: "...",
  sessionId: "default-session",
})

// Uses default session
await durableFetch(apiUrl, { body: "..." })

// Override: create new stream (no session reuse)
await durableFetch(apiUrl, {
  sessionId: undefined, // Explicitly no session
  body: "...",
})

// Override: use different session
await durableFetch(apiUrl, {
  sessionId: "other-session",
  body: "...",
})
```

#### Example 5: Short TTL with Auto-Renewal

```typescript
const durableFetch = createDurableFetch({
  proxyUrl: "https://proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  sessionId: "conversation-123",
  streamSignedUrlTtl: 300, // 5 minute signed URLs
  connectUrl: "https://api.example.com/auth/check-access",
})

// Signed URLs expire after 5 minutes of inactivity
// When reading an expired stream, the client automatically:
// 1. POSTs to /v1/proxy with Session-Id header (reconnect)
// 2. The proxy forwards to api.example.com/auth/check-access
// 3. If the user is still authorized, receives a fresh signed URL
// 4. Retries the read transparently
```

#### Example 6: Session with Connect

```typescript
const durableFetch = createDurableFetch({
  proxyUrl: "https://proxy.example.com/v1/proxy",
  proxyAuthorization: "service-secret",
  sessionId: "conversation-123",
  connectUrl: "https://api.example.com/auth/check-access",
})

// 1. Connect — initializes session, authorizes via auth endpoint, returns signed URL
const connectRes = await durableFetch.connect()
// connectRes.streamUrl is a fresh signed URL
// No response body — all data comes from reading the stream

// 2. Subscribe — read live updates via SSE
const stream = await durableFetch.subscribe()

// 3. Send — append a new message to the stream
const sendRes = await durableFetch(
  "https://api.openai.com/v1/chat/completions",
  {
    requestId: "turn-1",
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
  }
)
// sendRes.streamUrl is a fresh signed URL (extended TTL)
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
   - Return `200 OK` with fresh signed URL in `Location` header
3. If not present: existing behavior (create new stream, return `201 Created`)

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

1. Update `SessionCredentials` interface (remove `expiresAtSecs`)
2. Add `streamSignedUrlTtl` and `connectUrl` to `DurableFetchOptions`

#### File: `packages/proxy/src/client/storage.ts`

Add session credential storage functions:

```typescript
function createSessionStorageKey(
  prefix: string,
  scope: string,
  sessionId: string
): string
function saveSessionCredentials(
  storage,
  prefix,
  scope,
  sessionId,
  credentials
): void
function loadSessionCredentials(
  storage,
  prefix,
  scope,
  sessionId
): SessionCredentials | null
function removeSessionCredentials(storage, prefix, scope, sessionId): void
```

#### File: `packages/proxy/src/client/durable-fetch.ts`

Modify `createDurableFetch` to:

1. Accept `sessionId`, `getSessionId`, `streamSignedUrlTtl`, and `connectUrl` options
2. Send `Stream-Signed-URL-TTL` header when `streamSignedUrlTtl` is configured
3. Resolve effective sessionId for each request (priority: request > getSessionId > options)
4. Before making POST:
   - Check requestId credentials (existing resume path)
   - Check sessionId credentials
   - If session credentials exist, add `Use-Stream-URL` header
5. After successful response:
   - Store/update session credentials (streamUrl, streamId only)
   - Store request credentials (with current offset as starting point)
6. Add auto-renewal logic:
   - Intercept 401 on reads
   - Check for `renewable: true` in response
   - If `connectUrl` configured and `sessionId` available, POST `/v1/proxy` with `Session-Id` header (reconnect)
   - Update stored credentials with fresh URL
   - Retry the read

### Phase 3: Tests

#### File: `packages/proxy/src/__tests__/stream-reuse.test.ts`

New test file covering:

1. First request creates stream, stores session credentials
2. Second request with same sessionId appends to stream (200 OK)
3. Fresh signed URL returned on every `200` and `201`
4. `Stream-Signed-URL-TTL` respected in generated URLs
5. Expired HMAC accepted on write path when upstream returns 2xx
6. Expired HMAC rejected on read path with `renewable: true` in response
7. Invalid HMAC rejected on all paths
8. Non-existent stream returns 404
9. Resume (requestId) works within session stream
10. Mixed session/non-session requests
11. Session override per-request
12. getSessionId derivation

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

### Phase 4: Export Updates

#### File: `packages/proxy/src/client/index.ts`

Export new types:

- `SessionCredentials`

No new function exports needed - session handling is internal to `createDurableFetch`.

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
- `packages/proxy/src/client/durable-fetch.ts` - Current client implementation
- `packages/proxy/src/client/storage.ts` - Credential storage utilities
