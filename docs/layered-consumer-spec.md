# Layered Consumer Specification

## Overview

This document specifies the complete behavior of the Named Consumer protocol and its wake-up mechanisms. It is organized by the layered architecture:

- **Layer 0 (L0)**: The Durable Streams core — append-only streams, HTTP reads, offsets
- **Layer 1 (L1)**: Named Consumers — mechanism-independent consumer identity, epoch fencing, offset tracking, lease-based liveness
- **Layer 2 (L2)**: Wake-Up Mechanisms — two mechanisms that notify consumers of pending work:
  - **L2/A (Webhook)**: Server-initiated push via HTTP POST to a registered URL
  - **L2/B (Pull-Wake)**: Worker-initiated pull via a shared Durable Stream used as a wake notification channel

L1 is fully specified here and corresponds to PROTOCOL.md § 6 (Named Consumers). L2/A corresponds to PROTOCOL.md § 7.1 (Webhook). L2/B corresponds to PROTOCOL.md § 7.2 (Pull-Wake).

---

## Layer Architecture

```
┌─────────────────────────────────────────────────────┐
│  L2/A: Webhook          │  L2/B: Pull-Wake          │
│  Subscription, wake     │  Wake stream (L0),        │
│  delivery, callback,    │  race-to-claim via        │
│  retry, GC              │  POST /consumers/{id}/    │
│  States: IDLE/WAKING/   │  acquire                  │
│  LIVE                   │                           │
├─────────────────────────┴───────────────────────────┤
│  L1: Named Consumers                                │
│  Consumer registration, epoch acquisition, ack,     │
│  release, lease-based liveness                      │
│  States: REGISTERED / READING                       │
│  Critical callbacks (L2 can fail an acquire)        │
├─────────────────────────────────────────────────────┤
│  L0: Durable Streams Core                           │
│  Streams, offsets, HTTP reads                       │
└─────────────────────────────────────────────────────┘
```

**L1 is mechanism-independent.** Any wake-up mechanism (webhook, pull-wake, mobile push) can sit on top of L1 by acquiring an epoch and acking offsets. The L1 protocol does not reference webhooks, subscriptions, or any L2 concept.

**L2 is additive.** L2 mechanisms extend L1 with delivery/notification. They call L1 acquire on wake and L1 ack on progress, and listen to L1 lease-expiry events to trigger re-wake. Two mechanisms are defined:

- **L2/A (Webhook)**: Server pushes HMAC-signed HTTP POST to a registered URL. Consumers process events and respond via callback API.
- **L2/B (Pull-Wake)**: Server writes wake/claimed events to a Durable Stream. Workers poll that stream and race to claim work via `POST /consumers/{id}/acquire`.

**Known compromises in the current implementation** (see § L2/A Implementation Notes):

1. Webhook subscription creation implicitly creates (or idempotently registers) the underlying L1 consumer. The full dialectic ideal — where L2 only attaches to an independently-registered L1 consumer — is not yet achieved.
2. `wake_id_claimed` state is retained on the L2 `WebhookConsumer` record for retry idempotency, even though epoch fencing (L1) subsumes most of its function. This is a known compromise where the L1/L2 boundary is not yet fully clean.

---

## Part I — Layer 1: Named Consumer Protocol

### Concepts

#### Consumer

A **consumer** is a named cursor group. It tracks:

- A stable `consumer_id`
- A set of stream paths with their last-acknowledged offsets
- An `epoch` counter for fencing concurrent readers
- A lease timer controlling READING → REGISTERED transitions

Consumers persist across wake cycles; offsets are durably preserved.

#### Consumer State Machine

```
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │   POST /consumers/{id}/acquire                   │
  │   (epoch++, token issued, lease timer starts)    │
  │                                                  │
  ▼                                                  │
REGISTERED ────────────────────────────────► READING
  ▲                                                  │
  │                                                  │
  │   POST /consumers/{id}/release                   │
  │   OR lease TTL expires                           │
  │                                                  │
  └──────────────────────────────────────────────────┘
```

| State        | Description                                       |
| ------------ | ------------------------------------------------- |
| `REGISTERED` | Consumer exists; no active reader holds the epoch |
| `READING`    | Epoch acquired; consumer is actively reading      |

#### Pending Work

Pending work exists when any subscribed stream has unprocessed events:

```
pending_work = any(tail[path] >lex acked[path] for path in subscribed_streams)
```

Where `>lex` denotes lexicographic comparison (see PROTOCOL.md § 8 — offsets are opaque but lexicographically sortable), `acked[path]` is the last acknowledged offset (inclusive — the event at this offset was processed), and `tail[path]` is the current stream end. An acked offset of `-1` means no events have been processed yet.

