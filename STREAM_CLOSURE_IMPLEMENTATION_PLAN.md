# Stream Closure Implementation Plan: Reference Server & Conformance Tests

This document outlines the implementation plan for adding stream closure (EOF) support to the reference server (`packages/server`) and server conformance tests (`packages/server-conformance-tests`), based on the protocol changes in [PROTOCOL.md](./PROTOCOL.md).

## Overview

Stream closure provides an explicit end-of-stream (EOF) signal that allows readers to distinguish between "no data yet" and "no more data ever." This is a key feature for finite streams like proxied HTTP responses, job outputs, and completed conversations.

### Protocol Summary

- **`Stream-Closed: true`** header signals stream closure
- Streams can be closed via:
  - POST with `Stream-Closed: true` (close-only or close-with-final-append)
  - PUT with `Stream-Closed: true` (create in closed state)
- Once closed, streams reject all appends with `409 Conflict` + `Stream-Closed: true`
- Readers discover closure when reaching the final offset

---

## Design Decisions

### Close-Only Requests with Producer Headers

Per protocol Section 5.2.1:

> **Close without append**: Include `Stream-Closed: true` with empty body. Producer headers are optional but if provided, the close operation is still idempotent.

**Decision:** Close-only requests with producer headers WILL participate in producer sequencing:

1. Producer state is validated and updated (epoch/seq tracking)
2. Duplicate detection uses the same `(producerId, epoch, seq)` tuple matching
3. Response includes `Producer-Epoch` and `Producer-Seq` headers
4. Stale epochs return 403, sequence gaps return 409

**Rationale:**

- Enables clients to use a single producer for all operations (append, append-and-close, close-only)
- Maintains sequence continuity across the producer's lifetime
- Allows recovery/retry of close operations with the same semantics as appends

**Alternative considered:** Close-only could bypass producer validation entirely (simpler). However, this would break sequence continuity and make close-only a "special" operation that doesn't fit the producer model.

---

## Implementation Tasks

### Phase 1: Types & Constants

#### 1.1. Add Constants (`packages/server/src/server.ts`)

```typescript
// Add to protocol headers section
const STREAM_CLOSED_HEADER = `Stream-Closed`

// Add to SSE control event fields section
const SSE_CLOSED_FIELD = `streamClosed`
```

#### 1.2. Update Stream Type (`packages/server/src/types.ts`)

Add `closed` property to the `Stream` interface:

```typescript
export interface Stream {
  // ... existing properties ...

  /**
   * Whether the stream is closed (no further appends permitted).
   * Once set to true, this is permanent and durable.
   */
  closed?: boolean
}
```

---

### Phase 2: Store Layer Changes

#### 2.1. Update `StreamStore.create()` (`packages/server/src/store.ts`)

- Accept `closed?: boolean` in create options
- Set `stream.closed = true` when creating in closed state
- Include `closed` in idempotent create config comparison

```typescript
create(
  path: string,
  options: {
    contentType?: string
    ttlSeconds?: number
    expiresAt?: string
    initialData?: Uint8Array
    closed?: boolean  // NEW
  } = {}
): Stream {
  // ... existing code ...

  const stream: Stream = {
    path,
    contentType: options.contentType,
    messages: [],
    currentOffset: `0000000000000000_0000000000000000`,
    ttlSeconds: options.ttlSeconds,
    expiresAt: options.expiresAt,
    createdAt: Date.now(),
    closed: options.closed ?? false,  // NEW
  }

  // ... rest of method ...
}
```

#### 2.2. Update `StreamStore.append()` (`packages/server/src/store.ts`)

- Check if stream is closed before appending
- Return a result indicating closed state if attempt to append to closed stream
- Accept `close?: boolean` option to close stream atomically with append

```typescript
export interface AppendOptions {
  seq?: string
  contentType?: string
  producerId?: string
  producerEpoch?: number
  producerSeq?: number
  close?: boolean  // NEW: Close stream after append
}

export interface AppendResult {
  message: StreamMessage | null
  producerResult?: ProducerValidationResult
  streamClosed?: boolean  // NEW: Stream is now closed
}

// In append method:
append(path: string, data: Uint8Array, options: AppendOptions = {}): StreamMessage | AppendResult {
  const stream = this.getIfNotExpired(path)
  if (!stream) {
    throw new Error(`Stream not found: ${path}`)
  }

  // NEW: Check if stream is closed
  if (stream.closed) {
    return {
      message: null,
      streamClosed: true,
      // For idempotent producers, check if this is a duplicate of the closing request
      producerResult: options.producerId ? this.checkClosedStreamDuplicate(...) : undefined
    }
  }

  // ... existing append logic ...

  // NEW: Close stream if requested
  if (options.close) {
    stream.closed = true
  }

  return { message, producerResult, streamClosed: options.close }
}
```

