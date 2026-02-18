# Core Concepts

This page introduces the key concepts behind the Durable Streams protocol. For the complete specification, see [PROTOCOL.md](../PROTOCOL.md).

## Streams

A stream is a **URL-addressable, append-only, durable sequence of bytes**. Each stream lives at its own URL and has a content type set at creation. Once data is written at a position, it never changes -- new data can only be appended to the end.

Streams are strictly ordered by offset and support three fundamental operations: create, append, and read.

```
PUT /streams/my-stream          # Create
POST /streams/my-stream         # Append
GET /streams/my-stream?offset=… # Read
```

The protocol doesn't prescribe any particular URL structure. A stream URL can be anything: `/v1/stream/{id}`, `/events/{topic}`, or whatever makes sense for your application.

## Offsets

Every position in a stream is identified by an **offset** -- an opaque string token. Offsets have two important properties:

- **Opaque**: Never parse, construct, or make assumptions about the internal format of an offset. Always treat them as strings you received from the server.
- **Lexicographically sortable**: You can compare two offsets from the same stream using standard string comparison to determine which comes first.

The protocol defines two sentinel values:

| Value  | Meaning |
|--------|---------|
| `"-1"` | Beginning of the stream (equivalent to omitting the offset) |
| `"now"` | Current tail position -- skip all existing data and read only new messages |

When you read from a stream, the response includes a `Stream-Next-Offset` header telling you where to read next. Store this value and use it for your next request to resume where you left off.

```
GET /streams/my-stream?offset=-1

< 200 OK
< Stream-Next-Offset: 01JQXK5V00
< …response body…
```

## Messages and Content Types

A stream's content type is set at creation and determines how the server handles message boundaries.

### Byte streams

For most content types (`application/octet-stream`, `text/plain`, `application/x-ndjson`, etc.), the stream is a raw concatenation of bytes. The server doesn't interpret message boundaries -- that's up to your application. For structured data over a byte stream, use a self-delimiting format like NDJSON.

### JSON mode

Streams created with `Content-Type: application/json` get special treatment:

- **Message boundaries are preserved.** Each POST stores its payload as a distinct message.
- **Array flattening.** POSTing a JSON array like `[a, b, c]` stores three separate messages, not one array. This lets you batch multiple messages in a single HTTP request.
- **GET returns a JSON array** containing all messages in the requested range.

```
POST /streams/events
Content-Type: application/json

[{"event": "click"}, {"event": "scroll"}]
# Stores two separate messages
```

```
GET /streams/events?offset=-1

< 200 OK
< Content-Type: application/json
[{"event":"click"},{"event":"scroll"}]
```

## Producers

Any HTTP client can append data to a stream with a POST request.

### Idempotent producers

For exactly-once write semantics, a producer can identify itself using three headers:

| Header | Purpose |
|--------|---------|
| `Producer-Id` | Stable identifier for the producer (e.g., `"order-service-1"`) |
| `Producer-Epoch` | Incremented on producer restart to establish a new session |
| `Producer-Seq` | Monotonically increasing sequence number within an epoch, per request |

All three headers must be provided together or not at all.

The server tracks the last accepted sequence number for each `(stream, producerId, epoch)` tuple. If a request arrives with a sequence number the server has already seen, it returns a deduplicated success response instead of writing duplicate data. This makes retries safe.

```
POST /streams/orders
Producer-Id: order-service-1
Producer-Epoch: 0
Producer-Seq: 0

{"order": "abc"}

< 200 OK
```

Retrying the same request returns `204 No Content` -- the data was already written.

### Epoch-based fencing

When a producer restarts, it increments its epoch and resets its sequence to 0. The server accepts the new epoch and **fences out** any stale producer still using the old epoch -- those requests receive `403 Forbidden`. This prevents "zombie" producers from writing duplicate data after a crash and restart.

## Consumers

Read data from a stream with a GET request, passing the offset to start from.

### Catch-up reads

To replay all existing data, start from offset `"-1"` (or omit the offset). The server returns available data along with headers that tell you what to do next:

| Header | Meaning |
|--------|---------|
| `Stream-Next-Offset` | Use this offset in your next GET request |
| `Stream-Up-To-Date: true` | You've caught up with all currently available data |
| `Stream-Closed: true` | The stream is closed -- no more data will ever arrive (EOF) |

