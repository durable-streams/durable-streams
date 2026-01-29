# DRAFT: The Durable Streams Protocol

**Document:** Durable Streams Protocol  
**Version:** 1.0  
**Date:** 2025-01-XX  
**Author:** ElectricSQL

---

## Abstract

This document specifies the Durable Streams Protocol, an HTTP-based protocol for creating, appending to, and reading from durable, append-only byte streams. The protocol provides a simple, web-native primitive for applications requiring ordered, replayable data streams with support for catch-up reads, live tailing, and explicit stream closure (EOF). It is designed to be a foundation for higher-level abstractions such as event sourcing, database synchronization, collaborative editing, AI conversation histories, and finite response streaming.

## Copyright Notice

Copyright (c) 2025 ElectricSQL

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Protocol Overview](#3-protocol-overview)
4. [Stream Model](#4-stream-model)
   - 4.1. [Stream Closure](#41-stream-closure)
5. [HTTP Operations](#5-http-operations)
   - 5.1. [Create Stream](#51-create-stream)
   - 5.2. [Append to Stream](#52-append-to-stream)
     - 5.2.1. [Idempotent Producers](#521-idempotent-producers)
   - 5.3. [Close Stream](#53-close-stream)
   - 5.4. [Delete Stream](#54-delete-stream)
   - 5.5. [Stream Metadata](#55-stream-metadata)
   - 5.6. [Read Stream - Catch-up](#56-read-stream---catch-up)
   - 5.7. [Read Stream - Live (Long-poll)](#57-read-stream---live-long-poll)
   - 5.8. [Read Stream - Live (SSE)](#58-read-stream---live-sse)
6. [Offsets](#6-offsets)
7. [Content Types](#7-content-types)
8. [Caching and Collapsing](#8-caching-and-collapsing)
9. [Extensibility](#9-extensibility)
10. [Security Considerations](#10-security-considerations)
11. [IANA Considerations](#11-iana-considerations)
12. [References](#12-references)

---

## 1. Introduction

Modern web and cloud applications frequently require ordered, durable sequences of data that can be replayed from arbitrary points and tailed in real time. Common use cases include:

- Database synchronization and change feeds
- Event-sourced architectures
- Collaborative editing and CRDTs
- AI conversation histories and token streaming
- Workflow execution histories
- Real-time application state updates
- Finite response streaming (proxied HTTP responses, job outputs, file transfers)

While these patterns are widespread, the web platform lacks a simple, first-class primitive for durable streams. Applications typically implement ad-hoc solutions using combinations of databases, queues, and polling mechanisms, each reinventing similar offset-based replay semantics.

The Durable Streams Protocol provides a minimal HTTP-based interface for durable, append-only byte streams. It is intentionally low-level and byte-oriented, allowing higher-level abstractions to be built on top without protocol changes.

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

**Stream**: A URL-addressable, append-only byte stream that can be read and written to. A stream is simply a URL; the protocol defines how to interact with that URL using HTTP methods, query parameters, and headers. Streams are durable and immutable by position; new data can only be appended.

**Offset**: An opaque, lexicographically sortable token that identifies a position within a stream. Clients use offsets to resume reading from a specific previously reached point.

**Content Type**: A MIME type set on stream creation that describes the format of the stream's bytes. The content type is returned on reads and may be used by clients to interpret message boundaries.

**Tail Offset**: The offset immediately after the last byte in the stream. This is the position where new appends will be written.

**Closed Stream**: A stream that has been explicitly closed by a writer. Once closed, a stream is in a terminal state: no further appends are permitted, and readers can observe the closure as an end-of-stream (EOF) signal. Closure is durable and monotonic — once closed, a stream remains closed.

## 3. Protocol Overview

The Durable Streams Protocol is an HTTP-based protocol that operates on URLs. A stream is simply a URL; the protocol defines how to interact with that URL using standard HTTP methods, query parameters, and custom headers.

The protocol defines operations to create, append to, read, close, delete, and query metadata for streams. Reads have three modes: catch-up, long-poll, and Server-Sent Events (SSE). The primary operations are:

1. **Create**: Establish a new stream at a URL with optional initial content (PUT)
2. **Append**: Add bytes to the end of an existing stream (POST)
3. **Close**: Transition a stream to closed state, optionally with a final append (POST with `Stream-Closed: true`)
4. **Read**: Retrieve bytes starting from a given offset, with support for catch-up and live modes (GET)
5. **Delete**: Remove a stream (DELETE)
6. **Head**: Query stream metadata without transferring data (HEAD)

The protocol does not prescribe a specific URL structure. Servers may organize streams using any URL scheme they choose (e.g., `/v1/stream/{path}`, `/streams/{id}`, or domain-specific paths). The protocol is defined by the HTTP methods, query parameters, and headers applied to any stream URL.

Streams support arbitrary content types. The protocol operates at the byte level, leaving message framing and schema interpretation to clients.

**Independent Read/Write Implementation**: Servers **MAY** implement the read and write paths independently. For example, a database synchronization server may only implement the read path and use its own injection system for writes, while a collaborative editing service might implement both paths.

## 4. Stream Model

A stream is an append-only sequence of bytes with the following properties:

- **Durability**: Once written and acknowledged, bytes persist until the stream is deleted or expired
- **Immutability by Position**: Bytes at a given offset never change; new data is only appended
- **Ordering**: Bytes are strictly ordered by offset
- **Content Type**: Each stream has a MIME content type set at creation
- **TTL/Expiry**: Streams may have optional time-to-live or absolute expiry times
- **Retention**: Servers **MAY** implement retention policies that drop data older than a certain age while the stream continues. If a stream is deleted a new stream **SHOULD NOT** be created at the same URL.
- **Stream State**: A stream is either **open** (accepts appends) or **closed** (no further appends permitted). Streams start in the open state and transition to closed via an explicit close operation. This transition is **durable** (persisted) and **monotonic** (once closed, a stream cannot be reopened).

Clients track their position in a stream using offsets. Offsets are opaque to clients but are lexicographically sortable, allowing clients to determine ordering and resume from any point.

### 4.1. Stream Closure

Stream closure provides an explicit end-of-stream (EOF) signal that allows readers to distinguish between "no data yet" and "no more data ever." This is essential for finite streams where writers need to signal completion, such as:

- Proxied HTTP responses that have finished streaming
- Completed job outputs or workflow executions
- Finalized conversation histories or document streams

**Properties of stream closure:**

- **Durable**: The closed state is persisted and survives server restarts
- **Monotonic**: Once closed, a stream cannot be reopened
- **Idempotent**: Closing an already-closed stream succeeds (or returns a stable "already closed" response)
- **Observable**: Readers can detect closure and treat it as EOF
- **Atomic with final append**: Writers can atomically append a final message and close in a single operation

After closure, the stream's data remains fully readable. Only new appends are rejected.

**Stream-Closed Header Value:**

The `Stream-Closed` header uses the value `true` (case-insensitive) to indicate closure. Servers **MUST** treat the header as present only when its value is exactly `true` (case-insensitive comparison). Other values such as `false`, `yes`, `1`, or empty string **MUST** be treated as if the header were absent. Servers **SHOULD NOT** return error responses for non-`true` values; they simply ignore the header.

## 5. HTTP Operations

The protocol defines operations that are applied to a stream URL. The examples in this section use `{stream-url}` to represent any stream URL. Servers may implement any URL structure they choose; the protocol is defined by the HTTP methods, query parameters, and headers.

### 5.1. Create Stream

#### Request

```
PUT {stream-url}
```

Where `{stream-url}` is any URL that identifies the stream to be created.

Creates a new stream. If the stream already exists at `{stream-url}`, the server **MUST** either:

- return `200 OK` if the existing stream's configuration (content type, TTL/expiry, and closure status) matches the request, or
- return `409 Conflict` if it does not.

This provides idempotent "create or ensure exists" semantics aligned with HTTP PUT expectations.

**Closure status matching:** When checking for idempotent success (200 OK), servers **MUST** compare the `Stream-Closed` header in the request against the stream's current closure status. For example:

- `PUT /stream` (no `Stream-Closed`) to an **open** stream with matching config → `200 OK`
- `PUT /stream` (no `Stream-Closed`) to a **closed** stream → `409 Conflict` (closure status mismatch)
- `PUT /stream + Stream-Closed: true` to a **closed** stream with matching config → `200 OK`
- `PUT /stream + Stream-Closed: true` to an **open** stream → `409 Conflict` (closure status mismatch)

#### Request Headers (Optional)

- `Content-Type: <stream-content-type>`
  - Sets the stream's content type. If omitted, the server **MAY** default to `application/octet-stream`.

- `Stream-TTL: <seconds>`
  - Sets a relative time-to-live in seconds from creation. The value **MUST** be a non-negative integer in decimal notation without leading zeros, plus signs, decimal points, or scientific notation (e.g., `3600` is valid; `+3600`, `03600`, `3600.0`, and `3.6e3` are not).

- `Stream-Expires-At: <rfc3339>`
  - Sets an absolute expiry time as an RFC 3339 timestamp.
  - If both `Stream-TTL` and `Stream-Expires-At` are supplied, servers **SHOULD** reject the request with `400 Bad Request`. Implementations **MAY** define a deterministic precedence rule, but **MUST** document it.

- `Stream-Closed: true` (optional)
  - When present, the stream is created in the **closed** state. Any body provided becomes the complete and final content of the stream.
  - This enables atomic "create and close" semantics for single-message or empty streams that are immediately complete (e.g., cached responses, placeholder errors, pre-computed results).
  - **Examples:**
    - `PUT /stream + Stream-Closed: true` (empty body): Creates an empty, immediately-closed stream (useful for "completed with no output" or error placeholders).
    - `PUT /stream + Stream-Closed: true + body`: Creates a single-shot stream with the body as its complete content (useful for cached responses, pre-computed results).

#### Request Body (Optional)

- Initial stream bytes. If provided, these bytes form the first content of the stream.

#### Response Codes

- `201 Created`: Stream created successfully
- `200 OK`: Stream already exists with matching configuration (idempotent success)
- `409 Conflict`: Stream already exists with different configuration
- `400 Bad Request`: Invalid headers or parameters (including conflicting TTL/expiry)
- `429 Too Many Requests`: Rate limit exceeded

#### Response Headers (on 201 or 200)

- `Location: {stream-url}` (on 201): Servers **SHOULD** include a `Location` header equal to `{stream-url}` in `201 Created` responses.
- `Content-Type: <stream-content-type>`: The stream's content type
- `Stream-Next-Offset: <offset>`: The tail offset after any initial content
- `Stream-Closed: true`: Present when the stream was created in the closed state

### 5.2. Append to Stream

#### Request

```
POST {stream-url}
```

Where `{stream-url}` is the URL of an existing stream.

Appends bytes to the end of an existing stream. Supports both full-body and streaming (chunked) append operations. Optionally closes the stream atomically with the append.

Servers that do not support appends for a given stream **SHOULD** return `405 Method Not Allowed` or `501 Not Implemented` to `POST` requests on that URL.

#### Request Headers

- `Content-Type: <stream-content-type>`
  - **MUST** match the stream's existing content type when a body is provided. Servers **MUST** return `409 Conflict` when the content type is valid but does not match the stream's configured type.
  - **MAY** be omitted when the request body is empty (i.e., close-only requests with `Stream-Closed: true`). When the request body is empty, servers **MUST NOT** reject based on `Content-Type` and **MAY** ignore it entirely. This ensures close-only requests remain robust even when clients/libraries attach default `Content-Type` headers.

- `Transfer-Encoding: chunked` (optional)
  - Indicates a streaming body. Servers **SHOULD** support HTTP/1.1 chunked encoding and HTTP/2 streaming semantics.

- `Stream-Seq: <string>` (optional)
  - A monotonic, lexicographic writer sequence number for coordination.
  - `Stream-Seq` values are opaque strings that **MUST** compare using simple byte-wise lexicographic ordering. Sequence numbers are scoped per authenticated writer identity (or per stream, depending on implementation). Servers **MUST** document the scope they enforce.
  - If provided and less than or equal to the last appended sequence (as determined by lexicographic comparison), the server **MUST** return `409 Conflict`. Sequence numbers **MUST** be strictly increasing.

- `Stream-Closed: true` (optional)
  - When present with value `true`, the stream is **closed** after the append completes. This is an atomic operation: the body (if any) is appended as the final data, and the stream transitions to the closed state in the same step.
  - If the request body is empty (Content-Length: 0 or no body), the stream is closed without appending any data. This is the only case where an empty POST body is valid.
  - Once closed, the stream rejects all subsequent appends with `409 Conflict` (see below).
  - **Close-only requests are idempotent**: if the stream is already closed and the request includes `Stream-Closed: true` with an empty body, servers **SHOULD** return `204 No Content` with `Stream-Closed: true`.
  - **Append-and-close requests are NOT idempotent** (without idempotent producer headers): if the stream is already closed and the request includes a body but no idempotent producer headers, servers **MUST** return `409 Conflict` with `Stream-Closed: true`, since the body cannot be appended. However, if idempotent producer semantics apply and the request matches the `(producerId, epoch, seq)` tuple that performed the closing append, servers treat it as a deduplicated success (see Section 5.2.1).

#### Request Body

- Bytes to append to the stream. Servers **MUST** reject POST requests with an empty body (Content-Length: 0 or no body) with `400 Bad Request`, **unless** the `Stream-Closed: true` header is present (which allows closing without appending data).

#### Response Codes

- `204 No Content`: Append successful (or stream already closed when closing idempotently)
- `400 Bad Request`: Malformed request (invalid header syntax, missing Content-Type, empty body without `Stream-Closed: true`)
- `404 Not Found`: Stream does not exist
- `405 Method Not Allowed` or `501 Not Implemented`: Append not supported for this stream
- `409 Conflict`: Content type mismatch with stream's configured type, sequence regression (if `Stream-Seq` provided), or **stream is closed** (when attempting to append without `Stream-Closed: true`)
- `413 Payload Too Large`: Request body exceeds server limits
- `429 Too Many Requests`: Rate limit exceeded

#### Response Headers (on success)

- `Stream-Next-Offset: <offset>`: The new tail offset after the append
- `Stream-Closed: true`: Present when the stream is now closed (either by this request or previously)

#### Response Headers (on 409 Conflict due to closed stream)

When a client attempts to append to a closed stream (without `Stream-Closed: true`), servers **MUST** return:

- `409 Conflict` status code
- `Stream-Closed: true` header
- `Stream-Next-Offset: <offset>`: The final offset of the closed stream (useful for clients to know the stream's final position)

This allows clients to detect and handle the "stream already closed" condition programmatically without parsing the response body. Servers **SHOULD** keep the response body empty or use a standardized error format; clients **SHOULD NOT** rely on parsing the body to determine the reason for rejection.

**Error Precedence:** When an append request would trigger multiple conflict conditions (e.g., stream is closed AND content type mismatches), servers **SHOULD** check the stream's closed status first. This ensures clients receive the `Stream-Closed: true` header, enabling correct error handling. The recommended precedence is:

1. Stream closed → `409 Conflict` with `Stream-Closed: true`
2. Content type mismatch → `409 Conflict`
3. Sequence regression → `409 Conflict`

### 5.2.1. Idempotent Producers

Durable Streams supports Kafka-style idempotent producers for exactly-once write semantics. This enables fire-and-forget writes with server-side deduplication, eliminating duplicates from client retries.

#### Design

- **Client-provided producer IDs**: Zero RTT overhead, no handshake required
- **Client-declared epochs, server-validated fencing**: Client increments epoch on restart; server validates monotonicity and fences stale epochs
- **Per-batch sequence numbers**: Separate from `Stream-Seq`, used for retry safety
- **Two-layer sequence design**:
  - Transport layer: `Producer-Id` + `Producer-Epoch` + `Producer-Seq` (retry safety)
  - Application layer: `Stream-Seq` (cross-restart ordering, lexicographic)

#### Request Headers

All three producer headers **MUST** be provided together or none at all. If only some headers are provided, servers **MUST** return `400 Bad Request`.

- `Producer-Id: <string>`
  - Client-supplied stable identifier (e.g., "order-service-1", UUID)
  - **MUST** be a non-empty string; empty values result in `400 Bad Request`
  - Identifies the logical producer across restarts

- `Producer-Epoch: <integer>`
  - Client-declared epoch, starting at 0
  - Increment on producer restart to establish a new session
  - Server validates that epoch is monotonically non-decreasing
  - **MUST** be a non-negative integer ≤ 2^53-1 (for JavaScript interoperability)

- `Producer-Seq: <integer>`
  - Monotonically increasing sequence number per epoch
  - Starts at 0 for each new epoch
  - Applies per-batch (per HTTP request), not per-message
  - **MUST** be a non-negative integer ≤ 2^53-1 (for JavaScript interoperability)

#### Response Headers

- `Producer-Epoch: <integer>`: Echoed back on success (200/204), or current server epoch on stale epoch (403)
- `Producer-Seq: <integer>`: On success (200/204), the highest accepted sequence number for this `(stream, producerId, epoch)` tuple. Enables clients to confirm pipelined requests and recover state after crashes.
- `Producer-Expected-Seq: <integer>`: On 409 Conflict (sequence gap), the expected sequence
- `Producer-Received-Seq: <integer>`: On 409 Conflict (sequence gap), the received sequence

#### Validation Logic

```
# Epoch validation (client-declared, server-validated)
if epoch < state.epoch:
  → 403 Forbidden
  → Headers: Producer-Epoch: <current epoch>

if epoch > state.epoch:
  if seq != 0:
    → 400 Bad Request (new epoch must start at seq=0)
  → Accept: update state.epoch = epoch, state.lastSeq = 0
  → 200 OK (new epoch established)

# Same epoch: sequence validation
if seq <= state.lastSeq:
  → 204 No Content (duplicate, idempotent success)

if seq == state.lastSeq + 1:
  → Accept, update state.lastSeq = seq
  → 200 OK

if seq > state.lastSeq + 1:
  → 409 Conflict
  → Headers: Producer-Expected-Seq: <lastSeq + 1>, Producer-Received-Seq: <seq>
```

#### Response Codes (with Producer Headers)

- `200 OK`: Append successful (new data)
- `204 No Content`: Duplicate append (idempotent success, data already exists)
- `400 Bad Request`: Invalid producer headers (e.g., non-integer values, epoch increase with seq != 0)
- `403 Forbidden`: Stale producer epoch (zombie fencing). Response includes `Producer-Epoch` header with current server epoch.
- `409 Conflict`: Sequence gap detected. Response includes `Producer-Expected-Seq` and `Producer-Received-Seq` headers.

#### Bootstrap and Restart Flow

1. **Initial start (epoch=0)**:
   - Producer sends `(epoch=0, seq=0)`
   - Server accepts, establishes producer state

2. **Producer restart**:
   - Producer increments local epoch (0 → 1), resets seq to 0
   - Sends `(epoch=1, seq=0)`
   - Server sees epoch > state.epoch, accepts, updates state

3. **Zombie fencing**:
   - Old producer (zombie) still sending `(epoch=0, seq=N)` gets 403 Forbidden
   - Response includes `Producer-Epoch: 1` header

#### Auto-claim Flow (for ephemeral producers)

For serverless or ephemeral producers without persisted epoch:

1. Producer starts fresh with `(epoch=0, seq=0)`
2. If server has `state.epoch=5`, returns 403 with `Producer-Epoch: 5`
3. Client can retry with `(epoch=6, seq=0)` to claim the producer ID

This is opt-in client behavior and should be used with caution.

#### Concurrency Requirements

Servers **MUST** serialize validation + append operations per `(stream, producerId)` pair. HTTP requests can arrive out-of-order; without serialization, seq=1 arriving before seq=0 would cause false sequence gaps.

#### Atomicity Requirements

For persistent storage, servers **SHOULD** commit producer state updates and log appends atomically (e.g., in a single database transaction). Non-atomic implementations have a crash window where:

1. Data is appended to the log
2. Crash occurs before producer state is updated
3. On recovery, a retry may be re-accepted, causing duplicate data

**Recovery for non-atomic stores**: Clients can bump their epoch after a crash to establish a clean session. This trades "exactly once within epoch" for "at least once across crashes" which is acceptable for many use cases. Stores **SHOULD** document their atomicity guarantees clearly.

#### Producer State Cleanup

Servers **MAY** implement TTL-based cleanup for producer state:

- **In-memory stores**: 7 days TTL recommended, clean up on stream access
- **Persistent stores**: Retain as long as stream data exists (stronger guarantee)

After state expiry, the producer is treated as new. A zombie alive past TTL expiry can write again, which is acceptable for testing but persistent stores should use longer retention.

#### Stream Closure with Idempotent Producers

Idempotent producers can close streams using the `Stream-Closed: true` header. The behavior is:

- **Close with final append**: Include body, producer headers, and `Stream-Closed: true`. The append is deduplicated normally, and the stream closes atomically with the final append.
- **Close without append**: Include `Stream-Closed: true` with empty body. Producer headers are optional but if provided, the close operation is still idempotent.
- **Duplicate close**: If the stream was already closed by the same `(producerId, epoch, seq)` tuple, servers **SHOULD** return `204 No Content` with `Stream-Closed: true`.

When a closed stream receives an append from an idempotent producer:

- If the `(producerId, epoch, seq)` matches the request that closed the stream, return `204 No Content` (duplicate/idempotent success) with `Stream-Closed: true`
- Otherwise, return `409 Conflict` with `Stream-Closed: true` (stream is closed, no further appends allowed)

### 5.3. Close Stream

To close a stream without appending data, send a POST request with `Stream-Closed: true` and an empty body:

#### Request

```
POST {stream-url}
Stream-Closed: true
```

#### Response Codes

- `204 No Content`: Stream closed successfully (or already closed—idempotent)
- `404 Not Found`: Stream does not exist
- `405 Method Not Allowed` or `501 Not Implemented`: Append/close not supported for this stream

#### Response Headers

- `Stream-Next-Offset: <offset>`: The tail offset (unchanged, since no data was appended)
- `Stream-Closed: true`: Confirms the stream is now closed

This is the canonical "close-only" operation. For atomic "append final message and close", include a request body as described in Section 5.2.

### 5.4. Delete Stream

#### Request

```
DELETE {stream-url}
```

Where `{stream-url}` is the URL of the stream to delete.

Deletes the stream and all its data. In-flight reads may terminate with a `404 Not Found` on subsequent requests after deletion.

#### Response Codes

- `204 No Content`: Stream deleted successfully
- `404 Not Found`: Stream does not exist
- `405 Method Not Allowed` or `501 Not Implemented`: Delete not supported for this stream

### 5.5. Stream Metadata

#### Request

```
HEAD {stream-url}
```

Where `{stream-url}` is the URL of the stream. Checks stream existence and returns metadata without transferring a body. This is the canonical way to find the tail offset, TTL, expiry information, and **closure status**.

#### Response Codes

- `200 OK`: Stream exists
- `404 Not Found`: Stream does not exist
- `429 Too Many Requests`: Rate limit exceeded

#### Response Headers (on 200)

- `Content-Type: <stream-content-type>`: The stream's content type
- `Stream-Next-Offset: <offset>`: The tail offset (next offset after the current end)
- `Stream-TTL: <seconds>` (optional): Remaining time-to-live, if applicable
- `Stream-Expires-At: <rfc3339>` (optional): Absolute expiry time, if applicable
- `Stream-Closed: true` (optional): Present when the stream has been closed. Absence indicates the stream is still open.
- `Cache-Control`: See Section 8

#### Caching Guidance

Servers **SHOULD** make `HEAD` responses effectively non-cacheable, for example by returning `Cache-Control: no-store`. Servers **MAY** use `Cache-Control: private, max-age=0, must-revalidate` as an alternative, but `no-store` is recommended to avoid stale tail offsets and closure status.

### 5.6. Read Stream - Catch-up

#### Request

```
GET {stream-url}?offset=<offset>
```

Where `{stream-url}` is the URL of the stream. Returns bytes starting from the specified offset. This is used for catch-up reads when a client needs to replay stream content from a known position.

#### Query Parameters

- `offset` (optional)
  - Start offset token. If omitted, defaults to the stream start (offset -1).

#### Response Codes

- `200 OK`: Data available (or empty body if offset equals tail)
- `400 Bad Request`: Malformed offset or invalid parameters
- `404 Not Found`: Stream does not exist
- `410 Gone`: Offset is before the earliest retained position (retention/compaction)
- `429 Too Many Requests`: Rate limit exceeded

For non-live reads without data beyond the requested offset, servers **SHOULD** return `200 OK` with an empty body and `Stream-Next-Offset` equal to the requested offset. If the stream is closed, this response **MUST** also include `Stream-Closed: true` to signal EOF.

#### Response Headers (on 200)

- `Cache-Control`: Derived from TTL/expiry (see Section 8)
- `ETag: {internal_stream_id}:{start_offset}:{end_offset}`
  - Entity tag for cache validation
- `Stream-Cursor: <cursor>` (optional for catch-up, required for live modes)
  - Cursor to echo on subsequent long-poll requests to improve CDN collapsing. Servers **MAY** include this on catch-up reads; it is **required** for live modes when the stream is open (see Sections 5.7, 5.8). Servers **MAY** omit it when `Stream-Closed` is true. Clients **MUST** tolerate its absence when `Stream-Closed` is present.
- `Stream-Next-Offset: <offset>`
  - The next offset to read from (for subsequent requests)
- `Stream-Up-To-Date: true`
  - **MUST** be present and set to `true` when the response includes all data available in the stream at the time the response was generated (i.e., when the requested offset has reached the tail and no more data exists).
  - **SHOULD NOT** be present when returning partial data due to server-defined chunk size limits (when more data exists beyond what was returned).
  - Clients **MAY** use this header to determine when they have caught up and can transition to live tailing mode.
  - **Important:** `Stream-Up-To-Date: true` does **NOT** imply EOF. More data may be appended in the future. Only `Stream-Closed: true` indicates that no more data will ever arrive.
- `Stream-Closed: true`
  - **MUST** be present when the stream is closed **and** the client has reached the final offset **at the time the response is generated**. This includes:
    - Responses that return the final chunk of data, when the stream is already closed at response generation time, or
    - Responses with an empty body when the requested offset equals the tail offset of a closed stream (the canonical EOF signal).
  - When present, clients can conclude that no more data will ever be appended and treat this as EOF.
  - **SHOULD NOT** be present when returning partial data from a closed stream (when more data exists between the response and the final offset). In this case, `Stream-Closed: true` will be returned on a subsequent request that reaches the final offset.
  - **Timing note:** If a stream is closed **after** the final chunk was served (or cached), that chunk will not include `Stream-Closed: true`. Clients discover closure by requesting the next offset (`Stream-Next-Offset` from the previous response), which returns an empty body with `Stream-Closed: true`. This is the expected flow when closure occurs between chunk responses or when serving cached chunks.
  - Clients that need to know closure status before reaching the tail **SHOULD** use `HEAD` (see Section 5.5).

#### Response Body

- Bytes from the stream starting at the specified offset, up to a server-defined maximum chunk size.

### 5.7. Read Stream - Live (Long-poll)

#### Request

```
GET {stream-url}?offset=<offset>&live=long-poll[&cursor=<cursor>]
```

Where `{stream-url}` is the URL of the stream. If no data is available at the specified offset, the server waits up to a timeout for new data to arrive. This enables efficient live tailing without constant polling.

#### Query Parameters

- `offset` (required)
  - The offset to read from. **MUST** be provided.

- `live=long-poll` (required)
  - Indicates long-polling mode.

- `cursor` (optional)
  - Echo of the last `Stream-Cursor` header value from a previous response.
  - Used for collapsing keys in CDN/proxy configurations.

#### Response Codes

- `200 OK`: Data became available within the timeout
- `204 No Content`: Timeout expired with no new data
- `400 Bad Request`: Invalid parameters
- `404 Not Found`: Stream does not exist
- `429 Too Many Requests`: Rate limit exceeded

#### Response Headers (on 200)

- Same as catch-up reads (Section 5.6), plus:
- `Stream-Cursor: <cursor>`: Servers **MUST** include this header. See Section 8.1.

#### Response Headers (on 204)

- `Stream-Next-Offset: <offset>`: Servers **MUST** include a `Stream-Next-Offset` header indicating the current tail offset.
- `Stream-Up-To-Date: true`: Servers **MUST** include this header to indicate the client is caught up with all available data.
- `Stream-Cursor: <cursor>`: Servers **MUST** include this header when the stream is open. Servers **MAY** omit this header when `Stream-Closed` is true (cursor is unnecessary when no further polling is expected). Clients **MUST** tolerate its absence when `Stream-Closed` is present. See Section 8.1.
- `Stream-Closed: true`: **MUST** be present when the stream is closed (see Section 5.6 for semantics). A `204 No Content` with `Stream-Closed: true` indicates EOF.

**EOF Signaling Across Modes:**

Clients should treat **either** of the following as EOF, depending on the mode used:

- **Catch-up mode**: `200 OK` with empty body and `Stream-Closed: true`
- **Long-poll mode**: `204 No Content` with `Stream-Closed: true`
- **SSE mode**: `control` event with `streamClosed: true`

In all cases, `Stream-Closed` / `streamClosed` is the definitive EOF signal. The presence of `Stream-Up-To-Date` / `upToDate` alone does **not** indicate EOF—it only means the client has caught up with currently available data, but more may arrive.

#### Stream Closure Behavior in Long-poll Mode

When the stream is closed and the client is already at the tail offset:

- Servers **MUST NOT** wait for the long-poll timeout
- Servers **MUST** immediately return `204 No Content` with `Stream-Closed: true` and `Stream-Up-To-Date: true`

This ensures clients observing a closed stream do not have hanging connections waiting for data that will never arrive.

#### Response Body (on 200)

- New bytes that arrived during the long-poll period.

#### Timeout Behavior

The timeout for long-polling is implementation-defined. Servers **MAY** accept a `timeout` query parameter (in seconds) as a future extension, but this is not required by the base protocol.

### 5.8. Read Stream - Live (SSE)

#### Request

```
GET {stream-url}?offset=<offset>&live=sse
```

Where `{stream-url}` is the URL of the stream. Returns data as a Server-Sent Events (SSE) stream.

SSE mode supports all content types. For streams with `content-type: text/*` or `application/json`, data events carry UTF-8 text directly. For streams with any other `content-type` (binary streams), servers **MUST** automatically base64-encode data events and include the response header `stream-sse-data-encoding: base64`.

SSE responses **MUST** use `Content-Type: text/event-stream` in the HTTP response headers.

When the stream's configured `content-type` is neither `text/*` nor `application/json`, servers **MUST** include the HTTP response header `stream-sse-data-encoding: base64`. Clients **MUST** check for this header and decode data events accordingly.

#### Query Parameters

- `offset` (required)
  - The offset to start reading from.

- `live=sse` (required)
  - Indicates SSE streaming mode.

#### Response Codes

- `200 OK`: Streaming body (SSE format)
- `400 Bad Request`: Invalid parameters
- `404 Not Found`: Stream does not exist
- `429 Too Many Requests`: Rate limit exceeded

#### Response Format

Data is emitted in [Server-Sent Events format](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format).

**Events:**

- `data`: Emitted for each batch of data
  - Each line prefixed with `data:`
  - For binary streams (where `stream-sse-data-encoding: base64` is present), the `data` event payload represents bytes encoded using standard base64 per [RFC 4648](https://www.rfc-editor.org/rfc/rfc4648) (alphabet: A-Z, a-z, 0-9, +, /).
    - Servers **MAY** split the base64 text across multiple `data:` lines within the same SSE `data` event.
    - Clients **MUST** concatenate the `data:` lines for the event (per SSE rules) and **MUST** remove all `\n` and `\r` characters inserted between lines before base64-decoding.
    - The resulting string (after removing `\n` and `\r`) **MUST** be valid base64 text with length that is a multiple of 4 (or empty).
    - If a `data` event's byte payload length is 0, the base64 text **MUST** be the empty string.
  - Base64 encoding affects only `event: data` payloads. `event: control` events remain JSON as specified and are not encoded.
  - When the stream content type is `application/json`, implementations **MAY** batch multiple logical messages into a single SSE `data` event by streaming a JSON array across multiple `data:` lines, as in the example below.
- `control`: Emitted after every data event
  - **MUST** include `streamNextOffset`. See Section 8.1.
  - **MUST** include `streamCursor` when the stream is open. Servers **MAY** omit `streamCursor` when `streamClosed` is true (cursor is unnecessary when no reconnection is expected).
  - **MUST** include `upToDate: true` when the client is caught up with all available data. Note: `streamClosed: true` implies `upToDate: true` (a closed stream at the final offset is by definition up-to-date), so `upToDate` **MAY** be omitted when `streamClosed` is true.
  - **MUST** include `streamClosed: true` when the stream is closed and all data up to the final offset has been sent.
  - Format: JSON object with offset, cursor (when applicable), up-to-date status, and optionally closed status. Field names use camelCase: `streamNextOffset`, `streamCursor`, `upToDate`, and `streamClosed`.

**Example (normal data):**

```
event: data
data: [
data: {"k":"v"},
data: {"k":"w"},
data: ]

event: control
data: {"streamNextOffset":"123456_789","streamCursor":"abc"}
```

**Example (final data with stream closure):**

```
event: data
data: [
data: {"k":"final"}
data: ]

event: control
data: {"streamNextOffset":"123456_999","streamClosed":true}
```

Note: `streamCursor` is omitted when `streamClosed` is true, since clients must not reconnect after receiving a closed signal.

**Client Compatibility:** Clients **MUST** tolerate the absence of `streamCursor` (in SSE) and `Stream-Cursor` (in HTTP headers) when `streamClosed` / `Stream-Closed` is present. Implementations that assume cursor is always present will break when processing closed stream responses.

#### Stream Closure Behavior in SSE Mode

When the stream is closed:

- The final `control` event **MUST** include `streamClosed: true`
- After emitting the final control event, servers **MUST** close the SSE connection
- Clients receiving `streamClosed: true` **MUST NOT** attempt to reconnect, as no more data will arrive

If the stream is already closed when an SSE connection is established and the client's offset is at the tail:

- Servers **MUST** immediately emit a `control` event with `streamClosed: true` and `upToDate: true`
- Servers **MUST** then close the connection

**Example (binary stream with automatic base64 encoding):**

```
event: data
data: AQIDBAUG
data: BwgJCg==

event: control
data: {"streamNextOffset":"123456_789","streamCursor":"abc"}
```

#### Connection Lifecycle

- Server **SHOULD** close connections roughly every ~60 seconds to enable CDN collapsing
- Client **MUST** reconnect using the last received `streamNextOffset` value from the control event
- Client **MUST NOT** reconnect if the last control event included `streamClosed: true`

## 6. Offsets

Offsets are opaque tokens that identify positions within a stream. They have the following properties:

1. **Opaque**: Clients **MUST NOT** interpret offset structure or meaning
2. **Lexicographically Sortable**: For any two valid offsets for the same stream, a lexicographic comparison determines their relative position in the stream. Clients **MAY** compare offsets lexicographically to determine ordering.
3. **Persistent**: Offsets remain valid for the lifetime of the stream (until deletion or expiration)
4. **Unique**: Each offset identifies exactly one position in the stream. No two positions **MAY** share the same offset.
5. **Strictly Increasing**: Offsets assigned to appended data **MUST** be lexicographically greater than all previously assigned offsets. Server implementations **MUST NOT** use schemes (such as raw UTC timestamps) that can produce duplicate or non-monotonic offsets. Time-based identifiers like ULIDs, which combine timestamps with random components to guarantee uniqueness and monotonicity, are acceptable.

**Format**: Offset tokens are opaque, case-sensitive strings. Their internal structure is implementation-defined. Offsets are single tokens and **MUST NOT** contain `,`, `&`, `=`, `?`, or `/` (to avoid conflict with URL query parameter syntax). Servers **SHOULD** use URL-safe characters to avoid encoding issues, but clients **MUST** properly URL-encode offset values when including them in query parameters. Servers **SHOULD** keep offsets reasonably short (under 256 characters) since they appear in every request URL.

**Sentinel Values**: The protocol defines two special offset sentinel values:

- **`-1` (Stream Beginning)**: The special offset value `-1` represents the beginning of the stream. Clients **MAY** use `offset=-1` as an explicit way to request data from the start. This is semantically equivalent to omitting the offset parameter. Servers **MUST** recognize `-1` as a valid offset that returns data from the beginning of the stream.

- **`now` (Current Tail Position)**: The special offset value `now` allows clients to skip all existing data and begin reading from the current tail position. This is useful for applications that only care about future data (e.g., presence tracking, live monitoring, late joiners to a conversation). The behavior varies by read mode:

  **Catch-up mode** (`offset=now` without `live` parameter):
  - Servers **MUST** return `200 OK` with an empty response body appropriate to the stream's content type:
    - For `application/json` streams: the body **MUST** be `[]` (empty JSON array), consistent with Section 7.1
    - For all other content types: the body **MUST** be 0 bytes (empty)
  - Servers **MUST** include a `Stream-Next-Offset` header set to the current tail position
  - Servers **MUST** include `Stream-Up-To-Date: true` header
  - Servers **SHOULD** return `Cache-Control: no-store` to prevent caching of the tail offset
  - The response **MUST** contain no data messages, regardless of stream content

  **Long-poll mode** (`offset=now&live=long-poll`):
  - Servers **MUST** immediately begin waiting for new data (no initial empty response)
  - This eliminates a round-trip: clients can subscribe to future data in a single request
  - If new data arrives during the wait, servers return `200 OK` with the new data
  - If the timeout expires, servers return `204 No Content` with `Stream-Up-To-Date: true`
  - The `Stream-Next-Offset` header **MUST** be set to the tail position

  **SSE mode** (`offset=now&live=sse`):
  - Servers **MUST** immediately begin the SSE stream from the tail position
  - The first control event **MUST** include the tail offset in `streamNextOffset`
  - If no data has arrived, the first control event **MUST** include `upToDate: true`
  - If data arrives before the first control event, `upToDate` reflects the current state
  - No historical data is sent; only future data events are streamed

  **Closed streams** (`offset=now` on a closed stream):
  - Regardless of the `live` parameter, servers **MUST** return immediately with the closure signal
  - The response **MUST** include `Stream-Closed: true` and `Stream-Up-To-Date: true` headers
  - The `Stream-Next-Offset` header **MUST** be set to the stream's final (tail) offset
  - For catch-up mode: `200 OK` with empty body (or empty JSON array for JSON streams)
  - For long-poll mode: `204 No Content` (no waiting, immediate return)
  - For SSE mode: The first (and only) control event includes `streamClosed: true` and `upToDate: true`, then the connection closes
  - This ensures clients using `offset=now` can immediately discover that a stream has no future data

**Reserved Values**: The sentinel values `-1` and `now` are reserved by the protocol. Server implementations **MUST NOT** generate these strings as actual stream offsets (in `Stream-Next-Offset` headers or SSE control events). This ensures clients can always distinguish between sentinel requests and real offset values.

The opaque nature of offsets enables important server-side optimizations. For example, offsets may encode chunk file identifiers, allowing catch-up requests to be served directly from object storage without touching the main database.

Clients **MUST** use the `Stream-Next-Offset` value returned in responses for subsequent read requests. They **SHOULD** persist offsets locally (e.g., in browser local storage or a database) to enable resumability after disconnection or restart.

## 7. Content Types

The protocol supports arbitrary MIME content types. Most content types operate at the byte level, leaving message framing and interpretation to clients. The `application/json` content type has special semantics defined below.

**SSE Encoding:**

- SSE mode (Section 5.8) supports all content types. For streams with `content-type: text/*` or `application/json`, data events carry UTF-8 text natively. For all other content types, servers automatically base64-encode data events (see Section 5.8).

Clients **MAY** use any content type for their streams, including:

- `application/json` for JSON mode with message boundary preservation
- `application/ndjson` for newline-delimited JSON
- `application/x-protobuf` for Protocol Buffer messages
- `text/plain` for plain text
- Custom types for application-specific formats

### 7.1. JSON Mode

Streams created with JSON content types have special semantics for message boundaries and batch operations. JSON Mode applies to:

- `application/json`
- Any content type with a `+json` suffix (e.g., `application/vnd.api+json`, `application/ld+json`, `application/hal+json`)

The `+json` structured syntax suffix is defined by [RFC 6839](https://www.rfc-editor.org/rfc/rfc6839) and indicates that the content follows JSON representation format. Servers **MUST** treat these content types identically for JSON Mode processing. Content type matching is case-insensitive and ignores parameters (e.g., `application/json; charset=utf-8` is treated as `application/json`).

**Note:** Other structured syntax suffixes (e.g., `+xml`, `+der`, `+zip`) do **NOT** trigger JSON Mode. Only `application/json` and types ending with `+json` are treated as JSON.

#### Encoding

Per [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259), JSON text exchanged between systems **MUST** be encoded using UTF-8. Servers **SHOULD** assume UTF-8 encoding for JSON streams unless a charset parameter explicitly specifies otherwise.

#### Message Boundaries

For JSON streams, servers **MUST** preserve message boundaries. Each POST request stores messages as a distinct unit, and GET responses **MUST** return data as a JSON array containing all messages from the requested offset range.

#### Array Flattening for Batch Operations

When a POST request body contains a JSON array, servers **MUST** flatten exactly one level of the array, treating each element as a separate message. This enables clients to batch multiple messages in a single HTTP request while preserving individual message semantics.

**Examples (direct POST to server):**

- POST body `{"event": "created"}` stores one message: `{"event": "created"}`
- POST body `[{"event": "a"}, {"event": "b"}]` stores two messages: `{"event": "a"}`, `{"event": "b"}`
- POST body `[[1,2], [3,4]]` stores two messages: `[1,2]`, `[3,4]`
- POST body `[[[1,2,3]]]` stores one message: `[[1,2,3]]`

**Note:** Client libraries **MAY** automatically wrap individual values in arrays for batching. For example, a client calling `append({"x": 1})` might send POST body `[{"x": 1}]` to the server, which flattens it to store one message: `{"x": 1}`.

#### Empty Arrays

Servers **MUST** reject POST requests containing empty JSON arrays (`[]`) with `400 Bad Request`. Empty arrays in append operations represent no-op operations with no semantic meaning and likely indicate a client bug.

PUT requests with an empty array body (`[]`) are valid and create an empty stream. The empty array simply means no initial messages are being written.

#### JSON Validation

Servers **MUST** validate that appended data is valid JSON per [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259). Valid JSON values include objects, arrays, strings, numbers, booleans (`true`, `false`), and `null`. If validation fails, servers **MUST** return `400 Bad Request` with an appropriate error message.

#### Response Format

GET responses for `application/json` streams **MUST** return `Content-Type: application/json` with a body containing a JSON array of all messages in the requested range:

```http
HTTP/1.1 200 OK
Content-Type: application/json

[{"event":"created"},{"event":"updated"}]
```

If no messages exist in the range, servers **MUST** return an empty JSON array `[]`.

## 8. Caching and Collapsing

### 8.1. Catch-up and Long-poll Reads

For **shared, non-user-specific streams**, servers **SHOULD** return:

```
Cache-Control: public, max-age=60, stale-while-revalidate=300
```

For **streams that may contain user-specific or confidential data**, servers **SHOULD** use `private` instead of `public` and rely on CDN configurations that respect `Authorization` or other cache keys:

```
Cache-Control: private, max-age=60, stale-while-revalidate=300
```

This enables CDN/proxy caching while allowing stale content to be served during revalidation.

**Caching and Stream Closure:**

Catch-up chunks remain fully cacheable, including chunks at the tail of the stream. When a chunk is returned, it may or may not be the final chunk—this is unknown until the client requests the next offset.

The closure signal is discovered when the client requests the offset **after** the final data:

1. Client reads data and receives `Stream-Next-Offset: X` (the tail offset)
2. Client requests offset `X`
3. If stream is closed: server returns `200 OK` with **empty body** and `Stream-Closed: true`
4. If stream is open: server returns `200 OK` with empty body and `Stream-Up-To-Date: true` (or long-poll/SSE waits for data)

This design ensures:

- All data chunks are cacheable (a chunk that later becomes "final" was still valid data)
- The closure signal is a distinct request/response at the tail offset
- Cached chunks never become "stale" due to closure—clients simply make one more request to discover EOF

**ETag Usage:**

Servers **MUST** generate `ETag` headers for GET responses, except for `offset=now` responses. Clients **MAY** use `If-None-Match` with the `ETag` value on repeat catch-up requests. When a client provides a valid `If-None-Match` header that matches the current ETag, servers **MUST** respond with `304 Not Modified` (with no body) instead of re-sending the same data. This is essential for fast loading and efficient bandwidth usage.

**ETag and Stream Closure:** ETags **MUST** vary with the stream's closure status. When a stream is closed (without new data being appended), the ETag **MUST** change to ensure clients do not receive `304 Not Modified` responses that would hide the closure signal. Implementations **SHOULD** include a closure indicator in the ETag format (e.g., appending `:c` to the ETag when the stream is closed).

**Query Parameter Ordering:**

For optimal cache behavior, clients **SHOULD** order query parameters lexicographically by key name. This ensures consistent URL serialization across implementations and improves CDN cache hit rates.

**Collapsing:**

Clients **SHOULD** echo the `Stream-Cursor` value as `cursor=<cursor>` in subsequent long-poll requests. This, along with the appropriate `Cache-Control` header, enables CDNs and proxies to collapse multiple clients waiting for the same data into a single upstream request.

**Server-Generated Cursors:**

To prevent infinite CDN cache loops (where clients receive the same cached empty response indefinitely), servers **MUST** generate cursors on all live mode responses:

- **Long-poll**: `Stream-Cursor` response header
- **SSE**: `streamCursor` field in `control` events

The cursor mechanism works as follows:

1. **Interval-based Calculation**: Servers divide time into fixed intervals (default: 20 seconds) counted from an epoch (default: October 9, 2024 00:00:00 UTC). The cursor value is the interval number as a decimal string.

2. **Cursor Generation**: For each live response, the server calculates the current interval number and returns it as the cursor value.

3. **Monotonic Progression**: Servers **MUST** ensure cursors never go backwards. When a client provides a `cursor` query parameter that is greater than or equal to the current interval number, the server **MUST** return a cursor strictly greater than the client's cursor (by adding random jitter of 1-3600 seconds). This guarantees monotonic progression and prevents cache cycles.

4. **Client Behavior**: Clients **MUST** include the received cursor value as the `cursor` query parameter in subsequent requests. This creates different cache keys as time progresses, ensuring CDN caches eventually expire.

**Example Cursor Flow:**

```
# Client makes initial long-poll request
GET /stream?offset=123&live=long-poll

# Server returns cursor based on current interval (e.g., interval 1000)
< Stream-Cursor: 1000

# Client echoes cursor on next request
GET /stream?offset=123&live=long-poll&cursor=1000

# If still in same interval, server adds jitter and returns advanced cursor
< Stream-Cursor: 1050
```

**Long-poll Caching:**

CDNs and proxies **SHOULD NOT** cache `204 No Content` responses from long-poll requests in most cases. Long-poll `200 OK` responses are safe to cache when keyed by `offset`, `cursor`, and authentication credentials.

### 8.2. SSE

SSE connections **SHOULD** be closed by the server approximately every 60 seconds. This enables new clients to collapse onto edge requests rather than maintaining long-lived connections to origin servers.

## 9. Extensibility

The Durable Streams Protocol is designed to be extended for specific use cases and implementations. Extensions **SHOULD** be pure supersets of the base protocol, ensuring compatibility with any client that implements the base protocol.

### 9.1. Protocol Extensions

Implementations **MAY** extend the protocol with additional query parameters, headers, or response fields to support domain-specific semantics. For example, a database synchronization implementation might add query parameters to filter by table or schema, or include additional metadata in response headers.

Extensions **SHOULD** follow these principles:

- **Backward Compatibility**: Extensions **MUST NOT** break base protocol semantics. Clients that do not understand extension parameters or headers **MUST** be able to operate using only base protocol features.

- **Pure Superset**: Extensions **SHOULD** be additive only. New parameters and headers **SHOULD** be optional, and servers **SHOULD** provide sensible defaults or fallback behavior when extensions are not used.

- **Version Independence**: Extensions **SHOULD** work with any version of a client that implements the base protocol. Extension negotiation **MAY** be handled through headers or query parameters, but base protocol operations **MUST** remain functional without extension support.

### 9.2. Authentication Extensions

See Section 10.1 for authentication and authorization details. Implementations **MAY** extend the protocol with authentication-related query parameters or headers (e.g., API keys, OAuth tokens, custom authentication headers).

## 10. Security Considerations

### 10.1. Authentication and Authorization

Authentication and authorization are explicitly out of scope for this protocol specification. Clients **SHOULD** implement all standard HTTP authentication primitives (e.g., Basic Authentication [RFC7617], Bearer tokens [RFC6750], Digest Authentication [RFC7616]). Implementations **MUST** provide appropriate access controls to prevent unauthorized stream creation, modification, or deletion, but may do so using any mechanism they choose, including extending the protocol with authentication-related parameters or headers as described in Section 9.2.

### 10.2. Multi-tenant Safety

If stream URLs are guessable, servers **MUST** enforce access controls even when using shared caches. Servers **SHOULD** validate and sanitize stream URLs to prevent path traversal attacks and ensure URL components are within acceptable limits.

### 10.3. Untrusted Content

Clients **MUST** treat stream contents as untrusted input and **MUST NOT** evaluate or execute stream data without appropriate validation. This is particularly important for append-only streams used as logs, where log injection attacks are a concern.

### 10.4. Content Type Validation

Servers **MUST** validate that appended content types match the stream's declared content type to prevent type confusion attacks.

### 10.5. Rate Limiting

Servers **SHOULD** implement rate limiting to prevent abuse. The `429 Too Many Requests` response code indicates rate limit exhaustion.

### 10.6. Sequence Validation

The optional `Stream-Seq` header provides protection against out-of-order writes in multi-writer scenarios. Servers **MUST** reject sequence regressions to maintain stream integrity.

### 10.7. Browser Security Headers

When serving streams to browser clients, servers **SHOULD** include the following headers to prevent MIME-sniffing attacks, cross-origin embedding exploits, and cache-related vulnerabilities:

- `X-Content-Type-Options: nosniff`
  - Servers **SHOULD** include this header on all responses. This prevents browsers from MIME-sniffing the response content and potentially executing it as a different content type (e.g., interpreting binary data as HTML/JavaScript).

- `Cross-Origin-Resource-Policy: cross-origin` (or `same-origin`/`same-site`)
  - Servers **SHOULD** include this header to explicitly control cross-origin embedding. Use `cross-origin` to allow cross-origin access via `fetch()`, `same-site` to restrict to the same registrable domain, or `same-origin` for strict same-origin only. This prevents Cross-Origin Read Blocking (CORB) issues and protects against Spectre-like side-channel attacks.

- `Cache-Control: no-store`
  - Servers **SHOULD** include this header on HEAD responses and on responses containing sensitive or user-specific stream data. This prevents intermediate proxies and CDNs from caching potentially sensitive content. For public, non-sensitive historical reads, servers **MAY** use `Cache-Control: public, max-age=60, stale-while-revalidate=300` as described in Section 8.

- `Content-Disposition: attachment` (optional)
  - Servers **MAY** include this header for `application/octet-stream` responses to prevent inline rendering if a user navigates directly to the stream URL.

These headers provide defense-in-depth for scenarios where stream URLs might be accessed outside the intended programmatic fetch context (e.g., direct navigation, malicious cross-origin embedding via `<script>` or `<img>` tags).

### 10.8. TLS

All protocol operations **MUST** be performed over HTTPS (TLS) in production environments to protect data in transit.

## 11. IANA Considerations

### 11.1. Default Port

The default port for standalone Durable Streams servers is **4437/tcp** (with 4437/udp reserved for future use).

This port was selected from the IANA unassigned range 4434-4440. Standalone server implementations **SHOULD** use port 4437 as the default when no explicit port is configured. When Durable Streams is integrated into an existing web server or application framework, it **SHOULD** use the host server's port instead.

### 11.2. HTTP Headers

This document requests registration of the following HTTP headers in the "Permanent Message Header Field Names" registry:

| Field Name           | Status    | Reference     |
| -------------------- | --------- | ------------- |
| `Stream-TTL`         | permanent | This document |
| `Stream-Expires-At`  | permanent | This document |
| `Stream-Seq`         | permanent | This document |
| `Stream-Cursor`      | permanent | This document |
| `Stream-Next-Offset` | permanent | This document |
| `Stream-Up-To-Date`  | permanent | This document |
| `Stream-Closed`      | permanent | This document |

**Descriptions:**

- `Stream-TTL`: Relative time-to-live for streams (seconds)
- `Stream-Expires-At`: Absolute expiry time for streams (RFC 3339 timestamp)
- `Stream-Seq`: Writer sequence number for coordination (opaque string)
- `Stream-Cursor`: Cursor for CDN collapsing (opaque string)
- `Stream-Next-Offset`: Next offset for subsequent reads (opaque string)
- `Stream-Up-To-Date`: Indicates up-to-date response (presence header)
- `Stream-Closed`: Indicates stream is closed / end-of-stream (presence header, value `true`)

## 12. References

### 12.1. Normative References

[RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, DOI 10.17487/RFC2119, March 1997, <https://www.rfc-editor.org/info/rfc2119>.

[RFC3339] Klyne, G. and C. Newman, "Date and Time on the Internet: Timestamps", RFC 3339, DOI 10.17487/RFC3339, July 2002, <https://www.rfc-editor.org/info/rfc3339>.

[RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, DOI 10.17487/RFC8174, May 2017, <https://www.rfc-editor.org/info/rfc8174>.

[RFC9110] Fielding, R., Ed., Nottingham, M., Ed., and J. Reschke, Ed., "HTTP Semantics", STD 97, RFC 9110, DOI 10.17487/RFC9110, June 2022, <https://www.rfc-editor.org/info/rfc9110>.

[RFC9113] Thomson, M., Ed. and C. Benfield, Ed., "HTTP/2", RFC 9113, DOI 10.17487/RFC9113, June 2022, <https://www.rfc-editor.org/info/rfc9113>.

[RFC7617] Reschke, J., "The 'Basic' HTTP Authentication Scheme", RFC 7617, DOI 10.17487/RFC7617, September 2015, <https://www.rfc-editor.org/info/rfc7617>.

[RFC6750] Jones, M. and D. Hardt, "The OAuth 2.0 Authorization Framework: Bearer Token Usage", RFC 6750, DOI 10.17487/RFC6750, October 2012, <https://www.rfc-editor.org/info/rfc6750>.

[RFC7616] Shekh-Yusef, R., Ed., Ahrens, D., and S. Bremer, "HTTP Digest Access Authentication", RFC 7616, DOI 10.17487/RFC7616, September 2015, <https://www.rfc-editor.org/info/rfc7616>.

### 12.2. Informative References

[SSE] Hickson, I., "Server-Sent Events", W3C Recommendation, February 2015, <https://www.w3.org/TR/eventsource/>.

---

**Full Copyright Statement**

Copyright (c) 2025 ElectricSQL

This document and the information contained herein are provided on an "AS IS" basis. ElectricSQL disclaims all warranties, express or implied, including but not limited to any warranty that the use of the information herein will not infringe any rights or any implied warranties of merchantability or fitness for a particular purpose.
