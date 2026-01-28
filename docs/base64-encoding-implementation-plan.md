# Base64 Encoding for SSE - Implementation Plan

## Overview

This document describes the implementation plan for adding base64 encoding support for SSE with binary streams, as specified in PROTOCOL.md Section 5.7.

## Reference Documentation

- **Protocol Spec:** `PROTOCOL.md` (Section 5.7, lines 458-539)
- **Testing Guide:** `docs/testing-guide.md`

## Decisions

| Decision                      | Choice                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| Existing binary SSE test      | Update to include `encoding: base64`                                                |
| Client content-type detection | Explicit opt-in only (`encoding: 'base64'` in options)                              |
| CI jobs to disable            | All non-TypeScript clients (Python, Go, .NET, Swift, PHP, Java, Rust, Ruby, Elixir) |
| Server validation tests       | `server-conformance-tests/`                                                         |
| Implementation order          | Test-first                                                                          |

## Verification Commands (Run After Each Step)

| Check                   | Command                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| TypeScript Build        | `pnpm build`                                                           |
| TypeScript Typecheck    | `pnpm typecheck`                                                       |
| Lint                    | `pnpm lint`                                                            |
| Format Check            | `pnpm format:check`                                                    |
| TS Client/Server Tests  | `pnpm vitest run --project client --project server`                    |
| Caddy Go Tests          | `cd packages/caddy-plugin && go test ./...`                            |
| Caddy Conformance       | `pnpm vitest run --project caddy`                                      |
| Client Conformance (TS) | `cd packages/client-conformance-tests && pnpm tsx src/cli.ts --run ts` |

## Current Status

| Step                                     | Status      |
| ---------------------------------------- | ----------- |
| Step 1: Server Conformance Tests         | ✅ Complete |
| Step 2: Caddy Server Implementation      | ✅ Complete |
| Step 3: CI Configuration                 | ✅ Complete |
| Step 4: TypeScript Server Implementation | ✅ Complete |
| Step 5: TypeScript Client Implementation | ✅ Complete |
| Step 6: Client Conformance Tests         | ✅ Complete |
| Step 7: Python Client Implementation     | ✅ Complete |
| Step 8: Go Client Implementation         | ✅ Complete |
| Step 9: Elixir Client Implementation     | ✅ Complete |
| Step 10: .NET Client Implementation      | ✅ Complete |
| Step 11: Swift Client Implementation     | ✅ Complete |
| Step 12: PHP Client Implementation       | ✅ Complete |
| Step 13: Java Client Implementation      | ✅ Complete |
| Step 14: Rust Client Implementation      | ✅ Complete |
| Step 15: Ruby Client Implementation      | ✅ Complete |
| Step 16: Error Message Consistency       | ✅ Complete |
| Step 17: SSE Reconnection Test           | ⏳ Pending  |
| Step 18: Large Payload Test              | ⏳ Pending  |
| Step 19: Invalid Base64 Handling (Opt)   | ⏳ Pending  |
| Step 20: Create Changesets               | ⏳ Pending  |

## Implementation Order

