# Layered Consumer Protocol — TypeScript Reference Server

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract L1 consumer primitives (registration, epoch fencing, ack, liveness) from the webhook system and expose them as standalone HTTP endpoints, then refactor webhooks as a thin L2 layer on top.

**Architecture:** The current webhook system bundles four concerns (consumer identity, epoch fencing, offset tracking, wake delivery) into one callback POST. This plan unbundles them: L1 becomes a standalone consumer protocol with its own HTTP endpoints, and webhooks become a L2 notification layer that delegates all consumer state to L1. The key invariant: L1 code never imports from or references L2 (webhook) code.

**Tech Stack:** TypeScript, Node.js HTTP, vitest, existing crypto.ts (renamed from webhook-crypto.ts, reused for bearer tokens)

**Spec:** [RFC: Layered Consumer Protocol (L0/L1/L2)](https://github.com/electric-sql/durable-streams/issues/23)

**Scope:** L1 + L2 Webhook refactor, TypeScript reference server only. Caddy plugin (Go) gets a separate plan. No pull-wake, mobile push, or namespace change feeds.

### Known Gaps and Design Notes

**Token refresh forces self-supersede:** When a bearer token expires (JWT TTL elapsed), the consumer must call `acquire` to get a new token, which bumps the epoch. This is a forced self-supersede for a timing issue, not a semantic one. The RFC should consider a token-refresh endpoint that reissues a token without incrementing epoch, if the consumer is still the active `READING` holder.

**No auth on consumer endpoints:** `POST /consumers`, `DELETE /consumers/{id}`, and `POST /consumers/{id}/acquire` have no authentication. This is consistent with the existing webhook system (auth is handled at the deployment layer per PROTOCOL.md § Security).

**Stream tail initialization is a spec-level decision:** New consumers start at the stream's current tail offset (not from the beginning). This means they only process events arriving after registration. Task 13 must make this normative in the restructured spec.

**Webhook still uses wake_id / claim (RFC says "no claim needed"):** The RFC explicitly states: "The wake_id claiming from the current design is subsumed into epoch fencing." The plan preserves `wake_id_claimed` on `WebhookConsumer` because the existing webhook system uses it for retry idempotency. Removing claim requires redesigning the webhook wake cycle to rely solely on epoch fencing — correct per the RFC, but a behavioral change beyond refactoring onto L1.

**No independent wake-preference endpoint:** The RFC defines `PUT /consumers/{id}/wake` for notification preferences, separating registration (L1) from notification (L2). The plan still has `WebhookManager` implicitly register L1 consumers during subscription flows. This means consumers cannot be registered without a webhook, and cannot change wake mechanisms without going through the webhook subscription API.

**`namespace` is stored but inert:** The `Consumer` type includes a `namespace` field (glob pattern, e.g. `/orders/*`) and `ConsumerStore` has a `findConsumersMatchingStream()` method, but nothing in this plan activates namespace-driven behavior. Registration still requires explicit `streams[]`; there is no automatic stream discovery or subscription via namespace patterns. The field exists because the RFC defines it and it costs nothing to store, but namespace change feeds are explicitly out of scope (line 13). A future plan would add `onStreamCreated` hooks that auto-subscribe namespace-matching consumers to new streams.

**Empty ack is the heartbeat shape (RFC § Heartbeat Endpoint — departs from dialectic):** Empty ack (`{ "offsets": [] }`) resets the lease timer without forcing a durable cursor write. The RFC explicitly decided against a dedicated heartbeat endpoint: "A dedicated heartbeat would be a second liveness channel that must be reconciled with ack frequency — re-creating the bundling problem we solved." Lease TTL is L1 infrastructure; both cursor-advancing acks and empty acks reset `last_ack_time`. Note: the dialectic concluded that ack and liveness should be fully separated (different endpoints, different concerns). The RFC refined this: same endpoint, but different semantics — an empty ack extends the lease without advancing cursors. This plan follows the RFC's refinement.

---

## File Structure

### New Files

| File                                                      | Responsibility                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/server/src/consumer-types.ts`                   | L1 type definitions: `Consumer`, `ConsumerState`, `AckRequest`, `AckResponse`, error codes                                                             |
| `packages/server/src/consumer-store.ts`                   | L1 state management: consumer CRUD, epoch management, offset tracking, stream indexes                                                                  |
| `packages/server/src/consumer-manager.ts`                 | L1 lifecycle: acquire, ack, release, lease-based liveness                                                                                              |
| `packages/server/src/consumer-routes.ts`                  | L1 HTTP handlers: `POST /consumers`, `GET /consumers/{id}`, `POST /consumers/{id}/acquire`, `POST /consumers/{id}/ack`, `POST /consumers/{id}/release` |
| `packages/server-conformance-tests/src/consumer-tests.ts` | L1 conformance test suite                                                                                                                              |

### Modified Files

| File                                     | Changes                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/webhook-crypto.ts`  | Modify `validateCallbackToken` to return `epoch` on success (currently discarded from JWT payload). Required for epoch fencing in L1.                                                                                                                                                                                |
| `packages/server/src/webhook-manager.ts` | Delegate all consumer state operations to `ConsumerManager`. Remove direct store manipulation for epoch, ack, liveness.                                                                                                                                                                                              |
| `packages/server/src/webhook-store.ts`   | Remove consumer state management (moved to `consumer-store.ts`). Keep subscription-specific state only.                                                                                                                                                                                                              |
| `packages/server/src/webhook-types.ts`   | Remove consumer types (moved to `consumer-types.ts`). Keep webhook-specific types (`Subscription`, `CallbackRequest`).                                                                                                                                                                                               |
| `packages/server/src/server.ts`          | Initialize `ConsumerManager`, mount `ConsumerRoutes`, pass manager to `WebhookManager`.                                                                                                                                                                                                                              |
| `PROTOCOL.md`                            | Restructure Section 6 into L1 (Section 6: Named Consumers) + L2 (Section 7: Wake-Up Notifications, subsection 7.1: Webhook). Renumber subsequent sections.                                                                                                                                                           |
| `docs/webhook-spec.md`                   | Restructure into L1 consumer spec + L2 webhook spec. Existing safety invariants (S1-S8) and liveness properties (L1-L3) need to be split: some are L1 properties (epoch monotonicity, offset monotonicity, stale epoch rejection), some are L2 (wake ID uniqueness, signature presence). Add L1 consumer invariants. |
| `docs/webhooks-rfc.md`                   | Update to reference layered architecture. This is the design RFC — add a "Superseded by" note pointing to the L0/L1/L2 RFC (issue #23) for the layered restructuring.                                                                                                                                                |

---

## Chunk 1: L1 Consumer Types and Store

### Task 1: Define L1 Consumer Types

**Files:**

- Create: `packages/server/src/consumer-types.ts`

- [ ] **Step 1: Create consumer-types.ts with L1 type definitions**

```typescript
/**
 * Types for Layer 1: Named Consumers.
 * L1 is mechanism-independent — no references to webhooks, push, or any L2 concept.
 */

export type ConsumerState = `REGISTERED` | `READING`

export interface Consumer {
  consumer_id: string
  state: ConsumerState
  epoch: number
  token: string | null
  streams: Map<string, string> // path -> last acked offset
  namespace: string | null // glob pattern, e.g. "/orders/*"
  lease_ttl_ms: number
  last_ack_at: number // reset by both cursor-advancing acks and empty acks (heartbeat shape)
  lease_timer: ReturnType<typeof setTimeout> | null
  created_at: number
}

export interface AckRequest {
  offsets: Array<{ path: string; offset: string }>
}

export interface AckResponse {
  ok: true
}

export interface AcquireResponse {
  consumer_id: string
  epoch: number
  token: string
  streams: Array<{ path: string; offset: string }>
}

export interface ReleaseResponse {
  ok: true
  state: `REGISTERED`
}

export interface ConsumerInfo {
  consumer_id: string
  state: ConsumerState
  epoch: number
  streams: Array<{ path: string; offset: string }>
  namespace: string | null
  lease_ttl_ms: number
}

export type ConsumerErrorCode =
  | `CONSUMER_NOT_FOUND`
  | `CONSUMER_ALREADY_EXISTS`
  | `EPOCH_HELD` // Reserved for future multi-server contention. Not produced by the single-process reference server.
  | `STALE_EPOCH`
  | `TOKEN_EXPIRED`
  | `TOKEN_INVALID`
  | `OFFSET_REGRESSION`
  | `INVALID_OFFSET`
  | `UNKNOWN_STREAM`

export interface ConsumerError {
  code: ConsumerErrorCode
  message: string
  current_epoch?: number
  path?: string
  retry_after?: number // seconds, for EPOCH_HELD
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Users/kylemathews/programs/darix && pnpm exec tsc --noEmit --project packages/server/tsconfig.json 2>&1 | head -20`
Expected: No errors related to consumer-types.ts

- [ ] **Step 3: Commit**

```bash
sleep 0.01 && git add packages/server/src/consumer-types.ts
sleep 0.01 && git commit -m "feat: add L1 consumer type definitions"
```

---

### Task 2: Rename Shared Utilities Out of webhook-\* Namespace

**Files:**

- Rename: `packages/server/src/webhook-crypto.ts` → `packages/server/src/crypto.ts`
- Rename: `packages/server/src/webhook-glob.ts` → `packages/server/src/glob.ts`
- Modify: All files that import from these modules

The plan's key invariant is "L1 code never imports from L2." Both `webhook-crypto.ts` and `webhook-glob.ts` contain mechanism-independent utilities (token signing, glob matching) that L1 needs. Renaming them eliminates false positives in layer boundary checks and makes ownership clear: these are shared utilities, not webhook-specific code.

- [ ] **Step 1: Rename webhook-crypto.ts → crypto.ts**

```bash
cd /Users/kylemathews/programs/darix && sleep 0.01 && git mv packages/server/src/webhook-crypto.ts packages/server/src/crypto.ts
```

- [ ] **Step 2: Rename webhook-glob.ts → glob.ts**

```bash
cd /Users/kylemathews/programs/darix && sleep 0.01 && git mv packages/server/src/webhook-glob.ts packages/server/src/glob.ts
```

- [ ] **Step 3: Update all imports**

Find and update all files importing from the old paths:

```bash
cd /Users/kylemathews/programs/darix && grep -rn "webhook-crypto\|webhook-glob" packages/server/src/ --include="*.ts"
```

Update each import:

- `./webhook-crypto` → `./crypto`
- `./webhook-glob` → `./glob`

Files expected to change: `webhook-manager.ts`, `webhook-store.ts`, `webhook-routes.ts`, `webhook-telemetry.ts` (if applicable).

- [ ] **Step 4: Verify compilation**

Run: `cd /Users/kylemathews/programs/darix && pnpm exec tsc --noEmit --project packages/server/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
sleep 0.01 && git add -A packages/server/src/
sleep 0.01 && git commit -m "refactor: rename webhook-crypto.ts and webhook-glob.ts to shared utility names"
```

---

### Task 3: Modify validateCallbackToken to Return Epoch

**Files:**

- Modify: `packages/server/src/crypto.ts:92-135`

The current `validateCallbackToken` decodes the JWT payload (which contains `{ sub, epoch, exp, jti }`) but discards the `epoch` field, returning only `{ valid: true, exp: number }`. Epoch fencing is the central invariant of L1 — without returning the epoch from the token, ack/release cannot verify that the token belongs to the current epoch. A stale token from epoch 1 would pass validation for a consumer now on epoch 3.

- [ ] **Step 1: Update the return type and implementation**

In `packages/server/src/crypto.ts`, change the `validateCallbackToken` function:

```typescript
export function validateCallbackToken(
  token: string,
  consumerId: string
):
  | { valid: true; exp: number; epoch: number }
  | { valid: false; code: `TOKEN_INVALID` | `TOKEN_EXPIRED` } {
  // ... existing validation code ...

  // Change the success return to include epoch:
  return { valid: true, exp: payload.exp, epoch: payload.epoch }
}
```

- [ ] **Step 2: Verify existing webhook-manager.ts still compiles**

The existing `handleCallback` in `webhook-manager.ts` uses `tokenResult.exp` but not `tokenResult.epoch` (it validates epoch separately via `request.epoch !== consumer.epoch`). Adding `epoch` to the return type is additive — no existing code breaks.

Run: `cd /Users/kylemathews/programs/darix && pnpm exec tsc --noEmit --project packages/server/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
sleep 0.01 && git add packages/server/src/crypto.ts
sleep 0.01 && git commit -m "feat: return epoch from validateCallbackToken for L1 epoch fencing"
```

---

### Task 4: Create L1 Consumer Store

**Files:**

- Create: `packages/server/src/consumer-store.ts`

The consumer store manages L1 state: consumer registration, epoch tracking, offset storage, and stream indexes. It is extracted from the consumer-related logic currently in `webhook-store.ts`.

- [ ] **Step 1: Write consumer-store.ts**

```typescript
/**
 * In-memory state management for Layer 1: Named Consumers.
 * Manages consumer registration, epoch tracking, and offset storage.
 * No references to webhooks or any L2 concept.
 */

import { globMatch } from "./glob"
import type { Consumer, ConsumerState } from "./consumer-types"

const DEFAULT_LEASE_TTL_MS = 60_000 // 1 minute

/**
 * Compare two offsets. Offsets are fixed-width, zero-padded strings
 * (e.g., "0000000000000001_0000000000000001") that are lexicographically
 * orderable. This is guaranteed by the server's offset generation
 * (see PROTOCOL.md § Offsets). Returns negative if a < b, 0 if equal,
 * positive if a > b.
 */
function compareOffsets(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

export class ConsumerStore {
  private consumers = new Map<string, Consumer>()
  // Index: stream_path -> set of consumer_ids subscribed to that stream
  private streamConsumers = new Map<string, Set<string>>()

  // ============================================================================
  // Consumer CRUD
  // ============================================================================

  /**
   * Register a new consumer. Idempotent if config matches.
   */
  registerConsumer(
    consumerId: string,
    streams: Array<string>,
    getTailOffset: (path: string) => string,
    opts?: {
      namespace?: string
      lease_ttl_ms?: number
    }
  ): { consumer: Consumer; created: boolean } | { error: `CONFIG_MISMATCH` } {
    const existing = this.consumers.get(consumerId)
    if (existing) {
      // Idempotent if config matches; reject on mismatch (same pattern as createSubscription)
      const existingPaths = Array.from(existing.streams.keys()).sort()
      const newPaths = [...streams].sort()
      const configMatch =
        existingPaths.length === newPaths.length &&
        existingPaths.every((p, i) => p === newPaths[i]) &&
        existing.namespace === (opts?.namespace ?? null) &&
        existing.lease_ttl_ms === (opts?.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS)
      if (!configMatch) {
        return { error: `CONFIG_MISMATCH` as const }
      }
      return { consumer: existing, created: false }
    }

    const streamMap = new Map<string, string>()
    for (const path of streams) {
      // Initialize at stream tail, matching existing webhook-store behavior.
      // Consumer starts from "now", not from the beginning.
      streamMap.set(path, getTailOffset(path))
    }

    const consumer: Consumer = {
      consumer_id: consumerId,
      state: `REGISTERED`,
      epoch: 0,
      token: null,
      streams: streamMap,
      namespace: opts?.namespace ?? null,
      lease_ttl_ms: opts?.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS,
      last_ack_at: 0,
      lease_timer: null,
      created_at: Date.now(),
    }

    this.consumers.set(consumerId, consumer)

    // Update stream indexes
    for (const path of streams) {
      this.addStreamIndex(path, consumerId)
    }

    return { consumer, created: true }
  }

  getConsumer(consumerId: string): Consumer | undefined {
    return this.consumers.get(consumerId)
  }

  removeConsumer(consumerId: string): boolean {
    const consumer = this.consumers.get(consumerId)
    if (!consumer) return false

    if (consumer.lease_timer) {
      clearTimeout(consumer.lease_timer)
    }

    for (const path of consumer.streams.keys()) {
      this.removeStreamIndex(path, consumerId)
    }

    this.consumers.delete(consumerId)
    return true
  }

  // ============================================================================
  // Epoch Management
  // ============================================================================

  /**
   * Acquire epoch for a consumer. Increments epoch and transitions to READING.
   * If already READING, this is a self-supersede (crash recovery) — epoch
   * increments and old token is invalidated.
   * Returns null if consumer doesn't exist.
   * NOTE: Single-process reference server has no contention check (EPOCH_HELD). Self-supersede always
   * succeeds. Multi-server contention is a future concern.
   */
  acquireEpoch(consumerId: string): {
    epoch: number
    prevState: ConsumerState
  } | null {
    const consumer = this.consumers.get(consumerId)
    if (!consumer) return null

    // If already READING, this is a self-supersede (crash recovery).
    // Epoch increments, old token is invalidated.
    consumer.epoch++
    const prevState = consumer.state
    consumer.state = `READING`
    consumer.last_ack_at = Date.now()

    return { epoch: consumer.epoch, prevState }
  }

  /**
   * Release epoch. Transitions consumer from READING to REGISTERED.
   */
  releaseEpoch(consumerId: string): boolean {
    const consumer = this.consumers.get(consumerId)
    if (!consumer || consumer.state !== `READING`) return false

    consumer.state = `REGISTERED`
    consumer.token = null

    if (consumer.lease_timer) {
      clearTimeout(consumer.lease_timer)
      consumer.lease_timer = null
    }

    return true
  }

  // ============================================================================
  // Offset Management
  // ============================================================================

  /**
   * Update acked offsets. Returns error info if offset regresses or is invalid.
   */
  updateOffsets(
    consumer: Consumer,
    offsets: Array<{ path: string; offset: string }>,
    getTailOffset: (path: string) => string
  ): {
    path: string
    code: `OFFSET_REGRESSION` | `INVALID_OFFSET` | `UNKNOWN_STREAM`
  } | null {
    // Validate all offsets before applying any (atomic)
    for (const { path, offset } of offsets) {
      const current = consumer.streams.get(path)
      if (current === undefined) {
        return { path, code: `UNKNOWN_STREAM` }
      }

      // Check regression
      if (compareOffsets(offset, current) < 0) {
        return { path, code: `OFFSET_REGRESSION` }
      }

      // Check beyond tail
      const tail = getTailOffset(path)
      if (compareOffsets(offset, tail) > 0) {
        return { path, code: `INVALID_OFFSET` }
      }
    }

    // Apply all offsets
    for (const { path, offset } of offsets) {
      if (consumer.streams.has(path)) {
        consumer.streams.set(path, offset)
      }
    }

    consumer.last_ack_at = Date.now()
    return null
  }

  // ============================================================================
  // Stream Management
  // ============================================================================

  /**
   * Add streams to a consumer's subscription.
   */
  addStreams(
    consumer: Consumer,
    paths: Array<string>,
    getTailOffset: (path: string) => string
  ): void {
    for (const path of paths) {
      if (!consumer.streams.has(path)) {
        consumer.streams.set(path, getTailOffset(path))
        this.addStreamIndex(path, consumer.consumer_id)
      }
    }
  }

  /**
   * Remove streams from a consumer. Returns true if consumer has no streams left.
   */
  removeStreams(consumer: Consumer, paths: Array<string>): boolean {
    for (const path of paths) {
      consumer.streams.delete(path)
      this.removeStreamIndex(path, consumer.consumer_id)
    }
    return consumer.streams.size === 0
  }

  /**
   * Get consumer IDs subscribed to a stream.
   */
  getConsumersForStream(streamPath: string): Array<string> {
    const set = this.streamConsumers.get(streamPath)
    return set ? Array.from(set) : []
  }

  /**
   * Find consumers matching a stream path via namespace globs.
   */
  findConsumersMatchingStream(streamPath: string): Array<Consumer> {
    return Array.from(this.consumers.values()).filter(
      (c) => c.namespace && globMatch(c.namespace, streamPath)
    )
  }

  /**
   * Get streams data for API responses.
   */
  getStreamsData(consumer: Consumer): Array<{ path: string; offset: string }> {
    return Array.from(consumer.streams, ([path, offset]) => ({ path, offset }))
  }

  /**
   * Check if consumer has pending work.
   */
  hasPendingWork(
    consumer: Consumer,
    getTailOffset: (path: string) => string
  ): boolean {
    for (const [path, ackedOffset] of consumer.streams) {
      const tail = getTailOffset(path)
      if (compareOffsets(tail, ackedOffset) > 0) return true
    }
    return false
  }

  /**
   * Remove a stream from all consumers. Returns IDs of consumers with no streams left.
   */
  removeStreamFromAllConsumers(streamPath: string): Array<string> {
    const consumerIds = this.getConsumersForStream(streamPath)
    const empty: Array<string> = []

    for (const cid of consumerIds) {
      const consumer = this.consumers.get(cid)
      if (!consumer) continue
      consumer.streams.delete(streamPath)
      if (consumer.streams.size === 0) {
        empty.push(cid)
      }
    }

    this.streamConsumers.delete(streamPath)
    return empty
  }

  /**
   * Get all consumers (for shutdown).
   */
  getAllConsumers(): IterableIterator<Consumer> {
    return this.consumers.values()
  }

  /**
   * Shut down: clear all timers and state.
   */
  shutdown(): void {
    for (const consumer of this.consumers.values()) {
      if (consumer.lease_timer) clearTimeout(consumer.lease_timer)
    }
    this.consumers.clear()
    this.streamConsumers.clear()
  }

  // ============================================================================
  // Private
  // ============================================================================

  private addStreamIndex(streamPath: string, consumerId: string): void {
    let set = this.streamConsumers.get(streamPath)
    if (!set) {
      set = new Set()
      this.streamConsumers.set(streamPath, set)
    }
    set.add(consumerId)
  }

  private removeStreamIndex(streamPath: string, consumerId: string): void {
    const set = this.streamConsumers.get(streamPath)
    if (set) {
      set.delete(consumerId)
      if (set.size === 0) {
        this.streamConsumers.delete(streamPath)
      }
    }
  }
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Users/kylemathews/programs/darix && pnpm exec tsc --noEmit --project packages/server/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
sleep 0.01 && git add packages/server/src/consumer-store.ts
sleep 0.01 && git commit -m "feat: add L1 consumer store with registration, epoch, and offset management"
```

---

## Chunk 2: L1 Consumer Manager and Routes (Tasks 5-6)

### Task 5: Create L1 Consumer Manager

**Files:**

- Create: `packages/server/src/consumer-manager.ts`

The consumer manager orchestrates L1 lifecycle: acquire (with token issuance), ack (with offset validation and lease reset), release, and lease-based liveness. Per the RFC, empty ack is the heartbeat shape — it resets the lease timer without forcing a durable cursor write. No separate heartbeat endpoint.

- [ ] **Step 1: Write consumer-manager.ts**

```typescript
/**
 * Layer 1 consumer lifecycle: acquire, ack, release, lease-based liveness.
 * Mechanism-independent — no references to webhooks or any L2 concept.
 *
 * Lease model (RFC § Liveness): Each consumer has a configurable lease_ttl.
 * The epoch is released when last_ack_time + lease_ttl is exceeded.
 * Both cursor-advancing acks and empty acks reset last_ack_time.
 * Empty acks are the heartbeat shape — they MUST NOT force a durable cursor write.
 */

import { ConsumerStore } from "./consumer-store"
import {
  generateCallbackToken,
  validateCallbackToken,
  tokenNeedsRefresh,
} from "./crypto"
import type {
  AckRequest,
  AcquireResponse,
  Consumer,
  ConsumerError,
  ConsumerInfo,
  ReleaseResponse,
} from "./consumer-types"

export class ConsumerManager {
  readonly store: ConsumerStore
  private getTailOffset: (path: string) => string
  private isShuttingDown = false

  /**
   * Callbacks invoked when a consumer's lease expires.
   * L2 layers register here to react (e.g., webhook re-wake).
   */
  private leaseExpiredCallbacks: Array<(consumer: Consumer) => void> = []

  onLeaseExpired(cb: (consumer: Consumer) => void): void {
    this.leaseExpiredCallbacks.push(cb)
  }

  /**
   * Callbacks invoked when a consumer is deleted.
   * L2 layers register here to clean up associated state
   * (e.g., remove WebhookConsumer records, cancel retry timers).
   */
  private consumerDeletedCallbacks: Array<(consumerId: string) => void> = []

  onConsumerDeleted(cb: (consumerId: string) => void): void {
    this.consumerDeletedCallbacks.push(cb)
  }

  constructor(opts: { getTailOffset: (path: string) => string }) {
    this.store = new ConsumerStore()
    this.getTailOffset = opts.getTailOffset
  }

  // ============================================================================
  // Registration
  // ============================================================================

  registerConsumer(
    consumerId: string,
    streams: Array<string>,
    opts?: {
      namespace?: string
      lease_ttl_ms?: number
    }
  ): { consumer: Consumer; created: boolean } | { error: `CONFIG_MISMATCH` } {
    return this.store.registerConsumer(
      consumerId,
      streams,
      this.getTailOffset,
      opts
    )
  }

  deleteConsumer(consumerId: string): boolean {
    const removed = this.store.removeConsumer(consumerId)
    if (removed) {
      for (const cb of this.consumerDeletedCallbacks) {
        cb(consumerId)
      }
    }
    return removed
  }

  getConsumer(consumerId: string): ConsumerInfo | null {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) return null
    return {
      consumer_id: consumer.consumer_id,
      state: consumer.state,
      epoch: consumer.epoch,
      streams: this.store.getStreamsData(consumer),
      namespace: consumer.namespace,
      lease_ttl_ms: consumer.lease_ttl_ms,
    }
  }

  // ============================================================================
  // Epoch Acquisition
  // ============================================================================

  /**
   * Acquire epoch for a consumer. Returns token + stream offsets.
   * If already READING, this is a self-supersede (crash recovery).
   */
  acquire(consumerId: string): AcquireResponse | { error: ConsumerError } {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) {
      return {
        error: {
          code: `CONSUMER_NOT_FOUND`,
          message: `Consumer '${consumerId}' does not exist`,
        },
      }
    }

    const result = this.store.acquireEpoch(consumerId)
    if (!result) {
      return {
        error: {
          code: `CONSUMER_NOT_FOUND`,
          message: `Consumer '${consumerId}' does not exist`,
        },
      }
    }

    const token = generateCallbackToken(consumerId, result.epoch)
    consumer.token = token

    // Start lease timer
    this.resetLeaseTimer(consumer)

    return {
      consumer_id: consumerId,
      epoch: result.epoch,
      token,
      streams: this.store.getStreamsData(consumer),
    }
  }

  // ============================================================================
  // Acknowledgment
  // ============================================================================

  /**
   * Process an ack request. Validates token, epoch, and offsets.
   * Empty offsets = heartbeat: resets lease timer, no durable cursor write.
   * Both empty and cursor-advancing acks reset last_ack_time (RFC § Liveness).
   */
  ack(
    consumerId: string,
    token: string,
    request: AckRequest
  ): { ok: true; token: string } | { error: ConsumerError } {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) {
      return {
        error: {
          code: `CONSUMER_NOT_FOUND`,
          message: `Consumer '${consumerId}' does not exist`,
        },
      }
    }

    // Validate token
    const tokenResult = validateCallbackToken(token, consumerId)
    if (!tokenResult.valid) {
      if (tokenResult.code === `TOKEN_EXPIRED`) {
        // Only issue a new token if the expired token was for the CURRENT epoch.
        // We can't know the expired token's epoch here (it failed validation),
        // so we don't auto-refresh. The consumer must re-acquire.
        return {
          error: {
            code: `TOKEN_EXPIRED`,
            message: `Bearer token has expired. Re-acquire the epoch to get a new token.`,
          },
        }
      }
      return {
        error: {
          code: `TOKEN_INVALID`,
          message: `Bearer token is malformed or signature invalid`,
        },
      }
    }

    // Validate token epoch matches consumer's current epoch.
    // This is the core epoch fencing check — prevents a superseded session
    // (with a still-valid token from an old epoch) from acking.
    if (tokenResult.epoch !== consumer.epoch) {
      return {
        error: {
          code: `STALE_EPOCH`,
          message: `Token epoch ${tokenResult.epoch} does not match current epoch ${consumer.epoch}`,
        },
      }
    }

    // Consumer must be in READING state
    if (consumer.state !== `READING`) {
      return {
        error: {
          code: `STALE_EPOCH`,
          message: `Consumer is not in READING state`,
        },
      }
    }

    // Empty offsets = heartbeat (extend lease, no durable cursor write)
    if (request.offsets.length === 0) {
      consumer.last_ack_at = Date.now()
      this.resetLeaseTimer(consumer)

      const responseToken = tokenNeedsRefresh(tokenResult.exp)
        ? generateCallbackToken(consumerId, consumer.epoch)
        : token

      return { ok: true, token: responseToken }
    }

    // Validate and apply offsets
    const offsetError = this.store.updateOffsets(
      consumer,
      request.offsets,
      this.getTailOffset
    )
    if (offsetError) {
      return {
        error: {
          code: offsetError.code,
          message:
            offsetError.code === `OFFSET_REGRESSION`
              ? `Ack offset is less than current cursor`
              : offsetError.code === `UNKNOWN_STREAM`
                ? `Stream path is not registered for this consumer`
                : `Ack offset is beyond stream tail`,
          path: offsetError.path,
        },
      }
    }

    // Reset lease timer (both empty and cursor-advancing acks extend the lease)
    this.resetLeaseTimer(consumer)

    const responseToken = tokenNeedsRefresh(tokenResult.exp)
      ? generateCallbackToken(consumerId, consumer.epoch)
      : token

    return { ok: true, token: responseToken }
  }

  // ============================================================================
  // Release
  // ============================================================================

  release(
    consumerId: string,
    token: string
  ): ReleaseResponse | { error: ConsumerError } {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) {
      return {
        error: {
          code: `CONSUMER_NOT_FOUND`,
          message: `Consumer '${consumerId}' does not exist`,
        },
      }
    }

    // Validate token
    const tokenResult = validateCallbackToken(token, consumerId)
    if (!tokenResult.valid) {
      return {
        error: {
          code: tokenResult.code,
          message:
            tokenResult.code === `TOKEN_EXPIRED`
              ? `Bearer token has expired`
              : `Bearer token is malformed or signature invalid`,
        },
      }
    }

    // Validate token epoch matches consumer's current epoch
    if (tokenResult.epoch !== consumer.epoch) {
      return {
        error: {
          code: `STALE_EPOCH`,
          message: `Token epoch ${tokenResult.epoch} does not match current epoch ${consumer.epoch}`,
        },
      }
    }

    if (consumer.state !== `READING`) {
      return {
        error: {
          code: `STALE_EPOCH`,
          message: `Consumer is not in READING state`,
        },
      }
    }

    this.store.releaseEpoch(consumerId)

    return { ok: true, state: `REGISTERED` }
  }

  // ============================================================================
  // Lease-Based Liveness
  // ============================================================================

  private resetLeaseTimer(consumer: Consumer): void {
    if (consumer.lease_timer) {
      clearTimeout(consumer.lease_timer)
    }

    consumer.lease_timer = setTimeout(() => {
      consumer.lease_timer = null
      if (consumer.state === `READING` && !this.isShuttingDown) {
        this.store.releaseEpoch(consumer.consumer_id)
        for (const cb of this.leaseExpiredCallbacks) {
          cb(consumer)
        }
      }
    }, consumer.lease_ttl_ms)
  }

  /**
   * Expire a consumer's epoch. Public API for L2 to force-expire
   * (e.g., webhook delivery failures beyond threshold).
   */
  expireConsumer(consumerId: string): boolean {
    return this.store.releaseEpoch(consumerId)
  }

  // ============================================================================
  // Stream Hooks (called from server.ts)
  // ============================================================================

  /**
   * Called when a stream is deleted. Removes stream from all consumers.
   */
  onStreamDeleted(streamPath: string): void {
    const emptyConsumerIds = this.store.removeStreamFromAllConsumers(streamPath)
    for (const cid of emptyConsumerIds) {
      this.deleteConsumer(cid)
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  hasPendingWork(consumerId: string): boolean {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) return false
    return this.store.hasPendingWork(consumer, this.getTailOffset)
  }

  shutdown(): void {
    this.isShuttingDown = true
    this.store.shutdown()
  }
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Users/kylemathews/programs/darix && pnpm exec tsc --noEmit --project packages/server/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
sleep 0.01 && git add packages/server/src/consumer-manager.ts
sleep 0.01 && git commit -m "feat: add L1 consumer manager with acquire, ack, release, and lease-based liveness"
```

---

### Task 6: Create L1 Consumer HTTP Routes

**Files:**

- Create: `packages/server/src/consumer-routes.ts`

- [ ] **Step 1: Write consumer-routes.ts**

```typescript
/**
 * HTTP handlers for Layer 1: Named Consumers.
 * Routes:
 *   POST   /consumers             — Register a consumer
 *   GET    /consumers/{id}        — Get consumer state
 *   POST   /consumers/{id}/acquire — Acquire epoch
 *   POST   /consumers/{id}/ack     — Acknowledge offsets (empty offsets = heartbeat)
 *   POST   /consumers/{id}/release — Release epoch
 *   DELETE /consumers/{id}        — Deregister consumer
 */

import type { ConsumerManager } from "./consumer-manager"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AckRequest, Consumer } from "./consumer-types"

const ERROR_CODE_TO_STATUS: Record<string, number> = {
  CONSUMER_NOT_FOUND: 404,
  CONSUMER_ALREADY_EXISTS: 409,
  EPOCH_HELD: 409,
  STALE_EPOCH: 409,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  OFFSET_REGRESSION: 409,
  INVALID_OFFSET: 409,
  UNKNOWN_STREAM: 400,
}

export class ConsumerRoutes {
  private manager: ConsumerManager

  constructor(manager: ConsumerManager) {
    this.manager = manager
  }

  /**
   * Try to handle a request as a consumer route.
   * Returns true if handled, false to pass through.
   */
  async handleRequest(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    if (!path.startsWith(`/consumers`)) return false

    // POST /consumers — register
    if (path === `/consumers` && method === `POST`) {
      await this.handleRegister(req, res)
      return true
    }

    // Parse /consumers/{id} and /consumers/{id}/{action}
    const segments = path.slice(`/consumers/`.length).split(`/`)
    if (segments.length === 0 || !segments[0]) return false

    const consumerId = decodeURIComponent(segments[0])
    const action = segments[1] // acquire, ack, release, or undefined

    if (!action) {
      // GET /consumers/{id}
      if (method === `GET`) {
        this.handleGet(consumerId, res)
        return true
      }
      // DELETE /consumers/{id}
      if (method === `DELETE`) {
        this.handleDelete(consumerId, res)
        return true
      }
      return false
    }

    if (method !== `POST`) {
      res.writeHead(405, { "content-type": `text/plain` })
      res.end(`Method not allowed`)
      return true
    }

    switch (action) {
      case `acquire`:
        this.handleAcquire(consumerId, res)
        return true
      case `ack`:
        await this.handleAck(consumerId, req, res)
        return true
      case `release`:
        this.handleRelease(consumerId, req, res)
        return true
      default:
        return false
    }
  }

  // ============================================================================
  // Handlers
  // ============================================================================

  private async handleRegister(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req)
    let parsed: {
      consumer_id?: string
      streams?: Array<string>
      namespace?: string
      lease_ttl_ms?: number
    }

    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Invalid JSON body` },
        })
      )
      return
    }

    if (!parsed.consumer_id) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `Missing required field: consumer_id`,
          },
        })
      )
      return
    }

    if (!parsed.streams || parsed.streams.length === 0) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `Missing required field: streams`,
          },
        })
      )
      return
    }

    const result = this.manager.registerConsumer(
      parsed.consumer_id,
      parsed.streams,
      {
        namespace: parsed.namespace,
        lease_ttl_ms: parsed.lease_ttl_ms,
      }
    )

    if (`error` in result) {
      res.writeHead(409, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `CONSUMER_ALREADY_EXISTS`,
            message: `Consumer already exists with different configuration`,
          },
        })
      )
      return
    }

    const info = this.manager.getConsumer(result.consumer.consumer_id)
    res.writeHead(result.created ? 201 : 200, {
      "content-type": `application/json`,
    })
    res.end(JSON.stringify(info))
  }

  private handleGet(consumerId: string, res: ServerResponse): void {
    const info = this.manager.getConsumer(consumerId)
    if (!info) {
      res.writeHead(404, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `CONSUMER_NOT_FOUND`, message: `Consumer not found` },
        })
      )
      return
    }
    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify(info))
  }

  private handleDelete(consumerId: string, res: ServerResponse): void {
    const removed = this.manager.deleteConsumer(consumerId)
    if (!removed) {
      res.writeHead(404, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `CONSUMER_NOT_FOUND`, message: `Consumer not found` },
        })
      )
      return
    }
    res.writeHead(204)
    res.end()
  }

  private handleAcquire(consumerId: string, res: ServerResponse): void {
    const result = this.manager.acquire(consumerId)

    if (`error` in result) {
      const status = ERROR_CODE_TO_STATUS[result.error.code] ?? 500
      const headers: Record<string, string> = {
        "content-type": `application/json`,
      }
      if (result.error.retry_after) {
        headers[`Retry-After`] = String(result.error.retry_after)
      }
      res.writeHead(status, headers)
      res.end(JSON.stringify({ error: result.error }))
      return
    }

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify(result))
  }

  private async handleAck(
    consumerId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Extract bearer token
    const authHeader = req.headers[`authorization`]
    if (!authHeader || !authHeader.startsWith(`Bearer `)) {
      res.writeHead(401, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `TOKEN_INVALID`,
            message: `Missing or malformed Authorization header`,
          },
        })
      )
      return
    }
    const token = authHeader.slice(`Bearer `.length)

    // Parse body
    const body = await this.readBody(req)
    let parsed: AckRequest
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Invalid JSON body` },
        })
      )
      return
    }

    if (!Array.isArray(parsed.offsets)) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `Missing required field: offsets`,
          },
        })
      )
      return
    }

    const result = this.manager.ack(consumerId, token, parsed)

    if (`error` in result) {
      const status = ERROR_CODE_TO_STATUS[result.error.code] ?? 500
      res.writeHead(status, { "content-type": `application/json` })
      res.end(JSON.stringify({ error: result.error }))
      return
    }

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify({ ok: true, token: result.token }))
  }

  private handleRelease(
    consumerId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): void {
    const authHeader = req.headers[`authorization`]
    if (!authHeader || !authHeader.startsWith(`Bearer `)) {
      res.writeHead(401, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `TOKEN_INVALID`,
            message: `Missing or malformed Authorization header`,
          },
        })
      )
      return
    }
    const token = authHeader.slice(`Bearer `.length)

    const result = this.manager.release(consumerId, token)

    if (`error` in result) {
      const status = ERROR_CODE_TO_STATUS[result.error.code] ?? 500
      res.writeHead(status, { "content-type": `application/json` })
      res.end(JSON.stringify({ error: result.error }))
      return
    }

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify(result))
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private readBody(req: IncomingMessage): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const chunks: Array<Buffer> = []
      req.on(`data`, (chunk: Buffer) => chunks.push(chunk))
      req.on(`end`, () => resolve(new Uint8Array(Buffer.concat(chunks))))
      req.on(`error`, reject)
    })
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/kylemathews/programs/darix && pnpm exec tsc --noEmit --project packages/server/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
sleep 0.01 && git add packages/server/src/consumer-routes.ts
sleep 0.01 && git commit -m "feat: add L1 consumer HTTP routes (register, acquire, ack, release)"
```

