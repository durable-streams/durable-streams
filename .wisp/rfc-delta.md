# RFC 0001 Delta: Implementation Tasks

## What Changed in the RFC

### 1. New "Connect" Operation

A new server operation dispatched via `POST /v1/proxy` when `Session-Id` header is present (without `Use-Stream-URL` or `Renew-Stream-URL`).

**Behavior:**
- Derive stream ID deterministically: `streamId = UUIDv5(sessionId, FIXED_NAMESPACE)`
- HEAD to check stream existence; PUT to create if needed
- Forward request to `Upstream-URL` with added `Stream-Id` header + client auth
- Return **origin's response body** directly to client (NOT piped to stream)
- Return `Location` (fresh signed URL) + `Stream-Offset` + `Upstream-Content-Type`
- `201 Created` for new session, `200 OK` for existing

**Key difference from create/append:** Body goes to client, not to stream.

### 2. Deterministic Stream IDs for Sessions

New utility: `deriveStreamId(sessionId: string): string` using UUIDv5 with a fixed namespace UUID. Same session ID always yields same stream ID. Stateless.

### 3. Header-Based Dispatch Priority Update

Dispatch now checks 4 headers in order:

| Priority | Header Present | Operation |
|----------|---------------|-----------|
| 1 | `Renew-Stream-URL` | Renew |
| 2 | `Use-Stream-URL` | Append |
| 3 | `Session-Id` (without above) | **Connect** (NEW) |
| 4 | None | Create |

### 4. Client: New `connectUrl` Option

New option on `DurableFetchOptions`:
```typescript
connectUrl?: string
```
When configured with a `sessionId`, the client performs a connect operation before the first request if no session credentials exist.

### 5. Client: New Methods

The RFC shows `durableFetch.connect()` and `durableFetch.subscribe()` methods. These represent the session lifecycle: connect → subscribe → send → renew.

### 6. Session Lifecycle (Explicit)

```
1. Connect   → POST /v1/proxy (Session-Id header)      → history + URL + offset
2. Subscribe → GET signed-url?offset=<offset>           → SSE stream
3. Send      → POST /v1/proxy (Use-Stream-URL header)   → fresh URL
4. Renew     → POST /v1/proxy (Renew-Stream-URL header) → fresh URL
```

---

## What Already Exists (No Changes Needed)

- `Use-Stream-URL` header for append (correctly capitalized)
- `Renew-Stream-URL` header dispatch (already header-based, not separate endpoint)
- `Stream-Signed-URL-TTL` header (correctly named)
- `streamSignedUrlTtl` client option
- `renewUrl` client option
- `sessionId` / `getSessionId` client options
- Session credential storage (`saveSessionCredentials` / `loadSessionCredentials`)
- HMAC-without-expiry on write/renew paths
- Read path expired URL response with `renewable: true`
- 409 Conflict handling

---

## Implementation Tasks

### Server

#### S1. New file: `packages/proxy/src/server/derive-stream-id.ts`
- Export `deriveStreamId(sessionId: string): string`
- Use UUIDv5 with a fixed namespace UUID
- Choose/define the namespace UUID constant

#### S2. New file: `packages/proxy/src/server/connect-stream.ts`
- Export `handleConnectStream` handler
- Extract `Session-Id` header
- Call `deriveStreamId(sessionId)` to get stream ID
- HEAD to durable streams server to check existence
- PUT to create stream if it doesn't exist
- Forward request to `Upstream-URL` with `Stream-Id` header + client auth
- If upstream 2xx: return origin body + `Location` (fresh signed URL) + `Stream-Offset` (from upstream) + `Upstream-Content-Type`
- If upstream non-2xx: forward status to client
- Return `201 Created` (new) or `200 OK` (existing)

#### S3. Update `packages/proxy/src/server/proxy-handler.ts`
- Add `Session-Id` check after `Use-Stream-URL` check, before default create
- Route to `handleConnectStream` when `Session-Id` present without `Use-Stream-URL` or `Renew-Stream-URL`
- Add `Stream-Offset` to CORS exposed headers

#### S4. Update `packages/proxy/src/server/types.ts`
- Add any new types needed for connect operation

### Client

#### C1. Update `packages/proxy/src/client/types.ts`
- Add `connectUrl?: string` to `DurableFetchOptions`

#### C2. Update `packages/proxy/src/client/durable-fetch.ts`
- Accept `connectUrl` option
- When `connectUrl` configured + `sessionId` resolved + no session credentials:
  - POST to proxy with `Session-Id` header and `connectUrl` as `Upstream-URL`
  - Store session credentials from response
  - Return connect response (body + streamUrl + offset) to caller
- Consider adding `connect()` and `subscribe()` methods

#### C3. Update `packages/proxy/src/client/index.ts`
- Export any new types

### Tests

#### T1. New file: `packages/proxy/src/__tests__/connect-stream.test.ts`
- Connect creates stream and returns history (201)
- Reconnect to existing session returns history (200)
- Connect handler rejection forwarded to client
- Deterministic stream ID from session ID
- `Stream-Id` header forwarded to connect handler
- `Stream-Offset` header forwarded from handler to client
- Fresh signed URL in `Location` header

#### T2. Update existing tests if dispatch logic changes affect them