```
Step 1: Server Conformance Tests ✅
   ├── Write tests
   ├── Verify: pnpm build && pnpm typecheck && pnpm lint
   └── Verify: Tests FAIL (expected - implementation missing)

Step 2: Caddy Server Implementation ✅
   ├── Implement encoding support
   ├── Verify: cd packages/caddy-plugin && go test ./...
   ├── Verify: go fmt ./... && go vet ./...
   └── Verify: pnpm vitest run --project caddy (tests should PASS)

Step 3: CI Configuration ✅
   ├── Disable non-TS client tests
   ├── Verify: pnpm lint
   └── Verify: All TS tests pass (full suite)

Step 4: TypeScript Server Implementation ✅
   ├── Implement encoding support
   ├── Verify: pnpm build && pnpm typecheck && pnpm lint
   └── Verify: pnpm vitest run --project server

Step 5: TypeScript Client Implementation
   ├── Implement encoding support
   ├── Verify: pnpm build && pnpm typecheck && pnpm lint
   ├── Verify: pnpm vitest run --project client
   └── Verify: cd packages/client-conformance-tests && pnpm tsx src/cli.ts --run ts

Step 6: Client Conformance Tests ✅
   ├── Add encoding field to types
   ├── Write new test cases
   ├── Verify: pnpm build && pnpm typecheck && pnpm lint
   └── Verify: Tests PASS with TypeScript client

Step 7: Python Client Implementation ✅
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live='sse'
   └── Verify: Client conformance tests pass

Step 8: Go Client Implementation ✅
   ├── Add WithEncoding() option
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live=sse
   └── Verify: Client conformance tests pass

Step 9: Elixir Client Implementation ✅
   ├── Add :encoding option to read/2
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live=:sse
   └── Verify: Client conformance tests pass

Step 10: .NET Client Implementation ✅
   ├── Add encoding option to Read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live=sse
   └── Verify: Client conformance tests pass

Step 11: Swift Client Implementation ✅
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live=.sse
   └── Verify: Client conformance tests pass

Step 12: PHP Client Implementation ✅
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live='sse'
   └── Verify: Client conformance tests pass

Step 13: Java Client Implementation ✅
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires LiveMode.SSE
   └── Verify: Client conformance tests pass

Step 14: Rust Client Implementation ✅
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires LiveMode::Sse
   └── Verify: Client conformance tests pass

Step 15: Ruby Client Implementation ✅
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live: :sse
   └── Verify: Client conformance tests pass

Step 16: Error Message Consistency ✅
   ├── Standardize validation error message across all clients
   ├── Use: "encoding parameter is only valid with live='sse'"
   ├── Update all 10 client implementations (Swift pending)
   └── Verify: Client conformance tests pass

Step 17: SSE Reconnection Test ⏳
   ├── Add test: sse-base64-reconnect-decoding
   ├── Verify base64 decoding works after SSE reconnect
   ├── Ensure decoder state resets properly on new connection
   └── Verify: All client conformance tests pass

Step 18: Large Payload Test ⏳
   ├── Add test: sse-base64-large-payload-multiline
   ├── Test 64KB+ payload that triggers multi-line base64 splits
   ├── May require test framework enhancement for binaryDataSize
   └── Verify: All client conformance tests pass

Step 19: Invalid Base64 Handling (Optional) ⏳
   ├── Add test: sse-base64-invalid-data-error
   ├── Requires fault injection to send malformed base64
   ├── Verify client surfaces PARSE_ERROR for invalid base64
   └── Optional: implement if fault injection is available

Step 20: Create Changesets ⏳
   ├── Create changeset for @durable-streams/client (patch)
   ├── Create changeset for @durable-streams/server (patch)
   ├── Create changesets for all other client packages (patch)
   └── Verify: pnpm changeset status
```

## Step 1: Server Conformance Tests

**File:** `packages/server-conformance-tests/src/index.ts`

**New tests in `SSE Mode` describe block:**

| Test                                                        | Expected Result   |
| ----------------------------------------------------------- | ----------------- |
| `should return 400 for binary stream SSE without encoding`  | 400               |
| `should return 400 for text stream SSE with encoding param` | 400               |
| `should return 400 for JSON stream SSE with encoding param` | 400               |
| `should return 400 for unsupported encoding value`          | 400               |
| `should accept encoding=base64 for binary streams`          | 200 + base64 data |
| `should include Stream-SSE-Data-Encoding header`            | Header present    |
| `should base64 encode data events only`                     | Control = JSON    |
| `should handle empty binary payload`                        | Empty base64      |
| `should handle multi-line base64 split`                     | Valid decode      |

## Step 2: Caddy Server Implementation

**File:** `packages/caddy-plugin/handler.go`

Changes to `handleSSE()`:

1. Parse `encoding` query parameter
2. Validate encoding vs content-type compatibility
3. Add `Stream-SSE-Data-Encoding` response header when encoding used
4. Base64 encode data events (control events remain JSON)

## Step 3: CI Configuration

**Files to modify:**

- `.github/workflows/ci.yml` - Disable Python conformance tests
- `.github/workflows/client-tests.yml` - Keep only TypeScript in matrix

## Step 4: TypeScript Server Implementation

**File:** `packages/server/src/server.ts`

Changes to `handleRead()` and `handleSSE()`:

1. Parse `encoding` query parameter
2. Validate encoding vs content-type compatibility
3. Add `Stream-SSE-Data-Encoding` response header when encoding used
4. Base64 encode data events (control events remain JSON)

## Step 5: TypeScript Client Implementation

**Files to modify:**

- `packages/client/src/types.ts` - Add `encoding` option
- `packages/client/src/constants.ts` - Add `ENCODING_QUERY_PARAM`
- `packages/client/src/stream-api.ts` - Add encoding to URL query params
- `packages/client/src/sse.ts` - Add base64 decoding for data events

## Step 6: Client Conformance Tests

**Files to modify:**

- `packages/client-conformance-tests/src/test-cases.ts` - Add `encoding` field
- `packages/client-conformance-tests/src/protocol.ts` - Add `encoding` field
- `packages/client-conformance-tests/src/runner.ts` - Pass `encoding`
- `packages/client-conformance-tests/src/adapters/typescript-adapter.ts` - Pass `encoding`
- `packages/client-conformance-tests/test-cases/consumer/read-sse.yaml` - Update existing test
- `packages/client-conformance-tests/test-cases/consumer/read-sse-base64.yaml` - New test file