---

## Chunk 3: Wire L1 into Server and Write Conformance Tests

### Task 7: Mount L1 Routes in Server

**Files:**

- Modify: `packages/server/src/server.ts`

- [ ] **Step 1: Add imports for ConsumerManager and ConsumerRoutes**

At the top of `server.ts`, add:

```typescript
import { ConsumerManager } from "./consumer-manager"
import { ConsumerRoutes } from "./consumer-routes"
```

- [ ] **Step 2: Add ConsumerManager initialization**

In the server's constructor/init section (near where `WebhookManager` is initialized around line 269), add `ConsumerManager` initialization:

```typescript
// Initialize ConsumerManager (L1 — always available)
this.consumerManager = new ConsumerManager({
  getTailOffset: (path: string) => {
    const stream = this.store.get(path)
    return stream ? stream.currentOffset : `-1`
  },
})
this.consumerRoutes = new ConsumerRoutes(this.consumerManager)
```

Add fields to the class:

```typescript
private consumerManager?: ConsumerManager
private consumerRoutes?: ConsumerRoutes
```

- [ ] **Step 3: Add route handling in the request handler**

In the main request dispatch (where `webhookRoutes.handleRequest` is called), add consumer route handling BEFORE webhook routes:

```typescript
// L1 Consumer routes
if (this.consumerRoutes) {
  const handled = await this.consumerRoutes.handleRequest(
    method,
    path,
    req,
    res
  )
  if (handled) return
}
```

