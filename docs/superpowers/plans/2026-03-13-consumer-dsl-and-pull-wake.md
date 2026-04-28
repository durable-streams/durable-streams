# Consumer DSL & Pull-Wake Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove L1 Named Consumers are mechanism-independent by implementing a second L2 mechanism (Pull-Wake), building a shared consumer testing DSL, and porting all L1 tests to use it.

**Architecture:** Extract a mechanism-independent `ConsumerScenario` DSL from the existing `WebhookScenario`, add a `PullWakeScenario` that exercises L1 via direct HTTP acquire/ack/release, implement server-side pull-wake (wake stream + claim notifications), and run the _same_ invariant checkers across both mechanisms. The existing `consumer-tests.ts` (24 hand-rolled HTTP tests) gets replaced by DSL-driven tests that compose with property-based testing.

**Tech Stack:** TypeScript, Vitest, fast-check, existing Durable Streams server

---

## File Structure

### New Files

| File                                                     | Responsibility                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/server-conformance-tests/src/consumer-dsl.ts`  | Shared L1 consumer testing DSL — fluent builder, history events, L1 invariant checkers, ENABLED predicate model        |
| `packages/server-conformance-tests/src/pull-wake-dsl.ts` | Pull-wake L2 DSL — extends consumer DSL with wake stream reading, claim via acquire, pull-wake-specific history events |
| `packages/server/src/pull-wake-manager.ts`               | Server-side pull-wake L2: writes wake/claimed events to wake stream, hooks into ConsumerManager lifecycle              |

### Modified Files

| File                                                      | Changes                                                                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server-conformance-tests/src/webhook-dsl.ts`    | Extract L1 invariant checkers to consumer-dsl.ts, call shared checkers from `checkInvariants()`                                                                   |
| `packages/server-conformance-tests/src/consumer-tests.ts` | Rewrite 24 tests to use consumer-dsl.ts fluent builder                                                                                                            |
| `packages/server-conformance-tests/src/index.ts`          | Add pull-wake test describe blocks, property-based tests for pull-wake, cross-mechanism test, export new DSL                                                      |
| `packages/server/src/consumer-types.ts`                   | Add `wake_preference` field to `Consumer` type                                                                                                                    |
| `packages/server/src/consumer-store.ts`                   | Store `wake_preference` on registration                                                                                                                           |
| `packages/server/src/consumer-routes.ts`                  | Add `PUT /consumers/{id}/wake` endpoint for setting notification preferences                                                                                      |
| `packages/server/src/consumer-manager.ts`                 | Add `onEpochAcquired`, `onEpochReleased` callbacks; `setWakePreference()` method                                                                                  |
| `packages/server/src/server.ts`                           | Mount PullWakeManager, wire lifecycle callbacks                                                                                                                   |
| `packages/server/src/index.ts`                            | Export PullWakeManager                                                                                                                                            |
| `PROTOCOL.md`                                             | Restructure: add Section 6 (Named Consumers / L1), Section 7 (Wake-Up Notifications / L2), refactor webhooks into 7.1, add pull-wake as 7.2, renumber 7–13 → 8–14 |

---

## Chunk 0: Protocol Specification

### Task 1: Update PROTOCOL.md with Layered Consumer Architecture

**Files:**

- Modify: `PROTOCOL.md` — restructure Section 6, add Sections 6–7, renumber 7–13 → 8–14