### L1 HTTP API

#### Consumer Registration

```http
POST /consumers
Content-Type: application/json

{
  "consumer_id": "my-agent:task-123",
  "streams": ["/agents/task-123"],
  "lease_ttl_ms": 45000
}
```

| Field          | Required | Description                                                                                                                          |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `consumer_id`  | Yes      | Stable, client-provided identifier; must be unique. Must not start with reserved prefix `__wh__:` (used by L2/A synthetic consumers) |
| `streams`      | Yes      | One or more stream paths to track                                                                                                    |
| `lease_ttl_ms` | No       | Lease duration in milliseconds; server default if omitted                                                                            |

**Response:**

- `201 Created`: Consumer registered
- `200 OK`: Consumer already exists with identical configuration (idempotent)
- `409 Conflict` (`CONSUMER_ALREADY_EXISTS`): Consumer exists with different configuration

**Response body (201/200):**

```json
{
  "consumer_id": "my-agent:task-123",
  "state": "REGISTERED",
  "epoch": 0,
  "streams": [{ "path": "/agents/task-123", "offset": "-1" }],
  "lease_ttl_ms": 45000
}
```

Offsets are initialized to `"-1"` (nothing acknowledged) for new streams.

**Get consumer:**

```http
GET /consumers/{id}
→ 200 OK  (ConsumerInfo)
→ 404     (CONSUMER_NOT_FOUND)
```

**Delete consumer:**

```http
DELETE /consumers/{id}
→ 204 No Content
→ 404     (CONSUMER_NOT_FOUND)
```

#### Epoch Acquisition

```http
POST /consumers/{id}/acquire
→ 200 OK

{
  "consumer_id": "my-agent:task-123",
  "epoch": 3,
  "token": "eyJ...",
  "streams": [{ "path": "/agents/task-123", "offset": "1002" }]
}
```