#### 2.3. Add Close Method (`packages/server/src/store.ts`)

Add a dedicated method for close-only operations (no data):

```typescript
/**
 * Close a stream without appending data.
 * @returns The final offset, or null if stream doesn't exist
 */
close(path: string): { finalOffset: string; alreadyClosed: boolean } | null {
  const stream = this.getIfNotExpired(path)
  if (!stream) {
    return null
  }

  const alreadyClosed = stream.closed ?? false
  stream.closed = true

  // Notify any pending long-polls that the stream is closed
  this.notifyLongPollsClosed(path)

  return {
    finalOffset: stream.currentOffset,
    alreadyClosed
  }
}

/**
 * Close a stream with producer headers for idempotent close-only operations.
 * Participates in producer sequencing for deduplication.
 * @returns The final offset and producer result, or null if stream doesn't exist
 */
async closeWithProducer(
  path: string,
  options: {
    producerId: string
    producerEpoch: number
    producerSeq: number
  }
): Promise<{
  finalOffset: string
  alreadyClosed: boolean
  producerResult?: ProducerValidationResult
} | null> {
  // Acquire producer lock for serialization
  const releaseLock = await this.acquireProducerLock(path, options.producerId)

  try {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      return null
    }

    // Check if already closed by this producer tuple (duplicate)
    if (stream.closed && stream.closedBy) {
      if (
        stream.closedBy.producerId === options.producerId &&
        stream.closedBy.epoch === options.producerEpoch &&
        stream.closedBy.seq === options.producerSeq
      ) {
        return {
          finalOffset: stream.currentOffset,
          alreadyClosed: true,
          producerResult: { status: `duplicate`, lastSeq: options.producerSeq },
        }
      }
    }

    // Validate producer state
    const producerResult = this.validateProducer(
      stream,
      options.producerId,
      options.producerEpoch,
      options.producerSeq
    )

    // Return early for non-accepted results
    if (producerResult.status !== `accepted`) {
      return {
        finalOffset: stream.currentOffset,
        alreadyClosed: stream.closed ?? false,
        producerResult,
      }
    }

    // Commit producer state and close stream
    this.commitProducerState(stream, producerResult)
    stream.closed = true
    stream.closedBy = {
      producerId: options.producerId,
      epoch: options.producerEpoch,
      seq: options.producerSeq,
    }

    // Notify any pending long-polls
    this.notifyLongPollsClosed(path)

    return {
      finalOffset: stream.currentOffset,
      alreadyClosed: false,
      producerResult,
    }
  } finally {
    releaseLock()
  }
}
```

#### 2.4. Update Long-Poll Behavior (`packages/server/src/store.ts`)

When a stream is closed, long-polls should return immediately:

```typescript
async waitForMessages(
  path: string,
  offset: string,
  timeoutMs: number
): Promise<{ messages: Array<StreamMessage>; timedOut: boolean; streamClosed?: boolean }> {
  const stream = this.getIfNotExpired(path)
  if (!stream) {
    throw new Error(`Stream not found: ${path}`)
  }

  // NEW: If stream is closed and client is at tail, return immediately
  if (stream.closed && offset === stream.currentOffset) {
    return { messages: [], timedOut: false, streamClosed: true }
  }

  // ... existing wait logic ...

  // Also add streamClosed to result when returning after wait
}
```

#### 2.5. Update `FileBackedStreamStore` (`packages/server/src/file-store.ts`)

Apply the same changes to the file-backed store:

- Add `closed` field to persisted stream metadata
- Add `closedBy` field to persisted stream metadata (required for idempotent duplicate close detection after restart)
- Implement close semantics
- Update LMDB schema if needed

**Important:** The `closedBy` tuple must be persisted alongside `closed`. If `closedBy` is lost on restart, an idempotent producer retrying a successful close-with-append will incorrectly receive `409 Conflict` instead of `204 No Content`. Per protocol Section 5.2.1:

> If the stream was already closed by the same `(producerId, epoch, seq)` tuple, servers **SHOULD** return `204 No Content` with `Stream-Closed: true`.

```typescript
// In file-store metadata schema:
interface PersistedStreamMetadata {
  // ... existing fields ...
  closed?: boolean
  closedBy?: {
    producerId: string
    epoch: number
    seq: number
  }
}
```

---

### Phase 3: Server HTTP Handler Changes

#### 3.1. Update `handleCreate()` (`packages/server/src/server.ts`)

Handle `Stream-Closed: true` header on PUT:

```typescript
private async handleCreate(
  path: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // ... existing header parsing ...

  // NEW: Parse Stream-Closed header
  const closedHeader = req.headers[STREAM_CLOSED_HEADER.toLowerCase()]
  const createClosed = closedHeader === `true`

  // Pass to store.create()
  await Promise.resolve(
    this.store.create(path, {
      contentType,
      ttlSeconds,
      expiresAt: expiresAtHeader,
      initialData: body.length > 0 ? body : undefined,
      closed: createClosed,  // NEW
    })
  )

  // ... existing response logic ...

  // NEW: Include Stream-Closed header in response if created closed
  if (createClosed) {
    headers[STREAM_CLOSED_HEADER] = `true`
  }
}
```

#### 3.2. Update `handleAppend()` (`packages/server/src/server.ts`)

Handle close operations:

```typescript
private async handleAppend(
  path: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // ... existing header parsing ...

  // NEW: Parse Stream-Closed header
  const closedHeader = req.headers[STREAM_CLOSED_HEADER.toLowerCase()]
  const closeStream = closedHeader === `true`

  const body = await this.readBody(req)

  // NEW: Allow empty body ONLY if closing
  if (body.length === 0 && !closeStream) {
    res.writeHead(400, { "content-type": `text/plain` })
    res.end(`Empty body`)
    return
  }

  // NEW: Handle close-only request (empty body with Stream-Closed)
  // Note: Content-Type is ignored for close-only requests per protocol Section 5.2
  if (body.length === 0 && closeStream) {
    // Close-only with producer headers should participate in producer sequencing
    // This enables idempotent close-only operations with proper deduplication
    if (hasAllProducerHeaders) {
      const closeResult = await this.store.closeWithProducer(path, {
        producerId: producerId!,
        producerEpoch: producerEpoch!,
        producerSeq: producerSeq!,
      })

      if (!closeResult) {
        res.writeHead(404, { "content-type": `text/plain` })
        res.end(`Stream not found`)
        return
      }

      // Handle producer validation results
      if (closeResult.producerResult?.status === `duplicate`) {
        res.writeHead(204, {
          [STREAM_OFFSET_HEADER]: closeResult.finalOffset,
          [STREAM_CLOSED_HEADER]: `true`,
          [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
          [PRODUCER_SEQ_HEADER]: closeResult.producerResult.lastSeq.toString(),
        })
        res.end()
        return
      }

      if (closeResult.producerResult?.status === `stale_epoch`) {
        res.writeHead(403, {
          "content-type": `text/plain`,
          [PRODUCER_EPOCH_HEADER]: closeResult.producerResult.currentEpoch.toString(),
        })
        res.end(`Stale producer epoch`)
        return
      }

      // Add other producer error handling as needed...

      res.writeHead(204, {
        [STREAM_OFFSET_HEADER]: closeResult.finalOffset,
        [STREAM_CLOSED_HEADER]: `true`,
        [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
        [PRODUCER_SEQ_HEADER]: producerSeq!.toString(),
      })
      res.end()
      return
    }

    // Close-only without producer headers (simple idempotent close)
    const closeResult = this.store.close(path)
    if (!closeResult) {
      res.writeHead(404, { "content-type": `text/plain` })
      res.end(`Stream not found`)
      return
    }

    res.writeHead(204, {
      [STREAM_OFFSET_HEADER]: closeResult.finalOffset,
      [STREAM_CLOSED_HEADER]: `true`,
    })
    res.end()
    return
  }

  // ... existing content-type validation ...

  // Build append options (add close flag)
  const appendOptions = {
    seq,
    contentType,
    producerId,
    producerEpoch,
    producerSeq,
    close: closeStream,  // NEW
  }

  // ... existing append logic ...

  // NEW: Handle append to closed stream
  if (result && typeof result === `object` && result.streamClosed && !result.message) {
    // Check if this is an idempotent producer duplicate (matching closing tuple)
    // Per protocol: duplicate close returns 204 No Content with Stream-Closed: true
    if (result.producerResult?.status === `duplicate`) {
      res.writeHead(204, {
        [STREAM_OFFSET_HEADER]: stream.currentOffset,
        [STREAM_CLOSED_HEADER]: `true`,
        [PRODUCER_EPOCH_HEADER]: options.producerEpoch!.toString(),
        [PRODUCER_SEQ_HEADER]: result.producerResult.lastSeq.toString(),
      })
      res.end()
      return
    }

    // Not a duplicate - stream was closed by different request, return 409
    res.writeHead(409, {
      "content-type": `text/plain`,
      [STREAM_CLOSED_HEADER]: `true`,
    })
    res.end(`Stream is closed`)
    return
  }

  // ... existing response logic ...

  // NEW: Include Stream-Closed in success response if stream is now closed
  if (result?.streamClosed || closeStream) {
    responseHeaders[STREAM_CLOSED_HEADER] = `true`
  }
}
```