`Stream-Up-To-Date` means you've consumed everything available *right now* but more data may be appended later. `Stream-Closed` means the stream is permanently finished.

A typical read loop:

```
offset = "-1"

loop:
  GET /stream?offset={offset}
  process(response.body)
  offset = response.headers["Stream-Next-Offset"]

  if response.headers["Stream-Closed"]:
    break  # EOF

  if response.headers["Stream-Up-To-Date"]:
    # caught up -- switch to live mode or poll again later
```

## Live Modes

Once a consumer has caught up, it can subscribe to new data in real time using one of two live modes.

### Long-poll

Add `?live=long-poll` to your GET request. The server holds the connection open until new data arrives or a timeout expires:

- **200 OK** with data -- new data arrived
- **204 No Content** -- timeout expired, no new data yet (retry with the same offset)

```
GET /stream?offset=01JQXK5V00&live=long-poll

# Server waits…

< 200 OK
< Stream-Next-Offset: 01JQXK8M00
< …new data…
```

Long-poll is efficient for tailing a stream without constant polling, and works well with binary content types.

### SSE (Server-Sent Events)

Add `?live=sse` to get a streaming SSE connection. The server emits two event types:

- **`data`** events carry the stream payload
- **`control`** events carry metadata (next offset, up-to-date status, closed status)

```
GET /stream?offset=01JQXK5V00&live=sse

< 200 OK
< Content-Type: text/event-stream

event: data
data: [{"event":"click"}]

event: control
data: {"streamNextOffset":"01JQXK8M00","streamCursor":"abc","upToDate":true}
```

The server periodically closes SSE connections (roughly every 60 seconds) to enable CDN connection collapsing. Clients reconnect using the `streamNextOffset` from the last `control` event.

If a `control` event includes `streamClosed: true`, the stream is finished -- do not reconnect.

### When to use which

- **SSE** is a natural fit for JSON streams and text-based content where you want continuous real-time delivery.
- **Long-poll** works well for binary content and scenarios where you want simple request/response semantics.

Both modes can be used interchangeably against the same stream.

## Stream Lifecycle

A stream moves through a simple lifecycle:

**Create** the stream with PUT. This is idempotent -- PUTting an existing stream with the same configuration returns `200 OK`.

```
PUT /streams/my-stream
Content-Type: application/json

< 201 Created
```

**Append** data with POST.

```
POST /streams/my-stream
Content-Type: application/json

{"event": "started"}

< 204 No Content
< Stream-Next-Offset: 01JQXK5V00
```

**Close** the stream by including `Stream-Closed: true` on a POST. This signals EOF -- no more data can be appended. Closure is durable and monotonic: once closed, a stream stays closed. You can atomically append a final message and close in a single request.

```
POST /streams/my-stream
Stream-Closed: true

< 204 No Content
< Stream-Closed: true
```

After closure, all existing data remains fully readable. Only new appends are rejected.

**Delete** the stream with DELETE to remove it and all its data.

```
DELETE /streams/my-stream
< 204 No Content
```

## CDN Caching

The protocol is designed to work well with CDNs and HTTP caches.

**Historical reads are cache-friendly.** Catch-up responses for a given offset range are immutable -- the data at those offsets never changes. Servers return appropriate `Cache-Control` and `ETag` headers so CDNs can cache and serve these responses directly.

**Cursor-based collapsing in live mode.** When multiple clients are tailing the same stream at the same offset, the server provides a `Stream-Cursor` value that clients echo back on subsequent requests. This allows CDN edge nodes to collapse those waiting clients into a single upstream connection, enabling massive fan-out from a single origin.

**Conditional requests.** Servers include `ETag` headers on GET responses. Clients can use `If-None-Match` for efficient cache validation, receiving `304 Not Modified` when the data hasn't changed.

---

For the complete protocol specification -- including exact header semantics, error codes, validation rules, and edge cases -- see [PROTOCOL.md](../PROTOCOL.md).

See also: [Getting Started](getting-started.md) | [Building a Client](building-a-client.md) | [Building a Server](building-a-server.md)