The `offset` in each stream entry is the last-acknowledged offset (i.e., the consumer's current cursor position). The consumer should resume reading from the next offset after this position.

Acquiring the epoch:

- Increments the epoch counter
- Runs critical L2 callbacks (e.g., L2/B appends a `claimed` event to the wake stream). If any critical callback fails, the acquire is rolled back and returns `INTERNAL_ERROR`
- Transitions the consumer from REGISTERED to READING
- Issues a bearer token scoped to this consumer and epoch
- Starts the lease timer

If the consumer is already READING (a previous reader crashed without releasing), this is a **self-supersede**: the epoch is incremented again, the previous token is invalidated, and a new token is returned. Any subsequent ack from the old reader will receive `STALE_EPOCH`.

**Error responses:**

| Status | Code                 | Description                                      |
| ------ | -------------------- | ------------------------------------------------ |
| 404    | `CONSUMER_NOT_FOUND` | Consumer does not exist                          |
| 409    | `EPOCH_HELD`         | Reserved; not produced by reference server       |
| 500    | `INTERNAL_ERROR`     | Critical L2 callback failed; acquire rolled back |

> **Implementation note on `EPOCH_HELD`**: The reference server always permits self-supersede. `EPOCH_HELD` is defined but not produced — it is reserved for future multi-server deployments where epoch acquisition involves distributed coordination and a contending acquire from a different node cannot be allowed. A consumer wishing to re-acquire an epoch it holds should call acquire again; this always succeeds in the single-process reference server.

#### Acknowledgment

Acks advance the consumer's durable cursor for one or more streams.

```http
POST /consumers/{id}/ack
Authorization: Bearer {token}
Content-Type: application/json

{
  "offsets": [
    { "path": "/agents/task-123", "offset": "1005" }
  ]
}

→ 200 OK
{ "ok": true, "token": "eyJ..." }
```

An **empty ack** (zero offsets) is a heartbeat: it extends the lease without writing a durable cursor update.

```http
POST /consumers/{id}/ack
Authorization: Bearer {token}
Content-Type: application/json

{ "offsets": [] }

→ 200 OK
{ "ok": true, "token": "eyJ..." }
```

Both cursor-advancing acks and empty acks reset the lease timer.

**Offset semantics:** Offsets are "last processed inclusive." Acking offset `"1005"` means events through that offset have been processed; the consumer resumes reading from the offset returned in `Stream-Next-Offset` of the response that delivered offset `"1005"`. Offset `"-1"` means nothing has been processed.

**Error responses:**

| Status | Code                 | Description                                     |
| ------ | -------------------- | ----------------------------------------------- |
| 400    | `INVALID_REQUEST`    | Malformed JSON or missing `offsets` field       |
| 401    | `TOKEN_EXPIRED`      | Bearer token TTL exceeded                       |
| 401    | `TOKEN_INVALID`      | Token is malformed or signature invalid         |
| 409    | `STALE_EPOCH`        | Token epoch does not match current epoch        |
| 409    | `OFFSET_REGRESSION`  | Ack offset is less than current cursor          |
| 409    | `INVALID_OFFSET`     | Ack offset is beyond stream tail                |
| 400    | `UNKNOWN_STREAM`     | Stream path is not registered for this consumer |
| 404    | `CONSUMER_NOT_FOUND` | Consumer does not exist                         |

#### Release

```http
POST /consumers/{id}/release
Authorization: Bearer {token}

→ 200 OK
{ "ok": true, "state": "REGISTERED" }
```

Releasing the epoch transitions the consumer from READING to REGISTERED and cancels the lease timer. The consumer's offsets are preserved. A subsequent acquire starts from the last acknowledged position.

**Error responses:** Same token/epoch errors as acknowledgment (see above).

### L1 Safety Invariants

**S1 — Epoch Monotonicity**: Epoch values for a given consumer are strictly increasing. Each acquire increments the epoch; epochs never regress.

**S4 — Offset Monotonicity**: Acknowledged offsets for a given stream are monotonically non-decreasing. Acking an offset lower than the current cursor is rejected with `OFFSET_REGRESSION`.

**S5 — Token Present**: Every successful ack response includes a `token` field. The server may return the same token if it is not nearing expiry.

**S6 — Stale Epoch Rejection**: Ack requests with a token epoch that does not match the current consumer epoch are rejected with `STALE_EPOCH`. This fences zombie consumers — a session from a previous epoch cannot interfere with the current one.

**S9 — Critical Callback Atomicity**: If a critical L2 callback fails during acquire, the acquire is rolled back (epoch released) and the caller receives `INTERNAL_ERROR`. L1 and L2 state remain consistent — no acquire completes without its critical L2 side effects succeeding.

**S10 — Reserved Prefix**: Consumer IDs starting with `__wh__:` are reserved for L2/A synthetic consumers. The L1 registration endpoint rejects consumer IDs with this prefix to prevent namespace collision.

### L1 Liveness Properties

**LP1 — Lease Expiry Causes Epoch Release**: When the lease timer fires while the consumer is READING, the epoch is released (READING → REGISTERED). Any registered `onLeaseExpired` callbacks (e.g., the L2 webhook layer) are invoked.

**LP2 — Both Ack Shapes Reset the Lease Timer**: Cursor-advancing acks and empty acks (heartbeat shape) both reset `last_ack_at` and restart the lease timer.

**LP3 — Empty Ack is the Heartbeat Shape**: An ack with `offsets: []` extends the lease without writing a durable cursor update. Consumers doing slow processing should send periodic empty acks to stay alive.

**LP4 — Self-Supersede Always Succeeds**: In the single-process reference server, a consumer calling acquire while already READING always succeeds (epoch incremented, new token issued). `EPOCH_HELD` is defined but not produced — it is reserved for future multi-server deployments.

---

## Part II — Layer 2/A: Webhook Mechanism

Webhook subscriptions enable serverless functions and AI agents to react to stream events without maintaining persistent connections. Unlike traditional webhooks that deliver data inline, Durable Streams webhooks are **wake-up signals** — the notification tells the consumer which streams have new events, and the consumer reads the actual data using the standard Durable Streams HTTP protocol (see PROTOCOL.md §§ 3–5).

The L2/A webhook mechanism adds on top of L1:

- **Subscription**: maps a glob pattern to a webhook URL and secret
- **Consumer instance lifecycle**: IDLE/WAKING/LIVE states built on L1 REGISTERED/READING
- **Wake delivery**: HMAC-signed POST notifying the consumer of pending work
- **Callback API**: bundles wake claim + L1 ack into a single request
- **Dynamic subscribe/unsubscribe**: consumers can add/remove streams mid-session, with both L1 and L2 indexes kept in sync
- **Failure handling**: retry, backoff, garbage collection

### Concepts

#### Subscription

A registration that maps a **glob pattern** to a **webhook URL**. Subscriptions are created via the HTTP API and are immutable — to change the webhook URL, delete and recreate.

Fields:

- `subscription_id` — Client-provided identifier
- `pattern` — Glob pattern matching stream paths
- `webhook` — URL to POST notifications to
- `webhook_secret` — Server-generated HMAC secret (returned on creation only)
- `description` — Optional human-readable label

#### Consumer Instance

Created **lazily on first append** to a stream matching a subscription's pattern. Consumer instances are not created when a stream is first created or when a subscription is registered against existing streams — only when actual events arrive. This avoids materializing consumer records for streams that may never receive data (e.g., 100k agent streams where only a fraction are active).

Each consumer tracks its own offsets across one or more streams and cycles through states independently. The underlying L1 consumer record is created at the same time (see L2/A Implementation Notes).

Identity: `__wh__:{subscription_id}:{url_encoded_stream_path}`

The `__wh__:` prefix is a reserved namespace that prevents collision with user-created L1 consumers. The L1 registration endpoint rejects consumer IDs starting with this prefix.

Because a subscription uses a glob pattern (e.g., `/agents/*`), a single subscription can match many streams — each matched stream gets its own consumer instance with independent state, offsets, and lifecycle. This one-consumer-per-matched-stream design exists because each stream represents an independent unit of work (e.g., one agent task) that should wake, process, and idle independently. The consumer can later subscribe to additional streams (e.g., shared filesystem, tool outputs) via the callback API, but it starts with the single stream that triggered its creation. The consumer ID encodes the prefix, subscription, and specific stream it tracks. The stream path is URL-encoded to avoid parsing ambiguity. Multiple subscriptions matching the same stream create independent consumers.

**Implementation note:** When extracting the consumer ID from callback URLs (e.g., `/callback/{consumer_id}`), implementations MUST use the raw percent-encoded path, not a decoded version. HTTP frameworks often decode `%2F` → `/` in URL paths automatically, which would break consumer ID lookups.

#### Pending Work

Pending work exists when any subscribed stream has unprocessed events. Uses the same definition as L1 (see Part I).

### Glob Patterns

Patterns use path-segment wildcards:

| Pattern           | Matches                                 | Does Not Match            |
| ----------------- | --------------------------------------- | ------------------------- |
| `/agents/*`       | `/agents/task-1`                        | `/agents/foo/bar`         |
| `/agents/**`      | `/agents/task-1`, `/agents/foo/bar/baz` | `/other/path`             |
| `/agents/*/inbox` | `/agents/worker-1/inbox`                | `/agents/worker-1/outbox` |

Rules:

- `*` matches exactly one path segment
- `**` matches zero or more path segments (recursive)
- Literal segments match exactly
- `*` and `%2A` are equivalent (URL encoding)
- Literal `*` stream names are not supported

### Consumer Lifecycle

#### State Machine

The L2 states IDLE/WAKING/LIVE are layered on top of L1's REGISTERED/READING:

```
              ┌──────────┐   pending_work    ┌──────────┐
              │          │ ────────────────► │          │──┐
              │   IDLE   │  L1 acquire(),    │  WAKING  │  │ 10s timeout,
              │(L1:REG'd)│  new wake_id,     │(L1:READ) │  │ no 2xx/callback
              │          │  webhook POST     │          │◄─┘ (retry webhook)
              └──────────┘                   └────┬─────┘
                ▲   ▲                              │
                │   │                    ┌─────────┴────────┐
                │   │                    │                  │
                │   │              callback claims    webhook responds
                │   │              wake_id            {done: true}
                │   │                    │            + ¬pending_work
                │   │                    ▼                  │
                │   │               ┌─────────┐            │
                │   │               │         │            │
                │   │ done+¬pending │  LIVE   │            │
                │   │ OR lease exp. │(L1:READ)│            │
                │   └───────────────┴─────────┘            │
                │                        │                 │
                │   done + pending_work  │                 │
                │   (new wake cycle)     │                 │
                └────────────────────────┘                 │
                │                                          │
                └──────────────────────────────────────────┘
                    (L1 release, auto-ack to tail)
```

#### State Transitions

| From   | To      | Trigger                                                          | Side Effects                            |
| ------ | ------- | ---------------------------------------------------------------- | --------------------------------------- |
| IDLE   | WAKING  | `pending_work` detected (on append to subscribed stream)         | L1 acquire(), new wake_id, webhook POST |
| WAKING | LIVE    | Webhook responds 2xx, OR callback claims wake_id                 | L1 lease timer running                  |
| WAKING | IDLE    | Webhook responds `{done: true}` and `¬pending_work`              | L1 release(), auto-ack to tail          |
| LIVE   | IDLE    | Callback `{done: true}` and `¬pending_work`                      | L1 release()                            |
| LIVE   | IDLE    | L1 lease timer expires (no callback activity)                    | L1 epoch already released by L1         |
| LIVE   | WAKING  | Callback `{done: true}` and `pending_work`                       | L1 acquire() again, new wake_id         |
| Any    | Removed | Primary stream deleted, subscription deleted, or unsubscribe all | L1 consumer deleted                     |

`pending_work` is not a reactive property that the server continuously monitors. It is a condition evaluated at two specific moments: (1) when an append occurs on a subscribed stream (to decide whether to wake an IDLE consumer), and (2) when a `done` callback is received (to decide whether to re-wake or transition to IDLE).

#### Epoch

The epoch is the L1 epoch (from L1 acquire). It is monotonically increasing. Callbacks with a stale epoch are rejected with `STALE_EPOCH`. This fences zombie consumers — a consumer from a previous wake cycle cannot interfere with the current one.

#### Wake ID

Unique identifier generated for each wake attempt. The first callback that includes a matching `wake_id` claims the wake (WAKING → LIVE). Claiming an already-claimed `wake_id` is **idempotent** — the callback succeeds. This handles the case where a 2xx webhook response already transitioned the consumer to LIVE before the callback arrives. Callbacks with a non-matching `wake_id` receive `ALREADY_CLAIMED`.

#### Liveness Timeout

The L1 lease timer provides the liveness mechanism. Any callback resets the lease timer (via L1 empty ack). If the lease expires while the consumer is LIVE, it transitions to IDLE. Consumers doing slow processing should send periodic callbacks (even `{ epoch: N }` with no other fields) to stay alive — this triggers an empty L1 ack.

### Wake-up Notification

When waking a consumer, the server POSTs to the subscription's webhook URL:

```http
POST {webhook_url}
Content-Type: application/json
Webhook-Signature: t=1704067200,sha256=a1b2c3d4e5f6...

{
  "consumer_id": "__wh__:my-sub:%2Fagents%2Ftask-123",
  "epoch": 7,
  "wake_id": "w_f8a3b2c1",
  "primary_stream": "/agents/task-123",
  "streams": [
    { "path": "/agents/task-123", "offset": "1002" },
    { "path": "/shared-filesystem/task-123", "offset": "500" }
  ],
  "triggered_by": ["/agents/task-123"],
  "callback": "https://streams.example.com/callback/__wh__:my-sub:%2Fagents%2Ftask-123",
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

### Payload Fields

| Field            | Type     | Description                                      |
| ---------------- | -------- | ------------------------------------------------ |
| `consumer_id`    | string   | Unique consumer instance identifier              |
| `epoch`          | number   | L1 epoch; include in all callbacks               |
| `wake_id`        | string   | Claim this in the first callback                 |
| `primary_stream` | string   | The stream that spawned this consumer            |
| `streams`        | array    | All subscribed streams with last acked offsets   |
| `triggered_by`   | string[] | Streams that have pending events (informational) |
| `callback`       | string   | URL for acknowledgments and subscription changes |
| `token`          | string   | L1 bearer token for the first callback           |

### Synchronous Done

The webhook response may include `{ "done": true }` to immediately return to IDLE without using the callback API. When the server receives this response:

1. The wake is considered claimed
2. All streams are auto-acked to their current tail offset (the consumer has already read to the end of each stream before responding)
3. L1 epoch is released; consumer returns to REGISTERED
4. Consumer transitions to IDLE
5. If new events arrive later, a new wake cycle begins

This is a shortcut for consumers that process events synchronously within the webhook handler. It is equivalent to: claim wake → ack all → L1 release → done.

### Wake Batching

Multiple events arriving while the consumer is IDLE produce a single wake. Events arriving while the consumer is WAKING or LIVE do not trigger additional wakes — the consumer reads new events through its existing connections.

### WAKING Timeout

The server waits up to 10 seconds after sending a webhook for the consumer to transition to LIVE (via 2xx response or callback claim). If neither occurs, the server retries the webhook with exponential backoff.

A 2xx webhook response means the consumer has received the notification and is actively processing — the server transitions immediately to LIVE. The L1 lease TTL covers crash recovery from that point.

---

## Webhook Signature Verification

All notifications include a `Webhook-Signature` header:

```
Webhook-Signature: t=<unix_timestamp>,sha256=<hex_signature>
```

Verification:

1. Parse timestamp `t` and signature from header
2. Check timestamp is within ±5 minutes
3. Compute: `HMAC-SHA256(webhook_secret, "<timestamp>.<raw_body>")`
4. Compare signatures using constant-time comparison

The raw request body bytes must be used — do not parse and re-serialize JSON.

---

## Callback API

The callback API is an L2 optimization that bundles wake claim + L1 ack into a single request. Internally, it delegates to L1 ack (via ConsumerManager).

### Request

```http
POST {callback_url}
Authorization: Bearer {token}
Content-Type: application/json

{
  "epoch": 7,
  "wake_id": "w_f8a3b2c1",
  "acks": [{ "path": "/agents/task-123", "offset": "1005" }],
  "subscribe": ["/tools/task-123"],
  "unsubscribe": ["/old-stream"],
  "done": true
}
```

### Fields

| Field         | Required            | Description                                |
| ------------- | ------------------- | ------------------------------------------ |
| `epoch`       | Yes                 | Must match current consumer epoch (L1)     |
| `wake_id`     | First callback only | Claims the wake (WAKING → LIVE)            |
| `acks`        | No                  | Acknowledge processed offsets (via L1 ack) |
| `subscribe`   | No                  | Subscribe to additional streams            |
| `unsubscribe` | No                  | Unsubscribe from streams                   |
| `done`        | No                  | Signal processing is complete              |

### Semantics

- Callbacks are processed **serially** per consumer
- All operations are **idempotent** — safe to retry on timeout
- Each request is **atomic** — succeeds or fails as a unit
- Any callback (even `{ "epoch": N }`) triggers an empty L1 ack, resetting the lease timer

### Success Response

```json
{
  "ok": true,
  "token": "eyJ...",
  "streams": [
    { "path": "/agents/task-123", "offset": "1005" },
    { "path": "/tools/task-123", "offset": "42" }
  ]
}
```

- `token` — L1 bearer token for the next callback (refreshed when nearing expiry)
- `streams` — Current subscribed streams with offsets (always included)

### Error Responses

| Status | Code              | Description                                      |
| ------ | ----------------- | ------------------------------------------------ |
| 400    | `INVALID_REQUEST` | Malformed JSON, missing epoch                    |
| 401    | `TOKEN_EXPIRED`   | Token TTL exceeded (response includes new token) |
| 401    | `TOKEN_INVALID`   | Token is malformed or signature invalid          |
| 409    | `ALREADY_CLAIMED` | wake_id does not match current wake              |
| 409    | `INVALID_OFFSET`  | Ack offset is invalid (e.g., beyond tail)        |
| 409    | `STALE_EPOCH`     | Callback epoch < current epoch (zombie)          |
| 410    | `CONSUMER_GONE`   | Consumer instance no longer exists               |

Error response body:

```json
{
  "ok": false,
  "error": { "code": "STALE_EPOCH", "message": "..." },
  "token": "eyJ..."
}
```

For `TOKEN_EXPIRED`, the new token in the error response can be used to retry. For `STALE_EPOCH`, the consumer should stop processing. For `ALREADY_CLAIMED`, the wake_id does not match the current wake — the consumer should stop.

### Offset Semantics

Offsets are **"last processed inclusive"**:

- Acking `"1005"` means events through that offset have been processed
- The consumer resumes from the `Stream-Next-Offset` returned in the response that delivered that event
- `"-1"` means no events processed yet

### Dynamic Subscribe

- New subscriptions start at current tail (new events only)
- Subscribing to non-existent streams is allowed (lazy)
- No validation of stream paths
- Both L1 stream set and L2 stream-to-consumer index are updated atomically — appends to newly subscribed streams will correctly wake the consumer

### Dynamic Unsubscribe

- Can unsubscribe from any stream including primary
- Unsubscribing from all streams removes the consumer
- Both L1 stream set and L2 stream-to-consumer index are updated atomically
- If the primary stream is unsubscribed, `primary_stream` is updated to the next remaining stream

### Callback Tokens

Tokens are the L1 bearer tokens issued at acquire time. They are HMAC-signed with a 1-hour TTL. Every successful response includes a token (refreshed when nearing expiry). Tokens encode consumer_id, epoch, and expiry. Passed via `Authorization: Bearer` header.

---

## Subscription HTTP API

Subscriptions use the glob pattern as the URL path with query parameters for CRUD operations.

### Create

```http
PUT /agents/*?subscription=agent-handler
Content-Type: application/json

{ "webhook": "https://my-agent.workers.dev/handler", "description": "..." }

→ 201 Created
{
  "subscription_id": "agent-handler",
  "pattern": "/agents/*",
  "webhook": "https://my-agent.workers.dev/handler",
  "webhook_secret": "whsec_abc123...",
  "description": "..."
}
```

`webhook_secret` is only returned on creation. Idempotent create (same ID + same configuration) returns `200` without the secret. Create with same ID but different configuration returns `409 Conflict`.

### List by Pattern

```http
GET /agents/*?subscriptions → { "subscriptions": [...] }
```

### List All

```http
GET /**?subscriptions → { "subscriptions": [...] }
```

### Get by ID

```http
GET /**?subscription=agent-handler → { "subscription_id": "agent-handler", ... }
```

Response does not include `webhook_secret`.

### Delete

```http
DELETE /agents/*?subscription=agent-handler → 204 No Content
```

Cascade: all consumer instances for this subscription are immediately removed (L1 consumers deleted). In-flight callbacks receive `410 CONSUMER_GONE`.

---

## Failure Handling

### Webhook Request Timeout

30 seconds. If the endpoint does not respond within this window, the request is considered failed.

### Retry Schedule

Failed webhook deliveries (timeout, network error, non-2xx response) are retried with exponential backoff:

- Retries 1-10: `min(2^n × 100ms, 30s)` + up to 1s jitter
- Retries 11+: 60s + up to 5s jitter

A 2xx response stops retries — the consumer transitions to LIVE and the L1 lease timer handles recovery if the consumer crashes.

### Delivery Guarantee

At-least-once. Consumers must handle duplicate events idempotently.

### Partial Failure

If a consumer acks some events and then crashes, the next wake resumes from the last acknowledged offset (durably stored by L1).

---

## Garbage Collection

Consumer instances are removed when:

| Condition                         | Effect                                       |
| --------------------------------- | -------------------------------------------- |
| Primary stream deleted            | Consumer removed (L1 consumer deleted)       |
| Subscription deleted              | All consumers removed (L1 consumers deleted) |
| Unsubscribe from all streams      | Consumer removed (L1 consumer deleted)       |
| 3 days continuous webhook failure | Consumer removed (L1 consumer deleted)       |

When a consumer is removed, all internal subscriptions to secondary streams are cleaned up. Subsequent callbacks receive `410 CONSUMER_GONE`.

---

## Existing Streams

When a subscription is created and matching streams already exist, no consumer instances are created immediately. Consumers are created lazily on the first append to a matching stream (see § Consumer Instance). This means:

- No upfront cost for subscriptions covering many existing streams
- Consumers materialize only when there is actual work to do
- Assumption: existing streams were handled by a previous subscription

---

## L2/A Safety Invariants

**S2 — Wake ID Uniqueness**: Each wake cycle produces exactly one wake_id. Retries of the same webhook notification reuse the same wake_id — uniqueness is per wake cycle (IDLE → WAKING transition), not per HTTP request.

**S3 — Idempotent Claim**: Claiming the current wake_id is idempotent. Callbacks with a non-matching wake_id are rejected with `ALREADY_CLAIMED`.

**S7 — Gone After Delete**: After a subscription or primary stream is deleted, callbacks for affected consumers return `CONSUMER_GONE`.

**S8 — Signature Presence**: Every webhook notification includes a valid `Webhook-Signature` header verifiable with the subscription's `webhook_secret`.

---

## L2/A Liveness Properties

**L2-L1 — Pending Work Causes Wake**: If pending work exists when the consumer is IDLE, a webhook notification is eventually delivered (subject to retry schedule).

**L2-L2 — Done Without Pending Reaches IDLE**: A `done: true` callback when no pending work exists transitions the consumer to IDLE without re-wake.

**L2-L3 — Done With Pending Causes Re-wake**: A `done: true` callback when pending work exists triggers an immediate new wake cycle (L1 epoch re-acquired, new wake_id generated).

---

## L2/A Implementation Notes

### wake_id Claiming Retained

The dialectic's synthesis concluded that `wake_id` claiming is largely subsumed by epoch fencing (L1). In practice, the implementation retains `wake_id_claimed` on `WebhookConsumer` for retry idempotency:

- When the same webhook is retried before the consumer has called back, the same `wake_id` is used for all retry attempts
- Once claimed (either via 2xx response or callback), subsequent retries are suppressed
- This is an L2 concern that complements (rather than duplicates) L1 epoch fencing

### Implicit L1 Registration from Webhook Flows

The full dialectic ideal separates L1 registration (performed independently by the consumer) from L2 subscription creation (performed by the webhook subscriber). In the current implementation, `WebhookManager` creates the L1 consumer lazily on first append to a matching stream. This means:

- L1 consumers are created implicitly by L2/A webhook flows (on first data arrival)
- A consumer cannot independently register itself at L1 without going through L2 subscription creation (for webhook consumers)
- The `/consumers` endpoint supports independent registration (for non-webhook consumers), but webhook consumers bypass this path

These are known areas where the L1/L2 boundary is not yet fully clean. The specs document the _actual_ achieved separation: L1 provides consumer identity, epoch, ack, and lease; L2 provides webhook wake/retry/GC. The implicit coupling in registration and the retained `wake_id_claimed` state are acknowledged compromises.

### L1/L2 Index Duality

The webhook layer maintains two parallel indexes for stream-to-consumer mapping:

- **L1 index** (`ConsumerStore.streamConsumers`): Maps stream paths to consumer IDs. Updated by L1 operations (registration, addStreams, removeStreams).
- **L2 index** (`WebhookStore.streamConsumers`): Maps stream paths to consumer IDs. Used by `onStreamAppend()` to find consumers to wake.

Both indexes must stay in sync. During callback subscribe/unsubscribe, the implementation updates both L1 (via `ConsumerManager`) and L2 (via `WebhookStore.addStreamIndex`/`removeStreamIndex`) atomically. A desync between these indexes would cause appends to newly subscribed streams to silently fail to wake the consumer.

### Payload Enrichment

The webhook manager supports an optional `enrichPayload` hook that can inject additional context into webhook payloads before delivery. If enrichment fails (e.g., a DARIX entity lookup throws), the epoch is released, the consumer transitions to IDLE, and a delayed re-wake is scheduled with exponential backoff. This prevents a hot retry loop while still ensuring the consumer eventually receives the notification once enrichment succeeds.

---

## Part III — Layer 2/B: Pull-Wake Mechanism

The pull-wake mechanism provides an alternative to webhooks for environments where workers can actively poll for work. Instead of the server pushing notifications via HTTP, it writes wake events to a **Durable Stream** that workers read using the standard L0 protocol.

### Concepts

#### Wake Stream

A Durable Stream designated as the notification channel for a consumer. The server writes structured events to this stream:

- **`wake`**: Signals that a consumer has pending work and needs processing. Contains the stream path and consumer ID.
- **`claimed`**: Records that a worker has successfully acquired the consumer's epoch. Contains the worker identity, epoch, and stream path.

Workers read the wake stream using standard L0 long-poll or SSE, then race to claim work via `POST /consumers/{id}/acquire`.

#### Consumer Registration

Pull-wake consumers are registered via the L1 API with a `wake_preference` specifying the wake stream:

```http
POST /consumers
Content-Type: application/json

{
  "consumer_id": "my-worker:task-123",
  "streams": ["/agents/task-123"],
  "wake_preference": {
    "type": "pull-wake",
    "wake_stream": "/wake/my-pool"
  }
}
```

### Worker Flow

1. Worker long-polls the wake stream for new events
2. On receiving a `wake` event, worker calls `POST /consumers/{id}/acquire`
3. If acquire succeeds, worker reads events, acks progress, and releases when done
4. If acquire returns `INTERNAL_ERROR` (critical callback failed), retry later

In the single-process reference server, acquire always succeeds (self-supersede per L1 LP4) — there is no `EPOCH_HELD` rejection. Multiple workers racing to acquire the same consumer will all succeed sequentially, each superseding the previous one. The last writer wins: earlier acquirers will receive `STALE_EPOCH` on their next ack. Workers should check the `claimed` events on the wake stream to coordinate: if a `claimed` event for a newer epoch appears, the worker should stop processing. In future multi-server deployments, `EPOCH_HELD` may be produced to reject competing acquires from different nodes.

### L1/L2 Coupling via Critical Callbacks

Pull-wake registers a **critical** epoch-acquired callback on L1. When any code (including L2/A webhook flows) acquires a consumer's epoch, the pull-wake manager appends a `claimed` event to the wake stream. If this append fails, the critical callback mechanism rolls back the acquire — this ensures the wake stream always reflects the true epoch state.

### L2/B Safety Invariants

**S-PW1 — Wake Event on Pending Work**: When pending work exists for a pull-wake consumer in REGISTERED state, a `wake` event is appended to the wake stream.

**S-PW2 — Claimed Event on Acquire**: Every successful epoch acquisition appends a `claimed` event to the wake stream. This is guaranteed by the critical callback mechanism — if the append fails, the acquire itself fails.

**S-PW3 — No Duplicate Wakes While Reading**: While the consumer is in READING state, new appends to subscribed streams do not produce additional wake events.

---

## Security Considerations

### Webhook Signature Verification

All webhook notifications are signed. Consumers should verify signatures before processing. Signatures include timestamps to prevent replay attacks.

### SSRF Prevention

Implementations should:

- Require HTTPS for webhook URLs (except localhost in development)
- Block private IP ranges (RFC 1918, link-local, loopback)
- Block cloud metadata endpoints (169.254.169.254)

### Callback Token Security

- Tokens are passed via `Authorization` header (not in URLs) to avoid logging
- Tokens are HMAC-signed with server secret, not stored in a database
- Tokens include consumer_id and epoch, preventing cross-consumer use
