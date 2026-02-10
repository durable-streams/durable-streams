# Webhook Subscriptions Specification

## Overview

Webhook subscriptions add push-based event delivery to Durable Streams. When
streams matching a glob pattern receive events, the server POSTs a notification
to a registered webhook URL, waking a consumer instance that reads events using
the standard protocol and reports progress via a scoped callback API.

This specification defines the complete behavior that any conforming
implementation must exhibit. It covers subscription registration, consumer
lifecycle, callback semantics, failure handling, garbage collection, and security.

---

## Concepts

### Subscription

A registration that maps a **glob pattern** to a **webhook URL**. Subscriptions
are created via the HTTP API and are immutable — to change the webhook URL,
delete and recreate.

Fields:

- `subscription_id` — Client-provided identifier
- `pattern` — Glob pattern matching stream paths
- `webhook` — URL to POST notifications to
- `webhook_secret` — Server-generated HMAC secret (returned on creation only)
- `description` — Optional human-readable label

### Consumer Instance

Spawned when a stream matches a subscription's pattern. Each consumer tracks its
own offsets across one or more streams and cycles through states independently.

Identity: `{subscription_id}:{url_encoded_stream_path}`

The stream path is URL-encoded in the consumer ID to avoid parsing ambiguity.
Multiple subscriptions matching the same stream create independent consumers.

**Implementation note:** When extracting the consumer ID from callback URLs
(e.g., `/callback/{consumer_id}`), implementations MUST use the raw
percent-encoded path, not a decoded version. HTTP frameworks often decode
`%2F` → `/` in URL paths automatically, which would break consumer ID lookups.

### Pending Work

Pending work exists when any subscribed stream has unprocessed events:

```
pending_work = any(tail[path] > acked[path] for path in subscribed_streams)
```

Where `acked[path]` is the last acknowledged offset (inclusive — the event at
this offset was processed) and `tail[path]` is the current stream end. An acked
offset of `-1` means no events have been processed yet. Offset comparison uses
the fixed-width lexicographic format defined in the main protocol (see
PROTOCOL.md § Offsets).

---

## Glob Patterns

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

---

## Consumer Lifecycle

### State Machine

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    ▼                                          │
              ┌──────────┐    pending_work    ┌──────────┐    │
              │          │ ─────────────────► │          │    │
              │   IDLE   │    epoch++         │  WAKING  │    │
              │          │    wake_id new     │          │    │
              └──────────┘                    └────┬─────┘    │
                    ▲                              │          │
                    │                    ┌─────────┼────┐     │
                    │                    │         │    │     │
                    │              callback   webhook   │     │
                    │              claims     2xx or    │     │
                    │              wake_id    {done}    │     │
                    │                    │         │    │     │
                    │                    ▼         │    │     │
                    │               ┌─────────┐   │    │     │
                    │               │         │   │    │     │
                    │ done+¬pending │  LIVE   │───┘    │     │
                    │ OR 45s timeout│         │        │     │
                    └───────────────┴─────────┘        │     │
                    │                                   │     │
                    │  done + pending_work               │     │
                    └───────────────────────────────────┘     │
                                                              │
                    10s timeout, no 2xx, no callback ──────────┘
                    (retry webhook delivery)
```

### State Transitions

| From   | To      | Trigger                                                          | Side Effects                       |
| ------ | ------- | ---------------------------------------------------------------- | ---------------------------------- |
| IDLE   | WAKING  | `pending_work` becomes true                                      | epoch++, new wake_id, webhook POST |
| WAKING | LIVE    | Webhook responds 2xx, OR callback claims wake_id                 | Liveness timeout starts            |
| WAKING | IDLE    | Webhook responds `{done: true}` and `¬pending_work`              | Auto-ack to tail                   |
| LIVE   | IDLE    | Callback `{done: true}` and `¬pending_work`                      | —                                  |
| LIVE   | IDLE    | 45-second liveness timeout                                       | —                                  |
| LIVE   | WAKING  | Callback `{done: true}` and `pending_work`                       | epoch++, new wake_id               |
| Any    | Removed | Primary stream deleted, subscription deleted, or unsubscribe all | —                                  |

### Epoch

Monotonically increasing counter, incremented on each IDLE → WAKING transition.
Callbacks with a stale epoch are rejected with `409 STALE_EPOCH`. This fences
zombie consumers — a consumer from a previous wake cycle cannot interfere with
the current one.

### Wake ID

Unique identifier generated for each wake attempt. The first callback that
includes a matching `wake_id` claims the wake (WAKING → LIVE). Claiming an
already-claimed `wake_id` is **idempotent** — the callback succeeds. This
handles the case where a 2xx webhook response already transitioned the consumer
to LIVE before the callback arrives. Callbacks with a non-matching `wake_id`
receive `409 ALREADY_CLAIMED`.

### Liveness Timeout

Any callback resets the 45-second liveness timer. If no callback arrives within
45 seconds while the consumer is LIVE, it transitions to IDLE. Consumers doing
slow processing should send periodic callbacks (even `{ epoch: N }` with no
other fields) to stay alive.

---

## Wake-up Notification

When waking a consumer, the server POSTs to the subscription's webhook URL:

```http
POST {webhook_url}
Content-Type: application/json
Webhook-Signature: t=1704067200,sha256=a1b2c3d4e5f6...

