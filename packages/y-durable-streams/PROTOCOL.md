---
title: Yjs Durable Streams Protocol
version: "1.1"
status: draft
owner: vbalegas
contributors:
  - kyleamathews
  - samwillis
created: 2026-01-21
last_updated: 2026-01-21
prd: docs/prds/multi-protocol-durable-streams-infrastructure.md
prd_version: "1.2"
---

# Yjs Durable Streams Protocol

## Summary

Yjs collaboration requires persistent sync infrastructure; this RFC defines an HTTP-based protocol for Yjs document sync over durable streams, with automatic server-side compaction and awareness support, plus a conformance suite to validate implementations.

## Background

Electric Cloud is launching durable streams as a hosted product. The companion RFCs cover the foundational infrastructure (Durable Streams Protocol Infrastructure) and the durable proxy for AI streaming (Durable Proxy and AI SDK Transports). This RFC addresses Yjs document synchronization — a collaboration primitive that enables real-time multi-user editing.

### The Yjs Sync Problem

Yjs is a CRDT library for building collaborative applications. It requires infrastructure to sync document updates between clients. The typical approach is WebSocket servers that broadcast updates, but this creates operational complexity:

- Running WebSocket infrastructure (not HTTP-friendly, harder to scale)
- Persistence layer for document state
- Reconnection handling and conflict resolution
- Update history grows unbounded without compaction

### Durable Streams as Yjs Transport

Durable streams provide an ordered, persistent append-only log with cursor-based resumption — a natural fit for Yjs updates. Instead of WebSocket broadcast, clients:

1. POST updates to an HTTP endpoint (appended to stream)
2. GET updates with long-polling (cursor-based, resumable)
3. Reconnect from last offset on disconnect

This works with standard HTTP infrastructure (load balancers, CDNs, edge networks) without WebSocket complexity.

### Server-Side Compaction

A key differentiator: the server automatically compacts documents when updates exceed a size threshold. Most Yjs hosting solutions either don't compact (documents grow unbounded) or require developers to implement client-side snapshotting. Our approach:

1. Server tracks update stream size
2. When threshold exceeded (default 1MB), server decodes updates, creates snapshot
3. New clients are redirected to the new snapshot via `offset=snapshot`
4. Clients unaware — compaction is transparent

### Relationship to y-durable-streams

