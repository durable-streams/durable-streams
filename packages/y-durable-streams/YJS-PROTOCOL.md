# The Durable Streams Yjs Protocol

**Document:** Durable Streams Yjs Protocol  
**Version:** 1.0  
**Date:** 2026-01-XX  
**Author:** ElectricSQL  
**Status:** Extension of Durable Streams Protocol

---

## Abstract

This document specifies the Durable Streams Yjs Protocol, an extension of the Durable Streams Protocol [PROTOCOL] that defines an HTTP-based protocol for Yjs document synchronization. The protocol provides durable, append-only streams for Yjs updates with automatic server-side compaction, snapshot management, and ephemeral awareness streams. It is designed to enable real-time collaborative editing over standard HTTP infrastructure without WebSocket complexity.

## Copyright Notice

Copyright (c) 2026 ElectricSQL

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Protocol Overview](#3-protocol-overview)
   - 3.1. [Architecture Overview](#31-architecture-overview)
   - 3.2. [Key Concepts](#32-key-concepts)
4. [URL Structure](#4-url-structure)
5. [HTTP Operations](#5-http-operations)
   - 5.1. [Create Document](#51-create-document)
   - 5.2. [Snapshot Discovery](#52-snapshot-discovery)
   - 5.3. [Read Snapshot](#53-read-snapshot)
   - 5.4. [Read Updates](#54-read-updates)
   - 5.5. [Write Update](#55-write-update)
   - 5.6. [Awareness Subscribe](#56-awareness-subscribe)
   - 5.7. [Awareness Broadcast](#57-awareness-broadcast)
   - 5.8. [Create Awareness Stream](#58-create-awareness-stream)
   - 5.9. [Delete document](#59-delete-document)
   - 5.10. [Delete awareness stream](#510-delete-awareness-stream)
6. [Offset Sentinels](#6-offset-sentinels)
7. [Binary Framing](#7-binary-framing)
   - 7.1. [Variable-Length Integer Encoding](#71-variable-length-integer-encoding)
   - 7.2. [Write Frame Format](#72-write-frame-format-client--server)
   - 7.3. [Read Frame Format](#73-read-frame-format-server--client)
   - 7.4. [Summary](#74-summary)
   - 7.5. [Efficiency](#75-efficiency)
8. [Compaction](#8-compaction)
9. [Client Sync Flow](#9-client-sync-flow)
   - 9.1. [Document Creation](#91-document-creation)
   - 9.2. [Initial Sync](#92-initial-sync)
   - 9.3. [Writing Updates](#93-writing-updates)
   - 9.4. [Awareness](#94-awareness)
10. [Error Handling](#10-error-handling)
11. [Limits](#11-limits)
12. [Security Considerations](#12-security-considerations)
13. [IANA Considerations](#13-iana-considerations)
14. [References](#14-references)

- [Appendix A. Conformance Test Suite](#appendix-a-conformance-test-suite)

---

## 1. Introduction

Yjs is a CRDT library for building collaborative applications that requires infrastructure to synchronize document updates between clients. Traditional approaches use WebSocket servers for real-time broadcast, creating operational complexity around connection management, persistence, and scaling.

The Durable Streams Yjs Protocol extends the Durable Streams Protocol [PROTOCOL] by providing Yjs-specific semantics over HTTP. Instead of WebSocket broadcast, clients:

1. POST updates to an HTTP endpoint (appended to stream)
2. GET updates via long-poll or SSE (cursor-based, resumable)
3. Reconnect from last offset on disconnect

This approach works with standard HTTP infrastructure (load balancers, CDNs, edge networks) without WebSocket complexity.

The protocol is designed to be:

- **HTTP-native**: Uses standard HTTP methods with long-poll or SSE for real-time updates
- **Transparent compaction**: Server automatically compacts documents when updates exceed size thresholds
- **Awareness-enabled**: Supports ephemeral presence streams on the same URL path
- **Resumable**: Clients can reconnect from any offset without data loss

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

**Document Stream**: An append-only log of Yjs updates at a URL path. Each Yjs document corresponds to a single durable stream.

**Snapshot**: A compacted representation of a Yjs document state at a specific offset, created by applying all updates up to that point.

**Snapshot Discovery**: The process of requesting the current snapshot location using the `offset=snapshot` sentinel.

**Snapshot URL**: A URL with offset format `{offset}_snapshot` where `{offset}` is the stream position when the snapshot was taken.

**Awareness Stream**: An ephemeral stream for real-time presence data (cursors, selections, user status) accessed via the `awareness` query parameter.

**Update**: A Yjs binary update representing changes to a document. Updates are appended to the document stream.

**Compaction**: The server-side process of merging accumulated updates into a single snapshot to reduce sync payload size.

## 3. Protocol Overview

The Yjs Protocol operates on durable streams as specified in [PROTOCOL]. Each Yjs document is a single stream at a URL path, with the following Yjs-specific behaviors:

1. **Document creation** is performed via PUT before any reads or writes
2. **Document updates** are appended via POST and read via GET
3. **Snapshots** provide compacted document state, discovered via `offset=snapshot`
4. **Awareness** streams are accessed via the `awareness` query parameter
5. **Compaction** happens automatically when updates exceed a size threshold

The protocol uses `Content-Type: application/octet-stream` for all document operations. Updates are binary Yjs data, and read responses use lib0 framing (Section 7).

### 3.1. Architecture Overview

```
┌───────────────────────────────────────────────────────────────┐
│                    Yjs Document                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  Document Stream: {document-url}                              │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ [0...N] ← append-only log of Yjs updates                │  │
│  │                                                         │  │
│  │ offset=snapshot → 307 redirect to current snapshot      │  │
│  │                   or to offset=-1 if no snapshot        │  │
│  │                                                         │  │
│  │ Snapshot URL: ?offset=4782_snapshot                     │  │
│  │ (offset when snapshot was taken + "_snapshot" suffix─)  │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  Awareness (query param on same URL):                         │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ?awareness=default  (default awareness stream)          │  │
│  │ ?awareness=admin    (custom, e.g., for admin cursors)   │  │
│  │ [ephemeral, 1h TTL, SSE delivery]                       │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 3.2. Key Concepts

| Concept                     | Description                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Document stream             | Append-only log of Yjs updates at the document URL                                                            |
| Snapshot discovery          | `offset=snapshot` sentinel triggers 307 redirect to current snapshot, or to `offset=-1` if no snapshot exists |
| Snapshot URL                | Uses offset format `{offset}_snapshot` where offset is when snapshot was taken                                |
| `Stream-Next-Offset` header | Per Durable Streams Protocol; snapshot responses include this to indicate where to continue reading updates   |
| Awareness                   | Query param `?awareness=<name>` on same URL; `default` is the default stream; ephemeral with 1h TTL           |

## 4. URL Structure

The protocol does not prescribe a specific URL structure. Servers **MAY** organize document streams using any URL scheme they choose. The examples in this document use `{document-url}` to represent any URL that identifies a document stream.

Document paths **MAY** contain forward slashes (e.g., `project/chapter-1`) to enable hierarchical organization.

**Single URL Path Design:**

The document stream, snapshots, and awareness streams all share the same URL path (differentiated by query parameters). This design enables simple authentication proxying:

1. **Unified auth scope**: Awareness streams inherit the same authentication as the document
2. **Simple proxy implementation**: The proxy forwards requests without parsing different stream types
3. **Fine-grained awareness control**: The proxy can inspect the `awareness` query parameter to implement custom authorization

## 5. HTTP Operations

The following HTTP methods are supported on document and awareness URLs:

| Endpoint                          | Supported methods            | All other methods      |
| --------------------------------- | ---------------------------- | ---------------------- |
| `{document-url}`                  | GET, HEAD, POST, PUT, DELETE | 405 Method Not Allowed |
| `{document-url}?awareness=<name>` | GET, HEAD, POST, PUT, DELETE | 405 Method Not Allowed |

Servers **MUST** return `405 Method Not Allowed` for any HTTP method not listed above.

### 5.1. Create Document

Creates a new document. This creates both the document update stream and the default awareness stream. The server uses PUT semantics as defined in [PROTOCOL] Section 5.1.

#### Request

```
PUT {document-url}
```

#### Response (new document)

```
HTTP/1.1 201 Created
Location: {document-url}
Stream-Next-Offset: <offset>
```

#### Response (document already exists)

If the document already exists with matching configuration, the server MUST return:

```
HTTP/1.1 200 OK
Stream-Next-Offset: <offset>
```

If the document exists with different configuration, the server MUST return `409 Conflict`.

Clients MUST create documents via PUT before reading or writing. POST to a non-existent document returns `404 Not Found`.

### 5.2. Snapshot Discovery

The Yjs protocol adds a `snapshot` sentinel offset for snapshot-aware initialization.

#### Request

```
GET {document-url}?offset=snapshot
```

#### Response (snapshot exists)

```
HTTP/1.1 307 Temporary Redirect
Location: {document-url}?offset=4782_snapshot
Cache-Control: private, max-age=5
```

#### Response (no snapshot)

```
HTTP/1.1 307 Temporary Redirect
Location: {document-url}?offset=-1
Cache-Control: private, max-age=5
```

When a snapshot exists, the server **MUST** redirect to the snapshot URL. When no snapshot exists, the server **MUST** redirect to `offset=-1` which uses standard Durable Streams behavior (read from beginning).

Both responses **SHOULD** include `Cache-Control: private, max-age=5` to reduce load during rapid reconnects while ensuring clients receive reasonably fresh snapshot state.

### 5.3. Read Snapshot

Snapshot URLs use the format `offset={offset}_snapshot` where `{offset}` is the position at which the snapshot was taken.

#### Request

```
GET {document-url}?offset=4782_snapshot
```

#### Response

```
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Stream-Next-Offset: 4783

<yjs snapshot binary>
```

The `Stream-Next-Offset` header (per [PROTOCOL]) indicates where the client **MUST** continue reading updates after applying the snapshot.

#### Error Response

Servers **MUST** return `404 Not Found` if the snapshot does not exist (e.g., deleted after compaction, or invalid offset).

### 5.4. Read Updates

#### Request

```
GET {document-url}?offset=<offset>&live=long-poll
GET {document-url}?offset=<offset>&live=sse
```

#### Query Parameters

| Parameter | Required | Description                                                                                                                  |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `offset`  | No       | Cursor position. Use `snapshot` for discovery (Section 5.2), `-1` for beginning, or offset from `Stream-Next-Offset` header. |
| `live`    | No       | `long-poll` for long-polling, `sse` for Server-Sent Events. Omit for catch-up reads.                                         |

#### Response Headers

- `Stream-Next-Offset: <offset>`: The next offset to read from
- `Stream-Up-To-Date: true`: Present when response includes all available data

#### Response Body

Raw binary stream with lib0 framing (Section 7).

```
Content-Type: application/octet-stream
```

#### Long-Poll Mode (`live=long-poll`)

When long-poll mode is requested, the connection stays open until:

- 60 seconds elapsed (client **SHOULD** reconnect with new offset)
- New updates arrive (response completes with data, client reconnects)
- Server closes for other reasons

If timeout expires with no new data, server **MUST** return `204 No Content` with `Stream-Next-Offset` and `Stream-Up-To-Date: true` headers.

#### SSE Mode (`live=sse`)

When SSE mode is requested, the server returns updates via Server-Sent Events. Since this protocol uses `application/octet-stream` for binary data, the base Durable Streams protocol automatically handles binary-to-text encoding for SSE transport (see [PROTOCOL] Section 5.8). Clients using a Durable Streams client library receive decoded binary transparently.

After transport decoding, the payload contains lib0-framed updates identical to the long-poll response body. Clients **MUST** parse lib0 frames as described in Section 7.3.

Per [PROTOCOL], servers **SHOULD** close SSE connections approximately every 60 seconds to enable CDN collapsing. Clients **MUST** reconnect using the last received `streamNextOffset`.

### 5.5. Write Update

#### Request

```
POST {document-url}
Content-Type: application/octet-stream

<lib0-framed update>
```

Appends a Yjs update to the document stream. The document MUST exist (created via PUT per Section 5.1) before appending updates. If the document does not exist, the server MUST return `404 Not Found`.

Clients **MUST** send lib0-framed updates (Section 7.4). Each update is framed with a length prefix using lib0's `writeVarUint8Array`. This is critical because clients may batch multiple updates into a single HTTP request; each update must be individually framed so that concatenated bytes remain valid.

#### Response

```
HTTP/1.1 204 No Content
Stream-Next-Offset: 4783
```

The `Stream-Next-Offset` header contains the new tail offset after the append.

### 5.6. Awareness Subscribe

Awareness streams support both long-poll and SSE transports, using the same `live` parameter as document streams.

Awareness is accessed via the `awareness` query parameter on the same document URL:

- `?awareness=default`: Default stream for cursor positions, selections, user presence
- `?awareness=admin`: Separate stream for admin-only awareness (e.g., moderator cursors)
- `?awareness=<name>`: Any custom name for role-based or feature-specific awareness

Awareness streams are scoped to the document path. Two documents (`/docs/a` and `/docs/b`) have completely separate awareness streams, even if they use the same name.

#### Request (SSE)

```
GET {document-url}?awareness=default&offset=now&live=sse
```

#### Request (Long-Poll)

```
GET {document-url}?awareness=default&offset=now&live=long-poll
```

The `offset=now` sentinel (per [PROTOCOL]) means "start from current tail position, don't replay history." Awareness is ephemeral; clients only care about live updates.

#### Response (SSE)

Server-Sent Events stream per the Durable Streams Protocol format. Since awareness streams use `application/octet-stream`, the base Durable Streams protocol automatically handles binary-to-text encoding for SSE transport (see [PROTOCOL] Section 5.8). Clients using a Durable Streams client library receive decoded binary transparently.

After transport decoding, the payload contains lib0-framed awareness updates. Clients **MUST** parse lib0 frames as described in Section 7.3.

Per [PROTOCOL], servers **SHOULD** close SSE connections approximately every 60 seconds to enable CDN collapsing. Clients **MUST** reconnect using the last received `streamNextOffset`.

#### Response (Long-Poll)

Same as document updates (Section 5.4). Returns lib0-framed binary awareness data with `Content-Type: application/octet-stream`.

### 5.7. Awareness Broadcast

Clients write to awareness streams using the same POST operation as document updates, but with the `awareness` query parameter.

#### Request

```
POST {document-url}?awareness=default
Content-Type: application/octet-stream

<lib0-framed awareness update>
```

Clients **MUST** send lib0-framed awareness updates (Section 7.2). Each awareness update is framed with a length prefix using lib0's `writeVarUint8Array`, consistent with document updates.

#### Response

```
HTTP/1.1 204 No Content
Stream-Next-Offset: <offset>
```

The update is immediately broadcast to all SSE subscribers on that awareness stream. The awareness stream is created automatically when the document is created via PUT (Section 5.1).

**Client disconnect handling:** Yjs awareness has a built-in 30-second timeout that automatically removes stale clients. The `y-durable-streams` provider also calls `removeAwarenessStates()` on `beforeunload` for immediate cleanup on graceful disconnect. No explicit "leave" API endpoint is needed.

When the server auto-creates an awareness stream on POST (e.g., after TTL expiry), the server MUST verify that the parent document exists. If the document does not exist, the server MUST return `404 Not Found` with error code `DOCUMENT_NOT_FOUND`.

### 5.8. Create Awareness Stream

The `default` awareness stream is created automatically when the document is created via PUT (Section 5.1). Additional named awareness streams **MUST** be created explicitly via PUT before they can be used.

#### Request

```
PUT {document-url}?awareness=<name>
```

The document **MUST** exist before creating awareness streams. If the document does not exist, the server **MUST** return `404 Not Found` with error code `DOCUMENT_NOT_FOUND`.

#### Response (new stream)

```
HTTP/1.1 201 Created
```

#### Response (stream already exists)

```
HTTP/1.1 200 OK
```

Creating a stream that already exists is idempotent and returns `200 OK`.

### 5.9. Delete document

Deletes a document and its associated state.

#### Request

```
DELETE {document-url}
```

#### Response

```
HTTP/1.1 204 No Content
```

#### Response (document does not exist)

```
HTTP/1.1 404 Not Found
```

The server MUST return error code `DOCUMENT_NOT_FOUND`.

#### Behavior

The server MUST delete the document update stream. The server SHOULD delete all associated snapshot and awareness streams visible at the time the operation is issued. Servers MAY implement background cleanup of orphaned streams.

After deletion, all operations on the document and its awareness URLs MUST return `404 Not Found`, except PUT on the document URL which creates a new document (Section 5.1).

### 5.10. Delete awareness stream

Deletes a named awareness stream. The parent document is unaffected.

#### Request

```
DELETE {document-url}?awareness=<name>
```

#### Response

```
HTTP/1.1 204 No Content
```

#### Response (stream does not exist)

```
HTTP/1.1 404 Not Found
```

#### Behavior

The server MUST delete the specified awareness stream.

## 6. Offset Sentinels

In addition to the base protocol sentinels (`-1` for beginning, `now` for tail), this protocol defines:

**`snapshot`**: Requests a 307 redirect to the current snapshot URL, or to `offset=-1` if no snapshot exists. Used for snapshot-aware initialization.

**`{offset}_snapshot`**: Identifies a snapshot at a specific offset. The `{offset}` portion indicates when the snapshot was taken; the `_snapshot` suffix distinguishes it from regular stream offsets.

Servers **MUST NOT** generate actual stream offsets that match these sentinel patterns.

## 7. Binary Framing

Read responses use [lib0][LIB0] framing for efficient binary transport. lib0 is a collection of utility functions used by Yjs for binary encoding, providing variable-length integer encoding that minimizes overhead for small values while supporting arbitrarily large numbers.

### 7.1. Variable-Length Integer Encoding

lib0 uses a variable-length unsigned integer encoding where:

- Values 0-127 are encoded in a single byte
- Larger values use continuation bytes, with the high bit indicating whether more bytes follow
- Each byte contributes 7 bits of data

This is similar to Protocol Buffers' varint encoding. For example:

- `0` encodes as `0x00` (1 byte)
- `127` encodes as `0x7F` (1 byte)
- `128` encodes as `0x80 0x01` (2 bytes)
- `300` encodes as `0xAC 0x02` (2 bytes)

### 7.2. Write Frame Format (Client → Server)

Clients **MUST** frame each update before sending. This applies to both document updates and awareness updates. The write frame format is:

1. **Length prefix**: Variable-length unsigned int (lib0's `writeVarUint`) indicating the byte length of the update payload
2. **Update bytes**: The raw update data (Yjs document update or awareness update)

Multiple updates can be concatenated in a single request; the length prefix enables parsing.

**Encoding (client-side):**

```javascript
import * as encoding from "lib0/encoding"

const encoder = encoding.createEncoder()
encoding.writeVarUint8Array(encoder, update) // writes length + bytes
const framedUpdate = encoding.toUint8Array(encoder)
// Send framedUpdate in POST body
```

This is critical for batching: when clients use an idempotent producer that batches multiple `append()` calls into a single HTTP request (concatenating the bytes), each update must be individually framed. Without framing, concatenated raw updates would be invalid. With framing, concatenation produces valid lib0-framed data.

### 7.3. Read Frame Format (Server → Client)

Read responses include the stored lib0-framed updates. Since clients already framed updates on write, the server stores and returns them as-is.

**Decoding (client-side):**

```javascript
import * as decoding from "lib0/decoding"

const decoder = decoding.createDecoder(bytes)
while (decoding.hasContent(decoder)) {
  const update = decoding.readVarUint8Array(decoder)
  // apply update to Y.Doc
}
```

### 7.4. Summary

| Direction               | Applies To                     | Frame Format             | Who Frames               |
| ----------------------- | ------------------------------ | ------------------------ | ------------------------ |
| Write (Client → Server) | Document and awareness updates | `[length][update bytes]` | Client                   |
| Read (Server → Client)  | Document and awareness updates | `[length][update bytes]` | Stored as-is from client |

The server acts as a pass-through for framed updates, storing exactly what clients send. Both document updates and awareness updates use the same lib0 framing format.

### 7.5. Efficiency and Transport Selection

Binary framing minimizes per-update overhead. Transport selection affects latency and bandwidth. Binary-to-text encoding for SSE transport is handled automatically by the base Durable Streams protocol (see [PROTOCOL] Section 5.8).

| Transport | Latency                   | Bandwidth                                | Use Case                                  |
| --------- | ------------------------- | ---------------------------------------- | ----------------------------------------- |
| Long-poll | Higher (polling interval) | Lower (raw bytes)                        | Bandwidth-constrained, infrequent updates |
| SSE       | Lower (push-based)        | Higher (base protocol encoding overhead) | Real-time collaboration, frequent updates |

Developers **MAY** choose the transport that best fits their application's constraints.

## 8. Compaction

The server automatically compacts documents when the update stream exceeds a size threshold.

### 8.1. Trigger

- Default threshold: 1MB of updates since the last snapshot (or since document creation)
- Threshold **MAY** be configurable per-service (e.g., `compaction_threshold=1024` for 1KB in testing)

### 8.2. Process

1. **Detect**: Updates stream size exceeds threshold
2. **Read current state**: Load existing snapshot (if any) and all updates since
3. **Build document**: Apply snapshot and updates to a Y.Doc, encode as single snapshot
4. **Write new snapshot**: Record current stream end offset (e.g., 4782), store snapshot at `offset=4782_snapshot`
5. **Update snapshot pointer**: `offset=snapshot` now redirects to `offset=4782_snapshot`
6. **Cleanup**: Delete old snapshot (if any)

Steps 5-6 are sequential: the old snapshot is only deleted after the new snapshot is stored. If the process crashes mid-compaction, the old snapshot remains valid.

### 8.3. Client Transparency

Compaction is invisible to clients:

- **During compaction**: Clients continue reading/writing updates normally
- **After compaction**: New clients get redirected to the new snapshot via `offset=snapshot`; existing clients already have the data
- **Snapshot deletion**: If a client receives 404 for a snapshot, they **SHOULD** retry with `offset=snapshot` to get the current snapshot location

### 8.4. Implementation Note

The server uses the Yjs library to decode updates and encode snapshots. Compaction runs asynchronously and does not block writes. The snapshot offset is determined by the last offset read in step 2; any updates written during encoding will have higher offsets and are read by clients via `Stream-Next-Offset` after loading the snapshot.

If compaction fails (e.g., malformed update bytes), the error is logged and compaction is retried on the next threshold trigger; the document stream continues to accept reads and writes.

## 9. Client Sync Flow

### 9.1. Document Creation

```
Client                                    Server
  │                                         │
  │ PUT /docs/my-doc                        │
  │────────────────────────────────────────>│
  │                                         │
  │ 201 Created                             │
  │ (or 200 OK if already exists)           │
  │<────────────────────────────────────────│
```

### 9.2. Initial Sync

```
Client                                    Server
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
  │ Stream-Next-Offset: 4783                │
  │<────────────────────────────────────────│
  │                                         │
  │ Apply snapshot to Y.Doc                 │
  │                                         │
  │ GET /docs/my-doc?offset=4783            │
  │     &live=<long-poll|sse>               │
  │────────────────────────────────────────>│
  │                                         │
  │ (subscribe to new updates)              │
```

For a new document (no snapshot):

```
Client                                    Server
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
  │ Stream-Next-Offset: <offset>            │
  │<────────────────────────────────────────│
  │                                         │
  │ GET /docs/my-doc?offset=<offset>        │
  │     &live=<long-poll|sse>               │
  │────────────────────────────────────────>│
```

### 9.3. Writing Updates

```
Client                                    Server
  │                                         │
  │ Local Y.Doc change                      │
  │                                         │
  │ POST /docs/my-doc                       │
  │ <lib0-framed yjs update>               │
  │────────────────────────────────────────>│
  │                                         │
  │ 204 No Content                          │
  │ Stream-Next-Offset: 4783                │
  │<────────────────────────────────────────│
  │                                         │
  │ (Other clients receive via live stream) │
```

### 9.4. Awareness

```
Client                                    Server
  │                                         │
  │ GET /docs/my-doc?awareness=default      │
  │     &offset=now&live=<long-poll|sse>    │
  │────────────────────────────────────────>│
  │                                         │
  │ (live stream - no history, live only)   │
  │                                         │
  │ POST /docs/my-doc?awareness=default     │
  │ <lib0-framed awareness update>         │
  │────────────────────────────────────────>│
  │                                         │
  │ 204 No Content                          │
  │ Stream-Next-Offset: <offset>            │
  │                                         │
  │ (Broadcast to other subscribers)        │
```

## 10. Error Handling

All errors **MUST** return JSON:

```json
{
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document does not exist"
  }
}
```

### Error Codes

| Code                 | HTTP Status | Description                                                              |
| -------------------- | ----------- | ------------------------------------------------------------------------ |
| `INVALID_REQUEST`    | 400         | Malformed request or invalid offset format                               |
| `UNAUTHORIZED`       | 401         | Missing or invalid service secret                                        |
| `SNAPSHOT_NOT_FOUND` | 404         | Snapshot deleted or invalid (client should retry with `offset=snapshot`) |
| `DOCUMENT_NOT_FOUND` | 404         | Document stream doesn't exist                                            |
| `OFFSET_EXPIRED`     | 410         | Offset is older than stream retention                                    |
| `RATE_LIMITED`       | 429         | Too many requests                                                        |
| `INTERNAL_ERROR`     | 500         | Unexpected server-side failure                                           |

## 11. Limits

| Limit                | Value                       |
| -------------------- | --------------------------- |
| Compaction threshold | 1MB (default, configurable) |
| Awareness stream TTL | 1 hour                      |
| Long-poll timeout    | 60 seconds                  |

No limits on document size, update size, or path format are specified by this protocol; these are implementation decisions.

## 12. Security Considerations

### 12.1. Authentication and Authorization

As specified in [PROTOCOL], authentication and authorization are explicitly out of scope for this protocol specification. Implementations **MUST** provide appropriate access controls to prevent unauthorized document creation, modification, or reading.

### 12.2. Path Traversal

Servers **SHOULD** validate document paths to prevent path traversal attacks. Implementations that support hierarchical paths **SHOULD** reject paths containing `..` or `.` segments and normalize double slashes.

### 12.3. Untrusted Content

Clients **MUST** treat stream contents as untrusted input. Yjs updates from the stream **SHOULD** be validated before application to prevent malformed data from corrupting document state.

### 12.4. Awareness Data

Awareness updates are pass-through bytes; the server does not interpret them. Clients **MUST** validate awareness data before use, as malicious clients could send crafted payloads.

### 12.5. Rate Limiting

Servers **SHOULD** implement rate limiting to prevent abuse. The `429 Too Many Requests` response code indicates rate limit exhaustion.

### 12.6. TLS

All protocol operations **MUST** be performed over HTTPS (TLS) in production environments to protect data in transit.

## 13. IANA Considerations

This document does not require any new IANA registrations beyond those specified in [PROTOCOL]. The protocol uses HTTP headers and content types already registered or defined in the base Durable Streams Protocol.

## 14. References

### 14.1. Normative References

**[PROTOCOL]**  
Durable Streams Protocol. ElectricSQL, 2025.  
<https://github.com/electric-sql/durable-streams/blob/main/PROTOCOL.md>

**[RFC2119]**  
Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, DOI 10.17487/RFC2119, March 1997, <https://www.rfc-editor.org/info/rfc2119>.

**[RFC8174]**  
Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, DOI 10.17487/RFC8174, May 2017, <https://www.rfc-editor.org/info/rfc8174>.

### 14.2. Informative References

**[YJS]**  
Yjs - Shared Editing.  
<https://yjs.dev/>

**[LIB0]**  
lib0 - Efficient utility library.  
<https://github.com/dmonad/lib0>

**[SSE]**  
Hickson, I., "Server-Sent Events", W3C Recommendation, February 2015, <https://www.w3.org/TR/eventsource/>.

---

## Appendix A. Conformance Test Suite

This appendix specifies a conformance test suite for validating Yjs Protocol implementations. Implementations passing this suite are considered conformant with the protocol.

### A.1. Test Categories

#### A.1.1. Snapshot Discovery

| Test                               | Description                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `snapshot.discovery-new-doc`       | GET with `offset=snapshot` on new doc returns 307 redirect to `offset=-1`                                   |
| `snapshot.discovery-with-snapshot` | GET with `offset=snapshot` returns 307 redirect to `offset={N}_snapshot`                                    |
| `snapshot.discovery-cached`        | GET with `offset=snapshot` response includes `Cache-Control: private, max-age=5`                            |
| `snapshot.read`                    | GET snapshot URL returns binary data with `Stream-Next-Offset` header                                       |
| `snapshot.not-found`               | GET invalid/deleted snapshot returns 404                                                                    |
| `snapshot.deleted-retry`           | Client receives 404 for snapshot, retries with `offset=snapshot`, gets current snapshot or redirect to `-1` |

#### A.1.2. Document Operations

| Test                          | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `write.requires-put`          | POST to non-existent document returns 404                                         |
| `write.after-put`             | PUT then POST creates and syncs document correctly                                |
| `write.returns-offset`        | POST returns 204 with `Stream-Next-Offset` header                                 |
| `write.appends-to-stream`     | Sequential POSTs append with incrementing offsets                                 |
| `write.rapid-batched-updates` | Rapid writes with batching produce valid lib0-framed data                         |
| `write.multiple-rapid-bursts` | Multiple bursts of rapid writes are correctly stored and synced                   |
| `updates.read-from-offset`    | GET updates with offset returns updates from that position                        |
| `updates.read-from-beginning` | GET updates with `offset=-1` returns all updates                                  |
| `updates.live-long-poll`      | GET with `live=long-poll` holds connection, receives new updates                  |
| `updates.live-sse`            | GET with `live=sse` returns SSE stream (base64 encoding handled by base protocol) |
| `updates.live-timeout`        | Connection returns 204 with `Stream-Up-To-Date: true` after 60 seconds            |
| `doc.path-with-slashes`       | Document paths containing forward slashes work correctly                          |

#### A.1.3. Awareness

| Test                           | Description                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `awareness.created-with-doc`   | Awareness stream created when document is created via PUT                                       |
| `awareness.offset-now`         | GET with `offset=now` skips history per protocol                                                |
| `awareness.live-long-poll`     | Awareness with `live=long-poll` returns long-poll response                                      |
| `awareness.live-sse`           | Awareness with `live=sse` returns SSE stream (base64 encoding handled by base protocol)         |
| `awareness.write`              | POST to `?awareness=<name>` appends to awareness stream, returns 204 with `Stream-Next-Offset`  |
| `awareness.broadcast`          | POST awareness delivered to SSE subscribers in real-time                                        |
| `awareness.ttl`                | Awareness stream expires after 1 hour                                                           |
| `awareness.named-streams`      | Query param `?awareness=admin` creates separate stream from `?awareness=default`                |
| `awareness.default-stream`     | `?awareness=default` is the default awareness stream                                            |
| `awareness.sse-control-events` | SSE stream includes `control` events with `streamNextOffset` and `streamCursor`                 |
| `awareness.put-creates-stream` | PUT on `?awareness=<name>` creates a new awareness stream, POST succeeds after                  |
| `awareness.put-idempotent`     | First PUT returns 201, subsequent PUT returns 200                                               |
| `awareness.put-requires-doc`   | PUT on awareness for non-existent document returns 404 with `DOCUMENT_NOT_FOUND`                |
| `awareness.named-separate`     | Named awareness streams (`cursors`, `presence`) are independent; writes don't cross-contaminate |
| `awareness.post-auto-creates`  | POST to non-existent awareness stream auto-creates it and succeeds                              |
| `awareness.post-ttl-recovery`  | POST recovers from TTL expiry by re-creating the stream transparently                           |
| `awareness.post-concurrent`    | Concurrent POSTs to non-existent stream both succeed                                            |

#### A.1.4. Compaction

| Test                                | Description                                                    |
| ----------------------------------- | -------------------------------------------------------------- |
| `compaction.triggers-at-threshold`  | Compaction starts when updates exceed threshold                |
| `compaction.creates-snapshot-url`   | New snapshot available at `offset={N}_snapshot`                |
| `compaction.updates-redirect`       | `offset=snapshot` redirects to new snapshot                    |
| `compaction.stream-next-offset`     | Snapshot response includes correct `Stream-Next-Offset` header |
| `compaction.deletes-old-snapshot`   | Previous snapshot deleted                                      |
| `compaction.client-transparent`     | Clients sync correctly before/during/after compaction          |
| `compaction.configurable-threshold` | Custom threshold triggers at configured size                   |
| `compaction.single-writer`          | Only one compaction runs per document at a time                |

#### A.1.5. Method Validation

| Test                             | Description                        |
| -------------------------------- | ---------------------------------- |
| `method.doc-rejects-patch`       | PATCH on document URL returns 405  |
| `method.awareness-rejects-patch` | PATCH on awareness URL returns 405 |

#### A.1.6. Error Handling

| Test                     | Description                             |
| ------------------------ | --------------------------------------- |
| `error.invalid-request`  | Invalid request returns 400             |
| `error.unauthorized`     | Missing/invalid credentials returns 401 |
| `error.snapshot-deleted` | Accessing deleted snapshot returns 404  |
| `error.offset-expired`   | Expired offset returns 410              |

#### A.1.7. Document deletion

| Test                                      | Description                                                          |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `delete.doc-returns-204`                  | DELETE on existing document returns 204                              |
| `delete.doc-returns-404`                  | DELETE on non-existent document returns 404 DOCUMENT_NOT_FOUND       |
| `delete.doc-then-get-returns-404`         | GET after DELETE returns 404                                         |
| `delete.doc-then-post-returns-404`        | POST after DELETE returns 404                                        |
| `delete.doc-then-put-creates-fresh`       | PUT after DELETE creates new document (201)                          |
| `delete.doc-cascades-awareness`           | DELETE document removes associated awareness streams                 |
| `delete.doc-cascades-snapshots`           | DELETE document removes associated snapshots                         |
| `delete.awareness-returns-204`            | DELETE on existing awareness stream returns 204                      |
| `delete.awareness-returns-404`            | DELETE on non-existent awareness stream returns 404                  |
| `delete.awareness-preserves-document`     | DELETE awareness does not affect parent document                     |
| `delete.awareness-post-requires-document` | POST to awareness on deleted document returns 404 DOCUMENT_NOT_FOUND |

### A.2. Running Conformance Tests

The reference test suite is available in the `y-durable-streams` package:

```bash
# Test the reference implementation
pnpm test:conformance --impl=reference

# Test against a running server
pnpm test:conformance --url=https://example.com/yjs

# Test with custom compaction threshold (for compaction tests)
pnpm test:conformance --compaction-threshold=1024
```

---

**Full Copyright Statement**

Copyright (c) 2026 ElectricSQL

This document and the information contained herein are provided on an "AS IS" basis. ElectricSQL disclaims all warranties, express or implied, including but not limited to any warranty that the use of the information herein will not infringe any rights or any implied warranties of merchantability or fitness for a particular purpose.