#### 3.3. Update `handleHead()` (`packages/server/src/server.ts`)

Include `Stream-Closed` header when stream is closed:

```typescript
private handleHead(path: string, res: ServerResponse): void {
  const stream = this.store.get(path)
  if (!stream) {
    res.writeHead(404, { "content-type": `text/plain` })
    res.end()
    return
  }

  const headers: Record<string, string> = {
    [STREAM_OFFSET_HEADER]: stream.currentOffset,
    "cache-control": `no-store`,
  }

  // ... existing headers ...

  // NEW: Include Stream-Closed if stream is closed
  if (stream.closed) {
    headers[STREAM_CLOSED_HEADER] = `true`
  }

  res.writeHead(200, headers)
  res.end()
}
```

#### 3.4. Update `handleRead()` (`packages/server/src/server.ts`)

Include `Stream-Closed` header when client reaches tail of closed stream:

```typescript
private async handleRead(
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // ... existing read logic ...

  // NEW: Check if stream is closed for response headers
  const streamIsClosed = stream.closed ?? false
  const clientAtTail = responseOffset === stream.currentOffset

  // Set up-to-date header
  if (upToDate) {
    headers[STREAM_UP_TO_DATE_HEADER] = `true`
  }

  // NEW: Include Stream-Closed when client reaches tail of closed stream
  if (streamIsClosed && clientAtTail && upToDate) {
    headers[STREAM_CLOSED_HEADER] = `true`
  }

  // ... rest of response logic ...
}
```

#### 3.5. Update Long-Poll Response (`packages/server/src/server.ts`)

Handle closed streams in long-poll mode:

```typescript
// In handleRead, long-poll section:
if (live === `long-poll` && clientIsCaughtUp && messages.length === 0) {
  // NEW: Check if stream is closed - return immediately
  if (stream.closed) {
    res.writeHead(204, {
      [STREAM_OFFSET_HEADER]: stream.currentOffset,
      [STREAM_UP_TO_DATE_HEADER]: `true`,
      [STREAM_CLOSED_HEADER]: `true`,
    })
    res.end()
    return
  }

  const result = await this.store.waitForMessages(...)

  if (result.timedOut) {
    // ... existing timeout handling ...

    // NEW: Check if stream was closed during wait
    if (stream.closed) {
      res.writeHead(204, {
        [STREAM_OFFSET_HEADER]: stream.currentOffset,
        [STREAM_UP_TO_DATE_HEADER]: `true`,
        [STREAM_CURSOR_HEADER]: responseCursor,
        [STREAM_CLOSED_HEADER]: `true`,
      })
    } else {
      // ... existing response ...
    }
    res.end()
    return
  }

  // NEW: If stream was closed (result indicates closed), handle accordingly
  if (result.streamClosed) {
    // Return 204 with Stream-Closed immediately
    // ...
  }

  // ... rest of handling ...
}
```

#### 3.6. Update SSE Handler (`packages/server/src/server.ts`)

Handle closed streams in SSE mode:

```typescript
private async handleSSE(
  path: string,
  stream: ReturnType<StreamStore[`get`]>,
  initialOffset: string,
  cursor: string | undefined,
  res: ServerResponse
): Promise<void> {
  // ... existing setup ...

  while (isConnected && !this.isShuttingDown) {
    const { messages, upToDate } = this.store.read(path, currentOffset)

    // ... send data events ...

    // Build control event
    const controlData: Record<string, string | boolean> = {
      [SSE_OFFSET_FIELD]: controlOffset,
    }

    // NEW: Check if stream is closed and client is at tail
    const streamIsClosed = stream?.closed ?? false
    const clientAtTail = controlOffset === stream!.currentOffset

    if (streamIsClosed && clientAtTail) {
      // Final control event - stream is closed
      controlData[SSE_CLOSED_FIELD] = true
      // Note: streamCursor is omitted when streamClosed is true per protocol
      // upToDate is implied by streamClosed per protocol
    } else {
      // Normal control event
      controlData[SSE_CURSOR_FIELD] = responseCursor
      if (upToDate) {
        controlData[SSE_UP_TO_DATE_FIELD] = true
      }
    }

    res.write(`event: control\n`)
    res.write(encodeSSEData(JSON.stringify(controlData)))

    // NEW: Close SSE connection after sending streamClosed
    if (streamIsClosed && clientAtTail) {
      break  // Exit loop, connection will be closed
    }

    // ... rest of SSE loop ...

    // In wait section: check if stream was closed during wait
    if (upToDate) {
      // NEW: If stream is closed, don't wait - exit
      if (stream?.closed) {
        // Send final control event and exit
        const finalControlData = {
          [SSE_OFFSET_FIELD]: currentOffset,
          [SSE_CLOSED_FIELD]: true,
        }
        res.write(`event: control\n`)
        res.write(encodeSSEData(JSON.stringify(finalControlData)))
        break
      }

      const result = await this.store.waitForMessages(...)

      // NEW: Check if stream was closed during wait
      if (result.streamClosed) {
        const finalControlData = {
          [SSE_OFFSET_FIELD]: currentOffset,
          [SSE_CLOSED_FIELD]: true,
        }
        res.write(`event: control\n`)
        res.write(encodeSSEData(JSON.stringify(finalControlData)))
        break
      }

      // ... rest of wait handling ...
    }
  }

  // ... cleanup ...
}
```

#### 3.7. Update Error Handler (`packages/server/src/server.ts`)

Add handling for "stream is closed" errors:

```typescript
// In handleRequest catch block:
} else if (err.message.includes(`Stream is closed`)) {
  res.writeHead(409, {
    "content-type": `text/plain`,
    [STREAM_CLOSED_HEADER]: `true`,
  })
  res.end(`Stream is closed`)
}
```

#### 3.8. Update CORS Headers (`packages/server/src/server.ts`)

Add `Stream-Closed` to both CORS header lists:

```typescript
// Allow browsers to SEND Stream-Closed header in requests (preflighted POST/PUT)
res.setHeader(
  `access-control-allow-headers`,
  `content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq`
)

// Allow browsers to READ Stream-Closed header from responses
res.setHeader(
  `access-control-expose-headers`,
  `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary`
)
```

**Note:** Both headers are required:

- `Access-Control-Allow-Headers` - Allows the browser to send the header in requests
- `Access-Control-Expose-Headers` - Allows JavaScript to read the header from responses

#### 2.6. Add `notifyLongPollsClosed()` Method (`packages/server/src/store.ts`)

Add a method to wake up long-polls when a stream is closed:

```typescript
/**
 * Notify pending long-polls that a stream has been closed.
 * They should wake up immediately and return Stream-Closed: true.
 */
private notifyLongPollsClosed(path: string): void {
  const toNotify = this.pendingLongPolls.filter((p) => p.path === path)
  for (const pending of toNotify) {
    // Resolve with empty messages but include closed flag
    pending.resolve([])
  }
}
```

**Note:** The `waitForMessages` return type needs to include `streamClosed` so callers know why the wait ended.

#### 2.7. Audit: `append()` Return Type Change

The change from `StreamMessage` to `StreamMessage | AppendResult` affects all call sites. Here's the audit:

**Call sites to update:**

1. `DurableStreamTestServer.handleAppend()` - Already handles both return types
2. `StreamStore.appendWithProducer()` - Wraps result, already handles both
3. Any direct `store.append()` calls in tests