The `y-durable-streams` package (https://github.com/durable-streams/durable-streams/tree/main/packages/y-durable-streams) provides the client-side Yjs provider. It already implements the expected protocol. This RFC specifies:

1. The server-side protocol that the provider expects
2. A conformance test suite to validate implementations
3. A reference Node.js implementation

## Problem

Developers building collaborative applications with Yjs need sync infrastructure, but current options have significant drawbacks.

### 1. WebSocket Infrastructure is Operationally Complex

Running Yjs sync servers requires WebSocket infrastructure — sticky sessions, connection state management, horizontal scaling challenges. This doesn't fit well with modern edge/serverless architectures.

### 2. Document History Grows Unbounded

Yjs documents accumulate updates over time. Without compaction, sync payloads grow indefinitely. A document with months of edits may have megabytes of update history, even if the current state is small. Most hosting solutions punt this to developers.

### 3. No Standard HTTP-Based Protocol

There's no established protocol for Yjs sync over HTTP with long-polling. Developers either use WebSockets or build custom solutions. A standard protocol enables interoperability and hosted offerings.

**Link to PRD hypothesis:** This RFC enables testing whether developers will adopt hosted Yjs sync that eliminates WebSocket infrastructure and handles compaction automatically.

## Goals & Non-Goals

### Goals

- **Define the Yjs Worker HTTP protocol** for document sync, awareness, and compaction
- **Specify automatic server-side compaction** that is transparent to clients
- **Support awareness** via separate ephemeral SSE streams (with wildcard routing for multiple streams)
- **Create a conformance test suite** that validates any implementation
- **Provide a reference Node.js implementation** in the durable-streams repo

### Non-Goals

- **Custom compaction strategies** — v1 uses a simple size threshold; custom triggers are deferred
- **Server-side awareness aggregation** — awareness is pass-through bytes, clients handle decoding
- **Document access control** — service-level auth only; per-document permissions are app-level
- **Offline-first conflict resolution** — Yjs CRDTs handle this; the protocol just transports updates
- **WebSocket transport** — HTTP long-polling only; WebSocket is a potential future addition

## Proposal

This RFC defines three components:

1. **Yjs Worker Protocol** — HTTP API for document sync over durable streams
2. **Conformance Test Suite** — Validates protocol implementations
3. **Reference Implementation** — Node.js implementation in the durable-streams repo

### Durable Streams Protocol Foundation

This protocol is built on top of the [Durable Streams Protocol](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md), an HTTP-based protocol for append-only byte streams. The Yjs protocol:

- Uses standard Durable Streams operations: POST to append, GET with `offset` and `live` parameters to read
- Uses protocol-defined headers: `stream-next-offset`, `stream-up-to-date`, `stream-cursor`
- Uses protocol-defined sentinel values: `offset=-1` (beginning), `offset=now` (tail)
- Uses protocol-defined live mode: `live=true` (server picks optimal transport)

**Yjs-specific extensions:**

- `offset=snapshot` sentinel triggers a 307 redirect to the current snapshot (or to `offset=-1` if no snapshot exists)
- Snapshot URLs use the format `offset={N}_snapshot`
- The `awareness` query parameter creates namespaced awareness streams on the same URL path

### Architecture Overview

Each Yjs document is a single durable stream at a URL path. Document paths can include forward slashes (e.g., `project/chapter-1`).

```
┌─────────────────────────────────────────────────────────────┐
│              Yjs Document: "project/chapter-1"               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Document Stream: /v1/yjs/collab-x7Kp2m/docs/project/chapter-1
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ [0...N] ← append-only log of Yjs updates                │ │
│  │                                                         │ │
│  │ offset=snapshot → 307 redirect to current snapshot      │ │
│  │                   or to offset=-1 if no snapshot        │ │
│  │                                                         │ │
│  │ Snapshot URL: ?offset=4782_snapshot                     │ │
│  │ (offset when snapshot was taken + "_snapshot" suffix)   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  Awareness (query param on same URL):                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ?awareness=default  (default awareness stream)          │ │
│  │ ?awareness=admin    (custom, e.g., for admin cursors)   │ │
│  │ [ephemeral, 1h TTL, SSE delivery]                       │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Key concepts:**

| Concept                     | Description                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Document stream             | Append-only log of Yjs updates at the document URL                                                            |
| Snapshot discovery          | `offset=snapshot` sentinel triggers 307 redirect to current snapshot, or to `offset=-1` if no snapshot exists |
| Snapshot URL                | Uses offset format `{offset}_snapshot` where offset is when snapshot was taken                                |
| `stream-next-offset` header | Per Durable Streams Protocol; snapshot responses include this to indicate where to continue reading updates   |
| Awareness                   | Query param `?awareness=<name>` on same URL; `default` is the default stream; ephemeral with 1h TTL           |

**Why a single URL path?**

The document stream, snapshots, and awareness streams all share the same URL path to enable simple authentication proxying. A developer's API can route all requests from a single endpoint to the document URL, passing through all query parameters from the client. This provides:

1. **Unified auth scope** — By default, awareness streams inherit the same authentication as the document since they're on the same path.
2. **Simple proxy implementation** — The proxy just forwards requests to the document URL without parsing or routing different stream types.
3. **Fine-grained awareness control** — The proxy can inspect the `awareness` query parameter to implement custom authorization (e.g., only certain users can access `?awareness=admin`).

### HTTP API

The Yjs Worker handles requests at `/v1/yjs/<service-name>/docs/<docPath>` where `<docPath>` can include forward slashes:

#### Snapshot Discovery (offset=snapshot)

The Yjs protocol adds a `snapshot` sentinel offset for snapshot-aware initialization. This is separate from the base protocol's `-1` (beginning) and `now` (tail) sentinels.

```
GET /v1/yjs/collab-x7Kp2m/docs/project/chapter-1?offset=snapshot
Authorization: Bearer <service-secret>
```

**Response (snapshot exists):**

```
HTTP/1.1 307 Temporary Redirect
Location: /v1/yjs/collab-x7Kp2m/docs/project/chapter-1?offset=4782_snapshot
Cache-Control: private, max-age=5
```

**Response (no snapshot yet):**

```
HTTP/1.1 307 Temporary Redirect
Location: /v1/yjs/collab-x7Kp2m/docs/project/chapter-1?offset=-1
Cache-Control: private, max-age=5
```

When a snapshot exists, the server redirects to the snapshot URL. When no snapshot exists, the server redirects to `offset=-1` which uses standard Durable Streams behavior (read from beginning). Both responses are cached briefly (5 seconds) to reduce load during rapid reconnects while ensuring clients get reasonably fresh snapshot state.

**Note:** Clients can use `offset=-1` directly to read from the beginning of the stream without snapshot discovery. This bypasses any existing snapshot and reads all updates from the start — useful for debugging, reprocessing, or clients that need the full update history.

#### Read Snapshot

Snapshot URLs use the format `offset={offset}_snapshot` where `{offset}` is the offset at which the snapshot was taken.

```
GET /v1/yjs/collab-x7Kp2m/docs/project/chapter-1?offset=4782_snapshot
Authorization: Bearer <service-secret>
```

**Response:**

```
HTTP/1.1 200 OK
Content-Type: application/octet-stream
stream-next-offset: 4783

<yjs snapshot binary>
```

The `stream-next-offset` header (per the Durable Streams Protocol) indicates where the client should continue reading updates after applying the snapshot.

Returns 404 if snapshot doesn't exist (e.g., deleted after compaction, or invalid offset).

#### Read Updates

```
GET /v1/yjs/collab-x7Kp2m/docs/project/chapter-1?offset=4783&live=true
Authorization: Bearer <service-secret>
```

**Query Parameters:**

| Parameter | Required | Description                                                                                                                                                                             |
| --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offset`  | No       | Cursor position to read from. Use `snapshot` for snapshot discovery (see above), `-1` for beginning of stream, or the offset from `stream-next-offset` header after loading a snapshot. |
| `live`    | No       | Set to `true` to hold connection open for real-time updates (max 60 seconds). Server picks optimal transport. Omit for catch-up reads.                                                  |

**Response Headers:**

- `stream-next-offset: <offset>` — The next offset to read from
- `stream-up-to-date: true` — Present when response includes all available data

**Response Body:** Raw binary stream with lib0 framing.

```
Content-Type: application/octet-stream
```

Each update is framed using lib0's `writeVarUint8Array` encoding:

- Length prefix (variable-length unsigned int)
- Yjs update bytes
- Offset (variable-length unsigned int)

This avoids the ~33% overhead of base64 encoding that SSE would require.

**Note:** Writes (POST) send a single raw Yjs update without framing. The server stores updates and adds the lib0 framing with offsets when serving read responses.

When `live=true`, connection stays open until:

- 60 seconds elapsed (client should reconnect with new offset)
- New updates arrive (response completes with data, client reconnects)
- Server closes for other reasons

If timeout expires with no new data, server returns `204 No Content` with `stream-next-offset` and `stream-up-to-date: true` headers.

#### Write Update

```
POST /v1/yjs/collab-x7Kp2m/docs/project/chapter-1
Authorization: Bearer <service-secret>
Content-Type: application/octet-stream

<yjs update binary>
```

**Response:**

```
HTTP/1.1 204 No Content
stream-next-offset: 4783
```

The `stream-next-offset` header contains the new tail offset after the append (per the Durable Streams Protocol). Documents and streams are created implicitly on first write.

#### Awareness

Awareness streams use **SSE (Server-Sent Events)** for real-time delivery. When `live=true` is set on an awareness request, the server uses SSE transport (rather than long-polling) because it better suits the rapid, ephemeral nature of cursor updates.

Awareness is accessed via the `awareness` query parameter on the same document URL:

- `?awareness=default` — default stream for cursor positions, selections, user presence
- `?awareness=admin` — separate stream for admin-only awareness (e.g., moderator cursors)
- `?awareness=<name>` — any custom name for role-based or feature-specific awareness

Awareness streams are scoped to the document path. Two documents (`/docs/a` and `/docs/b`) have completely separate awareness streams, even if they use the same name (e.g., both use `?awareness=default`).

**Subscribe to awareness:**

```
GET /v1/yjs/collab-x7Kp2m/docs/project/chapter-1?awareness=default&offset=now&live=true
Authorization: Bearer <service-secret>
```

**Response:** Server-Sent Events stream per the Durable Streams Protocol format.

```
Content-Type: text/event-stream

event: data
data: <base64-encoded awareness update>

event: control
data: {"streamNextOffset":"abc123","streamCursor":"1000"}
```

The `offset=now` sentinel (per the Durable Streams Protocol) means "start from current tail position, don't replay history." Awareness is ephemeral — clients only care about live updates.

Per the protocol, the server closes SSE connections approximately every 60 seconds to enable CDN collapsing. Clients must reconnect using the last received `streamNextOffset`.

**Broadcast awareness:**

Clients write to awareness streams using the same POST operation as document updates (per the Durable Streams Protocol), but with the `awareness` query parameter:

```
POST /v1/yjs/collab-x7Kp2m/docs/project/chapter-1?awareness=default
Authorization: Bearer <service-secret>
Content-Type: application/octet-stream

<yjs awareness update binary>
```

**Response:**

```
HTTP/1.1 204 No Content
stream-next-offset: <offset>
```

The update is immediately broadcast to all SSE subscribers on that awareness stream. Awareness streams are created lazily on first read or write.

**Client disconnect handling:** Yjs awareness has a built-in 30-second timeout that automatically removes stale clients. The `y-durable-streams` provider also calls `removeAwarenessStates()` on `beforeunload` for immediate cleanup on graceful disconnect. No explicit "leave" API endpoint is needed.

### Compaction

The server automatically compacts documents when the updates stream exceeds a size threshold.

#### Trigger

- Default threshold: 1MB of updates since the last snapshot (or since document creation)
- Threshold is configurable per-service for testing (e.g., `compaction_threshold=1024` for 1KB)

#### Process

```
┌─────────────────────────────────────────────────────────────┐
│                    Compaction Flow                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Detect: updates stream size > threshold                  │
│                                                              │
│  2. Read current state:                                      │
│     - Load existing snapshot (if any) via current offset     │
│     - Read all updates from snapshot offset (or 0)           │
│                                                              │
│  3. Build document:                                          │
│     - Apply snapshot to Y.Doc (if exists)                    │
│     - Apply updates to Y.Doc                                 │
│     - Encode Y.Doc as single snapshot                        │
│                                                              │
│  4. Write new snapshot:                                      │
│     - Record current stream end offset (e.g., 4782)          │
│     - Store snapshot at offset=4782_snapshot                 │
│                                                              │
│  5. Update snapshot pointer:                                 │
│     - offset=snapshot now redirects to offset=4782_snapshot  │
│                                                              │
│  6. Cleanup:                                                 │
│     - Delete old snapshot (if any)                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

Steps 5-6 are sequential: the old snapshot is only deleted after the new snapshot is stored. If the process crashes mid-compaction, the old snapshot remains valid.

#### Client Transparency

Compaction is invisible to clients:

- **During compaction**: Clients continue reading/writing updates normally
- **After compaction**: New clients get redirected to the new snapshot via `offset=snapshot`; existing clients already have the data
- **Snapshot deletion**: If a client receives 404 for a snapshot, they retry with `offset=snapshot` to get the current snapshot location. The `y-durable-streams` provider handles this automatically.

#### Implementation Note

The server uses the JavaScript `yjs` package to decode updates and encode snapshots. Compaction runs asynchronously — it does not block writes. The snapshot offset is determined by the last offset read in step 2; any updates written during encoding will have higher offsets and are read by clients via `stream-next-offset` after loading the snapshot. If compaction fails (e.g., malformed update bytes), the error is logged and compaction is retried on the next threshold trigger; the document stream continues to accept reads and writes.

### Client Sync Flow

The `y-durable-streams` provider implements this flow:

#### Initial Sync

```
┌──────────┐                              ┌──────────┐
│  Client  │                              │  Server  │
└────┬─────┘                              └────┬─────┘
     │                                         │
     │ GET /docs/my-doc?offset=snapshot        │
     │────────────────────────────────────────>│
     │                                         │
     │ 307 Redirect                            │
     │ Location: ?offset=4782_snapshot         │
     │<────────────────────────────────────────│
     │                                         │
     │ GET /docs/my-doc?offset=4782_snapshot   │
     │────────────────────────────────────────>│
     │                                         │
     │ <snapshot binary>                       │
     │ stream-next-offset: 4783                │
     │<────────────────────────────────────────│
     │                                         │
     │ Apply snapshot to Y.Doc                 │
     │                                         │
     │ GET /docs/my-doc?offset=4783&live=true
     │────────────────────────────────────────>│
     │                                         │
     │ (long-poll for new updates)             │
     │                                         │
```

For a new document (no snapshot):

```
┌──────────┐                              ┌──────────┐
│  Client  │                              │  Server  │
└────┬─────┘                              └────┬─────┘
     │                                         │
     │ GET /docs/my-doc?offset=snapshot        │
     │────────────────────────────────────────>│
     │                                         │
     │ 307 Redirect                            │
     │ Location: ?offset=-1                    │
     │<────────────────────────────────────────│
     │                                         │
     │ GET /docs/my-doc?offset=-1              │
     │────────────────────────────────────────>│
     │                                         │
     │ 200 OK (empty body or existing updates) │
     │ stream-next-offset: <offset>            │
     │<────────────────────────────────────────│
     │                                         │
     │ GET /docs/my-doc?offset=<offset>&live=true
     │────────────────────────────────────────>│
     │                                         │
     │ (long-poll for new updates)             │
     │                                         │
```

#### Writing Updates

```
┌──────────┐                              ┌──────────┐
│  Client  │                              │  Server  │
└────┬─────┘                              └────┬─────┘
     │                                         │
     │ Local Y.Doc change                      │
     │                                         │
     │ POST /docs/my-doc                       │
     │ <yjs update binary>                     │
     │────────────────────────────────────────>│
     │                                         │
     │ 204 No Content                          │
     │ stream-next-offset: 4783                │
     │<────────────────────────────────────────│
     │                                         │
     │ (Other clients receive via long-poll)   │
     │                                         │
```

#### Awareness

```
┌──────────┐                              ┌──────────┐
│  Client  │                              │  Server  │
└────┬─────┘                              └────┬─────┘
     │                                         │
     │ GET /docs/my-doc?awareness=default&offset=now&live=true
     │────────────────────────────────────────>│
     │                                         │
     │ (SSE stream - no history, live only)    │
     │                                         │
     │ POST /docs/my-doc?awareness=default     │
     │ <awareness update>                      │
     │────────────────────────────────────────>│
     │                                         │
     │ 204 No Content                          │
     │ stream-next-offset: <offset>            │
     │                                         │
     │ (Broadcast to other SSE subscribers)    │
     │                                         │
```

### Error Responses

All errors return JSON:

```json
{
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document does not exist"
  }
}
```

**Error Codes:**

| Code                 | HTTP Status | Description                                                        |
| -------------------- | ----------- | ------------------------------------------------------------------ |
| `INVALID_REQUEST`    | 400         | Malformed request, invalid doc path or offset format               |
| `UNAUTHORIZED`       | 401         | Missing or invalid service secret                                  |
| `SNAPSHOT_NOT_FOUND` | 404         | Snapshot deleted or invalid (client should retry with `offset=-1`) |
| `DOCUMENT_NOT_FOUND` | 404         | Document stream doesn't exist                                      |
| `OFFSET_EXPIRED`     | 410         | Offset is older than stream retention                              |
| `RATE_LIMITED`       | 429         | Too many requests                                                  |

### TypeScript Types

```typescript
// Response headers per Durable Streams Protocol
interface DurableStreamHeaders {
  "stream-next-offset": string // Next offset to read from (opaque token)
  "stream-up-to-date"?: "true" // Present when caught up with all data
  "stream-cursor"?: string // Cursor for CDN collapsing (long-poll/SSE)
}

