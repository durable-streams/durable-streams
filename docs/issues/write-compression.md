# Write Compression (Content-Encoding on POST)

## Summary

Specify that servers SHOULD support `Content-Encoding: gzip` and `Content-Encoding: deflate` on POST (append) requests, allowing clients to send compressed payloads.

## Problem

The protocol currently supports compression for responses (reads) via `Accept-Encoding` negotiation, but doesn't specify compression for requests (writes).

For clients appending large payloads (e.g., batched JSON events, binary data), sending uncompressed data wastes bandwidth - especially on mobile or metered connections.

## Proposal

Servers SHOULD accept compressed request bodies on POST operations:

```http
POST /streams/my-stream
Content-Type: application/json
Content-Encoding: gzip

<gzipped JSON body>
```

### Supported Encodings

| Encoding | Support Level |
|----------|---------------|
| `gzip` | SHOULD support |
| `deflate` | SHOULD support |
| `br` (Brotli) | MAY support |
| `identity` | MUST support (uncompressed) |

### Behavior

1. Server decompresses the body before processing
2. Data is stored decompressed (compression is transport-only)
3. `Content-Type` refers to the decompressed content
4. If server doesn't support the encoding, return `415 Unsupported Media Type`

### Error Handling

```http
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/problem+json

{
  "type": "/errors/unsupported-encoding",
  "title": "Unsupported Content-Encoding",
  "status": 415,
  "code": "UNSUPPORTED_ENCODING",
  "detail": "Content-Encoding 'br' is not supported. Supported: gzip, deflate"
}
```

If decompression fails (corrupt data):

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "/errors/decompression-failed",
  "title": "Decompression Failed",
  "status": 400,
  "code": "DECOMPRESSION_FAILED",
  "detail": "Failed to decompress gzip body"
}
```

## Protocol Changes

Add to PROTOCOL.md Section 5.2 (Append to Stream):

```markdown
#### Request Compression

Servers SHOULD support compressed request bodies using the `Content-Encoding`
header.

**Supported Encodings:**
- `gzip` - SHOULD support
- `deflate` - SHOULD support
- `identity` - MUST support (no compression)

**Request Headers:**
- `Content-Encoding: <encoding>`
  - Indicates the body is compressed
  - `Content-Type` refers to the decompressed content

**Response Codes:**
- `415 Unsupported Media Type`: Server does not support the encoding
- `400 Bad Request`: Decompression failed (corrupt/invalid compressed data)

Note: Compression is transport-only. Servers store data decompressed and
compress responses independently based on `Accept-Encoding`.
```

## Conformance Tests

### Server Conformance

```yaml
- id: append-gzip-compressed
  description: Server accepts gzip-compressed POST body
  operations:
    - action: create
      path: ${streamPath}
      contentType: application/json
    - action: append
      path: ${streamPath}
      data: '[{"event": "test", "data": "some longer content to make compression worthwhile"}]'
      compress: gzip  # Test harness compresses before sending
      expect:
        status: 204
    - action: read
      path: ${streamPath}
      expect:
        chunks:
          - data: '{"event": "test", "data": "some longer content to make compression worthwhile"}'

- id: append-unsupported-encoding
  description: Server returns 415 for unsupported encoding
  operations:
    - action: create
      path: ${streamPath}
    - action: append
      path: ${streamPath}
      data: "test"
      headers:
        Content-Encoding: "br"  # Brotli - may not be supported
      expect:
        status: 415
        errorCode: UNSUPPORTED_ENCODING

- id: append-corrupt-gzip
  description: Server returns 400 for corrupt compressed data
  operations:
    - action: create
      path: ${streamPath}
    - action: append
      path: ${streamPath}
      data: "not actually gzipped data"
      headers:
        Content-Encoding: "gzip"
      expect:
        status: 400
        errorCode: DECOMPRESSION_FAILED
```

### Client Conformance

Clients MAY support sending compressed bodies:
- SHOULD compress bodies larger than a threshold (e.g., 1KB)
- MUST set `Content-Encoding` header when compressing
- SHOULD prefer `gzip` for widest compatibility

## Error Codes

Add to error codes table:

| type | code | status | title |
|------|------|--------|-------|
| `/errors/unsupported-encoding` | `UNSUPPORTED_ENCODING` | 415 | Unsupported Content-Encoding |
| `/errors/decompression-failed` | `DECOMPRESSION_FAILED` | 400 | Decompression Failed |

## Implementation Notes

- Most HTTP frameworks handle `Content-Encoding` automatically
- Node.js: `zlib.gunzip()` / `zlib.inflate()`
- Go: `compress/gzip`, `compress/flate`
- Decompression should have size limits to prevent zip bombs

## References

- [RFC 9110: HTTP Semantics - Content-Encoding](https://www.rfc-editor.org/rfc/rfc9110#field.content-encoding)
- [MDN: Content-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Encoding)