The RFC (issue #23) specifies a complete restructuring of PROTOCOL.md. The current Section 6 "Webhook Subscriptions" bundles L1 and L2 concerns. This task separates them into the layered architecture and adds the Pull-Wake spec. All subsequent implementation tasks and tests reference this spec as the normative source.

**Current structure:**

- Sections 1–5: Base protocol (Layer 0) — unchanged
- Section 6: Webhook Subscriptions (bundles L1 + L2/A)
- Sections 7–13: Offsets, Content Types, etc.

**Target structure (per RFC § Spec Structure Changes):**

- Sections 1–5: Unchanged (Layer 0)
- **Section 6: Named Consumers (Layer 1)** — NEW
- **Section 7: Wake-Up Notifications (Layer 2)** — NEW container
- Section 7.1: Webhook — refactored from current Section 6
- Section 7.2: Pull-Wake — NEW
- Section 7.3: Mobile Push — future placeholder
- Sections 8–14: Renumbered from current 7–13

- [ ] **Step 1: Write Section 6 — Named Consumers (Layer 1)**

Add after current Section 5. This is the mechanism-independent consumer protocol layer. Content derives directly from RFC § Layer 1: Named Consumers.

```markdown
## 6. Named Consumers (Layer 1)

Layer 1 adds opt-in server-side consumer identity to the base protocol.
Clients that manage their own offsets continue to use Layer 0 unchanged.

### 6.1. Consumer Registration

POST /consumers
Content-Type: application/json

{
"consumer_id": "order-processor",
"streams": ["/orders/incoming"],
"namespace": "/orders/\*"
}

Response: 201 Created with consumer_id, streams, namespace, state: "REGISTERED"

- consumer_id: unique identifier for this consumer
- streams: explicit stream subscriptions (array of paths)
- namespace: glob pattern for dynamic subscriptions (\* = one segment, \*\* = zero or more)
- When both provided, subscription is the union
- Registration is independent of any Layer 2 wake mechanism

### 6.2. Consumer State Machine

REGISTERED (no epoch held)
→ acquire → READING (epoch N, token T)

READING (epoch N, token T)
→ ack(offset) → READING (cursor advanced, same epoch)
→ re-acquire (same worker) → READING (epoch N+1, new token — self-supersede)
→ release → REGISTERED (epoch released)
→ lease timeout → REGISTERED (epoch released)
→ acquire by different worker → 409 EPOCH_HELD

### 6.3. Epoch Acquisition

POST /consumers/{id}/acquire
Content-Type: application/json

{
"streams": ["/orders/incoming"],
"worker": "worker-7"
}

Success response (200):
{
"consumer_id": "order-processor",
"epoch": 42,
"token": "eyJ...",
"streams": [{ "path": "/orders/incoming", "offset": "1005" }]
}

Contention response (409):
{
"error": "EPOCH_HELD",
"current_epoch": 41,
"holder": "active"
}

- Epoch is per-consumer, covers all subscribed streams
- Epoch monotonically increases
- Same worker re-acquire = self-supersede (crash recovery)
- Different worker while READING = 409 EPOCH_HELD
- Bearer token scoped to consumer_id + epoch

### 6.4. Acknowledgment

POST /consumers/{id}/ack
Authorization: Bearer {epoch-scoped-token}
Content-Type: application/json

{
"offsets": [
{ "path": "/orders/incoming", "offset": "1010" }
]
}

Response: { "ok": true }

Processing:

1. Validate bearer token → extract consumer_id + epoch
2. Validate epoch matches current active epoch
3. Empty offsets → heartbeat: reset last_ack_time, no durable cursor write
4. Verify offset doesn't regress (monotonic advance)
5. Advance stored cursor
6. Persist

- Cumulative cursor commit (not per-message)
- Cannot regress — 409 OFFSET_REGRESSION
- Multi-path ack is atomic
- Offsets are "last processed inclusive"
- Batching: consumers SHOULD batch acks at high throughput
- Ack is always explicit, never piggybacked on reads

Error responses:
| Status | Code | Description |
|--------|--------------------|------------------------------------------------|
| 401 | TOKEN_EXPIRED | Bearer token TTL elapsed |
| 401 | TOKEN_INVALID | Bearer token malformed or signature invalid |
| 409 | STALE_EPOCH | Consumer's epoch has been superseded |
| 409 | OFFSET_REGRESSION | Ack offset < current cursor (includes path) |
| 409 | INVALID_OFFSET | Ack offset > stream tail (includes path) |
| 404 | CONSUMER_NOT_FOUND | Consumer does not exist |

### 6.5. Release

POST /consumers/{id}/release
Authorization: Bearer {epoch-scoped-token}

Response: { "ok": true, "state": "REGISTERED" }

- Transitions READING → REGISTERED
- Invalidates bearer token
- Committed cursor preserved
- If Layer 2 wake configured and pending work, may trigger new wake

### 6.6. Liveness Policy

Lease model: Each consumer has configurable lease_ttl (set at registration).
Epoch released when last_ack_time + lease_ttl exceeded.

- Both cursor-advancing acks and empty acks reset last_ack_time
- Empty acks ({ "offsets": [] }) are the heartbeat shape
- Empty acks MUST NOT force durable cursor write

When liveness lost:

1. Release epoch → READING → REGISTERED
2. Other workers can acquire
3. Consumer NOT deregistered (L1 registration persists)
4. If Layer 2 wake exists, may re-send wake

Layer 2 never mutates Layer 1 state directly. Layer 2 detects liveness loss,
Layer 1 applies the policy (release epoch).

### 6.7. Token Scope

Bearer token is per-consumer, not per-stream. One consumer may ack across
multiple streams in one request. Token authorizes the consumer identity;
epoch validated server-side during ack processing.

Token TTL SHOULD be significantly longer than lease TTL so tokens do not
expire during normal operation.

### 6.8. Named Reads

- Anonymous L0 reads: client-supplied offset is authoritative
- Named L1 reads: server-committed cursor is authoritative
- Acquire returns committed cursor position for each subscribed stream
- Consumer reads from where server says it left off
- Named read with explicit offset MAY be used for debugging
  but MUST NOT advance committed cursor

### 6.9. Registration vs. Notification Preferences

PUT /consumers/{id}/wake
Content-Type: application/json

{ "type": "webhook", "url": "https://my-handler.dev/hook" }
// or
{ "type": "pull-wake", "wake_stream": "/wake/my-workers" }
// or
{ "type": "none" }

Registration (Layer 1) and notification preferences (Layer 2) are separate.
A consumer can be registered without any wake preference (pure pull).
A consumer can change wake mechanisms without re-registering.

> Phase 2 scope: A consumer has exactly one active wake preference at a time.
> The RFC's broader "zero-or-more" model (e.g., webhook AND push simultaneously)
> is deferred to a future phase.
```

- [ ] **Step 2: Write Section 7 — Wake-Up Notifications (Layer 2) container and Section 7.1 Webhook**

Refactor current Section 6 "Webhook Subscriptions" into Section 7.1 under the new Layer 2 container. The webhook section keeps all existing content but is reframed as an L2 mechanism.

```markdown
## 7. Wake-Up Notifications (Layer 2)

Layer 2 is opt-in and requires Layer 1. Each wake mechanism is fully,
concretely specified. No abstract interface.

Two structural categories:

- Unicast wake (webhook, mobile push): server targets specific consumer
- Competitive wake (pull-wake): workers compete to claim from shared stream

### 7.1. Webhook (Unicast Wake)

[Refactor current Section 6 content here, reframed as L2 mechanism]

Webhook is a unicast wake mechanism: the server targets a specific consumer
directly, so there is no competitive contention (unlike pull-wake).

Current implementation:

- Epoch acquisition: the SERVER acquires the L1 epoch (REGISTERED → READING)
  BEFORE sending the webhook. The consumer receives the webhook already in
  READING state with epoch, token, and stream offsets.
- Wake delivery: HMAC-signed POST to consumer's webhook URL, containing
  epoch, token, streams, wake_id, and callback URL. The epoch and token
  are from the server's pre-webhook acquire.
- Wake claiming: consumer responds to callback with { epoch, wake_id }
  to claim the wake. This is an L2 protocol step — it does NOT acquire
  the epoch (already acquired). Server validates wake_id, marks the wake
  as claimed, and extends the L1 lease via heartbeat ack.
  This wake_id claiming protocol is a Phase 1 mechanism. The RFC envisions
  simplifying it to pure epoch fencing in a future phase.
- Ack optimization: callbacks MAY bundle ack payloads
- Liveness: standard L1 lease model (last_ack_time + lease_ttl)
- Failure: backoff, retry, exhaustion marks webhook inactive (L2 only)
- Consumer remains REGISTERED regardless of webhook status (L1 untouched)
- Done signal: { "done": true } via callback → READING → REGISTERED
```

- [ ] **Step 3: Write Section 7.2 — Pull-Wake (Competitive Wake)**

This is the core new spec content for Phase 2. Content derives from RFC § Layer 2 / Mechanism B.

```markdown
### 7.2. Pull-Wake (Competitive Wake)

For worker pool patterns where multiple workers compete to process entities.

> **Phase 2 scope:** Pull-wake consumers are single-stream (one consumer per
> entity stream, e.g., `/users/123` → `user-handler`). Multi-stream pull-wake
> consumers are deferred to a future phase.

#### 7.2.1. Wake Stream

A Durable Stream (Layer 0 self-hosting) serving as notification channel
and coordination log.

Events:
{ "type": "wake", "stream": "/users/123", "consumer": "user-handler" }
{ "type": "claimed", "stream": "/users/123", "worker": "worker-7", "epoch": 42 }

- One event per stream (not arrays)
- Wake events written when REGISTERED consumer has pending data
- Claimed events written after successful epoch acquisition (informational)

#### 7.2.2. Claim Protocol

Control plane / data plane separation:

- Claims go through atomic POST /consumers/{id}/acquire (server authoritative)
- Server writes claimed notification to wake stream after success
- Workers use claimed notifications to skip already-claimed wakes (optimization)
- Worker that misses claimed notification gets 409 from acquire (safe fallback)

Worker flow:

1. Read wake stream via SSE (Layer 0)
2. See wake event with no subsequent claimed event for that stream
3. Call POST /consumers/{consumer_id}/acquire with streams + worker
4. On success: receive epoch + bearer token, server writes claimed event
5. On 409: another worker claimed it, skip and continue reading

#### 7.2.3. Bootstrapping

The wake stream operates at Layer 0 only — no named consumers on the
wake stream, no wake-about-wake. This is the termination condition for
self-hosting recursion (analogous to DNS root servers with hardcoded IPs).

#### 7.2.4. Liveness Detection

Two mechanisms combine:

- SSE connection to wake stream — connection drop means worker is offline
- Epoch lease timeout — processing sessions have TTL extended by ack activity

#### 7.2.5. Contention Handling

| Pattern         | Readers | Contention | Example                       |
| --------------- | ------- | ---------- | ----------------------------- |
| Single consumer | 1       | None       | Desktop app for user entity   |
| Small pool      | 2–5     | Low        | Team workspace handlers       |
| Large pool      | Many    | High       | Batch processing, distributed |

Thundering herd mitigation:

- Random backoff before claim attempt (proportional to known worker count)
- Workers may signal capacity via presence events on wake stream

#### 7.2.6. Failure Handling

- Worker SSE drops → loses access to wake stream
- Worker reconnects, resumes from last wake stream offset
- Active session timeout → epoch released (Layer 1 policy)
```

- [ ] **Step 4: Write Section 7.3 — Mobile Push (placeholder)**

```markdown
### 7.3. Mobile Push (Unicast Wake)

[Future — APNs/FCM integration. See RFC § Layer 2 / Mechanism C.]
```

- [ ] **Step 5: Renumber existing Sections 7–13 → 8–14**

Update all section headers and cross-references:

- Section 7 "Offsets" → Section 8
- Section 8 "Content Types" → Section 9
- Section 9 "Caching and Collapsing" → Section 10
- Section 10 "Extensibility" → Section 11
- Section 11 "Security Considerations" → Section 12 (add epoch-scoped token + wake stream ACL notes from RFC)
- Section 12 "IANA Considerations" → Section 13
- Section 13 "References" → Section 14

Update the Table of Contents to reflect the new structure.

- [ ] **Step 6: Run tests to verify no regressions**

Run: `pnpm vitest run --project server`
Expected: All existing tests pass (spec doc changes don't affect runtime)

- [ ] **Step 7: Commit**

```bash
git add PROTOCOL.md
git commit -m "docs: restructure PROTOCOL.md with layered consumer architecture (L1/L2)

Add Section 6 (Named Consumers / Layer 1) and Section 7 (Wake-Up
Notifications / Layer 2) per RFC #23. Refactor current webhook spec
into Section 7.1, add Pull-Wake spec as Section 7.2."
```

---

## Chunk 1: Consumer DSL — Shared L1 Testing Foundation

### Task 2: Create Consumer DSL with History Events and Fluent Builder

**Files:**

- Create: `packages/server-conformance-tests/src/consumer-dsl.ts`

This is the L1 testing foundation. It follows the exact same architecture as `webhook-dsl.ts` — fluent builder, step queue, run context, history recording — but for mechanism-independent L1 operations.

- [ ] **Step 1: Define L1 history event types**

These are the mechanism-independent events that ANY consumer test records. The webhook DSL's `webhook_received`, `callback_sent`, etc. are L2 events. These are L1:

```typescript
/**
 * Consumer Testing DSL — mechanism-independent L1 fluent builder,
 * history recorder, and invariant checkers.
 *
 * Usage:
 *   await consumer(baseUrl)
 *     .register('my-consumer', ['/stream-1'])
 *     .stream('/stream-1')
 *     .append('event-1')
 *     .acquire()
 *     .ack('/stream-1', '$latest')
 *     .release()
 *     .run()
 */

import { expect } from "vitest"
import { STREAM_OFFSET_HEADER } from "@durable-streams/client"

// ============================================================================
// History Event Types — L1 (mechanism-independent)
// ============================================================================

export type L1HistoryEvent =
  | { type: `stream_created`; path: string }
  | { type: `stream_deleted`; path: string }
  | {
      type: `events_appended`
      path: string
      count: number
      offset: string
    }
  | {
      type: `consumer_registered`
      consumer_id: string
      streams: Array<string>
      created: boolean
      lease_ttl_ms?: number
    }
  | { type: `consumer_deleted`; consumer_id: string }
  | {
      type: `consumer_info`
      consumer_id: string
      state: string
      epoch: number
      streams: Array<StreamInfo>
    }
  | {
      type: `epoch_acquired`
      consumer_id: string
      epoch: number
      token: string
      streams: Array<StreamInfo>
    }
  | {
      type: `epoch_acquire_failed`
      consumer_id: string
      status: number
      error: { code: string; message: string }
    }
  | {
      type: `ack_sent`
      consumer_id: string
      token: string
      offsets: Array<AckInfo>
    }
  | {
      type: `ack_response`
      ok: boolean
      status: number
      token?: string
      error?: { code: string; message: string; path?: string }
    }
  | {
      type: `release_sent`
      consumer_id: string
      token: string
    }
  | {
      type: `release_response`
      ok: boolean
      status: number
      state?: string
    }

export interface StreamInfo {
  path: string
  offset: string
}

export interface AckInfo {
  path: string
  offset: string
}
```

- [ ] **Step 2: Define step types and run context**

```typescript
// ============================================================================
// Step Types
// ============================================================================

type Step =
  | { kind: `stream`; path: string }
  | { kind: `append`; path: string | null; data: unknown }
  | { kind: `appendTo`; path: string; data: unknown }
  | {
      kind: `register`
      consumerId: string
      streams: Array<string>
      leaseTtlMs?: number
    }
  | { kind: `deleteConsumer`; consumerId: string }
  | { kind: `getConsumer`; consumerId: string }
  | { kind: `acquire`; consumerId?: string }
  | { kind: `ack`; path: string; offset: string }
  | { kind: `ackLatest` }
  | { kind: `ackAll` }
  | { kind: `heartbeat` }
  | { kind: `release`; consumerId?: string }
  | { kind: `wait`; ms: number }
  | { kind: `deleteStream`; path: string }
  | { kind: `expectState`; state: string }
  | { kind: `expectAcquireError`; code: string; status?: number }
  | { kind: `expectAckError`; code: string; status?: number }
  | { kind: `expectStreams`; paths: Array<string> }
  | { kind: `expectOffset`; path: string; offset: string }
  | { kind: `custom`; fn: (ctx: ConsumerRunContext) => Promise<void> }

// ============================================================================
// Run Context — mutable state during execution
// ============================================================================

export interface ConsumerRunContext {
  baseUrl: string
  history: Array<L1HistoryEvent>

  // Current consumer
  consumerId: string | null
  currentToken: string | null
  currentEpoch: number | null

  // Current stream (last created or appended to)
  currentStream: string | null

  // Track latest offsets per stream (from appends)
  tailOffsets: Map<string, string>

  // Last HTTP result (for assertions)
  lastResult: { status: number; body: Record<string, unknown> } | null
}
```

- [ ] **Step 3: Implement the fluent builder class**

```typescript
// ============================================================================
// ConsumerScenario — Fluent builder
// ============================================================================

export class ConsumerScenario {
  private baseUrl: string
  protected steps: Array<Step> = []
  private _skipInvariants = false

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  // --- Setup ---

  stream(path: string): this {
    this.steps.push({ kind: `stream`, path })
    return this
  }

  streams(paths: Array<string>): this {
    for (const p of paths) this.steps.push({ kind: `stream`, path: p })
    return this
  }

  // --- L1 Consumer Operations ---

  register(
    consumerId: string,
    streams: Array<string>,
    leaseTtlMs?: number
  ): this {
    this.steps.push({ kind: `register`, consumerId, streams, leaseTtlMs })
    return this
  }

  deleteConsumer(consumerId?: string): this {
    this.steps.push({ kind: `deleteConsumer`, consumerId: consumerId ?? `` })
    return this
  }

  getConsumer(consumerId?: string): this {
    this.steps.push({ kind: `getConsumer`, consumerId: consumerId ?? `` })
    return this
  }

  acquire(consumerId?: string): this {
    this.steps.push({ kind: `acquire`, consumerId })
    return this
  }

  ack(path: string, offset: string): this {
    this.steps.push({ kind: `ack`, path, offset })
    return this
  }

  ackLatest(): this {
    this.steps.push({ kind: `ackLatest` })
    return this
  }

  ackAll(): this {
    this.steps.push({ kind: `ackAll` })
    return this
  }

  heartbeat(): this {
    this.steps.push({ kind: `heartbeat` })
    return this
  }

  release(consumerId?: string): this {
    this.steps.push({ kind: `release`, consumerId })
    return this
  }

  // --- L0 Operations ---

  append(data: unknown): this {
    this.steps.push({ kind: `append`, path: null, data })
    return this
  }

  appendTo(path: string, data: unknown): this {
    this.steps.push({ kind: `appendTo`, path, data })
    return this
  }

  wait(ms: number): this {
    this.steps.push({ kind: `wait`, ms })
    return this
  }

  deleteStream(path: string): this {
    this.steps.push({ kind: `deleteStream`, path })
    return this
  }

  // --- Assertions ---

  expectState(state: string): this {
    this.steps.push({ kind: `expectState`, state })
    return this
  }

  expectAcquireError(code: string, status?: number): this {
    this.steps.push({ kind: `expectAcquireError`, code, status })
    return this
  }

  expectAckError(code: string, status?: number): this {
    this.steps.push({ kind: `expectAckError`, code, status })
    return this
  }

  expectStreams(paths: Array<string>): this {
    this.steps.push({ kind: `expectStreams`, paths })
    return this
  }

  expectOffset(path: string, offset: string): this {
    this.steps.push({ kind: `expectOffset`, path, offset })
    return this
  }

  // --- Custom step ---

  custom(fn: (ctx: ConsumerRunContext) => Promise<void>): this {
    this.steps.push({ kind: `custom`, fn })
    return this
  }

  // --- Config ---

  skipInvariants(): this {
    this._skipInvariants = true
    return this
  }

  // --- Execute ---

  async run(): Promise<Array<L1HistoryEvent>> {
    const ctx: ConsumerRunContext = {
      baseUrl: this.baseUrl,
      history: [],
      consumerId: null,
      currentToken: null,
      currentEpoch: null,
      currentStream: null,
      tailOffsets: new Map(),
      lastResult: null,
    }

    for (const step of this.steps) {
      await executeConsumerStep(ctx, step)
    }

    if (!this._skipInvariants) {
      checkL1Invariants(ctx.history)
    }

    return ctx.history
  }
}
```

- [ ] **Step 4: Implement the step executor**

Implement `executeConsumerStep()` — handles each step kind by making the appropriate HTTP call to the server and recording history events. Follow the exact pattern of `executeStep()` in `webhook-dsl.ts`. Key implementation notes:

- `register` → `POST /consumers` with `{ consumer_id, streams, lease_ttl_ms? }`
- `acquire` → `POST /consumers/{id}/acquire`
- `ack` → `POST /consumers/{id}/ack` with `Authorization: Bearer {token}`
- `heartbeat` → `POST /consumers/{id}/ack` with `{ offsets: [] }`
- `release` → `POST /consumers/{id}/release` with `Authorization: Bearer {token}`
- `ackAll` → ack all streams at their tail offset (from `tailOffsets` map)
- `ackLatest` → ack only the current stream at its latest appended offset
- `$latest` as a special offset string in `ack()` → replaced with the actual tail offset from `tailOffsets`
- `getConsumer` → `GET /consumers/{id}`, records `consumer_info` history event
- `expectState` → reads last `consumer_info` or does a GET and checks state
- `expectAcquireError` / `expectAckError` → checks `lastResult`
- `expectOffset` → GET consumer info, find stream, assert offset

For acquire: if acquire succeeds, set `ctx.currentToken`, `ctx.currentEpoch`, `ctx.consumerId`. If it fails, record `epoch_acquire_failed` and set `ctx.lastResult` (don't throw — let `expectAcquireError` assert).

For ack: similar — if fails, record error in `ack_response` and set `ctx.lastResult`. Only throw if there's no `expectAckError` step following.

The challenge is distinguishing "expected failure" from "unexpected failure" in the step queue. The pattern from `webhook-dsl.ts` is: steps that can fail set `lastResult`, assertion steps check `lastResult`. So:

- `acquire` always calls the endpoint. On success, updates context. On failure, only sets `lastResult` (doesn't throw).
- `ack` / `heartbeat` same pattern.
- If the test expects success (no `expectAcquireError` following), the step itself should assert 200.

Actually, to keep it simpler and match the webhook-dsl pattern: make `acquire` always assert success by default. Add a separate `tryAcquire()` step that doesn't assert and lets `expectAcquireError` check. Same for `tryAck()`.

Revised step types — add:

```typescript
  | { kind: `tryAcquire`; consumerId?: string }
  | { kind: `tryAck`; offsets: Array<AckInfo> }
  | { kind: `tryRelease`; consumerId?: string }
```

Builder methods:

```typescript
  tryAcquire(consumerId?: string): this {
    this.steps.push({ kind: `tryAcquire`, consumerId })
    return this
  }

  tryAck(offsets: Array<AckInfo>): this {
    this.steps.push({ kind: `tryAck`, offsets })
    return this
  }

  tryRelease(consumerId?: string): this {
    this.steps.push({ kind: `tryRelease`, consumerId })
    return this
  }
```

- [ ] **Step 5: Implement the postJson helper and factory function**

```typescript
async function postJson(
  url: string,
  body: object,
  token?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": `application/json` }
  if (token) headers[`authorization`] = `Bearer ${token}`
  const res = await fetch(url, {
    method: `POST`,
    headers,
    body: JSON.stringify(body),
  })
  const resBody = (await res.json().catch(() => ({}))) as Record<
    string,
    unknown
  >
  return { status: res.status, body: resBody }
}

// ============================================================================
// Public factory
// ============================================================================

export function consumer(baseUrl: string): ConsumerScenario {
  return new ConsumerScenario(baseUrl)
}
```

- [ ] **Step 6: Compile and fix any type errors**

Run: `pnpm exec tsc --noEmit --project packages/server-conformance-tests/tsconfig.json 2>&1 | head -20`
Expected: Clean compile (or only pre-existing errors from other packages)

- [ ] **Step 7: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/consumer-dsl.ts
sleep 0.01 && git commit -m "feat: add L1 consumer testing DSL with fluent builder and history events"
```

---

### Task 3: Add L1 Invariant Checkers to Consumer DSL

**Files:**

- Modify: `packages/server-conformance-tests/src/consumer-dsl.ts`

Extract the mechanism-independent invariant checkers. These check properties that must hold regardless of whether the consumer was woken by webhook, pull-wake, or pure pull.

- [ ] **Step 1: Implement L1 invariant checkers**

Add to the bottom of `consumer-dsl.ts`:

```typescript
// ============================================================================
// Checker Metadata (per configurancy skill §5.5, §12.5)
// ============================================================================

/**
 * Each invariant checker declares its soundness and completeness so CI/CD
 * can trust results and future agents know checker limitations.
 */
export interface CheckerMetadata {
  /** No false positives: if checker flags a violation, it IS a violation */
  soundness: `complete` | `partial`
  /** Coverage: does the checker find ALL violations of this property in the trace? */
  completeness: `exhaustive` | `conditional` | `sampled`
  /** When completeness is conditional, what must the trace contain? */
  preconditions?: Array<string>
  description: string
}

// ============================================================================
// L1 Invariant Checkers
// ============================================================================

export const L1_CHECKER_METADATA: Record<string, CheckerMetadata> = {
  checkEpochMonotonicity: {
    soundness: `complete`,
    completeness: `exhaustive`,
    description: `Epochs for a consumer are strictly increasing across all epoch_acquired events`,
  },
  checkAckMonotonicity: {
    soundness: `complete`,
    completeness: `exhaustive`,
    description: `Acknowledged offsets per (consumer, stream) pair never regress`,
  },
  checkAcquireTokenPresent: {
    soundness: `complete`,
    completeness: `exhaustive`,
    description: `Every successful epoch_acquired event includes a non-empty token`,
  },
  checkStaleEpochRejection: {
    soundness: `complete`,
    completeness: `conditional`,
    preconditions: [
      `trace must contain an ack_sent with a stale (non-active) token`,
    ],
    description: `Acks using a superseded token are rejected (requires trace to include stale-token attempt)`,
  },
  checkHeartbeatPreservesCursor: {
    soundness: `complete`,
    completeness: `conditional`,
    preconditions: [
      `trace must contain a consumer_info event between a confirmed heartbeat and the next ack_sent for that consumer`,
    ],
    description: `Empty acks (heartbeats) are no-ops on the durable cursor — verified by checking consumer_info snapshots between heartbeat and next ack are unchanged from the pre-heartbeat cursor (seeded from epoch_acquired)`,
  },
}

export function checkL1Invariants(history: Array<L1HistoryEvent>): void {
  checkEpochMonotonicity(history)
  checkAckMonotonicity(history)
  checkAcquireTokenPresent(history)
  checkStaleEpochRejection(history)
  checkHeartbeatPreservesCursor(history)
}

/**
 * S1 (L1): Epoch values for a consumer are strictly increasing.
 * Every epoch_acquired for the same consumer_id must have a higher epoch
 * than the previous one.
 */
function checkEpochMonotonicity(history: Array<L1HistoryEvent>): void {
  const epochsByConsumer = new Map<string, Array<number>>()
  for (const event of history) {
    if (event.type === `epoch_acquired`) {
      const epochs = epochsByConsumer.get(event.consumer_id) ?? []
      epochs.push(event.epoch)
      epochsByConsumer.set(event.consumer_id, epochs)
    }
  }
  for (const [consumerId, epochs] of epochsByConsumer) {
    for (let i = 1; i < epochs.length; i++) {
      expect(
        epochs[i],
        `S1/L1: Epoch must increase for consumer ${consumerId}: ${epochs[i - 1]} → ${epochs[i]}`
      ).toBeGreaterThan(epochs[i - 1]!)
    }
  }
}

/**
 * S4 (L1): Acknowledged offsets per (consumer, stream) pair are monotonically non-decreasing.
 * A successful ack with an offset less than a previously acked offset is a violation.
 * Keyed by (consumer_id, path) — not path alone — because two independent consumers
 * can ack the same stream at different offsets without violating monotonicity.
 */
function checkAckMonotonicity(history: Array<L1HistoryEvent>): void {
  const lastAckByConsumerStream = new Map<string, string>()

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!
    if (event.type !== `ack_sent`) continue

    const next = history[i + 1]
    if (!next || next.type !== `ack_response` || !next.ok) continue

    for (const ack of event.offsets) {
      const key = `${event.consumer_id}:${ack.path}`
      const prev = lastAckByConsumerStream.get(key)
      if (prev !== undefined && ack.offset < prev) {
        throw new Error(
          `S4/L1: ack for ${event.consumer_id}:${ack.path} went backwards: ${prev} → ${ack.offset}`
        )
      }
      lastAckByConsumerStream.set(key, ack.offset)
    }
  }
}

/**
 * S5 (L1): Every successful epoch acquisition includes a token.
 * Per RFC, the canonical ack response is { "ok": true } — no token required.
 * Token presence in ack responses is an implementation-specific optimization
 * (token refresh), not an L1 invariant. Keep that check in the webhook DSL
 * where the implementation provides it.
 */
function checkAcquireTokenPresent(history: Array<L1HistoryEvent>): void {
  for (const event of history) {
    if (event.type === `epoch_acquired`) {
      expect(
        event.token,
        `S5/L1: epoch_acquired must include token`
      ).toBeTruthy()
    }
  }
}

/**
 * S6 (L1): After a new epoch is acquired, acks with the old token are rejected.
 * Look for patterns: epoch_acquired(N) → epoch_acquired(N+1) → ack_sent(old_token) → ack_response(error)
 */
function checkStaleEpochRejection(history: Array<L1HistoryEvent>): void {
  // Collect all tokens issued per consumer
  const activeTokenByConsumer = new Map<string, string>()

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!
    if (event.type === `epoch_acquired`) {
      activeTokenByConsumer.set(event.consumer_id, event.token)
    }
    if (event.type === `ack_sent`) {
      const activeToken = activeTokenByConsumer.get(event.consumer_id)
      if (activeToken && event.token !== activeToken) {
        // Using a stale token — the next response MUST be an error
        const next = history[i + 1]
        if (next && next.type === `ack_response`) {
          expect(next.ok, `S6/L1: ack with stale token must be rejected`).toBe(
            false
          )
        }
      }
    }
  }
}
```

- [ ] **Step 2: Add ENABLED predicate and consumer state model**

```typescript
// ============================================================================
// ENABLED Predicate & Consumer State Model
// ============================================================================

export type ConsumerAction =
  | `append`
  | `ack`
  | `heartbeat`
  | `acquire`
  | `release`

export interface L1ConsumerModel {
  state: `REGISTERED` | `READING`
  hasUnackedEvents: boolean
  appendCount: number
}

export function enabledConsumerActions(
  state: L1ConsumerModel
): Array<ConsumerAction> {
  const enabled: Array<ConsumerAction> = [`append`]
  if (state.state === `REGISTERED`) enabled.push(`acquire`)
  if (state.state === `READING`) {
    enabled.push(`heartbeat`, `release`)
    if (state.hasUnackedEvents) enabled.push(`ack`)
  }
  return enabled
}

export function applyConsumerAction(
  state: L1ConsumerModel,
  action: ConsumerAction
): L1ConsumerModel {
  switch (action) {
    case `append`:
      return {
        ...state,
        hasUnackedEvents: true,
        appendCount: state.appendCount + 1,
      }
    case `ack`:
      return { ...state, hasUnackedEvents: false }
    case `heartbeat`:
      return state
    case `acquire`:
      return { ...state, state: `READING` }
    case `release`:
      return { ...state, state: `REGISTERED` }
  }
}
```

- [ ] **Step 3: Add L1 liveness property checkers**

```typescript
// ============================================================================
// L1 Liveness Property Checkers
// ============================================================================

/**
 * LP1: Lease expiry causes epoch release (READING → REGISTERED).
 * After a lease expires, the next consumer_info query must show REGISTERED.
 *
 * This is verified by tests that explicitly wait for the TTL, but
 * we can also check the trace: if we see a consumer_info with state=REGISTERED
 * after epoch_acquired (without an intervening release_sent), lease expired.
 */
// LP1 is tested explicitly in lease TTL tests — difficult to check via trace alone

/**
 * LP2: Both cursor-advancing acks and empty acks reset last_ack_time.
 * Verified by the heartbeat-extends-lease test.
 */
// LP2 is tested explicitly

/**
 * LP3: Empty ack is the heartbeat shape — no durable cursor write.
 * After a heartbeat (ack with empty offsets), the consumer's stream offsets
 * must not change.
 */
export function checkHeartbeatPreservesCursor(
  history: Array<L1HistoryEvent>
): void {
  // LP3: Empty acks (heartbeats) extend the lease without writing a
  // durable cursor. The ONLY claim is that the heartbeat itself is a
  // no-op on the cursor. Subsequent non-empty acks MAY advance the
  // cursor freely — even for pre-existing work appended before the
  // heartbeat. Those are normal acks, not heartbeat side effects.
  //
  // Check: for every confirmed heartbeat (empty ack_sent → ack_response ok),
  // the confirmed cursor immediately before and after must be identical.

  // Confirmed cursor: consumer_id → stream_path → offset
  // Updated only on ack_sent(non-empty) → ack_response(ok) pairs
  const confirmedCursor = new Map<string, Map<string, string>>()

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!

    // Seed cursor from epoch_acquired (initial cursor position from acquire).
    // Without this, a heartbeat before the first ack would have an empty
    // snapshot, and a buggy cursor advance from the initial position would
    // be missed.
    if (event.type === `epoch_acquired` && event.streams) {
      if (!confirmedCursor.has(event.consumer_id)) {
        confirmedCursor.set(event.consumer_id, new Map())
      }
      const cursors = confirmedCursor.get(event.consumer_id)!
      for (const { path, offset } of event.streams) {
        cursors.set(path, offset)
      }
    }

    // Update confirmed cursor on successful non-empty ack pairs
    if (event.type === `ack_sent` && event.offsets.length > 0) {
      const resp = history[i + 1]
      if (resp?.type === `ack_response` && resp.ok) {
        if (!confirmedCursor.has(event.consumer_id)) {
          confirmedCursor.set(event.consumer_id, new Map())
        }
        const cursors = confirmedCursor.get(event.consumer_id)!
        for (const { path, offset } of event.offsets) {
          cursors.set(path, offset)
        }
      }
    }

    // Detect confirmed heartbeat: empty ack_sent → ack_response(ok)
    if (event.type === `ack_sent` && event.offsets.length === 0) {
      const resp = history[i + 1]
      if (resp?.type === `ack_response` && resp.ok) {
        const hbConsumer = event.consumer_id

        // Snapshot cursor before heartbeat
        const cursorBefore = new Map(
          confirmedCursor.get(hbConsumer) ?? new Map()
        )

        // The heartbeat (empty ack) should not change the cursor.
        // Since confirmedCursor is only updated by non-empty ack pairs,
        // and a heartbeat is an empty ack, the cursor map is unchanged
        // by definition — unless the server incorrectly writes a cursor
        // on empty ack. We verify this by checking: after the heartbeat's
        // ack_response, before any subsequent non-empty ack, if we could
        // observe the cursor (via consumer_info events if present), it
        // must match cursorBefore.
        //
        // In practice, LP3 is primarily enforced by the direct scenario
        // test (heartbeat does not advance cursor) which calls GET
        // /consumers/{id} before and after. This trace-level checker
        // provides defense-in-depth: if a consumer_info event appears
        // in the trace between the heartbeat and the next non-empty ack,
        // its offsets must match cursorBefore.
        for (let j = i + 2; j < history.length; j++) {
          const future = history[j]!

          // If we see a consumer_info snapshot, verify cursor unchanged
          if (
            future.type === `consumer_info` &&
            future.consumer_id === hbConsumer
          ) {
            for (const { path, offset } of future.streams) {
              const before = cursorBefore.get(path)
              if (before && offset !== before) {
                throw new Error(
                  `LP3: Heartbeat for '${hbConsumer}' at index ${i} changed ` +
                    `cursor on '${path}' (${before} → ${offset})`
                )
              }
            }
          }

          // Stop scanning at the next ack_sent for this consumer
          // (non-empty ack or another heartbeat — either way, new state)
          if (future.type === `ack_sent` && future.consumer_id === hbConsumer) {
            break
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/consumer-dsl.ts
sleep 0.01 && git commit -m "feat: add L1 invariant checkers and ENABLED predicate model to consumer DSL"
```

---

### Task 4: Port L1 Consumer Tests to DSL

**Files:**

- Modify: `packages/server-conformance-tests/src/consumer-tests.ts`
- Modify: `packages/server-conformance-tests/src/index.ts`

Replace the 24 hand-rolled HTTP tests with DSL-driven tests. The DSL tests should be shorter, more readable, and automatically run invariant checkers.

- [ ] **Step 1: Rewrite consumer-tests.ts to use consumer DSL**

Replace the entire file. The new tests use the fluent builder. Group by the same describe blocks. Each test becomes a single fluent chain.

```typescript
/**
 * Layer 1 Consumer Protocol conformance tests — DSL-driven.
 * Tests the consumer lifecycle: register, acquire, ack, release.
 */

import { describe, expect, it } from "vitest"
import { consumer } from "./consumer-dsl"
import type { ConsumerRunContext } from "./consumer-dsl"

export interface ConsumerTestContext {
  serverUrl: string
}

let _testCounter = 0
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_testCounter}`
}

export function runConsumerConformanceTests(
  getCtx: () => ConsumerTestContext
): void {
  describe(`L1: Named Consumers`, () => {
    // Helper: get base URL
    const url = () => getCtx().serverUrl

    describe(`Registration`, () => {
      it(`registers a new consumer`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .getConsumer(c)
          .expectState(`REGISTERED`)
          .run()
      })

      it(`idempotent registration`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .register(c, [s]) // second registration is idempotent
          .run()
      })

      it(`GET returns consumer info`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .getConsumer(c)
          .expectState(`REGISTERED`)
          .run()
      })

      it(`GET returns 404 for unknown consumer`, async () => {
        await consumer(url())
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/nonexistent`)
            expect(res.status).toBe(404)
          })
          .skipInvariants()
          .run()
      })

      it(`DELETE removes consumer`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .deleteConsumer(c)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}`)
            expect(res.status).toBe(404)
          })
          .skipInvariants()
          .run()
      })
    })

    describe(`Epoch Acquisition`, () => {
      it(`acquires epoch and returns token`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .run()
      })

      it(`transitions consumer to READING state`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .getConsumer(c)
          .expectState(`READING`)
          .run()
      })

      it(`self-supersede increments epoch`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c) // epoch 1
          .acquire(c) // epoch 2 (self-supersede)
          .custom(async (ctx) => {
            expect(ctx.currentEpoch).toBe(2)
          })
          .run()
      })

      it(`returns 404 for unknown consumer`, async () => {
        await consumer(url())
          .tryAcquire(`nonexistent`)
          .expectAcquireError(`CONSUMER_NOT_FOUND`, 404)
          .skipInvariants()
          .run()
      })
    })

    describe(`Acknowledgment`, () => {
      it(`acks offsets successfully`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .ackLatest()
          .run()
      })

      it(`empty ack acts as heartbeat`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .heartbeat()
          .run()
      })

      it(`heartbeat does not advance cursor (LP3)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .ackLatest()
          // Cursor is now at event-1's offset
          .custom(async (ctx) => {
            // Capture cursor before heartbeat
            const info1 = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            const cursorBefore = info1.streams[0].offset

            // Heartbeat (empty ack)
            const hbRes = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [] }),
            })
            expect(hbRes.status).toBe(200)

            // Cursor must be unchanged after heartbeat
            const info2 = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            expect(info2.streams[0].offset).toBe(cursorBefore)
          })
          .run()
      })

      it(`heartbeat between two acks does not interfere with cursor (LP3 boundary)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        // Capture per-event offsets from DSL's tailOffsets (updated on
        // each appendTo from the Stream-Next-Offset response header).
        let offset1: string
        let offset2: string
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .custom(async (ctx) => {
            offset1 = ctx.tailOffsets.get(s)!
          })
          .appendTo(s, `event-2`)
          .custom(async (ctx) => {
            offset2 = ctx.tailOffsets.get(s)!
          })
          .register(c, [s])
          .acquire(c)
          .custom(async (ctx) => {
            expect(offset2 > offset1).toBe(true)

            // Partial ack: only event-1 (event-2 is pre-existing pending work)
            const ackRes = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [{ path: s, offset: offset1 }] }),
            })
            expect(ackRes.status).toBe(200)
            const ackBody = await ackRes.json()
            if (ackBody.token) ctx.currentToken = ackBody.token

            // Verify cursor at event-1
            const info1 = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            expect(info1.streams[0].offset).toBe(offset1)

            // Heartbeat (empty ack — must not change cursor)
            const hbRes = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [] }),
            })
            expect(hbRes.status).toBe(200)
            const hbBody = await hbRes.json()
            if (hbBody.token) ctx.currentToken = hbBody.token

            // Cursor must still be at event-1
            const info2 = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            expect(info2.streams[0].offset).toBe(offset1)

            // Ack event-2 (pre-existing work — no new appends needed after heartbeat)
            const ack2Res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [{ path: s, offset: offset2 }] }),
            })
            expect(ack2Res.status).toBe(200)

            // Cursor should advance to event-2
            const info3 = await (
              await fetch(`${ctx.baseUrl}/consumers/${c}`)
            ).json()
            expect(info3.streams[0].offset).toBe(offset2)
          })
          .run()
      })

      it(`rejects ack without bearer token`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: { "content-type": `application/json` },
              body: JSON.stringify({ offsets: [] }),
            })
            expect(res.status).toBe(401)
          })
          .skipInvariants()
          .run()
      })

      it(`rejects ack when REGISTERED (not READING)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .release(c)
          .custom(async (ctx) => {
            // Try to ack with old token — consumer is REGISTERED
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [] }),
            })
            expect(res.status).toBe(409)
          })
          .skipInvariants()
          .run()
      })
    })

    describe(`Error Cases`, () => {
      it(`rejects ack with stale epoch token (STALE_EPOCH)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        let oldToken: string
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .custom(async (ctx) => {
            oldToken = ctx.currentToken!
          })
          .acquire(c) // self-supersede invalidates old token
          .custom(async (ctx) => {
            // Try ack with old token
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${oldToken}`,
              },
              body: JSON.stringify({ offsets: [] }),
            })
            expect(res.status).toBe(409)
            const body = await res.json()
            expect(body.error.code).toBe(`STALE_EPOCH`)
          })
          .skipInvariants()
          .run()
      })

      it(`rejects ack with regressing offset (OFFSET_REGRESSION)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .appendTo(s, `event-2`)
          .register(c, [s])
          .acquire(c)
          .ackAll() // ack to latest (event-2)
          .custom(async (ctx) => {
            // Find offset of event-1 from history
            const appends = ctx.history.filter(
              (e) => e.type === `events_appended` && e.path === s
            )
            const offset1 = (appends[0] as any).offset

            // Try to ack with earlier offset (regression)
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({ offsets: [{ path: s, offset: offset1 }] }),
            })
            expect(res.status).toBe(409)
            const body = await res.json()
            expect(body.error.code).toBe(`OFFSET_REGRESSION`)
          })
          .skipInvariants()
          .run()
      })

      it(`rejects ack beyond stream tail (INVALID_OFFSET)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .tryAck([{ path: s, offset: `9999999999999999_9999999999999999` }])
          .expectAckError(`INVALID_OFFSET`, 409)
          .run()
      })

      it(`rejects ack for unknown stream (UNKNOWN_STREAM)`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .tryAck([
            {
              path: `/test/nonexistent`,
              offset: `0000000000000001_0000000000000001`,
            },
          ])
          .expectAckError(`UNKNOWN_STREAM`, 400)
          .run()
      })
    })

    describe(`Lease TTL`, () => {
      it(`releases epoch after lease TTL expires`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s], 100) // 100ms lease
          .acquire(c)
          .getConsumer(c)
          .expectState(`READING`)
          .wait(200)
          .getConsumer(c)
          .expectState(`REGISTERED`)
          .run()
      })

      it(`empty ack (heartbeat) extends the lease`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s], 150) // 150ms lease
          .acquire(c)
          .wait(100)
          .heartbeat() // extends lease
          .wait(100)
          .getConsumer(c)
          .expectState(`READING`) // still alive
          .run()
      })
    })

    describe(`Multi-Stream Consumers`, () => {
      it(`tracks offsets independently across streams`, async () => {
        const sA = `/test/${uid(`stream-a`)}`
        const sB = `/test/${uid(`stream-b`)}`
        const c = uid(`multi-consumer`)
        await consumer(url())
          .stream(sA)
          .stream(sB)
          .appendTo(sA, `event-a`)
          .register(c, [sA, sB])
          .acquire(c)
          .ack(sA, `$latest`)
          .release(c)
          .acquire(c) // re-acquire — stream-a should be at offsetA
          .expectOffset(sA, `$latest`)
          .run()
      })

      it(`atomic ack: regression on one stream rejects entire batch`, async () => {
        const sA = `/test/${uid(`stream-a`)}`
        const sB = `/test/${uid(`stream-b`)}`
        const c = uid(`atomic-consumer`)
        await consumer(url())
          .stream(sA)
          .stream(sB)
          .appendTo(sA, `a2`)
          .appendTo(sB, `b1`)
          .appendTo(sB, `b2`)
          .register(c, [sA, sB])
          .acquire(c)
          .ackAll() // ack both to latest
          .appendTo(sA, `a3`)
          .custom(async (ctx) => {
            // Get offset of b1 (first append to sB) from history
            const bAppends = ctx.history.filter(
              (e) => e.type === `events_appended` && e.path === sB
            )
            const offsetB1 = (bAppends[0] as any).offset
            const offsetA3 = ctx.tailOffsets.get(sA)!

            // Ack stream-a forward but stream-b backward
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
              method: `POST`,
              headers: {
                "content-type": `application/json`,
                authorization: `Bearer ${ctx.currentToken}`,
              },
              body: JSON.stringify({
                offsets: [
                  { path: sA, offset: offsetA3 },
                  { path: sB, offset: offsetB1 },
                ],
              }),
            })
            expect(res.status).toBe(409)
            const body = await res.json()
            expect(body.error.code).toBe(`OFFSET_REGRESSION`)
            expect(body.error.path).toBe(sB)

            // Verify stream-a was NOT advanced (atomicity)
            const info = await fetch(`${ctx.baseUrl}/consumers/${c}`)
            const consumer = await info.json()
            const foundA = consumer.streams.find((s: any) => s.path === sA)
            const prevOffsetA = ctx.history
              .filter((e) => e.type === `events_appended` && e.path === sA)
              .slice(0, 1)
              .map((e: any) => e.offset)[0]
            expect(foundA.offset).toBe(prevOffsetA)
          })
          .skipInvariants()
          .run()
      })
    })

    describe(`Release`, () => {
      it(`releases epoch and returns to REGISTERED`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .release(c)
          .getConsumer(c)
          .expectState(`REGISTERED`)
          .run()
      })

      it(`preserves committed cursor after release`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .appendTo(s, `event-1`)
          .register(c, [s])
          .acquire(c)
          .ackLatest()
          .release(c)
          .acquire(c)
          .expectOffset(s, `$latest`)
          .run()
      })

      it(`rejects release without token`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`consumer`)
        await consumer(url())
          .stream(s)
          .register(c, [s])
          .acquire(c)
          .custom(async (ctx) => {
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/release`, {
              method: `POST`,
            })
            expect(res.status).toBe(401)
          })
          .skipInvariants()
          .run()
      })
    })
  })
}
```

- [ ] **Step 2: Update index.ts export**

In `packages/server-conformance-tests/src/index.ts`, update the export to use `ConsumerTestContext` instead of `TestContext`:

```typescript
export { runConsumerConformanceTests } from "./consumer-tests"
export type { ConsumerTestContext } from "./consumer-tests"
export { consumer, checkL1Invariants } from "./consumer-dsl"
export type {
  L1HistoryEvent,
  ConsumerRunContext,
  L1ConsumerModel,
} from "./consumer-dsl"
```

- [ ] **Step 3: Update conformance.test.ts to match new TestContext interface**

The test context interface changed from `TestContext` (with `createStream` and `appendToStream` helpers) to `ConsumerTestContext` (just `serverUrl`). Update `packages/server/test/conformance.test.ts` accordingly — the DSL handles stream creation and appending internally.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run --project server 2>&1 | tail -20`
Expected: All 693 tests pass (24 consumer tests rewritten via DSL + all existing tests unchanged)

- [ ] **Step 5: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/consumer-tests.ts packages/server-conformance-tests/src/index.ts packages/server/test/conformance.test.ts
sleep 0.01 && git commit -m "refactor: port L1 consumer tests to fluent DSL"
```

---

### Task 5: Wire Webhook DSL to Shared L1 Invariant Checkers

**Files:**

- Modify: `packages/server-conformance-tests/src/webhook-dsl.ts`

The existing webhook-dsl has its own `checkInvariants()` with S1 (epoch monotonicity) and ack monotonicity — both are L1 invariants that now live in consumer-dsl.ts. Wire the webhook DSL to call the shared checkers rather than duplicating.

- [ ] **Step 1: Import shared checkers**

Add to `webhook-dsl.ts`:

```typescript
import { checkL1Invariants } from "./consumer-dsl"
import type { L1HistoryEvent, AckInfo as L1AckInfo } from "./consumer-dsl"
```

- [ ] **Step 2: Add a function to project webhook history to L1 history**

The webhook DSL's `HistoryEvent` types are different from L1's `L1HistoryEvent`. Write a projection function that maps webhook history events to the L1 equivalents where applicable:

```typescript
/**
 * Project webhook-specific history events to L1 history events.
 * This allows running shared L1 invariant checkers on webhook traces.
 *
 * Key insight: the server acquires the L1 epoch BEFORE sending the
 * webhook (webhook-manager.ts:180). By the time webhook_received fires,
 * the consumer is already in READING state. The callback wake_id claim
 * is an L2 protocol step, not an L1 state transition.
 */
function projectToL1History(
  history: Array<HistoryEvent>
): Array<L1HistoryEvent> {
  const l1Events: Array<L1HistoryEvent> = []
  let currentConsumerId = ``
  // Track whether the last callback_sent was a PURE wake claim (wake_id
  // but no acks). Pure claims are L2-only — their callback_response must
  // NOT be projected. But a MIXED callback (wake_id + acks) bundles L2
  // claim with L1 ack in one request — its response carries the ack result
  // and MUST be projected as ack_response. The discriminator is on
  // callback_sent (wake_id + acks fields).
  let lastCallbackWasPureClaim = false

  for (const event of history) {
    switch (event.type) {
      case `stream_created`:
      case `stream_deleted`:
        l1Events.push(event)
        break
      case `events_appended`:
        l1Events.push(event)
        break
      case `webhook_received`:
        // The server acquired the epoch BEFORE sending this webhook.
        // This is the L1 epoch_acquired moment from the DSL's perspective.
        currentConsumerId = event.consumer_id
        l1Events.push({
          type: `epoch_acquired`,
          consumer_id: event.consumer_id,
          epoch: event.epoch,
          token: event.token,
          streams: event.streams,
        })
        break
      case `webhook_responded`:
        // Synchronous 2xx response to webhook POST (respondDone/respondOk).
        // Purely L2 — epoch was already acquired before webhook was sent.
        break
      case `callback_sent`:
        // Pure claim: wake_id present, no acks → L2-only, skip response
        // Mixed: wake_id + acks → response carries ack result, must project
        lastCallbackWasPureClaim =
          !!event.wake_id && (!event.acks || event.acks.length === 0)
        if (event.acks && event.acks.length > 0) {
          l1Events.push({
            type: `ack_sent`,
            consumer_id: currentConsumerId,
            token: event.token,
            offsets: event.acks,
          })
        }
        break
      case `callback_response`:
        if (lastCallbackWasPureClaim) {
          // Pure L2 wake claim response (no bundled acks) — not an L1 event.
          lastCallbackWasPureClaim = false
          break
        }
        // Ack callback response — project as L1 ack_response
        if (event.ok || event.error) {
          l1Events.push({
            type: `ack_response`,
            ok: event.ok,
            status: event.status,
            token: event.token,
            error: event.error,
          })
        }
        break
    }
  }

  return l1Events
}
```

- [ ] **Step 3: Update `checkInvariants` to call shared L1 checkers**

In the existing `checkInvariants()` function, add a call to shared L1 checkers via projection:

```typescript
export function checkInvariants(
  history: Array<HistoryEvent>,
  webhookSecret: string | null
): void {
  // L1 invariants (shared — mechanism-independent)
  const l1History = projectToL1History(history)
  checkL1Invariants(l1History)

  // L2 safety invariants (webhook-specific)
  checkWakeIdUniqueness(history)
  checkSingleClaim(history)
  if (webhookSecret) {
    checkSignaturePresence(history, webhookSecret)
  }

  // L2 temporal / liveness properties
  checkAppendTriggersWake(history)
  checkDoneWithPendingRewake(history)

  // L2 structural properties
  checkClaimPrecedesWake(history)
}
```

Remove the now-redundant `checkEpochMonotonicity` and `checkAckMonotonicity` functions from webhook-dsl.ts since they're now covered by the L1 checkers. **Keep `checkTokenRotation` in webhook-dsl.ts** — it checks that successful webhook callback responses include a refreshed token, which is a webhook-specific (L2/A) behavior, not an L1 invariant. The RFC's canonical ack response is `{ "ok": true }` with no token; token refresh in ack/callback responses is an implementation optimization.

- [ ] **Step 4: Run all tests**

Run: `pnpm vitest run --project server 2>&1 | tail -20`
Expected: All tests pass — webhook property-based tests still exercise invariant checkers, now via shared L1 path

- [ ] **Step 5: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/webhook-dsl.ts
sleep 0.01 && git commit -m "refactor: webhook DSL delegates L1 invariant checking to shared consumer-dsl"
```

---

## Chunk 2: Pull-Wake Server Implementation

### Task 6: Implement Pull-Wake (L2 Mechanism B) per RFC

**Files:**

- Modify: `packages/server/src/consumer-types.ts`
- Modify: `packages/server/src/consumer-store.ts`
- Modify: `packages/server/src/consumer-routes.ts`
- Modify: `packages/server/src/consumer-manager.ts`
- Create: `packages/server/src/pull-wake-manager.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/index.ts`

Per the RFC (§Layer 2 / Mechanism B): Pull-wake uses a Durable Stream (Layer 0 self-hosting) as the wake notification channel. The wake stream path is per-consumer, set via `PUT /consumers/{id}/wake` (RFC §Registration vs. Notification Preferences). Workers read the wake stream via SSE, see wake events, and race to claim via `POST /consumers/{id}/acquire`. On successful acquire, the server writes a `claimed` notification to the wake stream.

**Phase 2 scope constraint: pull-wake consumers are single-stream (one consumer per entity stream).** The RFC's primary use case is entity-per-stream patterns (e.g., `/users/123` → `user-handler`). Multi-stream pull-wake consumers create an ambiguity between stream-scoped wakes and consumer-scoped epochs. Phase 3 may generalize to multi-stream if needed.

Key RFC principles:

- **Registration vs. Notification Preferences are separate**: `POST /consumers` is L1 registration. `PUT /consumers/{id}/wake` is L2 notification preference. A consumer can be registered without any wake subscription (pure pull). A consumer can change wake mechanisms without re-registering.
- **Wake stream operates at L0 only**: No named consumers on the wake stream, no wake-about-wake. Like DNS root servers with hardcoded IPs — the termination condition for the self-hosting recursion.
- **Server is authoritative for claims**: Claims go through `POST /consumers/{id}/acquire`. The `claimed` event on the wake stream is informational only.

Note: `hasPendingWork()` already exists on `ConsumerManager` (line 356) and `ConsumerStore` (line 262) — added in the Phase 1 PR.

- [ ] **Step 1: Add `wake_preference` to Consumer type**

In `packages/server/src/consumer-types.ts`, add to the `Consumer` interface:

**Phase 2 scope: one active wake mechanism per consumer.** The RFC's broader vision is "one identity, zero-or-more notification preferences" (e.g., webhook AND push simultaneously). Phase 2 supports exactly one active preference at a time — `none`, `webhook`, or `pull-wake` — switchable via `PUT /consumers/{id}/wake`. The discriminated union below enforces this. Simultaneous multi-mechanism support is deferred to a future phase.

```typescript
export type WakePreference =
  | { type: `none` }
  | { type: `webhook`; url: string }
  | { type: `pull-wake`; wake_stream: string }

export interface Consumer {
  // ... existing fields ...
  wake_preference: WakePreference // L2 notification preference, default { type: 'none' }
}
```

Add to `ConsumerInfo`:

```typescript
export interface ConsumerInfo {
  // ... existing fields ...
  wake_preference: WakePreference
}
```

- [ ] **Step 2: Store wake_preference on consumer creation and expose setter**

In `packages/server/src/consumer-store.ts`, update `registerConsumer()` to initialize `wake_preference: { type: 'none' }` on new consumers.

In `packages/server/src/consumer-manager.ts`, add:

```typescript
setWakePreference(consumerId: string, preference: WakePreference): Consumer | null {
  const consumer = this.store.getConsumer(consumerId)
  if (!consumer) return null
  consumer.wake_preference = preference
  return consumer
}
```

- [ ] **Step 3: Add `PUT /consumers/{id}/wake` route**

In `packages/server/src/consumer-routes.ts`, add handler for `PUT /consumers/{id}/wake`:

```typescript
// PUT /consumers/{id}/wake — set L2 notification preference
case `PUT`: {
  if (segments.length === 3 && segments[2] === `wake`) {
    const consumerId = segments[1]!
    const body = await readJsonBody(req)

    // Validate preference
    if (!body.type || ![`none`, `webhook`, `pull-wake`].includes(body.type)) {
      return jsonResponse(400, {
        error: { code: `INVALID_PREFERENCE`, message: `type must be none, webhook, or pull-wake` },
      })
    }

    if (body.type === `pull-wake` && !body.wake_stream) {
      return jsonResponse(400, {
        error: { code: `INVALID_PREFERENCE`, message: `pull-wake requires wake_stream path` },
      })
    }

    // Phase 2 scope: pull-wake is single-stream only. Reject if consumer
    // has more than one subscribed stream. The claimed event writes assume
    // a single primary stream (writeClaimedEvent takes the first key).
    if (body.type === `pull-wake`) {
      const info = this.consumerManager.getConsumer(consumerId)
      if (info && info.streams.length > 1) {
        return jsonResponse(400, {
          error: {
            code: `MULTI_STREAM_PULL_WAKE`,
            message: `Pull-wake requires single-stream consumers (Phase 2 constraint). This consumer has ${info.streams.length} streams.`,
          },
        })
      }
    }

    const consumer = this.consumerManager.setWakePreference(consumerId, body as WakePreference)
    if (!consumer) {
      return jsonResponse(404, {
        error: { code: `CONSUMER_NOT_FOUND`, message: `Consumer not found` },
      })
    }

    return jsonResponse(200, { ok: true, wake_preference: consumer.wake_preference })
  }
}
```

- [ ] **Step 4: Add `onEpochAcquired` and `onEpochReleased` callbacks to ConsumerManager**

In `packages/server/src/consumer-manager.ts`, add (same pattern as `onLeaseExpired`):

```typescript
private epochAcquiredCallbacks: Array<(consumerId: string, epoch: number) => void> = []
private epochReleasedCallbacks: Array<(consumerId: string) => void> = []

onEpochAcquired(cb: (consumerId: string, epoch: number) => void): void {
  this.epochAcquiredCallbacks.push(cb)
}

onEpochReleased(cb: (consumerId: string) => void): void {
  this.epochReleasedCallbacks.push(cb)
}
```

Fire in `acquire()` after successful acquisition:

```typescript
for (const cb of this.epochAcquiredCallbacks) {
  cb(consumerId, consumer.epoch)
}
```

Fire in `release()` after successful release:

```typescript
for (const cb of this.epochReleasedCallbacks) {
  cb(consumerId)
}
```

- [ ] **Step 5: Add `worker` and `streams` fields to acquire request**

The RFC shows the acquire request body includes `worker` and `streams` fields:

```http
POST /consumers/{consumer_id}/acquire
Content-Type: application/json

{
  "streams": ["/users/123"],
  "worker": "worker-7"
}
```

In `packages/server/src/consumer-routes.ts`, update the acquire handler to accept optional `worker` and `streams` fields from the request body. `worker` is passed through to the response, callbacks, and stored on the Consumer (for contention logic in Step 6). `streams` is accepted and validated but reserved for future use — the registered streams remain authoritative.

In `packages/server/src/consumer-types.ts`, add to `AcquireResponse`:

```typescript
export interface AcquireResponse {
  consumer_id: string
  epoch: number
  token: string
  streams: Array<{ path: string; offset: string }>
  worker?: string // optional, passed through from request
}
```

Update `onEpochAcquired` callback signature to include `worker`:

```typescript
onEpochAcquired(cb: (consumerId: string, epoch: number, worker?: string) => void): void
```

- [ ] **Step 6: Add acquire contention logic (worker-based epoch fencing)**

The current `ConsumerManager.acquire()` always self-supersedes: if the consumer is READING, it increments the epoch and issues a new token. This is correct for crash recovery (same process re-acquiring), but wrong for pull-wake worker pools where a different worker tries to acquire a consumer already held by another worker.

Per the RFC, when a second worker tries to acquire a consumer currently READING by a different worker, it should get `409 EPOCH_HELD` — the consumer is occupied. Self-supersede only happens when the same worker (or no worker specified) re-acquires.

In `packages/server/src/consumer-types.ts`, add to `Consumer`:

```typescript
holder_id: string | null // the session/worker holding the epoch (mechanism-neutral: worker id for pull-wake, session id for pure pull, null = no holder tracking)
```

In `packages/server/src/consumer-types.ts`, add `holder` to `ConsumerError`:

```typescript
export interface ConsumerError {
  code: string
  message: string
  path?: string
  holder?: string // "active" when epoch is held by another session (409 EPOCH_HELD)
}
```

In `packages/server/src/consumer-manager.ts`, update `acquire()` to accept an optional `worker` parameter and add the contention check:

```typescript
acquire(consumerId: string, worker?: string): AcquireResponse | { error: ConsumerError } {
  const consumer = this.store.getConsumer(consumerId)
  if (!consumer) {
    return {
      error: { code: `CONSUMER_NOT_FOUND`, message: `Consumer '${consumerId}' does not exist` },
    }
  }

  // Contention check: if READING and a different worker holds the epoch, reject
  if (
    consumer.state === `READING` &&
    worker &&
    consumer.holder_id &&
    consumer.holder_id !== worker
  ) {
    return {
      error: {
        code: `EPOCH_HELD`,
        message: `Consumer is currently held by another worker`,
        holder: `active`,
      },
    }
  }

  // Proceed with acquire (self-supersede if READING + same worker or no worker)
  const result = this.store.acquireEpoch(consumerId)
  // ... rest of existing acquire logic ...

  // Track holder
  consumer.holder_id = worker ?? null

  // ... token generation, lease timer, callbacks ...
}
```

In `packages/server/src/consumer-routes.ts`, update the acquire handler to return 409 for `EPOCH_HELD`:

```typescript
if (`error` in result) {
  const status =
    result.error.code === `CONSUMER_NOT_FOUND`
      ? 404
      : result.error.code === `EPOCH_HELD`
        ? 409
        : 400
  return jsonResponse(status, { error: result.error })
}
```

Clear `holder_id` on release and lease expiry — in `ConsumerStore.releaseEpoch()`:

```typescript
consumer.holder_id = null
```

Initialize `holder_id: null` in `ConsumerStore.registerConsumer()` alongside the other Consumer fields.

- [ ] **Step 7: Create PullWakeManager**

```typescript
/**
 * Layer 2 / Mechanism B: Pull-Wake (Competitive Wake).
 * Uses a Durable Stream as a shared notification channel.
 * Workers read wake events, race to claim via L1 acquire.
 *
 * Only writes wake/claimed events for consumers whose wake_preference
 * is { type: 'pull-wake', wake_stream: '...' }.
 *
 * Wake stream schema (per RFC):
 *   { type: "wake",    stream: "/users/123", consumer: "user-handler" }
 *   { type: "claimed", stream: "/users/123", worker: "worker-7", epoch: 42 }
 *
 * One wake event per stream path with pending work (not one event with all streams).
 * This matches the RFC's event log:
 *   offset 1: { type: "wake",    stream: "/users/123", consumer: "user-handler" }
 *   offset 2: { type: "claimed", stream: "/users/123", worker: "worker-7", epoch: 42 }
 *   offset 3: { type: "wake",    stream: "/users/456", consumer: "user-handler" }
 */

import type { ConsumerManager } from "./consumer-manager"
import type { StreamStore } from "./store"
import type { Consumer } from "./consumer-types"

export interface WakeEvent {
  type: `wake`
  stream: string // the stream path with pending work
  consumer: string // the consumer_id to claim
  ts: number
}

export interface ClaimedEvent {
  type: `claimed`
  stream: string // the stream path that was claimed
  worker: string // the worker that claimed it
  epoch: number
  ts: number
}

export type PullWakeEvent = WakeEvent | ClaimedEvent

export class PullWakeManager {
  private consumerManager: ConsumerManager
  private streamStore: StreamStore
  private getTailOffset: (path: string) => string
  private isShuttingDown = false
  // Track consumer:stream pairs with outstanding wakes to avoid duplicates
  private pendingWakes = new Set<string>()

  constructor(opts: {
    consumerManager: ConsumerManager
    streamStore: StreamStore
    getTailOffset: (path: string) => string
  }) {
    this.consumerManager = opts.consumerManager
    this.streamStore = opts.streamStore
    this.getTailOffset = opts.getTailOffset

    // Register L1 lifecycle hooks
    this.consumerManager.onLeaseExpired((consumer) => {
      this.clearPendingWakes(consumer.consumer_id)
      if (
        this.isPullWakeConsumer(consumer) &&
        this.consumerManager.hasPendingWork(consumer.consumer_id)
      ) {
        this.writeWakeEvents(consumer)
      }
    })

    this.consumerManager.onEpochAcquired((consumerId, epoch, worker) => {
      const consumer = this.consumerManager.store.getConsumer(consumerId)
      if (consumer && this.isPullWakeConsumer(consumer)) {
        this.clearPendingWakes(consumerId)
        this.writeClaimedEvent(consumer, epoch, worker ?? `unknown`)
      }
    })

    this.consumerManager.onEpochReleased((consumerId) => {
      const consumer = this.consumerManager.store.getConsumer(consumerId)
      if (consumer && this.isPullWakeConsumer(consumer)) {
        this.clearPendingWakes(consumerId)
        if (this.consumerManager.hasPendingWork(consumerId)) {
          this.writeWakeEvents(consumer)
        }
      }
    })
  }

  /**
   * Called when events are appended to a stream.
   * Iterates over all L1 consumers subscribed to this stream
   * (via ConsumerStore.getConsumersForStream) and wakes any
   * pull-wake consumers that are REGISTERED with pending work.
   *
   * Same signature as WebhookManager.onStreamAppend(streamPath) —
   * wired into the same append hooks in server.ts.
   */
  onStreamAppend(streamPath: string): void {
    if (this.isShuttingDown) return

    const consumerIds =
      this.consumerManager.store.getConsumersForStream(streamPath)
    for (const consumerId of consumerIds) {
      const consumer = this.consumerManager.store.getConsumer(consumerId)
      if (!consumer) continue
      if (!this.isPullWakeConsumer(consumer)) continue
      if (consumer.state !== `REGISTERED`) continue

      const key = `${consumerId}:${streamPath}`
      if (this.pendingWakes.has(key)) continue

      if (this.consumerManager.hasPendingWork(consumerId)) {
        this.writeWakeEventForStream(consumer, streamPath)
      }
    }
  }

  private isPullWakeConsumer(consumer: Consumer): boolean {
    return consumer.wake_preference.type === `pull-wake`
  }

  private getWakeStreamPath(consumer: Consumer): string | null {
    if (consumer.wake_preference.type !== `pull-wake`) return null
    return consumer.wake_preference.wake_stream
  }

  /**
   * Write one wake event per stream with pending work (RFC format).
   * Only fires for streams where the consumer's cursor is behind the stream tail.
   */
  private writeWakeEvents(consumer: Consumer): void {
    for (const [streamPath] of consumer.streams) {
      // Only wake for streams with actual pending work (cursor behind tail)
      // Uses the same hasPendingWork check as WebhookManager
      if (this.hasPendingWorkForStream(consumer, streamPath)) {
        this.writeWakeEventForStream(consumer, streamPath)
      }
    }
  }

  private hasPendingWorkForStream(
    consumer: Consumer,
    streamPath: string
  ): boolean {
    const ackedOffset = consumer.streams.get(streamPath)
    if (ackedOffset === undefined) return false
    const tailOffset = this.getTailOffset(streamPath)
    return tailOffset > ackedOffset
  }

  private writeWakeEventForStream(
    consumer: Consumer,
    streamPath: string
  ): void {
    const wakeStreamPath = this.getWakeStreamPath(consumer)
    if (!wakeStreamPath) return

    const key = `${consumer.consumer_id}:${streamPath}`
    if (this.pendingWakes.has(key)) return

    const event: WakeEvent = {
      type: `wake`,
      stream: streamPath,
      consumer: consumer.consumer_id,
      ts: Date.now(),
    }

    this.pendingWakes.add(key)
    this.appendToWakeStream(wakeStreamPath, event)
  }

  /**
   * Write a claimed event for the consumer's primary stream (RFC format).
   * Phase 2 scope: pull-wake consumers are single-stream, so there is exactly
   * one stream to claim. The claimed event matches the wake event's stream field.
   */
  private writeClaimedEvent(
    consumer: Consumer,
    epoch: number,
    worker: string
  ): void {
    const wakeStreamPath = this.getWakeStreamPath(consumer)
    if (!wakeStreamPath) return

    // Single-stream constraint: use the first (only) stream
    const [streamPath] = consumer.streams.keys()
    if (!streamPath) return

    const event: ClaimedEvent = {
      type: `claimed`,
      stream: streamPath,
      worker,
      epoch,
      ts: Date.now(),
    }
    this.appendToWakeStream(wakeStreamPath, event)
  }

  private clearPendingWakes(consumerId: string): void {
    for (const key of this.pendingWakes) {
      if (key.startsWith(`${consumerId}:`)) {
        this.pendingWakes.delete(key)
      }
    }
  }

  private appendToWakeStream(
    wakeStreamPath: string,
    event: PullWakeEvent
  ): void {
    const stream = this.streamStore.get(wakeStreamPath)
    if (!stream) return
    this.streamStore.append(
      wakeStreamPath,
      JSON.stringify(event),
      `application/json`
    )
  }

  shutdown(): void {
    this.isShuttingDown = true
    this.pendingWakes.clear()
  }
}
```

The key insight: PullWakeManager is ~150 lines. It never touches epoch, offsets, or tokens — that's all L1. It writes notification events in the exact RFC schema (`stream` singular, `consumer`, `worker` fields) to each consumer's configured wake stream. It only fires for consumers with `wake_preference.type === 'pull-wake'`.

- [ ] **Step 8: Mount PullWakeManager in server.ts and wire append hooks**

In `packages/server/src/server.ts`, after the ConsumerManager initialization:

```typescript
this.pullWakeManager = new PullWakeManager({
  consumerManager: this.consumerManager,
  streamStore: this.store,
  getTailOffset: (path) => this.store.getTailOffset(path),
})
```

Wire `onStreamAppend` into the same append hooks that WebhookManager uses. There are three call sites in server.ts (lines ~839, ~1633, ~1700) that call `this.webhookManager.onStreamAppend(path)`. Add `this.pullWakeManager.onStreamAppend(path)` alongside each one:

```typescript
// After each existing webhookManager.onStreamAppend(path) call:
if (this.pullWakeManager) {
  this.pullWakeManager.onStreamAppend(path)
}
```

Also wire into `darix-manager.ts` if it calls `webhookManager.onStreamAppend()` directly (lines ~609, ~772).

No wake stream auto-creation. Wake streams are normal L0 Durable Streams — tests create them explicitly via `PUT` (per PROTOCOL.md §5.1) or the DSL's `.stream()` step. The wake stream path comes from each consumer's `wake_preference.wake_stream`.

- [ ] **Step 9: Export from index.ts**

Add to `packages/server/src/index.ts`:

```typescript
export { PullWakeManager } from "./pull-wake-manager"
export type {
  WakeEvent,
  ClaimedEvent,
  PullWakeEvent,
} from "./pull-wake-manager"
```

- [ ] **Step 10: Run tests to verify no regressions**

Run: `pnpm vitest run --project server 2>&1 | tail -20`
Expected: All tests pass (PullWakeManager is mounted but no tests exercise it yet)

- [ ] **Step 11: Commit**

```bash
sleep 0.01 && git add packages/server/src/consumer-types.ts packages/server/src/consumer-store.ts packages/server/src/consumer-routes.ts packages/server/src/consumer-manager.ts packages/server/src/pull-wake-manager.ts packages/server/src/server.ts packages/server/src/index.ts
sleep 0.01 && git commit -m "feat: add pull-wake (L2/B) per RFC — PUT /consumers/{id}/wake, per-consumer wake streams, worker/streams fields in acquire, contention logic (409 EPOCH_HELD), PullWakeManager with RFC event schema"
```

---

## Chunk 3: Pull-Wake DSL and Tests

### Task 7: Create Pull-Wake Testing DSL

**Files:**

- Create: `packages/server-conformance-tests/src/pull-wake-dsl.ts`

The pull-wake DSL extends the consumer DSL with wake stream reading. A pull-wake "worker" connects to the wake stream via SSE, reads wake events, and calls L1 acquire/ack/release directly.

- [ ] **Step 1: Implement PullWakeScenario**

```typescript
/**
 * Pull-Wake Testing DSL — fluent builder for L2 Mechanism B.
 * Workers read a wake stream (L0 SSE) and claim via L1 acquire.
 *
 * Usage:
 *   await pullWake(baseUrl, '/wake/my-pool')
 *     .stream('/tasks/123')
 *     .stream('/wake/my-pool')         // create the L0 wake stream
 *     .register('my-worker', ['/tasks/123'])
 *     .setWakePreference('my-worker')  // PUT → { type: 'pull-wake', wake_stream: '/wake/my-pool' }
 *     .startWakeReader()
 *     .appendTo('/tasks/123', 'event-1')
 *     .expectWakeEvent('my-worker')
 *     .claimViaAcquire()
 *     .ackAll()
 *     .release()
 *     .run()
 */

import { expect } from "vitest"
import { ConsumerScenario } from "./consumer-dsl"
import type {
  ConsumerRunContext,
  L1HistoryEvent,
  StreamInfo,
  AckInfo,
} from "./consumer-dsl"

// ============================================================================
// Pull-Wake History Events (L2/B specific)
// Matches RFC wake stream schema:
//   { type: "wake",    stream: "...", consumer: "..." }
//   { type: "claimed", stream: "...", worker: "...", epoch: N }
// ============================================================================

export type PullWakeHistoryEvent =
  | L1HistoryEvent
  | {
      type: `wake_event_received`
      stream: string // the stream path with pending work
      consumer: string // the consumer_id to claim
    }
  | {
      type: `claimed_event_received`
      stream: string // the stream path that was claimed
      worker: string // the worker that claimed it
      epoch: number
    }
  | {
      type: `claim_attempted`
      consumer_id: string
      worker: string
    }
  | {
      type: `claim_succeeded`
      consumer_id: string
      worker: string
      epoch: number
      token: string
    }
  | {
      type: `claim_failed`
      consumer_id: string
      worker: string
      status: number
      error: { code: string; message: string }
    }

// ============================================================================
// Wake Stream Reader
// ============================================================================

// Matches RFC wake stream event schema
interface WakeStreamEvent {
  type: `wake` | `claimed`
  stream: string // the data stream path
  consumer?: string // on wake events: the consumer_id to claim
  worker?: string // on claimed events: the worker that claimed
  epoch?: number // on claimed events: the epoch
}

export class WakeStreamReader {
  private baseUrl: string
  private wakeStreamPath: string
  private events: Array<WakeStreamEvent> = []
  private consumedCount = 0
  private waitResolvers: Array<() => void> = []
  private controller: AbortController | null = null
  private readPromise: Promise<void> | null = null

  constructor(baseUrl: string, wakeStreamPath: string) {
    this.baseUrl = baseUrl
    this.wakeStreamPath = wakeStreamPath
  }

  async start(fromOffset?: string): Promise<void> {
    this.controller = new AbortController()
    const offset = fromOffset ?? `-1`

    this.readPromise = this.readLoop(offset)
  }

  private async readLoop(offset: string): Promise<void> {
    try {
      const url = `${this.baseUrl}${this.wakeStreamPath}?offset=${offset}&live=sse`
      const res = await fetch(url, {
        signal: this.controller!.signal,
        headers: { accept: `text/event-stream` },
      })

      if (!res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ``

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(`\n`)
        buffer = lines.pop()!

        for (const line of lines) {
          if (line.startsWith(`data: `)) {
            try {
              const event = JSON.parse(line.slice(6)) as WakeStreamEvent
              this.events.push(event)
              for (const waiter of this.waitResolvers) waiter()
              this.waitResolvers = []
            } catch {
              // non-JSON SSE data, skip
            }
          }
        }
      }
    } catch {
      // AbortError or network error — expected on stop()
    }
  }

  async waitForWakeEvent(
    consumerId: string,
    timeoutMs = 10_000
  ): Promise<WakeStreamEvent & { index: number }> {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      for (let i = this.consumedCount; i < this.events.length; i++) {
        const event = this.events[i]!
        if (event.type === `wake` && event.consumer === consumerId) {
          this.consumedCount = i + 1
          return { ...event, index: i }
        }
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs - (Date.now() - start))
        this.waitResolvers.push(() => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }

    throw new Error(
      `Timed out waiting for wake event for consumer ${consumerId} after ${timeoutMs}ms`
    )
  }

  /**
   * Wait for a claimed event on a specific stream path.
   * RFC claimed events have { type: "claimed", stream: "...", worker: "...", epoch: N }
   * — no consumer field. Workers match by stream path.
   */
  async waitForClaimedEvent(
    streamPath: string,
    timeoutMs = 5_000
  ): Promise<WakeStreamEvent> {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      for (let i = this.consumedCount; i < this.events.length; i++) {
        const event = this.events[i]!
        if (event.type === `claimed` && event.stream === streamPath) {
          this.consumedCount = i + 1
          return event
        }
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs - (Date.now() - start))
        this.waitResolvers.push(() => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }

    throw new Error(
      `Timed out waiting for claimed event for stream ${streamPath}`
    )
  }

  /**
   * Check if a claimed event exists for a stream AFTER the given event index.
   * Workers use this to skip already-claimed wakes without a round-trip.
   *
   * Temporal ordering matters: an old claimed event from a previous epoch
   * must NOT suppress a fresh wake. Only a claimed event that appears
   * AFTER the wake in the stream ordering counts.
   */
  hasClaimedEventAfter(streamPath: string, afterIndex: number): boolean {
    for (let i = afterIndex + 1; i < this.events.length; i++) {
      const e = this.events[i]!
      if (e.type === `claimed` && e.stream === streamPath) return true
    }
    return false
  }

  stop(): void {
    if (this.controller) {
      this.controller.abort()
      this.controller = null
    }
  }
}
```

- [ ] **Step 2: Implement PullWakeScenario class**

**Design: single unified step queue, no inheritance.** PullWakeScenario has ONE step list with a discriminated union that includes both L1 step kinds (from consumer-dsl) and pull-wake step kinds. `run()` dispatches on `kind`. This avoids the fragile two-queue interleaving problem.

```typescript
// Unified step type — includes all L1 steps plus pull-wake-specific steps
type PullWakeStep =
  // L1 steps (same kinds as ConsumerScenario's Step type)
  | { kind: `stream`; path: string }
  | { kind: `append`; path: string | null; data: unknown }
  | { kind: `appendTo`; path: string; data: unknown }
  | {
      kind: `register`
      consumerId: string
      streams: Array<string>
      leaseTtlMs?: number
    }
  | { kind: `setWakePreference`; consumerId?: string; wakeStreamPath: string }
  | { kind: `deleteConsumer`; consumerId: string }
  | { kind: `getConsumer`; consumerId: string }
  | { kind: `acquire`; consumerId?: string }
  | { kind: `tryAcquire`; consumerId?: string }
  | { kind: `ack`; path: string; offset: string }
  | { kind: `ackLatest` }
  | { kind: `ackAll` }
  | { kind: `heartbeat` }
  | { kind: `release`; consumerId?: string }
  | { kind: `wait`; ms: number }
  | { kind: `expectState`; state: string }
  | { kind: `expectOffset`; path: string; offset: string }
  | { kind: `custom`; fn: (ctx: PullWakeRunContext) => Promise<void> }
  // Pull-wake-specific steps (L2/B)
  | { kind: `startWakeReader` }
  | { kind: `expectWakeEvent`; consumerId?: string }
  | { kind: `expectClaimedEvent`; streamPath?: string }
  | { kind: `claimViaAcquire`; consumerId?: string; worker?: string }
  | { kind: `expectNoWakeEvent`; timeoutMs?: number }
  | { kind: `expectClaimedSkip`; streamPath: string } // verify worker sees claimed after the most recent wake for this stream, skips acquire

// Single unified history — PullWakeHistoryEvent is a supertype of L1HistoryEvent,
// so all L1 events also go into this trace. No dual-array split.
// The L1 step executor writes to `history` (which IS the pullWakeHistory via alias),
// preserving interleaving order for checker soundness.
interface PullWakeRunContext extends Omit<ConsumerRunContext, "history"> {
  wakeStreamPath: string
  wakeReader: WakeStreamReader | null
  history: Array<PullWakeHistoryEvent> // unified trace: L1 + pull-wake events
  lastWakeIndexByStream: Map<string, number> // stream path → wake event index (for hasClaimedEventAfter)
}

export class PullWakeScenario {
  private baseUrl: string
  private wakeStreamPath: string
  private steps: Array<PullWakeStep> = []
  private _skipInvariants = false

  constructor(baseUrl: string, wakeStreamPath: string) {
    this.baseUrl = baseUrl
    this.wakeStreamPath = wakeStreamPath
  }

  // L1 builder methods (same signatures as ConsumerScenario)
  stream(path: string): this {
    this.steps.push({ kind: `stream`, path })
    return this
  }
  register(
    consumerId: string,
    streams: Array<string>,
    leaseTtlMs?: number
  ): this {
    this.steps.push({ kind: `register`, consumerId, streams, leaseTtlMs })
    return this
  }
  setWakePreference(consumerId?: string, wakeStreamPath?: string): this {
    this.steps.push({
      kind: `setWakePreference`,
      consumerId,
      wakeStreamPath: wakeStreamPath ?? this.wakeStreamPath,
    })
    return this
  }
  append(data: unknown): this {
    this.steps.push({ kind: `append`, path: null, data })
    return this
  }
  appendTo(path: string, data: unknown): this {
    this.steps.push({ kind: `appendTo`, path, data })
    return this
  }
  acquire(consumerId?: string): this {
    this.steps.push({ kind: `acquire`, consumerId })
    return this
  }
  ack(path: string, offset: string): this {
    this.steps.push({ kind: `ack`, path, offset })
    return this
  }
  ackLatest(): this {
    this.steps.push({ kind: `ackLatest` })
    return this
  }
  ackAll(): this {
    this.steps.push({ kind: `ackAll` })
    return this
  }
  heartbeat(): this {
    this.steps.push({ kind: `heartbeat` })
    return this
  }
  release(consumerId?: string): this {
    this.steps.push({ kind: `release`, consumerId })
    return this
  }
  wait(ms: number): this {
    this.steps.push({ kind: `wait`, ms })
    return this
  }
  expectState(state: string): this {
    this.steps.push({ kind: `expectState`, state })
    return this
  }
  expectOffset(path: string, offset: string): this {
    this.steps.push({ kind: `expectOffset`, path, offset })
    return this
  }
  getConsumer(consumerId?: string): this {
    this.steps.push({ kind: `getConsumer`, consumerId: consumerId ?? `` })
    return this
  }
  deleteConsumer(consumerId?: string): this {
    this.steps.push({ kind: `deleteConsumer`, consumerId: consumerId ?? `` })
    return this
  }
  custom(fn: (ctx: PullWakeRunContext) => Promise<void>): this {
    this.steps.push({ kind: `custom`, fn })
    return this
  }
  skipInvariants(): this {
    this._skipInvariants = true
    return this
  }

  // Pull-wake-specific builder methods
  startWakeReader(): this {
    this.steps.push({ kind: `startWakeReader` })
    return this
  }
  expectWakeEvent(consumerId?: string): this {
    this.steps.push({ kind: `expectWakeEvent`, consumerId })
    return this
  }
  claimViaAcquire(consumerId?: string, worker?: string): this {
    this.steps.push({ kind: `claimViaAcquire`, consumerId, worker })
    return this
  }
  expectClaimedEvent(streamPath?: string): this {
    this.steps.push({ kind: `expectClaimedEvent`, streamPath })
    return this
  }
  expectNoWakeEvent(timeoutMs?: number): this {
    this.steps.push({ kind: `expectNoWakeEvent`, timeoutMs })
    return this
  }
  expectClaimedSkip(streamPath: string): this {
    this.steps.push({ kind: `expectClaimedSkip`, streamPath })
    return this
  }

  async run(): Promise<Array<PullWakeHistoryEvent>> {
    const ctx: PullWakeRunContext = {
      baseUrl: this.baseUrl,
      history: [], // unified trace: L1 + pull-wake events
      consumerId: null,
      currentToken: null,
      currentEpoch: null,
      currentStream: null,
      tailOffsets: new Map(),
      lastResult: null,
      wakeStreamPath: this.wakeStreamPath,
      wakeReader: null,
      lastWakeIndexByStream: new Map(),
    }

    try {
      for (const step of this.steps) {
        await executePullWakeStep(ctx, step)
      }
    } finally {
      if (ctx.wakeReader) ctx.wakeReader.stop()
    }

    if (!this._skipInvariants) {
      checkPullWakeInvariants(ctx.history)
    }

    return ctx.history
  }
}

export function pullWake(
  baseUrl: string,
  wakeStreamPath: string
): PullWakeScenario {
  return new PullWakeScenario(baseUrl, wakeStreamPath)
}
```

The `executePullWakeStep()` function dispatches on `kind`. For L1 step kinds, it delegates to the same `executeConsumerStep()` from consumer-dsl (imported). For pull-wake step kinds, it handles wake reader start/stop, wake event waiting, and claim-via-acquire. The `setWakePreference` step calls `PUT /consumers/{id}/wake` with `{ type: 'pull-wake', wake_stream: ctx.wakeStreamPath }`.

- [ ] **Step 3: Add pull-wake invariant checkers**

```typescript
export const PULL_WAKE_CHECKER_METADATA: Record<string, CheckerMetadata> = {
  checkClaimedFollowsClaim: {
    soundness: `complete`,
    completeness: `exhaustive`,
    description: `Every claimed_event_received in the trace has a preceding claim_succeeded`,
  },
  checkPullWakeAppendTriggersWake: {
    soundness: `complete`,
    completeness: `conditional`,
    preconditions: [
      `trace must contain events_appended while consumer is REGISTERED with pending work`,
    ],
    description: `Append to a REGISTERED consumer with pending work produces a wake event before next epoch_acquired`,
  },
  checkPullWakeReleaseRewake: {
    soundness: `complete`,
    completeness: `conditional`,
    preconditions: [
      `trace must contain release_response(ok) with pending unacked events`,
    ],
    description: `Release with pending work triggers a re-wake event`,
  },
}

export function checkPullWakeInvariants(
  history: Array<PullWakeHistoryEvent>
): void {
  // Safety
  // PW-S1: Every claimed_event_received has a preceding claim_succeeded
  checkClaimedFollowsClaim(history)

  // Liveness (pull-wake equivalents of webhook's L1/L3)
  // PW-L1: Append to a REGISTERED consumer with pending work triggers a wake event
  checkPullWakeAppendTriggersWake(history)
  // PW-L2: Release with pending work triggers re-wake
  checkPullWakeReleaseRewake(history)

  // Shared L1 invariants
  const l1Events = history.filter(
    (e) =>
      !e.type.startsWith(`wake_event`) &&
      !e.type.startsWith(`claimed_event`) &&
      !e.type.startsWith(`claim_`)
  ) as Array<L1HistoryEvent>
  checkL1Invariants(l1Events)
}

/**
 * PW-L1: After events_appended, if the consumer is REGISTERED with pending work,
 * a wake_event_received should eventually appear for that consumer before the
 * next epoch_acquired (i.e., before the consumer is claimed by another path).
 */
function checkPullWakeAppendTriggersWake(
  history: Array<PullWakeHistoryEvent>
): void {
  // Track consumer state: REGISTERED vs READING
  let consumerState: `REGISTERED` | `READING` = `REGISTERED`
  let lastAckedOffset: string | null = null
  let lastAppendedOffset: string | null = null

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!

    if (event.type === `epoch_acquired`) {
      consumerState = `READING`
    } else if (event.type === `release_response` && event.ok) {
      consumerState = `REGISTERED`
    } else if (event.type === `events_appended`) {
      lastAppendedOffset = event.offset
      // Consumer is REGISTERED and there's pending work (appended > acked)
      if (
        consumerState === `REGISTERED` &&
        lastAppendedOffset !== lastAckedOffset
      ) {
        // Look ahead: a wake_event_received must appear before the next epoch_acquired
        let foundWake = false
        for (let j = i + 1; j < history.length; j++) {
          const future = history[j]!
          if (future.type === `wake_event_received`) {
            foundWake = true
            break
          }
          if (future.type === `epoch_acquired`) break
        }
        if (!foundWake) {
          throw new Error(
            `PW-L1: events_appended at index ${i} with consumer REGISTERED ` +
              `and pending work, but no wake_event_received before next epoch_acquired`
          )
        }
      }
    } else if (event.type === `ack_response` && event.ok) {
      // Update acked offset from the preceding ack_sent
      const prev = history[i - 1]
      if (prev && prev.type === `ack_sent` && prev.offsets.length > 0) {
        lastAckedOffset = prev.offsets[prev.offsets.length - 1]!.offset
      }
    }
  }
}

/**
 * PW-L2: After release with pending work (unacked events exist beyond the
 * committed cursor), a wake_event_received should appear before the next
 * epoch_acquired.
 */
function checkPullWakeReleaseRewake(
  history: Array<PullWakeHistoryEvent>
): void {
  let lastAckedOffset: string | null = null
  let lastAppendedOffset: string | null = null

  for (let i = 0; i < history.length; i++) {
    const event = history[i]!

    if (event.type === `events_appended`) {
      lastAppendedOffset = event.offset
    } else if (event.type === `ack_response` && event.ok) {
      const prev = history[i - 1]
      if (prev && prev.type === `ack_sent` && prev.offsets.length > 0) {
        lastAckedOffset = prev.offsets[prev.offsets.length - 1]!.offset
      }
    } else if (event.type === `release_response` && event.ok) {
      // Check if there's pending work (appended beyond last acked)
      if (lastAppendedOffset && lastAppendedOffset !== lastAckedOffset) {
        // Look ahead: wake_event_received must appear before next epoch_acquired
        let foundWake = false
        for (let j = i + 1; j < history.length; j++) {
          const future = history[j]!
          if (future.type === `wake_event_received`) {
            foundWake = true
            break
          }
          if (future.type === `epoch_acquired`) break
        }
        if (!foundWake) {
          throw new Error(
            `PW-L2: release_response(ok) at index ${i} with pending work, ` +
              `but no wake_event_received before next epoch_acquired`
          )
        }
      }
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/pull-wake-dsl.ts
sleep 0.01 && git commit -m "feat: add pull-wake testing DSL with wake stream reader and invariant checkers"
```

---

### Task 8: Write Pull-Wake Conformance Tests

**Files:**

- Create: `packages/server-conformance-tests/src/pull-wake-tests.ts`
- Modify: `packages/server-conformance-tests/src/index.ts`
- Modify: `packages/server/test/conformance.test.ts`

These tests prove L1 works with a completely different L2 mechanism. They follow the same structure as the webhook tests.

- [ ] **Step 1: Write pull-wake scenario tests**

```typescript
/**
 * Layer 2 Mechanism B: Pull-Wake conformance tests.
 * Proves L1 consumer lifecycle works with pull-based wake via shared stream.
 *
 * Each test:
 * 1. Creates a wake stream (L0 Durable Stream)
 * 2. Registers an L1 consumer
 * 3. Sets wake preference to pull-wake via PUT /consumers/{id}/wake
 * 4. Exercises the pull-wake lifecycle
 */

import { describe, expect, it } from "vitest"
import { pullWake } from "./pull-wake-dsl"

export interface PullWakeTestContext {
  serverUrl: string
}

let _testCounter = 0
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_testCounter}`
}

export function runPullWakeConformanceTests(
  getCtx: () => PullWakeTestContext
): void {
  describe(`L2/B: Pull-Wake`, () => {
    const url = () => getCtx().serverUrl

    describe(`Wake Stream Events`, () => {
      it(`writes wake event when REGISTERED consumer has pending work`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w) // create the wake stream (L0)
          .register(c, [s])
          .setWakePreference(c) // PUT /consumers/{c}/wake → { type: 'pull-wake', wake_stream: w }
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .run()
      })

      it(`writes claimed event after successful acquire`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `worker-1`)
          .expectClaimedEvent(s) // claimed event keyed by stream path per RFC
          .run()
      })

      it(`no wake while consumer is READING`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          .appendTo(s, `event-2`) // append while READING
          .expectNoWakeEvent(500) // no new wake — consumer is READING
          .run()
      })

      it(`no wake for consumer without pull-wake preference`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          // No setWakePreference — consumer has { type: 'none' }
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectNoWakeEvent(500) // no wake — consumer isn't pull-wake
          .skipInvariants()
          .run()
      })
    })

    describe(`Full Lifecycle`, () => {
      it(`wake → acquire → ack → release → re-wake`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          // First cycle
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          .ackAll()
          .release(c)
          // Second cycle — new event triggers re-wake
          .appendTo(s, `event-2`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          .ackAll()
          .release(c)
          .run()
      })

      it(`cursors persist across pull-wake cycles`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        let firstAckOffset: string
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          .ackLatest()
          .custom(async (ctx) => {
            firstAckOffset = ctx.tailOffsets.get(s)!
          })
          .release(c)
          // Second cycle — offset should be preserved from first ack
          .appendTo(s, `event-2`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          .custom(async (ctx) => {
            // The consumer's offset after re-acquire should match what we acked
            const info = ctx.history
              .filter((e) => e.type === `epoch_acquired`)
              .pop()!
            if (info.type === `epoch_acquired`) {
              const streamOffset = info.streams.find(
                (si) => si.path === s
              )!.offset
              expect(streamOffset).toBe(firstAckOffset)
            }
          })
          .run()
      })

      it(`lease expiry triggers re-wake`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s], 200) // 200ms lease
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c)
          // Don't ack or heartbeat — let lease expire
          .wait(300)
          .expectWakeEvent(c) // re-wake after lease expiry
          .run()
      })
    })

    describe(`Competitive Claims (Worker Pool)`, () => {
      it(`two workers race — one claims, other gets 409`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`

        // Setup: register consumer, set pull-wake, create wake stream
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          // Worker-1 claims successfully
          .claimViaAcquire(c, `worker-1`)
          .expectClaimedEvent(s)
          .custom(async (ctx) => {
            // Worker-2 tries to claim same consumer — gets 409 Conflict
            const res = await fetch(`${ctx.baseUrl}/consumers/${c}/acquire`, {
              method: `POST`,
              headers: { "content-type": `application/json` },
              body: JSON.stringify({ worker: `worker-2` }),
            })
            expect(res.status).toBe(409)
          })
          .run()
      })

      it(`worker sees claimed event and skips acquire`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `worker-1`)
          .expectClaimedEvent(s)
          // Now a second "worker" reads the wake stream and should see the
          // claimed event — it can skip acquiring via hasClaimedEventAfter()
          .expectClaimedSkip(s)
          .run()
      })

      it(`claimed event includes worker and epoch from acquire`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `worker-7`)
          .custom(async (ctx) => {
            // Find the claimed event on the wake stream and verify fields
            const wakeStreamEvents = await fetch(`${ctx.baseUrl}${w}?offset=-1`)
            const body = await wakeStreamEvents.text()
            const events = body
              .split(`\n`)
              .filter(Boolean)
              .map((l) => JSON.parse(l))
            const claimed = events.find(
              (e: any) => e.type === `claimed` && e.stream === s
            )
            expect(claimed).toBeDefined()
            expect(claimed.worker).toBe(`worker-7`)
            expect(claimed.epoch).toBeGreaterThanOrEqual(1)
          })
          .run()
      })
    })

    describe(`Worker Reconnection`, () => {
      it(`worker reconnects to wake stream and resumes from last offset`, async () => {
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pw-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `worker-1`)
          .ackAll()
          .release(c)
          .custom(async (ctx) => {
            // Save current wake stream tail offset before disconnect
            const tailRes = await fetch(`${ctx.baseUrl}${w}`)
            const tailOffset = tailRes.headers.get(`stream-offset`) ?? `0`

            // Stop current wake reader (simulates disconnect)
            ctx.wakeReader!.stop()

            // Append new event to trigger re-wake
            await fetch(`${ctx.baseUrl}${s}`, {
              method: `POST`,
              headers: { "content-type": `application/json` },
              body: JSON.stringify(`event-2`),
            })

            // Reconnect from saved offset (resume, not replay)
            const newReader = new WakeStreamReader(ctx.baseUrl, w)
            await newReader.start(tailOffset)
            const wakeEvent = await newReader.waitForWakeEvent(c, 5000)
            expect(wakeEvent.consumer).toBe(c)
            expect(wakeEvent.stream).toBe(s)
            newReader.stop()
          })
          .skipInvariants()
          .run()
      })
    })

    describe(`Contention Patterns (per RFC)`, () => {
      it(`single consumer — no contention`, async () => {
        // One worker, one consumer. Like a desktop app for a user entity.
        const s = `/test/${uid(`stream`)}`
        const c = uid(`solo-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `sole-worker`)
          .ackAll()
          .release(c)
          .run()
      })

      it(`small pool — two workers with second waiting for release`, async () => {
        // Worker-1 claims, worker-2 waits. After worker-1 releases,
        // a new wake event appears and worker-2 can claim.
        const s = `/test/${uid(`stream`)}`
        const c = uid(`pool-consumer`)
        const w = `/wake/${uid(`wake`)}`
        await pullWake(url(), w)
          .stream(s)
          .stream(w)
          .register(c, [s])
          .setWakePreference(c)
          .startWakeReader()
          // First event
          .appendTo(s, `event-1`)
          .expectWakeEvent(c)
          .claimViaAcquire(c, `worker-1`)
          .ackAll()
          // Append another event while worker-1 is READING
          .appendTo(s, `event-2`)
          .release(c)
          // After release with pending work → re-wake
          .expectWakeEvent(c)
          // Worker-2 claims the re-wake
          .claimViaAcquire(c, `worker-2`)
          .ackAll()
          .release(c)
          .run()
      })
    })
  })
}
```

- [ ] **Step 2: Wire pull-wake tests into the test runner**

In `packages/server-conformance-tests/src/index.ts`, add export:

```typescript
export { runPullWakeConformanceTests } from "./pull-wake-tests"
export type { PullWakeTestContext } from "./pull-wake-tests"
```

In `packages/server/test/conformance.test.ts`, add:

```typescript
import { runPullWakeConformanceTests } from "@durable-streams/server-conformance-tests"

// ... inside the test setup
runPullWakeConformanceTests(() => ({
  serverUrl: server.url,
}))
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run --project server 2>&1 | tail -30`
Expected: All existing tests + new pull-wake tests pass

- [ ] **Step 4: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/pull-wake-tests.ts packages/server-conformance-tests/src/index.ts packages/server/test/conformance.test.ts
sleep 0.01 && git commit -m "test: add pull-wake conformance tests proving L1 mechanism independence"
```

---

### Task 9: Tier 2 Adversarial Pull-Wake DSL and Tests

**Files:**

- Modify: `packages/server-conformance-tests/src/pull-wake-dsl.ts`
- Modify: `packages/server-conformance-tests/src/index.ts`

Per the configurancy skill (§2.4), the two-tier DSL split is essential: Tier 1 typed builders test valid scenarios, Tier 2 raw/adversarial API tests malformed, reordered, duplicated, and replayed behavior. Pull-wake needs this even more than webhook because its failure modes involve shared-stream ordering bugs, stale claimed events, and race conditions between workers.

The webhook DSL already has this pattern (`rawCallback`, `rawWebhookResponse`). The pull-wake DSL should follow suit.

- [ ] **Step 1: Add Tier 2 raw API methods to PullWakeScenario**

Add raw escape hatches to `pull-wake-dsl.ts` that bypass the typed builder's safety:

```typescript
// ============================================================================
// Tier 2: Raw / Adversarial API
// ============================================================================

// Raw acquire: send arbitrary body, don't update context token/epoch
type RawAcquireStep = {
  kind: `rawAcquire`
  consumerId: string
  body: Record<string, unknown>
  expectedStatus: number
}

// Raw ack: send arbitrary token/offsets, don't validate
type RawAckStep = {
  kind: `rawAck`
  consumerId: string
  token: string
  body: Record<string, unknown>
  expectedStatus: number
}

// Raw wake event injection: write directly to wake stream (simulates
// a corrupted or replayed event that didn't come from the server)
type RawWakeEventStep = {
  kind: `rawWakeEvent`
  event: Record<string, unknown>
}

// Raw claimed event injection: write a fake claimed event
type RawClaimedEventStep = {
  kind: `rawClaimedEvent`
  event: Record<string, unknown>
}
```

Add corresponding builder methods:

```typescript
  // Tier 2: Raw / Adversarial methods
  rawAcquire(consumerId: string, body: Record<string, unknown>, expectedStatus: number): this {
    this.steps.push({ kind: `rawAcquire`, consumerId, body, expectedStatus })
    return this
  }
  rawAck(consumerId: string, token: string, body: Record<string, unknown>, expectedStatus: number): this {
    this.steps.push({ kind: `rawAck`, consumerId, token, body, expectedStatus })
    return this
  }
  rawWakeEvent(event: Record<string, unknown>): this {
    this.steps.push({ kind: `rawWakeEvent`, event })
    return this
  }
  rawClaimedEvent(event: Record<string, unknown>): this {
    this.steps.push({ kind: `rawClaimedEvent`, event })
    return this
  }
```

Executor for Tier 2 steps:

```typescript
case `rawAcquire`: {
  const res = await fetch(`${ctx.baseUrl}/consumers/${step.consumerId}/acquire`, {
    method: `POST`,
    headers: { "content-type": `application/json` },
    body: JSON.stringify(step.body),
  })
  expect(res.status, `rawAcquire expected ${step.expectedStatus}`).toBe(step.expectedStatus)
  ctx.history.push({
    type: `raw_acquire_sent`,
    consumer_id: step.consumerId,
    body: step.body,
    status: res.status,
  } as any)
  break
}
case `rawAck`: {
  const res = await fetch(`${ctx.baseUrl}/consumers/${step.consumerId}/ack`, {
    method: `POST`,
    headers: {
      "content-type": `application/json`,
      authorization: `Bearer ${step.token}`,
    },
    body: JSON.stringify(step.body),
  })
  expect(res.status, `rawAck expected ${step.expectedStatus}`).toBe(step.expectedStatus)
  break
}
case `rawWakeEvent`: {
  // Inject directly into wake stream (adversarial: not from server)
  await fetch(`${ctx.baseUrl}${ctx.wakeStreamPath}`, {
    method: `POST`,
    headers: { "content-type": `application/json` },
    body: JSON.stringify(step.event),
  })
  break
}
case `rawClaimedEvent`: {
  await fetch(`${ctx.baseUrl}${ctx.wakeStreamPath}`, {
    method: `POST`,
    headers: { "content-type": `application/json` },
    body: JSON.stringify(step.event),
  })
  break
}
```

- [ ] **Step 2: Write Tier 2 adversarial tests**

```typescript
describe(`Tier 2: Adversarial Pull-Wake`, () => {
  describe(`malformed acquire`, () => {
    it(`acquire without worker field still works (pure-pull path)`, async () => {
      const s = `/test/${uid(`stream`)}`
      const c = uid(`pw-t2`)
      const w = `/wake/${uid(`wake`)}`
      await pullWake(url(), w)
        .stream(s)
        .stream(w)
        .register(c, [s])
        .setWakePreference(c)
        .rawAcquire(c, { streams: [s] }, 200) // no worker field
        .skipInvariants()
        .run()
    })

    it(`acquire with empty worker string treated as no holder`, async () => {
      const s = `/test/${uid(`stream`)}`
      const c = uid(`pw-t2`)
      const w = `/wake/${uid(`wake`)}`
      await pullWake(url(), w)
        .stream(s)
        .stream(w)
        .register(c, [s])
        .setWakePreference(c)
        .rawAcquire(c, { streams: [s], worker: `` }, 200)
        .skipInvariants()
        .run()
    })
  })

  describe(`replayed and stale tokens`, () => {
    it(`ack with token from superseded epoch returns STALE_EPOCH`, async () => {
      const s = `/test/${uid(`stream`)}`
      const c = uid(`pw-t2`)
      const w = `/wake/${uid(`wake`)}`
      await pullWake(url(), w)
        .stream(s)
        .stream(w)
        .register(c, [s])
        .setWakePreference(c)
        .startWakeReader()
        .appendTo(s, `event-1`)
        .expectWakeEvent(c)
        .claimViaAcquire(c, `worker-1`)
        .custom(async (ctx) => {
          const staleToken = ctx.currentToken!
          // Self-supersede to get new epoch
          const res = await fetch(`${ctx.baseUrl}/consumers/${c}/acquire`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ streams: [s], worker: `worker-1` }),
          })
          expect(res.status).toBe(200)
          const body = await res.json()
          ctx.currentToken = body.token
          ctx.currentEpoch = body.epoch
          // Now try to ack with the old token
          const ackRes = await fetch(`${ctx.baseUrl}/consumers/${c}/ack`, {
            method: `POST`,
            headers: {
              "content-type": `application/json`,
              authorization: `Bearer ${staleToken}`,
            },
            body: JSON.stringify({ offsets: [{ path: s, offset: `1` }] }),
          })
          expect(ackRes.status).toBe(409)
          const ackBody = await ackRes.json()
          expect(ackBody.error.code).toBe(`STALE_EPOCH`)
        })
        .skipInvariants()
        .run()
    })
  })

  describe(`bogus wake stream events`, () => {
    it(`injected fake wake event — acquire still works (server is authoritative)`, async () => {
      const s = `/test/${uid(`stream`)}`
      const c = uid(`pw-t2`)
      const w = `/wake/${uid(`wake`)}`
      await pullWake(url(), w)
        .stream(s)
        .stream(w)
        .register(c, [s])
        .setWakePreference(c)
        // Inject a fake wake event (not from server)
        .rawWakeEvent({ type: `wake`, stream: s, consumer: c })
        // Acquire should still work (server validates state, not wake stream)
        .rawAcquire(c, { streams: [s], worker: `attacker` }, 200)
        .skipInvariants()
        .run()
    })

    it(`injected fake claimed event does not prevent real claim`, async () => {
      const s = `/test/${uid(`stream`)}`
      const c = uid(`pw-t2`)
      const w = `/wake/${uid(`wake`)}`
      await pullWake(url(), w)
        .stream(s)
        .stream(w)
        .register(c, [s])
        .setWakePreference(c)
        .startWakeReader()
        .appendTo(s, `event-1`)
        .expectWakeEvent(c)
        // Inject fake claimed event before real claim
        .rawClaimedEvent({
          type: `claimed`,
          stream: s,
          worker: `fake-worker`,
          epoch: 999,
        })
        // Real claim still succeeds (server is authoritative)
        .claimViaAcquire(c, `real-worker`)
        .ackAll()
        .release(c)
        .run()
    })
  })

  describe(`temporal ordering attacks`, () => {
    it(`old claimed event does not suppress fresh wake (hasClaimedEventAfter)`, async () => {
      const s = `/test/${uid(`stream`)}`
      const c = uid(`pw-t2`)
      const w = `/wake/${uid(`wake`)}`
      await pullWake(url(), w)
        .stream(s)
        .stream(w)
        .register(c, [s])
        .setWakePreference(c)
        .startWakeReader()
        // First cycle: wake → claim → ack → release
        .appendTo(s, `event-1`)
        .expectWakeEvent(c)
        .claimViaAcquire(c, `worker-1`)
        .expectClaimedEvent(s)
        .ackAll()
        .release(c)
        // Second cycle: new append → new wake (must not be suppressed by old claimed)
        .appendTo(s, `event-2`)
        .expectWakeEvent(c) // this is the key assertion: fresh wake appears
        .claimViaAcquire(c, `worker-1`)
        .ackAll()
        .release(c)
        .run()
    })
  })

  describe(`contention edge cases`, () => {
    it(`different worker acquire while held returns 409 EPOCH_HELD`, async () => {
      const s = `/test/${uid(`stream`)}`
      const c = uid(`pw-t2`)
      const w = `/wake/${uid(`wake`)}`
      await pullWake(url(), w)
        .stream(s)
        .stream(w)
        .register(c, [s])
        .setWakePreference(c)
        .startWakeReader()
        .appendTo(s, `event-1`)
        .expectWakeEvent(c)
        .claimViaAcquire(c, `worker-1`)
        // Different worker tries to acquire — should get 409
        .rawAcquire(c, { streams: [s], worker: `worker-2` }, 409)
        .ackAll()
        .release(c)
        .skipInvariants()
        .run()
    })

    it(`same worker re-acquire succeeds (self-supersede)`, async () => {
      const s = `/test/${uid(`stream`)}`
      const c = uid(`pw-t2`)
      const w = `/wake/${uid(`wake`)}`
      await pullWake(url(), w)
        .stream(s)
        .stream(w)
        .register(c, [s])
        .setWakePreference(c)
        .startWakeReader()
        .appendTo(s, `event-1`)
        .expectWakeEvent(c)
        .claimViaAcquire(c, `worker-1`)
        // Same worker re-acquires (crash recovery) — should succeed
        .rawAcquire(c, { streams: [s], worker: `worker-1` }, 200)
        .skipInvariants()
        .run()
    })
  })
})
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run --project server 2>&1 | tail -20`
Expected: All tests pass including Tier 2 adversarial tests

- [ ] **Step 4: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/pull-wake-dsl.ts packages/server-conformance-tests/src/index.ts
sleep 0.01 && git commit -m "test: add Tier 2 adversarial pull-wake DSL and tests (per configurancy skill §2.4)"
```

---

### Task 10: Cross-Mechanism Test — Same Consumer, Direct HTTP then Pull-Wake

**Files:**

- Modify: `packages/server-conformance-tests/src/index.ts` (or a new cross-mechanism test file)

This is a smoke test for L1 mechanism-independence. One consumer, **explicitly registered at L1**, then exercised first by direct HTTP acquire/ack/release (pure L1, no L2) and then by pull-wake (L2/B). Verifies epoch continuity, cursor continuity, and state transitions work across mechanism switches. The stronger proof comes from Tasks 3–5 and 7–9: the same L1 invariant checkers pass on both mechanisms' traces.

**Why not webhook + pull-wake?** The webhook subsystem is subscription-driven — it creates consumers from Subscriptions (WebhookStore.createSubscription → createWebhookConsumer) and only wakes those subscription-created consumers. Wiring `PUT /consumers/{id}/wake { type: "webhook" }` to actually trigger webhooks requires webhook subsystem changes that are out of scope for this plan. Task 5 already proves webhook traces satisfy L1 invariants via shared checkers.

- [ ] **Step 1: Write cross-mechanism test**

Note: uses `STREAM_OFFSET_HEADER` from `@durable-streams/client` (already imported by webhook-dsl.ts and other test files — the header name is `Stream-Next-Offset`).

```typescript
import { STREAM_OFFSET_HEADER } from "@durable-streams/client"

describe(`Cross-Mechanism: Same L1 Consumer via Direct HTTP then Pull-Wake`, () => {
  it(`epoch chain continues across mechanism switch`, async () => {
    const s = `/test/${uid(`stream`)}`
    const c = uid(`cross-consumer`)
    const w = `/wake/${uid(`wake`)}`

    // Step 0: Create stream (L0)
    await fetch(`${getBaseUrl()}${s}`, { method: `PUT` })

    // Step 1: Explicit L1 registration — independent of any L2 mechanism
    const regRes = await fetch(`${getBaseUrl()}/consumers`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({ consumer_id: c, streams: [s] }),
    })
    expect(regRes.status).toBe(201)

    // Step 2: Exercise via direct HTTP (pure L1, no L2)
    // Append data — capture the offset from the Stream-Next-Offset
    // response header (STREAM_OFFSET_HEADER) so we can ack it. The
    // acquire response returns the COMMITTED cursor (initialized to
    // tail at registration, before this append), not the new event's
    // offset.
    const appendRes = await fetch(`${getBaseUrl()}${s}`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({ event: `via-direct-http` }),
    })
    const appendedOffset = appendRes.headers.get(STREAM_OFFSET_HEADER)!

    // Acquire epoch
    const acqRes = await fetch(`${getBaseUrl()}/consumers/${c}/acquire`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({ streams: [s], worker: `worker-direct` }),
    })
    expect(acqRes.status).toBe(200)
    const acqBody = await acqRes.json()
    const epochAfterDirect = acqBody.epoch
    const token = acqBody.token

    // Ack the APPENDED event (not the committed cursor from acquire)
    const ackRes = await fetch(`${getBaseUrl()}/consumers/${c}/ack`, {
      method: `POST`,
      headers: {
        "content-type": `application/json`,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ offsets: [{ path: s, offset: appendedOffset }] }),
    })
    expect(ackRes.status).toBe(200)

    // Release
    const relRes = await fetch(`${getBaseUrl()}/consumers/${c}/release`, {
      method: `POST`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(relRes.status).toBe(200)

    // Capture cursor after direct-HTTP phase for continuity check
    const infoAfterDirect = await (
      await fetch(`${getBaseUrl()}/consumers/${c}`)
    ).json()
    const cursorAfterDirect = infoAfterDirect.streams.find(
      (s2: any) => s2.path === s
    )?.offset
    expect(cursorAfterDirect).toBe(appendedOffset) // direct-HTTP phase acked the appended event

    // Step 3: Switch SAME consumer to pull-wake (L2/B)
    await fetch(`${getBaseUrl()}${w}`, { method: `PUT` }) // create L0 wake stream
    await fetch(`${getBaseUrl()}/consumers/${c}/wake`, {
      method: `PUT`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({ type: `pull-wake`, wake_stream: w }),
    })

    // Step 4: Exercise via pull-wake — same consumer, different mechanism
    await pullWake(getBaseUrl(), w)
      .startWakeReader()
      .appendTo(s, `via-pull-wake`)
      .expectWakeEvent(c)
      .claimViaAcquire(c, `worker-1`)
      .ackAll()
      .release(c)
      .run()

    // Step 5: Verify epoch and cursor continuity across mechanism switch
    const info = await fetch(`${getBaseUrl()}/consumers/${c}`)
    const body = await info.json()
    expect(body.epoch).toBeGreaterThan(epochAfterDirect)
    expect(body.state).toBe(`REGISTERED`)

    // Cursor continuity: pull-wake phase should have advanced the cursor
    // beyond where direct-HTTP left it (we appended + acked via pull-wake)
    const cursorAfterPullWake = body.streams.find(
      (s2: any) => s2.path === s
    )?.offset
    expect(cursorAfterPullWake > cursorAfterDirect).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run --project server 2>&1 | tail -20`
Expected: All tests pass including the cross-mechanism test

- [ ] **Step 3: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/
sleep 0.01 && git commit -m "test: add cross-mechanism test proving L1 works across webhook and pull-wake"
```

---

### Task 11: Property-Based Tests for Pull-Wake

**Files:**

- Modify: `packages/server-conformance-tests/src/index.ts`

Add property-based tests using fast-check that exercise pull-wake with random action sequences, using the same ENABLED predicate model as the webhook property tests.

- [ ] **Step 1: Add pull-wake property-based test**

Follow the exact pattern of the existing `Property-Based: Random Action Sequences` describe block in `index.ts` (line ~8200), but using the pull-wake DSL instead of the webhook DSL. The consumer actions are the same (append, ack, heartbeat), just triggered differently.

Per the configurancy skill (§3.2), property tests must use seeded randomness for reliable shrinking and replay. No `Date.now()` or `Math.random()` — derive all IDs and event data from the fast-check seed.

```typescript
describe(`Property-Based: Pull-Wake Random Action Sequences`, () => {
  const actionArb: fc.Arbitrary<ConsumerAction> = fc.oneof(
    { weight: 40, arbitrary: fc.constant(`append` as const) },
    { weight: 25, arbitrary: fc.constant(`ack` as const) },
    { weight: 20, arbitrary: fc.constant(`heartbeat` as const) }
  )

  test(`random action sequences preserve L1 safety invariants via pull-wake`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(actionArb, { minLength: 2, maxLength: 8 }),
        fc.integer({ min: 1, max: 999999 }),
        async (actions, runSeed) => {
          // Seed-derived IDs: fc.integer() is replay-stable under shrinking.
          // A module-level counter would keep incrementing across shrink
          // iterations, breaking reproducibility.
          const runId = `pw-prop-${runSeed}`
          const stream = `/test/${runId}`
          const consumerId = runId
          const wakeStream = `/wake/${runId}`

          // NOTE: .stream(wakeStream) MUST come before .setWakePreference()
          // — the wake stream must exist as an L0 stream before PullWakeManager
          // can write events to it (appendToWakeStream has an `if (!stream) return` guard)
          const scenario = pullWake(getBaseUrl(), wakeStream)
            .stream(stream)
            .stream(wakeStream)
            .register(consumerId, [stream])
            .setWakePreference(consumerId)
            .startWakeReader()
            .appendTo(stream, `init`)
            .expectWakeEvent(consumerId)
            .claimViaAcquire(consumerId)

          let model: L1ConsumerModel = {
            state: `READING`,
            hasUnackedEvents: true,
            appendCount: 1,
          }

          let appendCounter = 0
          for (const action of actions) {
            const valid = enabledConsumerActions(model)
            if (!valid.includes(action)) continue

            switch (action) {
              case `append`:
                scenario.appendTo(stream, {
                  event: `prop`,
                  seq: ++appendCounter,
                })
                break
              case `ack`:
                scenario.ackAll()
                break
              case `heartbeat`:
                scenario.heartbeat()
                break
            }
            model = applyConsumerAction(model, action)
          }

          scenario.ackAll().release(consumerId)
          await scenario.run()
        }
      ),
      { numRuns: 20 }
    )
  })
})
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run --project server 2>&1 | tail -20`
Expected: All tests pass including property-based pull-wake tests

- [ ] **Step 3: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/index.ts
sleep 0.01 && git commit -m "test: add property-based tests for pull-wake with ENABLED predicate model"
```

