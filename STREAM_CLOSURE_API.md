# Stream Closure API Proposal (TypeScript Client)

This document outlines the proposed API changes for implementing stream closure (EOF) support in the TypeScript client, based on the protocol changes in [PROTOCOL.md](./PROTOCOL.md).

**Tracking Issue:** https://github.com/durable-streams/durable-streams/issues/215

## Overview

Stream closure provides an explicit end-of-stream (EOF) signal that allows readers to distinguish between "no data yet" and "no more data ever." This is essential for finite streams where writers need to signal completion.

### API Summary

**Writer API:**

| Addition                                  | Description                                     |
| ----------------------------------------- | ----------------------------------------------- |
| `DurableStream.close(opts?)`              | Close a stream, optionally with a final message |
| `CreateOptions.closed`                    | Create a stream in closed state                 |
| `IdempotentProducer.close(finalMessage?)` | Flush pending + close stream (idempotent)       |
| `IdempotentProducer.detach()`             | Stop producer without closing stream            |

**Reader API:**

| Addition                      | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `StreamResponse.streamClosed` | `boolean` — true when stream is at EOF         |
| `JsonBatch.streamClosed`      | `boolean` — true on the final batch            |
| `HeadResult.streamClosed`     | `boolean` — check if stream is closed via HEAD |

**Error Handling:**

| Addition            | Description                              |
| ------------------- | ---------------------------------------- |
| `StreamClosedError` | Thrown when appending to a closed stream |

**Behavior Changes:**

- ReadableStream APIs (`jsonStream()`, `bodyStream()`, etc.) automatically close when `streamClosed` is true
- Subscriber APIs receive `streamClosed` in batch/chunk metadata
- Live modes (long-poll, SSE) stop polling/reconnecting when `streamClosed` is true

### Protocol Summary

- **`Stream-Closed: true`** header indicates a stream is closed
- **Close operation**: POST with `Stream-Closed: true` header
- **Atomic close**: POST with body + `Stream-Closed: true` for final append + close
- **Create closed**: PUT with `Stream-Closed: true` to create in closed state
- **SSE control event**: `streamClosed: true` field
- **409 Conflict**: Returned when appending to a closed stream (with `Stream-Closed: true` header)

---

## Design Decisions

### Naming: `streamClosed` vs `closed`

We use `streamClosed` rather than `closed` because:

1. **Avoids collision**: `StreamResponse` already has `closed: Promise<void>` for session lifecycle
2. **Semantic clarity**: `closed` (Promise) = "session ended", `streamClosed` (boolean) = "EOF, no more data ever"
3. **Protocol alignment**: Matches the `Stream-Closed` header and `streamClosed` SSE control field names

### `streamClosed` is Always Present (Not Optional)

All metadata types use `streamClosed: boolean` rather than `streamClosed?: boolean`. This avoids ambiguity between `undefined` and `false`—consumers don't need to handle both cases.

### State Matrix: `upToDate` × `streamClosed`

| `upToDate` | `streamClosed` | Possible? | Meaning                                                           |
| ---------- | -------------- | --------- | ----------------------------------------------------------------- |
| `false`    | `false`        | ✅        | **Catching up** — more data exists (stream may be open or closed) |
| `true`     | `false`        | ✅        | **Caught up** — at tail of open stream, waiting for new data      |
| `false`    | `true`         | ❌        | Not possible — `streamClosed` only appears at final offset        |
| `true`     | `true`         | ✅        | **Complete** — at final offset, stream permanently closed         |

**Key insights:**

- `streamClosed: true` **only appears when the client has reached the final offset** — you don't learn about closure until you're at the tail
- When catching up to a closed stream, you see `(upToDate: false, streamClosed: false)` until you reach the end
- Only `upToDate: true && streamClosed: true` means "you have everything and nothing more will ever come"
- This design enables caching: intermediate chunks don't need to know about closure

### When Does `streamClosed: true` Appear?

Per the protocol, `streamClosed: true` appears when the client has **reached the final offset** of a closed stream. This is not necessarily the response containing the final data—it depends on timing:

**Case 1: Stream closed before client catches up**

The response containing the final data includes `streamClosed: true`:

```
Writer: append(A) → append(B) → close()
Reader: GET offset=0 → receives [A, B] with streamClosed: true
```

**Case 2: Stream closed after client catches up**

The client discovers closure on the **next request** (which returns an empty body):

```
Writer: append(A) → append(B)
Reader: GET offset=0 → receives [A, B] with upToDate: true (no streamClosed)
Writer: close()
Reader: GET offset=X (next offset) → receives empty body with streamClosed: true
```

**Case 3: Close with no final message while client is caught up**

```
Reader: polling at tail, upToDate: true
Writer: close()
Reader: long-poll returns immediately → 204 No Content with streamClosed: true
```

**Why this design?**

This enables caching: data chunks remain cacheable regardless of whether the stream is later closed. The closure signal is always discovered by requesting the offset after the last data, ensuring cached chunks never become stale.

**Client implications:**

- Subscriber callbacks may receive a final batch with **zero items** but `streamClosed: true`
- ReadableStream APIs close after delivering the empty response (no visible empty batch to consumers)
- The `streamClosed` property on `StreamResponse` is updated when the closure signal is received

---

## Constants

```typescript
// constants.ts

/** Response/request header indicating stream is closed (EOF). */
export const STREAM_CLOSED_HEADER = `Stream-Closed`

/** SSE control event field for stream closed state. */
export const SSE_CLOSED_FIELD = `streamClosed`
```

---

## Types

### HeadResult

```typescript
export interface HeadResult {
  exists: true
  contentType?: string
  offset?: Offset
  etag?: string
  cacheControl?: string

  /**
   * Whether the stream is closed.
   * When true, no further appends are permitted.
   */
  streamClosed: boolean // NEW (always present, defaults to false)
}
```

### JsonBatchMeta / ByteChunk / TextChunk

```typescript
export interface JsonBatchMeta {
  offset: Offset
  upToDate: boolean
  cursor?: string

  /**
   * Whether the stream is closed and this batch contains the final data.
   * When true, no more data will ever be appended to the stream.
   */
  streamClosed: boolean // NEW (always present, defaults to false)
}

// ByteChunk and TextChunk extend JsonBatchMeta, so they inherit streamClosed
```

### StreamResponse

```typescript
export interface StreamResponse<TJson = unknown> {
  // ... existing properties ...

  /**
   * Whether the stream is closed (EOF).
   *
   * When true, no more data will ever be appended to the stream.
   * This is updated after each chunk is delivered to the consumer.
   *
   * In live mode, when streamClosed becomes true:
   * - Long-poll requests return immediately (no waiting)
   * - SSE connections are closed by the server
   * - Clients stop reconnecting automatically
   */
  readonly streamClosed: boolean // NEW

  /**
   * Resolves when the session has fully closed.
   * (existing - unchanged)
   */
  readonly closed: Promise<void>
}
```

### SSEControlEvent (internal)

```typescript
export interface SSEControlEvent {
  type: "control"
  streamNextOffset: Offset
  streamCursor?: string // Omitted when streamClosed is true
  upToDate?: boolean // May be omitted when streamClosed is true (implied)
  streamClosed?: boolean // NEW (optional in protocol, we default to false)
}
```

**Note:** When `streamClosed: true`, the server omits `streamCursor` since clients must not reconnect. Clients must tolerate missing `streamCursor` when `streamClosed` is present.

---

## Writer API

### CloseResult

```typescript
/**
 * Result of a close operation.
 */
export interface CloseResult {
  /**
   * The final offset of the stream.
   * This is the offset after the last byte (including any final message).
   * Returned via the `Stream-Next-Offset` header.
   */
  finalOffset: Offset
}
```

**Idempotency notes:**

- **`close()` without body** (close-only): Idempotent. Calling on an already-closed stream returns `204 No Content` with the same `finalOffset`.

- **`close({ body })` with body**: **NOT idempotent** (without idempotent producer headers). If the stream is already closed, the server returns `409 Conflict` with `Stream-Closed: true` because the body cannot be appended. Use `IdempotentProducer.close()` if you need idempotent close-with-body semantics.

### CloseOptions

