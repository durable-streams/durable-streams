# Implementation Plan: Issue #32 - Optimistic Concurrency Control (OCC) Support

## Overview

This plan details the implementation of Optimistic Concurrency Control (OCC) for Durable Streams append operations using the standard HTTP `If-Match` header. OCC enables clients to detect concurrent writes by specifying an expected ETag that must match the stream's current state for the append to succeed.

## Background

### Issue Request
User @yordis requested support for the `If-Match` HTTP header on append operations to enable optimistic concurrency control for scenarios where multiple clients may write to the same stream.

### Current State
- **Read-side caching**: ✅ `If-None-Match` + `304 Not Modified` is already implemented (PROTOCOL.md Section 8.1)
- **Write-side OCC**: ❌ Not specified or implemented
- **Go client**: ⚠️ Has `WithIfMatch()` option defined but server doesn't support it
- **.NET client**: ⚠️ Has `IfMatch` constant but no actual usage

## Design Decisions

### 1. ETag Format for Writes

The protocol already uses ETags for read caching. For OCC on writes, we'll use the same ETag that represents the current tail position:

```
ETag: "<stream-next-offset>"
```

For example: `ETag: "123456_789"`

**Rationale**: Using the next-offset as the ETag provides a simple, consistent mechanism:
- After any successful append, the client receives `Stream-Next-Offset`
- The client can use this value as the `If-Match` header on subsequent appends
- If another writer appends first, the offset changes and the If-Match fails

### 2. Wildcard Support (`If-Match: *`)

The `If-Match: *` wildcard SHOULD be supported, meaning "match if the stream exists" (any current state is acceptable). This is useful for "create-or-append" semantics where the client wants to append if the stream exists.

### 3. Error Response

When the ETag doesn't match, the server returns:
- **Status**: `412 Precondition Failed`
- **Headers**:
  - `ETag: "<current-offset>"` - The actual current offset
  - `Stream-Next-Offset: <current-offset>` - Standard header for consistency
  - `Stream-Closed: true` (if applicable)

### 4. Mutual Exclusivity with Idempotent Producers

**`If-Match` and idempotent producer headers (`Producer-Id`, `Producer-Epoch`, `Producer-Seq`) are mutually exclusive.** If a request includes both `If-Match` and any producer headers, the server MUST return `400 Bad Request`.

**Rationale**: These mechanisms solve different problems and have conflicting semantics on retries:

| Mechanism | Problem Solved | Retry Behavior |
|-----------|---------------|----------------|
| Idempotent Producers | Safe retries from same writer | Retries succeed (deduplicated) |
| OCC (If-Match) | Detect concurrent writes | Retries may fail (offset changed) |

If both were allowed, a retry of a successful request would fail with `412` because the offset changed after the original request succeeded. This breaks the retry safety that idempotent producers are designed to provide.

**Use case guidance**:
- **Single writer, unreliable network**: Use idempotent producers
- **Multiple writers, conflict detection**: Use OCC (If-Match)
- **Multiple writers with retry safety**: Use idempotent producers with application-level conflict resolution

### 5. Validation Order

OCC validation should occur **after** basic validation but **before** the actual append:

1. Stream exists (404 if not)
2. Stream not closed (409 if closed, with `Stream-Closed: true`)
3. Content-Type matches (409 if mismatch)
4. **If-Match + Producer headers mutual exclusivity check (400 if both provided)** ← New
5. Producer headers valid OR If-Match validation (not both)
6. Perform append

---

## Implementation Tasks

### Phase 1: Protocol Specification

#### Task 1.1: Update PROTOCOL.md

Add OCC documentation to Section 5.2 (Append to Stream):

**Location**: After the existing Request Headers section (~line 218)

**New content to add**:

```markdown
- `If-Match: <etag>` (optional)
  - Enables optimistic concurrency control. The append will only succeed if the
    stream's current ETag matches the provided value.
  - The ETag corresponds to the stream's current tail offset (the value that would
    be returned in `Stream-Next-Offset` for a HEAD request).
  - Format: `If-Match: "<offset>"` (quoted string per HTTP spec)
  - `If-Match: *` matches any existing stream state (useful for "append if exists")
  - If the ETag does not match, the server MUST return `412 Precondition Failed`
    with the current ETag in the response headers.
  - **MUST NOT** be used together with idempotent producer headers (`Producer-Id`,
    `Producer-Epoch`, `Producer-Seq`). If both `If-Match` and any producer header
    are present, servers MUST return `400 Bad Request`.
```

