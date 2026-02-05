# Webhooks RFC

## Summary

Serverless functions and AI agents need to react to events without holding persistent connections, but Durable Streams currently only supports pull-based consumption. This RFC adds webhook-based push delivery: register a subscription with a glob pattern and webhook URL, and the server will POST notifications when matching streams receive events. Each matched stream spawns a consumer instance that can dynamically subscribe to additional streams (e.g., an agent subscribing to its task queue plus shared filesystem and tool outputs), with the server tracking offsets across all subscribed streams as a unit. Consumers read events using the standard Durable Streams client, use a scoped callback URL to acknowledge progress and manage subscriptions, and signal completion when done—or get re-woken when new events arrive. The implementation adds subscription CRUD endpoints, consumer instance lifecycle management, exponential backoff retry for failed webhooks, and OpenTelemetry integration for debugging.

## Background

Modern event-driven architectures increasingly run on serverless functions (Cloudflare Workers, AWS Lambda, etc.) where compute spins up only when there's work to do. This pattern is particularly common for AI agent systems, where each agent instance handles a specific task and may need to coordinate across multiple event streams—its own task queue, shared resources, tool outputs.

Durable Streams currently requires consumers to actively poll or maintain persistent connections (long-poll, SSE) to receive events. This works for always-on services but creates friction for serverless deployments:

- Functions can't hold open connections waiting for events
- Polling from cold functions is wasteful and adds latency
- Coordinating reads across multiple related streams requires complex client logic

A push-based delivery model—where the server notifies consumers when events arrive—would let serverless functions wake on demand, process events, and shut down cleanly.

### Related Systems

This design draws from several comparable systems:

- **Apache Kafka** — Consumer group protocol with session timeouts, consumer epochs for fencing zombie consumers, and KIP-848 server-side assignment
- **NATS JetStream** — Push consumers with ack-wait timeouts, max_ack_pending flow control, and delivery policies
- **Restate** — Virtual Objects with single-writer semantics and keyed state management
- **Inngest** — Serverless function orchestration with step-based execution and event-driven invocation
- **Svix/Hookdeck** — Webhook delivery infrastructure with signature verification, retry schedules, and dead letter queues

## Problem

Serverless functions cannot efficiently consume Durable Streams today. The current pull-based model requires either:

1. **Persistent connections** (long-poll/SSE) — incompatible with serverless execution limits
2. **Periodic polling** — wasteful, adds latency, and doesn't scale when an agent needs to monitor multiple streams

This gap blocks a key use case: **multi-agent systems** where each agent instance needs to:
- React to events on its primary task stream
- Dynamically subscribe to additional streams (shared filesystem, tool outputs, coordination channels)
- Maintain offsets across all subscribed streams as a unit
- Resume exactly where it left off after being idle

Without server-side push, building this requires external orchestration (separate queue systems, workflow engines) that duplicates what Durable Streams already provides—durable, resumable, ordered event delivery.

**Constraints:**
- Must work with serverless functions that have 30-second to 5-minute execution limits
- Must handle webhook endpoint failures gracefully (deploys, outages, bugs)
- Protocol must support distributed deployments, even if reference implementations are single-server
- No authentication built-in (handled at deployment layer, consistent with existing protocol)

## Proposal

### Overview

Add a webhook-based push delivery system to Durable Streams. The core concepts:

- **Subscription**: A registration that maps a glob pattern to a webhook URL. When streams matching the pattern receive events, the server notifies the webhook.
- **Consumer Instance**: Spawned when a stream matches a subscription's pattern. Each instance has its own identity, epoch (for fencing), offsets, and can dynamically subscribe to additional streams.
- **Callback**: A scoped URL that consumer instances use to acknowledge progress, subscribe to additional streams, and signal completion.

### Subscription Model