```typescript
export interface CloseOptions {
  /**
   * Optional final message to append atomically with close.
   * For JSON streams, pass a pre-serialized JSON string.
   * Strings are UTF-8 encoded.
   */
  body?: Uint8Array | string

  /**
   * Content type for the final message.
   * Defaults to the stream's content type. Must match if provided.
   */
  contentType?: string

  /**
   * AbortSignal for this operation.
   */
  signal?: AbortSignal
}
```

### DurableStream.close()

````typescript
class DurableStream {
  /**
   * Close the stream, optionally with a final message.
   *
   * After closing:
   * - No further appends are permitted (server returns 409)
   * - Readers can observe the closed state and treat it as EOF
   * - The stream's data remains fully readable
   *
   * Closing is:
   * - **Durable**: The closed state is persisted
   * - **Monotonic**: Once closed, a stream cannot be reopened
   *
   * **Idempotency:**
   * - `close()` without body: Idempotent — safe to call multiple times
   * - `close({ body })` with body: NOT idempotent — throws `StreamClosedError`
   *   if stream is already closed (use `IdempotentProducer.close()` for
   *   idempotent close-with-body semantics)
   *
   * @returns CloseResult with the final offset
   * @throws StreamClosedError if called with body on an already-closed stream
   *
   * @example
   * ```typescript
   * // Close with no final message (idempotent)
   * const result = await stream.close()
   * console.log("Final offset:", result.finalOffset)
   *
   * // Atomically append final message and close (NOT idempotent)
   * const result = await stream.close({
   *   body: JSON.stringify({ status: "complete", total: 42 })
   * })
   *
   * // Close-only is idempotent - safe to call multiple times
   * await stream.close()
   * await stream.close()  // succeeds
   *
   * // Close-with-body is NOT idempotent
   * await stream.close({ body: "final" })
   * await stream.close({ body: "final" })  // throws StreamClosedError
   * ```
   */
  async close(opts?: CloseOptions): Promise<CloseResult>
}
````

### DurableStream.create() - closed option

````typescript
export interface CreateOptions extends StreamHandleOptions {
  // ... existing options ...

  /**
   * If true, create the stream in the closed state.
   * Any body provided becomes the complete and final content.
   *
   * Useful for:
   * - Cached responses
   * - Placeholder errors
   * - Pre-computed results
   * - Single-message streams that are immediately complete
   *
   * @example
   * ```typescript
   * // Create an empty closed stream
   * const stream = await DurableStream.create({
   *   url,
   *   contentType: 'application/json',
   *   closed: true
   * })
   *
   * // Create a closed stream with content
   * const stream = await DurableStream.create({
   *   url,
   *   contentType: 'application/json',
   *   body: JSON.stringify({ cached: true, data: [...] }),
   *   closed: true
   * })
   * ```
   */
  closed?: boolean // NEW
}
````

### IdempotentProducer Methods

The `IdempotentProducer` naming is updated to make the common case simple and avoid confusion:

````typescript
class IdempotentProducer {
  /**
   * Flush pending messages and close the underlying stream (EOF).
   *
   * This is the typical way to end a producer session. It:
   * 1. Flushes all pending messages
   * 2. Optionally appends a final message
   * 3. Closes the stream (no further appends permitted)
   *
   * **Idempotent**: Unlike `DurableStream.close({ body })`, this method is
   * idempotent even with a final message because it uses producer headers
   * for deduplication. Safe to retry on network failures.
   *
   * @param finalMessage - Optional final message to append atomically with close
   * @returns CloseResult with the final offset
   *
   * @example
   * ```typescript
   * const producer = new IdempotentProducer(stream, "writer-1")
   *
   * producer.append(JSON.stringify({ event: "start" }))
   * producer.append(JSON.stringify({ event: "data", value: 42 }))
   *
   * // Flush all pending and close the stream (idempotent, safe to retry)
   * await producer.close(JSON.stringify({ event: "end" }))
   * ```
   */
  async close(finalMessage?: Uint8Array | string): Promise<CloseResult>

