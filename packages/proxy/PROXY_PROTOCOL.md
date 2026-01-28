# Proxy Protocol Server Behavior Specification

## Overview

The proxy protocol provides durable HTTP request proxying. When a client creates a proxy request, the server forwards it to an upstream server while persisting the response to an underlying durable stream. This enables clients to disconnect and reconnect, resuming reads from any offset without data loss.

The proxy protocol reuses the existing durable stream infrastructure (HotBuffer Durable Object) for storage, delegating to the stream protocol's read semantics for data retrieval. All `Stream-*` response headers are provided by the underlying durable stream.

---

## Protocol Registration

The proxy protocol is registered at `/v1/proxy` with the following routes:

| Method  | Path            | Auth                  | Description          |
| ------- | --------------- | --------------------- | -------------------- |
| POST    | `/`             | Service JWT           | Create proxy request |
| GET     | `/:streamId`    | Pre-signed URL or JWT | Read from stream     |
| HEAD    | `/:streamId`    | Service JWT           | Get stream metadata  |
| PATCH   | `/:streamId`    | Pre-signed URL only   | Abort upstream       |
| DELETE  | `/:streamId`    | Service JWT           | Delete stream        |
| OPTIONS | `/{:streamId}?` | None                  | CORS preflight       |

---

## POST: Create Proxy Request

### Request Validation

1. **Authentication**: Validate service JWT from `?secret=` query param or `Authorization: Bearer` header
   - Errors: `MISSING_SECRET` (401), `INVALID_SECRET` (401)

2. **Required Headers**:
   - `Upstream-URL`: Must be present → `MISSING_UPSTREAM_URL` (400)
   - `Upstream-Method`: Must be present → `MISSING_UPSTREAM_METHOD` (400)

3. **Method Validation**: `Upstream-Method` must be one of: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
   - Disallowed: `HEAD`, `OPTIONS`, `CONNECT`, `TRACE`
   - Error: `INVALID_UPSTREAM_METHOD` (400)

4. **Allowlist Validation**: `Upstream-URL` must match at least one pattern in the configured allowlist
   - URL must use HTTP or HTTPS scheme
   - URL must have a hostname
   - Query params and fragments stripped before matching
   - Error: `UPSTREAM_NOT_ALLOWED` (403)

### Stream Initialization

1. **Generate Stream ID**: Create UUIDv7 for the new stream

2. **Prepare Upstream Request**:
   - Extract headers from client request, excluding:
     - Hop-by-hop headers: `Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`
     - Proxy-managed headers: `Host`, `Authorization`, `Upstream-URL`, `Upstream-Authorization`, `Upstream-Method`
   - Set `Host` header to upstream hostname
   - Transform `Upstream-Authorization` → `Authorization` if present
   - Forward request body as-is

3. **Call HotBuffer.initializeProxy()**: The Durable Object handles upstream fetch

### Upstream Fetch (in HotBuffer DO)

1. **Create AbortController** for fetch lifecycle management

2. **Fetch with Timeout**:
   - Timeout: 60 seconds for response headers
   - Redirect policy: `manual` (do not follow redirects)

3. **Handle Response Status**:

   | Status  | Action                                                                                          |
   | ------- | ----------------------------------------------------------------------------------------------- |
   | 2xx     | Success path (continue)                                                                         |
   | 3xx     | Return `{ ok: false, code: 'redirect', status, location }`                                      |
   | 4xx/5xx | Read body (max 64KB), return `{ ok: false, code: 'upstream_error', status, body, contentType }` |
   | Timeout | Return `{ ok: false, code: 'timeout' }`                                                         |

4. **On 2xx Success**:
   - Store `upstream_content_type` in DO storage
   - Initialize underlying durable stream with:
     - `contentType`: `application/octet-stream`
     - `expiresAt`: now + 24 hours
     - `metadata`: `{ upstream_url, upstream_method, upstream_status, upstream_content_type }`
   - Start piping response body in background via `ctx.waitUntil()`
   - Return `{ ok: true, upstreamContentType }`

### Response Body Piping

Runs asynchronously after POST returns:

1. **Batching**: Accumulate chunks, flush when:
   - Size threshold: 4KB accumulated
   - Time threshold: 50ms since first chunk in batch
   - Whichever comes first

2. **Inactivity Timeout**: 10 minutes between chunks
   - On timeout: abort fetch, flush accumulated data

3. **On Stream End**: Flush remaining data, then mark the underlying stream as closed

4. **On Abort/Error**: Flush accumulated data, stop piping (stream remains readable up to that point)

### POST Response

**On Success (2xx from upstream)**:

```http
HTTP/1.1 201 Created
Location: https://{host}/v1/proxy/{streamId}?expires={ts}&signature={sig}
Upstream-Content-Type: {upstream Content-Type}
Access-Control-Expose-Headers: Location, Upstream-Content-Type, ...
```

No response body. Location is always an absolute URL (using `X-Forwarded-Proto` for scheme detection behind TLS-terminating proxies). The pre-signed URL is valid for 24 hours.

**On Upstream Error (4xx/5xx)**:

```http
HTTP/1.1 502 Bad Gateway
Upstream-Status: {upstream status code}
Content-Type: {upstream Content-Type}

{upstream error body, max 64KB}
```

**On Redirect (3xx)**:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error": {"code": "REDIRECT_NOT_ALLOWED", "message": "Proxy cannot follow redirects"}}
```

**On Timeout**:

```http
HTTP/1.1 504 Gateway Timeout
Content-Type: application/json

{"error": {"code": "UPSTREAM_TIMEOUT", "message": "Upstream server did not respond in time"}}
```

---

## GET: Read from Stream

### Authentication

1. Check for pre-signed URL parameters (`expires` AND `signature` both present):
   - Validate expiration: `Date.now() <= expires * 1000`
     - Error: `SIGNATURE_EXPIRED` (401)
   - Verify HMAC-SHA256 signature of `{streamId}:{expires}`
     - Error: `SIGNATURE_INVALID` (401)

2. If pre-signed URL params not present, fall back to service JWT validation
   - Errors: `MISSING_SECRET` (401), `INVALID_SECRET` (401)

### Stream Read

Delegates to the underlying durable stream read handler with resource ID `{streamId}`.

The underlying durable stream handles:

- Offset parsing and validation
- Hot buffer reads (SQLite in DO)
- Cold storage reads (R2) for older chunks
- Live modes (`long-poll`, `sse`)

### Response

The underlying durable stream provides `Stream-*` headers. The proxy adds `Upstream-Content-Type`:

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Stream-Next-Offset: {hash}:{chunk}:{position}
Stream-Up-To-Date: true|false
Stream-Total-Size: {bytes}
Stream-Write-Units: {units}
Stream-Closed: true|false
Upstream-Content-Type: {original upstream Content-Type}

{stream data}
```

All `Stream-*` headers (`Stream-Next-Offset`, `Stream-Up-To-Date`, `Stream-Total-Size`, `Stream-Write-Units`, `Stream-Closed`, `Stream-Expires-At`) are provided by the underlying durable stream.

**Note**: Once the body of the proxied upstream response ends, the underlying stream is marked closed by the proxy. Subsequent reads that reach the tail of the stream will include the `Stream-Closed: true` header, indicating no more data will be written.

---

## HEAD: Get Stream Metadata

### Authentication

Service JWT only (no pre-signed URL fallback).

### Behavior

Calls `HotBuffer.getMetadata()` and returns headers without body.

### Response

The underlying durable stream provides `Stream-*` headers:

```http
HTTP/1.1 200 OK
Stream-Next-Offset: {tail offset}
Stream-Total-Size: {bytes}
Stream-Write-Units: {units}
Stream-Expires-At: {ISO 8601 timestamp}
Upstream-Content-Type: {original upstream Content-Type}
```

Error: `STREAM_NOT_FOUND` (404) if stream doesn't exist.

---

## PATCH: Abort Upstream

### Authentication

Pre-signed URL only—no fallback to JWT.

- Both `expires` and `signature` required → `MISSING_SIGNATURE` (401) if missing
- Expiration and signature validated as in GET

### Action Validation

Query parameter `action` must equal `abort`.

- Error: `INVALID_ACTION` (400) with message indicating supported actions

### Behavior

Calls `HotBuffer.proxyAbortUpstream()`:

1. If `AbortController` exists (upstream still piping): call `abort()`
2. Clear `AbortController` reference
3. Always return success (idempotent)

The abort does NOT mark the stream as errored. Data piped up to the abort point remains readable. If the upstream body was still being piped, it will flush any accumulated chunks before stopping.

### Response

```http
HTTP/1.1 204 No Content
```

---

## DELETE: Delete Stream

### Authentication

Service JWT required.

### Behavior

Calls `HotBuffer.delete()`:

1. Schedule cold storage cleanup (R2 chunks) via queue
2. Queue deregister event for registry
3. Drop SQLite tables (`chunks`, `producers`)
4. Delete KV metadata keys
5. Abort any in-flight proxy request
6. Reset in-memory state

Idempotent—returns success even if stream already deleted.

### Response

```http
HTTP/1.1 204 No Content
```

---

## Pre-signed URL Generation

Generated by POST handler after successful upstream initialization:

```typescript
signature = base64url(HMAC - SHA256(secret, `${streamId}:${expiresAt}`))
url = `${origin}/v1/proxy/${streamId}?expires=${expiresAt}&signature=${signature}`
```

- Expiration: 24 hours from creation (configurable via `DEFAULT_URL_EXPIRATION_SECONDS`)
- Path segments URL-encoded in final URL
- Signature computed on raw (unencoded) ID

---

## Capability Model

The pre-signed URL returned by POST is a **capability URL**: possession of it grants both **read** and **abort** access to the stream. The signature binds to `{streamId}:{expires}` and does not include the HTTP method or action, so a single URL works for both GET (read) and PATCH (abort).

| Operation           | Auth required                   |
| ------------------- | ------------------------------- |
| **Read** (GET)      | Pre-signed URL _or_ service JWT |
| **Abort** (PATCH)   | Pre-signed URL only             |
| **Metadata** (HEAD) | Service JWT only                |
| **Delete** (DELETE) | Service JWT only                |

This means any holder of the pre-signed URL can abort the upstream connection. If you share read URLs with untrusted parties, be aware they can also cancel generation. Administrative operations (metadata, deletion) require the service secret and cannot be performed with a pre-signed URL alone.

---

## Allowlist Pattern Matching

Patterns parsed into `URLPattern` matchers:

| Pattern Syntax            | URLPattern Equivalent                                              |
| ------------------------- | ------------------------------------------------------------------ |
| `api.example.com`         | `protocol: "http{s}?", hostname: "api.example.com", pathname: "*"` |
| `https://api.example.com` | `protocol: "https", hostname: "api.example.com", pathname: "*"`    |
| `api.example.com:8080`    | `port: "8080", ...`                                                |
| `api.example.com/v1/*`    | `pathname: "/v1{/*}?"`                                             |
| `*.example.com`           | `hostname: "*.example.com"`                                        |

Default ports (80 for HTTP, 443 for HTTPS) are normalized to empty string.

---

## Storage Keys (HotBuffer DO)

| Key                     | Type   | Description                                 |
| ----------------------- | ------ | ------------------------------------------- |
| `stream_id`             | string | Stream ID                                   |
| `stream_hash`           | string | 5-char random hash for offset encoding      |
| `content_type`          | string | Always `application/octet-stream` for proxy |
| `upstream_content_type` | string | Original Content-Type from upstream         |
| `current_chunk_seq`     | number | Current hot buffer chunk sequence           |
| `total_bytes`           | number | Total bytes written to stream               |
| `write_units`           | number | Billable write units consumed               |
| `stream_expires_at`     | string | ISO 8601 expiration timestamp               |

---

## CORS Headers

**Allowed Request Headers** (preflight):

- `Upstream-URL`
- `Upstream-Authorization`
- `Upstream-Method`
- `Content-Type`

**Exposed Response Headers**:

- `Location`
- `Upstream-Content-Type`
- `Upstream-Status`
- `Stream-Next-Offset` (from underlying durable stream)
- `Stream-Up-To-Date` (from underlying durable stream)
- `Stream-Total-Size` (from underlying durable stream)
- `Stream-Write-Units` (from underlying durable stream)
- `Stream-Closed` (from underlying durable stream)
- `Stream-Expires-At` (from underlying durable stream)

---

## Error Codes Reference

| Code                      | Status | Trigger                             |
| ------------------------- | ------ | ----------------------------------- |
| `MISSING_SECRET`          | 401    | No JWT in request                   |
| `INVALID_SECRET`          | 401    | JWT verification failed             |
| `SIGNATURE_EXPIRED`       | 401    | Pre-signed URL past expiration      |
| `SIGNATURE_INVALID`       | 401    | HMAC verification failed            |
| `MISSING_SIGNATURE`       | 401    | PATCH without expires/signature     |
| `MISSING_UPSTREAM_URL`    | 400    | POST without Upstream-URL header    |
| `MISSING_UPSTREAM_METHOD` | 400    | POST without Upstream-Method header |
| `INVALID_UPSTREAM_METHOD` | 400    | Disallowed Upstream-Method on POST  |
| `INVALID_ACTION`          | 400    | Invalid PATCH action parameter      |
| `REDIRECT_NOT_ALLOWED`    | 400    | Upstream returned 3xx               |
| `UPSTREAM_NOT_ALLOWED`    | 403    | URL not in allowlist                |
| `STREAM_NOT_FOUND`        | 404    | Stream doesn't exist                |
| `UPSTREAM_TIMEOUT`        | 504    | No headers within 60s               |
| `UPSTREAM_BODY_TIMEOUT`   | 504    | No data within 10 minutes           |
