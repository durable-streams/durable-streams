# Webhooks RFC

## Summary

Serverless functions and AI agents need to react to events without holding persistent connections, but Durable Streams currently only supports pull-based consumption. This RFC adds webhook-based push delivery: register a subscription with a glob pattern and webhook URL, and the server will POST notifications when matching streams receive events. Each matched stream spawns a consumer instance that can dynamically subscribe to additional streams (e.g., an agent subscribing to its task queue plus shared filesystem and tool outputs), with the server tracking cursor positions across all subscribed streams as a unit. Consumers read events using the standard Durable Streams client, use a scoped callback URL to acknowledge progress and manage subscriptions, and signal completion when done—or get re-woken when new events arrive. The implementation adds subscription CRUD endpoints, consumer instance lifecycle management, exponential backoff retry for failed webhooks, and OpenTelemetry integration for debugging.

## Background

Modern event-driven architectures increasingly run on serverless functions (Cloudflare Workers, AWS Lambda, etc.) where compute spins up only when there's work to do. This pattern is particularly common for AI agent systems, where each agent instance handles a specific task and may need to coordinate across multiple event streams—its own task queue, shared resources, tool outputs.

Durable Streams currently requires consumers to actively poll or maintain persistent connections (long-poll, SSE) to receive events. This works for always-on services but creates friction for serverless deployments:

- Functions can't hold open connections waiting for events
- Polling from cold functions is wasteful and adds latency
- Coordinating reads across multiple related streams requires complex client logic

A push-based delivery model—where the server notifies consumers when events arrive—would let serverless functions wake on demand, process events, and shut down cleanly.

## Problem

Serverless functions cannot efficiently consume Durable Streams today. The current pull-based model requires either:

1. **Persistent connections** (long-poll/SSE) — incompatible with serverless execution limits
2. **Periodic polling** — wasteful, adds latency, and doesn't scale when an agent needs to monitor multiple streams

This gap blocks a key use case: **multi-agent systems** where each agent instance needs to:
- React to events on its primary task stream
- Dynamically subscribe to additional streams (shared filesystem, tool outputs, coordination channels)
- Maintain cursor positions across all subscribed streams as a unit
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
- **Consumer Instance**: Spawned when a stream matches a subscription's pattern. Each instance has its own identity, cursor positions, and can dynamically subscribe to additional streams.
- **Callback**: A short-lived, scoped URL that consumer instances use to acknowledge progress, subscribe to additional streams, and signal completion.

### Subscription Model

A subscription is registered via HTTP API and consists of:
- `handler_id`: Server-generated UUID identifying this subscription
- `pattern`: Glob pattern matching stream paths (e.g., `/agents/*`)
- `webhook`: URL to POST notifications to
- `description`: Optional human-readable description