- [ ] **Step 4: Add shutdown call**

In the server's shutdown/close method, add:

```typescript
this.consumerManager?.shutdown()
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Users/kylemathews/programs/darix && pnpm exec tsc --noEmit --project packages/server/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 6: Verify existing tests still pass**

Run: `cd /Users/kylemathews/programs/darix && pnpm vitest run --project server 2>&1 | tail -20`
Expected: All existing tests pass

- [ ] **Step 7: Commit**

```bash
sleep 0.01 && git add packages/server/src/server.ts
sleep 0.01 && git commit -m "feat: mount L1 consumer routes in server"
```

---

### Task 8: Write L1 Conformance Tests — Registration

**Files:**

- Create: `packages/server-conformance-tests/src/consumer-tests.ts`

These tests verify the L1 consumer protocol using direct HTTP calls.

- [ ] **Step 1: Write registration test scaffolding and first test**

```typescript
/**
 * Layer 1 Consumer Protocol conformance tests.
 * Tests the consumer lifecycle: register, acquire, ack, release.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"

// These tests run against a live server instance.
// The server URL is provided by the test runner.

interface TestContext {
  serverUrl: string
  createStream: (path: string) => Promise<void>
  appendToStream: (path: string, data: string) => Promise<string>
}

async function postJson(
  url: string,
  body: object,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers["authorization"] = `Bearer ${token}`
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
}

export function runConsumerConformanceTests(getCtx: () => TestContext) {
  describe("L1: Named Consumers", () => {
    describe("Registration", () => {
      it("registers a new consumer", async () => {
        const ctx = getCtx()
        await ctx.createStream("/test/stream-1")

        const res = await postJson(`${ctx.serverUrl}/consumers`, {
          consumer_id: "test-consumer",
          streams: ["/test/stream-1"],
        })

        expect(res.status).toBe(201)
        const body = await res.json()
        expect(body.consumer_id).toBe("test-consumer")
        expect(body.state).toBe("REGISTERED")
        expect(body.epoch).toBe(0)
      })

      it("idempotent registration returns 200", async () => {
        const ctx = getCtx()
        await ctx.createStream("/test/stream-1")

        await postJson(`${ctx.serverUrl}/consumers`, {
          consumer_id: "test-consumer",
          streams: ["/test/stream-1"],
        })

        const res = await postJson(`${ctx.serverUrl}/consumers`, {
          consumer_id: "test-consumer",
          streams: ["/test/stream-1"],
        })

        expect(res.status).toBe(200)
      })

      it("GET returns consumer info", async () => {
        const ctx = getCtx()
        await ctx.createStream("/test/stream-1")

        await postJson(`${ctx.serverUrl}/consumers`, {
          consumer_id: "test-consumer",
          streams: ["/test/stream-1"],
        })

        const res = await fetch(`${ctx.serverUrl}/consumers/test-consumer`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.consumer_id).toBe("test-consumer")
        expect(body.state).toBe("REGISTERED")
      })

      it("GET returns 404 for unknown consumer", async () => {
        const ctx = getCtx()
        const res = await fetch(`${ctx.serverUrl}/consumers/nonexistent`)
        expect(res.status).toBe(404)
      })

      it("DELETE removes consumer", async () => {
        const ctx = getCtx()
        await ctx.createStream("/test/stream-1")

        await postJson(`${ctx.serverUrl}/consumers`, {
          consumer_id: "test-consumer",
          streams: ["/test/stream-1"],
        })

        const delRes = await fetch(`${ctx.serverUrl}/consumers/test-consumer`, {
          method: "DELETE",
        })
        expect(delRes.status).toBe(204)

        const getRes = await fetch(`${ctx.serverUrl}/consumers/test-consumer`)
        expect(getRes.status).toBe(404)
      })
    })
  })
}
```

- [ ] **Step 2: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/consumer-tests.ts
sleep 0.01 && git commit -m "test: add L1 consumer registration conformance tests"
```

---

### Task 9: Write L1 Conformance Tests — Acquire, Ack, Release, Error Cases

**Files:**

- Modify: `packages/server-conformance-tests/src/consumer-tests.ts`

- [ ] **Step 1: Add epoch acquisition tests**

Add inside the `consumerTests` function, after the Registration describe block:

```typescript
describe("Epoch Acquisition", () => {
  it("acquires epoch and returns token", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")
    await ctx.appendToStream("/test/stream-1", "event-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    const res = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.consumer_id).toBe("test-consumer")
    expect(body.epoch).toBe(1)
    expect(body.token).toBeTruthy()
    expect(body.streams).toHaveLength(1)
    expect(body.streams[0].path).toBe("/test/stream-1")
  })

  it("transitions consumer to READING state", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    await postJson(`${ctx.serverUrl}/consumers/test-consumer/acquire`, {})

    const res = await fetch(`${ctx.serverUrl}/consumers/test-consumer`)
    const body = await res.json()
    expect(body.state).toBe("READING")
    expect(body.epoch).toBe(1)
  })

  it("self-supersede increments epoch", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    const res1 = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const body1 = await res1.json()
    expect(body1.epoch).toBe(1)

    const res2 = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const body2 = await res2.json()
    expect(body2.epoch).toBe(2)
    expect(body2.token).not.toBe(body1.token)
  })

  it("returns 404 for unknown consumer", async () => {
    const ctx = getCtx()
    const res = await postJson(
      `${ctx.serverUrl}/consumers/nonexistent/acquire`,
      {}
    )
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Add ack tests**

```typescript
describe("Acknowledgment", () => {
  it("acks offsets successfully", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")
    const offset = await ctx.appendToStream("/test/stream-1", "event-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    const acqRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const { token } = await acqRes.json()

    const ackRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      { offsets: [{ path: "/test/stream-1", offset }] },
      token
    )

    expect(ackRes.status).toBe(200)
    const body = await ackRes.json()
    expect(body.ok).toBe(true)
    expect(body.token).toBeTruthy()
  })

  it("empty offsets acts as heartbeat (extends lease, no cursor write)", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    const acqRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const { token } = await acqRes.json()

    // Empty offsets = heartbeat shape (RFC § Heartbeat Endpoint):
    // resets lease timer, no durable cursor write.
    const ackRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      { offsets: [] },
      token
    )

    expect(ackRes.status).toBe(200)
  })

  it("rejects ack without bearer token", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    await postJson(`${ctx.serverUrl}/consumers/test-consumer/acquire`, {})

    const ackRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      { offsets: [] }
      // no token
    )

    expect(ackRes.status).toBe(401)
  })

  it("rejects ack when consumer is REGISTERED (not READING)", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    // Acquire then release to get a valid token for REGISTERED state
    const acqRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const { token } = await acqRes.json()

    await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/release`,
      {},
      token
    )

    // Now try to ack — consumer is REGISTERED
    // Need to use the old token since that's all we have
    const ackRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      { offsets: [] },
      token
    )

    expect(ackRes.status).toBe(409)
  })
})
```

- [ ] **Step 3: Add STALE_EPOCH, OFFSET_REGRESSION, and INVALID_OFFSET tests**

```typescript
describe("Error Cases", () => {
  it("rejects ack with stale epoch token (STALE_EPOCH)", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    // Acquire epoch 1
    const acq1 = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const { token: oldToken } = await acq1.json()

    // Self-supersede to epoch 2 (invalidates epoch 1 token)
    await postJson(`${ctx.serverUrl}/consumers/test-consumer/acquire`, {})

    // Try to ack with epoch 1 token
    const ackRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      { offsets: [] },
      oldToken
    )

    expect(ackRes.status).toBe(409)
    const body = await ackRes.json()
    expect(body.error.code).toBe("STALE_EPOCH")
  })

  it("rejects ack with regressing offset (OFFSET_REGRESSION)", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")
    const offset1 = await ctx.appendToStream("/test/stream-1", "event-1")
    const offset2 = await ctx.appendToStream("/test/stream-1", "event-2")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    const acqRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const { token } = await acqRes.json()

    // Ack offset2 first
    await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      { offsets: [{ path: "/test/stream-1", offset: offset2 }] },
      token
    )

    // Try to ack offset1 (regression)
    const ackRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      { offsets: [{ path: "/test/stream-1", offset: offset1 }] },
      token
    )

    expect(ackRes.status).toBe(409)
    const body = await ackRes.json()
    expect(body.error.code).toBe("OFFSET_REGRESSION")
  })

  it("rejects ack beyond stream tail (INVALID_OFFSET)", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")
    await ctx.appendToStream("/test/stream-1", "event-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    const acqRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const { token } = await acqRes.json()

    // Ack an offset way beyond the tail
    const ackRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      {
        offsets: [
          {
            path: "/test/stream-1",
            offset: "9999999999999999_9999999999999999",
          },
        ],
      },
      token
    )

    expect(ackRes.status).toBe(409)
    const body = await ackRes.json()
    expect(body.error.code).toBe("INVALID_OFFSET")
  })

  it("rejects ack for unknown stream path (UNKNOWN_STREAM)", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    const acqRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const { token } = await acqRes.json()

    // Ack a path the consumer isn't subscribed to (typo)
    const ackRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      {
        offsets: [
          {
            path: "/test/strem-1",
            offset: "0000000000000001_0000000000000001",
          },
        ],
      },
      token
    )

    expect(ackRes.status).toBe(400)
    const body = await ackRes.json()
    expect(body.error.code).toBe("UNKNOWN_STREAM")
    expect(body.error.path).toBe("/test/strem-1")
  })
})

describe("Lease TTL", () => {
  it("releases epoch after lease TTL expires", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    // Register with short lease TTL for testing
    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
      lease_ttl_ms: 100, // 100ms for fast test
    })

    await postJson(`${ctx.serverUrl}/consumers/test-consumer/acquire`, {})

    // Verify READING state
    const before = await fetch(`${ctx.serverUrl}/consumers/test-consumer`)
    expect((await before.json()).state).toBe("READING")

    // Wait for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Verify transition back to REGISTERED
    const after = await fetch(`${ctx.serverUrl}/consumers/test-consumer`)
    expect((await after.json()).state).toBe("REGISTERED")
  })

  it("empty ack (heartbeat) extends the lease", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
      lease_ttl_ms: 150,
    })

    const acqRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const { token } = await acqRes.json()

    // Wait 100ms (within 150ms TTL), then send heartbeat
    await new Promise((resolve) => setTimeout(resolve, 100))
    await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      { offsets: [] },
      token
    )

    // Wait another 100ms — would be 200ms total without heartbeat (past 150ms TTL)
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Should still be READING because heartbeat reset the timer
    const after = await fetch(`${ctx.serverUrl}/consumers/test-consumer`)
    expect((await after.json()).state).toBe("READING")
  })
})
```

- [ ] **Step 4: Add multi-stream consumer tests**

```typescript
describe("Multi-Stream Consumers", () => {
  it("tracks offsets independently across streams", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-a")
    await ctx.createStream("/test/stream-b")
    const offsetA = await ctx.appendToStream("/test/stream-a", "event-a")
    const offsetB = await ctx.appendToStream("/test/stream-b", "event-b")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "multi-consumer",
      streams: ["/test/stream-a", "/test/stream-b"],
    })

    const acqRes = await postJson(
      `${ctx.serverUrl}/consumers/multi-consumer/acquire`,
      {}
    )
    const { token } = await acqRes.json()

    // Ack only stream-a
    const ackRes = await postJson(
      `${ctx.serverUrl}/consumers/multi-consumer/ack`,
      { offsets: [{ path: "/test/stream-a", offset: offsetA }] },
      token
    )
    expect(ackRes.status).toBe(200)

    // Release and re-acquire — stream-a should be at offsetA, stream-b at tail
    await postJson(
      `${ctx.serverUrl}/consumers/multi-consumer/release`,
      {},
      token
    )
    const acq2 = await postJson(
      `${ctx.serverUrl}/consumers/multi-consumer/acquire`,
      {}
    )
    const body2 = await acq2.json()

    const streamA = body2.streams.find((s: any) => s.path === "/test/stream-a")
    const streamB = body2.streams.find((s: any) => s.path === "/test/stream-b")
    expect(streamA.offset).toBe(offsetA)
    // stream-b was never acked, so offset is at its initial position (tail at registration)
  })

  it("atomic ack: second offset regresses, first is not applied", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-a")
    await ctx.createStream("/test/stream-b")
    const offsetA1 = await ctx.appendToStream("/test/stream-a", "a1")
    const offsetA2 = await ctx.appendToStream("/test/stream-a", "a2")
    const offsetB1 = await ctx.appendToStream("/test/stream-b", "b1")
    const offsetB2 = await ctx.appendToStream("/test/stream-b", "b2")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "atomic-consumer",
      streams: ["/test/stream-a", "/test/stream-b"],
    })

    const acqRes = await postJson(
      `${ctx.serverUrl}/consumers/atomic-consumer/acquire`,
      {}
    )
    const { token } = await acqRes.json()

    // Ack both streams to offset 2
    await postJson(
      `${ctx.serverUrl}/consumers/atomic-consumer/ack`,
      {
        offsets: [
          { path: "/test/stream-a", offset: offsetA2 },
          { path: "/test/stream-b", offset: offsetB2 },
        ],
      },
      token
    )

    // Now try to ack stream-a forward but stream-b backward (regression)
    const offsetA3 = await ctx.appendToStream("/test/stream-a", "a3")
    const badAck = await postJson(
      `${ctx.serverUrl}/consumers/atomic-consumer/ack`,
      {
        offsets: [
          { path: "/test/stream-a", offset: offsetA3 }, // valid: forward
          { path: "/test/stream-b", offset: offsetB1 }, // invalid: regression
        ],
      },
      token
    )

    expect(badAck.status).toBe(409)
    const body = await badAck.json()
    expect(body.error.code).toBe("OFFSET_REGRESSION")
    expect(body.error.path).toBe("/test/stream-b")

    // Verify stream-a was NOT advanced (atomicity)
    const info = await fetch(`${ctx.serverUrl}/consumers/atomic-consumer`)
    const consumer = await info.json()
    const streamA = consumer.streams.find(
      (s: any) => s.path === "/test/stream-a"
    )
    expect(streamA.offset).toBe(offsetA2) // NOT offsetA3
  })
})
```

- [ ] **Step 5: Add release tests**

```typescript
describe("Release", () => {
  it("releases epoch and returns to REGISTERED", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    const acqRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const { token } = await acqRes.json()

    const relRes = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/release`,
      {},
      token
    )

    expect(relRes.status).toBe(200)
    const body = await relRes.json()
    expect(body.ok).toBe(true)
    expect(body.state).toBe("REGISTERED")

    // Verify state
    const getRes = await fetch(`${ctx.serverUrl}/consumers/test-consumer`)
    const info = await getRes.json()
    expect(info.state).toBe("REGISTERED")
  })

  it("preserves committed cursor after release", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")
    const offset = await ctx.appendToStream("/test/stream-1", "event-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    // Acquire, ack, release
    const acq1 = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const { token: t1 } = await acq1.json()
    await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/ack`,
      { offsets: [{ path: "/test/stream-1", offset }] },
      t1
    )
    await postJson(`${ctx.serverUrl}/consumers/test-consumer/release`, {}, t1)

    // Re-acquire — cursor should be preserved
    const acq2 = await postJson(
      `${ctx.serverUrl}/consumers/test-consumer/acquire`,
      {}
    )
    const body2 = await acq2.json()
    expect(body2.streams[0].offset).toBe(offset)
  })

  it("rejects release without token", async () => {
    const ctx = getCtx()
    await ctx.createStream("/test/stream-1")

    await postJson(`${ctx.serverUrl}/consumers`, {
      consumer_id: "test-consumer",
      streams: ["/test/stream-1"],
    })

    await postJson(`${ctx.serverUrl}/consumers/test-consumer/acquire`, {})

    const res = await fetch(
      `${ctx.serverUrl}/consumers/test-consumer/release`,
      {
        method: "POST",
      }
    )

    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 4: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/consumer-tests.ts
sleep 0.01 && git commit -m "test: add L1 acquire, ack, and release conformance tests"
```

---

### Task 10: Wire Tests into Test Runner and Verify

**Files:**

- Modify: `packages/server/test/conformance.test.ts` (or appropriate test entry point)

- [ ] **Step 1: Import and call consumerTests in the test runner**

Find how existing conformance tests are wired up in `packages/server/test/conformance.test.ts` and add a parallel import for the consumer tests. Follow the same pattern used for other conformance test suites.

The test context needs to provide:

- `serverUrl`: URL of the running test server
- `createStream(path)`: Creates a stream via PUT
- `appendToStream(path, data)`: Appends data via POST, returns the offset

If `createStream` and `appendToStream` helpers do not already exist in the test harness, implement them as HTTP calls:

```typescript
async function createStream(serverUrl: string, path: string): Promise<void> {
  await fetch(`${serverUrl}${path}`, { method: "PUT" })
}

async function appendToStream(
  serverUrl: string,
  path: string,
  data: string
): Promise<string> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: data,
  })
  // Return the offset from the Stream-Next-Offset header (not Stream-Seq, which is an INPUT header for producer sequence numbers)
  return res.headers.get("stream-next-offset") ?? "0"
}
```

- [ ] **Step 1.5: Export consumer tests from the conformance package**

The conformance test runner imports from `@durable-streams/server-conformance-tests`, which resolves to `packages/server-conformance-tests/src/index.ts`. Add the export at the bottom of `index.ts`:

```typescript
export { runConsumerConformanceTests } from "./consumer-tests"
```

Without this, the import in `conformance.test.ts` will fail — the function exists in `consumer-tests.ts` but isn't reachable through the package surface.

- [ ] **Step 2: Run the L1 consumer tests**

Run: `cd /Users/kylemathews/programs/darix && pnpm vitest run --project server 2>&1 | tail -30`
Expected: All L1 consumer tests pass

- [ ] **Step 3: Run ALL tests to verify nothing is broken**

Run: `cd /Users/kylemathews/programs/darix && pnpm test:run 2>&1 | tail -30`
Expected: All tests pass (L1 consumer tests + existing tests)

- [ ] **Step 4: Commit**

```bash
sleep 0.01 && git add packages/server/test/conformance.test.ts
sleep 0.01 && git commit -m "test: wire L1 consumer tests into server conformance runner"
```

---

## Chunk 4: Refactor Webhook System to Use L1

### Task 11: Refactor WebhookManager to Delegate to ConsumerManager

> **Risk note:** This is the highest-risk task in the plan — a stateful system refactoring with ~30 state transitions, timers, and edge cases. Create a checkpoint before starting.

**Files:**

- Modify: `packages/server/src/webhook-manager.ts`
- Modify: `packages/server/src/webhook-store.ts`
- Modify: `packages/server/src/webhook-types.ts`
- Modify: `packages/server/src/server.ts`

- [ ] **Step 0: Create rollback checkpoint**

```bash
sleep 0.01 && git tag pre-l2-refactor
```

- [ ] **Step 0.5: Audit webhook-manager.ts for all consumer state access**

Before changing any code, enumerate every method in `webhook-manager.ts` that reads or writes consumer state fields (`consumer.epoch`, `consumer.state`, `consumer.streams`, `consumer.last_callback_at`). For each, identify the L1 delegation target:

```bash
cd /Users/kylemathews/programs/darix && grep -n "consumer\.\(epoch\|state\|streams\|last_callback_at\|wake_id\)" packages/server/src/webhook-manager.ts
```

Expected method-by-method delegation map:

| WebhookManager method              | Consumer state accessed                                                                                                                                               | L1 delegation target                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeConsumer()`                   | `store.transitionToWaking()` → epoch++, state=WAKING                                                                                                                  | `consumerManager.acquire()`                                                                                                                                                                                       |
| `deliverWebhook()`                 | `consumer.state`, `consumer.wake_id_claimed`, `consumer.last_callback_at`, response body `{done:true}` → auto-ack-to-tail + idle                                      | Wake-specific state stays in L2; epoch/state via `consumerManager`. Synchronous done path: parse response body, if `{done:true}` → `consumerManager.ack()` with all streams at tail + `consumerManager.release()` |
| `handleCallback()`                 | token validation, epoch check, `store.updateAcks()`, `store.claimWakeId()`, `store.subscribeStreams()`, `store.unsubscribeStreams()`, done→idle, done+pending→re-wake | `consumerManager.ack()` for offsets, `consumerManager.release()` for done; wake_id claiming stays L2. After release, check `hasPendingWork()` → immediate `wakeConsumer()` if true                                |
| `resetLivenessTimeout()`           | `consumer.state`, `consumer.liveness_timer`                                                                                                                           | Remove — replaced by L1 lease timer via `consumerManager.onLeaseExpired()`                                                                                                                                        |
| `onStreamAppend()`                 | `consumer.state`, `store.hasPendingWork()`                                                                                                                            | `consumerManager.hasPendingWork()` for pending check; wake trigger stays L2                                                                                                                                       |
| `onStreamCreated()`                | `store.getOrCreateConsumer()`                                                                                                                                         | `consumerManager.registerConsumer()` + L2 `store.getOrCreateWebhookConsumer()`                                                                                                                                    |
| `onStreamCreatedForSubscription()` | same as above                                                                                                                                                         | same                                                                                                                                                                                                              |
| `onStreamDeleted()`                | `store.removeStreamFromConsumers()`                                                                                                                                   | `consumerManager.onStreamDeleted()` + L2 `webhookManager.onStreamDeleted()` (update primary_stream, clean stream index)                                                                                           |
| `shutdown()`                       | `store.shutdown()`, spans                                                                                                                                             | `consumerManager.shutdown()` + L2 cleanup                                                                                                                                                                         |

Verify this map is complete before proceeding. Add any missing methods.

This is the key refactoring. The webhook system (L2) should delegate ALL consumer state operations to `ConsumerManager` (L1). The webhook-specific code should only handle:

- Subscription management (pattern, webhook URL, secret)
- Wake delivery (HTTP POST with HMAC signature)
- Retry scheduling
- Webhook-specific failure tracking (for GC)

**Design note:** The current `ConsumerInstance` type in `webhook-types.ts` bundles L1 state (epoch, streams, state) with L2 state (wake_id, retry_count, webhook failures, timers). After refactoring, the L2 `WebhookConsumer` type wraps an L1 `Consumer` (by reference via consumer_id) and adds only webhook-specific fields.

- [ ] **Step 1: Create a WebhookConsumer type that wraps L1 consumer_id**

In `webhook-types.ts`, replace the `ConsumerInstance` type:

```typescript
/**
 * L2 Webhook-specific consumer state.
 * Consumer identity, epoch, offsets, and liveness are L1 concerns
 * managed by ConsumerManager. This type adds webhook delivery state.
 */