A subscription is registered via HTTP API and consists of:
- `handler_id`: Server-generated UUID identifying this subscription
- `pattern`: Glob pattern matching stream paths (e.g., `/agents/*`)
- `webhook`: URL to POST notifications to
- `webhook_secret`: Server-generated secret for signature verification (returned on creation, not stored retrievably)
- `description`: Optional human-readable description
- `internal`: Optional boolean flag indicating this is an internal subscription (for secondary stream coordination)

When a stream is created or receives events that match the pattern, the server spawns a consumer instance (if one doesn't exist) and wakes it.

Subscriptions marked as `internal: true` may be routed differently by implementations (e.g., direct function calls instead of HTTP in single-server deployments), but the behavior is identical.

**Glob patterns** support simple wildcards only:
- `*` matches exactly one path segment
- `/agents/*` matches `/agents/task-123` but not `/agents/foo/bar`
- `/agents/*/inbox` matches `/agents/worker-1/inbox`

### Consumer Instance Lifecycle

```
Stream matches subscription pattern
              │
              ▼
┌─────────────────────────────────┐
│  CONSUMER INSTANCE              │
│  id: {handler_id}:{stream_path} │
│  epoch: 1                       │
│  primary: /agents/task-123      │
│  streams: [primary]             │
│  state: IDLE                    │
└───────────────┬─────────────────┘
                │ events arrive on any subscribed stream
                │ epoch incremented
                ▼
┌─────────────────────────────────┐
│  state: WAKING                  │
│  epoch: 2                       │
│  POST webhook with notification │
│  (connection held open)         │
│  45s timeout to receive callback│
└───────────────┬─────────────────┘
                │
        ┌───────┴───────┐
        │               │
        ▼               ▼
   (callback)    (webhook responds
                  { done: true })
        │               │
        ▼               ▼
┌───────────────┐       │
│  state: LIVE  │◄──┐   │
│  epoch: 2     │   │   │
│  processing   │   │   │
└───────┬───────┘   │   │
        │           │   │
        │ callback  │   │
        │ activity  │   │
        └───────────┘   │
        │               │
        │ 45s timeout   │
        │ OR { done }   │
        ▼               │
┌───────────────────────┴─────────┐
│  state: IDLE                    │
│  epoch: 2                       │
│  (offsets preserved)            │
└─────────────────────────────────┘
```

**State transitions:**

1. **IDLE → WAKING**: Events arrive on any subscribed stream; epoch is incremented
2. **WAKING → LIVE**: Consumer calls the callback (any callback request)
3. **WAKING → IDLE**: Consumer responds with `{ done: true }` (synchronous processing), OR 45-second timeout with no callback
4. **LIVE → IDLE**: Consumer sends `{ done: true }` in callback, OR 45-second timeout with no callback activity

**Epoch for fencing:** The epoch is a monotonically increasing counter that increments on each IDLE → WAKING transition. It prevents split-brain scenarios where a zombie consumer (from a previous wake cycle) sends acks that conflict with the current consumer. Callbacks with a stale epoch are rejected with `409 STALE_EPOCH`. This is analogous to producer epochs in the existing Durable Streams protocol.

**Timeout (45 seconds):** Any callback request (including empty `{}`) resets the timeout. If no callback activity occurs within 45 seconds, the consumer transitions to IDLE. Consumers doing slow processing should send periodic callbacks (even just re-acking the same offset) to stay alive.

**Consumer instance identity** is `{handler_id}:{url_encoded_stream_path}`. The stream path is URL-encoded to avoid parsing ambiguity (paths contain `/`). Multiple subscriptions can match the same stream, each creating independent consumer instances.

### Wake-up Notification

When waking a consumer, the server POSTs to the webhook:

```http
POST https://my-agent.workers.dev/handler
Content-Type: application/json
Webhook-Signature: t=1704067200,sha256=a1b2c3d4e5f6...

{
  "consumer_id": "sub_a1b2c3d4:%2Fagents%2Ftask-123",
  "epoch": 7,
  "primary_stream": "/agents/task-123",
  "streams": [
    { "path": "/agents/task-123", "offset": "1002" },
    { "path": "/shared-filesystem/task-123", "offset": "500" }
  ],
  "triggered_by": ["/agents/task-123", "/shared-filesystem/task-123"],
  "callback": "https://streams.example.com/callback/sub_a1b2c3d4/%2Fagents%2Ftask-123"
}
```

**Headers:**
- `Webhook-Signature`: Signature for verification (see Webhook Signature Verification below)

**Payload fields:**
- `consumer_id`: Unique identifier for this consumer instance
- `epoch`: Current epoch; consumers should include this in callback requests
- `streams`: All streams this consumer is subscribed to, with their last acknowledged offset
- `triggered_by`: Array of stream paths that have pending events (informational—consumer should read from all streams based on their offsets, not just triggered ones)
- `callback`: Scoped URL for acknowledgments and subscription changes

The webhook can respond with `{ "done": true }` to immediately return to IDLE (for simple synchronous processing).

**Wake-up batching:** If multiple events arrive on subscribed streams while the consumer is IDLE, they are batched into a single wake-up. The server does not wake the consumer multiple times—one wake-up per IDLE → WAKING transition.

**No re-wake while LIVE:** If the consumer is already LIVE (actively processing), new events on subscribed streams do not trigger additional wake-ups. The consumer reads new events through its existing client connections.

### Webhook Signature Verification

All webhook notifications are signed to prevent spoofing. Consumers should verify signatures before processing.

**Signature format:**
```
Webhook-Signature: t=<timestamp>,sha256=<signature>
```

- `t`: Unix timestamp (seconds) when the signature was generated
- `sha256`: HMAC-SHA256 of `<timestamp>.<body>` using the subscription's `webhook_secret`

**Verification steps:**

1. Extract timestamp and signature from header
2. Check timestamp is within acceptable window (e.g., ±5 minutes) to prevent replay attacks
3. Compute expected signature: `HMAC-SHA256(webhook_secret, "<timestamp>.<raw_body>")`
4. Compare signatures using constant-time comparison

**Example verification:**
```typescript
import { createHmac, timingSafeEqual } from 'crypto'

function verifyWebhookSignature(
  body: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  const match = signatureHeader.match(/t=(\d+),sha256=([a-f0-9]+)/)
  if (!match) return false

  const [, timestamp, signature] = match
  const ts = parseInt(timestamp, 10)

  // Check timestamp is within tolerance
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > toleranceSeconds) return false

  // Compute expected signature
  const payload = `${timestamp}.${body}`
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')

  // Constant-time comparison
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
```

### Event Reading

The webhook notification tells the consumer *what* to read, not the events themselves. Consumers read events using **standard Durable Streams HTTP reads** via the client library.

This separation keeps the webhook system focused on coordination while leveraging the existing protocol for data transfer. Authentication for reading streams is handled at the deployment layer, same as existing reads.

### Callback API

The callback URL is scoped to the specific consumer instance and has a fixed TTL (default: 1 hour). The token is passed via the `Authorization` header to avoid logging exposure.

```http
POST {callback}
Authorization: Bearer eyJ...
Content-Type: application/json

{
  "epoch": 7,
  "acks": [
    { "path": "/agents/task-123", "offset": "1005" },
    { "path": "/shared-filesystem/task-123", "offset": "520" }
  ],
  "subscribe": ["/tools/task-123"],
  "unsubscribe": ["/some-old-stream"],
  "done": true
}
```

All fields are optional (except `epoch` should be included for fencing).

**Callback semantics:**
- Callbacks are processed **serially** per consumer instance (no concurrent processing)
- All operations are **idempotent**—safe to retry on timeout
- Requests are **atomic**—entire request succeeds or fails together
- Any callback (even empty `{}`) resets the 45-second timeout

**Success response:**
```json
{
  "ok": true,
  "token": "eyJ...",
  "streams": [
    { "path": "/agents/task-123", "offset": "1005" },
    { "path": "/shared-filesystem/task-123", "offset": "520" },
    { "path": "/tools/task-123", "offset": "-1" }
  ]
}
```

- `token`: New callback token (always included; consumer should use this for subsequent requests)
- `streams`: Current list of all subscribed streams with their offsets (always included)

**Error responses:**

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Malformed JSON, unknown fields |
| 401 | `TOKEN_EXPIRED` | Callback token has expired (response includes new token) |
| 401 | `TOKEN_INVALID` | Callback token is malformed or signature invalid |
| 404 | `STREAM_NOT_FOUND` | Stream in `subscribe` does not exist |
| 409 | `INVALID_OFFSET` | Ack offset is invalid (e.g., beyond stream tail) |
| 409 | `STALE_EPOCH` | Callback epoch is older than current consumer epoch (zombie consumer) |
| 410 | `CONSUMER_GONE` | Consumer instance no longer exists (subscription deleted) |

Error response body:
```json
{
  "ok": false,
  "error": {
    "code": "STALE_EPOCH",
    "message": "Consumer epoch 5 is stale; current epoch is 7"
  },
  "token": "eyJ..."
}
```

For `TOKEN_EXPIRED`, a new token is included in the error response—consumer should retry with the new token.

For `STALE_EPOCH`, the consumer should stop processing—a newer instance has taken over.

**Subscribe behavior:**
- New subscriptions start at offset `-1` (beginning of stream)
- Consumer controls effective position through acks (can immediately ack to current tail to skip history)
- Subscribe fails with `STREAM_NOT_FOUND` if the stream doesn't exist

**Unsubscribe behavior:**
- Consumer can unsubscribe from any stream including its primary
- Unsubscribing from primary is valid—any remaining subscribed stream can still wake the consumer
- Unsubscribing from all streams removes the consumer instance

**Stream removal:** If a subscribed stream is deleted, it is silently removed from the consumer's subscription list. The next callback response will show the updated `streams` array without the deleted stream.

### Secondary Subscriptions (Internal Webhooks)

When a consumer subscribes to streams beyond its primary, the coordination works via internal webhooks:

1. Primary stream's server creates a subscription on the secondary stream (marked as `internal: true`)
2. Secondary stream sends webhook notifications to the primary stream's server (not directly to the consumer)
3. Primary stream decides whether to wake the consumer (if IDLE) or let the callback loop handle it (if LIVE)

This model:
- Uses the same webhook mechanism everywhere
- Works naturally in distributed deployments where streams live on different servers
- Keeps the primary stream as single source of truth for consumer state

For single-server deployments, implementations may optimize internal subscriptions (e.g., direct function calls). For distributed deployments, it's HTTP between servers. The routing optimization is implementation-specific.

### Failure Handling

**Webhook request timeout:** The server waits up to 30 seconds for a response from the webhook endpoint. If the endpoint hangs beyond this, the request is considered failed and enters the retry loop.

**Webhook delivery failures** use exponential backoff (AWS standard algorithm):
- Initial retry with exponential backoff up to 30 seconds between attempts
- Then retry every 60 seconds with jitter
- No maximum retry limit—keeps retrying indefinitely

This ensures consumers auto-recover after deploys, outages, or bug fixes without manual intervention.

**Delivery guarantee** is at-least-once. Consumers must handle duplicate events idempotently.

**Partial failures**: If a consumer processes some events and acks progress but crashes before completing, the next wake-up resumes from the last acknowledged offset.

### Garbage Collection

Consumer instances are removed when:
- Primary stream is deleted
- Webhook errors continuously for 3 days
- Consumer unsubscribes from all streams (including primary)

When a consumer instance is removed, all its internal webhook subscriptions to secondary streams are also cleaned up.

No explicit deletion API is needed—unsubscribe handles cleanup.

### Subscription HTTP API

**Create subscription:**
```http
POST /subscriptions
{
  "pattern": "/agents/*",
  "webhook": "https://my-agent.workers.dev/handler",
  "description": "Agent task processor"
}

→ 201 Created
{
  "handler_id": "sub_a1b2c3d4",
  "pattern": "/agents/*",
  "webhook": "https://my-agent.workers.dev/handler",
  "webhook_secret": "whsec_abc123def456...",
  "description": "Agent task processor"
}
```

**Note:** The `webhook_secret` is only returned on creation. Store it securely—it cannot be retrieved later.

**List subscriptions:**
```http
GET /subscriptions
→ { "subscriptions": [...] }
```

**Get subscription:**
```http
GET /subscriptions/{handler_id}
→ { "handler_id": "...", ... }
```

(Does not include `webhook_secret`)

**Delete subscription:**
```http
DELETE /subscriptions/{handler_id}
→ 204 No Content
```

When a subscription is deleted, all its consumer instances are immediately removed. Any in-flight callback requests will receive `410 CONSUMER_GONE`.

Subscriptions are immutable—to change the webhook URL, delete and recreate.

### State Storage

Subscription and consumer instance state lives in the same Store abstraction as stream data. This keeps the implementation simple and leverages existing persistence.

### Existing Streams

When a subscription is created and matching streams already exist:
- Consumer instances are created in IDLE state
- They wake only when new events arrive (not immediately)
- Assumption: existing streams were handled by a previous subscription/version

### Example Consumer (Serverless Function)

```typescript
import { createHmac, timingSafeEqual } from 'crypto'
import { stream } from '@durable-streams/client'

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!
const PLATFORM_TIMEOUT_MS = 30_000  // e.g., Cloudflare Workers limit
const IDLE_TIMEOUT_MS = 15_000      // exit if no messages for 15s
const SAFETY_MARGIN_MS = 5_000      // exit 5s before platform kills us

export default {
  async fetch(request: Request) {
    const body = await request.text()
    const signature = request.headers.get('Webhook-Signature')

    // Verify webhook signature
    if (!signature || !verifyWebhookSignature(body, signature, WEBHOOK_SECRET)) {
      return new Response('Invalid signature', { status: 401 })
    }

    const { consumer_id, epoch, streams: initialStreams, callback } = JSON.parse(body)
    const startTime = Date.now()

    // Subscribe to additional streams and get updated list
    // First callback transitions WAKING → LIVE
    let token = extractInitialToken(callback)
    let subRes = await fetch(callback, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        epoch,
        subscribe: [
          `/shared-filesystem/${consumer_id}`,
          `/tools/${consumer_id}`
        ]
      })
    })
    let { streams: allStreams, token: newToken } = await subRes.json()
    token = newToken

    let lastMessageTime = Date.now()
    const pendingAcks: Promise<Response>[] = []
    const controller = new AbortController()

    // Set up concurrent readers for all subscribed streams
    const readers = allStreams.map((s: { path: string; offset: string }) =>
      stream({
        url: `https://streams.example.com${s.path}`,
        offset: s.offset,
        live: true,
        signal: controller.signal,
      }).then(res => {
        res.subscribeJson(async (batch) => {
          lastMessageTime = Date.now()

          for (const item of batch.items) {
            await processEvent(s.path, item)
          }

          // Track ack promises so we can flush before exit
          pendingAcks.push(fetch(callback, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              epoch,
              acks: [{ path: s.path, offset: batch.offset }]
            })
          }).then(res => res.json()).then(data => {
            token = data.token  // keep token fresh
            return data
          }))
        })
      })
    )

    await Promise.all(readers)

    // Check exit conditions periodically
    while (true) {
      await sleep(1000)

      const elapsed = Date.now() - startTime
      const idleTime = Date.now() - lastMessageTime

      if (elapsed >= PLATFORM_TIMEOUT_MS - SAFETY_MARGIN_MS) break
      if (idleTime >= IDLE_TIMEOUT_MS) break
    }

    controller.abort()

    // Flush pending acks before exit
    await Promise.allSettled(pendingAcks)

    // Response signals done - transitions LIVE → IDLE
    return Response.json({ done: true })
  }
}

