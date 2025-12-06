# DRAFT: The Durable Streams Protocol

**Document:** Durable Streams Protocol  
**Version:** 1.0  
**Date:** 2025-01-XX  
**Author:** ElectricSQL

---

## Abstract

This document specifies the Durable Streams Protocol, an HTTP-based protocol for creating, appending to, and reading from durable, append-only byte streams. The protocol provides a simple, web-native primitive for applications requiring ordered, replayable data streams with support for catch-up reads and live tailing. It is designed to be a foundation for higher-level abstractions such as event sourcing, database synchronization, collaborative editing, and AI conversation histories.

## Copyright Notice

Copyright (c) 2025 ElectricSQL

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Protocol Overview](#3-protocol-overview)
4. [Stream Model](#4-stream-model)
5. [HTTP Operations](#5-http-operations)
   - 5.1. [Create Stream](#51-create-stream)
   - 5.2. [Append to Stream](#52-append-to-stream)
   - 5.3. [Delete Stream](#53-delete-stream)
   - 5.4. [Stream Metadata](#54-stream-metadata)
   - 5.5. [Read Stream - Catch-up](#55-read-stream---catch-up)
   - 5.6. [Read Stream - Live (Long-poll)](#56-read-stream---live-long-poll)
   - 5.7. [Read Stream - Live (SSE)](#57-read-stream---live-sse)
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

While these patterns are widespread, the web platform lacks a simple, first-class primitive for durable streams. Applications typically implement ad-hoc solutions using combinations of databases, queues, and polling mechanisms, each reinventing similar offset-based replay semantics.

The Durable Streams Protocol provides a minimal HTTP-based interface for durable, append-only byte streams. It is intentionally low-level and byte-oriented, allowing higher-level abstractions to be built on top without protocol changes.

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

**Stream**: A URL-addressable, append-only byte stream that can be read and written to. A stream is simply a URL; the protocol defines how to interact with that URL using HTTP methods, query parameters, and headers. Streams are durable and immutable by position; new data can only be appended.

**Offset**: An opaque, lexicographically sortable token that identifies a position within a stream. Clients use offsets to resume reading from a specific previously reached point.

**Content Type**: A MIME type set on stream creation that describes the format of the stream's bytes. The content type is returned on reads and may be used by clients to interpret message boundaries.

**Tail Offset**: The offset immediately after the last byte in the stream. This is the position where new appends will be written.

## 3. Protocol Overview

The Durable Streams Protocol is an HTTP-based protocol that operates on URLs. A stream is simply a URL; the protocol defines how to interact with that URL using standard HTTP methods, query parameters, and custom headers.

The protocol defines operations to create, append to, read, delete, and query metadata for streams. Reads have three modes: catch-up, long-poll, and Server-Sent Events (SSE). The primary operations are:

1. **Create**: Establish a new stream at a URL with optional initial content (PUT)
2. **Append**: Add bytes to the end of an existing stream (POST)
3. **Read**: Retrieve bytes starting from a given offset, with support for catch-up and live modes (GET)
4. **Delete**: Remove a stream (DELETE)
5. **Head**: Query stream metadata without transferring data (HEAD)

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

Clients track their position in a stream using offsets. Offsets are opaque to clients but are lexicographically sortable, allowing clients to determine ordering and resume from any point.

## 5. HTTP Operations

The protocol defines operations that are applied to a stream URL. The examples in this section use `{stream-url}` to represent any stream URL. Servers may implement any URL structure they choose; the protocol is defined by the HTTP methods, query parameters, and headers.

### 5.1. Create Stream

#### Request

```
PUT {stream-url}
```

Where `{stream-url}` is any URL that identifies the stream to be created.

Creates a new stream. If the stream already exists at `{stream-url}`, the server **MUST** either:

- return `200 OK` (or `204 No Content`) if the existing stream's configuration (content type, TTL/expiry) matches the request, or
- return `409 Conflict` if it does not.

This provides idempotent "create or ensure exists" semantics aligned with HTTP PUT expectations.

#### Request Headers (Optional)

- `Content-Type: <stream-content-type>`
  - Sets the stream's content type. If omitted, the server **MAY** default to `application/octet-stream`.

- `Stream-TTL: <seconds>`
  - Sets a relative time-to-live in seconds from creation.

- `Stream-Expires-At: <rfc3339>`
  - Sets an absolute expiry time as an RFC 3339 timestamp.
  - If both `Stream-TTL` and `Stream-Expires-At` are supplied, servers **SHOULD** reject the request with `400 Bad Request`. Implementations **MAY** define a deterministic precedence rule, but **MUST** document it.

#### Request Body (Optional)

- Initial stream bytes. If provided, these bytes form the first content of the stream.

#### Response Codes

- `201 Created`: Stream created successfully
- `200 OK` or `204 No Content`: Stream already exists with matching configuration (idempotent success)
- `409 Conflict`: Stream already exists with different configuration
- `400 Bad Request`: Invalid headers or parameters (including conflicting TTL/expiry)
- `429 Too Many Requests`: Rate limit exceeded

#### Response Headers (on 201 or 200)

- `Location: {stream-url}` (on 201): Servers **SHOULD** include a `Location` header equal to `{stream-url}` in `201 Created` responses.
- `Content-Type: <stream-content-type>`: The stream's content type
- `Stream-Next-Offset: <offset>`: The tail offset after any initial content

### 5.2. Append to Stream

#### Request

```
POST {stream-url}
```

Where `{stream-url}` is the URL of an existing stream.

Appends bytes to the end of an existing stream. Supports both full-body and streaming (chunked) append operations.

Servers that do not support appends for a given stream **SHOULD** return `405 Method Not Allowed` or `501 Not Implemented` to `POST` requests on that URL.

#### Request Headers

- `Content-Type: <stream-content-type>`
  - **MUST** match the stream's existing content type. Servers **MUST** return `400 Bad Request` (or `409 Conflict` for state conflict) on mismatch.

- `Transfer-Encoding: chunked` (optional)
  - Indicates a streaming body. Servers **SHOULD** support HTTP/1.1 chunked encoding and HTTP/2 streaming semantics.

- `Stream-Seq: <string>` (optional)
  - A monotonic, lexicographic writer sequence number for coordination.
  - `Stream-Seq` values are opaque strings that **MUST** compare using simple byte-wise lexicographic ordering. Sequence numbers are scoped per authenticated writer identity (or per stream, depending on implementation). Servers **MUST** document the scope they enforce.
  - If provided and less than or equal to the last appended sequence (as determined by lexicographic comparison), the server **MUST** return `409 Conflict`. Sequence numbers **MUST** be strictly increasing.

#### Request Body

- Bytes to append to the stream. Servers **MUST** reject POST requests with an empty body (Content-Length: 0 or no body) with `400 Bad Request`. Empty appends have no semantic meaning and are likely client errors.

#### Response Codes

- `204 No Content` (recommended) or `200 OK`: Append successful
- `404 Not Found`: Stream does not exist
- `405 Method Not Allowed` or `501 Not Implemented`: Append not supported for this stream
- `409 Conflict`: Sequence regression detected (if `Stream-Seq` provided) or content type mismatch
- `400 Bad Request`: Invalid headers or parameters
- `413 Payload Too Large`: Request body exceeds server limits
- `429 Too Many Requests`: Rate limit exceeded

#### Response Headers (on success)

- `Stream-Next-Offset: <offset>`: The new tail offset after the append

### 5.3. Delete Stream

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

### 5.4. Stream Metadata

#### Request

```
HEAD {stream-url}
```

Where `{stream-url}` is the URL of the stream. Checks stream existence and returns metadata without transferring a body. This is the canonical way to find the tail offset, TTL, and expiry information.

#### Response Codes

- `200 OK`: Stream exists
- `404 Not Found`: Stream does not exist
- `429 Too Many Requests`: Rate limit exceeded

#### Response Headers (on 200)

- `Content-Type: <stream-content-type>`: The stream's content type
- `Stream-Next-Offset: <offset>`: The tail offset (next offset after the current end)
- `Stream-TTL: <seconds>` (optional): Remaining time-to-live, if applicable
- `Stream-Expires-At: <rfc3339>` (optional): Absolute expiry time, if applicable
- `Cache-Control`: See Section 8

#### Caching Guidance

Servers **SHOULD** make `HEAD` responses effectively non-cacheable, for example by returning `Cache-Control: no-store`. Servers **MAY** use `Cache-Control: private, max-age=0, must-revalidate` as an alternative, but `no-store` is recommended to avoid stale tail offsets.

### 5.5. Read Stream - Catch-up

#### Request

```
GET {stream-url}?offset=<offset>
```

Where `{stream-url}` is the URL of the stream. Returns bytes starting from the specified offset. This is used for catch-up reads when a client needs to replay stream content from a known position.

#### Query Parameters

- `offset` (optional)
  - Start offset token. If omitted, defaults to the stream start (offset 0).

#### Response Codes

- `200 OK`: Data available (or empty body if offset equals tail)
- `400 Bad Request`: Malformed offset or invalid parameters
- `404 Not Found`: Stream does not exist
- `410 Gone`: Offset is before the earliest retained position (retention/compaction)
- `429 Too Many Requests`: Rate limit exceeded

For non-live reads without data beyond the requested offset, servers **SHOULD** return `200 OK` with an empty body and `Stream-Next-Offset` equal to the requested offset.

#### Response Headers (on 200)

- `Cache-Control`: Derived from TTL/expiry (see Section 8)
- `ETag: {internal_stream_id}:{start_offset}:{end_offset}`
  - Entity tag for cache validation
- `Stream-Cursor: <cursor>` (optional)
  - Cursor to echo on subsequent long-poll requests to improve CDN collapsing
- `Stream-Next-Offset: <offset>`
  - The next offset to read from (for subsequent requests)
- `Stream-Up-To-Date: true`
  - **MUST** be present and set to `true` when the response includes all data available in the stream at the time the response was generated (i.e., when the requested offset has reached the tail and no more data exists).
  - **SHOULD NOT** be present when returning partial data due to server-defined chunk size limits (when more data exists beyond what was returned).
  - Clients **MAY** use this header to determine when they have caught up and can transition to live tailing mode.

#### Response Body

- Bytes from the stream starting at the specified offset, up to a server-defined maximum chunk size.

### 5.6. Read Stream - Live (Long-poll)

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

- Same as catch-up reads (Section 5.5)

#### Response Headers (on 204)

- `Stream-Next-Offset: <offset>`: Servers **SHOULD** include a `Stream-Next-Offset` header indicating the current tail offset, so clients can confirm they're still up-to-date.

#### Response Body (on 200)

- New bytes that arrived during the long-poll period.

#### Timeout Behavior

The timeout for long-polling is implementation-defined. Servers **MAY** accept a `timeout` query parameter (in seconds) as a future extension, but this is not required by the base protocol.

### 5.7. Read Stream - Live (SSE)

#### Request

```
GET {stream-url}?offset=<offset>&live=sse
```

Where `{stream-url}` is the URL of the stream. Returns data as a Server-Sent Events (SSE) stream. **ONLY** valid for streams with `content-type: text/*` or `application/json` (the stream's configured content type). SSE responses **MUST** use `Content-Type: text/event-stream` in the HTTP response headers.

#### Query Parameters

- `offset` (required)
  - The offset to start reading from.

- `live=sse` (required)
  - Indicates SSE streaming mode.

#### Response Codes

- `200 OK`: Streaming body (SSE format)
- `400 Bad Request`: Content type incompatible with SSE or invalid parameters
- `404 Not Found`: Stream does not exist
- `429 Too Many Requests`: Rate limit exceeded

#### Response Format

Data is emitted in [Server-Sent Events format](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format).

**Events:**

- `data`: Emitted for each batch of data
  - Each line prefixed with `data:`
  - When the stream content type is `application/json`, implementations **MAY** batch multiple logical messages into a single SSE `data` event by streaming a JSON array across multiple `data:` lines, as in the example below.
- `control`: Emitted after every data event
  - **MUST** include `streamNextOffset` and **MAY** include `streamCursor`
  - Format: JSON object with offset and optional cursor. Field names use camelCase: `streamNextOffset` and `streamCursor`.

**Example:**

```
event: data
data: [
data: {"k":"v"},
data: {"k":"w"},
data: ]

event: control
data: {"streamNextOffset":"123456_789","streamCursor":"abc"}
```

#### Connection Lifecycle

- Server **SHOULD** close connections roughly every ~60 seconds to enable CDN collapsing
- Client **MUST** reconnect using the last received `streamNextOffset` value from the control event

## 6. Offsets

Offsets are opaque tokens that identify positions within a stream. They have the following properties:

1. **Opaque**: Clients **MUST NOT** interpret offset structure or meaning
2. **Lexicographically Sortable**: For any two valid offsets for the same stream, a lexicographic comparison determines their relative position in the stream. Clients **MAY** compare offsets lexicographically to determine ordering.
3. **Persistent**: Offsets remain valid for the lifetime of the stream (until deletion or expiration)

**Format**: Offset tokens are opaque, case-sensitive strings. Their internal structure is implementation-defined. Offsets are single tokens and **MUST NOT** contain commas, ampersands, equals signs, or question marks (to avoid conflict with URL query parameter syntax). Servers **SHOULD** use URL-safe characters to avoid encoding issues, but clients **MUST** properly URL-encode offset values when including them in query parameters.

The opaque nature of offsets enables important server-side optimizations. For example, offsets may encode chunk file identifiers, allowing catch-up requests to be served directly from object storage without touching the main database.

Clients **MUST** use the `Stream-Next-Offset` value returned in responses for subsequent read requests. They **SHOULD** persist offsets locally (e.g., in browser local storage or a database) to enable resumability after disconnection or restart.

## 7. Content Types

The protocol supports arbitrary MIME content types. Most content types operate at the byte level, leaving message framing and interpretation to clients. The `application/json` content type has special semantics defined below.

**Restriction:**

- SSE mode (Section 5.7) **REQUIRES** `content-type: text/*` or `application/json`

Clients **MAY** use any content type for their streams, including:

- `application/json` for JSON mode with message boundary preservation
- `application/ndjson` for newline-delimited JSON
- `application/x-protobuf` for Protocol Buffer messages
- `text/plain` for plain text
- Custom types for application-specific formats

### 7.1. JSON Mode

Streams created with `Content-Type: application/json` have special semantics for message boundaries and batch operations.

#### Message Boundaries

For `application/json` streams, servers **MUST** preserve message boundaries. Each appended JSON value is stored as a distinct message, and GET responses **MUST** return data as a JSON array containing all messages from the requested offset range.

#### Array Flattening (One-Level Semantic Batching)

When a client appends a JSON array to an `application/json` stream, servers **MUST** flatten exactly one level of the array, treating each element as a separate message. This enables efficient batching while preserving message semantics.

**Examples:**

- Appending `{"event": "created"}` stores one message: `{"event": "created"}`
- Appending `[1, 2, 3]` stores three messages: `1`, `2`, `3`
- Appending `[[1,2], [3,4]]` stores two messages: `[1,2]`, `[3,4]`
- To store an array as a single message, wrap it: appending `[[1,2,3]]` stores one message: `[1,2,3]`

#### Empty Arrays

Servers **MUST** reject POST requests containing empty JSON arrays (`[]`) with `400 Bad Request`. Empty arrays represent no-op operations with no semantic meaning.

#### JSON Validation

Servers **MUST** validate that appended data is valid JSON. If validation fails, servers **MUST** return `400 Bad Request` with an appropriate error message.

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

**ETag Usage:**

Clients **MAY** use `If-None-Match` with the `ETag` value on repeat catch-up requests. Servers **MAY** respond with `304 Not Modified` when nothing changed for that offset range.

**Collapsing:**

Clients **SHOULD** echo the `Stream-Cursor` value as `cursor=<cursor>` in subsequent long-poll requests. This, along with the appropriate `Cache-Control` header, enables CDNs and proxies to collapse multiple clients waiting for the same data into a single upstream request.

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

### 10.8. TLS

All protocol operations **MUST** be performed over HTTPS (TLS) in production environments to protect data in transit.

## 11. IANA Considerations

This document requests registration of the following HTTP headers in the "Permanent Message Header Field Names" registry:

| Field Name           | Status    | Reference     |
| -------------------- | --------- | ------------- |
| `Stream-TTL`         | permanent | This document |
| `Stream-Expires-At`  | permanent | This document |
| `Stream-Seq`         | permanent | This document |
| `Stream-Cursor`      | permanent | This document |
| `Stream-Next-Offset` | permanent | This document |
| `Stream-Up-To-Date`  | permanent | This document |

**Descriptions:**

- `Stream-TTL`: Relative time-to-live for streams (seconds)
- `Stream-Expires-At`: Absolute expiry time for streams (RFC 3339 timestamp)
- `Stream-Seq`: Writer sequence number for coordination (opaque string)
- `Stream-Cursor`: Cursor for CDN collapsing (opaque string)
- `Stream-Next-Offset`: Next offset for subsequent reads (opaque string)
- `Stream-Up-To-Date`: Indicates up-to-date response (presence header)

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