export interface WebhookConsumer {
  consumer_id: string // Reference to L1 consumer
  subscription_id: string
  primary_stream: string
  // Webhook delivery state (L2 only)
  wake_id: string | null
  wake_id_claimed: boolean
  last_webhook_failure_at: number | null
  first_webhook_failure_at: number | null
  retry_count: number
  retry_timer: ReturnType<typeof setTimeout> | null
  // Telemetry
  wake_cycle_span: Span | null
  wake_cycle_ctx: Context | null
}
```

- [ ] **Step 2: Update WebhookStore to use WebhookConsumer**

Replace all `ConsumerInstance` references with `WebhookConsumer`. Remove methods that are now in `ConsumerStore`:

- Remove `transitionToWaking` (epoch management is L1)
- Remove `transitionToIdle` (state management is L1)
- Remove `claimWakeId` (keep — this is L2 wake coordination)
- Remove `updateAcks` (offset management is L1)
- Remove `subscribeStreams` / `unsubscribeStreams` (stream management is L1)
- Remove `hasPendingWork` (L1 concern)
- Remove `getStreamsData` (L1 concern)
- Remove `removeStreamFromConsumers` (L1 concern)

Keep:

- Subscription CRUD (createSubscription, getSubscription, etc.)
- WebhookConsumer CRUD (getOrCreateWebhookConsumer, removeWebhookConsumer)
- `findMatchingSubscriptions` (subscription matching)
- Stream index for mapping stream → webhook consumers (for wake triggers)

- [ ] **Step 3: Update WebhookManager to use ConsumerManager**

Add `ConsumerManager` as a constructor dependency:

```typescript
constructor(opts: {
  callbackBaseUrl: string
  getTailOffset: (path: string) => string
  consumerManager: ConsumerManager
})
```

Refactor key methods:

**`wakeConsumer`**: Instead of `store.transitionToWaking(consumer)`:

```typescript
// Register L1 consumer if needed (idempotent)
const regResult = this.consumerManager.registerConsumer(
  webhookConsumer.consumer_id,
  [...streams]
)
if ("error" in regResult) {
  // CONFIG_MISMATCH: L1 consumer exists with different streams/config.
  // This shouldn't happen in normal operation — means L2 state diverged from L1.
  // Log and bail rather than silently running against stale config.
  console.error(
    `wakeConsumer: L1 config mismatch for ${webhookConsumer.consumer_id}`
  )
  return
}
// Acquire epoch via L1
const acqResult = this.consumerManager.acquire(webhookConsumer.consumer_id)
if ("error" in acqResult) return
// Use L1 epoch and token in webhook payload
```

**`handleCallback`**: Instead of direct store manipulation:

```typescript
// Ack via L1 canonical endpoint
if (request.acks) {
  const ackResult = this.consumerManager.ack(consumerId, token, {
    offsets: request.acks,
  })
  if ("error" in ackResult) return errorResponse(ackResult.error)
}
// Done signal → L1 release + immediate re-wake if work remains
if (request.done) {
  this.consumerManager.release(consumerId, token)
  // Preserve current behavior: done + pending_work => immediate re-wake.
  // Without this, work arriving between the last ack and the done signal
  // would sit stranded until the next append triggers onStreamAppend().
  const webhookConsumer = this.store.getWebhookConsumer(consumerId)
  if (webhookConsumer && this.consumerManager.hasPendingWork(consumerId)) {
    this.wakeConsumer(webhookConsumer, [webhookConsumer.primary_stream])
  }
}
```

**`deliverWebhook` synchronous done path**: The current implementation parses the webhook response body — if it contains `{done:true}`, the server auto-acks all streams to tail and transitions to IDLE. This is a convenience for simple synchronous webhook workers. Preserve this by delegating to L1:

```typescript
// In deliverWebhook(), after successful response:
let resBody: { done?: boolean } | null = null
try {
  resBody = (await response.json()) as { done?: boolean }
} catch {
  // Empty or non-JSON response — fine
}

