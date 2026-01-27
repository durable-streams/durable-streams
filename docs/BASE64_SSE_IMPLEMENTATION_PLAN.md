# Base64 SSE Encoding Implementation Plan

This document outlines the implementation plan for adding base64 encoding support to SSE streams, enabling binary content delivery over Server-Sent Events.

## Protocol Summary

Per PROTOCOL.md Section 5.7:

- **Native SSE**: `text/*` and `application/json` streams work without encoding
- **Binary SSE**: All other content types require `encoding=base64`
- **Validation**: Servers return 400 if encoding is missing for binary or present for text/json
- **Format**: RFC 4648 standard base64 (A-Z, a-z, 0-9, +, /)
- **Multi-line**: Clients must remove `\n` and `\r` before decoding
- **Scope**: Only `event: data` is encoded; `event: control` remains JSON

---

## Phase 1: Test Infrastructure

### 1.1 Extend Test Case Types

**File:** `packages/client-conformance-tests/src/test-cases.ts`

Add `encoding` parameter to `ReadOperation`:

```typescript
export interface ReadOperation {
  action: `read`
  path: string
  offset?: string
  live?: false | `long-poll` | `sse`
  encoding?: `base64` // NEW
  // ...
}
```

Add to `ReadExpectation`:

```typescript
export interface ReadExpectation extends BaseExpectation {
  // ... existing fields
  responseHeaders?: Record<string, string> // Verify response headers
}
```

Note: Binary data can be verified using the existing `data` field - adapters return
base64 strings with `binary: true` flag on chunks.

---

## Phase 2: Server Conformance Tests

**File:** `packages/server-conformance-tests/src/index.ts`

### Tests to Add

| Test ID                           | Description                                                |
| --------------------------------- | ---------------------------------------------------------- |
| `sse-base64-required-for-binary`  | 400 when `encoding` missing for `application/octet-stream` |
| `sse-base64-forbidden-for-text`   | 400 when `encoding=base64` provided for `text/plain`       |
| `sse-base64-forbidden-for-json`   | 400 when `encoding=base64` provided for `application/json` |
| `sse-base64-unsupported-encoding` | 400 when `encoding=foo` (unsupported value)                |
| `sse-base64-encodes-binary-data`  | Binary stream with `encoding=base64` returns valid base64  |
| `sse-base64-response-header`      | Response includes `stream-sse-data-encoding: base64`       |
| `sse-base64-multiline-decodes`    | Multi-line base64 decodes correctly after `\n\r` removal   |
| `sse-base64-empty-payload`        | Zero-length payload returns empty string                   |
| `sse-base64-control-not-encoded`  | Control events remain JSON (not base64)                    |

---

## Phase 3: Client Conformance Tests

**File:** `packages/client-conformance-tests/test-cases/consumer/read-sse-base64.yaml` (new)

### Tests to Add

| Test ID                        | Description                                        |
| ------------------------------ | -------------------------------------------------- |
| `sse-base64-decodes-binary`    | Client decodes base64 binary data correctly        |
| `sse-base64-multiline-concat`  | Client removes `\n` and `\r` before decoding       |
| `sse-base64-preserves-control` | Control events parsed as JSON (not decoded)        |
| `sse-base64-empty-binary`      | Empty binary payload handled correctly             |
| `sse-base64-client-validation` | Client rejects `encoding` for text streams locally |

---

## Phase 4: Server Implementations

### 4.1 Reference Server (TypeScript)

**File:** `packages/server/src/server.ts`

**Changes:**

1. Parse `encoding` query parameter (~line 680)
2. Validate encoding vs content-type compatibility
3. Add `stream-sse-data-encoding` response header
4. Base64 encode data in `handleSSE()` when `encoding=base64`

### 4.2 Caddy Plugin (Go)

**File:** `packages/caddy-plugin/handler.go`

**Changes:**

1. Parse `encoding` query parameter
2. Update content-type validation (~line 451)
3. Add response header
4. Base64 encode in `handleSSE()` (~line 493)

---

## Phase 5: Client Implementations (Not Yet Implemented)

> **Status**: Phase 5 is planned but not yet implemented. This PR includes Phases 1-4 only.
> Client implementations will be added in a follow-up PR.

### Client Inventory