Add to Response Codes section:

```markdown
- `412 Precondition Failed`: `If-Match` header provided but ETag does not match
  the stream's current state
```

Add new section for 412 response:

```markdown
#### Response Headers (on 412 Precondition Failed)

When an append fails due to `If-Match` precondition:

- `412 Precondition Failed` status code
- `ETag: "<current-offset>"`: The stream's current ETag (tail offset)
- `Stream-Next-Offset: <offset>`: The current tail offset
- `Stream-Closed: true` (if applicable): Present if the stream is closed

This allows clients to detect concurrent modifications and decide how to handle
the conflict (retry with new offset, merge, or abort).
```

Update Error Precedence section to include OCC:

```markdown
**Error Precedence:** When an append request would trigger multiple error conditions,
servers SHOULD check in this order:

1. Stream does not exist → `404 Not Found`
2. Stream closed → `409 Conflict` with `Stream-Closed: true`
3. Content type mismatch → `409 Conflict`
4. If-Match precondition failed → `412 Precondition Failed`
5. Producer validation errors → `400`/`403`/`409` as appropriate
6. Sequence regression → `409 Conflict`
```

---

### Phase 2: Server Implementation

#### Task 2.1: Go Server (caddy-plugin) - `packages/caddy-plugin/handler.go`

**File**: `packages/caddy-plugin/handler.go`

1. **Add If-Match to CORS headers** (~line 49):
   ```go
   // Current: "If-None-Match"
   // Change to: "If-Match, If-None-Match"
   ```

2. **Add If-Match handling in `handleAppend()`** (~line 700, after stream existence/closure checks):
   ```go
   // Check If-Match for optimistic concurrency control
   if ifMatch := r.Header.Get("If-Match"); ifMatch != "" {
       currentETag := fmt.Sprintf(`"%s"`, stream.NextOffset().String())

       // Handle wildcard
       if ifMatch != "*" && ifMatch != currentETag {
           w.Header().Set("ETag", currentETag)
           w.Header().Set("Stream-Next-Offset", stream.NextOffset().String())
           if stream.IsClosed() {
               w.Header().Set("Stream-Closed", "true")
           }
           w.WriteHeader(http.StatusPreconditionFailed)
           return nil
       }
   }
   ```

3. **Update store interface** (if needed) to expose atomic check-and-append

#### Task 2.2: TypeScript Server - `packages/server/src/server.ts`

**File**: `packages/server/src/server.ts`

Add If-Match handling in the append handler (after closure check):

```typescript
// Check If-Match for optimistic concurrency control
const ifMatch = req.headers['if-match']
if (ifMatch) {
  const currentOffset = stream.getNextOffset()
  const currentETag = `"${currentOffset}"`

  if (ifMatch !== '*' && ifMatch !== currentETag) {
    res.setHeader('ETag', currentETag)
    res.setHeader('Stream-Next-Offset', currentOffset)
    if (stream.isClosed()) {
      res.setHeader('Stream-Closed', 'true')
    }
    res.writeHead(412)
    res.end()
    return
  }
}
```

---

### Phase 3: Conformance Tests

#### Task 3.1: Create OCC test cases

**File**: `packages/server-conformance-tests/test-cases/occ.yaml` (new file)