if (resBody?.done) {
  webhookConsumer.wake_id_claimed = true
  // Auto-ack all streams to tail via L1
  const streams = this.consumerManager.store.getConsumer(
    webhookConsumer.consumer_id
  )
  if (streams) {
    const tailOffsets = Array.from(streams.streams.keys()).map((path) => ({
      path,
      offset: this.consumerManager.getTailOffset(path),
    }))
    if (tailOffsets.length > 0) {
      this.consumerManager.ack(webhookConsumer.consumer_id, token, {
        offsets: tailOffsets,
      })
    }
  }
  // Release via L1 + immediate re-wake if pending
  this.consumerManager.release(webhookConsumer.consumer_id, token)
  if (this.consumerManager.hasPendingWork(webhookConsumer.consumer_id)) {
    this.wakeConsumer(webhookConsumer, [webhookConsumer.primary_stream])
  }
  return
}
```

**Consumer deletion cascade**: Register a delete callback to clean up L2 state when an L1 consumer is deleted:

```typescript
this.consumerManager.onConsumerDeleted((consumerId) => {
  const webhookConsumer = this.store.getWebhookConsumer(consumerId)
  if (webhookConsumer) {
    if (webhookConsumer.retry_timer) clearTimeout(webhookConsumer.retry_timer)
    this.store.removeWebhookConsumer(consumerId)
  }
})
```

**Liveness**: Remove `resetLivenessTimeout` from WebhookManager — L1's lease timer handles this. Instead, register a lease expiry callback with `consumerManager.onLeaseExpired()` to trigger re-wake:

```typescript
this.consumerManager.onLeaseExpired((consumer) => {
  const webhookConsumer = this.store.getWebhookConsumer(consumer.consumer_id)
  if (
    webhookConsumer &&
    this.consumerManager.hasPendingWork(consumer.consumer_id)
  ) {
    this.wakeConsumer(webhookConsumer, [webhookConsumer.primary_stream])
  }
})
```

**Stream deletion in L2**: When L1 handles `onStreamDeleted`, the stream is removed from L1 consumers. But L2 must also update its own state — specifically `primary_stream` and the stream→webhook consumer index. Register a stream-deleted callback or call an L2 method from `onStreamDeleted` in `server.ts`:

```typescript
// In WebhookManager — call this when a stream is deleted
onStreamDeleted(streamPath: string): void {
  // Clean up L2 stream index
  this.store.removeStreamFromIndex(streamPath)

  // Update any webhook consumer whose primary_stream was deleted
  for (const wc of this.store.getAllWebhookConsumers()) {
    if (wc.primary_stream === streamPath) {
      // Get surviving streams from L1
      const l1Consumer = this.consumerManager.store.getConsumer(wc.consumer_id)
      if (!l1Consumer || l1Consumer.streams.size === 0) {
        // L1 consumer was already deleted (no streams left) —
        // onConsumerDeleted callback handles L2 cleanup
        continue
      }
      // Reassign primary_stream to first surviving stream
      wc.primary_stream = l1Consumer.streams.keys().next().value!
    }
  }
}
```

In `server.ts`, call both L1 and L2 on stream deletion:

```typescript
// When a stream is deleted:
this.consumerManager.onStreamDeleted(streamPath)
this.webhookManager?.onStreamDeleted(streamPath)
```

- [ ] **Step 4: Update server.ts to pass ConsumerManager to WebhookManager**

```typescript
this.webhookManager = new WebhookManager({
  callbackBaseUrl: this._url!,
  getTailOffset: (path) => {
    const stream = this.store.get(path)
    return stream ? stream.currentOffset : `-1`
  },
  consumerManager: this.consumerManager!,
})
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Users/kylemathews/programs/darix && pnpm exec tsc --noEmit --project packages/server/tsconfig.json 2>&1 | head -30`
Expected: No errors

- [ ] **Step 6: Run ALL tests**

Run: `cd /Users/kylemathews/programs/darix && pnpm test:run 2>&1 | tail -30`
Expected: All tests pass — L1 consumer tests AND existing webhook tests

- [ ] **Step 7: Commit**

```bash
sleep 0.01 && git add packages/server/src/webhook-manager.ts packages/server/src/webhook-store.ts packages/server/src/webhook-types.ts packages/server/src/server.ts
sleep 0.01 && git commit -m "refactor: webhook system delegates consumer state to L1 ConsumerManager"
```

---

### Task 12: Clean Up — Remove Duplicated Code

**Files:**

- Modify: `packages/server/src/webhook-store.ts`
- Modify: `packages/server/src/webhook-types.ts`

- [ ] **Step 1: Remove now-unused ConsumerInstance type and ConsumerState from webhook-types.ts**

Verify these are no longer imported anywhere:

```bash
cd /Users/kylemathews/programs/darix && grep -r "ConsumerInstance\|ConsumerState" packages/server/src/ --include="*.ts"
```

Remove any dead type definitions and adjust remaining imports.

- [ ] **Step 2: Remove duplicated methods from WebhookStore**

Verify there are no remaining calls to the methods that were moved to ConsumerStore:

```bash
cd /Users/kylemathews/programs/darix && grep -r "store.updateAcks\|store.transitionToWaking\|store.transitionToIdle\|store.hasPendingWork\|store.getStreamsData\|store.subscribeStreams\|store.unsubscribeStreams" packages/server/src/ --include="*.ts"
```

Remove any dead methods.

- [ ] **Step 3: Verify compilation and tests**

Run: `cd /Users/kylemathews/programs/darix && pnpm exec tsc --noEmit --project packages/server/tsconfig.json 2>&1 | head -20`
Run: `cd /Users/kylemathews/programs/darix && pnpm test:run 2>&1 | tail -30`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
sleep 0.01 && git add packages/server/src/webhook-store.ts packages/server/src/webhook-types.ts
sleep 0.01 && git commit -m "refactor: remove L1 consumer code from webhook layer"
```

