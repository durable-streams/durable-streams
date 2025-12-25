# Error Message Standards Proposal for Durable Streams

**Date:** 2025-01-XX
**Status:** Draft
**Author:** Research Summary

---

## Executive Summary

This document proposes error message standards for Durable Streams servers that can be enforced through conformance tests. Based on industry standards research, we present three options ranging from minimal to comprehensive, each with trade-offs in complexity, interoperability, and developer experience.

## Industry Standards Research

### 1. RFC 9457: Problem Details for HTTP APIs

RFC 9457 (successor to RFC 7807) is the current industry standard for HTTP API error responses. It defines a structured JSON format with the media type `application/problem+json`.

**Standard Fields:**
- `type` (string, URI): Identifies the problem type (e.g., `https://durable-streams.dev/errors/not-found`)
- `title` (string): Short, human-readable summary (e.g., "Stream Not Found")
- `status` (integer): HTTP status code (e.g., `404`)
- `detail` (string): Detailed explanation specific to this occurrence
- `instance` (string, URI): Reference to the specific occurrence of the problem

**Example:**
```json
{
  "type": "https://durable-streams.dev/errors/sequence-conflict",
  "title": "Sequence Conflict",
  "status": 409,
  "detail": "Stream-Seq header value '42' is less than or equal to the last appended sequence '50'",
  "instance": "/streams/my-stream"
}
```

**Key Benefits:**
- Extensible with custom fields (clients ignore unknown fields)
- Machine-readable AND human-readable
- Well-documented, widely adopted standard
- Multiple language implementations available

