# RFC 0001: Proxy Stream Reuse

**Status:** Draft
**Created:** 2026-02-01
**Package:** `@durable-streams/proxy`

## Summary

This RFC proposes adding stream reuse capabilities to the proxy package, allowing multiple HTTP request-response cycles to write to the same durable stream. This enables session-based streaming where a client can consume and resume a single stream across an entire conversation or session.

## Requirements

### Functional Requirements

1. **Stream Reuse**: The proxy server MUST support appending upstream responses to an existing stream instead of always creating a new stream.

2. **Session Identification**: The client MUST be able to specify a session identifier that groups multiple requests into a single stream.

3. **Backward Compatibility**: The default behavior MUST remain unchanged - each request creates a new stream unless stream reuse is explicitly requested.

4. **Resume Compatibility**: The existing `requestId`-based resume mechanism MUST continue to work, including for requests that are part of a session stream.

5. **Security**: Stream reuse MUST validate that the caller has permission to append to the stream using the existing pre-signed URL mechanism.

### Non-Functional Requirements

1. **Stateless Proxy**: The proxy server MUST remain stateless. Session-to-stream mapping is managed client-side.

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

## Proposal

### New Concept: `sessionId`

Introduce `sessionId` as a distinct concept from `requestId`:

| Concept     | Purpose                                 | Affects                                   |
| ----------- | --------------------------------------- | ----------------------------------------- |
| `requestId` | Resume reading an interrupted response  | Client-side (skip POST, read from offset) |
| `sessionId` | Group multiple requests into one stream | Server-side (append vs create)            |