{
  "consumer_id": "my-sub:%2Fagents%2Ftask-123",
  "epoch": 7,
  "wake_id": "w_f8a3b2c1",
  "primary_stream": "/agents/task-123",
  "streams": [
    { "path": "/agents/task-123", "offset": "1002" },
    { "path": "/shared-filesystem/task-123", "offset": "500" }
  ],
  "triggered_by": ["/agents/task-123"],
  "callback": "https://streams.example.com/callback/my-sub:%2Fagents%2Ftask-123",
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

### Payload Fields

| Field            | Type     | Description                                      |
| ---------------- | -------- | ------------------------------------------------ |
| `consumer_id`    | string   | Unique consumer instance identifier              |
| `epoch`          | number   | Current epoch; include in all callbacks          |
| `wake_id`        | string   | Claim this in the first callback                 |
| `primary_stream` | string   | The stream that spawned this consumer            |
| `streams`        | array    | All subscribed streams with last acked offsets   |
| `triggered_by`   | string[] | Streams that have pending events (informational) |
| `callback`       | string   | URL for acknowledgments and subscription changes |
| `token`          | string   | Bearer token for the first callback              |

### Synchronous Done

The webhook response may include `{ "done": true }` to immediately return to
IDLE without using the callback API. When the server receives this response:

1. The wake is considered claimed
2. All streams are auto-acked to their current tail offset
3. Consumer transitions to IDLE
4. If new events arrive later, a new wake cycle begins

This is a shortcut for consumers that process events synchronously within the
webhook handler. It is equivalent to: claim wake → ack all → done.

### Wake Batching

Multiple events arriving while the consumer is IDLE produce a single wake.
Events arriving while the consumer is WAKING or LIVE do not trigger additional
wakes — the consumer reads new events through its existing connections.

### WAKING Timeout

The server waits up to 10 seconds after sending a webhook for the consumer to
transition to LIVE (via 2xx response or callback claim). If neither occurs, the
server retries the webhook with exponential backoff.

A 2xx webhook response means the consumer has received the notification and is
actively processing — the server transitions immediately to LIVE. The 45-second
liveness timeout covers crash recovery from that point. This design supports
serverless functions that hold the webhook connection open during processing.

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

| Field         | Required            | Description                       |
| ------------- | ------------------- | --------------------------------- |
| `epoch`       | Yes                 | Must match current consumer epoch |
| `wake_id`     | First callback only | Claims the wake (WAKING → LIVE)   |
| `acks`        | No                  | Acknowledge processed offsets     |
| `subscribe`   | No                  | Subscribe to additional streams   |
| `unsubscribe` | No                  | Unsubscribe from streams          |
| `done`        | No                  | Signal processing is complete     |

### Semantics

- Callbacks are processed **serially** per consumer
- All operations are **idempotent** — safe to retry on timeout
- Each request is **atomic** — succeeds or fails as a unit
- Any callback (even `{ "epoch": N }`) resets the liveness timeout

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

- `token` — Bearer token for the next callback (refreshed when nearing expiry)
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

For `TOKEN_EXPIRED`, the new token in the error response can be used to retry.
For `STALE_EPOCH`, the consumer should stop processing. For `ALREADY_CLAIMED`,
the wake_id does not match the current wake — the consumer should stop.

### Offset Semantics

Offsets are **"last processed inclusive"**:

- `"1005"` means events through 1005 have been processed
- Next read starts from `"1006"`
- `"-1"` means no events processed yet

### Dynamic Subscribe

- New subscriptions start at current tail (new events only)
- Subscribing to non-existent streams is allowed (lazy)
- No validation of stream paths

### Dynamic Unsubscribe

- Can unsubscribe from any stream including primary
- Unsubscribing from all streams removes the consumer

### Callback Tokens

- Tokens are HMAC-signed with a 1-hour TTL
- Every successful response includes a token (refreshed when nearing expiry)
- Tokens encode consumer_id, epoch, and expiry
- Passed via `Authorization: Bearer` header

---

## Subscription HTTP API

Subscriptions use the glob pattern as the URL path with query parameters for
CRUD operations.

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

`webhook_secret` is only returned on creation. Idempotent create (same ID +
same configuration) returns `200` without the secret. Create with same ID but
different configuration returns `409 Conflict`.

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

Cascade: all consumer instances for this subscription are immediately removed.
In-flight callbacks receive `410 CONSUMER_GONE`.

---

## Failure Handling

### Webhook Request Timeout

30 seconds. If the endpoint does not respond within this window, the request is
considered failed.

### Retry Schedule

Failed webhook deliveries (timeout, network error, non-2xx response) are retried
with exponential backoff:

- Retries 1-10: `min(2^n × 100ms, 30s)` + up to 1s jitter
- Retries 11+: 60s + up to 5s jitter

A 2xx response stops retries — the consumer transitions to LIVE and the liveness
timeout handles recovery if the consumer crashes.

### Delivery Guarantee

At-least-once. Consumers must handle duplicate events idempotently.

### Partial Failure

If a consumer acks some events and then crashes, the next wake resumes from the
last acknowledged offset.

---

## Garbage Collection

Consumer instances are removed when:

| Condition                         | Effect                |
| --------------------------------- | --------------------- |
| Primary stream deleted            | Consumer removed      |
| Subscription deleted              | All consumers removed |
| Unsubscribe from all streams      | Consumer removed      |
| 3 days continuous webhook failure | Consumer removed      |

When a consumer is removed, all internal subscriptions to secondary streams are
cleaned up. Subsequent callbacks receive `410 CONSUMER_GONE`.

---

## Safety Invariants

These properties must hold for any conforming implementation:

**S1 — Epoch Monotonicity**: Epoch values in webhook notifications for a given
consumer are strictly increasing.

**S2 — Wake ID Uniqueness**: Each wake cycle produces exactly one wake_id.
Retries of the same webhook notification reuse the same wake_id — uniqueness is
per wake cycle (IDLE → WAKING transition), not per HTTP request.

**S3 — Idempotent Claim**: Claiming the current wake_id is idempotent. Callbacks
with a non-matching wake_id are rejected with `ALREADY_CLAIMED`.

**S4 — Offset Monotonicity**: Acknowledged offsets for a given stream are
monotonically non-decreasing.

**S5 — Token Present**: Every successful callback response includes a `token`
field. The server may return the same token if it is not nearing expiry.

**S6 — Stale Epoch Rejection**: Callbacks with epoch < current consumer epoch
are rejected with `STALE_EPOCH`.

**S7 — Gone After Delete**: After a subscription or primary stream is deleted,
callbacks for affected consumers return `CONSUMER_GONE`.

**S8 — Signature Presence**: Every webhook notification includes a valid
`Webhook-Signature` header verifiable with the subscription's `webhook_secret`.

---

## Liveness Properties

**L1 — Pending Work Causes Wake**: If pending work exists when the consumer is
IDLE, a webhook notification is eventually delivered (subject to retry schedule).

**L2 — Done Without Pending Reaches IDLE**: A `done: true` callback when no
pending work exists transitions the consumer to IDLE without re-wake.

**L3 — Done With Pending Causes Re-wake**: A `done: true` callback when pending
work exists triggers an immediate new wake cycle (epoch incremented).

---

## Existing Streams

When a subscription is created and matching streams already exist:

- Consumer instances are created in IDLE state
- They wake only when **new** events arrive (not immediately)
- Assumption: existing streams were handled by a previous subscription

---

## Security Considerations

### Webhook Signature Verification

All webhook notifications are signed. Consumers should verify signatures before
processing. Signatures include timestamps to prevent replay attacks.

### SSRF Prevention

Implementations should:

- Require HTTPS for webhook URLs (except localhost in development)
- Block private IP ranges (RFC 1918, link-local, loopback)
- Block cloud metadata endpoints (169.254.169.254)

### Callback Token Security

- Tokens are passed via `Authorization` header (not in URLs) to avoid logging
- Tokens are HMAC-signed with server secret, not stored in a database
- Tokens include consumer_id and epoch, preventing cross-consumer use