**Migration strategy:**

```typescript
// OLD: Assumes StreamMessage return
const message = store.append(path, data, options)
console.log(message.offset)

// NEW: Must handle union type
const result = store.append(path, data, options)
if ("message" in result) {
  // AppendResult
  if (result.message) {
    console.log(result.message.offset)
  }
} else {
  // StreamMessage (legacy path, may be removed)
  console.log(result.offset)
}
```

**Recommendation:** Change `append()` to always return `AppendResult` for consistency. The `StreamMessage` return path exists only for backward compatibility with non-producer appends.

```typescript
// Cleaner approach: always return AppendResult
append(path: string, data: Uint8Array, options: AppendOptions = {}): AppendResult {
  // ...
  return { message, producerResult, streamClosed: options.close }
}
```

---

### Phase 4: Idempotent Producer Integration

#### 4.1. Track Closing Request (`packages/server/src/store.ts`)

Track which `(producerId, epoch, seq)` tuple closed the stream for idempotent close:

```typescript
export interface Stream {
  // ... existing properties ...

  /**
   * The producer tuple that closed this stream (for idempotent close).
   * If set, duplicate close requests with this tuple return 204.
   */
  closedBy?: {
    producerId: string
    epoch: number
    seq: number
  }
}
```

#### 4.2. Handle Duplicate Close Requests

When an idempotent producer sends a close request to an already-closed stream:

```typescript
// In append method, when stream is closed:
if (stream.closed) {
  // Check if this is a duplicate of the closing request
  if (
    options.producerId &&
    stream.closedBy &&
    stream.closedBy.producerId === options.producerId &&
    stream.closedBy.epoch === options.producerEpoch &&
    stream.closedBy.seq === options.producerSeq
  ) {
    // Idempotent success - return 204 with Stream-Closed
    return {
      message: null,
      streamClosed: true,
      producerResult: { status: `duplicate`, lastSeq: options.producerSeq },
    }
  }

  // Different request - return 409 Conflict
  return {
    message: null,
    streamClosed: true,
  }
}

// When closing with producer headers, store the closing tuple:
if (options.close && options.producerId) {
  stream.closedBy = {
    producerId: options.producerId,
    epoch: options.producerEpoch!,
    seq: options.producerSeq!,
  }
}
```

---

### Phase 5: Server Conformance Tests

#### 5.1. Create Test File Structure

Add new test file: `packages/server-conformance-tests/src/stream-closure.test.ts`

Or extend `packages/server-conformance-tests/src/index.ts` with closure tests.

#### 5.2. Test Categories

**Create Tests:**

1. `create-closed-stream` - PUT with `Stream-Closed: true` creates closed stream
2. `create-closed-stream-with-body` - PUT with body + `Stream-Closed: true`
3. `create-closed-stream-empty` - PUT with empty body + `Stream-Closed: true`
4. `create-closed-returns-header` - Response includes `Stream-Closed: true`

**Append/Close Tests:** 5. `close-stream-empty-post` - POST with `Stream-Closed: true`, empty body 6. `close-with-final-append` - POST with body + `Stream-Closed: true` 7. `close-returns-offset` - Response includes `Stream-Next-Offset` 8. `close-returns-header` - Response includes `Stream-Closed: true` 9. `close-idempotent` - Closing already-closed stream (empty body) returns 204 10. `close-only-ignores-content-type` - Close-only with mismatched/missing Content-Type still returns 204 11. `append-to-closed-stream-409` - Append to closed stream (no Stream-Closed header) returns 409 12. `append-to-closed-stream-header` - 409 response includes `Stream-Closed: true` 13. `append-and-close-to-closed-stream-409` - POST with body + `Stream-Closed: true` to already-closed stream returns 409 (not idempotent without producer headers)

**HEAD Tests:** 14. `head-closed-stream` - HEAD returns `Stream-Closed: true`
14a. `head-open-stream` - HEAD does NOT return `Stream-Closed` header

**Read Tests (Catch-up):** 15. `read-closed-stream-at-tail` - Returns `Stream-Closed: true` at tail 16. `read-closed-stream-partial` - Partial read does NOT include `Stream-Closed` 17. `read-closed-stream-empty-body` - At tail: 200 OK, empty body, `Stream-Closed: true` 18. `read-closed-stream-final-chunk-with-data` - Final chunk with data includes `Stream-Closed: true` (stream already closed at response time)

