# Idempotency-Key Header for Append Operations

## Summary

Add support for an `Idempotency-Key` request header on POST (append) operations to enable exactly-once semantics from the client's perspective.

## Problem

When a client appends data and the connection drops before receiving a response, the client doesn't know if the append succeeded. Retrying may cause duplicate data:

```
Client                    Server
  |-- POST /stream --------->|
  |                          | (append succeeds)
  |    <-- 204 No Content ---|
  |        X (connection drops)
  |
  |-- POST /stream --------->|  (retry - DUPLICATE!)
  |    <-- 204 No Content ---|
```

The existing `Stream-Seq` header helps with ordering but doesn't solve deduplication - it rejects out-of-order writes rather than deduplicating retries.

## Proposal

Servers SHOULD support an `Idempotency-Key` request header for POST operations:

```http
POST /streams/my-stream
Content-Type: application/json
Idempotency-Key: client-request-uuid-123

{"event": "user_clicked"}
```

### Behavior

1. **First request with key**: Process normally, cache the response keyed by `Idempotency-Key`
2. **Subsequent requests with same key**: Return the cached response without re-processing
3. **Key expiry**: Servers SHOULD retain idempotency keys for at least 24 hours
4. **Key scope**: Keys are scoped per-stream (same key on different streams = different operations)

### Response Headers

When a cached response is returned, servers SHOULD include:

```http
HTTP/1.1 204 No Content
Idempotency-Replayed: true
Stream-Next-Offset: 123_456
```

### Key Format

- Keys MUST be strings between 1-256 characters
- Keys SHOULD be UUIDs or similar unique identifiers
- Keys are case-sensitive
- Servers MUST reject keys with invalid characters (control chars, etc.)

## Protocol Changes

Add to PROTOCOL.md Section 5.2 (Append to Stream):

```markdown
#### Idempotency

Servers SHOULD support the `Idempotency-Key` request header for POST operations
to enable exactly-once append semantics.

**Request Header:**
- `Idempotency-Key: <string>` (optional)
  - A unique identifier for this append operation
  - MUST be 1-256 characters
  - Scoped per-stream

**Behavior:**
- First request with a given key: Process normally, cache response
- Subsequent requests with same key: Return cached response
- Servers SHOULD retain keys for at least 24 hours

**Response Header:**
- `Idempotency-Replayed: true`
  - Present when returning a cached response

If a request with the same `Idempotency-Key` is received with a different body,
servers SHOULD return `409 Conflict` with error code `IDEMPOTENCY_MISMATCH`.
```

## Conformance Tests

### Server Conformance

```yaml
- id: idempotency-key-deduplication
  description: Same idempotency key returns cached response
  operations:
    - action: create
      path: ${streamPath}
    - action: append
      path: ${streamPath}
      data: '{"event": "test"}'
      headers:
        Idempotency-Key: "test-key-123"
      expect:
        status: 204
      capture:
        offset: headers.stream-next-offset
    - action: append
      path: ${streamPath}
      data: '{"event": "test"}'
      headers:
        Idempotency-Key: "test-key-123"
      expect:
        status: 204
        headers:
          idempotency-replayed: "true"
          stream-next-offset: ${offset}  # Same offset as first request
    - action: read
      path: ${streamPath}
      expect:
        chunks: 1  # Only one message, not two

- id: idempotency-key-different-body-conflict
  description: Same key with different body returns 409
  operations:
    - action: create
      path: ${streamPath}
    - action: append
      path: ${streamPath}
      data: '{"event": "first"}'
      headers:
        Idempotency-Key: "test-key-456"
    - action: append
      path: ${streamPath}
      data: '{"event": "different"}'
      headers:
        Idempotency-Key: "test-key-456"
      expect:
        status: 409
        errorCode: IDEMPOTENCY_MISMATCH
```

### Client Conformance

Clients SHOULD:
- Generate unique idempotency keys for each logical append operation
- Reuse the same key when retrying a failed append
- Parse `Idempotency-Replayed` header to detect cached responses

## Implementation Notes

- Idempotency keys can be stored in-memory with LRU eviction for simple implementations
- Production implementations may use Redis or similar for distributed key storage
- The 24-hour retention is a SHOULD, not MUST - implementations can choose shorter windows

## Error Codes

Add to error codes table:

| type | code | status | title |
|------|------|--------|-------|
| `/errors/idempotency-mismatch` | `IDEMPOTENCY_MISMATCH` | 409 | Idempotency Key Mismatch |

## References

- [Stripe Idempotency](https://stripe.com/docs/api/idempotent_requests)
- [IETF Draft: Idempotency-Key Header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
