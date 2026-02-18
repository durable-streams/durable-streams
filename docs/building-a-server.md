# Building a Server

The Durable Streams protocol is designed to support server implementations in any language or platform. This guide covers what a conforming server must implement and how to validate it against the protocol conformance test suite (124 tests).

For the full protocol specification, see [PROTOCOL.md](../PROTOCOL.md). For existing server implementations, see [Servers](servers.md).

## HTTP API

A Durable Streams server exposes a single URL-per-stream HTTP interface. The protocol does not prescribe a specific URL structure -- your server may organize streams however you choose (e.g. `/v1/stream/{path}`, `/streams/{id}`, or domain-specific paths).

| Method | Path | Purpose |
|--------|------|---------|
| PUT | `/{path}` | Create stream (idempotent) |
| POST | `/{path}` | Append to stream |
| GET | `/{path}?offset=X` | Read (catch-up) |
| GET | `/{path}?offset=X&live=long-poll` | Read (live, long-poll) |
| GET | `/{path}?offset=X&live=sse` | Read (live, SSE) |
| HEAD | `/{path}` | Stream metadata |
| DELETE | `/{path}` | Delete stream |

Servers may implement the read and write paths independently. For example, a database sync server might only implement reads and use its own injection system for writes.

### Create Stream (PUT)

Creates a new stream. If the stream already exists with matching configuration, returns `200 OK` (idempotent). If the configuration differs, returns `409 Conflict`.

```
PUT /v1/stream/my-stream HTTP/1.1
Content-Type: application/json

HTTP/1.1 201 Created
Location: /v1/stream/my-stream
Content-Type: application/json
Stream-Next-Offset: 0000000000000
```

**Request headers:**

- `Content-Type` -- sets the stream's content type (default: `application/octet-stream`)
- `Stream-TTL` -- relative time-to-live in seconds
- `Stream-Expires-At` -- absolute expiry as an RFC 3339 timestamp
- `Stream-Closed: true` -- create the stream in a closed state

**Request body:** optional initial stream bytes.

**Status codes:** `201 Created`, `200 OK` (already exists, matching config), `409 Conflict` (exists, different config), `400 Bad Request`.

**Response headers:** `Content-Type`, `Stream-Next-Offset`, `Location` (on 201), `Stream-Closed: true` (when created closed).

### Append to Stream (POST)

Appends bytes to an existing stream. Optionally closes the stream atomically with the append.

```
POST /v1/stream/my-stream HTTP/1.1
Content-Type: application/json

{"event":"user.created","userId":"123"}

HTTP/1.1 204 No Content
Stream-Next-Offset: 0000000000001
```

**Request headers:**

- `Content-Type` -- must match the stream's content type
- `Stream-Closed: true` -- close the stream after this append
- `Stream-Seq` -- optional monotonic sequence number for writer coordination

**Request body:** bytes to append. Empty bodies are rejected with `400` unless `Stream-Closed: true` is present.

**Status codes:** `204 No Content`, `404 Not Found`, `409 Conflict` (content type mismatch, sequence regression, or stream is closed), `400 Bad Request`, `413 Payload Too Large`.

**Response headers:** `Stream-Next-Offset`, `Stream-Closed: true` (when stream is now closed).

When rejecting appends to a closed stream, the response must include both `Stream-Closed: true` and `Stream-Next-Offset` so clients can detect the condition programmatically.

### Read Stream -- Catch-up (GET)

Returns bytes starting from the specified offset.

```
GET /v1/stream/my-stream?offset=0000000000000 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json
Stream-Next-Offset: 0000000000001
Stream-Up-To-Date: true
Cache-Control: public, max-age=60, stale-while-revalidate=300
ETag: "stream-id:0000000000000:0000000000001"

[{"event":"user.created","userId":"123"}]
```

**Query parameters:**

- `offset` -- start position. Omit or use `-1` for the stream beginning. Use `now` to skip to the current tail.

**Status codes:** `200 OK`, `400 Bad Request`, `404 Not Found`, `410 Gone` (offset before retained range).

**Response headers:**