function verifyWebhookSignature(
  body: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  const match = signatureHeader.match(/t=(\d+),sha256=([a-f0-9]+)/)
  if (!match) return false

  const [, timestamp, signature] = match
  const ts = parseInt(timestamp, 10)

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > toleranceSeconds) return false

  const payload = `${timestamp}.${body}`
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')

  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function extractInitialToken(callbackUrl: string): string {
  // Implementation-specific: extract initial token from callback URL or request
  return ''
}

declare function processEvent(path: string, item: unknown): Promise<void>
```

### Security Considerations

While authentication is handled at the deployment layer, implementations should consider:

**Webhook signature verification:**
- All webhook notifications include a `Webhook-Signature` header
- Consumers should verify signatures before processing (see example above)
- Signatures include timestamps to prevent replay attacks

**Webhook URL validation (SSRF prevention):**
- Require HTTPS for webhook URLs (except localhost in development)
- Block private IP ranges (RFC 1918, link-local, loopback)
- Block cloud metadata endpoints (169.254.169.254)
- Consider allowlisting webhook domains

**Callback token security:**
- Tokens are passed via `Authorization` header to avoid logging exposure
- Tokens should be signed JWTs with consumer_id, epoch, and expiry
- Implementations should validate token signatures on every callback

### Implementation Scope

**In scope for v1:**
- Subscription CRUD API
- Consumer instance lifecycle (IDLE → WAKING → LIVE → IDLE, and WAKING → IDLE shortcut)
- Consumer epochs for fencing zombie consumers
- Webhook signature verification
- Wake-up notifications and callback API
- Dynamic subscribe/unsubscribe for secondary streams
- Internal webhook routing for secondary subscriptions (single-server)
- Exponential backoff retry with indefinite retries
- OpenTelemetry integration in Node.js server for debugging

**Out of scope for v1:**
- Distributed server implementation (protocol supports it)
- Consumer instance listing/inspection APIs
- Complex glob patterns (`**`, character classes)
- Authentication (handled at deployment layer)
- Configurable callback TTL (fixed at 1 hour for v1)

### Future Considerations

The following features are not included in v1 but may be added based on demand:

- **Backfill/replay delivery policies** — Allow subscriptions to specify `deliver_policy: "all" | "new" | "from_offset"` to control whether existing streams trigger immediate wake-ups
- **Subscription pause/resume** — Temporarily disable webhook delivery without deleting subscription state
- **Consumer instance inspection API** — Query consumer state for debugging (stats, state, last activity)
- **Configurable retry schedules** — Per-subscription retry timing configuration
- **Dead letter queue** — Capture consumer state when GC'd for inspection/replay

## Definition of Success

This feature is successful when a multi-agent system running on serverless functions works smoothly without DX friction. Specifically:

**Functional requirements:**
- Agents wake reliably when events arrive on any subscribed stream
- Dynamic subscribe/unsubscribe works correctly mid-session
- Offsets are preserved across wake cycles
- Agents can stay alive processing live events, then cleanly exit
- Failed webhooks retry indefinitely and recover automatically after deploys/fixes
- Zombie consumers are fenced via epochs

**Developer experience:**
- Consumer code is straightforward (see example above)
- Webhook signature verification is simple to implement
- No external orchestration needed—Durable Streams handles coordination
- Debugging is tractable via OpenTelemetry traces in the Node.js server

**Out of scope for v1:**
- Distributed server implementation (protocol supports it, reference impl is single-server)
- Consumer instance listing/inspection APIs
- Complex glob patterns (`**`, character classes)
- Authentication (handled at deployment layer)