// SSE control event payload (camelCase per protocol)
interface SSEControlEvent {
  streamNextOffset: string
  streamCursor: string
  upToDate?: boolean
}

interface YjsError {
  error: {
    code: YjsErrorCode
    message: string
  }
}

type YjsErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "SNAPSHOT_NOT_FOUND"
  | "DOCUMENT_NOT_FOUND"
  | "OFFSET_EXPIRED"
  | "RATE_LIMITED"
```

### Limits

| Limit                | Value                                                             |
| -------------------- | ----------------------------------------------------------------- |
| Compaction threshold | 1MB (default, configurable)                                       |
| Awareness stream TTL | 1 hour                                                            |
| Long-poll timeout    | 60 seconds                                                        |
| Doc path format      | `[a-zA-Z0-9_-/]`, max 256 characters; can include forward slashes |

**Path normalization:** Paths are validated after URL decoding. Paths containing `..` or `.` segments are rejected (400). Double slashes are collapsed to single slashes. This prevents path traversal attacks.

No limits on document size or update size — these are application-level decisions.

### Conformance Suite

The durable-streams repository includes a conformance test suite that validates Yjs Worker implementations. The reference Node.js implementation is tested against this suite.

#### Test Categories

**Snapshot Discovery:**

| Test                               | Description                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `snapshot.discovery-new-doc`       | GET with `offset=snapshot` on new doc returns 307 redirect to `offset=-1`                                   |
| `snapshot.discovery-with-snapshot` | GET with `offset=snapshot` returns 307 redirect to `offset={N}_snapshot`                                    |
| `snapshot.discovery-cached`        | GET with `offset=snapshot` response includes `Cache-Control: private, max-age=5`                            |
| `snapshot.read`                    | GET snapshot URL returns binary data with `stream-next-offset` header                                       |
| `snapshot.not-found`               | GET invalid/deleted snapshot returns 404                                                                    |
| `snapshot.deleted-retry`           | Client receives 404 for snapshot, retries with `offset=snapshot`, gets current snapshot or redirect to `-1` |

**Document Operations:**

| Test                          | Description                                                            |
| ----------------------------- | ---------------------------------------------------------------------- |
| `write.creates-document`      | POST to new doc creates stream implicitly                              |
| `write.returns-offset`        | POST returns 204 with `stream-next-offset` header                      |
| `write.appends-to-stream`     | Sequential POSTs append with incrementing offsets                      |
| `updates.read-from-offset`    | GET updates with offset returns updates from that position             |
| `updates.read-from-beginning` | GET updates with `offset=-1` returns all updates                       |
| `updates.live-polling`        | GET with `live=true` holds connection, receives new updates            |
| `updates.live-timeout`        | Connection returns 204 with `stream-up-to-date: true` after 60 seconds |
| `doc.path-with-slashes`       | Document paths containing forward slashes work correctly               |

**Awareness:**

| Test                           | Description                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `awareness.lazy-creation`      | Awareness stream created on first access                                                       |
| `awareness.offset-now`         | GET with `offset=now&live=true` skips history per protocol                                     |
| `awareness.write`              | POST to `?awareness=<name>` appends to awareness stream, returns 204 with `stream-next-offset` |
| `awareness.broadcast`          | POST awareness delivered to SSE subscribers in real-time                                       |
| `awareness.ttl`                | Awareness stream expires after 1 hour                                                          |
| `awareness.named-streams`      | Query param `?awareness=admin` creates separate stream from `?awareness=default`               |
| `awareness.default-stream`     | `?awareness=default` is the default awareness stream                                           |
| `awareness.sse-control-events` | SSE stream includes `control` events with `streamNextOffset` and `streamCursor`                |

**Compaction:**

| Test                                | Description                                                    |
| ----------------------------------- | -------------------------------------------------------------- |
| `compaction.triggers-at-threshold`  | Compaction starts when updates exceed threshold                |
| `compaction.creates-snapshot-url`   | New snapshot available at `offset={N}_snapshot`                |
| `compaction.updates-redirect`       | `offset=snapshot` redirects to new snapshot                    |
| `compaction.stream-next-offset`     | Snapshot response includes correct `stream-next-offset` header |
| `compaction.deletes-old-snapshot`   | Previous snapshot deleted                                      |
| `compaction.client-transparent`     | Clients sync correctly before/during/after compaction          |
| `compaction.configurable-threshold` | Custom threshold triggers at configured size                   |
| `compaction.single-writer`          | Only one compaction runs per document at a time                |

**Error Handling:**

| Test                     | Description                            |
| ------------------------ | -------------------------------------- |
| `error.invalid-doc-path` | Invalid doc path returns 400           |
| `error.unauthorized`     | Missing/invalid secret returns 401     |
| `error.snapshot-deleted` | Accessing deleted snapshot returns 404 |
| `error.offset-expired`   | Expired offset returns 410             |

#### Running Conformance Tests

```bash
# Test the reference Node.js implementation
pnpm test:conformance --impl=reference