---

## Chunk 5: Protocol Spec Update

### Task 13: Restructure Protocol and Spec Documents

**Files:**

- Modify: `PROTOCOL.md`
- Modify: `docs/webhook-spec.md`
- Modify: `docs/webhooks-rfc.md`

This task restructures all three documents to reflect the layered architecture.

#### PROTOCOL.md Changes

- [ ] **Step 1: Add new Section 6 header and L1 consumer registration spec**

Replace the current "6. Webhook Subscriptions" header. The new Section 6 documents:

- Consumer registration (`POST /consumers`)
- Consumer state machine (REGISTERED ↔ READING)
- Epoch fencing (`POST /consumers/{id}/acquire`)
- Acknowledgment (`POST /consumers/{id}/ack`)
- Release (`POST /consumers/{id}/release`)
- Liveness policy (lease TTL)

Use the RFC's Layer 1 section as the normative source for the spec language.

- [ ] **Step 2: Add new Section 7 header and refactor webhook spec**

Create "7. Wake-Up Notifications" as a container section. Move the current webhook spec content into "7.1. Webhook" subsection, updating it to reference L1 primitives:

- Subscription model → L2 concern (webhook URL, secret, pattern)
- Wake delivery → L2 concern (HMAC-signed POST)
- Callback API → L2 optimization that delegates to L1 ack
- Consumer lifecycle → reference L1 state machine
- Failure handling → L2 concern (retry, backoff, GC)