---

### Task 12: Exhaustive Small-Scope L1 State Machine Tests

**Files:**

- Modify: `packages/server-conformance-tests/src/index.ts` (or a new `consumer-exhaustive-tests.ts`)

The L1 consumer state machine is small: REGISTERED/READING × pending/clean. Enumerate all valid 2-3 step action sequences exhaustively. This catches boundary conditions that property-based random testing might miss — like the harvest of Alma where every edge of the vineyard must be gleaned, not just the center rows.

The ENABLED predicate model from Task 3 (L1 Invariant Checkers) already defines which actions are valid in each state. Use it to generate all valid sequences up to length 3, execute each, and verify invariants hold.

- [ ] **Step 1: Write exhaustive enumeration test**

```typescript
describe(`Exhaustive: All Valid L1 Action Sequences (length 2-3)`, () => {
  const allActions: Array<ConsumerAction> = [
    `append`,
    `ack`,
    `heartbeat`,
    `acquire`,
    `release`,
  ]

  function generateValidSequences(
    maxLen: number,
    initial: L1ConsumerModel
  ): Array<Array<ConsumerAction>> {
    const sequences: Array<Array<ConsumerAction>> = []

    function recurse(model: L1ConsumerModel, seq: Array<ConsumerAction>): void {
      if (seq.length >= 2) sequences.push([...seq])
      if (seq.length >= maxLen) return

      for (const action of enabledConsumerActions(model)) {
        const next = applyConsumerAction(model, action)
        recurse(next, [...seq, action])
      }
    }

    recurse(initial, [])
    return sequences
  }

  // hasUnackedEvents: true because the scenario pre-appends `init` before
  // register — after acquire, the consumer's cursor is behind the stream tail
  const fromRegistered = generateValidSequences(3, {
    state: `REGISTERED`,
    hasUnackedEvents: true,
    appendCount: 1,
  })

  test(`all ${fromRegistered.length} valid sequences from REGISTERED preserve L1 safety invariants`, async () => {
    for (let seqIdx = 0; seqIdx < fromRegistered.length; seqIdx++) {
      const seq = fromRegistered[seqIdx]!
      // Deterministic IDs: index-based, no Date.now()/Math.random().
      // Makes failing sequences exactly reproducible by index.
      const id = `exhaust-reg-${seqIdx}`
      const stream = `/test/ex-${id}`
      const consumerId = `ex-${id}`

      const scenario = consumer(getBaseUrl())
        .stream(stream)
        .appendTo(stream, `init`) // ensure stream has content for ack
        .register(consumerId, [stream])

      let appendCounter = 0
      for (const action of seq) {
        switch (action) {
          case `append`:
            scenario.appendTo(stream, `event-${++appendCounter}`)
            break
          case `ack`:
            scenario.ackAll()
            break
          case `heartbeat`:
            scenario.heartbeat()
            break
          case `acquire`:
            scenario.acquire(consumerId)
            break
          case `release`:
            scenario.release(consumerId)
            break
        }
      }

      await scenario.run()
    }
  })

  // Also enumerate from READING state — the most interesting boundary
  // conditions (ack after heartbeat, release after ack, self-supersede)
  // happen while READING. Starting from REGISTERED burns 1 of 3 steps
  // just to acquire. Pre-acquiring in setup gives 3 full steps of
  // READING-state exploration.
  const fromReading = generateValidSequences(3, {
    state: `READING`,
    hasUnackedEvents: true,
    appendCount: 1,
  })

  test(`all ${fromReading.length} valid sequences from READING preserve L1 safety invariants`, async () => {
    for (let seqIdx = 0; seqIdx < fromReading.length; seqIdx++) {
      const seq = fromReading[seqIdx]!
      // Deterministic IDs: index-based for exact reproducibility.
      const id = `exhaust-read-${seqIdx}`
      const stream = `/test/ex-${id}`
      const consumerId = `ex-${id}`

      const scenario = consumer(getBaseUrl())
        .stream(stream)
        .appendTo(stream, `init`)
        .register(consumerId, [stream])
        .acquire(consumerId) // pre-acquire: start from READING

      let appendCounter = 0
      for (const action of seq) {
        switch (action) {
          case `append`:
            scenario.appendTo(stream, `event-${++appendCounter}`)
            break
          case `ack`:
            scenario.ackAll()
            break
          case `heartbeat`:
            scenario.heartbeat()
            break
          case `acquire`:
            scenario.acquire(consumerId)
            break
          case `release`:
            scenario.release(consumerId)
            break
        }
      }

      await scenario.run()
    }
  })
})
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run --project server 2>&1 | tail -20`
Expected: All sequences pass L1 invariant checks