| Client          | Language   | SSE Parser File                 | Base64 Support             |
| --------------- | ---------- | ------------------------------- | -------------------------- |
| `client`        | TypeScript | `src/sse.ts`                    | Needs implementation       |
| `client-py`     | Python     | `_sse.py`                       | Needs implementation       |
| `client-go`     | Go         | `internal/sse/parser.go`        | Needs implementation       |
| `client-dotnet` | C#         | `Sse/SseParser.cs`              | Needs implementation       |
| `client-elixir` | Elixir     | `lib/durable_streams/stream.ex` | **Already exists**         |
| `client-java`   | Java       | `internal/sse/SSEParser.java`   | Needs implementation       |
| `client-php`    | PHP        | `StreamResponse.php`            | **Needs SSE parser first** |
| `client-rb`     | Ruby       | `sse_reader.rb`                 | Needs implementation       |
| `client-rust`   | Rust       | `src/iterator.rs`               | Needs implementation       |
| `client-swift`  | Swift      | `SSEParser.swift`               | Needs implementation       |

### Implementation Pattern

For each client:

1. **Add encoding option** to stream/read API
2. **Pass encoding param** in SSE URL construction
3. **Decode in SSE parser**:
   - Concatenate multi-line data
   - Remove `\n` and `\r` characters
   - Base64 decode to bytes
4. **Return decoded bytes** to consumer

### 5.1 TypeScript Client

**Files:** `packages/client/src/sse.ts`, `stream-api.ts`

```typescript
// In parseSSEStream, after collecting data lines:
if (options?.encoding === `base64`) {
  const cleaned = dataStr.replace(/[\n\r]/g, ``)
  const bytes = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0))
  yield { type: `data`, data: dataStr, rawBytes: bytes }
}
```

### 5.2 Python Client

**File:** `packages/client-py/src/durable_streams/_sse.py`

```python
# In _emit_event, after joining data lines:
if self._encoding == "base64":
    cleaned = data_str.replace("\n", "").replace("\r", "")
    raw_bytes = base64.b64decode(cleaned)
    return SSEDataEvent(data=data_str, raw_bytes=raw_bytes)
```

### 5.3 Go Client

**File:** `packages/client-go/internal/sse/parser.go`

```go
// In flushEvent, for data events:
if p.encoding == "base64" {
    cleaned := strings.ReplaceAll(dataStr, "\n", "")
    cleaned = strings.ReplaceAll(cleaned, "\r", "")
    rawBytes, err := base64.StdEncoding.DecodeString(cleaned)
    if err != nil {
        return nil, fmt.Errorf("invalid base64: %w", err)
    }
    return DataEvent{Data: dataStr, RawBytes: rawBytes}, nil
}
```

### 5.4 C#/.NET Client

**File:** `packages/client-dotnet/src/DurableStreams/Sse/SseParser.cs`

```csharp
// In FlushEvent, after collecting data:
if (_encoding == "base64") {
    var cleaned = data.Replace("\n", "").Replace("\r", "");
    var rawBytes = Convert.FromBase64String(cleaned);
    return new SseDataEvent(data, rawBytes);
}
```

### 5.5 Elixir Client

**File:** `packages/client-elixir/lib/durable_streams/stream.ex`

Already has base64 decoding via `Base.decode64()`. Verify it:

- Handles `\n` and `\r` removal
- Works with encoding parameter

### 5.6 Java Client

**File:** `packages/client-java/src/main/java/com/durablestreams/internal/sse/SSEParser.java`

```java
// After collecting data:
if ("base64".equals(encoding)) {
    String cleaned = data.toString().replace("\n", "").replace("\r", "");
    byte[] rawBytes = Base64.getDecoder().decode(cleaned);
    return new SSEEvent(eventType, data.toString(), rawBytes);
}
```

### 5.7 PHP Client

**File:** `packages/client-php/src/StreamResponse.php`

PHP client needs an SSE parser first. Then add:

```php
if ($encoding === 'base64') {
    $cleaned = str_replace(["\n", "\r"], '', $data);
    $rawBytes = base64_decode($cleaned, true);
}
```

### 5.8 Ruby Client

**File:** `packages/client-rb/lib/durable_streams/sse_reader.rb`

