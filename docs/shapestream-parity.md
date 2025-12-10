# ShapeStream Feature Parity Analysis

This document tracks missing features in `@durable-streams/client` that are needed for `@electric-sql/client` to be built on top of it.

## Background

`@durable-streams/client` was extracted from the Electric SQL protocol. The goal is to have `@electric-sql/client`'s `ShapeStream` class built on top of `DurableStream`. This analysis identifies transport-layer features in `ShapeStream` that `DurableStream` currently lacks.

## Feature Comparison

### Currently Implemented in DurableStream ✅

- SSE support (`@microsoft/fetch-event-source`)
- Long-poll support
- Exponential backoff with jitter (`createFetchWithBackoff`)
- Body consumption (`createFetchWithConsumedBody`)
- Dynamic headers/params (function values)
- Auth patterns (token, headers, getHeaders)
- onError handler with retry options
- AbortSignal support
- Cursor tracking for CDN collapsing
- Content-type detection

---

## Missing Features

### High Priority

These are core infrastructure features that ShapeStream relies on.

#### 1. Subscribe/Callback Pattern

**ShapeStream has:**
```typescript
#subscribers: Map<number, [callback, errorHandler]>

subscribe(callback, onError?): () => void
unsubscribeAll(): void

// Internal
#publish(messages): Promise<void[]>
#sendErrorToSubscribers(error): void
```

**DurableStream has:** AsyncIterator only (`read()` returns `AsyncIterable<StreamChunk>`)

**Why needed:** ShapeStream's primary consumption model is pub/sub with multiple subscribers.

---

#### 2. Status Query Methods

**ShapeStream has:**
```typescript
// Fields
#lastSyncedAt?: number
#connected: boolean
#started: boolean
#isUpToDate: boolean

// Methods
lastSyncedAt(): number | undefined
lastSynced(): number           // ms since last sync
isConnected(): boolean
isLoading(): boolean
hasStarted(): boolean
```

**DurableStream has:** Only `contentType` property

**Why needed:** Shape class and consumers need to query stream state.

---

#### 3. Public Getters for Stream State

**ShapeStream has:**
```typescript
get isUpToDate(): boolean
get lastOffset(): Offset
get error(): unknown
get shapeHandle(): string | undefined
```

**DurableStream has:** None of these as public properties

**Why needed:** Required for Shape state management and external monitoring.

---

### Medium Priority

These improve robustness and browser compatibility.

#### 4. Pause/Resume with Visibility Handling

**ShapeStream has:**
```typescript
#state: 'active' | 'pause-requested' | 'paused'
#unsubscribeFromVisibilityChanges?: () => void

#pause(): void
#resume(): void
#subscribeToVisibilityChanges(): void
```

**Why needed:** Auto-pauses when browser tab is hidden, resumes on visibility. Important for mobile and battery life.

---

#### 5. Force Disconnect & Refresh

**ShapeStream has:**
```typescript
#requestAbortController?: AbortController
#isRefreshing: boolean

forceDisconnectAndRefresh(): Promise<void>
```

**DurableStream has:** Only AbortSignal support, no explicit reconnect

**Why needed:** Manual reconnection for recovery scenarios.

---

#### 6. SSE Automatic Fallback to Long-Poll

**ShapeStream has:**
```typescript
#lastSseConnectionStartTime?: number
#minSseConnectionDuration: number
#consecutiveShortSseConnections: number
#maxShortSseConnections: number
#sseFallbackToLongPolling: boolean
#sseBackoffBaseDelay: number
#sseBackoffMaxDelay: number
```

**Logic:** If SSE connection dies < 1 second, 3 times in a row → fallback to long-poll.

**DurableStream has:** SSE implemented but no automatic fallback detection

**Why needed:** Connection resilience in flaky network conditions.

---

#### 7. Mid-Stream Transaction Tracking

**ShapeStream has:**
```typescript
#isMidStream: boolean
#midStreamPromise?: Promise<void>
#midStreamPromiseResolver?: () => void

#waitForStreamEnd(): Promise<void>
```

**Why needed:** Prevents operations (like snapshots) during active data streaming.

---

#### 8. Replay Mode Detection

**ShapeStream has:**
```typescript
get #replayMode(): boolean  // Detects if response is from cache
```

**Why needed:** Cache-aware behavior for proper state management.

---

### Lower Priority

Nice-to-have features for performance and DX.

#### 9. Snapshot/Subset Fetching

**ShapeStream has:**
```typescript
#snapshotTracker: SnapshotTracker
#activeSnapshotRequests: number

requestSnapshot(params): Promise<{ metadata, data }>
fetchSnapshot(opts): Promise<{ metadata, data }>
```

**Why needed:** Partial data queries for specific subsets.

---

#### 10. Chunk Prefetch Buffer

**Electric has in fetch.ts:**
```typescript
createFetchWithChunkBuffer(
  fetchClient,
  { maxChunks?: number }
): typeof fetch
```

**Why needed:** Performance optimization for sequential chunk loading.

---

#### 11. Response Headers Validation

**Electric has:**
```typescript
createFetchWithResponseHeadersCheck(fetchClient): typeof fetch
```

**Why needed:** Validates required protocol headers with helpful CORS error messages.

---

#### 12. Reserved Parameter Validation

**Electric has:**
```typescript
ELECTRIC_PROTOCOL_QUERY_PARAMS = [...] // 12 reserved params
validateParams(params): void  // Throws ReservedParamError
```

**DurableStream has:** `DURABLE_STREAM_PROTOCOL_QUERY_PARAMS` constant but no validation function

**Why needed:** Developer experience - prevent accidental param conflicts.

---

## Implementation Notes

### Subscription Pattern Approach

Two options for implementing subscribe pattern:

1. **Wrap AsyncIterator internally** - DurableStream manages single read() internally, publishes to subscribers
2. **Add separate subscribable stream class** - New class that wraps DurableStream

Option 1 is closer to how ShapeStream works.

### State Management

DurableStream is currently stateless (cold handle pattern). Adding status methods requires tracking:
- Connection state per read session
- Last sync timestamps
- Up-to-date status

This may require a mode where DurableStream maintains an active connection rather than just being a handle.

---

## References

- Electric SQL TypeScript Client: https://github.com/electric-sql/electric/tree/main/packages/typescript-client
- ShapeStream source: `packages/typescript-client/src/client.ts`
- Shape source: `packages/typescript-client/src/shape.ts`