```yaml
name: Optimistic Concurrency Control (OCC)
description: Tests for If-Match header support on append operations

tests:
  # Basic If-Match success
  - name: append with matching If-Match succeeds
    steps:
      - action: create
        stream: /test/occ-match
        contentType: application/json
      - action: head
        stream: /test/occ-match
        expect:
          status: 200
          headers:
            Stream-Next-Offset: present
      - action: append
        stream: /test/occ-match
        headers:
          If-Match: '"${Stream-Next-Offset}"'
        body: '{"event": "first"}'
        expect:
          status: [200, 204]

  # If-Match failure due to stale ETag
  - name: append with stale If-Match returns 412
    steps:
      - action: create
        stream: /test/occ-stale
        contentType: application/json
      - action: append
        stream: /test/occ-stale
        body: '{"event": "first"}'
      - action: append
        stream: /test/occ-stale
        headers:
          If-Match: '"0"'  # Stale offset
        body: '{"event": "second"}'
        expect:
          status: 412
          headers:
            ETag: present
            Stream-Next-Offset: present

  # Wildcard If-Match
  - name: append with If-Match wildcard succeeds
    steps:
      - action: create
        stream: /test/occ-wildcard
        contentType: application/json
      - action: append
        stream: /test/occ-wildcard
        body: '{"event": "first"}'
      - action: append
        stream: /test/occ-wildcard
        headers:
          If-Match: '*'
        body: '{"event": "second"}'
        expect:
          status: [200, 204]

  # If-Match on non-existent stream
  - name: append with If-Match to non-existent stream returns 404
    steps:
      - action: append
        stream: /test/occ-nonexistent
        headers:
          If-Match: '"0"'
        body: '{"event": "test"}'
        expect:
          status: 404

  # If-Match on closed stream
  - name: append with If-Match to closed stream returns 409 (closure takes precedence)
    steps:
      - action: create
        stream: /test/occ-closed
        contentType: application/json
        closed: true
      - action: append
        stream: /test/occ-closed
        headers:
          If-Match: '"0"'
        body: '{"event": "test"}'
        expect:
          status: 409
          headers:
            Stream-Closed: "true"

  # Concurrent write simulation
  - name: second writer fails with 412 after first writer appends
    steps:
      - action: create
        stream: /test/occ-concurrent
        contentType: application/json
      - action: head
        stream: /test/occ-concurrent
        saveAs: initialState
      - action: append
        stream: /test/occ-concurrent
        body: '{"writer": "first"}'
      - action: append
        stream: /test/occ-concurrent
        headers:
          If-Match: '"${initialState.Stream-Next-Offset}"'
        body: '{"writer": "second"}'
        expect:
          status: 412

  # 412 response includes current ETag for retry
  - name: 412 response includes current ETag
    steps:
      - action: create
        stream: /test/occ-etag-response
        contentType: application/json
      - action: append
        stream: /test/occ-etag-response
        body: '{"event": "first"}'
      - action: head
        stream: /test/occ-etag-response
        saveAs: currentState
      - action: append
        stream: /test/occ-etag-response
        headers:
          If-Match: '"stale-offset"'
        body: '{"event": "retry"}'
        expect:
          status: 412
          headers:
            Stream-Next-Offset: ${currentState.Stream-Next-Offset}

  # Mutual exclusivity with idempotent producers
  - name: If-Match with producer headers returns 400
    steps:
      - action: create
        stream: /test/occ-producer-conflict
        contentType: application/json
      - action: head
        stream: /test/occ-producer-conflict
        saveAs: currentState
      - action: append
        stream: /test/occ-producer-conflict
        headers:
          If-Match: '"${currentState.Stream-Next-Offset}"'
          Producer-Id: "test-producer"
          Producer-Epoch: "0"
          Producer-Seq: "0"
        body: '{"event": "conflict"}'
        expect:
          status: 400
```

---

### Phase 4: Client Implementation

#### Task 4.1: TypeScript Client - `packages/client/`

Add `ifMatch` option to append:

```typescript
interface AppendOptions {
  // ... existing options
  ifMatch?: string;
}

async append(data: T, options?: AppendOptions): Promise<AppendResult> {
  const headers: Record<string, string> = {};
  // ... existing header setup

  if (options?.ifMatch) {
    headers['If-Match'] = options.ifMatch;
  }

  // ... rest of append logic
}
```

Add error handling for 412:

```typescript
if (response.status === 412) {
  const currentETag = response.headers.get('ETag');
  const currentOffset = response.headers.get('Stream-Next-Offset');
  throw new PreconditionFailedError(currentETag, currentOffset);
}
```

#### Task 4.2: Python Client - `packages/client-py/`

Add `if_match` parameter to append method:

```python
def append(
    self,
    data: Any,
    *,
    if_match: Optional[str] = None,
    # ... other params
) -> AppendResult:
    headers = {}
    if if_match:
        headers["If-Match"] = if_match
    # ... rest of implementation
```

