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

| Concept | Purpose | Affects |
|---------|---------|---------|
| `requestId` | Resume reading an interrupted response | Client-side (skip POST, read from offset) |
| `sessionId` | Group multiple requests into one stream | Server-side (append vs create) |

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

#### Server Validation

When `Use-Stream-Url` header is present:

1. **Parse URL**: Extract `streamId`, `expires`, and `signature` from the URL
2. **Validate Signature**: Use existing `validatePreSignedUrl()` to verify the signature
3. **Check Stream Exists**: HEAD request to underlying durable streams server to verify stream exists
4. **Check Stream Open**: Ensure stream is not closed (can still accept writes)
5. **Append**: Use POST (not PUT) to append upstream response to existing stream

#### Response Codes

| Status | Condition |
|--------|-----------|
| `200 OK` | Stream reuse successful, response appended |
| `201 Created` | New stream created (existing behavior) |
| `400 Bad Request` | `Use-Stream-Url` header malformed |
| `401 Unauthorized` | Pre-signed URL signature invalid or expired |
| `404 Not Found` | Specified stream does not exist |
| `409 Conflict` | Stream is closed, cannot append |

#### Response Headers (Stream Reuse)

On successful stream reuse (`200 OK`):
```
Location: <same-pre-signed-url>
Upstream-Content-Type: <content-type>
```

The `Location` header returns the same stream URL (or a refreshed pre-signed URL with extended expiry).

### Storage Changes

Two storage key patterns:

```typescript
// Session storage: stream URL shared across requests in a session
`{prefix}session:{scope}:{sessionId}` → SessionCredentials

// Request storage: per-request resume point (existing, with modifications)
`{prefix}{scope}:{requestId}` → StreamCredentials
```

#### New Type: `SessionCredentials`

```typescript
interface SessionCredentials {
  /** The pre-signed stream URL */
  streamUrl: string
  /** The stream ID */
  streamId: string
  /** When the pre-signed URL expires (Unix timestamp in seconds) */
  expiresAtSecs: number
}
```

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
       │ exist & not expired?      │
       └───────────────────────────┘
              │           │
             YES          NO
              │           │
              ▼           ▼
    ┌──────────────┐  ┌───────────────────────────┐
    │ SKIP POST    │  │ sessionId credentials     │
    │ Resume read  │  │ exist & not expired?      │
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
  proxyUrl: '...',
  proxyAuthorization: '...',
  sessionId: 'default-session',
})

// Uses default session
await durableFetch(apiUrl, { body: '...' })

// Override: create new stream (no session reuse)
await durableFetch(apiUrl, {
  sessionId: undefined,  // Explicitly no session
  body: '...',
})

// Override: use different session
await durableFetch(apiUrl, {
  sessionId: 'other-session',
  body: '...',
})
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

#### File: `packages/proxy/src/server/create-stream.ts`

Modify `handleCreateStream` to:

1. Check for `Use-Stream-Url` header
2. If present:
   - Parse and validate the pre-signed URL
   - Verify stream exists (HEAD to durable streams server)
   - Check stream is not closed
   - Skip stream creation (no PUT)
   - Pipe upstream response to existing stream (POST)
   - Return `200 OK` with `Location` header
3. If not present: existing behavior (create new stream, return `201 Created`)

### Phase 2: Client-Side Changes

#### File: `packages/proxy/src/client/types.ts`

1. Add `SessionCredentials` interface
2. Add `sessionId` and `getSessionId` to `DurableFetchOptions`
3. Add `sessionId` to `DurableFetchRequestOptions`

#### File: `packages/proxy/src/client/storage.ts`

Add session credential storage functions:

```typescript
function createSessionStorageKey(prefix: string, scope: string, sessionId: string): string
function saveSessionCredentials(storage, prefix, scope, sessionId, credentials): void
function loadSessionCredentials(storage, prefix, scope, sessionId): SessionCredentials | null
function removeSessionCredentials(storage, prefix, scope, sessionId): void
```

#### File: `packages/proxy/src/client/durable-fetch.ts`

Modify `createDurableFetch` to:

1. Accept `sessionId` and `getSessionId` options
2. Resolve effective sessionId for each request (priority: request > getSessionId > options)
3. Before making POST:
   - Check requestId credentials (existing resume path)
   - Check sessionId credentials
   - If session credentials exist, add `Use-Stream-Url` header
4. After successful response:
   - Store/update session credentials
   - Store request credentials (with current offset as starting point)
5. Handle `409 Conflict` (stream closed) by falling back to new stream creation

### Phase 3: Tests

#### File: `packages/proxy/src/__tests__/stream-reuse.test.ts`

New test file covering:

1. First request creates stream, stores session credentials
2. Second request with same sessionId appends to stream (200 OK)
3. Invalid/expired pre-signed URL returns 401
4. Non-existent stream returns 404
5. Closed stream returns 409, client creates new stream
6. Resume (requestId) works within session stream
7. Mixed session/non-session requests
8. Session override per-request
9. getSessionId derivation

### Phase 4: Export Updates

#### File: `packages/proxy/src/client/index.ts`

Export new types:
- `SessionCredentials`

No new function exports needed - session handling is internal to `createDurableFetch`.

## Security Considerations

1. **Capability-Based Access**: The pre-signed URL acts as a capability token. Possession of the URL grants read/write access to the stream. This aligns with the existing security model.

2. **Signature Validation**: The `Use-Stream-Url` header value is validated using the same `validatePreSignedUrl()` function, ensuring timing-safe HMAC comparison.

3. **Expiration**: Pre-signed URLs have expiration timestamps. Expired URLs cannot be used for stream reuse.

4. **No Cross-Tenant Access**: Stream IDs are UUIDs with signed URLs. A client cannot guess or forge access to another client's stream.

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

## Open Questions

1. **URL Refresh**: Should the server return a refreshed pre-signed URL with extended expiry on stream reuse? Current proposal returns the same URL.

2. **Concurrent Appends**: What happens if two requests try to append to the same stream simultaneously? The underlying durable streams protocol handles this via sequencing, but should the proxy add any coordination?

3. **Stream Closed Detection**: How should the client handle the case where a stream was closed between requests? Current proposal: return 409, client clears session credentials and creates new stream.

## References

- `packages/proxy/src/server/create-stream.ts` - Current stream creation logic
- `packages/proxy/src/server/tokens.ts` - Pre-signed URL generation and validation
- `packages/proxy/src/client/durable-fetch.ts` - Current client implementation
- `packages/proxy/src/client/storage.ts` - Credential storage utilities
