# Production hardening: port Electric's resilience features

Design spec for [issue #265](https://github.com/durable-streams/durable-streams/issues/265) — porting production hardening features from Electric's TypeScript client to the durable-streams TypeScript client.

## Context

The durable-streams TypeScript client's state machine was modeled after Electric's `ShapeStream` state machine. Both use immutable class hierarchies and SSE-to-long-poll fallback. But Electric has accumulated significant production hardening from real-world deployments that durable-streams currently lacks.

This design covers all 8 features from the issue plus backoff defaults update, SPEC.md with truth table, and test infrastructure.

### Learnings from recent Electric PRs

Four post-issue Electric fixes inform the design:

1. **Backoff defaults** (PR #3896): Changed from `100ms/1.3x/60s` to `1s/2x/32s` to prevent thundering herd.
2. **Wake detection re-arming** (PR #3918): Timer must be set up in `#start()` not constructor, otherwise lost after pause/resume.
3. **Handle suffix accumulation** (PR #3961): Never fabricate protocol values for cache busting — use dedicated `cache_buster` query param.
4. **Stale CDN infinite loop** (PR #4015): Stale responses must always enter stale-retry. Added duplicate-URL guard as safety net.

## State machine restructure

### New hierarchy

```
StreamState (abstract base)
├── ActiveState (abstract)
│   │  Shared fields: offset, cursor, upToDate, streamClosed
│   │  Methods: pause(), toErrorState(), applyUrlParams(), shouldContinueLive()
│   │
│   ├── FetchingState (abstract)
│   │   │  Template method: handleResponseMetadata() with stale-check hook
│   │   │  Always uses long-poll (non-live fetching)
│   │   │
│   │   ├── InitialState       (kind: "initial")  — first request, offset from options
│   │   ├── SyncingState       (kind: "syncing")   — catching up to live
│   │   └── StaleRetryState    (kind: "stale-retry") — carries cacheBuster + retryCount
│   │
│   ├── LiveState              (kind: "live")
│   │      SSE resilience: consecutiveShortConnections, sseFallbackToLongPolling
│   │      Methods: shouldUseSse(), handleSseConnectionClosed()
│   │
│   └── ReplayingState         (kind: "replaying")
│          Carries replayCursor, suppresses duplicate batches.
│          Extends ActiveState directly (not FetchingState). Implements its own
│          handleResponseMetadata() (delegates to base shared-field parsing) and
│          overrides handleMessageBatch() for cursor-based suppression.
│
├── PausedState                (kind: "paused")  — wraps ActiveState | ErrorState
└── ErrorState                 (kind: "error")   — wraps ActiveState | PausedState, carries error
```

### Adaptation from Electric

Durable-streams doesn't have "shape handles" that expire via 409. Key differences:

- **StaleRetryState** triggered by fast-loop detection (same offset repeated in time window) rather than expired-handle matching.
- **No `expiredShapesCache`** — streams have fixed URLs, not transient handles.
- **CDN cache busting** uses the same `cache_buster` query param mechanism.
- Events `markMustRefetch` and `withHandle` are dropped (no shape handles).

### What moves where

| Current                        | New location                                    |
| ------------------------------ | ----------------------------------------------- |
| `LongPollState` sync fields    | `ActiveState` (shared by all)                   |
| `SSEState` resilience tracking | `LiveState` (SSE only matters when live)        |
| `PausedState` wrapping         | Same concept, wraps `ActiveState \| ErrorState` |

### State-driven URL construction

Each state adds its own params via `applyUrlParams(url)`:

- **ActiveState**: adds `offset`, `cursor`
- **StaleRetryState**: adds `cache_buster`
- **LiveState**: adds `live=long-poll` or `live=sse`, plus cursor
- **ReplayingState**: same as FetchingState (syncing phase)

### handleResponseMetadata() template method

`FetchingState` defines the response-handling template:

```typescript
abstract class FetchingState extends ActiveState {
  handleResponseMetadata(input: ResponseMetadataInput): ResponseTransition {
    // 1. Check for stale response (offset didn't advance)
    const staleResult = this.checkStaleResponse(input)
    if (staleResult) return staleResult

    // 2. Parse response headers into shared fields
    const shared = {
      offset: input.offset ?? this.offset,
      cursor: input.cursor ?? this.cursor,
      upToDate: input.upToDate,
      streamClosed: this.streamClosed || input.streamClosed,
    }

    // 3. Transition to SyncingState
    return { action: "accepted", state: new SyncingState(shared) }
  }

  protected checkStaleResponse(
    input: ResponseMetadataInput
  ): ResponseTransition | null {
    // Base: detect offset stall (response offset === request offset)
    if (input.offset === input.requestOffset) {
      // Offset didn't advance — response is stale (likely CDN-cached)
      return {
        action: "stale-retry",
        state: new StaleRetryState({
          ...this.currentFields,
          cacheBuster: input.createCacheBuster(),
          retryCount: 1,
        }),
      }
    }
    return null
  }
}

// StaleRetryState overrides to increment its own counter:
class StaleRetryState extends FetchingState {
  protected checkStaleResponse(
    input: ResponseMetadataInput
  ): ResponseTransition | null {
    if (input.offset === input.requestOffset) {
      const nextCount = this.#retryCount + 1
      if (nextCount > MAX_STALE_CACHE_RETRIES) {
        return { action: "fatal", message: "..." }
      }
      return {
        action: "stale-retry",
        state: new StaleRetryState({
          ...this.currentFields,
          cacheBuster: input.createCacheBuster(),
          retryCount: nextCount,
        }),
      }
    }
    return null // offset advanced — stale retry succeeded
  }
}
```

`ResponseMetadataInput` contains: `offset`, `cursor`, `upToDate`, `streamClosed` (from response headers), plus `requestOffset` (the offset the request was made with, for stale detection).

`handleMessageBatch()` is defined on `ActiveState`. States that implement it: `SyncingState` (transitions to `LiveState` on up-to-date), `LiveState` (stays live), `ReplayingState` (suppresses duplicates, transitions to `LiveState`). `InitialState` and `StaleRetryState` inherit base behavior from `FetchingState`.

### Typed transition objects

State methods return typed results:

```typescript
type ResponseTransition =
  | { action: "accepted"; state: ActiveState }
  | { action: "stale-retry"; state: StaleRetryState }
  | { action: "fatal"; message: string }

type MessageBatchTransition = {
  state: ActiveState
  suppressBatch: boolean
  becameUpToDate: boolean
}
```

### State transitions

Summary of all valid transitions:

| From            | Event                                  | To                      | Condition                                                                 |
| --------------- | -------------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| InitialState    | response (accepted)                    | SyncingState            | First successful response                                                 |
| InitialState    | response (stale)                       | StaleRetryState         | Response offset == request offset (didn't advance)                        |
| SyncingState    | messages (up-to-date)                  | LiveState               | `upToDate` message received                                               |
| SyncingState    | messages (up-to-date)                  | ReplayingState          | If replay mode entry conditions met (checked before LiveState transition) |
| SyncingState    | response (stale)                       | StaleRetryState         | Response offset == request offset (didn't advance)                        |
| StaleRetryState | response (accepted)                    | SyncingState            | Cache-busted request advances offset                                      |
| StaleRetryState | response (fatal)                       | throws                  | 3 consecutive stale retries                                               |
| LiveState       | sseClose (short)                       | LiveState               | Bump short connection counter                                             |
| LiveState       | sseClose (threshold)                   | LiveState               | Set `sseFallbackToLongPolling = true`                                     |
| ReplayingState  | messages (up-to-date, cursor match)    | LiveState               | Suppress batch (CDN cached response)                                      |
| ReplayingState  | messages (up-to-date, cursor mismatch) | LiveState               | Pass batch through (fresh data)                                           |
| Any ActiveState | pause                                  | PausedState             | PauseLock acquired                                                        |
| Any ActiveState | error                                  | ErrorState              | Exception during request/processing                                       |
| PausedState     | resume                                 | (previous ActiveState)  | PauseLock released                                                        |
| PausedState     | pause                                  | PausedState             | Idempotent (returns `this`)                                               |
| ErrorState      | retry                                  | (previous ActiveState)  | `onError` returns retry opts                                              |
| ErrorState      | pause                                  | PausedState(ErrorState) | PauseLock acquired while in error                                         |

No-op rules:

- `resume` on non-PausedState returns `this`
- `retry` on non-ErrorState returns `this`
- `response`/`messages`/`sseClose` on ErrorState return `this` (ignored)
- `messages`/`sseClose` on PausedState return `this` (ignored)
- `response` on PausedState delegates to `previousState`, preserving PausedState wrapper

## Feature 1: PauseLock

**File**: `src/pause-lock.ts` (~80 lines)

A `Set<string>`-based counting lock coordinating multiple independent pause reasons.

```typescript
interface PauseLockOptions {
  onAcquired: () => void // fires on 0 → 1 transition
  onReleased: () => void // fires on 1 → 0 transition
}

class PauseLock {
  #holders = new Set<string>()

  acquire(reason: string): void // add holder, warn on duplicate
  release(reason: string): void // remove holder, warn on orphan
  releaseAllMatching(prefix: string): void // batch cleanup
  get isPaused(): boolean
  isHeldBy(reason: string): boolean
}
```

### Integration

- Constructor creates PauseLock with `onAcquired` → `state.pause()` + abort in-flight request, `onReleased` → restart request loop.
- Replaces the manual `#state` string enum (`active` / `pause-requested` / `paused`) and `#pausePromise` plumbing.
- Visibility changes call `pauseLock.acquire('visibility')` / `pauseLock.release('visibility')`.

### Pause reasons

- `'visibility'` — document hidden/visible

## Feature 2: System wake detection

**File**: `src/wake-detection.ts` (~40 lines)

```typescript
interface WakeDetectionOptions {
  onWake: () => void
  intervalMs?: number // default: 2000
  thresholdMs?: number // default: 4000
}

function subscribeToWakeDetection(options: WakeDetectionOptions): () => void
```

### Algorithm

`setInterval` at 2s. If wall-clock delta between ticks exceeds 6s (2s interval + 4s threshold), system was sleeping.

### Integration

- Skip in browsers (visibility API handles it via PauseLock).
- `timer.unref()` so it doesn't keep Node/Bun alive.
- On wake: abort current in-flight request with `SYSTEM_WAKE` reason. The request loop's existing catch logic detects the abort and immediately re-fetches from the current offset. Wake detection does NOT use PauseLock — it's a one-shot abort, not a pause/resume cycle.
- Subscribe in `#start()`, not the constructor (lesson from Electric PR #3918).
- Idempotency guard to prevent duplicate timers.
- Reset cleanup reference on teardown.

## Feature 3: Fast-loop detection

**File**: `src/fast-loop-detection.ts` (~60 lines)

```typescript
interface FastLoopDetectorOptions {
  windowMs?: number // default: 500
  threshold?: number // default: 5 requests at same offset in window
  maxCount?: number // default: 5 consecutive detections before fatal
  backoffBaseMs?: number // default: 100
  backoffMaxMs?: number // default: 5000
}

class FastLoopDetector {
  check(offset: Offset): FastLoopResult
  reset(): void
}

type FastLoopResult =
  | { action: "ok" }
  | { action: "clear-and-reset" } // first detection → StaleRetryState
  | { action: "backoff"; delayMs: number } // detections 2-4
  | { action: "fatal"; message: string } // detection 5
```

### Algorithm

Sliding time window of `{ timestamp, offset }` entries. Before each non-live request, prune entries older than `windowMs`. If >= `threshold` entries share the same offset, trigger detection.

### Escalation ladder

1. **Detection 1** (`clear-and-reset`): Log warning, transition to StaleRetryState with cache buster, clear detector state.
2. **Detections 2-4** (`backoff`): Exponential backoff with full jitter.
3. **Detection 5** (`fatal`): Throw `FetchError(502)` with descriptive proxy misconfiguration message.

### Integration

Called in the request loop before each non-live fetch. Live requests clear the detector.

The fast-loop detector catches _successful_ responses (HTTP 200) that don't advance the offset — e.g., a CDN serving stale cached data. These bypass the backoff middleware entirely since they return 200 OK. That's why the 500ms/5-request threshold works despite the 1s initial backoff: errors hit backoff, but stale 200s don't.

## Feature 4: ErrorState + resumable onError

### ErrorState (in `stream-response-state.ts`)

```typescript
class ErrorState extends StreamState {
  readonly kind = "error"
  readonly #previousState: ActiveState | PausedState
  readonly error: Error

  constructor(
    previousState: ActiveState | PausedState | ErrorState,
    error: Error
  ) {
    // Flatten same-type nesting: ErrorState(ErrorState(X)) → ErrorState(X)
    // Cross-type nesting preserved: ErrorState(PausedState(X)) is valid
    this.#previousState =
      previousState instanceof ErrorState
        ? previousState.#previousState
        : previousState
  }

  retry(): ActiveState | PausedState {
    return this.#previousState
  }
  pause(): PausedState {
    return new PausedState(this)
  }

  // Delegate all field access to previousState
}
```

### Behavior change

Currently, errors during active long-poll/SSE loop call `#markError()` and permanently close the stream. With ErrorState:

1. Error occurs mid-stream → `state = state.toErrorState(error)`
2. Call user's `onError` handler
3. If `onError` returns an object (even `{}`) → `state = errorState.retry()`, resume from same position
4. If `onError` returns `void` → propagate error, stream closes (current behavior preserved)

The same `onError` handler signature works for both initial errors and mid-stream errors.

`retry()` returns the exact `previousState` instance, preserving all fields (offset, cursor, cache buster, replay cursor, SSE resilience counters, etc.). The request loop resumes exactly where it left off. If `PausedState` wraps an `ErrorState` and is resumed, the request loop checks the unwrapped state's kind and re-enters error handling if `kind === 'error'`.

## Feature 5: Fetch middleware enhancements

### 5a: Backoff defaults update

Three-line change in `fetch.ts`:

```typescript
export const BackoffDefaults: BackoffOptions = {
  initialDelay: 1_000, // was 100
  maxDelay: 32_000, // was 60_000
  multiplier: 2, // was 1.3
  maxRetries: Infinity,
}
```

Delay sequence: `1s → 2s → 4s → 8s → 16s → 32s`.

`Retry-After` header support already exists — no change needed.

### 5b: Response header validation

New middleware in `fetch.ts`:

```typescript
function createFetchWithResponseHeadersCheck(
  fetchClient: typeof fetch
): typeof fetch
```

On 2xx responses, validates required protocol headers:

- Always required: `Stream-Next-Offset`
- When request has `live=long-poll` or `live=sse` AND response does NOT have `Stream-Closed: true`: also `Stream-Cursor` (servers may omit cursor on closed streams per protocol)

Throws `MissingHeadersError` (new error class) listing absent headers.

**`MissingHeadersError` is non-retryable.** Stripped/CORS-hidden protocol headers are not recoverable — retrying would spin forever on a broken proxy. The request loop must propagate this error immediately, bypassing ErrorState and `onError`. This matches Electric's behavior where `MissingHeadersError` is explicitly excluded from retry logic.

### Middleware chain

Composition order (outermost wraps innermost). When `fetch(url)` is called, the outermost middleware runs first and delegates inward:

```typescript
fetchClient = createFetchWithConsumedBody(
  // 1. outermost: eagerly read body
  createFetchWithResponseHeadersCheck(
    // 2. validate protocol headers
    createFetchWithChunkBuffer(
      // 3. speculative prefetch (feature 8)
      createFetchWithBackoff(baseFetch, backoff) // 4. retry with exponential backoff
    )
  )
)
```

This matches Electric's order. Key consequences:

- **Backoff is innermost** — prefetched requests go through backoff (get retried on network errors)
- **Header validation is outside backoff** — `MissingHeadersError` surfaces immediately without retries
- **Chunk buffer is outside backoff** — prefetched requests get the full retry stack
- **Consumed body is outermost** — ensures body is always read regardless of what inner layers do

## Feature 6: CDN cache busting (StaleRetryState)

### Adaptation for durable-streams

No shape handles that expire via 409. Two layers of stale detection:

**Layer 1 — State machine (`handleResponseMetadata`)**: When a response's offset matches the request offset (didn't advance), `checkStaleResponse()` transitions to `StaleRetryState`. The state carries a `retryCount` that increments on each consecutive stale response. After `MAX_STALE_CACHE_RETRIES` (3), returns `{ action: "fatal" }`. This is the primary detection mechanism.

**Layer 2 — Fast-loop detector (request loop)**: Catches rapid request patterns (5+ requests at same offset in 500ms) that the state machine might miss — e.g., if the response technically has a different offset but the stream isn't making progress. This is a secondary safety net, not the primary entry point.

### StaleRetryState (in `stream-response-state.ts`)

```typescript
class StaleRetryState extends FetchingState {
  readonly kind = "stale-retry"
  readonly #cacheBuster: string // random: `${Date.now()}-${random}`
  readonly #retryCount: number // max 3 before fatal

  applyUrlParams(url: URL): void {
    super.applyUrlParams(url)
    url.searchParams.set("cache_buster", this.#cacheBuster)
  }
}
```

### Entry and exit

- **Entry (primary)**: `handleResponseMetadata()` detects offset stall → `checkStaleResponse()` returns `{ action: "stale-retry" }` with cache buster and `retryCount: 1`.
- **Entry (secondary)**: Fast-loop detector catches rapid same-offset patterns as a safety net.
- **Retry escalation**: `StaleRetryState.checkStaleResponse()` increments `retryCount` on each stale response. Counter lives in the state, not the detector.
- **Exit (success)**: Cache-busted request advances offset → `checkStaleResponse()` returns null → transitions to SyncingState.
- **Exit (fatal)**: `retryCount` exceeds `MAX_STALE_CACHE_RETRIES` (3) → returns `{ action: "fatal" }`.

### Duplicate-URL guard

Safety net in request loop: detects when same URL would be sent twice for non-live GET requests. Adds cache buster on detection, throws after 5 consecutive duplicates. Skipped for live requests (same URL is normal).

### `cache_buster` is a client-only concern

The `cache_buster` query parameter is for CDN cache invalidation only. Servers MUST ignore unknown query parameters per protocol (verify Caddy plugin passes unknown params through). No change to PROTOCOL.md needed.

### No `expiredShapesCache`

Durable-streams URLs are stable — no need for expired-handle tracking.

## Feature 7: Replay mode

### UpToDateTracker (`src/up-to-date-tracker.ts`, ~100 lines)

Pluggable storage for tracking cursor at each up-to-date transition:

```typescript
interface UpToDateStorage {
  get(key: string): { cursor: string; timestamp: number } | null
  set(key: string, value: { cursor: string; timestamp: number }): void
  delete(key: string): void
}

class InMemoryUpToDateStorage implements UpToDateStorage { ... }
class LocalStorageUpToDateStorage implements UpToDateStorage { ... }

class UpToDateTracker {
  constructor(storage?: UpToDateStorage)
  recordUpToDate(streamKey: string, cursor: string): void
  shouldEnterReplayMode(streamKey: string): string | null
  delete(streamKey: string): void
}
```

Key behaviors:

- **TTL**: 60s (CDN cache expiry)
- **Write throttle**: 60s
- **LRU eviction**: 250 entries
- **Canonical stream key**: URL stripped of all protocol-varying params (`offset`, `cursor`, `live`, `cache_buster`). Must include `cache_buster` — otherwise stale-retry URLs and normal URLs land in different replay buckets, breaking suppression after the stale-cache path fires.
- `localStorage` I/O wrapped in try/catch

### ReplayingState (in `stream-response-state.ts`)

```typescript
class ReplayingState extends ActiveState {
  readonly kind = "replaying"
  readonly #replayCursor: string

  handleMessageBatch(input: MessageBatchInput): MessageBatchTransition {
    if (input.hasUpToDateMessage) {
      const suppressBatch =
        !input.isSse && this.#replayCursor === input.currentCursor
      return {
        state: new LiveState(shared),
        suppressBatch,
        becameUpToDate: true,
      }
    }
    return { state: this, suppressBatch: false, becameUpToDate: false }
  }
}
```

### Entry conditions

Checked once in the request loop after the first response transitions from InitialState to SyncingState:

1. Stream not yet up-to-date
2. Current state is InitialState or SyncingState (NOT StaleRetryState)
3. `upToDateTracker.shouldEnterReplayMode(streamKey)` returns non-null cursor

If all conditions met, transition to `ReplayingState` with the returned cursor.

One-shot gate: always transitions to LiveState on up-to-date. Only long-poll (SSE not served from CDN cache).

## Feature 8: Chunk prefetching

### PrefetchQueue (added to `fetch.ts`, ~120 lines)

```typescript
interface PrefetchQueueOptions {
  maxChunksToPrefetch?: number // default: 2
  fetchClient: typeof fetch
}

class PrefetchQueue {
  #queue: Map<string, { promise: Promise<Response>; abort: AbortController }>
  consume(url: string): Promise<Response> | undefined
  prefetch(url: string, signal?: AbortSignal): void
  clear(): void
}
```

### getNextChunkUrl helper

Infers next chunk URL from response headers:

- Read `Stream-Next-Offset` and `Stream-Cursor`
- Return `null` when: `Stream-Closed: true`, `live=*` request, or required headers missing

### createFetchWithChunkBuffer middleware

```typescript
function createFetchWithChunkBuffer(
  fetchClient: typeof fetch,
  options?: { maxChunksToPrefetch?: number }
): typeof fetch
```

Guard rails:

- Only prefetches GET requests
- Never prefetches live requests
- Prefetch errors silently swallowed — real retry on consumer demand
- In-order consumption only (head-of-queue)
- Per-entry AbortController chained to user's signal

## SPEC.md and test infrastructure

### `packages/client/SPEC.md`

Adapted from Electric's 373-line spec:

- **States**: 7 states (same hierarchy, adapted for durable-streams protocol)
- **Events**: Adapted set — dropping `markMustRefetch`, `withHandle` (no shape handles)
- **Transition table**: All state x event combinations specified. TypeScript `Record` with no `Partial` — compiler enforces completeness.
- **Invariants**: Ported from Electric (I0-I12, adapted to drop handle-specific ones)
- **Constraints**: Ported (C1-C8, adapted for durable-streams headers)
- **Loop-back path analysis**: Adapted for our request loop
- **Bidirectional enforcement checklist**: Every invariant maps to tests, every test maps to spec

### Test files

| File                                     | Content                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| `test/support/state-machine-dsl.ts`      | Scenario builder with auto-invariant checking              |
| `test/support/state-transition-table.ts` | Exhaustive truth table (compiler-enforced completeness)    |
| `test/stream-response-state.test.ts`     | Tiered: scenarios, truth table, algebraic properties, fuzz |
| `test/pause-lock.test.ts`                | PauseLock unit tests                                       |
| `test/wake-detection.test.ts`            | Wake detection unit tests                                  |
| `test/fast-loop-detection.test.ts`       | Fast-loop detector unit tests                              |
| `test/up-to-date-tracker.test.ts`        | UpToDateTracker unit tests                                 |

## File map

### New files

| File                                     | Size estimate | Content                            |
| ---------------------------------------- | ------------- | ---------------------------------- |
| `src/pause-lock.ts`                      | ~80 lines     | PauseLock class                    |
| `src/wake-detection.ts`                  | ~40 lines     | System wake detector               |
| `src/fast-loop-detection.ts`             | ~60 lines     | Sliding-window loop detector       |
| `src/up-to-date-tracker.ts`              | ~100 lines    | Pluggable storage for replay mode  |
| `SPEC.md`                                | ~350 lines    | Formal state machine specification |
| `test/support/state-machine-dsl.ts`      | ~400 lines    | Scenario builder DSL               |
| `test/support/state-transition-table.ts` | ~200 lines    | Exhaustive truth table             |
| `test/pause-lock.test.ts`                | ~80 lines     | PauseLock tests                    |
| `test/wake-detection.test.ts`            | ~80 lines     | Wake detection tests               |
| `test/fast-loop-detection.test.ts`       | ~100 lines    | Fast-loop tests                    |
| `test/up-to-date-tracker.test.ts`        | ~100 lines    | Tracker tests                      |

### Modified files

| File                                 | Changes                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `src/stream-response-state.ts`       | Full rewrite — new hierarchy with 7 states                                                                                  |
| `src/response.ts`                    | Replace pause mechanism with PauseLock, wire in wake detection, fast-loop, ErrorState recovery, replay mode, chunk prefetch |
| `src/stream-api.ts`                  | Wire mid-stream ErrorState/onError into the outer retry loop for unified error contract                                     |
| `src/fetch.ts`                       | Update backoff defaults, add header validation middleware, add chunk prefetch middleware                                    |
| `src/error.ts`                       | Add `MissingHeadersError` class                                                                                             |
| `src/types.ts`                       | Add new option types (FastLoopOptions, PrefetchOptions, UpToDateStorageOption)                                              |
| `src/constants.ts`                   | Add `CACHE_BUSTER_QUERY_PARAM`                                                                                              |
| `src/index.ts`                       | Export new public types and classes                                                                                         |
| `test/stream-response-state.test.ts` | Full rewrite — tiered tests matching new state machine                                                                      |

## Implementation phases

| Phase | Features                                                                                  | Dependencies                                                                                |
| ----- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1     | State machine restructure + SPEC.md + truth table tests, PauseLock, System Wake Detection | Foundation — everything else builds on this                                                 |
| 2     | Fast-Loop Detection, ErrorState + Resumable onError                                       | Requires Phase 1 state machine                                                              |
| 3     | Backoff defaults, Header validation middleware, CDN Cache Busting (StaleRetryState)       | Requires Phase 1 state machine. ErrorState (Phase 2) improves recovery but is not blocking  |
| 4     | Replay Mode (UpToDateTracker + ReplayingState), Chunk Prefetching                         | Requires Phase 1 state machine. StaleRetryState constraint C1 needed for replay entry guard |

Each phase can be a separate PR.