They are orthogonal and can be used together.

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
   * Sent as X-Stream-TTL header. Server uses this as the expiry
   * duration for generated signed URLs.
   * Default: server-configured (typically 7 days).
   */
  ttl?: number

  /**
   * Optional URL for renewing expired signed URLs.
   * When a read URL expires, the client will POST to /v1/proxy/renew
   * with this as the Upstream-URL to obtain a fresh signed URL.
   * The endpoint must accept the client's auth headers and return
   * 2xx if the client is still authorized.
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

#### New Request Header: `Use-Stream-Url`

When `POST /v1/proxy` includes this header, the server appends to the existing stream instead of creating a new one.

**Header Format:**

```
Use-Stream-Url: <pre-signed-stream-url>
```

**Example:**

```
POST /v1/proxy?secret=xxx HTTP/1.1
Upstream-URL: https://api.openai.com/v1/chat/completions
Upstream-Method: POST
Use-Stream-Url: http://proxy.example.com/v1/proxy/abc-123?expires=1234567890&signature=xyz
Content-Type: application/json

{"messages": [...]}
```

#### New Request Header: `X-Stream-TTL`

Optional header specifying the TTL in seconds for the generated signed URL.

**Header Format:**

```
X-Stream-TTL: <seconds>
```

**Server Behavior:**

- If provided, the server uses this value as the expiry duration for the signed URL it generates.
- Default: 7 days (604800 seconds), configurable server-side.
- No server-enforced ceiling - infinite TTL is supported by setting to `0` or omitting entirely when the server default is infinite.

#### Server Validation

When `Use-Stream-Url` header is present:

1. **Parse URL**: Extract `streamId`, `expires`, and `signature` from the URL
2. **Validate HMAC**: Verify the signature is valid (reject if invalid)
3. **Ignore Expiry**: On write paths, expiry is NOT enforced - only HMAC validity matters
4. **Check Stream Exists**: HEAD request to underlying durable streams server to verify stream exists
5. **Check Stream Open**: Ensure stream is not closed (can still accept writes)
6. **Append**: Use POST (not PUT) to append upstream response to existing stream

**HMAC vs Expiry Validation by Path:**

| Path                                         | HMAC                         | Expiry      |
| -------------------------------------------- | ---------------------------- | ----------- |
| `POST /v1/proxy` with `Use-Stream-Url`       | Validate (reject if invalid) | **Ignore**  |
| `POST /v1/proxy/renew` with `Use-Stream-Url` | Validate (reject if invalid) | **Ignore**  |
| `GET /v1/proxy/{id}` (read)                  | Validate (reject if invalid) | **Enforce** |

**Rationale**: On write and renew paths, the real authorization is the upstream accepting the forwarded request. The HMAC proves the client received this URL from the proxy (prior legitimate access). Expiry is irrelevant because the upstream is the authority. On read paths, the signed URL is the sole authorization - both HMAC and expiry must be valid.

#### New Endpoint: `POST /v1/proxy/renew`

Allows clients to obtain a fresh signed URL for an existing stream without producing a write. This is for re-activating read access when the signed URL has expired and the client doesn't have a pending real request to make.

**Request:**

```
POST /v1/proxy/renew
Use-Stream-Url: <stream-url-with-valid-hmac>
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

**Response Codes (Renew Endpoint):**

| Status             | Condition                                               |
| ------------------ | ------------------------------------------------------- |
| `200 OK`           | Renewal successful. Fresh signed URL in `Location`.     |
| `401 Unauthorized` | HMAC invalid, or upstream renewUrl rejected the request |
| `404 Not Found`    | Stream does not exist                                   |

#### Response Codes

| Status             | Condition                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `200 OK`           | Stream reuse successful, response appended. Fresh signed URL in `Location`.               |
| `201 Created`      | New stream created. Fresh signed URL in `Location`.                                       |
| `400 Bad Request`  | `Use-Stream-Url` header malformed                                                         |
| `401 Unauthorized` | HMAC signature invalid (not just expired - expired HMAC is accepted on write/renew paths) |
| `404 Not Found`    | Specified stream does not exist                                                           |
| `409 Conflict`     | Stream is closed, cannot append                                                           |

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

- **"expired but renewable"**: Valid HMAC, expired timestamp - client can use `/v1/proxy/renew` to obtain a fresh URL
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
                   │ Use-Stream-  │  │ header       │
                   │ Url header   │  │ (create new) │
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
   - Automatically `POST /v1/proxy/renew` with the expired stream URL and the renewUrl
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
  ttl: 300, // 5 minute signed URLs
  renewUrl: "https://api.example.com/auth/check-access",
})

// Signed URLs expire after 5 minutes of inactivity
// When reading an expired stream, the client automatically:
// 1. POSTs to /v1/proxy/renew with the renewUrl
// 2. The proxy forwards to api.example.com/auth/check-access
// 3. If the user is still authorized, receives a fresh signed URL
// 4. Retries the read transparently
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

1. Check for `Use-Stream-Url` header
2. If present:
   - Parse and validate the HMAC (ignore expiry)
   - Verify stream exists (HEAD to durable streams server)
   - Check stream is not closed
   - Skip stream creation (no PUT)
   - Pipe upstream response to existing stream (POST)
   - Return `200 OK` with fresh signed URL in `Location` header
3. If not present: existing behavior (create new stream, return `201 Created`)

Support `X-Stream-TTL` header:

- Pass TTL value to URL generation
- Default: 7 days (604800 seconds)
- Support infinite TTL (no expiry)

#### File: `packages/proxy/src/server/renew-stream.ts` (new)

Add `handleRenewStream` handler for `POST /v1/proxy/renew`:

1. Parse `Use-Stream-Url` header, validate HMAC (ignore expiry)
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
2. Add `ttl` and `renewUrl` to `DurableFetchOptions`

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

1. Accept `sessionId`, `getSessionId`, `ttl`, and `renewUrl` options
2. Send `X-Stream-TTL` header when `ttl` is configured
3. Resolve effective sessionId for each request (priority: request > getSessionId > options)
4. Before making POST:
   - Check requestId credentials (existing resume path)
   - Check sessionId credentials
   - If session credentials exist, add `Use-Stream-Url` header
5. After successful response:
   - Store/update session credentials (streamUrl, streamId only)
   - Store request credentials (with current offset as starting point)
6. Handle `409 Conflict` (stream closed) by falling back to new stream creation
7. Add auto-renewal logic:
   - Intercept 401 on reads
   - Check for `renewable: true` in response
   - If `renewUrl` configured, call `/v1/proxy/renew`
   - Update stored credentials with fresh URL
   - Retry the read

### Phase 3: Tests

#### File: `packages/proxy/src/__tests__/stream-reuse.test.ts`

New test file covering:

1. First request creates stream, stores session credentials
2. Second request with same sessionId appends to stream (200 OK)
3. Fresh signed URL returned on every `200` and `201`
4. `X-Stream-TTL` respected in generated URLs
5. Expired HMAC accepted on write path when upstream returns 2xx
6. Expired HMAC rejected on read path with `renewable: true` in response
7. Invalid HMAC rejected on all paths
8. Non-existent stream returns 404
9. Closed stream returns 409, client creates new stream
10. Resume (requestId) works within session stream
11. Mixed session/non-session requests
12. Session override per-request
13. getSessionId derivation

#### File: `packages/proxy/src/__tests__/renew-stream.test.ts`

New test file covering:

1. `/v1/proxy/renew` success path: valid HMAC + upstream 2xx → fresh URL
2. `/v1/proxy/renew` failure path: valid HMAC + upstream 4xx → 401
3. `/v1/proxy/renew` failure path: invalid HMAC → 401
4. `/v1/proxy/renew` with non-existent stream → 404
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

3. **Signature Validation**: The `Use-Stream-Url` header value is validated using timing-safe HMAC comparison.

4. **HMAC-Without-Expiry on Writes**: An attacker would need both:
   - A valid HMAC (proving they once received the URL from the proxy)
   - Valid upstream credentials (the upstream must accept their request)

   Both are required. Stream IDs are UUIDs - unguessable.

5. **Renewal Endpoint Security**: The renew endpoint requires valid HMAC + upstream acceptance via the renewUrl. The renewUrl handler is the user's opportunity to enforce access control decisions (e.g., revoke access to a conversation). Implementers should NOT return 200 unconditionally from their renewUrl handler.

6. **No Cross-Tenant Access**: Stream IDs are UUIDs with signed URLs. A client cannot guess or forge access to another client's stream.

7. **Infinite TTL**: When TTL is set to infinite, signed URLs never expire. This is appropriate for trusted environments or when the signed URL is stored securely. The HMAC still prevents forgery. Simple deployments can use long/infinite TTL with no renewal infrastructure.

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

## Resolved Questions

### URL Refresh and Expiry

- The server returns a fresh signed URL on every response (both `200` and `201`).
- TTL is configurable via `X-Stream-TTL` header, defaulting to 7 days. No server-enforced ceiling - infinite TTL is supported.
- On write paths (`POST /v1/proxy` with `Use-Stream-Url`), HMAC is validated but expiry is ignored. Authorization flows through the upstream.
- On read paths (`GET /v1/proxy/{id}`), both HMAC and expiry are enforced. Expired-but-valid-HMAC responses indicate the URL is renewable.
- A new `POST /v1/proxy/renew` endpoint allows obtaining a fresh signed URL by proving upstream authorization, without producing a stream write.
- Client-side: optional `renewUrl` and `ttl` configuration. Simple deployments use long/infinite TTL. Security-sensitive deployments use short TTL + renewUrl.

## Open Questions

1. **Concurrent Appends**: What happens if two requests try to append to the same stream simultaneously? The underlying durable streams protocol handles this via sequencing, but should the proxy add any coordination?

2. **Stream Closed Detection**: How should the client handle the case where a stream was closed between requests? Current proposal: return 409, client clears session credentials and creates new stream.

## References

- `packages/proxy/src/server/create-stream.ts` - Current stream creation logic
- `packages/proxy/src/server/tokens.ts` - Pre-signed URL generation and validation
- `packages/proxy/src/client/durable-fetch.ts` - Current client implementation
- `packages/proxy/src/client/storage.ts` - Credential storage utilities