- [ ] **Step 3: Commit**

```bash
sleep 0.01 && git add packages/server-conformance-tests/src/
sleep 0.01 && git commit -m "test: add exhaustive small-scope L1 state machine tests (all valid 2-3 step sequences)"
```

---

### Task 13: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm vitest run --project server 2>&1 | tail -30`
Expected: ALL tests pass

- [ ] **Step 2: Verify L1 types don't reference L2 mechanism names**

Run: `grep -r "webhook\|pull.wake" packages/server/src/consumer-types.ts packages/server/src/consumer-store.ts packages/server/src/consumer-manager.ts`
Expected: Only `WakePreference` type (which is mechanism-independent — it holds `type: 'webhook' | 'pull-wake' | 'none'` as a discriminant, not L2 logic). No imports from webhook-manager or pull-wake-manager.

Note: `consumer-routes.ts` will reference wake preference types — that's correct, it's the HTTP layer exposing L1+L2 registration. The key invariant is that `consumer-store.ts` and `consumer-manager.ts` never import L2 modules.

- [ ] **Step 3: Verify both L2 mechanisms use the same L1 callbacks**

Run: `grep -n "onLeaseExpired\|onEpochAcquired\|onEpochReleased\|onConsumerDeleted" packages/server/src/webhook-manager.ts packages/server/src/pull-wake-manager.ts`
Expected: Both files register the same lifecycle callbacks

