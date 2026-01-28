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
| Step 10: .NET Client Implementation      | Pending     |
| Step 11: Swift Client Implementation     | Pending     |
| Step 12: PHP Client Implementation       | Pending     |
| Step 13: Java Client Implementation      | Pending     |
| Step 14: Rust Client Implementation      | Pending     |
| Step 15: Ruby Client Implementation      | Pending     |

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

Step 10: .NET Client Implementation
   ├── Add encoding option to Read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live=sse
   └── Verify: Client conformance tests pass

Step 11: Swift Client Implementation
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live=.sse
   └── Verify: Client conformance tests pass

Step 12: PHP Client Implementation
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live='sse'
   └── Verify: Client conformance tests pass

Step 13: Java Client Implementation
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires LiveMode.SSE
   └── Verify: Client conformance tests pass

Step 14: Rust Client Implementation
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires LiveMode::Sse
   └── Verify: Client conformance tests pass

Step 15: Ruby Client Implementation
   ├── Add encoding option to read() method
   ├── Add base64 decoding for SSE data events
   ├── Add validation: encoding requires live: :sse
   └── Verify: Client conformance tests pass
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
| client-conformance-tests | `test-cases/consumer/read-sse-base64.yaml` | New test file                           |

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
| client-dotnet | .NET       | Pending     |
| client-swift  | Swift      | Pending     |
| client-php    | PHP        | Pending     |
| client-java   | Java       | Pending     |
| client-rust   | Rust       | Pending     |
| client-rb     | Ruby       | Pending     |