  /**
   * Stop the producer without closing the underlying stream.
   *
   * Use this when you want to:
   * - Hand off writing to another producer
   * - Keep the stream open for future writes
   * - Stop this producer but not signal EOF to readers
   *
   * Flushes any pending messages before detaching.
   *
   * @example
   * ```typescript
   * // Stop writing but keep stream open
   * await producer.detach()
   *
   * // Another producer can continue
   * const producer2 = new IdempotentProducer(stream, "writer-2")
   * producer2.append(...)
   * ```
   */
  async detach(): Promise<void>
}
````

**Note:** This is a breaking change from the current API where `close()` doesn't close the stream. The old behavior is now `detach()`.

---

## Reader Behavior

### Catch-up Mode

- `Stream-Closed: true` is included when the client has **reached the final offset** of a closed stream
- If returning partial data from a closed stream (more data exists before the final offset), `Stream-Closed` is NOT included
- The closure signal is typically discovered by requesting the **next offset** after receiving the last data:
  - If stream is closed: returns `200 OK` with empty body and `Stream-Closed: true`
  - If stream is open: returns `200 OK` with empty body and `Stream-Up-To-Date: true`
- This design ensures all data chunks remain cacheable

### Long-Poll Mode

When the stream is closed and the client is at the tail offset:

- Server returns `204 No Content` with `Stream-Closed: true` **immediately** (no waiting for timeout)
- Client sets `streamClosed = true` on `StreamResponse`
- Client stops polling (session ends normally)

If the stream is closed while a long-poll is waiting:

- The long-poll returns immediately with the closure signal
- No hanging connections waiting for data that will never arrive

### SSE Mode

When the stream is closed:

- Final control event includes `streamClosed: true` (and implicitly `upToDate: true`)
- `streamCursor` is **omitted** when `streamClosed: true` (cursor unnecessary, no reconnection expected)
- Server closes the SSE connection after the final control event
- Client sets `streamClosed = true` and does NOT attempt to reconnect

If the stream is already closed when an SSE connection is established and the client is at the tail:

- Server immediately emits a `control` event with `streamClosed: true`
- Server then closes the connection

### ReadableStream APIs

**`jsonStream()`, `bodyStream()`, `textStream()`**

- Stream closes automatically when `streamClosed: true` is reached
- No per-chunk metadata (yields raw values only)
- Check `res.streamClosed` after iteration to confirm EOF

```typescript
for await (const item of res.jsonStream()) {
  process(item)
}
// Stream exited automatically at EOF
console.log("Complete:", res.streamClosed) // true
```

### Subscriber APIs

**`subscribeJson()`, `subscribeBytes()`, `subscribeText()`**

- Receive `streamClosed` in each batch/chunk metadata
- Can react to EOF immediately as it arrives

```typescript
res.subscribeJson((batch) => {
  process(batch.items)
  if (batch.streamClosed) {
    showCompleteBanner() // React immediately to EOF
  }
})
```

### Accumulator APIs

**`json()`, `body()`, `text()`**

- Return all data up to `upToDate` (existing behavior)
- Check `res.streamClosed` after to confirm the stream is complete

```typescript
const items = await res.json()
console.log(`Got ${items.length} items, complete: ${res.streamClosed}`)
```

### Summary Table

| Method             | Per-chunk `streamClosed` | Auto-exits at EOF | Check after        |
| ------------------ | ------------------------ | ----------------- | ------------------ |
| `subscribeJson()`  | ✅ `batch.streamClosed`  | ✅                | `res.streamClosed` |
| `subscribeBytes()` | ✅ `chunk.streamClosed`  | ✅                | `res.streamClosed` |
| `subscribeText()`  | ✅ `chunk.streamClosed`  | ✅                | `res.streamClosed` |
| `jsonStream()`     | ❌                       | ✅                | `res.streamClosed` |
| `bodyStream()`     | ❌                       | ✅                | `res.streamClosed` |
| `textStream()`     | ❌                       | ✅                | `res.streamClosed` |
| `json()`           | N/A                      | ✅                | `res.streamClosed` |
| `body()`           | N/A                      | ✅                | `res.streamClosed` |
| `text()`           | N/A                      | ✅                | `res.streamClosed` |

### Caching Behavior

The protocol is designed so that data chunks remain cacheable regardless of stream closure:

1. **Data chunks are always cacheable** — A chunk that returns data does not "become stale" if the stream is later closed
2. **Closure is discovered at the tail** — The `streamClosed: true` signal comes from requesting the offset _after_ the last data
3. **One extra request at EOF** — Clients make one additional request to discover EOF (empty body with `streamClosed: true`)

This means:

- CDN-cached chunks remain valid even after closure
- The closure signal itself (`200 OK` + empty body + `Stream-Closed: true`) can be cached with short TTL
- Clients don't need special cache-invalidation logic for closed streams

---

## Error Handling

### StreamClosedError

```typescript
/**
 * Error thrown when attempting to append to a closed stream.
 */
export class StreamClosedError extends DurableStreamError {
  readonly code = 'STREAM_CLOSED'
  readonly status = 409
  readonly streamClosed = true  // Useful for type narrowing

  /**
   * The final offset of the stream, if available from the response.
   */
  readonly finalOffset?: Offset

  constructor(url?: string, finalOffset?: Offset) {
    super(`Cannot append to closed stream`, 'STREAM_CLOSED', 409, url)
    this.name = 'StreamClosedError'
    this.finalOffset = finalOffset
  }
}

// Add to error code union
export type DurableStreamErrorCode =
  | ... existing ...
  | `STREAM_CLOSED`  // NEW
```

When a POST to a closed stream returns `409 Conflict` with `Stream-Closed: true`:

```typescript
try {
  await stream.append(data)
} catch (err) {
  if (err instanceof StreamClosedError) {
    console.log("Stream is closed, cannot append")
    console.log("Final offset:", err.finalOffset)
  }
}
```

---

## Usage Examples

### Fetch Proxy (Primary Use Case)

```typescript
// Server-side: proxy an upstream response into a durable stream
async function proxyResponse(upstreamUrl: string, streamUrl: string) {
  const upstream = await fetch(upstreamUrl)
  const stream = await DurableStream.create({
    url: streamUrl,
    contentType:
      upstream.headers.get("content-type") || "application/octet-stream",
  })

  // Stream the response body
  const reader = upstream.body!.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await stream.append(value)
    }
    // Close the stream when upstream is complete
    const result = await stream.close()
    console.log("Proxy complete, final offset:", result.finalOffset)
  } catch (err) {
    // On error, close with error status
    await stream.close({ body: JSON.stringify({ error: String(err) }) })
  }
}

// Client-side: read the proxied response (auto-exits at EOF)
const res = await stream.stream()

for await (const chunk of res.bodyStream()) {
  output.write(chunk)
}

console.log("Transfer complete:", res.streamClosed) // true
```

### Job Output Stream

```typescript
// Writer: job executor
const stream = await DurableStream.create({
  url,
  contentType: "application/json",
})
const producer = new IdempotentProducer(stream, `job-${jobId}`)

producer.append(JSON.stringify({ type: "log", message: "Starting..." }))
// ... job execution ...
producer.append(JSON.stringify({ type: "log", message: "Processing..." }))

// Job complete - flush pending and close the stream with final status
await producer.close(
  JSON.stringify({
    type: "complete",
    exitCode: 0,
    duration: 1234,
  })
)

// Reader: job monitor
const res = await stream.stream()
const logs: JobEvent[] = []

res.subscribeJson<JobEvent>(async (batch) => {
  for (const event of batch.items) {
    logs.push(event)
    if (event.type === "complete") {
      console.log(`Job finished with code ${event.exitCode}`)
    }
  }

  if (batch.streamClosed) {
    console.log("Job stream complete")
  }
})

await res.closed // Wait for session to end
console.log(`Received ${logs.length} events`)
```

### Pre-computed/Cached Response

```typescript
// Create a stream that's immediately complete (e.g., cached data)
const stream = await DurableStream.create({
  url: cacheUrl,
  contentType: "application/json",
  body: JSON.stringify(cachedData),
  closed: true, // Stream is complete
})

// Reader sees it as already closed
const res = await stream.stream()
const data = await res.json()
console.log(`Got ${data.length} items, streamClosed: ${res.streamClosed}`) // true
```

### Check Stream Status

