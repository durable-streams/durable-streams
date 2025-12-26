# RFC 9457 Structured Error Responses

## Summary

Adopt RFC 9457 (Problem Details for HTTP APIs) as the standard error response format for Durable Streams servers.

## Problem

Currently, servers return plain text error responses:

```http
HTTP/1.1 409 Conflict
Content-Type: text/plain

Sequence conflict
```

This makes error handling brittle:
- Clients must parse free-form text to determine error type
- No machine-readable error codes
- Difficult to distinguish between similar errors (e.g., `CONFLICT_SEQ` vs `CONFLICT_EXISTS`)
- No standard way to include additional context

## Proposal

Servers MUST return structured error responses following RFC 9457:

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "/errors/sequence-conflict",
  "title": "Sequence Conflict",
  "status": 409,
  "code": "SEQUENCE_CONFLICT",
  "detail": "Stream-Seq header value '42' is less than or equal to the last appended sequence '50'",
  "instance": "/streams/my-stream"
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | URI identifying the error type (can be relative) |
| `title` | string | Short human-readable summary |
| `status` | integer | HTTP status code (MUST match response status) |
| `code` | string | Machine-readable error code |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `detail` | string | Detailed explanation for this specific error |
| `instance` | string | The stream URL/path that triggered the error |

### Standardized Error Codes

| type | code | status | title |
|------|------|--------|-------|
| `/errors/bad-request` | `BAD_REQUEST` | 400 | Bad Request |
| `/errors/invalid-offset` | `INVALID_OFFSET` | 400 | Invalid Offset |
| `/errors/invalid-json` | `INVALID_JSON` | 400 | Invalid JSON |
| `/errors/empty-body` | `EMPTY_BODY` | 400 | Empty Body |
| `/errors/empty-array` | `EMPTY_ARRAY` | 400 | Empty Array |
| `/errors/unauthenticated` | `UNAUTHENTICATED` | 401 | Unauthenticated |
| `/errors/permission-denied` | `PERMISSION_DENIED` | 403 | Permission Denied |
| `/errors/not-found` | `NOT_FOUND` | 404 | Stream Not Found |
| `/errors/already-exists` | `ALREADY_EXISTS` | 409 | Stream Already Exists |
| `/errors/sequence-conflict` | `SEQUENCE_CONFLICT` | 409 | Sequence Conflict |
| `/errors/content-type-mismatch` | `CONTENT_TYPE_MISMATCH` | 409 | Content Type Mismatch |
| `/errors/offset-expired` | `OFFSET_EXPIRED` | 410 | Offset Expired |
| `/errors/payload-too-large` | `PAYLOAD_TOO_LARGE` | 413 | Payload Too Large |
| `/errors/rate-limited` | `RATE_LIMITED` | 429 | Rate Limited |
| `/errors/not-implemented` | `NOT_IMPLEMENTED` | 501 | Not Implemented |
| `/errors/unavailable` | `UNAVAILABLE` | 503 | Service Unavailable |

## Protocol Changes

Add to PROTOCOL.md Section 5:

```markdown
### 5.X. Error Responses

Servers MUST return structured error responses following RFC 9457 (Problem
Details for HTTP APIs) for all 4xx and 5xx responses.

Error responses MUST:
- Use `Content-Type: application/problem+json`
- Include `type`, `title`, `status`, and `code` fields
- Have `status` field matching HTTP response status code
- Use `code` from the standardized error codes table

Error responses SHOULD:
- Include `detail` with a helpful description of the specific error
- Include `instance` with the stream URL when applicable

Clients MUST ignore unknown fields in error responses to allow for
future extensibility.
```

## Conformance Tests

### Server Conformance

```yaml
- id: error-format-not-found
  description: Server returns RFC 9457 format for 404
  operations:
    - action: read
      path: /nonexistent-stream
      expect:
        status: 404
        contentType: application/problem+json
        body:
          type: /errors/not-found
          title: Stream Not Found
          status: 404
          code: NOT_FOUND

- id: error-format-sequence-conflict
  description: Server returns RFC 9457 format for sequence conflict
  operations:
    - action: create
      path: ${streamPath}
    - action: append
      path: ${streamPath}
      seq: 100
    - action: append
      path: ${streamPath}
      seq: 50
      expect:
        status: 409
        contentType: application/problem+json
        body:
          code: SEQUENCE_CONFLICT
```

### Client Conformance

Clients MUST be able to parse RFC 9457 responses and expose:
- The `code` field for programmatic error handling
- The `detail` field for debugging/logging
- The `status` field matching the HTTP status

## References

- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
- [Detailed proposal](../proposals/error-message-standards.md)