**Long-Poll Tests:** 19. `longpoll-closed-stream-immediate` - No wait when closed stream at tail 20. `longpoll-closed-during-wait` - Stream closed during wait returns immediately 21. `longpoll-closed-returns-204` - Returns 204 with `Stream-Closed: true`

**SSE Tests:** 22. `sse-closed-stream-control-event` - Final control has `streamClosed: true` 23. `sse-closed-stream-no-cursor` - `streamCursor` omitted when `streamClosed` 24. `sse-closed-stream-connection-closes` - Connection closes after final event 25. `sse-already-closed-at-tail` - Immediate control + close on connection

**Idempotent Producer Tests:** 26. `idempotent-close-with-append` - Close with final append, producer headers 27. `idempotent-close-only-duplicate` - Duplicate close-only (no body) returns 204 28. `idempotent-close-with-append-duplicate` - Duplicate close-with-body returns 204 (critical: must not be 409) 29. `idempotent-close-different-producer` - Different producer gets 409 30. `idempotent-close-different-seq` - Same producer, different seq gets 409 31. `idempotent-close-after-restart` - Duplicate close works after server restart (file-backed store only) 32. `idempotent-close-only-with-producer-headers` - Close-only with producer headers updates state and returns producer headers

**State Matrix Tests:** 33. `state-catching-up` - `upToDate: false, streamClosed: false` 34. `state-caught-up-open` - `upToDate: true, streamClosed: false` 35. `state-complete` - `upToDate: true, streamClosed: true`

---

### Phase 6: Client Conformance Tests

#### 6.1. Create YAML Test File

Add: `packages/client-conformance-tests/test-cases/lifecycle/stream-closure.yaml`

```yaml
id: stream-closure
name: Stream Closure
description: Tests for stream closure (EOF) functionality
category: lifecycle
tags:
  - core
  - closure
  - eof

tests:
  # Writer tests
  - id: close-empty-stream
    name: Close stream with no content
    setup:
      - action: create
        as: streamPath
    operations:
      - action: close
        path: ${streamPath}
        expect:
          status: 204
          streamClosed: true
          hasOffset: true

  - id: close-with-content
    name: Append data then close
    setup:
      - action: create
        as: streamPath
    operations:
      - action: append
        path: ${streamPath}
        data: "message-1"
      - action: close
        path: ${streamPath}
        expect:
          status: 204
          streamClosed: true

  - id: close-with-final-message
    name: Atomic append and close
    setup:
      - action: create
        as: streamPath
    operations:
      - action: close
        path: ${streamPath}
        data: "final-message"
        expect:
          status: 204
          streamClosed: true

  - id: close-only-ignores-content-type
    name: Close-only ignores Content-Type mismatch
    description: Per protocol, empty-body close requests must not be rejected on Content-Type
    setup:
      - action: create
        as: streamPath
        contentType: application/json
    operations:
      - action: server-close
        path: ${streamPath}
        contentType: text/plain # Mismatched, should be ignored
        expect:
          status: 204
          streamClosed: true

  - id: append-and-close-to-closed-stream-409
    name: Append-and-close to already-closed stream returns 409
    description: Without producer headers, append-and-close is NOT idempotent
    setup:
      - action: create
        as: streamPath
      - action: close
        path: ${streamPath}
    operations:
      - action: server-append
        path: ${streamPath}
        data: "should-fail"
        streamClosed: true # Has body AND Stream-Closed header
        expect:
          status: 409
          streamClosed: true

  - id: read-closed-stream-final-chunk-with-data
    name: Final data chunk includes Stream-Closed when stream already closed
    description: Per protocol 5.6, responses returning final data include Stream-Closed
    setup:
      - action: create
        as: streamPath
      - action: append
        path: ${streamPath}
        data: "message-1"
      - action: append
        path: ${streamPath}
        data: "message-2"
      - action: close
        path: ${streamPath}
    operations:
      - action: read
        path: ${streamPath}
        offset: -1
        expect:
          dataContainsAll:
            - "message-1"
            - "message-2"
          upToDate: true
          streamClosed: true # Final chunk should have this


  # ... more tests per STREAM_CLOSURE_API.md conformance test section ...
```

---

## Implementation Order

### Recommended Sequence

