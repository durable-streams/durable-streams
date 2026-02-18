# Building a Client

The Durable Streams protocol is designed to have many client implementations. The protocol is pure HTTP -- any language that can make HTTP requests can implement a client. This guide covers what you need to build a client library and how to validate it against the conformance test suite.

For the full protocol specification, see [PROTOCOL.md](../PROTOCOL.md).

## What a Client Needs to Do

A Durable Streams client makes standard HTTP requests to stream URLs and tracks offsets for resumption. At minimum, a client must:

- Make HTTP requests (`PUT`, `POST`, `GET`, `HEAD`, `DELETE`) to stream URLs
- Read and store opaque offset strings from response headers
- Handle the two content modes: byte streams and JSON mode
- Implement retry logic for transient errors

## Core Operations

### Create a Stream

```
PUT /{path}
Content-Type: text/plain
```

Creates a new stream at the given URL. The `Content-Type` header sets the stream's content type for its lifetime. If omitted, the server may default to `application/octet-stream`.

**Response codes:**

- `201 Created` -- stream created
- `200 OK` -- stream already exists with matching configuration (idempotent)
- `409 Conflict` -- stream exists with different configuration

**Response headers:**

- `Stream-Next-Offset` -- the tail offset (where the next append will go)

Optional request headers include `Stream-TTL` (seconds), `Stream-Expires-At` (RFC 3339 timestamp), and `Stream-Closed: true` (create in closed state).

### Append Data

```
POST /{path}
Content-Type: text/plain

Hello, world!
```

Appends bytes to an existing stream. The `Content-Type` must match the stream's configured type.

**Response codes:**

- `204 No Content` -- append successful
- `404 Not Found` -- stream does not exist
- `409 Conflict` -- content type mismatch, sequence conflict, or stream is closed

**Response headers:**

- `Stream-Next-Offset` -- the new tail offset after the append

### Read (Catch-up)

```
GET /{path}?offset=0a1b2c
```

Returns data from the specified offset. If no data exists beyond the offset, returns an empty body.

**Response codes:**

- `200 OK` -- data available (or empty body if at tail)
- `404 Not Found` -- stream does not exist

**Response headers:**

- `Stream-Next-Offset` -- the offset to use for the next read
- `Stream-Up-To-Date: true` -- present when the response includes all currently available data
- `Stream-Closed: true` -- present when the stream is closed and the client has reached the final offset (EOF)

### Read (Long-poll)

```
GET /{path}?offset=0a1b2c&live=long-poll
```

If no data is available, the server holds the connection open until new data arrives or a timeout expires.

**Response codes:**

- `200 OK` -- new data arrived
- `204 No Content` -- timeout with no new data

A `204` with `Stream-Closed: true` indicates EOF -- the stream is closed and no more data will arrive.

**Response headers:**

- `Stream-Next-Offset` -- the offset for the next request
- `Stream-Cursor` -- echo this as `cursor=<value>` on the next request (enables CDN collapsing)

### Read (SSE)

```
GET /{path}?offset=0a1b2c&live=sse
```

Returns a `text/event-stream` response with two event types:

- `data` -- contains stream data (base64-encoded for binary content types)
- `control` -- JSON object with `streamNextOffset`, `streamCursor`, `upToDate`, and optionally `streamClosed`

```
event: data
data: Hello, world!

event: control
data: {"streamNextOffset":"0a1b2c","streamCursor":"abc","upToDate":true}
```

When `streamClosed: true` appears in a control event, the client must not reconnect. The server closes the connection after sending the final control event.

For reconnection, use the last `streamNextOffset` value.

### Stream Metadata

```
HEAD /{path}
```

Returns stream metadata in headers without transferring a body.

**Response headers:**

- `Content-Type` -- the stream's content type
- `Stream-Next-Offset` -- the current tail offset
- `Stream-Closed: true` -- present if the stream is closed

### Delete a Stream

```
DELETE /{path}
```

Deletes the stream and all its data. Returns `204 No Content` on success, `404 Not Found` if the stream does not exist.

### Close a Stream

```
POST /{path}
Stream-Closed: true
```

Closes the stream without appending data. Once closed, no further appends are accepted. To atomically append final data and close, include a body with the `Stream-Closed: true` header.

