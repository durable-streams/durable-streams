# RFC 0001: Proxy Stream Reuse

**Status:** Draft
**Created:** 2026-02-01
**Package:** `@durable-streams/proxy`

## Summary

This RFC proposes adding stream reuse and session management capabilities to the proxy package. It specifies four operations — **create**, **append**, **connect**, and **renew** — all dispatched via `POST /v1/proxy` using header-based routing. This enables session-based streaming where a client can initialize a session (connect), consume and resume a single stream across an entire conversation (append), and maintain read access through URL renewal (renew).

## Requirements

### Functional Requirements

1. **Stream Reuse**: The proxy server MUST support appending upstream responses to an existing stream instead of always creating a new stream.

2. **Session Identification**: The client MUST be able to specify a session identifier that groups multiple requests into a single stream.

3. **Connect Operation**: The proxy MUST support a connect operation that derives a stream ID deterministically from a session ID, ensures the stream exists, proxies the request to a developer-provided connect handler (upstream), and returns the origin's response body along with a signed stream URL and current offset.

4. **Deterministic Stream IDs**: When a `Session-Id` is provided, the stream ID MUST be derived deterministically from the session ID (e.g., UUIDv5 with a fixed namespace). This MUST be stateless and reproducible — the same session ID always yields the same stream ID.

5. **Header-Based Dispatch**: All write operations MUST be dispatched via `POST /v1/proxy` using header presence to determine the operation (create, append, connect, or renew).

6. **Backward Compatibility**: The default behavior MUST remain unchanged - each request creates a new stream unless stream reuse is explicitly requested.

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
- Initialize a session (connect, authorize, hydrate message history) or derive a stream ID from a session identity

## Proposal

### New Concept: `sessionId`

Introduce `sessionId` as a distinct concept from `requestId`:

| Concept     | Purpose                                 | Affects                                                               |
| ----------- | --------------------------------------- | --------------------------------------------------------------------- |
| `requestId` | Resume reading an interrupted response  | Client-side (skip POST, read from offset)                             |
| `sessionId` | Group multiple requests into one stream | Server-side (append vs create)                                        |
| `connect`   | Initialize/reconnect a session          | Server-side (derive stream, proxy to connect handler, return history) |

They are orthogonal and can be used together.

**Session Lifecycle**: A typical session follows this sequence: **connect** (first operation — initializes the session, returns message history and stream URL) → **subscribe** (GET the signed stream URL with offset — SSE stream for real-time updates) → **send** (append POST — writes new messages to the stream).

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
   * Optional URL for the connect handler (origin endpoint).
   * When a session connects, the proxy forwards the request to this URL
   * with a Stream-Id header. The handler authorizes the session, reads
   * the raw stream to materialize message history, and returns the
   * history body + optional Stream-Offset header.
   */
  connectUrl?: string

  /**
   * Optional URL for renewing expired signed URLs.
   * When a read URL expires, the client will POST /v1/proxy with
   * Renew-Stream-URL header, using this as the Upstream-URL to obtain
   * a fresh signed URL. The endpoint must accept the client's auth
   * headers and return 2xx if the client is still authorized.
   *
   * If not configured, expired URLs surface as errors to the caller.
   */
  renewUrl?: string
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
- Default: 7 days (604800 seconds), configurable server-side.
- No server-enforced ceiling - infinite TTL is supported by setting to `0` or omitting entirely when the server default is infinite.

#### Header-Based Dispatch

All write operations use `POST /v1/proxy`. The proxy determines the operation by checking headers in priority order:

| Header Present                          | Operation   |
| --------------------------------------- | ----------- |
| `Renew-Stream-URL`                      | **Renew**   |
| `Use-Stream-URL`                        | **Append**  |
| `Session-Id` (without `Use-Stream-URL`) | **Connect** |
| None of the above                       | **Create**  |

Headers are checked in this order. For example, a request with both `Session-Id` and `Use-Stream-URL` is an **append** (not a connect), because `Use-Stream-URL` is checked first.

#### Server Validation (Append)

When `Use-Stream-URL` header is present:

1. **Parse URL**: Extract `streamId`, `expires`, and `signature` from the URL
2. **Validate HMAC**: Verify the signature is valid (reject if invalid)
3. **Ignore Expiry**: On write paths, expiry is NOT enforced - only HMAC validity matters
4. **Check Stream Exists**: HEAD request to underlying durable streams server to verify stream exists
5. **Check Stream Open**: Ensure stream is not closed (can still accept writes)
6. **Append**: Use POST (not PUT) to append upstream response to existing stream

**HMAC vs Expiry Validation by Path:**

| Path                                             | HMAC                         | Expiry      |
| ------------------------------------------------ | ---------------------------- | ----------- |
| `POST /v1/proxy` with `Use-Stream-URL` (append)  | Validate (reject if invalid) | **Ignore**  |
| `POST /v1/proxy` with `Renew-Stream-URL` (renew) | Validate (reject if invalid) | **Ignore**  |
| `GET /v1/proxy/{id}` (read)                      | Validate (reject if invalid) | **Enforce** |

**Rationale**: On write and renew paths, the real authorization is the upstream accepting the forwarded request. The HMAC proves the client received this URL from the proxy (prior legitimate access). Expiry is irrelevant because the upstream is the authority. On read paths, the signed URL is the sole authorization - both HMAC and expiry must be valid.

#### Connect Operation (`Session-Id` header)

When `POST /v1/proxy` includes a `Session-Id` header (without `Use-Stream-URL` or `Renew-Stream-URL`), the proxy performs a **connect** operation. This initializes or reconnects a session by deriving a stream, proxying to the developer's connect handler, and returning message history.

**Request:**

```
POST /v1/proxy?secret=xxx HTTP/1.1
Session-Id: <session-id>
Upstream-URL: <connect-handler-url>
Authorization: <client's upstream auth headers>
Content-Type: application/json

{...optional body...}
```

**Server behavior:**

1. **Authenticate**: Validate service JWT (existing proxy auth)
2. **Derive Stream ID**: `streamId = UUIDv5(sessionId, FIXED_NAMESPACE)` — deterministic, stateless, reproducible
3. **Ensure Stream Exists**: HEAD request to check stream existence; PUT to create if needed
4. **Forward to Connect Handler**: Forward the request to `Upstream-URL` with:
   - `Stream-Id: <derived-stream-id>` header
   - Client's original auth headers (e.g., `Authorization`)
   - Original request body
5. **Origin Processes**: The connect handler authorizes the session, reads the raw stream to materialize messages, and returns:
   - Response body (message history)
   - Optional `Stream-Offset` header (byte offset for SSE subscription)
6. **Proxy Returns**: Origin's response body + proxy-added headers

**Response (`200 OK` for existing session, `201 Created` for new session):**

```
HTTP/1.1 200 OK
Location: <fresh-pre-signed-stream-url>
Stream-Offset: <byte-offset>
Upstream-Content-Type: <content-type>

{...origin response body (message history)...}
```

**Key distinction from create/append**: The connect operation returns the **origin's response body** (message history) to the client. In create/append, the upstream body is piped to the stream — the client reads it via SSE. In connect, the body goes directly to the client.

##### Connect Handler Contract

The developer-provided connect handler (the `Upstream-URL` for connect operations) receives the forwarded request and is responsible for:

- **Input**: Receives the original client request with an additional `Stream-Id` header identifying the durable stream
- **Authorization**: Validates the client's credentials and determines whether the session is permitted
- **History Materialization**: Reads the raw durable stream (using the stream ID) and materializes it into a response body (e.g., message history in the AI framework's format)
- **Output**: Returns:
  - Response body containing message history (format is opaque to the proxy — framework-specific)
  - Optional `Stream-Offset` header indicating the byte offset for SSE subscription
- **Rejection**: Returns non-2xx status to reject the connect (proxy forwards the status to the client)

Framework-aware helpers for parsing the raw stream into messages are out of scope for this RFC (referenced only as a concern for individual framework integrations).

#### Renew Operation (`Renew-Stream-URL` header)

When `POST /v1/proxy` includes a `Renew-Stream-URL` header, the proxy performs a **renew** operation. This allows clients to obtain a fresh signed URL for an existing stream without producing a write. This is for re-activating read access when the signed URL has expired and the client doesn't have a pending real request to make.

**Request:**

```
POST /v1/proxy?secret=xxx HTTP/1.1
Renew-Stream-URL: <stream-url-with-valid-hmac>
Upstream-URL: <renewUrl>
Authorization: <client's upstream auth headers>
```

**Server behavior:**

1. Validate HMAC on stream URL (ignore expiry)
2. Forward request to `Upstream-URL` (the renewUrl) with client's auth headers
3. Upstream returns 2xx → generate fresh signed URL for the stream → return it
4. Upstream returns 4xx → return `401 Unauthorized`

**No stream writes. No body piping.** The renewUrl response body is discarded by the proxy. This is a pure auth-check → re-sign operation.

**Response (`200 OK`):**

```
HTTP/1.1 200 OK
Location: <fresh-pre-signed-stream-url>
```

**Important**: The user's renewUrl handler should perform a real authorization check (e.g., "does this user still have access to this conversation"), not just return 200 unconditionally. The renewUrl is the user's opportunity to revoke access.

#### Response Codes

| Status             | Condition                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200 OK`           | Append: response appended to existing stream. Connect: existing session reconnected. Renew: fresh URL generated. Fresh signed URL in `Location`. |
| `201 Created`      | Create: new stream created. Connect: new session initialized. Fresh signed URL in `Location`.                                                    |
| `400 Bad Request`  | `Use-Stream-URL` or `Renew-Stream-URL` header malformed, or `Session-Id` provided without required `Upstream-URL`                                |
| `401 Unauthorized` | HMAC signature invalid (not just expired - expired HMAC is accepted on write/renew paths), or upstream rejected the request (renew/connect)      |
| `404 Not Found`    | Specified stream does not exist                                                                                                                  |
| `409 Conflict`     | Stream is closed, cannot append                                                                                                                  |

#### Response Headers (Stream Reuse)

On successful stream reuse (`200 OK`) and new stream creation (`201 Created`):

```
Location: <fresh-pre-signed-url>
Upstream-Content-Type: <content-type>
```

The server MUST return a fresh pre-signed URL on every response (both `200 OK` and `201 Created`). The TTL clock starts at response time. This ensures that active sessions automatically have their read tokens extended on every successful write.

#### Read Path Error Response for Expired URLs

When a `GET /v1/proxy/{id}` request fails due to an expired (but HMAC-valid) signature, the response includes structured information indicating the URL is renewable:

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "expired",
  "message": "Pre-signed URL has expired",
  "renewable": true,
  "streamId": "<stream-id>"
}
```

This distinguishes between:

- **"expired but renewable"**: Valid HMAC, expired timestamp - client can POST `/v1/proxy` with `Renew-Stream-URL` to obtain a fresh URL
- **"invalid"**: Bad HMAC - no recovery possible

The client uses this signal to trigger auto-renewal if a `renewUrl` is configured.

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
1. Connect   → POST /v1/proxy (Session-Id header)      → history + URL + offset
2. Subscribe → GET signed-url?offset=<offset>           → SSE stream
3. Send      → POST /v1/proxy (Use-Stream-URL header)   → fresh URL
4. Renew     → POST /v1/proxy (Renew-Stream-URL header) → fresh URL
```

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
    │ → history + URL  │  │
    │   + offset       │  │
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

1. **If `renewUrl` is configured:**
   - Automatically `POST /v1/proxy` with `Renew-Stream-URL` header (the expired stream URL) and the renewUrl as `Upstream-URL`
   - On success: update stored session credentials with fresh signed URL, retry the read
   - On failure: surface error to caller (upstream rejected - user no longer authorized)

2. **If `renewUrl` is not configured:**
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
  renewUrl: "https://api.example.com/auth/check-access",
})

// Signed URLs expire after 5 minutes of inactivity
// When reading an expired stream, the client automatically:
// 1. POSTs to /v1/proxy with Renew-Stream-URL header
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
  connectUrl: "https://api.example.com/connect",
})

// 1. Connect — initializes session, returns message history
const connectRes = await durableFetch.connect()
// connectRes.body contains message history from origin
// connectRes.streamUrl is a fresh signed URL
// connectRes.offset is the byte offset for subscription

// 2. Subscribe — read live updates via SSE
const stream = await durableFetch.subscribe({
  offset: connectRes.offset,
})

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

1. `Renew-Stream-URL` present → route to renew handler
2. `Use-Stream-URL` present → route to append handler (existing `handleCreateStream` with append logic)
3. `Session-Id` present → route to connect handler
4. None → route to create handler (existing `handleCreateStream`)

#### File: `packages/proxy/src/server/connect-stream.ts` (new)

Add `handleConnectStream` handler:

1. Extract `Session-Id` header
2. Derive `streamId = UUIDv5(sessionId, FIXED_NAMESPACE)` using `deriveStreamId()` utility
3. HEAD to check stream existence; PUT to create if needed
4. Forward request to `Upstream-URL` with `Stream-Id` header + client auth headers
5. If upstream returns 2xx: return origin body + `Location` (fresh signed URL) + `Stream-Offset` + `Upstream-Content-Type`
6. If upstream returns non-2xx: forward the status to the client
7. Return `201 Created` for new sessions, `200 OK` for existing sessions

#### File: `packages/proxy/src/server/derive-stream-id.ts` (new)

Add `deriveStreamId(sessionId: string): string` utility:

- Uses UUIDv5 with a fixed namespace UUID
- Deterministic: same session ID always produces same stream ID
- Stateless: no lookup tables or stored mappings

#### File: `packages/proxy/src/server/renew-stream.ts` (new)

Add `handleRenewStream` handler for `POST /v1/proxy` with `Renew-Stream-URL` header:

1. Parse `Renew-Stream-URL` header, validate HMAC (ignore expiry)
2. Parse `Upstream-URL` header (the renewUrl)
3. Forward request to renewUrl with client's auth headers
4. If upstream returns 2xx: generate fresh signed URL, return 200 with `Location`
5. If upstream returns 4xx: return 401 Unauthorized
6. If stream doesn't exist: return 404 Not Found

#### File: `packages/proxy/src/server/read-stream.ts`

Update read handler error responses:

- When HMAC is valid but URL is expired, return structured JSON response with `renewable: true`
- Distinguish between "expired but renewable" and "invalid HMAC"

### Phase 2: Client-Side Changes

#### File: `packages/proxy/src/client/types.ts`

1. Update `SessionCredentials` interface (remove `expiresAtSecs`)
2. Add `streamSignedUrlTtl`, `connectUrl`, and `renewUrl` to `DurableFetchOptions`

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

1. Accept `sessionId`, `getSessionId`, `streamSignedUrlTtl`, `connectUrl`, and `renewUrl` options
2. Send `Stream-Signed-URL-TTL` header when `streamSignedUrlTtl` is configured
3. Resolve effective sessionId for each request (priority: request > getSessionId > options)
4. Before making POST:
   - Check requestId credentials (existing resume path)
   - Check sessionId credentials
   - If session credentials exist, add `Use-Stream-URL` header
5. After successful response:
   - Store/update session credentials (streamUrl, streamId only)
   - Store request credentials (with current offset as starting point)
6. Handle `409 Conflict` (stream closed) by falling back to new stream creation
7. Add auto-renewal logic:
   - Intercept 401 on reads
   - Check for `renewable: true` in response
   - If `renewUrl` configured, POST `/v1/proxy` with `Renew-Stream-URL` header
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
9. Closed stream returns 409, client creates new stream
10. Resume (requestId) works within session stream
11. Mixed session/non-session requests
12. Session override per-request
13. getSessionId derivation

#### File: `packages/proxy/src/__tests__/connect-stream.test.ts`

New test file covering:

1. First connect creates stream and returns message history (`201 Created`)
2. Reconnect to existing session returns history (`200 OK`)
3. Connect handler rejection (non-2xx) forwarded to client
4. Deterministic stream ID: same session ID always yields same stream ID
5. `Stream-Id` header forwarded to connect handler
6. `Stream-Offset` header forwarded from connect handler to client
7. Fresh signed URL generated in `Location` header

#### File: `packages/proxy/src/__tests__/renew-stream.test.ts`

New test file covering:

1. Renew success path: valid HMAC + upstream 2xx → fresh URL
2. Renew failure path: valid HMAC + upstream 4xx → 401
3. Renew failure path: invalid HMAC → 401
4. Renew with non-existent stream → 404
5. Client auto-renewal with `renewUrl` configured
6. Client error surfacing without `renewUrl` configured
7. Infinite TTL: URL never expires on reads

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

5. **Renewal Endpoint Security**: The renew endpoint requires valid HMAC + upstream acceptance via the renewUrl. The renewUrl handler is the user's opportunity to enforce access control decisions (e.g., revoke access to a conversation). Implementers should NOT return 200 unconditionally from their renewUrl handler.

6. **No Cross-Tenant Access**: Stream IDs are UUIDs with signed URLs. A client cannot guess or forge access to another client's stream.

7. **Infinite TTL**: When TTL is set to infinite, signed URLs never expire. This is appropriate for trusted environments or when the signed URL is stored securely. The HMAC still prevents forgery. Simple deployments can use long/infinite TTL with no renewal infrastructure.

8. **Connect Authorization**: The proxy validates the service JWT (existing proxy auth) and defers session-level authorization to the origin connect handler. The connect handler receives the client's original auth headers and decides whether to permit the session. This two-layer model (proxy auth + origin auth) is consistent with the append path.

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

## Resolved Questions

### URL Refresh and Expiry

- The server returns a fresh signed URL on every response (both `200` and `201`).
- TTL is configurable via `Stream-Signed-URL-TTL` header, defaulting to 7 days. No server-enforced ceiling - infinite TTL is supported.
- On write paths (`POST /v1/proxy` with `Use-Stream-URL`), HMAC is validated but expiry is ignored. Authorization flows through the upstream.
- On read paths (`GET /v1/proxy/{id}`), both HMAC and expiry are enforced. Expired-but-valid-HMAC responses indicate the URL is renewable.
- Renewal uses `POST /v1/proxy` with `Renew-Stream-URL` header (not a separate endpoint), obtaining a fresh signed URL by proving upstream authorization, without producing a stream write.
- Client-side: optional `renewUrl` and `streamSignedUrlTtl` configuration. Simple deployments use long/infinite TTL. Security-sensitive deployments use short TTL + renewUrl.

### Header-Based Dispatch

All operations (create, append, connect, renew) use `POST /v1/proxy`. The operation is determined by header presence, checked in priority order: `Renew-Stream-URL` → `Use-Stream-URL` → `Session-Id` → none.

### Header Naming

- `Use-Stream-URL` (not `Use-Stream-Url`) — consistent with HTTP convention for acronyms (URL, not Url)
- `Stream-Signed-URL-TTL` (not `X-Stream-TTL`) — descriptive, avoids deprecated `X-` prefix

### Deterministic Stream ID

Stream IDs for session-based operations are derived via UUIDv5 from the session ID using a fixed namespace. For stream-per-request operations (no session), a random UUID is used. This maintains the stateless proxy requirement.

### Stream Closed Detection

When a stream is closed between requests, the proxy returns `409 Conflict`. The client clears session credentials and creates a new stream.

## Open Questions

1. **Connect Handler Body Format**: Should the connect handler response body format be opaque (framework-specific) or specified by this RFC? Current proposal: opaque — the proxy passes through whatever the origin returns.

2. **UUIDv5 Namespace**: What fixed namespace UUID should be used for deriving stream IDs from session IDs? Options include a well-known UUID specific to the durable-streams project or a configurable namespace.

3. **Concurrent Appends**: What happens if two requests try to append to the same stream simultaneously? The underlying durable streams protocol handles this via sequencing, but should the proxy add any coordination?

## References

- `packages/proxy/src/server/create-stream.ts` - Current stream creation logic
- `packages/proxy/src/server/tokens.ts` - Pre-signed URL generation and validation
- `packages/proxy/src/server/proxy-handler.ts` - Request dispatch logic
- `packages/proxy/src/server/connect-stream.ts` - Connect operation handler (new)
- `packages/proxy/src/server/derive-stream-id.ts` - Deterministic stream ID derivation (new)
- `packages/proxy/src/client/durable-fetch.ts` - Current client implementation
- `packages/proxy/src/client/storage.ts` - Credential storage utilities
- PRD: Phase 3.1 (Proxy connect operation), Phase 3.4 (Session lifecycle)