## Files Summary

| Package                  | File                                       | Action                                  |
| ------------------------ | ------------------------------------------ | --------------------------------------- |
| server-conformance-tests | `src/index.ts`                             | Add 9 new tests                         |
| caddy-plugin             | `handler.go`                               | Modify `handleSSE()`                    |
| .github/workflows        | `ci.yml`                                   | Disable Python tests                    |
| .github/workflows        | `client-tests.yml`                         | Keep only TypeScript                    |
| server                   | `src/server.ts`                            | Modify `handleRead()` and `handleSSE()` |
| client                   | `src/types.ts`                             | Add `encoding` option                   |
| client                   | `src/constants.ts`                         | Add constant                            |
| client                   | `src/stream-api.ts`                        | Add query param                         |
| client                   | `src/sse.ts`                               | Add base64 decoding                     |
| client-conformance-tests | `src/test-cases.ts`                        | Add `encoding` field                    |
| client-conformance-tests | `src/protocol.ts`                          | Add `encoding` field                    |
| client-conformance-tests | `src/runner.ts`                            | Pass `encoding`                         |
| client-conformance-tests | `src/adapters/typescript-adapter.ts`       | Pass `encoding`                         |
| client-conformance-tests | `test-cases/consumer/read-sse.yaml`        | Update existing test                    |
| client-conformance-tests | `test-cases/consumer/read-sse-base64.yaml` | New test file + reconnection test       |

## Client Implementation Details

Each client implementation follows the same pattern:

1. **Add encoding option** - Accept `encoding: 'base64'` in read options
2. **Pass query parameter** - Add `?encoding=base64` to SSE request URL
3. **Decode SSE data events** - Base64 decode data event payloads before returning
4. **Validate usage** - Return error if encoding used without SSE mode

### Client Packages

| Package       | Language   | Status      |
| ------------- | ---------- | ----------- |
| client        | TypeScript | ✅ Complete |
| client-py     | Python     | ✅ Complete |
| client-go     | Go         | ✅ Complete |
| client-elixir | Elixir     | ✅ Complete |
| client-dotnet | .NET       | ✅ Complete |
| client-swift  | Swift      | ✅ Complete |
| client-php    | PHP        | ✅ Complete |
| client-java   | Java       | ✅ Complete |
| client-rust   | Rust       | ✅ Complete |
| client-rb     | Ruby       | ✅ Complete |

## Step 16: Error Message Consistency

**Purpose:** Standardize the validation error message for "encoding requires SSE" across all 10 client implementations for consistency.

**Standard error message:** `"encoding parameter is only valid with live='sse'"`

**Files to update:**

| Package       | File                             | Current Message (approximate) |
| ------------- | -------------------------------- | ----------------------------- |
| client        | `src/stream-api.ts`              | Check current implementation  |
| client-py     | `src/durable_streams/stream.py`  | Check current implementation  |
| client-go     | `stream.go`                      | Check current implementation  |
| client-elixir | `lib/durable_streams/stream.ex`  | Check current implementation  |
| client-dotnet | `src/DurableStream.cs`           | Check current implementation  |
| client-swift  | `Sources/DurableStreams/*.swift` | Check current implementation  |
| client-php    | `src/Stream.php`                 | Check current implementation  |
| client-java   | `src/.../DurableStream.java`     | Check current implementation  |
| client-rust   | `src/stream.rs`                  | Check current implementation  |
| client-rb     | `lib/durable_streams/stream.rb`  | Check current implementation  |

**Verification:** Run client conformance tests - the `messageContains` assertions in validation tests should pass with the standardized message.

## Step 17: SSE Reconnection Test

**File:** `packages/client-conformance-tests/test-cases/consumer/read-sse-base64.yaml`

**Purpose:** Verify that base64 decoding works correctly after an SSE connection drops and reconnects using `streamNextOffset`. This catches issues where decoder state isn't properly reset on reconnection.

**New test case:**

```yaml
- id: sse-base64-reconnect-decoding
  name: SSE base64 decoding works after reconnect
  description: |
    After SSE connection closes and client reconnects from last offset,
    base64 decoding should work correctly without corruption from
    any previous decoder state.
  setup:
    - action: create
      as: streamPath
      contentType: application/octet-stream
    - action: append
      path: ${streamPath}
      binaryData: "Zmlyc3Q=" # "first"
      expect:
        storeOffsetAs: firstOffset
    - action: append
      path: ${streamPath}
      binaryData: "c2Vjb25k" # "second"
  operations:
    # First read - gets "first", stops after 1 chunk
    - action: read
      path: ${streamPath}
      live: sse
      encoding: base64
      maxChunks: 1
      expect:
        minChunks: 1
        dataContains: "first"
    # Second read - reconnects from offset, should decode "second" correctly
    - action: read
      path: ${streamPath}
      offset: ${firstOffset}
      live: sse
      encoding: base64
      waitForUpToDate: true
      expect:
        minChunks: 1
        dataContains: "second"
        upToDate: true
```