Returns `204 No Content` on success. Closing is idempotent -- closing an already-closed stream succeeds.

## Idempotent Producer

Durable Streams supports Kafka-style idempotent producers for exactly-once write semantics. This eliminates duplicates from client retries.

### Headers

All three headers must be provided together or not at all:

- `Producer-Id` -- a stable string identifier for the producer (e.g., `"order-service-1"`)
- `Producer-Epoch` -- a non-negative integer, incremented on producer restart
- `Producer-Seq` -- a non-negative integer, monotonically increasing within an epoch, starting at 0

### How It Works

The server tracks the last accepted `(epoch, seq)` per `(stream, producerId)`:

- **Same `(epoch, seq)` as a previous request** -- returns `204 No Content` (duplicate, idempotent success, no data written)
- **`seq == lastSeq + 1`** -- accepted, data appended, returns `200 OK`
- **`seq > lastSeq + 1`** -- gap detected, returns `409 Conflict` with `Producer-Expected-Seq` and `Producer-Received-Seq` headers
- **`epoch > server epoch`** with `seq == 0` -- new epoch accepted, old epoch fenced
- **`epoch < server epoch`** -- stale producer, returns `403 Forbidden` with `Producer-Epoch` header showing the current epoch

### Epoch-based Fencing

When a producer restarts, it increments its epoch and starts `seq` at 0. The server accepts the new epoch and fences the old one. Any requests from the old epoch receive `403 Forbidden`.

### Auto-claim Flow

For ephemeral producers that don't persist their epoch:

1. Start with `(epoch=0, seq=0)`
2. If the server returns `403` with `Producer-Epoch: 5`, retry with `(epoch=6, seq=0)`
3. The server accepts the new epoch

This is opt-in client behavior and trades strict fencing for convenience.

## JSON Mode

Streams created with `Content-Type: application/json` get special message boundary handling:

- **POST with a JSON array** flattens one level -- each element is stored as a separate message
- **POST with a non-array JSON value** stores it as a single message
- **GET** returns a JSON array of all messages in the requested range
- **Empty range** returns `[]`

```
POST /{path}
Content-Type: application/json

[{"event":"a"},{"event":"b"}]
```

This stores two messages. A subsequent `GET` returns:

```
HTTP/1.1 200 OK
Content-Type: application/json

[{"event":"a"},{"event":"b"}]
```

Empty JSON arrays (`[]`) in POST requests are rejected with `400 Bad Request`.

## Offset Handling

Offsets are **opaque strings**. Never parse, construct, or make assumptions about their internal structure. They have two important properties:

- **Lexicographically sortable** -- you can compare two offsets to determine ordering
- **Monotonically increasing** -- later data always has a higher offset

### Special Values

| Value  | Meaning                                             |
| ------ | --------------------------------------------------- |
| `"-1"` | Beginning of the stream (equivalent to omitting offset) |
| `"now"` | Current tail position (skip existing data)          |

### Usage

Always use the `Stream-Next-Offset` value from responses for subsequent reads. Persist offsets client-side for resumption across restarts and reconnects.

```
GET /{path}?offset=-1         # read from beginning
GET /{path}?offset=0a1b2c     # resume from saved offset
GET /{path}?offset=now        # skip to current tail
```

## Error Handling

### Retryable Errors

Retry these with exponential backoff:

- `500 Internal Server Error`
- `503 Service Unavailable`
- `429 Too Many Requests` -- respect the `Retry-After` header when present

### Non-retryable Errors

Do **not** retry these:

- `400 Bad Request` -- malformed request
- `404 Not Found` -- stream does not exist
- `409 Conflict` -- content type mismatch, stream closed, or sequence conflict
- `403 Forbidden` -- stale producer epoch
- `413 Payload Too Large`

### Error Mapping

Map HTTP errors to client-friendly error types so callers don't need to interpret status codes directly.

## Running the Conformance Tests

The conformance test suite is the definitive way to validate a client implementation. It covers 221 tests spanning offset semantics, retry behavior, live streaming, message ordering, and producer operations.

### Install

```bash
npm install @durable-streams/client-conformance-tests
```

### Architecture

The test runner is a Node.js process that:

1. Starts a reference Durable Streams server
2. Launches your client adapter as a subprocess
3. Sends JSON commands to the adapter's stdin (one per line)
4. Reads JSON results from the adapter's stdout (one per line)
5. Compares results against expectations