```typescript
const { streamClosed, offset } = await DurableStream.head({ url })

if (streamClosed) {
  console.log("Stream is complete, final offset:", offset)
} else {
  console.log("Stream is still open, current offset:", offset)
}
```

### Idempotent Close

```typescript
// Close-only is idempotent - safe to call multiple times
await stream.close()
await stream.close() // Succeeds, returns same finalOffset

// Close-with-body is NOT idempotent
await stream.close({ body: "final message" })
try {
  await stream.close({ body: "another message" })
} catch (err) {
  // StreamClosedError - stream is already closed
}
```

---

## Implementation Checklist

### Constants & Types

- [ ] Add `STREAM_CLOSED_HEADER` and `SSE_CLOSED_FIELD` constants
- [ ] Add `streamClosed: boolean` to `HeadResult` type
- [ ] Add `streamClosed: boolean` to `JsonBatchMeta` (and thus `ByteChunk`, `TextChunk`)
- [ ] Add `streamClosed: boolean` to `StreamResponse` interface
- [ ] Add `streamClosed?: boolean` to `SSEControlEvent` interface
- [ ] Add `CloseResult` interface
- [ ] Add `CloseOptions` interface

### Reader Implementation

- [ ] Parse `Stream-Closed` header in `head()` method
- [ ] Parse `Stream-Closed` header in response handling (`response.ts`)
- [ ] Parse `streamClosed` in SSE control event parsing (`sse.ts`)
- [ ] Stop reconnection when `streamClosed` is true (SSE and long-poll)
- [ ] Ensure ReadableStream APIs close automatically at EOF

### Writer Implementation

- [ ] Add `close()` method to `DurableStream` returning `CloseResult`
- [ ] Add `closed` option to `CreateOptions`
- [ ] Update `create()` to send `Stream-Closed: true` header when `closed: true`
- [ ] Rename `IdempotentProducer.close()` to `detach()`
- [ ] Add new `IdempotentProducer.close()` that flushes and closes stream

### Error Handling

- [ ] Add `StreamClosedError` class with `finalOffset` property
- [ ] Add `STREAM_CLOSED` to `DurableStreamErrorCode`
- [ ] Handle 409 + `Stream-Closed: true` as `StreamClosedError`

### Tests

- [ ] Add conformance tests for stream closure

---

## Conformance Test Cases

Tests to add to `packages/client-conformance-tests/test-cases/`:

### stream-closure.yaml (new file)

**Writer tests:**

1. **close-empty-stream** - Close a stream with no content
2. **close-with-content** - Append data, then close
3. **close-with-final-message** - Atomic append + close
4. **close-returns-result** - Verify CloseResult shape (finalOffset)
5. **close-idempotent** - Closing already-closed stream succeeds with same finalOffset
6. **create-closed-stream** - Create with closed: true
7. **create-closed-stream-with-body** - Create with body + closed: true
8. **append-to-closed-stream-fails** - 409 with Stream-Closed header → StreamClosedError

**Reader tests (catch-up):** 9. **read-closed-stream-catchup** - Reader sees streamClosed: true at final offset 10. **read-closed-stream-partial** - Partial read of closed stream, streamClosed only at final offset 11. **read-closed-stream-empty-eof** - Closure discovered via empty body response at tail 12. **head-closed-stream** - HEAD returns streamClosed: true

**Reader tests (live modes):** 13. **long-poll-closed-stream-immediate** - Returns immediately when at tail of closed stream 14. **long-poll-closed-during-wait** - Closure during long-poll returns immediately 15. **sse-closed-stream-final-event** - Final control event has streamClosed, cursor omitted 16. **sse-closed-stream-connection-closes** - Server closes connection after streamClosed 17. **sse-already-closed-at-tail** - Immediate control event with streamClosed when connecting to closed stream at tail

**State matrix tests:** 18. **state-catching-up** - upToDate: false, streamClosed: false (more data exists) 19. **state-caught-up-open** - upToDate: true, streamClosed: false (at tail, stream open) 20. **state-complete** - upToDate: true, streamClosed: true (at tail, stream closed) 21. **state-catching-up-closed-stream** - Verify partial read of closed stream shows (upToDate: false, streamClosed: false), then next request shows (upToDate: true, streamClosed: true)