```ruby
# In parse_sse_event, after extracting data:
if @encoding == 'base64'
  cleaned = data.gsub(/[\n\r]/, '')
  raw_bytes = Base64.strict_decode64(cleaned)
end
```

### 5.9 Rust Client

**File:** `packages/client-rust/src/iterator.rs`

```rust
// In next_sse_chunk, for data events:
if self.encoding == Some("base64") {
    let cleaned: String = data.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    let raw_bytes = base64::engine::general_purpose::STANDARD.decode(&cleaned)?;
    return Ok(Some(Chunk::Data { data: raw_bytes.into(), ... }));
}
```

### 5.10 Swift Client

**File:** `packages/client-swift/Sources/DurableStreams/SSEParser.swift`

```swift
// In parse(), after collecting data:
if encoding == "base64" {
    let cleaned = data.replacingOccurrences(of: "\n", with: "")
                      .replacingOccurrences(of: "\r", with: "")
    if let rawBytes = Data(base64Encoded: cleaned) {
        // Use rawBytes
    }
}
```

---

## Implementation Order

```
Phase 1: Test Infrastructure ✅ COMPLETE
├── 1.1 Extend test-cases.ts types
│
Phase 2: Server Conformance Tests ✅ COMPLETE
├── 2.1 Add base64 SSE tests to server-conformance-tests
│
Phase 3: Client Conformance Tests ✅ COMPLETE
├── 3.1 Create read-sse-base64.yaml
│
Phase 4: Server Implementations ✅ COMPLETE
├── 4.1 Reference server (packages/server)
├── 4.2 Caddy plugin (packages/caddy-plugin)
│   └── Server conformance tests now pass
│
Phase 5: Client Implementations ⏳ PENDING (follow-up PR)
├── 5.1 TypeScript (reference)
├── 5.2 Python
├── 5.3 Go
├── 5.4 C#/.NET
├── 5.5 Elixir (verify existing)
├── 5.6 Java
├── 5.7 PHP (needs SSE parser)
├── 5.8 Ruby
├── 5.9 Rust
├── 5.10 Swift
│   └── Client conformance tests will pass after implementation
```

---

## Verification Commands

```bash
# Run all conformance tests
pnpm test:run

# Run server conformance tests only
cd packages/server-conformance-tests && pnpm test

# Run specific client
pnpm test:run -- --client typescript
pnpm test:run -- --client python
pnpm test:run -- --client go
pnpm test:run -- --client dotnet
pnpm test:run -- --client elixir
pnpm test:run -- --client java
pnpm test:run -- --client php
pnpm test:run -- --client ruby
pnpm test:run -- --client rust
pnpm test:run -- --client swift

# Run Caddy plugin tests
cd packages/caddy-plugin && go test ./...
```

---

## Files Modified Summary

### This PR (Phases 1-4)

| Package                    | Files                                      | Changes                          |
| -------------------------- | ------------------------------------------ | -------------------------------- |
| `client-conformance-tests` | `src/test-cases.ts`                        | Add `encoding` to ReadOperation  |
| `client-conformance-tests` | `test-cases/consumer/read-sse-base64.yaml` | New file                         |
| `server-conformance-tests` | `src/index.ts`                             | Add 9 base64 SSE tests           |
| `server`                   | `src/server.ts`                            | Query validation, encoding logic |
| `caddy-plugin`             | `handler.go`                               | Query validation, encoding logic |

### Follow-up PR (Phase 5 - Client Implementations)

| Package         | Files                         | Changes                    |
| --------------- | ----------------------------- | -------------------------- |
| `client`        | `src/sse.ts`, `stream-api.ts` | Base64 decoding            |
| `client-py`     | `_sse.py`                     | Base64 decoding            |
| `client-go`     | `internal/sse/parser.go`      | Base64 decoding            |
| `client-dotnet` | `Sse/SseParser.cs`            | Base64 decoding            |
| `client-elixir` | `stream.ex`                   | Verify existing, add param |
| `client-java`   | `SSEParser.java`              | Base64 decoding            |
| `client-php`    | `StreamResponse.php`          | SSE parser + base64        |
| `client-rb`     | `sse_reader.rb`               | Base64 decoding            |
| `client-rust`   | `iterator.rs`                 | Base64 decoding            |
| `client-swift`  | `SSEParser.swift`             | Base64 decoding            |