**Sources:**
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
- [Problem Details RFC 9457: Doing API Errors Well](https://swagger.io/blog/problem-details-rfc9457-doing-api-errors-well/)

### 2. Google API / gRPC Error Model

Google's API design guide uses a structured error model based on gRPC status codes. It's widely used in cloud APIs and defines both canonical error codes and rich error details.

**Standard Status Codes (numeric 0-16):**
| Code | Name | HTTP | Description |
|------|------|------|-------------|
| 0 | OK | 200 | Success |
| 1 | CANCELLED | 499 | Request cancelled by client |
| 2 | UNKNOWN | 500 | Unknown error |
| 3 | INVALID_ARGUMENT | 400 | Invalid argument provided |
| 4 | DEADLINE_EXCEEDED | 504 | Operation timed out |
| 5 | NOT_FOUND | 404 | Resource not found |
| 6 | ALREADY_EXISTS | 409 | Resource already exists |
| 7 | PERMISSION_DENIED | 403 | Permission denied |
| 8 | RESOURCE_EXHAUSTED | 429 | Quota/rate limit exceeded |
| 9 | FAILED_PRECONDITION | 400 | Precondition failed |
| 10 | ABORTED | 409 | Operation aborted (concurrency conflict) |
| 11 | OUT_OF_RANGE | 400 | Value out of valid range |
| 12 | UNIMPLEMENTED | 501 | Operation not implemented |
| 13 | INTERNAL | 500 | Internal server error |
| 14 | UNAVAILABLE | 503 | Service unavailable |
| 15 | DATA_LOSS | 500 | Unrecoverable data loss |
| 16 | UNAUTHENTICATED | 401 | Authentication failed |

**Standard Detail Types:**
- `ErrorInfo`: reason, domain, metadata
- `BadRequest`: field_violations with field and description
- `PreconditionFailure`: violations with type, subject, description
- `QuotaFailure`: quota violations
- `ResourceInfo`: resource_type, resource_name, owner, description
- `LocalizedMessage`: locale and message
- `Help`: links with description and URL

**Sources:**
- [gRPC Status Codes](https://grpc.io/docs/guides/status-codes/)
- [Google AIP-193: Errors](https://google.aip.dev/193)

### 3. Best Practices Summary

From multiple sources, modern API error handling should:

1. **Be Structured**: Use JSON with consistent field names (not just plain text)
2. **Be Machine-Readable**: Include error codes for programmatic handling
3. **Be Human-Readable**: Include descriptive messages for debugging
4. **Be Actionable**: Explain what went wrong AND how to fix it
5. **Be Consistent**: All errors follow the same format
6. **Be Secure**: Never leak internal details (stack traces, DB schemas)
7. **Be Extensible**: Allow custom fields while maintaining compatibility

---

## Current Durable Streams Error Handling

### Server Responses (Current)

Currently, durable streams servers return **plain text** error responses:

```http
HTTP/1.1 404 Not Found
Content-Type: text/plain

Stream not found
```

```http
HTTP/1.1 409 Conflict
Content-Type: text/plain

Sequence conflict
```

### Client Error Codes (Current)

The TypeScript client defines `DurableStreamErrorCode`:

```typescript
type DurableStreamErrorCode =
  | 'NOT_FOUND'           // 404
  | 'CONFLICT_SEQ'        // 409 - Sequence conflict
  | 'CONFLICT_EXISTS'     // 409 - Stream exists with different config
  | 'BAD_REQUEST'         // 400
  | 'BUSY'                // 503
  | 'UNAUTHORIZED'        // 401
  | 'FORBIDDEN'           // 403
  | 'RATE_LIMITED'        // 429
  | 'SSE_NOT_SUPPORTED'   // Client-side
  | 'ALREADY_CONSUMED'    // Client-side
  | 'ALREADY_CLOSED'      // Client-side
  | 'UNKNOWN'
```

### Conformance Test Error Codes (Current)

```typescript
const ErrorCodes = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  CONFLICT: 'CONFLICT',
  NOT_FOUND: 'NOT_FOUND',
  SEQUENCE_CONFLICT: 'SEQUENCE_CONFLICT',
  INVALID_OFFSET: 'INVALID_OFFSET',
  UNEXPECTED_STATUS: 'UNEXPECTED_STATUS',
  PARSE_ERROR: 'PARSE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
}
```

---

## Proposed Options

### Option A: Minimal - Standardized Plain Text with Error Codes

**Philosophy:** Keep the protocol simple with plain text errors, but standardize error messages so they can be parsed reliably.

**Server Response Format:**
```http
HTTP/1.1 409 Conflict
Content-Type: text/plain
X-Error-Code: SEQUENCE_CONFLICT

Sequence conflict: Stream-Seq '42' <= last seq '50'
```

**Specification:**

1. **Error Code Header**: Servers MUST include `X-Error-Code` header with a standardized code
2. **Message Format**: `<Title>: <Details>` or just `<Title>` if no details
3. **Standardized Codes**:

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 400 | `BAD_REQUEST` | Generic bad request |
| 400 | `INVALID_OFFSET` | Malformed offset parameter |
| 400 | `INVALID_TTL` | Invalid TTL header |
| 400 | `INVALID_JSON` | Invalid JSON body |
| 400 | `EMPTY_BODY` | Empty request body where body required |
| 400 | `EMPTY_ARRAY` | Empty JSON array in append |
| 401 | `UNAUTHENTICATED` | Authentication required |
| 403 | `PERMISSION_DENIED` | Not authorized |
| 404 | `NOT_FOUND` | Stream does not exist |
| 409 | `ALREADY_EXISTS` | Stream exists with different config |
| 409 | `SEQUENCE_CONFLICT` | Stream-Seq regression |
| 409 | `CONTENT_TYPE_MISMATCH` | Content-Type doesn't match stream |
| 410 | `OFFSET_EXPIRED` | Offset before retention window |
| 413 | `PAYLOAD_TOO_LARGE` | Body exceeds size limit |
| 429 | `RATE_LIMITED` | Too many requests |
| 501 | `NOT_IMPLEMENTED` | Operation not supported |
| 503 | `UNAVAILABLE` | Server temporarily unavailable |

**Conformance Test Requirements:**
- Server MUST return `X-Error-Code` header on all 4xx/5xx responses
- Error code MUST be from the standardized list
- HTTP status MUST match the code's expected status

**Pros:**
- Minimal change from current implementation
- Low overhead (no JSON parsing)
- Simple for servers to implement
- Backward compatible (existing clients can still parse text)

**Cons:**
- Less rich than structured formats
- Custom header instead of standard body format
- Harder to extend with additional metadata

---

### Option B: RFC 9457 Problem Details (Recommended)

**Philosophy:** Adopt the industry-standard RFC 9457 format for structured, extensible error responses.

**Server Response Format:**
```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "https://durable-streams.dev/errors/sequence-conflict",
  "title": "Sequence Conflict",
  "status": 409,
  "detail": "Stream-Seq header value '42' is less than or equal to the last appended sequence '50'",
  "instance": "/streams/my-stream",
  "code": "SEQUENCE_CONFLICT"
}
```

**Specification:**

1. **Content-Type**: Servers MUST return `Content-Type: application/problem+json` for errors
2. **Required Fields**:
   - `type` (string): URI identifying the error type (can be relative or absolute)
   - `title` (string): Short human-readable summary
   - `status` (integer): HTTP status code (MUST match response status)
   - `code` (string): Machine-readable error code (Durable Streams extension)

3. **Optional Fields**:
   - `detail` (string): Detailed explanation for this specific error
   - `instance` (string): The stream URL or path that triggered the error

4. **Durable Streams Extensions** (optional but recommended):
   - `code` (string): Standardized error code from the list below
   - `streamSeq` (string): For sequence conflicts, the conflicting sequence values
   - `expectedContentType` (string): For content-type mismatches
   - `actualContentType` (string): For content-type mismatches
   - `retryAfter` (integer): Seconds to wait before retrying (for 429/503)

**Standardized Error Types & Codes:**

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

**Conformance Test Requirements:**

1. **Format Validation**:
   - Response MUST have `Content-Type: application/problem+json`
   - Body MUST be valid JSON
   - MUST include `type`, `title`, `status`, and `code` fields
   - `status` field MUST match HTTP response status code

2. **Semantic Validation**:
   - `code` MUST be from the standardized list
   - `type` MUST correspond to `code`
   - Error scenario MUST match expected code

3. **Example Conformance Test Cases**:

```yaml
- id: append-to-nonexistent-stream
  operations:
    - action: append
      path: /nonexistent-stream
      data: "test"
      expect:
        status: 404
        errorCode: NOT_FOUND
        errorType: /errors/not-found

- id: sequence-conflict
  operations:
    - action: append
      path: ${streamPath}
      seq: 100
    - action: append
      path: ${streamPath}
      seq: 50
      expect:
        status: 409
        errorCode: SEQUENCE_CONFLICT
        errorType: /errors/sequence-conflict
```

**Pros:**
- Industry standard (RFC 9457)
- Rich, extensible format
- Machine AND human readable
- Excellent tooling support
- Future-proof

**Cons:**
- More complex than plain text
- Requires JSON parsing
- Larger response size
- Breaking change from current implementation

---

### Option C: Hybrid - Content Negotiation

**Philosophy:** Support both plain text and RFC 9457 based on client preference.

**Specification:**

1. Clients MAY send `Accept: application/problem+json` to request structured errors
2. If client accepts `application/problem+json`:
   - Server MUST return RFC 9457 format (Option B)
3. If client prefers `text/plain` or doesn't specify:
   - Server MUST return plain text with `X-Error-Code` header (Option A)

**Default Behavior:**
- When `Accept` header is missing or `*/*`: Return plain text (backward compatible)
- When `Accept: application/problem+json`: Return RFC 9457

**Example:**
```http
# Request
GET /nonexistent-stream HTTP/1.1
Accept: application/problem+json

# Response
HTTP/1.1 404 Not Found
Content-Type: application/problem+json

{
  "type": "/errors/not-found",
  "title": "Stream Not Found",
  "status": 404,
  "code": "NOT_FOUND"
}
```

```http
# Request
GET /nonexistent-stream HTTP/1.1
Accept: text/plain

# Response
HTTP/1.1 404 Not Found
Content-Type: text/plain
X-Error-Code: NOT_FOUND

Stream not found
```

**Conformance Test Requirements:**
- Server MUST support both formats
- Content negotiation MUST work correctly
- Both formats MUST return the same error code for the same scenario

**Pros:**
- Backward compatible
- Clients choose their preferred format
- Gradual migration path

**Cons:**
- Most complex to implement
- Servers must maintain two formats
- More conformance test scenarios

---

## Recommendation

**We recommend Option B (RFC 9457 Problem Details)** for the following reasons:

1. **Industry Standard**: RFC 9457 is the established standard for HTTP API errors. Following it improves interoperability with existing tools, libraries, and monitoring systems.

2. **Extensibility**: The format supports custom fields, allowing Durable Streams to add domain-specific metadata (e.g., `streamSeq`, `expectedContentType`) without breaking clients.

3. **Developer Experience**: Structured errors with both codes and messages are easier to debug and handle programmatically.

4. **Conformance Testing**: A well-defined JSON schema is easier to validate in conformance tests than parsing free-form text.

5. **Future-Proofing**: As the protocol evolves, structured errors can carry additional context without breaking changes.

**Migration Path:**
1. Add RFC 9457 support to the reference server
2. Update conformance tests to validate error format
3. Update client libraries to parse new format
4. Document the change in PROTOCOL.md

---

## Conformance Test Specification

### Error Code Verification

For each error scenario, conformance tests SHOULD verify:

1. **HTTP Status Code**: Response status matches expected status
2. **Error Code**: The `code` field (or `X-Error-Code` header) matches expected code
3. **Error Type**: The `type` field matches expected type URI
4. **Format**: Response body is valid JSON with required fields

### Test Cases to Add

| Scenario | Expected Status | Expected Code |
|----------|-----------------|---------------|
| GET non-existent stream | 404 | `NOT_FOUND` |
| POST to non-existent stream | 404 | `NOT_FOUND` |
| PUT with conflicting config | 409 | `ALREADY_EXISTS` |
| POST with seq regression | 409 | `SEQUENCE_CONFLICT` |
| POST with wrong content-type | 409 | `CONTENT_TYPE_MISMATCH` |
| GET with malformed offset | 400 | `INVALID_OFFSET` |
| POST with empty body | 400 | `EMPTY_BODY` |
| POST JSON with empty array | 400 | `EMPTY_ARRAY` |
| POST with invalid JSON | 400 | `INVALID_JSON` |
| GET expired offset | 410 | `OFFSET_EXPIRED` |
| Rate limited request | 429 | `RATE_LIMITED` |
| Server overloaded | 503 | `UNAVAILABLE` |

### Protocol Additions

Add to PROTOCOL.md Section 5 (HTTP Operations):

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
```

---

## Summary

| Option | Complexity | Standard | Breaking Change | Recommended |
|--------|------------|----------|-----------------|-------------|
| A: Plain Text + Header | Low | No | Minimal | No |
| B: RFC 9457 | Medium | Yes (RFC 9457) | Yes | **Yes** |
| C: Hybrid | High | Partial | No | No |

**Next Steps:**
1. Review and discuss this proposal
2. Choose an option (recommend B)
3. Update PROTOCOL.md with error specification
4. Implement in reference server
5. Add conformance test cases
6. Update client libraries

---

## References

- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
- [RFC 7807 is dead, long live RFC 9457](https://blog.frankel.ch/problem-details-http-apis/)
- [gRPC Status Codes](https://grpc.io/docs/guides/status-codes/)
- [Google AIP-193: Errors](https://google.aip.dev/193)
- [Zuplo: Best Practices for API Error Handling](https://zuplo.com/learning-center/best-practices-for-api-error-handling)
- [Speakeasy: Errors Best Practices in REST API Design](https://www.speakeasy.com/api-design/errors)