```
┌──────────────────────────────┐
│     Test Runner (Node.js)    │
│  - YAML test cases           │
│  - Reference server          │
│  - Result validation         │
└──────────────┬───────────────┘
               │ stdin/stdout (JSON lines)
               v
┌──────────────────────────────┐
│   Your Client Adapter        │
│  - Reads commands from stdin │
│  - Calls your client SDK     │
│  - Writes results to stdout  │
└──────────────┬───────────────┘
               │ HTTP
               v
┌──────────────────────────────┐
│     Reference Server         │
└──────────────────────────────┘
```

### Writing an Adapter

Create an executable that reads JSON commands from stdin and writes JSON results to stdout, one per line. The adapter is the bridge between the test runner and your client library.

**Lifecycle:**

1. The test runner starts your adapter as a subprocess
2. The first command is always `init`, which provides the `serverUrl`
3. Subsequent commands exercise your client's operations
4. The final command is `shutdown`

**Key commands:**

| Command    | Description                              |
| ---------- | ---------------------------------------- |
| `init`     | Receive server URL, report client info   |
| `create`   | Create a stream                          |
| `append`   | Append data to a stream                  |
| `read`     | Read from a stream (catch-up or live)    |
| `head`     | Get stream metadata                      |
| `delete`   | Delete a stream                          |
| `close`    | Close a stream                           |
| `shutdown` | Clean up and exit                        |

**Example: `init` command and response:**

```json
{"type":"init","serverUrl":"http://localhost:3000"}
```

```json
{"type":"init","success":true,"clientName":"my-client","clientVersion":"1.0.0","features":{"sse":true,"longPoll":true}}
```

**Example: `append` command and response:**

```json
{"type":"append","path":"/my-stream","data":"Hello, World!","seq":1}
```

```json
{"type":"append","success":true,"status":200,"offset":"13"}
```

**Example: error response:**

```json
{"type":"error","success":false,"commandType":"append","status":404,"errorCode":"NOT_FOUND","message":"Stream not found"}
```

### Error Codes

Map your client's errors to these standard codes in error results:

| Code                | Meaning                         |
| ------------------- | ------------------------------- |
| `NETWORK_ERROR`     | Network connection failed       |
| `TIMEOUT`           | Operation timed out             |
| `CONFLICT`          | Stream already exists (409)     |
| `NOT_FOUND`         | Stream not found (404)          |
| `SEQUENCE_CONFLICT` | Sequence number conflict (409)  |
| `STREAM_CLOSED`     | Stream is closed (409)          |
| `INVALID_OFFSET`    | Invalid offset format (400)     |
| `UNEXPECTED_STATUS` | Unexpected HTTP status          |
| `PARSE_ERROR`       | Failed to parse response        |
| `INTERNAL_ERROR`    | Client internal error           |
| `NOT_SUPPORTED`     | Operation not supported         |

### Running Tests

```bash
# Run all tests against your adapter
npx @durable-streams/client-conformance-tests --run ./your-adapter

# Run a specific test suite
npx @durable-streams/client-conformance-tests --run ./your-adapter --suite producer

# Verbose output
npx @durable-streams/client-conformance-tests --run ./your-adapter --verbose

# Stop on first failure
npx @durable-streams/client-conformance-tests --run ./your-adapter --fail-fast
```

### Test Coverage

The 221 tests cover:

- **Producer** -- stream creation, append operations, sequence ordering, batching, error handling
- **Consumer** -- catch-up reads, long-poll, SSE, offset handling, error handling
- **Lifecycle** -- full create/append/read/delete flows, HEAD requests, custom headers

## Reference Implementations

Use these as examples when building your own client:

- [TypeScript](../packages/client/) -- reference client with full read/write support
- [Python](../packages/client-py/)
- [Go](../packages/client-go/)
- [Elixir](../packages/client-elixir/)
- [.NET](../packages/client-dotnet/)
- [Swift](../packages/client-swift/)
- [PHP](../packages/client-php/)
- [Java](../packages/client-java/)
- [Rust](../packages/client-rust/)
- [Ruby](../packages/client-rb/)

All pass the conformance test suite. See [Client Libraries](clients.md) for details.
