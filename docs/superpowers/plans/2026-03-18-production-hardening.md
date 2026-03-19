# Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Electric's production hardening features to the durable-streams TypeScript client — state machine restructure, PauseLock, wake detection, fast-loop detection, ErrorState, CDN cache busting, replay mode, and chunk prefetching.

**Architecture:** Restructure the 3-state machine (LongPollState/SSEState/PausedState) into a 7-state Electric-style hierarchy (InitialState/SyncingState/StaleRetryState/LiveState/ReplayingState/PausedState/ErrorState). Add PauseLock for multi-reason pause coordination, fast-loop detection for CDN stale response recovery, and chunk prefetching for faster initial sync. Split fetch clients for SSE vs chunk paths.

**Tech Stack:** TypeScript, Vitest, pnpm

**Spec:** `docs/superpowers/specs/2026-03-18-production-hardening-design.md`

**Test command:** `pnpm vitest run --project client`

**Note:** This plan creates new test files (pause-lock, wake-detection, fast-loop-detection, up-to-date-tracker, state-machine DSL/truth-table). The user has explicitly approved these as part of the design spec review (issue #265 spec includes test file map).

**Electric reference:** `https://github.com/electric-sql/electric/tree/main/packages/typescript-client/src`

---

## Phase 1: State Machine + PauseLock + Wake Detection

### Task 1.1: PauseLock

**Files:**

- Create: `packages/client/src/pause-lock.ts`
- Create: `packages/client/test/pause-lock.test.ts`

- [ ] **Step 1: Write PauseLock tests**

```typescript
// packages/client/test/pause-lock.test.ts
import { describe, expect, it, vi } from "vitest"
import { PauseLock } from "../src/pause-lock"

describe(`PauseLock`, () => {
  it(`starts unpaused`, () => {
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased: vi.fn() })
    expect(lock.isPaused).toBe(false)
  })

  it(`fires onAcquired on 0→1 transition`, () => {
    const onAcquired = vi.fn()
    const lock = new PauseLock({ onAcquired, onReleased: vi.fn() })
    lock.acquire(`visibility`)
    expect(lock.isPaused).toBe(true)
    expect(onAcquired).toHaveBeenCalledTimes(1)
  })

  it(`does not fire onAcquired on 1→2 transition`, () => {
    const onAcquired = vi.fn()
    const lock = new PauseLock({ onAcquired, onReleased: vi.fn() })
    lock.acquire(`visibility`)
    lock.acquire(`snapshot-1`)
    expect(onAcquired).toHaveBeenCalledTimes(1)
  })

  it(`fires onReleased on 1→0 transition`, () => {
    const onReleased = vi.fn()
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased })
    lock.acquire(`visibility`)
    lock.release(`visibility`)
    expect(lock.isPaused).toBe(false)
    expect(onReleased).toHaveBeenCalledTimes(1)
  })

  it(`does not fire onReleased on 2→1 transition`, () => {
    const onReleased = vi.fn()
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased })
    lock.acquire(`visibility`)
    lock.acquire(`snapshot-1`)
    lock.release(`visibility`)
    expect(lock.isPaused).toBe(true)
    expect(onReleased).not.toHaveBeenCalled()
  })

  it(`warns on duplicate acquire`, () => {
    const warn = vi.spyOn(console, `warn`).mockImplementation(() => {})
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased: vi.fn() })
    lock.acquire(`visibility`)
    lock.acquire(`visibility`)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it(`warns on orphan release`, () => {
    const warn = vi.spyOn(console, `warn`).mockImplementation(() => {})
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased: vi.fn() })
    lock.release(`never-acquired`)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it(`isHeldBy returns correct state`, () => {
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased: vi.fn() })
    lock.acquire(`visibility`)
    expect(lock.isHeldBy(`visibility`)).toBe(true)
    expect(lock.isHeldBy(`other`)).toBe(false)
  })

  it(`releaseAllMatching removes matching holders`, () => {
    const onReleased = vi.fn()
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased })
    lock.acquire(`snapshot-1`)
    lock.acquire(`snapshot-2`)
    lock.acquire(`visibility`)
    lock.releaseAllMatching(`snapshot-`)
    expect(lock.isPaused).toBe(true) // visibility still held
    expect(lock.isHeldBy(`snapshot-1`)).toBe(false)
    expect(lock.isHeldBy(`snapshot-2`)).toBe(false)
  })

  it(`releaseAllMatching fires onReleased when last holder removed`, () => {
    const onReleased = vi.fn()
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased })
    lock.acquire(`snapshot-1`)
    lock.releaseAllMatching(`snapshot-`)
    expect(onReleased).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project client test/pause-lock.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement PauseLock**

```typescript
// packages/client/src/pause-lock.ts
export interface PauseLockOptions {
  onAcquired: () => void
  onReleased: () => void
}

export class PauseLock {
  readonly #holders = new Set<string>()
  readonly #onAcquired: () => void
  readonly #onReleased: () => void

  constructor(options: PauseLockOptions) {
    this.#onAcquired = options.onAcquired
    this.#onReleased = options.onReleased
  }

  acquire(reason: string): void {
    if (this.#holders.has(reason)) {
      console.warn(
        `PauseLock: "${reason}" already held — ignoring duplicate acquire`
      )
      return
    }
    const wasUnlocked = this.#holders.size === 0
    this.#holders.add(reason)
    if (wasUnlocked) {
      this.#onAcquired()
    }
  }

  release(reason: string): void {
    if (!this.#holders.delete(reason)) {
      console.warn(`PauseLock: "${reason}" not held — ignoring orphan release`)
      return
    }
    if (this.#holders.size === 0) {
      this.#onReleased()
    }
  }

  releaseAllMatching(prefix: string): void {
    const sizeBefore = this.#holders.size
    for (const reason of this.#holders) {
      if (reason.startsWith(prefix)) {
        this.#holders.delete(reason)
      }
    }
    if (sizeBefore > 0 && this.#holders.size === 0) {
      this.#onReleased()
    }
  }

  get isPaused(): boolean {
    return this.#holders.size > 0
  }

  isHeldBy(reason: string): boolean {
    return this.#holders.has(reason)
  }
}
```

Note: `releaseAllMatching` needs care — only fire `onReleased` if we went from >0 to 0. Track `sizeBefore` to decide.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project client test/pause-lock.test.ts`
Expected: All 9 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/pause-lock.ts packages/client/test/pause-lock.test.ts
git commit -m "feat(client): add PauseLock for multi-reason pause coordination"
```

---

### Task 1.2: Wake Detection

**Files:**

- Create: `packages/client/src/wake-detection.ts`
- Create: `packages/client/test/wake-detection.test.ts`

- [ ] **Step 1: Write wake detection tests**

```typescript
// packages/client/test/wake-detection.test.ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { subscribeToWakeDetection } from "../src/wake-detection"

describe(`subscribeToWakeDetection`, () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it(`does not fire onWake under normal conditions`, () => {
    vi.useFakeTimers()
    const onWake = vi.fn()
    const unsubscribe = subscribeToWakeDetection({ onWake })
    vi.advanceTimersByTime(10_000) // 5 normal ticks
    expect(onWake).not.toHaveBeenCalled()
    unsubscribe()
  })

  it(`fires onWake when time jump detected`, () => {
    // Can't use vi.useFakeTimers() for this — fake timers advance Date.now()
    // in lockstep with intervals, so elapsed always equals intervalMs.
    // Instead, mock Date.now() directly to simulate a time jump.
    const onWake = vi.fn()
    let now = 1000
    vi.spyOn(Date, `now`).mockImplementation(() => now)
    vi.useFakeTimers()
    const unsubscribe = subscribeToWakeDetection({
      onWake,
      intervalMs: 2000,
      thresholdMs: 4000,
    })
    // Normal tick: advance 2s
    now += 2000
    vi.advanceTimersByTime(2000)
    expect(onWake).not.toHaveBeenCalled()
    // Simulate sleep: jump 10s but only one tick fires
    now += 10_000
    vi.advanceTimersByTime(2000)
    expect(onWake).toHaveBeenCalledTimes(1)
    unsubscribe()
    vi.restoreAllMocks()
  })

  it(`returns unsubscribe function that clears timer`, () => {
    vi.useFakeTimers()
    const onWake = vi.fn()
    const unsubscribe = subscribeToWakeDetection({ onWake })
    unsubscribe()
    vi.advanceTimersByTime(100_000)
    expect(onWake).not.toHaveBeenCalled()
  })

  it(`skips in browser environments`, () => {
    // Mock document.hidden to simulate browser
    const originalDocument = globalThis.document
    // @ts-expect-error - mock
    globalThis.document = { hidden: false, addEventListener: vi.fn() }
    const onWake = vi.fn()
    const unsubscribe = subscribeToWakeDetection({ onWake })
    // Should return a no-op unsubscribe
    unsubscribe()
    globalThis.document = originalDocument
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project client test/wake-detection.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement wake detection**

```typescript
// packages/client/src/wake-detection.ts
export interface WakeDetectionOptions {
  onWake: () => void
  intervalMs?: number
  thresholdMs?: number
}

const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_THRESHOLD_MS = 4000

function isBrowser(): boolean {
  return (
    typeof document === `object` &&
    typeof document.hidden === `boolean` &&
    typeof document.addEventListener === `function`
  )
}

export function subscribeToWakeDetection(
  options: WakeDetectionOptions
): () => void {
  if (isBrowser()) {
    return () => {} // no-op in browsers — visibility API handles this
  }

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS
  let lastTick = Date.now()

  const timer = setInterval(() => {
    const now = Date.now()
    const elapsed = now - lastTick
    lastTick = now

    if (elapsed > intervalMs + thresholdMs) {
      options.onWake()
    }
  }, intervalMs)

  // Don't keep Node/Bun alive just for wake detection
  if (typeof timer === `object` && `unref` in timer) {
    timer.unref()
  }

  return () => {
    clearInterval(timer)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project client test/wake-detection.test.ts`
Expected: All 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/wake-detection.ts packages/client/test/wake-detection.test.ts
git commit -m "feat(client): add system wake detection for non-browser environments"
```

---

### Task 1.3: State Machine — Base Classes and Types

**Files:**

- Modify: `packages/client/src/stream-response-state.ts` (full rewrite)

This task defines the abstract base classes and types. Concrete states come in subsequent tasks.

- [ ] **Step 1: Write the new type definitions and abstract classes**

Rewrite `packages/client/src/stream-response-state.ts` with:

- `SharedStateFields` interface (offset, cursor, upToDate, streamClosed)
- `ResponseMetadataInput` interface
- `MessageBatchInput` interface
- `ResponseTransition` discriminated union
- `MessageBatchTransition` discriminated union
- `SseCloseTransition` discriminated union
- `StreamState` abstract base (kind, abstract methods for all events)
- `ActiveState` abstract (extends StreamState, shared fields, `pause()`, `toErrorState()`, `applyUrlParams()`, `shouldContinueLive()`)
- `FetchingState` abstract (extends ActiveState, `handleResponseMetadata()` template)

Key reference: spec Section "State machine restructure" and "handleResponseMetadata() template method"

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/client && pnpm typecheck`
Expected: No type errors in the new file (existing tests will fail — that's expected since we removed old classes)

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/stream-response-state.ts
git commit -m "feat(client): add state machine base classes and transition types"
```

---

### Task 1.4: State Machine — Concrete States (InitialState, SyncingState, LiveState)

**Files:**

- Modify: `packages/client/src/stream-response-state.ts`

- [ ] **Step 1: Implement InitialState**

Extends `FetchingState`. Kind `"initial"`. No extra fields. `handleResponseMetadata()` inherits from `FetchingState` (transitions to SyncingState on accepted response).

- [ ] **Step 2: Implement SyncingState**

Extends `FetchingState`. Kind `"syncing"`. Overrides `handleMessageBatch()` — transitions to `LiveState` when `hasUpToDateMessage` is true.

- [ ] **Step 3: Implement LiveState**

Extends `ActiveState` directly. Kind `"live"`. Carries:

- `consecutiveShortConnections: number` (default 0)
- `sseFallbackToLongPolling: boolean` (default false)

Key methods:

```typescript
shouldUseSse(opts: { liveSseEnabled: boolean; resumingFromPause: boolean }): boolean {
  return opts.liveSseEnabled && !opts.resumingFromPause && !this.#sseFallbackToLongPolling
}
```

`handleSseConnectionClosed(input: SseCloseInput): SseCloseTransition` — port from current `SSEState.handleConnectionEnd()`:

- If connection was short (< minConnectionDuration) and NOT aborted: bump counter
  - If counter >= maxShortConnections: set `sseFallbackToLongPolling = true` (permanent)
  - Otherwise: return `wasShortConnection: true` for backoff
- If connection was healthy (>= minConnectionDuration): reset counter to 0
- Always returns a new LiveState (immutable)

`handleResponseMetadata()` — accepts response, stays in LiveState (preserves SSE fields).
`handleMessageBatch()` — stays in LiveState.

Reference: current `SSEState.handleConnectionEnd()` at `packages/client/src/stream-response-state.ts:190-250`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd packages/client && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/stream-response-state.ts
git commit -m "feat(client): add InitialState, SyncingState, LiveState"
```

---

### Task 1.5: State Machine — PausedState and ErrorState

**Files:**

- Modify: `packages/client/src/stream-response-state.ts`

- [ ] **Step 1: Implement PausedState**

Kind `"paused"`. Wraps `ActiveState | ErrorState`. Delegates all field getters. `pause()` returns `this` (idempotent). `resume()` returns `previousState`. Prevents same-type nesting: `PausedState(PausedState(X))` → `PausedState(X)`.

Response on PausedState: delegates to `previousState`, wraps result in PausedState for `accepted` transitions, returns `{ action: "ignored", state: this }` for ignored.

Messages/sseClose on PausedState: return `this` (no-op).

- [ ] **Step 2: Implement ErrorState**

Kind `"error"`. Wraps `ActiveState | PausedState`. Delegates all field getters. `retry()` returns `previousState`. `pause()` returns `new PausedState(this)`. Prevents same-type nesting. All event methods return ignored/no-op. Carries `error: Error`.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd packages/client && pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/stream-response-state.ts
git commit -m "feat(client): add PausedState and ErrorState with delegation"
```

---

### Task 1.6: SPEC.md and State Machine Tests

**Files:**

- Create: `packages/client/SPEC.md`
- Create: `packages/client/test/support/state-machine-dsl.ts`
- Create: `packages/client/test/support/state-transition-table.ts`
- Modify: `packages/client/test/stream-response-state.test.ts` (full rewrite)

- [ ] **Step 1: Write SPEC.md**

Adapt from Electric's SPEC.md (373 lines). Include:

- State table (7 states, 3 groups)
- Event table (8 events — dropping markMustRefetch, withHandle)
- Transition summary (state-machine + request-loop transitions)
- Invariants I0-I12 (adapted — drop handle-specific I10, I11)
- Constraints C1-C8 (adapted for durable-streams headers)
- Bidirectional enforcement checklist

Reference: Electric's `packages/typescript-client/SPEC.md` and our design spec.

- [ ] **Step 2: Write state-transition-table.ts**

TypeScript `Record<StateKind, Record<EventType, ExpectedBehavior>>` with NO `Partial` — compiler enforces completeness. Every cell of the 7×8 matrix must be specified.

```typescript
// packages/client/test/support/state-transition-table.ts
export type StateKind =
  | "initial"
  | "syncing"
  | "stale-retry"
  | "live"
  | "replaying"
  | "paused"
  | "error"
export type EventType =
  | "response"
  | "messages"
  | "sseClose"
  | "pause"
  | "resume"
  | "error"
  | "retry"
  | "enterReplayMode"

export interface ExpectedBehavior {
  resultKind: StateKind | "same"
  sameReference?: boolean
  action?: string
}

export const TRANSITION_TABLE: Record<
  StateKind,
  Record<EventType, ExpectedBehavior>
> = {
  // ... all 56 cells
}
```

- [ ] **Step 3: Write state-machine-dsl.ts**

Scenario builder with `assertStateInvariants()` that auto-checks:

- I0: kind/instanceof consistency
- I1: isUpToDate iff LiveState in delegation chain
- I6: StaleRetryState has cacheBuster
- I7: ReplayingState has replayCursor
- I8: PausedState delegation (field equality)
- I9: ErrorState delegation (field equality)
- I12: No same-type nesting

- [ ] **Step 4: Rewrite stream-response-state.test.ts**

Tiered test structure:

1. **Truth table tests** — iterate TRANSITION_TABLE, verify each cell
2. **Algebraic property tests** — pause/resume round-trip (I3), error/retry round-trip (I4)
3. **Invariant tests** — I0-I12 via DSL scenario builder
4. **Dedicated tests** — SSE fallback, shouldUseSse, applyUrlParams

- [ ] **Step 5: Run all tests**

Run: `pnpm vitest run --project client test/stream-response-state.test.ts`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/client/SPEC.md packages/client/test/support/ packages/client/test/stream-response-state.test.ts
git commit -m "feat(client): add SPEC.md, truth table, DSL, and state machine tests"
```

---

### Task 1.7: Wire PauseLock into Response Loop

**Files:**

- Modify: `packages/client/src/response.ts`
- Modify: `packages/client/src/stream-api.ts`

- [ ] **Step 1: Replace manual pause mechanism with PauseLock**

In `response.ts`:

- Remove `#state` string enum (`active`/`pause-requested`/`paused`)
- Remove `#pausePromise` / `#pauseResolve` plumbing
- Remove `#pause()` / `#resume()` methods
- Add `#pauseLock: PauseLock` field
- Constructor creates PauseLock with:
  - `onAcquired`: `this.#syncState = this.#syncState.pause()` + `this.#requestAbortController?.abort(PAUSE_STREAM)`
  - `onReleased`: restart request loop
- Visibility changes use `#pauseLock.acquire('visibility')` / `#pauseLock.release('visibility')`
- Pull function checks `#pauseLock.isPaused` instead of `#state`
- Resume path: check if `#syncState instanceof PausedState`, call `.resume()`

- [ ] **Step 2: Update state references to new hierarchy**

Replace all references to `LongPollState`/`SSEState` with new state classes. The `#syncState` field type changes to `StreamState`. Key method mapping from old → new:

| Old call in response.ts                              | New equivalent                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `state.withResponseMetadata(update)`                 | `state.handleResponseMetadata(input)` → returns `ResponseTransition`, check `.action`                              |
| `state.withSSEControl(event)`                        | `state.handleMessageBatch(input)` → returns `MessageBatchTransition`, check `.suppressBatch` and `.becameUpToDate` |
| `state instanceof SSEState` / `state.shouldUseSse()` | `state instanceof LiveState && state.shouldUseSse(opts)`                                                           |
| `(state as SSEState).handleConnectionEnd(...)`       | `(state as LiveState).handleSseConnectionClosed(input)` → returns `SseCloseTransition`                             |
| `(state as SSEState).startConnection(now)`           | Move connection tracking into LiveState — `handleSseConnectionClosed` takes duration                               |
| `new LongPollState(fields)`                          | `new InitialState(fields)` for first request, `new SyncingState(fields)` for catch-up                              |
| `new SSEState(fields)`                               | Not needed — LiveState is entered via `handleMessageBatch` returning `becameUpToDate: true`                        |

The pull() function loop in response.ts (lines 650-823) changes from direct state mutation to transition dispatch:

```typescript
// Old:
this.#syncState = this.#syncState.withResponseMetadata(update)

// New:
const transition = this.#syncState.handleResponseMetadata(input)
if (transition.action === `ignored`) return // ErrorState/PausedState no-op
this.#syncState = transition.state
```

Similarly for message batches:

```typescript
const batch = this.#syncState.handleMessageBatch(input)
this.#syncState = batch.state
if (batch.suppressBatch) return // ReplayingState suppressed duplicates
if (batch.becameUpToDate) {
  /* transition to live */
}
```

- [ ] **Step 3: Run existing tests to check for regressions**

Run: `pnpm vitest run --project client`
Expected: Existing tests that don't depend on old state class names should pass. Tests that reference `LongPollState`/`SSEState` directly will need updating.

- [ ] **Step 4: Fix broken existing tests**

Update test imports and assertions to use new state classes. The behavior should be preserved — same pause/resume semantics, just different implementation.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/response.ts packages/client/src/stream-api.ts packages/client/test/
git commit -m "feat(client): replace manual pause with PauseLock, wire new state machine"
```

---

### Task 1.8: Wire Wake Detection

**Files:**

- Modify: `packages/client/src/response.ts`

- [ ] **Step 1: Add wake detection subscription**

In `response.ts`:

- Add `#unsubscribeFromWakeDetection?: () => void` field
- Subscribe inside the `pull()` function of `#createResponseStream()` on the first invocation (not in the constructor). The current codebase has no `#start()` method — the pull function IS the lifecycle entry point. Use an idempotency guard:
  ```typescript
  // At top of pull():
  if (!this.#unsubscribeFromWakeDetection) {
    this.#unsubscribeFromWakeDetection = subscribeToWakeDetection({
      onWake: () => this.#requestAbortController?.abort(SYSTEM_WAKE),
    })
  }
  ```
- In `#markClosed()` and `#markError()` (teardown paths): call `this.#unsubscribeFromWakeDetection?.()` then set to `undefined`
- In catch block: handle `SYSTEM_WAKE` abort reason same as reconnect (don't propagate error)

- [ ] **Step 2: Add SYSTEM_WAKE constant**

```typescript
const SYSTEM_WAKE = `SYSTEM_WAKE`
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run --project client`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/response.ts
git commit -m "feat(client): wire system wake detection into request loop"
```

---

## Phase 2: Fast-Loop Detection + ErrorState Integration

### Task 2.1: FastLoopDetector

**Files:**

- Create: `packages/client/src/fast-loop-detection.ts`
- Create: `packages/client/test/fast-loop-detection.test.ts`

- [ ] **Step 1: Write FastLoopDetector tests**

Test cases:

- `check()` returns `ok` for normal requests at different offsets
- `check()` returns `ok` when same offset but under threshold count
- `check()` returns `clear-and-reset` on first detection (5 same-offset in 500ms)
- `check()` returns `backoff` on detections 2-4 with increasing delay
- `check()` returns `fatal` on detection 5
- `reset()` clears all state
- Entries older than window are pruned automatically

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project client test/fast-loop-detection.test.ts`

- [ ] **Step 3: Implement FastLoopDetector**

```typescript
// packages/client/src/fast-loop-detection.ts
import type { Offset } from "./types"

export interface FastLoopDetectorOptions {
  windowMs?: number
  threshold?: number
  maxCount?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
}

export type FastLoopResult =
  | { action: "ok" }
  | { action: "clear-and-reset" }
  | { action: "backoff"; delayMs: number }
  | { action: "fatal"; message: string }

export class FastLoopDetector {
  readonly #windowMs: number
  readonly #threshold: number
  readonly #maxCount: number
  readonly #backoffBaseMs: number
  readonly #backoffMaxMs: number
  #entries: Array<{ timestamp: number; offset: Offset }> = []
  #consecutiveCount = 0

  constructor(options: FastLoopDetectorOptions = {}) {
    this.#windowMs = options.windowMs ?? 500
    this.#threshold = options.threshold ?? 5
    this.#maxCount = options.maxCount ?? 5
    this.#backoffBaseMs = options.backoffBaseMs ?? 100
    this.#backoffMaxMs = options.backoffMaxMs ?? 5000
  }

  check(offset: Offset): FastLoopResult {
    const now = Date.now()

    // Prune old entries
    this.#entries = this.#entries.filter(
      (e) => now - e.timestamp < this.#windowMs
    )
    this.#entries.push({ timestamp: now, offset })

    // Count entries at same offset
    const sameOffsetCount = this.#entries.filter(
      (e) => e.offset === offset
    ).length

    if (sameOffsetCount < this.#threshold) {
      return { action: `ok` }
    }

    this.#consecutiveCount++

    if (this.#consecutiveCount >= this.#maxCount) {
      return {
        action: `fatal`,
        message: `Client is stuck in a fast retry loop at offset ${offset}. This usually indicates a misconfigured proxy or CDN.`,
      }
    }

    if (this.#consecutiveCount === 1) {
      this.#entries = []
      return { action: `clear-and-reset` }
    }

    // Exponential backoff with full jitter
    const maxDelay = Math.min(
      this.#backoffMaxMs,
      this.#backoffBaseMs * Math.pow(2, this.#consecutiveCount)
    )
    const delayMs = Math.floor(Math.random() * maxDelay)

    return { action: `backoff`, delayMs }
  }

  reset(): void {
    this.#entries = []
    this.#consecutiveCount = 0
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run --project client test/fast-loop-detection.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/fast-loop-detection.ts packages/client/test/fast-loop-detection.test.ts
git commit -m "feat(client): add FastLoopDetector with escalation ladder"
```

---

### Task 2.2: Add StaleRetryState to State Machine

**Files:**

- Modify: `packages/client/src/stream-response-state.ts`
- Modify: `packages/client/test/stream-response-state.test.ts`
- Modify: `packages/client/test/support/state-transition-table.ts`
- Modify: `packages/client/src/constants.ts`

- [ ] **Step 1: Add CACHE_BUSTER_QUERY_PARAM to constants**

```typescript
export const CACHE_BUSTER_QUERY_PARAM = `cache_buster`
```

Also add to the `DURABLE_STREAM_PROTOCOL_QUERY_PARAMS` array (line 149 of `constants.ts`) so users can't accidentally collide with it:

```typescript
export const DURABLE_STREAM_PROTOCOL_QUERY_PARAMS: Array<string> = [
  OFFSET_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  CURSOR_QUERY_PARAM,
  CACHE_BUSTER_QUERY_PARAM,
]
```

- [ ] **Step 2: Implement StaleRetryState**

Extends `FetchingState`. Kind `"stale-retry"`. Carries `#cacheBuster: string`. Overrides `applyUrlParams()` to add cache_buster param. `handleResponseMetadata()` inherited from FetchingState — transitions to SyncingState on accepted response.

Also add a `createCacheBuster()` utility (can live in `stream-response-state.ts` or a shared util):

```typescript
function createCacheBuster(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
```

- [ ] **Step 3: Update truth table and tests**

Add `stale-retry` row to transition table. Add tests for StaleRetryState URL params and transitions.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run --project client test/stream-response-state.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/stream-response-state.ts packages/client/src/constants.ts packages/client/test/
git commit -m "feat(client): add StaleRetryState with cache buster URL params"
```

---

### Task 2.3: Wire ErrorState + FastLoopDetector into Request Loop

**Files:**

- Modify: `packages/client/src/response.ts`
- Modify: `packages/client/src/stream-api.ts`
- Modify: `packages/client/src/error.ts`

- [ ] **Step 1: Wire ErrorState mid-stream error recovery**

In `response.ts` catch blocks:

- Instead of `#markError(err)` + `controller.error(err)`, transition to ErrorState:
  ```typescript
  this.#syncState = this.#syncState.toErrorState(err)
  ```
- Call `onError` handler
- If returns object: `this.#syncState = (this.#syncState as ErrorState).retry()`, continue loop
- If returns void: propagate error (current behavior)
- Check for `MissingHeadersError` — propagate immediately, bypass onError

- [ ] **Step 2: Wire FastLoopDetector**

In the request loop, before each non-live fetch:

```typescript
const loopResult = this.#fastLoopDetector.check(this.#syncState.offset)
switch (loopResult.action) {
  case `ok`: break
  case `clear-and-reset`:
    this.#syncState = new StaleRetryState({ ...fields, cacheBuster: createCacheBuster() })
    break
  case `backoff`:
    await new Promise(resolve => setTimeout(resolve, loopResult.delayMs))
    break
  case `fatal`:
    throw new FetchError(502, loopResult.message, ...)
}
```

On live request or successful offset advance: `this.#fastLoopDetector.reset()`

- [ ] **Step 3: Add regression test — same-offset tail read must NOT enter stale-retry**

This is the core protocol carveout: a valid `200 OK` with `Stream-Next-Offset` equal to the requested offset and `Stream-Up-To-Date: true` is a normal "at tail" response, not stale CDN data. Write a response-loop integration test:

```typescript
it(`does not enter stale-retry for valid at-tail 200 with same offset`, async () => {
  // Mock server returns 200 with same offset + upToDate: true
  // Verify state transitions to LiveState (not StaleRetryState)
  // Verify fast-loop detector is NOT triggered (only one request, not 5 in 500ms)
})
```

Place in the existing test file that tests the response loop (e.g., `test/stream-api.test.ts` or a new integration section in `test/stream-response-state.test.ts`).

- [ ] **Step 4: Update stream-api.ts**

Add `stream-api.ts` to scope — the outer retry loop should handle the unified error contract.

- [ ] **Step 4: Run all tests**

Run: `pnpm vitest run --project client`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/response.ts packages/client/src/stream-api.ts packages/client/src/error.ts
git commit -m "feat(client): wire ErrorState recovery and fast-loop detection into request loop"
```

---

## Phase 3: Fetch Middleware + Backoff + Header Validation

### Task 3.1: Update Backoff Defaults

**Files:**

- Modify: `packages/client/src/fetch.ts`

- [ ] **Step 1: Update BackoffDefaults**

```typescript
export const BackoffDefaults: BackoffOptions = {
  initialDelay: 1_000,
  maxDelay: 32_000,
  multiplier: 2,
  maxRetries: Infinity,
}
```

- [ ] **Step 2: Run tests (some backoff-timing tests may need threshold updates)**

Run: `pnpm vitest run --project client test/fetch.test.ts test/backoff-integration.test.ts`
Expected: Check if any tests hardcode old default values (100ms, 1.3x, 60s) and update them.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/fetch.ts packages/client/test/
git commit -m "fix(client): align backoff defaults with industry standards (1s/2x/32s)"
```

---

### Task 3.2: MissingHeadersError + Header Validation Middleware

**Files:**

- Modify: `packages/client/src/error.ts`
- Modify: `packages/client/src/fetch.ts`
- Modify: `packages/client/test/fetch.test.ts`

- [ ] **Step 1: Add MissingHeadersError to error.ts**

```typescript
export class MissingHeadersError extends Error {
  readonly missingHeaders: string[]
  constructor(missingHeaders: string[], url: string) {
    super(
      `Response from ${url} is missing required protocol headers: ${missingHeaders.join(`, `)}. ` +
        `This usually means a proxy or CDN is stripping headers.`
    )
    this.name = `MissingHeadersError`
    this.missingHeaders = missingHeaders
  }
}
```

- [ ] **Step 2: Implement createFetchWithResponseHeadersCheck**

Add to `fetch.ts`:

```typescript
export function createFetchWithResponseHeadersCheck(
  fetchClient: typeof fetch
): typeof fetch {
  return async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const res = await fetchClient(...args)
    if (res.status < 200 || res.status >= 300) return res

    const url = args[0].toString()
    const missing: string[] = []

    if (!res.headers.has(STREAM_OFFSET_HEADER)) {
      missing.push(STREAM_OFFSET_HEADER)
    }

    // Check cursor requirement for live requests (unless stream is closed)
    const requestUrl = new URL(url)
    const liveParam = requestUrl.searchParams.get(LIVE_QUERY_PARAM)
    const streamClosed = res.headers.get(STREAM_CLOSED_HEADER) === `true`
    if (liveParam && !streamClosed && !res.headers.has(STREAM_CURSOR_HEADER)) {
      missing.push(STREAM_CURSOR_HEADER)
    }

    if (missing.length > 0) {
      throw new MissingHeadersError(missing, url)
    }

    return res
  }
}
```

Import required constants from `constants.ts`.

- [ ] **Step 3: Write tests for header validation**

Test cases:

- Passes through response with all required headers
- Throws MissingHeadersError when Stream-Next-Offset missing
- Throws MissingHeadersError when live + missing cursor + not closed
- Does not throw when live + missing cursor + Stream-Closed: true
- Does not throw on non-2xx responses (4xx, 5xx pass through)

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run --project client test/fetch.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/error.ts packages/client/src/fetch.ts packages/client/test/fetch.test.ts
git commit -m "feat(client): add response header validation middleware (MissingHeadersError)"
```

---

### Task 3.3: Split Fetch Clients (Chunk vs SSE)

**Files:**

- Modify: `packages/client/src/stream-api.ts`
- Modify: `packages/client/src/response.ts`

- [ ] **Step 1: Create two fetch client chains in stream-api.ts**

```typescript
const backoffClient = createFetchWithBackoff(baseFetchClient, backoffOptions)

// For long-poll / catch-up chunk fetches:
const chunkFetchClient = createFetchWithConsumedBody(
  createFetchWithResponseHeadersCheck(backoffClient)
)

// For SSE connections (must not consume body):
const sseFetchClient = createFetchWithResponseHeadersCheck(backoffClient)
```

(Chunk prefetch middleware added in Phase 4)

- [ ] **Step 2: Thread both clients through to response.ts**

Pass both `chunkFetchClient` and `sseFetchClient` to `StreamResponseImpl`. Use `chunkFetchClient` for long-poll requests and `sseFetchClient` for SSE connections.

- [ ] **Step 3: Add SSE-bootstrap header validation regression test**

The SSE client must validate protocol headers on the initial SSE response (before streaming begins). Write a test that verifies `MissingHeadersError` is thrown when the SSE bootstrap response is missing `Stream-Next-Offset`:

```typescript
it(`SSE client throws MissingHeadersError when bootstrap response lacks protocol headers`, async () => {
  // Mock fetch returns SSE content-type response without Stream-Next-Offset header
  // Verify MissingHeadersError is thrown (not swallowed by SSE parsing)
  // Verify the error is non-retryable (bypasses onError)
})
```

- [ ] **Step 4: Run all tests**

Run: `pnpm vitest run --project client`
Expected: All pass — behavior unchanged for normal paths, new test covers SSE header validation

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/stream-api.ts packages/client/src/response.ts packages/client/test/
git commit -m "feat(client): split fetch clients for chunk vs SSE paths"
```

---

### Task 3.4: Duplicate-URL Guard

**Files:**

- Modify: `packages/client/src/response.ts`

- [ ] **Step 1: Add duplicate-URL detection**

In the request loop, after constructing the URL:

```typescript
if (!isLiveRequest && lastRequestUrl === url.toString()) {
  this.#duplicateUrlCount++
  if (this.#duplicateUrlCount >= 5) {
    throw new FetchError(502, `Same URL requested 5 times consecutively`, ...)
  }
  // Add cache buster to force unique URL
  url.searchParams.set(CACHE_BUSTER_QUERY_PARAM, createCacheBuster())
} else {
  this.#duplicateUrlCount = 0
}
lastRequestUrl = url.toString()
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run --project client`

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/response.ts
git commit -m "feat(client): add duplicate-URL guard as safety net"
```

---

## Phase 4: Replay Mode + Chunk Prefetching

### Task 4.1: UpToDateTracker

**Files:**

- Create: `packages/client/src/up-to-date-tracker.ts`
- Create: `packages/client/test/up-to-date-tracker.test.ts`

- [ ] **Step 1: Write UpToDateTracker tests**

Test cases:

- `recordUpToDate` stores cursor for stream key
- `shouldEnterReplayMode` returns cursor when entry is fresh (<60s)
- `shouldEnterReplayMode` returns null when entry is stale (>60s)
- `shouldEnterReplayMode` returns null when no entry exists
- `delete` removes entry
- LRU eviction after 250 entries
- Canonical key strips protocol params (offset, cursor, live, cache_buster)
- InMemoryUpToDateStorage works
- LocalStorageUpToDateStorage wraps localStorage errors in try/catch

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement UpToDateTracker**

```typescript
// packages/client/src/up-to-date-tracker.ts
export interface UpToDateStorage {
  get(key: string): { cursor: string; timestamp: number } | null
  set(key: string, value: { cursor: string; timestamp: number }): void
  delete(key: string): void
}

export class InMemoryUpToDateStorage implements UpToDateStorage {
  readonly #map = new Map<string, { cursor: string; timestamp: number }>()
  get(key: string) {
    return this.#map.get(key) ?? null
  }
  set(key: string, value: { cursor: string; timestamp: number }) {
    this.#map.set(key, value)
  }
  delete(key: string) {
    this.#map.delete(key)
  }
}

// ... LocalStorageUpToDateStorage, UpToDateTracker, canonicalStreamKey
```

Key: `canonicalStreamKey()` must strip `offset`, `cursor`, `live`, `cache_buster` from URL.

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/up-to-date-tracker.ts packages/client/test/up-to-date-tracker.test.ts
git commit -m "feat(client): add UpToDateTracker with pluggable storage"
```

---

### Task 4.2: ReplayingState

**Files:**

- Modify: `packages/client/src/stream-response-state.ts`
- Modify: `packages/client/test/stream-response-state.test.ts`
- Modify: `packages/client/test/support/state-transition-table.ts`

- [ ] **Step 1: Implement ReplayingState**

Extends `ActiveState`. Kind `"replaying"`. Carries `#replayCursor: string`. Overrides:

- `handleMessageBatch()` — suppresses batch when cursor matches replayCursor, transitions to LiveState
- `handleResponseMetadata()` — delegates to shared-field parsing
- `canEnterReplayMode()` returns `false` (already in replay)

Constraint C1: StaleRetryState also returns `false` for `canEnterReplayMode()`.

- [ ] **Step 2: Update truth table and add tests**

Add `replaying` row. Test cursor-match suppression vs cursor-mismatch pass-through.

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run --project client test/stream-response-state.test.ts`

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/stream-response-state.ts packages/client/test/
git commit -m "feat(client): add ReplayingState with cursor-based batch suppression"
```

---

### Task 4.3: Chunk Prefetching

**Files:**

- Modify: `packages/client/src/fetch.ts`
- Modify: `packages/client/test/fetch.test.ts`

- [ ] **Step 1: Implement getNextChunkUrl helper**

```typescript
export function getNextChunkUrl(
  requestUrl: URL,
  response: Response
): URL | null {
  if (response.headers.get(STREAM_CLOSED_HEADER) === `true`) return null
  if (response.headers.has(STREAM_UP_TO_DATE_HEADER)) return null
  if (requestUrl.searchParams.has(LIVE_QUERY_PARAM)) return null

  const nextOffset = response.headers.get(STREAM_OFFSET_HEADER)
  if (!nextOffset) return null

  const nextUrl = new URL(requestUrl.toString())
  nextUrl.searchParams.set(OFFSET_QUERY_PARAM, nextOffset)

  const cursor = response.headers.get(STREAM_CURSOR_HEADER)
  if (cursor) nextUrl.searchParams.set(CURSOR_QUERY_PARAM, cursor)

  return nextUrl
}
```

- [ ] **Step 2: Implement PrefetchQueue**

`Map<string, { promise, abort }>` with head/tail tracking. In-order consumption only. Per-entry AbortController. `consume(url)` returns prefetched promise or undefined. `prefetch(url, signal)` fires background fetch. `clear()` aborts all.

- [ ] **Step 3: Implement createFetchWithChunkBuffer**

Middleware that intercepts responses, calls `getNextChunkUrl`, and speculatively prefetches the next 1-2 chunks. Only for GET requests, never for live.

- [ ] **Step 4: Write tests**

Test cases for getNextChunkUrl:

- Returns null on Stream-Closed
- Returns null on Stream-Up-To-Date
- Returns null on live requests
- Returns correct URL with updated offset

Test cases for PrefetchQueue:

- consume() returns undefined for unknown URL
- prefetch() + consume() returns the response
- In-order: consume(url2) when url1 is head returns undefined
- clear() aborts all in-flight

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run --project client test/fetch.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/fetch.ts packages/client/test/fetch.test.ts
git commit -m "feat(client): add chunk prefetching middleware"
```

---

### Task 4.4: Wire Replay Mode + Prefetch into Request Loop

**Files:**

- Modify: `packages/client/src/response.ts`
- Modify: `packages/client/src/stream-api.ts`
- Modify: `packages/client/src/types.ts`
- Modify: `packages/client/src/index.ts`

- [ ] **Step 1: Add new option types**

In `types.ts`, add configurable options to `StreamOptions`:

```typescript
// Add to StreamOptions interface:
fastLoopOptions?: FastLoopDetectorOptions
prefetchOptions?: { maxChunksToPrefetch?: number }
upToDateStorage?: UpToDateStorage
```

Add the type imports from `fast-loop-detection.ts` and `up-to-date-tracker.ts`. These make fast-loop thresholds and prefetch depth configurable rather than hardcoded.

- [ ] **Step 2: Wire chunk prefetch into fetch client chain**

In `stream-api.ts`, add prefetch to the chunk client:

```typescript
const chunkFetchClient = createFetchWithConsumedBody(
  createFetchWithResponseHeadersCheck(createFetchWithChunkBuffer(backoffClient))
)
```

- [ ] **Step 3: Wire replay mode entry**

In `response.ts`, after first response transitions from InitialState to SyncingState:

```typescript
if (!this.#syncState.upToDate && this.#syncState.canEnterReplayMode()) {
  const cursor = upToDateTracker.shouldEnterReplayMode(streamKey)
  if (cursor) {
    this.#syncState = new ReplayingState({ ...fields, replayCursor: cursor })
  }
}
```

On up-to-date, record cursor:

```typescript
upToDateTracker.recordUpToDate(streamKey, cursor)
```

- [ ] **Step 4: Export new public types**

In `index.ts`, export `PauseLock`, `UpToDateStorage`, `InMemoryUpToDateStorage`, `LocalStorageUpToDateStorage`, and any other new public types.

- [ ] **Step 5: Run all tests**

Run: `pnpm vitest run --project client`
Expected: All pass

- [ ] **Step 6: Final commit**

```bash
git add packages/client/src/ packages/client/test/
git commit -m "feat(client): wire replay mode and chunk prefetching into request loop"
```

---

## Verification

After all 4 phases are complete:

- [ ] **Run full client test suite**: `pnpm vitest run --project client`
- [ ] **Run conformance tests**: `pnpm test:run -- --client typescript`
- [ ] **TypeScript compilation**: `cd packages/client && pnpm typecheck`
- [ ] **Verify Caddy plugin ignores cache_buster param**: `cd packages/caddy-plugin && go test ./...`