- `Content-Type` -- the stream's content type
- `Stream-Next-Offset` -- the offset to use for the next read
- `Stream-Up-To-Date: true` -- present when the client has caught up to the tail (does not mean EOF)
- `Stream-Closed: true` -- present when the stream is closed and the client has reached the final offset (this is the EOF signal)
- `Stream-Cursor` -- optional cursor for CDN collapsing
- `Cache-Control` and `ETag` -- for caching (see [Caching](#caching-headers))

When the requested offset is at the tail and no data is available, return `200 OK` with an empty body and `Stream-Up-To-Date: true`. If the stream is also closed, include `Stream-Closed: true`.

### Read Stream -- Long-poll (GET)

If no data is available at the requested offset, the server holds the connection open until new data arrives or a timeout expires.

```
GET /v1/stream/my-stream?offset=0000000000001&live=long-poll HTTP/1.1

HTTP/1.1 204 No Content
Stream-Next-Offset: 0000000000001
Stream-Up-To-Date: true
Stream-Cursor: 1000
```

**Query parameters:**

- `offset` -- required
- `live=long-poll` -- required
- `cursor` -- echo of the last `Stream-Cursor` value, used for CDN collapsing

**Status codes:** `200 OK` (data arrived), `204 No Content` (timeout, no new data), `404 Not Found`.

**Response headers:** same as catch-up, plus `Stream-Cursor` is required on all long-poll responses.

When the stream is closed and the client is at the tail, return `204 No Content` with `Stream-Closed: true` immediately -- do not wait for the timeout.

### Read Stream -- SSE (GET)

Returns data as a Server-Sent Events stream.

```
GET /v1/stream/my-stream?offset=0000000000000&live=sse HTTP/1.1

HTTP/1.1 200 OK
Content-Type: text/event-stream

event: data
data: [{"event":"user.created","userId":"123"}]

event: control
data: {"streamNextOffset":"0000000000001","streamCursor":"abc","upToDate":true}
```

SSE responses use `Content-Type: text/event-stream`. Data is emitted as `data` events, followed by `control` events carrying the offset, cursor, up-to-date status, and closure status as a JSON object with camelCase field names.

For binary content types (anything other than `text/*` or `application/json`), data events must be base64-encoded and the response must include a `Stream-SSE-Data-Encoding: base64` header.

Servers should close SSE connections roughly every 60 seconds to enable CDN collapsing. Clients reconnect using the last `streamNextOffset` from the most recent control event.

When the stream is closed and all data has been sent, emit a final control event with `streamClosed: true` and close the connection.

### Stream Metadata (HEAD)

Returns stream metadata without a body. This is the canonical way to check existence, content type, tail offset, and closure status.

```
HEAD /v1/stream/my-stream HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json
Stream-Next-Offset: 0000000000001
Cache-Control: no-store
```

**Status codes:** `200 OK`, `404 Not Found`.

**Response headers:** `Content-Type`, `Stream-Next-Offset`, `Stream-TTL`, `Stream-Expires-At`, `Stream-Closed: true` (when closed), `Cache-Control`.

HEAD responses should be non-cacheable (`Cache-Control: no-store`).

### Delete Stream (DELETE)

Removes the stream and all its data.

**Status codes:** `204 No Content`, `404 Not Found`.

## Storage Layer

Your storage backend needs to support the following operations:

- **Durable append** -- persist data reliably so that once an append is acknowledged, the data survives restarts
- **Offset generation** -- produce opaque, lexicographically sortable offset tokens that are strictly increasing and unique within a stream
- **Read from offset** -- return all data starting from a given offset, up to a server-defined chunk size
- **Stream metadata** -- track content type, current tail offset, TTL/expiry, and closed status per stream
- **Stream deletion** -- remove a stream and its data

Possible backends include in-memory stores (for development), file-based storage (log files with LMDB indexes), relational databases (Postgres, SQLite), and object storage (S3).

The reference implementations use in-memory and file-backed stores. See the [Dev Server](../packages/server/) and [Caddy Plugin](../packages/caddy-plugin/) source for concrete examples.

## Key Protocol Requirements

These invariants are enforced by the conformance tests and must hold for any server implementation.

### Byte-exact resumption

Reading from an offset must return exactly the bytes that follow that offset -- no skips, no duplicates. A client that reads a stream in chunks using `Stream-Next-Offset` must reconstruct the exact same byte sequence as reading the entire stream at once.

### Offset monotonicity

Offsets must be strictly increasing. Every append must produce an offset that is lexicographically greater than all previously assigned offsets. Schemes that can produce duplicate or non-monotonic values (such as raw UTC timestamps) are not conforming.

### Stream closure (EOF)

Once a stream is closed, no further appends are permitted. Closure is durable (survives restarts) and monotonic (cannot be reversed). Readers observe closure as a `Stream-Closed: true` header when they reach the final offset.

### Idempotent creates

PUT must be idempotent: creating a stream that already exists with matching configuration returns `200 OK`. Mismatched configuration returns `409 Conflict`.

### Content-type preservation

The content type is set on stream creation and returned on every read. Appends with a mismatched content type are rejected with `409 Conflict`.

## Optional Features

These features are tested by the conformance suite but are not strictly required for a minimal implementation.

### Idempotent producers

Handle `Producer-Id`, `Producer-Epoch`, and `Producer-Seq` request headers on POST for exactly-once write semantics. The server tracks `(producerId, epoch, lastSeq)` state per stream and deduplicates retries. Key behaviors:

- All three headers must be present together or not at all
- Epoch must be monotonically non-decreasing; a stale epoch returns `403 Forbidden`
- Sequence numbers must be strictly increasing within an epoch; duplicates return `204 No Content` (idempotent success); gaps return `409 Conflict`
- A new epoch must start at `seq=0`
- Producer state and log appends should be committed atomically where possible

See [Section 5.2.1 of the protocol spec](../PROTOCOL.md#521-idempotent-producers) for the full validation logic.

### JSON mode

Streams with `Content-Type: application/json` have special semantics:

- Message boundaries are preserved: each POST stores messages as distinct units
- Array flattening: a POST body of `[a, b, c]` stores three messages, not one
- GET responses return a JSON array of all messages in the range
- Empty array POSTs (`[]`) are rejected with `400`
- POST bodies must be valid JSON

### Caching headers

Support CDN-friendly caching:

- `Cache-Control` on catch-up reads (e.g. `public, max-age=60, stale-while-revalidate=300`)
- `ETag` on GET responses for conditional requests (`If-None-Match` / `304 Not Modified`)
- ETags must vary with closure status so clients don't receive stale `304` responses that hide an EOF signal
- `Stream-Cursor` on live responses to enable CDN request collapsing
- `Cache-Control: no-store` on HEAD responses

### TTL/expiry

Support `Stream-TTL` and `Stream-Expires-At` headers on PUT for automatic stream cleanup after a time-to-live. The two headers are mutually exclusive.

## Running the Conformance Tests

The conformance test suite is the definitive way to verify your server implements the protocol correctly. It contains 124 tests covering the full protocol surface.

### Install

```bash
npm install @durable-streams/server-conformance-tests
```

### CLI Usage

Run tests once against a running server (suitable for CI):

```bash
npx @durable-streams/server-conformance-tests --run http://localhost:4437
```

Watch mode re-runs tests automatically when your source files change (suitable for development):

```bash
npx @durable-streams/server-conformance-tests --watch src http://localhost:4437

# Watch multiple directories
npx @durable-streams/server-conformance-tests --watch src lib http://localhost:4437
```

### Programmatic Usage

Run the tests from your own test suite:

```typescript
import { runConformanceTests } from "@durable-streams/server-conformance-tests"

describe("My Server", () => {
  const config = { baseUrl: "" }

  beforeAll(async () => {
    const server = await startMyServer({ port: 0 })
    config.baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  runConformanceTests(config)
})
```

### CI Integration

```yaml
# GitHub Actions example
jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install
      - run: npm run start:server &
      - run: npx wait-on http://localhost:4437
      - run: npx @durable-streams/server-conformance-tests --run http://localhost:4437
```

### Test Coverage

The 124 tests cover:

- **Basic operations** -- create, delete, idempotent creates
- **Append operations** -- string data, binary data, chunking, sequences
- **Read operations** -- empty/full streams, offset reads, up-to-date signals
- **Long-poll** -- waiting for data, timeouts, cancellation
- **HTTP protocol** -- headers, status codes, content types
- **TTL/expiry** -- TTL and Expires-At handling
- **Stream closure** -- EOF signaling, closed status propagation
- **Byte-exactness** -- no data loss or duplication on resumption
- **Caching and ETag** -- ETag generation, `304 Not Modified`, cache headers
- **SSE mode** -- Server-Sent Events streaming and control events
- **JSON mode** -- array flattening, message boundaries, validation
- **Idempotent producers** -- deduplication, epoch fencing, sequence validation
- **Property-based fuzzing** -- random append/read sequences
- **Malformed input fuzzing** -- security-focused edge cases

## Reference Implementations

Two official implementations are available as reference:

- **Node.js Dev Server** ([packages/server](../packages/server/)) -- a TypeScript implementation good for understanding the basics. Uses in-memory or file-backed storage.
- **Caddy Plugin** ([packages/caddy-plugin](../packages/caddy-plugin/)) -- a production-grade Go implementation built as a Caddy v2 plugin. Uses LMDB for persistence.

See [Servers](servers.md) for usage details on both.