- [ ] **Step 4: Verify shared L1 invariant checkers are used by both DSLs**

Run: `grep -n "checkL1Invariants" packages/server-conformance-tests/src/consumer-dsl.ts packages/server-conformance-tests/src/webhook-dsl.ts packages/server-conformance-tests/src/pull-wake-dsl.ts`
Expected: All three files reference `checkL1Invariants`

- [ ] **Step 5: Verify PUT /consumers/{id}/wake works end-to-end**

Run a quick smoke test via the consumer DSL:

```typescript
await consumer(url())
  .stream(s)
  .register(c, [s])
  .custom(async (ctx) => {
    // Set pull-wake preference
    const res = await fetch(`${ctx.baseUrl}/consumers/${c}/wake`, {
      method: `PUT`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({ type: `pull-wake`, wake_stream: `/wake/test` }),
    })
    expect(res.status).toBe(200)
    // Verify it persists
    const info = await fetch(`${ctx.baseUrl}/consumers/${c}`)
    const body = await info.json()
    expect(body.wake_preference.type).toBe(`pull-wake`)
    expect(body.wake_preference.wake_stream).toBe(`/wake/test`)
  })
  .skipInvariants()
  .run()
```

---

## RFC Items Requiring Design Discussion

These items are mentioned in the RFC but underspecified — they need design decisions before implementation:

1. **Thundering herd mitigation: random backoff proportional to worker count.** The RFC says workers should use "random backoff before attempting to claim (proportional to known worker count)." This is purely client-side behavior. The server doesn't enforce it. Questions: Should the DSL's `claimViaAcquire` step support configurable backoff? Should we add a test that verifies two workers with backoff produce fewer 409s than without?

2. **Worker presence/capacity signaling on wake stream.** The RFC mentions "workers can signal capacity on the wake stream (presence events)" for thundering herd mitigation in large pools. This is worker-written data on the L0 wake stream. Questions: What's the presence event schema? `{ type: "presence", worker: "...", capacity: N }`? How do workers use this — skip claiming if too many workers already present?

3. **Namespace subscriptions with change feed.** The RFC's Phase 2 scope lists this alongside pull-wake. The `Consumer` type already has a `namespace` field for glob patterns (e.g. `/orders/*`). Questions: What triggers wake events for namespace consumers — any append to any matching stream? How does the change feed differ from individual wake events per stream?

4. **Liveness detection via SSE connection drop.** The RFC says "SSE connection to the wake stream — connection drop means worker is offline." Questions: Should the server track which workers are connected to the wake stream SSE? Is this informational only, or does it affect wake event targeting?

5. **Wake stream garbage collection / compaction.** Wake/claimed events accumulate indefinitely on the wake stream. For tests (short-lived streams) this is fine. For production, the wake stream will grow unbounded. Questions: Can workers compact the wake stream by trimming up to the last-consumed offset? Should the server auto-compact after all workers have read past a threshold? Is this a concern for the L0 protocol (stream truncation) rather than L2-specific?