When a stream is created or receives events that match the pattern, the server spawns a consumer instance (if one doesn't exist) and wakes it.

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
│  primary: /agents/task-123      │
│  streams: [primary]             │
│  state: IDLE                    │
└───────────────┬─────────────────┘
                │ events arrive on any subscribed stream
                ▼
┌─────────────────────────────────┐
│  state: WAKING                  │
│  POST webhook with notification │
│  (connection held open)         │
└───────────────┬─────────────────┘
                │
        ┌───────┴───────┐
        │               │
        ▼               ▼
   (callback)    (webhook responds
                  { done: true })
        │               │
        ▼               │
┌───────────────┐       │
│  state: LIVE  │◄──┐   │
│  processing   │   │   │
└───────┬───────┘   │   │
        │           │   │
        │ callback  │   │
        │ activity  │   │
        └───────────┘   │
        │               │
        │ timeout OR    │
        │ { done: true }│
        ▼               │
┌───────────────────────┴─────────┐
│  state: IDLE                    │
│  (offsets preserved)            │
└─────────────────────────────────┘
```

**Two paths from WAKING:**
1. **WAKING → LIVE → IDLE** (normal flow): Consumer calls callback to signal liveness, processes events, eventually times out or signals done
2. **WAKING → IDLE** (synchronous): Consumer handles everything in the webhook handler and responds with `{ done: true }`

**Consumer instance identity** is `{handler_id}:{url_encoded_stream_path}`. The stream path is URL-encoded to avoid parsing ambiguity (paths contain `/`). Multiple subscriptions can match the same stream, each creating independent consumer instances.

The transition from WAKING → LIVE happens when the consumer **calls the callback**, not when it responds to the webhook. This lets the serverless function hold the HTTP connection open (keeping the platform from killing it) while signaling liveness through the callback.

### Wake-up Notification

When waking a consumer, the server POSTs to the webhook:

```http
POST https://my-agent.workers.dev/handler
Content-Type: application/json

{
  "consumer_id": "sub_a1b2c3:%2Fagents%2Ftask-123",
  "primary_stream": "/agents/task-123",
  "streams": [
    { "path": "/agents/task-123", "offset": "1002" },
    { "path": "/shared-filesystem/task-123", "offset": "500" }
  ],
  "triggered_by": ["/agents/task-123", "/shared-filesystem/task-123"],
  "callback": "https://streams.example.com/callback?token=eyJ..."
}
```

- `streams`: All streams this consumer is subscribed to, with their last acknowledged offset
- `triggered_by`: Array of stream paths that have pending events (multiple streams may have accumulated events while consumer was IDLE)
- `callback`: Scoped URL for acknowledgments and subscription changes

The webhook can respond with `{ "done": true }` to immediately return to IDLE (for simple synchronous processing).

**Wake-up batching:** If multiple events arrive on subscribed streams while the consumer is IDLE, they are batched into a single wake-up. The server does not wake the consumer multiple times—one wake-up per IDLE → WAKING transition.

**No re-wake while LIVE:** If the consumer is already LIVE (actively processing), new events on subscribed streams do not trigger additional wake-ups. The consumer reads new events through its existing client connections.

### Event Reading

The webhook notification tells the consumer *what* to read, not the events themselves. Consumers read events using **standard Durable Streams HTTP reads** via the client library.

This separation keeps the webhook system focused on coordination while leveraging the existing protocol for data transfer. Authentication for reading streams is handled at the deployment layer, same as existing reads.

### Callback API

The callback URL is scoped to the specific consumer instance and has a fixed TTL (default: 5 minutes). The token is a signed JWT containing the consumer_id and expiry timestamp—implementers can use any signing method appropriate for their deployment.

Consumers use the callback to:

```http
POST {callback}
Content-Type: application/json

{
  "acks": [
    { "path": "/agents/task-123", "offset": "1005" },
    { "path": "/shared-filesystem/task-123", "offset": "520" }
  ],
  "subscribe": ["/tools/task-123"],
  "unsubscribe": ["/some-old-stream"],
  "done": true
}
```

All fields are optional.

**Response:**
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

- `token`: New callback token (always included; refreshed when near expiry)
- `streams`: Updated list of all subscribed streams with current offsets (included when subscriptions change)

If the token has already expired, the server returns 4xx with a new token; the consumer should retry.

**Subscribe behavior:**
- New subscriptions start at offset `-1` (beginning of stream)
- Consumer controls effective position through acks (can immediately ack to current tail to skip history)
- Subscribe fails with error if the stream doesn't exist

**Unsubscribe behavior:**
- Consumer can unsubscribe from any stream including its primary
- Unsubscribing from primary is valid—any remaining subscribed stream can still wake the consumer
- Unsubscribing from all streams removes the consumer instance

### Secondary Subscriptions (Internal Webhooks)

When a consumer subscribes to streams beyond its primary, the coordination works via internal webhooks:

1. Primary stream's server creates a subscription on the secondary stream
2. Secondary stream sends webhook notifications to the primary stream's server (not directly to the consumer)
3. Primary stream decides whether to wake the consumer (if IDLE) or let the callback loop handle it (if LIVE)

This model:
- Uses the same webhook mechanism everywhere
- Works naturally in distributed deployments where streams live on different servers
- Keeps the primary stream as single source of truth for consumer state

For single-server deployments, this is just internal routing. For distributed deployments, it's HTTP between servers.

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
  "description": "Agent task processor"
}
```

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

**Delete subscription:**
```http
DELETE /subscriptions/{handler_id}
→ 204 No Content
```

When a subscription is deleted, all its consumer instances are immediately removed.

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
import { stream } from '@durable-streams/client'

const PLATFORM_TIMEOUT_MS = 30_000  // e.g., Cloudflare Workers limit
const IDLE_TIMEOUT_MS = 15_000      // exit if no messages for 15s
const SAFETY_MARGIN_MS = 5_000      // exit 5s before platform kills us

export default {
  async fetch(request: Request) {
    const { consumer_id, streams: initialStreams, callback } = await request.json()
    const startTime = Date.now()

    // Subscribe to additional streams and get updated list
    const subRes = await fetch(callback, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscribe: [
          `/shared-filesystem/${consumer_id}`,
          `/tools/${consumer_id}`
        ]
      })
    })
    const { streams: allStreams } = await subRes.json()

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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              acks: [{ path: s.path, offset: batch.offset }]
            })
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

declare function processEvent(path: string, item: unknown): Promise<void>
```

### Implementation Scope

**In scope for v1:**
- Subscription CRUD API
- Consumer instance lifecycle (IDLE → WAKING → LIVE → IDLE, and WAKING → IDLE shortcut)
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
- Configurable callback TTL (fixed at 5 minutes for v1)

## Definition of Success

This feature is successful when a multi-agent system running on serverless functions works smoothly without DX friction. Specifically:

**Functional requirements:**
- Agents wake reliably when events arrive on any subscribed stream
- Dynamic subscribe/unsubscribe works correctly mid-session
- Cursor positions are preserved across wake cycles
- Agents can stay alive processing live events, then cleanly exit
- Failed webhooks retry indefinitely and recover automatically after deploys/fixes

**Developer experience:**
- Consumer code is straightforward (see example above)
- No external orchestration needed—Durable Streams handles coordination
- Debugging is tractable via OpenTelemetry traces in the Node.js server

**Out of scope for v1:**
- Distributed server implementation (protocol supports it, reference impl is single-server)
- Consumer instance listing/inspection APIs
- Complex glob patterns (`**`, character classes)
- Authentication (handled at deployment layer)