Keep sections 7.2 (Pull-Wake) and 7.3 (Mobile Push) as "Future" placeholders per RFC.

- [ ] **Step 3: Renumber subsequent sections**

Current Section 7 (Offsets) → Section 8
Current Section 8 (Content Types) → Section 9
Current Section 9 (Caching and Collapsing) → Section 10
Current Section 10 (Extensibility) → Section 11
Current Section 11 (Security Considerations) → Section 12

Update the Table of Contents to reflect all renumbering.

- [ ] **Step 4: Review for internal consistency**

Verify all cross-references within the document are updated to use new section numbers. Search for references like "Section 6" that should now say "Section 7.1".

#### docs/webhook-spec.md Changes

- [ ] **Step 5: Restructure webhook-spec.md into L1 + L2 spec**

The current `webhook-spec.md` is a complete normative spec for the webhook consumer system. It needs to be split into two documents (or restructured in-place):

**Option A (recommended): Restructure in-place with clear L1/L2 sections**

Add a "Layer Architecture" section at the top explaining the L0/L1/L2 model. Then restructure existing content:

**L1 Consumer Protocol section** — Extract from current spec:

- Consumer registration (new — currently implicit in subscription creation)
- Consumer state machine: REGISTERED ↔ READING (replaces IDLE/WAKING/LIVE which become L2)
- Epoch fencing (currently in "Epoch" section)
- Acknowledgment endpoint (extract from "Callback API")
- Offset semantics (currently in "Offset Semantics")
- Lease-based liveness (extract from "Liveness Timeout")
- Bearer token management (extract from "Callback Tokens")