# Test against a running Yjs Worker
pnpm test:conformance --yjs-url=https://api.electric.cloud/v1/yjs/test-svc

# Test with custom compaction threshold (for compaction tests)
pnpm test:conformance --compaction-threshold=1024
```

### Complexity Check

**Is this the simplest approach?**

Yes. The protocol is a thin wrapper over durable streams — each document is a single stream at a URL, updates append, clients long-poll. The `offset=snapshot` redirect pattern for snapshot discovery keeps the API surface minimal while supporting compaction.

**What could we cut?**

- Awareness could be deferred, but it's straightforward (same URL with `?awareness=<name>` query param)
- The `stream-next-offset` header could be omitted if clients always start from `offset=snapshot`, but it saves a redirect on snapshot load

**What's the 90/10 solution?**

This is it. The core is: POST updates, GET updates with long-poll, automatic compaction via `offset=snapshot` redirect. Everything else supports these three operations.

## Open Questions

| Question                                | Options                                                       | Resolution Path                                       |
| --------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| **Compaction during high write volume** | Queue compaction, delay until quiet period, or run regardless | Prototype and observe behavior under load             |
| **Snapshot format versioning**          | Store Yjs version with snapshot for future compatibility      | Decide during implementation if needed                |
| **Snapshot URL caching**                | Should `{offset}_snapshot` URLs be cacheable?                 | Consider Cache-Control headers for snapshot responses |

## Definition of Success

### Primary Hypothesis

> We believe that implementing **Yjs sync over durable streams with automatic compaction** will enable developers to build collaborative apps without running WebSocket infrastructure.
>
> We'll know we're right if **developers successfully use y-durable-streams for production collaborative features**.
>
> We'll know we're wrong if **developers require WebSocket transport or hit compaction issues that block adoption**.

### Functional Requirements

| Requirement            | Acceptance Criteria                                        |
| ---------------------- | ---------------------------------------------------------- |
| Document sync          | Multiple clients can sync a Yjs document via the HTTP API  |
| Presence               | Awareness updates propagate to subscribed clients          |
| Compaction             | Server compacts documents at threshold; clients unaffected |
| Conformance            | Reference implementation passes test suite                 |
| Provider compatibility | Existing y-durable-streams provider works unchanged        |

### Performance Requirements

| Metric                         | Target                        |
| ------------------------------ | ----------------------------- |
| Update propagation             | < 100ms p99                   |
| Initial sync (post-compaction) | < 500ms for typical documents |
| Compaction duration            | < 5s for 1MB of updates       |

### Learning Goals

1. Is HTTP long-polling sufficient for real-time collaboration, or will users request WebSocket?
2. Does 1MB compaction threshold feel right, or do users need to tune it?
3. Are there Yjs edge cases (large updates, rapid writes) that stress the protocol?

## Alternatives Considered

### Alternative 1: WebSocket Transport

**Description:** Implement Yjs sync over WebSockets instead of HTTP long-polling.

**Why not:** WebSocket infrastructure is operationally complex (sticky sessions, connection state). HTTP long-polling works with standard load balancers, CDNs, and edge networks. We can add WebSocket later if there's demand.

### Alternative 2: Client-Side Compaction

**Description:** Have clients detect size threshold and trigger compaction.

**Why not:** Requires developer integration, may never happen, and creates coordination problems (multiple clients racing to compact). Server-side is transparent and reliable.

### Alternative 3: Separate Index Stream

**Description:** Maintain a separate index stream that points to the current snapshot and update offset.

**Why not:** Adds an extra round-trip to fetch the index before loading data. The `offset=snapshot` redirect pattern achieves the same goal with one less request and a simpler mental model — every document is just one URL.

## Revision History

| Version | Date       | Author                 | Changes                                                                               |
| ------- | ---------- | ---------------------- | ------------------------------------------------------------------------------------- |
| 1.0     | 2026-01-21 | kylemathews, samwillis | Initial version with single URL path architecture and redirect-based snapshot loading |
| 1.1     | 2026-01-21 | kylemathews            | Lowercase headers; `live=true` (server picks transport); path normalization           |
