---
name: go-to-production
description: >
  Production readiness checklist for durable streams. Switch from dev server
  to Caddy binary, configure CDN caching with offset-based URLs,
  Cache-Control and ETag headers, Stream-Cursor for cache collision prevention,
  TTL and Stream-Expires-At for stream lifecycle, HTTPS requirement, request
  collapsing for fan-out, CORS configuration. Load before deploying durable
  streams to production.
type: lifecycle
library: durable-streams
library_version: "0.2.1"
requires:
  - server-deployment
sources:
  - "durable-streams/durable-streams:PROTOCOL.md"
  - "durable-streams/durable-streams:packages/caddy-plugin/README.md"
---

This skill builds on durable-streams/server-deployment. Read it first for server setup basics.

# Durable Streams — Go to Production Checklist

Run through each section before deploying to production.

## Server Checks

### Check: Using Caddy production server (not dev server)

Expected:

```bash
./durable-streams-server run --config Caddyfile
```

Fail condition: Importing `DurableStreamTestServer` from `@durable-streams/server` in production code.

Fix: Download the Caddy binary from GitHub releases and configure with a Caddyfile.

### Check: File-backed persistence configured

Expected:

```
durable_streams {
  data_dir ./data
  max_file_handles 200
}
```

Fail condition: No `data_dir` in Caddyfile — server uses in-memory storage and loses data on restart.

Fix: Add `data_dir` pointing to a persistent directory.

## Transport Checks

### Check: HTTPS enabled

Expected:

```typescript
const res = await stream({
  url: "https://your-server.com/v1/stream/my-stream",
})
```

Fail condition: Using `http://` URLs in production. Pre-signed URLs and auth tokens are bearer credentials — HTTP exposes them in transit. HTTP/1.1 also limits browsers to ~6 concurrent connections per origin.

Fix: Configure TLS on the Caddy server (Caddy provides automatic HTTPS by default).

## Stream Lifecycle Checks

### Check: TTL or expiration set on streams

Expected:

```typescript
const handle = await DurableStream.create({
  url: "https://server.com/v1/stream/my-stream",
  contentType: "application/json",
  headers: { "Stream-TTL": "86400" }, // 24 hours
})
```

Fail condition: Streams created without TTL persist forever, causing unbounded storage growth.

Fix: Set `Stream-TTL` (seconds) or `Stream-Expires-At` (ISO timestamp) on stream creation. Use exactly one, not both.

### Check: Not specifying both TTL and Expires-At

Expected:

```typescript
headers: { "Stream-TTL": "86400" }
// OR
headers: { "Stream-Expires-At": "2026-04-01T00:00:00Z" }
```

Fail condition: Providing both `Stream-TTL` and `Stream-Expires-At` returns 400 Bad Request.

Fix: Use one or the other. TTL is relative (seconds from creation), Expires-At is absolute.

## CDN and Caching Checks

### Check: CDN-friendly URL structure

Expected:

Reads use offset-based URLs that are naturally cacheable:

```
GET /v1/stream/my-stream?offset=abc123
```

The server returns `Cache-Control` and `ETag` headers automatically for historical reads. CDNs can cache and collapse requests — 10,000 viewers at the same offset become one upstream request.

Fail condition: Overriding or stripping `Cache-Control` headers at the CDN/proxy layer.

Fix: Allow the server's `Cache-Control` and `ETag` headers to pass through to the CDN.

### Check: Stream-Cursor header preserved

`Stream-Cursor` prevents CDN cache collisions when the same offset returns different data (e.g., after stream truncation). Ensure your CDN does not strip this header.

Fail condition: CDN strips `Stream-Cursor` from responses.

Fix: Configure CDN to pass through `Stream-Cursor` response header.

## Error Handling Checks

### Check: onError handler configured for live streams

Expected:

```typescript
const res = await stream({
  url,
  offset: "-1",
  live: true,
  onError: (error) => {
    if (error.status === 401) return // Stop retrying
    return {} // Retry transient errors
  },
})
```

Fail condition: No `onError` handler — permanent errors (401, 403) silently retry forever.

Fix: Add `onError` handler that stops retrying for non-transient errors.

## Common Production Mistakes

### CRITICAL Using HTTP in production with browser clients

Wrong:

```typescript
const res = await stream({ url: "http://api.example.com/v1/stream/my-stream" })
```

Correct:

```typescript
const res = await stream({ url: "https://api.example.com/v1/stream/my-stream" })
```

Pre-signed URLs and auth tokens are bearer credentials. HTTP exposes these in transit. Also, HTTP/1.1 limits browsers to ~6 concurrent connections per origin.

Source: packages/client/src/utils.ts warnIfUsingHttpInBrowser

### HIGH Not setting TTL or expiration on streams

Wrong:

```typescript
const handle = await DurableStream.create({
  url: "https://server.com/v1/stream/my-stream",
  contentType: "application/json",
})
```

Correct:

```typescript
const handle = await DurableStream.create({
  url: "https://server.com/v1/stream/my-stream",
  contentType: "application/json",
  headers: { "Stream-TTL": "86400" },
})
```

Without TTL, streams persist forever causing unbounded storage growth.

Source: PROTOCOL.md TTL and Expiry section

### MEDIUM Specifying both TTL and Expires-At

Wrong:

```typescript
headers: {
  "Stream-TTL": "86400",
  "Stream-Expires-At": "2026-04-01T00:00:00Z",
}
```

Correct:

```typescript
headers: {
  "Stream-TTL": "86400",  // OR Expires-At, not both
}
```

The protocol requires exactly one. Providing both returns 400 Bad Request.

Source: PROTOCOL.md TTL and Expiry section

### HIGH Tension: Ephemeral producers vs. persistent coordination

This skill's patterns conflict with writing-data. `autoClaim: true` is convenient for serverless/ephemeral workers but sacrifices cross-restart coordination. Persistent long-running workers may benefit from explicit epoch management for proper multi-worker coordination.

See also: durable-streams/writing-data/SKILL.md § Common Mistakes

## Pre-Deploy Summary

- [ ] Using Caddy production server (not dev server)
- [ ] `data_dir` configured for persistence
- [ ] HTTPS enabled
- [ ] TTL or Expires-At set on all streams
- [ ] Not using both TTL and Expires-At together
- [ ] CDN passes through Cache-Control, ETag, and Stream-Cursor headers
- [ ] `onError` handler configured for live streams
- [ ] `max_file_handles` tuned for expected stream count

## See also

- [server-deployment](../server-deployment/SKILL.md) — Initial server setup
- [writing-data](../writing-data/SKILL.md) — Producer configuration for production

## Version

Targets durable-streams v0.2.1.