**L1 Safety Invariants** — Split from current S1-S8:

- S1 (Epoch Monotonicity) → **L1 invariant**: Epoch values for a consumer are strictly increasing
- S4 (Offset Monotonicity) → **L1 invariant**: Acknowledged offsets are monotonically non-decreasing
- S5 (Token Present) → **L1 invariant**: Every successful ack response includes a token
- S6 (Stale Epoch Rejection) → **L1 invariant**: Operations with stale epoch are rejected

**L1 Liveness Properties** (new):

- LP1: Lease expiry causes epoch release (READING → REGISTERED)
- LP2: Both cursor-advancing acks and empty acks reset `last_ack_time` (lease timer)
- LP3: Empty ack is the heartbeat shape — extends lease, no durable cursor write
- LP4: Self-supersede always succeeds in the single-process reference server (no `EPOCH_HELD` contention). The error code is defined but not produced — reserved for future multi-server deployments.

**L2 Webhook section** — Remaining webhook-specific content:

- Subscription model (pattern, webhook URL, secret)
- Consumer instance lifecycle with IDLE/WAKING/LIVE states (L2 layer on top of L1 REGISTERED/READING)
- Wake-up notification (POST with HMAC signature)
- Callback API (as L2 optimization bundling wake claim + ack)
- Wake ID and claiming semantics
- Webhook signature verification
- Retry and failure handling
- Garbage collection

**L2 Safety Invariants** — Remaining from S1-S8:

- S2 (Wake ID Uniqueness) → **L2 invariant**
- S3 (Idempotent Claim) → **L2 invariant**
- S7 (Gone After Delete) → **L2 invariant**
- S8 (Signature Presence) → **L2 invariant**

**L2 Liveness Properties** — Current L1-L3 become L2-specific:

- L1 (Pending Work Causes Wake) → **L2 property**
- L2 (Done Without Pending Reaches IDLE) → **L2 property**
- L3 (Done With Pending Causes Re-wake) → **L2 property**

- [ ] **Step 6: Review webhook-spec.md for consistency with implementation**

Verify the restructured spec matches the refactored implementation. In particular:

- L1 endpoints match `consumer-routes.ts`
- L1 error codes match `consumer-types.ts`
- L2 webhook behavior matches refactored `webhook-manager.ts`

#### docs/webhooks-rfc.md Changes

- [ ] **Step 7: Add superseded note to webhooks-rfc.md**

Add a note at the top of `docs/webhooks-rfc.md`:

```markdown
> **Note:** The webhook system described in this RFC has been implemented and is now
> part of the layered consumer protocol (L0/L1/L2). See [RFC: Layered Consumer Protocol](https://github.com/electric-sql/durable-streams/issues/23)
> for the architecture that separates consumer identity (L1) from webhook wake-up (L2).
> The webhook behavior described here is preserved as Layer 2 Mechanism A.
```

- [ ] **Step 7.5: Document actual vs. ideal layering in the restructured specs**

The implementation preserves two legacy mechanics that the dialectic's synthesis removed:

1. **wake_id claiming**: The dialectic concluded claiming is subsumed by epoch fencing. The implementation keeps `wake_id_claimed` on `WebhookConsumer` for retry idempotency.
2. **Implicit L1 registration from webhook flows**: The dialectic's registration-vs-notification split says L2 should attach to an existing consumer. The implementation still has `WebhookManager` create L1 consumers during subscription creation.

The restructured specs should document the _actual_ achieved separation (L1 provides consumer identity, epoch, ack, lease; L2 provides webhook wake/retry/GC) rather than claiming the full dialectic ideal. Call out these two areas as known compromises where the L1/L2 boundary is not yet clean.

- [ ] **Step 8: Commit all spec changes**

```bash
sleep 0.01 && git add PROTOCOL.md docs/webhook-spec.md docs/webhooks-rfc.md
sleep 0.01 && git commit -m "docs: restructure specs with L1 Named Consumers and L2 Wake-Up Notifications"
```

---

### Task 14: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/kylemathews/programs/darix && pnpm test:run 2>&1 | tail -30`
Expected: ALL tests pass

- [ ] **Step 2: Run TypeScript type check**

Run: `cd /Users/kylemathews/programs/darix && pnpm exec tsc --noEmit --project packages/server/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Verify layer boundary — L1 does not import L2**

Run: `cd /Users/kylemathews/programs/darix && grep -r "webhook" packages/server/src/consumer-types.ts packages/server/src/consumer-store.ts packages/server/src/consumer-manager.ts packages/server/src/consumer-routes.ts`
Expected: No matches. L1 files import from `./crypto` and `./glob` (renamed from `webhook-crypto` and `webhook-glob` in Task 2), not from any `webhook-*` module.

- [ ] **Step 4: Verify L2 delegates to L1 — no direct consumer state manipulation**

Run: `cd /Users/kylemathews/programs/darix && grep -n "consumer\.epoch\|consumer\.state\|consumer\.streams" packages/server/src/webhook-manager.ts`
Expected: No direct mutations of L1 state fields. All access goes through `consumerManager`.