## Step 18: Large Payload Test

**File:** `packages/client-conformance-tests/test-cases/consumer/read-sse-base64.yaml`

**Purpose:** Verify that large binary payloads (64KB+) that may be split across multiple `data:` lines in SSE are correctly concatenated and decoded. Per protocol: "Servers MAY split the base64 text across multiple `data:` lines within the same SSE `data` event."

**Prerequisites:** May require test framework enhancement to support `binaryDataSize` parameter for generating large binary payloads, or use a pre-encoded large base64 string.

**New test case:**

```yaml
- id: sse-base64-large-payload-multiline
  name: SSE handles large base64 payload with line splits
  description: |
    Large binary payloads (64KB+) may be split across multiple data: lines.
    Client must concatenate lines and remove \n\r before decoding per protocol.
  setup:
    - action: create
      as: streamPath
      contentType: application/octet-stream
    - action: append
      path: ${streamPath}
      # 64KB of binary data - will produce ~87KB of base64 text
      # Servers may split this across multiple data: lines
      binaryDataSize: 65536
  operations:
    - action: read
      path: ${streamPath}
      live: sse
      encoding: base64
      waitForUpToDate: true
      timeoutMs: 10000
      expect:
        minChunks: 1
        upToDate: true
        # Verify decoded size matches original
        dataSize: 65536
```

## Step 19: Invalid Base64 Handling (Optional)

**File:** `packages/client-conformance-tests/test-cases/consumer/read-sse-base64.yaml`

**Purpose:** Verify that clients properly handle malformed base64 data from the server by surfacing a `PARSE_ERROR` rather than silently corrupting data or crashing.

**Prerequisites:** Requires fault injection capability in the test framework to make the server send intentionally malformed base64 data.

**Status:** Optional - implement only if fault injection support is available.

**Proposed test case (requires fault injection):**

```yaml
- id: sse-base64-invalid-data-error
  name: Client returns PARSE_ERROR for invalid base64
  description: |
    When server sends malformed base64 (illegal characters, wrong padding),
    client should surface a PARSE_ERROR rather than corrupting data.
  setup:
    - action: create
      as: streamPath
      contentType: application/octet-stream
  operations:
    - action: read
      path: ${streamPath}
      live: sse
      encoding: base64
      faultInjection:
        type: malformed-base64
        # Send data with illegal characters: "!!!invalid!!!"
        data: "ISEhaW52YWxpZCEhIQ=="
      expect:
        errorCode: PARSE_ERROR
        messageContains:
          - base64
```

**Alternative approach:** If fault injection is not feasible, this could be tested via unit tests in each client implementation rather than conformance tests.

## Step 20: Create Changesets

**Purpose:** Create changesets for all packages modified by this feature so changes are included in releases and CHANGELOGs are updated.

**Reference:** Per CLAUDE.md: "All packages are pre-1.0. Use `patch` for changesets, not `minor`, unless it's a breaking change."

**Command:** `pnpm changeset`

**Packages requiring changesets (all patch):**

| Package                   | Description                                       |
| ------------------------- | ------------------------------------------------- |
| `@durable-streams/client` | Add `encoding` option for SSE with binary streams |
| `@durable-streams/server` | Add base64 encoding support for SSE               |
| `client-py`               | Add `encoding` option for SSE with binary streams |
| `client-go`               | Add `WithEncoding()` option for SSE               |
| `client-elixir`           | Add `:encoding` option for SSE                    |
| `client-dotnet`           | Add `encoding` option for SSE                     |
| `client-swift`            | Add `encoding` option for SSE                     |
| `client-php`              | Add `encoding` option for SSE                     |
| `client-java`             | Add `encoding` option for SSE                     |
| `client-rust`             | Add `encoding` option for SSE                     |
| `client-rb`               | Add `encoding` option for SSE                     |

**Changeset message template:**

```
feat: add base64 encoding support for SSE with binary streams

Added `encoding: 'base64'` option for reading binary streams via SSE.
Per Protocol Section 5.7, this is required for content types other than
text/* or application/json. The client validates that encoding is only
used with live='sse' and decodes base64 data events automatically.
```

**Verification:** `pnpm changeset status`