1. **Types & Constants** (Phase 1)
   - Quick win, enables other work
   - No behavioral changes

2. **Store Layer** (Phase 2)
   - Core functionality
   - `StreamStore` first, then `FileBackedStreamStore`
   - Unit test with store directly

3. **HTTP Handlers - Basic** (Phase 3.1-3.4)
   - Create with closed
   - Close operation (POST with Stream-Closed)
   - HEAD with Stream-Closed
   - Basic read with Stream-Closed

4. **Server Conformance Tests - Basic** (Phase 5, subset)
   - Write tests as you implement each handler
   - Verify behavior is correct

5. **HTTP Handlers - Live Modes** (Phase 3.5-3.6)
   - Long-poll closure handling
   - SSE closure handling

6. **Server Conformance Tests - Live Modes** (Phase 5, remainder)
   - Long-poll tests
   - SSE tests

7. **Idempotent Producer Integration** (Phase 4)
   - Track closing producer
   - Duplicate close handling

8. **Client Conformance Tests** (Phase 6)
   - YAML test cases
   - Verify across all client implementations

---

## Testing Strategy

### Manual Testing Checklist

```bash
# Start server
cd packages/server && pnpm dev

# Create and close stream
curl -X PUT http://localhost:4437/test -H "Content-Type: text/plain"
curl -X POST http://localhost:4437/test -H "Stream-Closed: true" -v

# Verify HEAD shows closed
curl -I http://localhost:4437/test

# Verify append fails
curl -X POST http://localhost:4437/test -H "Content-Type: text/plain" -d "should fail" -v
# Should return 409 with Stream-Closed: true

# Create stream in closed state
curl -X PUT http://localhost:4437/closed -H "Content-Type: text/plain" -H "Stream-Closed: true"

# Test long-poll (should return immediately)
curl "http://localhost:4437/closed?offset=-1&live=long-poll" -v

# Test SSE (should close after control event)
curl "http://localhost:4437/closed?offset=-1&live=sse" -v
```

### Automated Testing

```bash
# Run server conformance tests
cd packages/server-conformance-tests
pnpm test

# Run client conformance tests
cd packages/client-conformance-tests
pnpm test:run
```

---

## Edge Cases to Consider

1. **Race condition: Close during long-poll wait**
   - Long-poll should wake up and return immediately with `Stream-Closed: true`

2. **Race condition: Close during SSE stream**
   - SSE should send final control event and close connection

3. **Idempotent close retry (same tuple)**
   - First close-with-body succeeds (200/204)
   - Retry with same `(producerId, epoch, seq)` must return 204 (not 409!)
   - This is the critical case the protocol mandates for retry safety

4. **Idempotent close with different tuple**
   - First close-with-body succeeds
   - Second close-with-body (different `producerId`, `epoch`, or `seq`) returns 409

5. **Close-only idempotency**
   - Multiple close-only requests (no producer headers) should all return 204

6. **Create closed stream idempotency**
   - PUT with same config + closed should return 200
   - PUT with different config (e.g., different closed state) should return 409

7. **Cached responses and closure**
   - Data chunks remain valid after closure
   - Closure signal is separate request at tail

8. **offset=now on closed stream**
   - Should return immediately with empty body and `Stream-Closed: true`

9. **File-backed store restart with closedBy**
   - After restart, `closedBy` must be restored from persistence
   - Duplicate close retry after restart must still return 204

---

## Files to Modify

| File                                                                         | Changes                              |
| ---------------------------------------------------------------------------- | ------------------------------------ |
| `packages/server/src/types.ts`                                               | Add `closed`, `closedBy` to Stream   |
| `packages/server/src/store.ts`                                               | Add close method, update append/wait |
| `packages/server/src/file-store.ts`                                          | Mirror store.ts changes              |
| `packages/server/src/server.ts`                                              | HTTP handlers for closure            |
| `packages/server-conformance-tests/src/index.ts`                             | Add closure tests                    |
| `packages/client-conformance-tests/test-cases/lifecycle/stream-closure.yaml` | New file                             |

---

## Success Criteria

- [ ] All server conformance tests pass
- [ ] All client conformance tests pass for TypeScript client
- [ ] Manual testing checklist completed
- [ ] No regressions in existing tests
- [ ] Protocol compliance verified against PROTOCOL.md Section 4.1, 5.2, 5.3, 5.5-5.8