#### Task 4.3: Go Client - `packages/client-go/`

The Go client already has `WithIfMatch()` option defined. Verify it works correctly and add error handling for 412 response.

#### Task 4.4: Other Clients

Update remaining clients with If-Match support:
- `packages/client-elixir/`
- `packages/client-dotnet/` (complete the partial implementation)
- `packages/client-swift/`
- `packages/client-php/`
- `packages/client-java/`
- `packages/client-rust/`
- `packages/client-rb/`

---

### Phase 5: Client Conformance Tests

#### Task 5.1: Add OCC tests to client conformance suite

**File**: `packages/client-conformance-tests/test-cases/occ.yaml`

```yaml
name: Client OCC Support
description: Tests that clients correctly handle If-Match for OCC

tests:
  - name: client sends If-Match header when specified
    steps:
      - action: createStream
        contentType: application/json
      - action: append
        data: {"event": "first"}
      - action: getNextOffset
        saveAs: currentOffset
      - action: appendWithIfMatch
        ifMatch: ${currentOffset}
        data: {"event": "second"}
        expect:
          success: true

  - name: client handles 412 Precondition Failed
    steps:
      - action: createStream
        contentType: application/json
      - action: append
        data: {"event": "first"}
      - action: appendWithIfMatch
        ifMatch: "stale-offset"
        data: {"event": "will-fail"}
        expect:
          error: PreconditionFailed
          currentOffset: present
```

---

## Checklist Summary

### Protocol
- [ ] Update PROTOCOL.md with If-Match header documentation
- [ ] Add 412 Precondition Failed to response codes
- [ ] Document mutual exclusivity with idempotent producers
- [ ] Document error precedence including OCC
- [ ] Update IANA headers section if needed

### Servers
- [ ] Implement If-Match handling in caddy-plugin (Go)
- [ ] Implement If-Match handling in server (TypeScript)
- [ ] Add If-Match to CORS Allow-Headers
- [ ] Validate mutual exclusivity: If-Match + Producer headers → 400

### Conformance Tests
- [ ] Create server conformance tests for OCC (occ.yaml)
- [ ] Create client conformance tests for OCC

### Clients
- [ ] TypeScript client: Add ifMatch option + 412 handling
- [ ] Python client: Add if_match parameter + 412 handling
- [ ] Go client: Verify existing WithIfMatch() + add 412 handling
- [ ] Elixir client: Add if_match option + 412 handling
- [ ] .NET client: Complete implementation + 412 handling
- [ ] Swift client: Add ifMatch option + 412 handling
- [ ] PHP client: Add if_match option + 412 handling
- [ ] Java client: Add ifMatch option + 412 handling
- [ ] Rust client: Add if_match option + 412 handling
- [ ] Ruby client: Add if_match option + 412 handling

---

## Implementation Order

1. **Protocol specification** - Document the behavior first
2. **Server conformance tests** - Write failing tests
3. **Go server (caddy-plugin)** - Primary server implementation
4. **TypeScript server** - Development server implementation
5. **Client conformance tests** - Write client test cases
6. **TypeScript client** - Reference client implementation
7. **Other clients** - Implement remaining language clients

---

## Open Questions

1. **Atomicity**: Should OCC check + append be atomic at the store level, or is HTTP-level serialization sufficient?
   - **Recommendation**: HTTP-level serialization is sufficient for most use cases. Document that concurrent requests to the same stream may be serialized.

2. **ETag format**: Should we use quoted strings (`"offset"`) or unquoted?
   - **Recommendation**: Use quoted strings per HTTP specification (RFC 9110 Section 8.8.3)

3. **Interaction with idempotent producers**: How does If-Match interact with `Producer-Id/Epoch/Seq`?
   - **Decision**: They are mutually exclusive. Requests with both `If-Match` and producer headers return `400 Bad Request`. See Design Decision #4 for rationale.

---

## References

- HTTP Conditional Requests: [RFC 9110 Section 13](https://www.rfc-editor.org/rfc/rfc9110#section-13)
- ETag format: [RFC 9110 Section 8.8.3](https://www.rfc-editor.org/rfc/rfc9110#section-8.8.3)
- 412 Precondition Failed: [RFC 9110 Section 15.5.13](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.13)
