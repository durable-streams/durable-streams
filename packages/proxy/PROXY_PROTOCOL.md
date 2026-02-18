# DRAFT: The Durable Streams Proxy Protocol

**Document:** Durable Streams Proxy Protocol Extension  
**Version:** 0.2  
**Date:** 2026-02-XX  
**Author:** ElectricSQL  
**Base Protocol:** [The Durable Streams Protocol](../../PROTOCOL.md)

---

## Abstract

This document specifies the Durable Streams Proxy Protocol, an extension to the [Durable Streams Protocol](../../PROTOCOL.md) that adds proxy operations for forwarding HTTP requests to upstream servers while persisting their streaming responses to durable streams. This enables clients to make any HTTP streaming response resumable — if a connection drops mid-stream, the client reconnects to the durable stream and continues reading from where it left off, without data loss or repeating the upstream request.

The proxy protocol supports both single-request and multi-request streams. Multiple upstream responses can be appended to the same stream using explicit, client-chosen stream IDs, enabling session-based patterns where an entire conversation accumulates in a single durable stream. All upstream response data is written using a binary framing format that encapsulates response metadata and body data, allowing readers to reconstruct individual responses from the multiplexed stream.

## Copyright Notice

Copyright (c) 2026 ElectricSQL

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Protocol Overview](#3-protocol-overview)
4. [HTTP Operations](#4-http-operations)
   - 4.1. [URL-Based Dispatch](#41-url-based-dispatch)
   - 4.2. [Create Proxy Stream](#42-create-proxy-stream)
   - 4.3. [Create or Append to Proxy Stream](#43-create-or-append-to-proxy-stream)
   - 4.4. [Connect](#44-connect)
   - 4.5. [Read Proxy Stream](#45-read-proxy-stream)
   - 4.6. [Abort Upstream](#46-abort-upstream)
   - 4.7. [Stream Metadata](#47-stream-metadata)
   - 4.8. [Delete Proxy Stream](#48-delete-proxy-stream)
   - 4.9. [Stream Lifecycle](#49-stream-lifecycle)
5. [Stream Framing Format](#5-stream-framing-format)
   - 5.1. [Frame Structure](#51-frame-structure)
   - 5.2. [Frame Types](#52-frame-types)
   - 5.3. [Response Lifecycle](#53-response-lifecycle)
   - 5.4. [Parsing](#54-parsing)
6. [Header Handling](#6-header-handling)
   - 6.1. [Upstream Request Headers](#61-upstream-request-headers)
   - 6.2. [Hop-by-Hop Header Filtering](#62-hop-by-hop-header-filtering)
7. [Upstream URL Allowlist](#7-upstream-url-allowlist)
   - 7.1. [Redirect Blocking](#71-redirect-blocking)
8. [Pre-signed URLs](#8-pre-signed-urls)
   - 8.1. [URL Format](#81-url-format)
   - 8.2. [Signature Generation and Verification](#82-signature-generation-and-verification)
   - 8.3. [Scope](#83-scope)
   - 8.4. [Expiration and TTL](#84-expiration-and-ttl)
   - 8.5. [Write and Connect Paths](#85-write-and-connect-paths)
9. [Upstream Fetch Lifecycle](#9-upstream-fetch-lifecycle)
   - 9.1. [Timeouts](#91-timeouts)
   - 9.2. [Response Piping and Framing](#92-response-piping-and-framing)
   - 9.3. [Abort Behavior](#93-abort-behavior)
10. [Authentication](#10-authentication)
    - 10.1. [Service Authentication](#101-service-authentication)
    - 10.2. [Stream Authentication](#102-stream-authentication)
11. [CORS](#11-cors)
    - 11.1. [Preflight (OPTIONS)](#111-preflight-options)
    - 11.2. [Response Headers](#112-response-headers)
12. [Error Codes](#12-error-codes)
13. [Security Considerations](#13-security-considerations)
14. [References](#14-references)

---

## 1. Introduction

The [Durable Streams Protocol](../../PROTOCOL.md) provides a minimal HTTP-based interface for durable, append-only byte streams with offset-based resumption. The base protocol requires clients to create a stream, make the upstream request, and pipe the response into the stream themselves. While flexible, this is unnecessary complexity for the most common use case: making an existing HTTP streaming response resumable.

The Proxy Protocol extension solves this by introducing a server-side proxy that:

1. Accepts an HTTP request destined for an upstream service
2. Forwards the request to the upstream service
3. Creates a durable stream and pipes the upstream response into it in the background, using a binary framing format
4. Returns a capability URL (pre-signed URL) that grants the client read and abort access to the stream

The proxy supports **stream reuse** — multiple upstream responses can be appended to the same stream. Clients address streams by name using explicit IDs in the URL path, so no session-to-stream mapping is needed. Combined with the binary framing format, this enables session-based patterns where an entire conversation (multiple request/response turns) accumulates in a single durable stream. Each response is encapsulated in frames that carry a response ID, allowing readers to reconstruct individual responses from the multiplexed stream.

For session-based use cases, the proxy supports a **connect** operation that optionally authorizes the client via a developer-provided auth endpoint and returns a pre-signed read URL for the stream. Connect serves as both the initial session setup and the mechanism for obtaining fresh signed URLs when they expire — the client simply connects again to the same stream ID.

```
┌──────────┐        ┌──────────────────┐        ┌──────────────┐
│  Client  │──POST─►│  Proxy Server    │──req──►│  Upstream    │
│          │◄─201───│                  │◄─res───│  (OpenAI,    │
│          │        │  Writes framed   │        │  Anthropic)  │
│          │──GET──►│  response to     │        │              │
│          │◄─data──│  durable stream  │        └──────────────┘
│          │        │                  │
│  (resume │──GET──►│  ┌────────────┐  │
│  on      │◄─data──│  │  Durable   │  │
│  reconn) │        │  │  Streams   │  │
│          │        │  │  Backend   │  │
└──────────┘        │  └────────────┘  │
                    └──────────────────┘
```

### 1.1. Relationship to the Base Protocol

The proxy protocol is a pure superset of the base Durable Streams Protocol (see Section 9 of the base protocol). Proxy streams are regular durable streams — the read path uses the same `Stream-*` headers, offset semantics, and live modes (long-poll, SSE) defined in the base protocol. The stream content is binary framed data (see Section 5) — the base protocol transports it as opaque bytes.

The proxy protocol adds:

- A creation mechanism that combines upstream fetching with stream creation
- Stream reuse via the append operation
- Stream-level authorization via the connect operation
- A binary framing format for encapsulating upstream responses
- Pre-signed capability URLs for per-stream authentication
- Configurable signed URL TTL
- Upstream URL allowlisting for SSRF prevention
- Abort semantics for cancelling in-flight upstream requests

Servers implementing the proxy protocol **MUST** also implement the read path of the base Durable Streams Protocol.

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

**Proxy Server**: A server implementing this protocol that forwards HTTP requests to upstream services and persists their responses to durable streams.

**Upstream**: The target HTTP service to which the proxy forwards requests (e.g., an AI inference API).

**Upstream Request**: The HTTP request that the proxy sends to the upstream service on behalf of the client.

**Upstream Response**: The HTTP response received from the upstream service.

**Pre-signed URL**: A capability URL containing a cryptographic signature that grants access to a specific stream without requiring separate authentication credentials.

**Service Authentication**: Authentication that identifies a trusted caller authorized to create and manage proxy streams. The mechanism is implementation-defined (see Section 10).

**Response ID**: A 4-byte unsigned integer that identifies a specific upstream response within a stream. Assigned sequentially starting from 1.

**Frame**: A binary envelope that wraps upstream response data written to the stream (see Section 5).

## 3. Protocol Overview

The proxy protocol defines operations using URL paths and query parameters for dispatch:

| Method | Path                                                   | Description                                     |
| ------ | ------------------------------------------------------ | ----------------------------------------------- |
| POST   | `{proxy-url}`                                          | Create a new stream (server-generated ID) (4.2) |
| POST   | `{proxy-url}/{stream-id}`                              | Create or append to a named stream (4.3)        |
| POST   | `{proxy-url}/{stream-id}?action=connect`               | Connect — obtain a pre-signed read URL (4.4)    |
| GET    | `{proxy-url}/{stream-id}?expires=&signature=`          | Read framed data from a proxy stream (4.5)      |
| HEAD   | `{proxy-url}/{stream-id}`                              | Get stream metadata (4.7)                       |
| PATCH  | `{proxy-url}/{stream-id}?action=abort[&response={id}]` | Abort upstream connection(s) (4.6)              |
| DELETE | `{proxy-url}/{stream-id}`                              | Delete a proxy stream (4.8)                     |

The protocol does not prescribe a specific URL structure. The examples in this document use `/v1/proxy` as the base URL, but implementations **MAY** use any URL scheme they choose. The protocol is defined by the HTTP methods, query parameters, and headers applied to the proxy URLs.

**Stream IDs** may be server-generated or client-specified. For `POST {proxy-url}` (no stream ID in the path), the server generates a unique ID. For `POST {proxy-url}/{stream-id}`, the client specifies the stream ID directly. Implementations **SHOULD** accept any URL-safe string as a stream ID and **SHOULD** use UUIDs or another scheme for server-generated IDs.

**Multi-phase flow:**

1. **Create** (POST without stream ID): Client sends upstream request details to the proxy. The proxy generates a stream ID, creates a stream, fetches from upstream, and writes the response using the framing format (Section 5). Returns a pre-signed URL in the `Location` header.
2. **Create or Append** (POST with stream ID): Client sends upstream request details to a named stream. If the stream doesn't exist, it is created; if it exists, the response is appended. Returns a pre-signed URL.
3. **Connect** (POST with `?action=connect`): Client requests a pre-signed read URL for a named stream, optionally authorized via a developer-provided auth endpoint. No data is written to the stream.
4. **Read** (GET): Client reads from the pre-signed URL, which returns the framed stream data. Supports offset-based resumption and live modes from the base protocol.
5. **Reconnect**: When a signed URL expires, the client connects again to the same stream ID to obtain a fresh URL (same operation as step 3).

## 4. HTTP Operations

### 4.1. URL-Based Dispatch

The proxy determines the operation from the URL path and query parameters:

| URL Pattern                                   | Operation                                           |
| --------------------------------------------- | --------------------------------------------------- |
| `POST {proxy-url}`                            | **Create** — new stream, server-generated ID (4.2)  |
| `POST {proxy-url}/{stream-id}`                | **Create or Append** — upsert to named stream (4.3) |
| `POST {proxy-url}/{stream-id}?action=connect` | **Connect** — obtain pre-signed read URL (4.4)      |

Write operations (create, create-or-append) require the `Upstream-URL` header. Connect operations do not fetch from upstream (though they may optionally forward to an auth endpoint via `Upstream-URL`).

If the `action` query parameter is present and its value is not recognized for the given HTTP method, the server **MUST** return `400 Bad Request` with error code `INVALID_ACTION`. Servers **MUST NOT** fall through to another operation when an unrecognized `action` is specified.

### 4.2. Create Proxy Stream

#### Request

```
POST {proxy-url}
```

Creates a new proxy stream by forwarding a request to an upstream service and persisting the response to a durable stream using the framing format (Section 5).

#### Request Headers

- `Upstream-URL` (required)
  - The full URL of the upstream service to forward the request to.
  - **MUST** be a valid absolute HTTP or HTTPS URL.
  - **MUST** match at least one pattern in the server's allowlist (see Section 7).

- `Upstream-Method` (required)
  - The HTTP method to use for the upstream request.
  - **MUST** be one of: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.

- `Upstream-Authorization` (optional)
  - Authorization credentials for the upstream service.
  - Sent as the `Authorization` header on the upstream request.
  - The client's `Authorization` header is used for proxy authentication and is **NOT** forwarded to upstream.

- `Stream-Signed-URL-TTL` (optional)
  - TTL in seconds for the generated pre-signed URL (see Section 8.4).
  - If omitted, the server uses its configured default.

- `Content-Type` (optional)
  - Content type of the request body, forwarded to upstream.

- Other headers
  - All other headers are forwarded to upstream, subject to hop-by-hop filtering (see Section 6.2).

#### Request Body (Optional)

The request body is forwarded to the upstream service as-is.

#### Response — Success (upstream 2xx)

```http
HTTP/1.1 201 Created
Location: {proxy-url}/{stream-id}?expires={timestamp}&signature={sig}
Upstream-Content-Type: {content-type}
Stream-Response-Id: {response-id}
```

- **`201 Created`**: The proxy successfully received a 2xx response from upstream, created a durable stream, and began writing the upstream response in the background using the framing format (Section 5).
- **`Location`**: A pre-signed capability URL for reading from and aborting the stream (see Section 8).
- **`Upstream-Content-Type`**: The `Content-Type` of the upstream response. Clients can use this to interpret the stream data without parsing the Start frame.
- **`Stream-Response-Id`**: The numeric response ID assigned to this upstream response within the stream. Clients use this to demultiplex the correct response from the framed stream data.
- **No response body**: The upstream response body is written as framed data to the durable stream in the background.

The proxy **MUST** return the `201` response before the upstream response body is fully consumed. The piping runs asynchronously — the client begins reading the stream via GET while the proxy continues writing to it.

The upstream response is written to the stream as a sequence of frames: a Start frame (containing the upstream status and headers), followed by Data frames (containing the response body chunks), followed by a terminal frame (Complete, Abort, or Error). See Section 5 for the framing format.

The first response written to a new stream is assigned response ID `1`.

#### Response — Upstream Error (4xx/5xx)

```http
HTTP/1.1 502 Bad Gateway
Upstream-Status: {status-code}
Content-Type: {upstream-content-type}

{upstream error body}
```

When the upstream service returns a non-2xx, non-3xx response:

- **`502 Bad Gateway`**: Indicates an upstream error.
- **`Upstream-Status`**: The HTTP status code from the upstream response.
- **Body**: The upstream error response body. Implementations **SHOULD** truncate large error bodies to prevent memory exhaustion.

No stream is created. No frames are written.

#### Response — Upstream Redirect (3xx)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error": {"code": "REDIRECT_NOT_ALLOWED", "message": "Proxy cannot follow redirects"}}
```

The proxy **MUST NOT** follow HTTP redirects from upstream. See Section 7.1.

#### Response — Other Errors

See Section 12 for the full error code table.

### 4.3. Create or Append to Proxy Stream

#### Request

```
POST {proxy-url}/{stream-id}
Upstream-URL: {upstream-url}
Upstream-Method: {method}
```

Creates a new proxy stream with the specified ID, or appends to it if it already exists (**upsert** semantics). The upstream response is written using the framing format (Section 5) — as the first response if the stream is new, or the next sequential response if appending.

#### Request Headers

Same as Section 4.2 (Create):

- `Upstream-URL` (required)
- `Upstream-Method` (required)
- `Upstream-Authorization` (optional)
- `Stream-Signed-URL-TTL` (optional)
- `Content-Type` (optional)
- Other headers forwarded to upstream (see Section 6)

#### Authentication

Service authentication is required (see Section 10).

#### Validation

1. Validate service authentication
2. If stream exists, verify it is not closed (return `409` if closed)
3. Validate `Upstream-URL` against allowlist

#### Response — Success (upstream 2xx, new stream)

```http
HTTP/1.1 201 Created
Location: {proxy-url}/{stream-id}?expires={timestamp}&signature={sig}
Upstream-Content-Type: {content-type}
Stream-Response-Id: {response-id}
```

- **`201 Created`**: The stream was newly created.

#### Response — Success (upstream 2xx, existing stream)

```http
HTTP/1.1 200 OK
Location: {proxy-url}/{stream-id}?expires={timestamp}&signature={sig}
Upstream-Content-Type: {content-type}
Stream-Response-Id: {response-id}
```

- **`200 OK`**: The upstream response is being appended to the existing stream.

Both responses include:

- **`Location`**: A pre-signed capability URL for reading from and aborting the stream (see Section 8). The server **MUST** return a fresh pre-signed URL on every successful response.
- **`Upstream-Content-Type`**: The `Content-Type` of the upstream response.
- **`Stream-Response-Id`**: The numeric response ID assigned to this upstream response. The first response in a stream is `1`, the next is `2`, and so on.
- **No response body**. The upstream response body is written to the durable stream in the background.

#### Response — Errors

- **`409 Conflict`** with `STREAM_CLOSED`: The stream has been closed (via the base protocol) and cannot accept new data.
- All other errors from Section 4.2 (upstream errors, redirect blocking, etc.) apply.

### 4.4. Connect

#### Request

```
POST {proxy-url}/{stream-id}?action=connect
```

Obtains a pre-signed read URL for a named stream, optionally authorizing the client via a developer-provided auth endpoint. Connect does not write data to the stream and does not return a response body.

This operation serves as both the initial session setup and the mechanism for obtaining fresh signed URLs — when a URL expires, the client simply connects again to the same stream ID. If the stream does not yet exist, it is created.

The proxy always uses the `POST` method when calling the auth endpoint. The `Upstream-Method` header is not used for connect operations.

#### Query Parameters

- `action=connect` (required) — Identifies this as a connect operation.
- Any additional query parameters (e.g., `offset`, `live`, `cursor`) are preserved in the returned `Location` URL (see Response below).

#### Request Headers

- `Upstream-URL` (optional)
  - The URL of an auth endpoint. If provided, the proxy forwards the request to this URL for an authorization check before returning the signed URL.
  - **MUST** match at least one pattern in the server's allowlist (see Section 7).
  - If omitted, the proxy trusts service authentication alone (suitable for simple deployments without user-level authorization).

- `Upstream-Authorization` (optional)
  - Forwarded as `Authorization` to the auth endpoint.

- `Stream-Signed-URL-TTL` (optional)
  - TTL in seconds for the generated pre-signed URL (see Section 8.4).

#### Request Body (Optional)

If `Upstream-URL` is provided, the request body is forwarded to the auth endpoint as-is.

#### Server Behavior

1. Validate service authentication
2. Extract stream ID from the URL path
3. If `Upstream-URL` is provided:
   - Forward a POST request to `Upstream-URL` with:
     - `Stream-Id: {stream-id}` header
     - Client's original headers (per Section 6.1)
     - Original request body
   - If auth endpoint returns non-2xx: return `401 Unauthorized` with `CONNECT_REJECTED`
4. Check if stream exists; create it if not
5. Generate a fresh pre-signed URL for the stream
6. If the client included additional query parameters (e.g., `offset`, `live`), append them to the generated URL
7. Return the signed URL to the client

#### Query Parameter Passthrough

When the client includes query parameters beyond `action=connect`, the server preserves them in the returned `Location` URL. For example:

```
POST {proxy-url}/my-stream?action=connect&offset=4096&live=sse
```

Returns:

```
Location: {proxy-url}/my-stream?expires={ts}&signature={sig}&offset=4096&live=sse
```

The signature covers only the stream ID and expiry — the additional parameters are unsigned and included for client convenience. This allows clients to obtain a ready-to-use read URL that resumes from a specific offset without an additional request.

#### Auth Endpoint Contract

The auth endpoint is a developer-provided endpoint responsible for deciding whether the client is allowed to access this stream. The proxy calls it with a `POST` request containing:

- The client's auth headers (e.g., `Authorization` via `Upstream-Authorization`)
- A `Stream-Id` header identifying the durable stream
- The original request body (if any)

The auth endpoint **SHOULD** perform a real authorization check (e.g., "does this user have access to this conversation?"). It returns:

- **2xx**: Approved — proxy generates a signed URL
- **Non-2xx**: Rejected — proxy returns `401 Unauthorized` to the client

The auth endpoint's response body is discarded by the proxy. Only the status code matters.

Implementers **SHOULD NOT** return `200` unconditionally from their auth endpoint. The auth endpoint is the developer's opportunity to revoke access to a stream. An auth endpoint that always approves effectively grants permanent access, regardless of the signed URL's expiration.

#### Response — Success (new stream)

```http
HTTP/1.1 201 Created
Location: {proxy-url}/{stream-id}?expires={timestamp}&signature={sig}
```

#### Response — Success (existing stream)

```http
HTTP/1.1 200 OK
Location: {proxy-url}/{stream-id}?expires={timestamp}&signature={sig}
```

- **`201 Created`** or **`200 OK`**: `201` when the stream was newly created, `200` when connecting to an existing stream.
- **`Location`**: A fresh pre-signed URL for the stream (with any passthrough query parameters appended).
- **No response body**.

#### Response — Errors

- **`401 Unauthorized`** with `CONNECT_REJECTED`: The auth endpoint returned a non-2xx response (client is not authorized for this stream).

### 4.5. Read Proxy Stream

#### Request

```
GET {proxy-url}/{stream-id}?expires={ts}&signature={sig}[&offset={offset}][&live={mode}]
```

Reads data from an existing proxy stream. This operation delegates to the underlying durable stream, returning the raw stream bytes which contain framed data (Section 5). Supports the same offset-based reads and live modes defined in the base Durable Streams Protocol.

#### Authentication

Authenticates via pre-signed URL parameters (`expires` and `signature`) or via service authentication as a fallback. See Sections 8 and 10.

#### Query Parameters

- `expires`, `signature` — Pre-signed URL authentication (see Section 8)
- `offset` — Start offset in bytes (see base protocol Section 5.6)
- `live` — Live mode: `long-poll` or `sse` (see base protocol Sections 5.7, 5.8)
- `cursor` — Cursor for CDN collapsing (see base protocol Section 8.1)

#### Response

The response body contains framed binary data (see Section 5). Clients **MUST** parse the frame format to extract individual upstream responses. The byte offset semantics from the base protocol apply — clients can resume reading from any byte offset, including mid-frame. Client implementations **MUST** handle partial frames when resuming from a non-zero offset that falls within a frame.

#### Response Headers

All standard `Stream-*` response headers from the base protocol.

#### Response Codes

- `200 OK`: Data available
- `204 No Content`: Long-poll timeout with no new data
- `401 Unauthorized`: Missing or invalid authentication
- `404 Not Found`: Stream does not exist

For full response semantics (offsets, live modes, stream closure), see the base Durable Streams Protocol Sections 5.6–5.8.

#### Expired URL Response

When a read request fails because the pre-signed URL has expired but the HMAC signature is valid, the server **MUST** return a structured error response:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": {
    "code": "SIGNATURE_EXPIRED",
    "message": "Pre-signed URL has expired",
    "streamId": "{stream-id}"
  }
}
```

The `streamId` field identifies the stream so the client can reconnect. A caller with valid service authentication (and, if configured, auth endpoint approval) can obtain a fresh URL via the connect operation: `POST {proxy-url}/{stream-id}?action=connect` (Section 4.4). Note that connect requires service authentication — a holder of only a pre-signed URL cannot refresh it directly; the request must be issued by a caller with service credentials (typically the client's backend).

This distinguishes between two failure modes:

- **Expired**: Valid HMAC, expired timestamp — caller with service auth can reconnect via connect to obtain a fresh URL
- **Invalid**: Bad HMAC — no recovery possible, return `SIGNATURE_INVALID`

### 4.6. Abort Upstream

#### Request

```
PATCH {proxy-url}/{stream-id}?action=abort[&response={response-id}]
```

Aborts active upstream connections for a stream. If the `response` query parameter is provided, only the specified response is aborted; otherwise, all active responses are aborted. This is useful for cancelling expensive operations (e.g., stopping AI text generation mid-response).

#### Authentication

Authenticates via pre-signed URL parameters (`expires` and `signature`) or via service authentication as a fallback. See Sections 8 and 10.

#### Query Parameters

- `action=abort` (required) — Specifies the abort action.
- `response` (optional) — The numeric response ID to abort. If omitted, all active responses are aborted.
- `expires`, `signature` — Pre-signed URL authentication (see Section 8).

#### Behavior

- If `response` is specified: cancels the upstream connection for that response ID only. Other active responses continue unaffected.
- If `response` is omitted: cancels all active upstream connections for this stream.
- For each aborted response, any buffered data is flushed as a Data frame, followed by an Abort frame (`A`) (see Section 5.2).
- Data written before the abort is preserved and readable.
- **Idempotent**: Aborting a response that is not active (already completed, already aborted, or does not exist) succeeds silently.

#### Response

```http
HTTP/1.1 204 No Content
```

### 4.7. Stream Metadata

#### Request

```
HEAD {proxy-url}/{stream-id}
```

Returns stream metadata headers without a body. Delegates to the underlying durable stream's HEAD operation.

#### Authentication

Service authentication only (see Section 10). Pre-signed URLs are not accepted for HEAD requests.

#### Response Headers

Same as the base protocol Section 5.5.

#### Response Codes

- `200 OK`: Stream exists
- `401 Unauthorized`: Missing or invalid service authentication
- `404 Not Found`: Stream does not exist

### 4.8. Delete Proxy Stream

#### Request

```
DELETE {proxy-url}/{stream-id}
```

Deletes the stream and aborts any in-flight upstream connections.

#### Authentication

Service authentication only (see Section 10). Pre-signed URLs are not accepted for DELETE requests.

#### Behavior

- If upstream connections are active for this stream, they are aborted.
- The underlying durable stream is deleted, removing all persisted data.
- **Idempotent**: Deleting a non-existent stream returns `204 No Content`.

#### Response

```http
HTTP/1.1 204 No Content
```

### 4.9. Stream Lifecycle

The proxy protocol does not manage stream closure. Each upstream response is self-contained within its frame sequence (Start → Data\* → terminal frame), so readers always know when a response is complete regardless of the stream's open/closed state.

Closing or deleting a stream is an application-level concern:

- **Delete** (Section 4.8): Removes the stream and all persisted data, aborting any in-flight upstream connections.
- **Close via base protocol**: Applications can close a stream using the base Durable Streams Protocol (e.g., `Stream-Closed: true` on a write), preventing further appends while preserving existing data for reads.
- **Retention policies**: Implementations **MAY** apply their own retention or expiry policies to clean up idle streams.

## 5. Stream Framing Format

All data written to proxy streams uses a binary framing format. Each upstream response is encapsulated as a sequence of frames carrying a response ID, enabling multiple responses to be multiplexed onto a single stream and reconstructed independently by readers.

The framing is transparent to the base Durable Streams Protocol — it is simply bytes in an append-only stream. Only the proxy server (writer) and proxy-aware clients (readers) understand the frame format.

### 5.1. Frame Structure

Every frame has a fixed 9-byte header followed by a variable-length payload:

```
┌──────────┬─────────────────┬────────────────────┬─────────────────┐
│ Type     │ Response ID     │ Payload Length     │ Payload         │
│ (1 byte) │ (4 bytes, BE)   │ (4 bytes, BE)      │ (variable)      │
└──────────┴─────────────────┴────────────────────┴─────────────────┘
```

- **Type** (1 byte): An ASCII character identifying the frame type (see Section 5.2).
- **Response ID** (4 bytes, big-endian unsigned integer): Identifies which upstream response this frame belongs to. Assigned sequentially starting from `1`.
- **Payload Length** (4 bytes, big-endian unsigned integer): The number of bytes in the payload. May be `0` for frames with no payload.
- **Payload** (variable): Frame-type-specific data. Exactly `Payload Length` bytes.

Every frame follows the same structure: read 1 byte, read 4 bytes, read 4 bytes, read N bytes. There are no exceptions or variable-header formats.

### 5.2. Frame Types

| Type     | Byte   | ASCII | Payload            | Description                                  |
| -------- | ------ | ----- | ------------------ | -------------------------------------------- |
| Start    | `0x53` | `S`   | JSON object        | Upstream response metadata (status, headers) |
| Data     | `0x44` | `D`   | Raw bytes          | Upstream response body chunk                 |
| Complete | `0x43` | `C`   | Empty (length `0`) | Response completed successfully              |
| Abort    | `0x41` | `A`   | Empty (length `0`) | Response was aborted by the client           |
| Error    | `0x45` | `E`   | JSON object        | Response failed due to an error              |

#### Start Frame (`S`)

Marks the beginning of a new upstream response. The payload is a JSON object containing the upstream response's HTTP status code and headers:

```json
{
  "status": 200,
  "headers": {
    "content-type": "text/event-stream",
    "x-request-id": "abc-123"
  }
}
```

The `status` field is REQUIRED. The `headers` field is REQUIRED and contains the upstream response headers as a flat key-value object. Header names **MUST** be lowercased. An empty object (`{}`) is valid when no upstream headers are relevant (e.g., after hop-by-hop filtering).

There **MUST** be exactly one Start frame per response ID, and it **MUST** be the first frame for that response ID.

#### Data Frame (`D`)

Contains a chunk of the upstream response body as raw bytes. There may be zero or more Data frames per response ID, appearing after the Start frame and before the terminal frame.

Implementations **SHOULD** batch small chunks before writing Data frames to reduce write overhead (see Section 9.2).

#### Complete Frame (`C`)

Signals that the upstream response completed successfully — the entire response body has been received and written. The payload length is `0`.

#### Abort Frame (`A`)

Signals that the upstream connection was intentionally cancelled by the client (via the abort operation, Section 4.6). Any data received before the abort has already been written in preceding Data frames. The payload length is `0`.

#### Error Frame (`E`)

Signals that the upstream response failed due to an error (e.g., network failure, timeout, storage error). The payload is a JSON object containing an error code and message:

```json
{
  "code": "UPSTREAM_TIMEOUT",
  "message": "Upstream did not send data within 600 seconds"
}
```

Error codes used in Error frames **SHOULD** be drawn from the error codes defined in Section 12.

### 5.3. Response Lifecycle

Each upstream response follows this frame sequence:

```
Start (S) → Data (D)* → Complete (C) | Abort (A) | Error (E)
```

1. Exactly one **Start** frame opens the response.
2. Zero or more **Data** frames carry the response body.
3. Exactly one **terminal frame** (Complete, Abort, or Error) closes the response.

There **MUST** be exactly one terminal frame per response ID.

Response IDs are assigned sequentially starting from `1`. The first upstream response written to a stream gets response ID `1`, the next gets `2`, and so on. Response IDs are only assigned when an upstream response is successfully initiated (upstream returns 2xx) — failed upstream requests (4xx/5xx returned to the client as 502) do not consume a response ID and no frames are written.

Multiple responses **MAY** be in flight concurrently (interleaved Data frames from different response IDs). Readers demultiplex by filtering frames by response ID.

### 5.4. Parsing

To parse the stream, readers repeat the following steps:

1. Read 1 byte → frame type
2. Read 4 bytes → response ID (big-endian unsigned integer)
3. Read 4 bytes → payload length (big-endian unsigned integer)
4. Read `payload_length` bytes → payload

When resuming from a non-zero offset, the reader may begin mid-frame. Client implementations **MUST** either:

- Track byte offsets at frame boundaries and resume from the nearest frame boundary, or
- Buffer partial frame data and skip incomplete frames at the start of a resumed read

Implementations **SHOULD** validate that frame type bytes are one of the defined types (`S`, `D`, `C`, `A`, `E`) and reject unknown types.

## 6. Header Handling

### 6.1. Upstream Request Headers

When forwarding the client's request to upstream, the proxy applies the following transformations:

| Client Header            | Upstream Behavior                                            |
| ------------------------ | ------------------------------------------------------------ |
| `Authorization`          | **NOT forwarded.** Used for proxy authentication.            |
| `Upstream-Authorization` | Sent as `Authorization` to upstream.                         |
| `Upstream-URL`           | Used as the upstream request URL. Not forwarded as a header. |
| `Upstream-Method`        | Used as the upstream HTTP method. Not forwarded as a header. |
| `Stream-Signed-URL-TTL`  | Proxy-specific. Not forwarded to upstream.                   |
| `Host`                   | Set to the upstream host. Client's `Host` is not forwarded.  |
| Hop-by-hop headers       | Stripped (see Section 6.2).                                  |
| All other headers        | Forwarded as-is to upstream.                                 |

For connect operations (Section 4.4), the proxy adds a `Stream-Id` header to the forwarded request containing the stream ID from the URL path.

The following headers are returned by the proxy in responses and are **not** request headers:

| Response Header         | Description                                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `Location`              | Pre-signed URL for the stream.                                           |
| `Upstream-Content-Type` | The `Content-Type` of the upstream response.                             |
| `Upstream-Status`       | The HTTP status code of the upstream response (on `502` errors).         |
| `Stream-Response-Id`    | The numeric response ID assigned to the upstream response in the stream. |

### 6.2. Hop-by-Hop Header Filtering

The proxy **MUST** strip the following hop-by-hop headers before forwarding to upstream, as they are specific to the client-proxy connection and not meaningful for the proxy-upstream connection:

- `Connection`
- `Keep-Alive`
- `Proxy-Authenticate`
- `Proxy-Authorization`
- `TE`
- `Trailers`
- `Transfer-Encoding`
- `Upgrade`

Additionally, the proxy **MUST** strip:

- `Host` (replaced with the upstream host)
- `Authorization` (replaced by `Upstream-Authorization` if provided)
- `Upstream-URL`, `Upstream-Method`, `Upstream-Authorization`, `Stream-Signed-URL-TTL` (proxy-specific headers, not forwarded)

## 7. Upstream URL Allowlist

To prevent SSRF (Server-Side Request Forgery) attacks, the proxy **MUST** validate upstream URLs against a configured allowlist before forwarding any requests. If no allowlist is configured or the allowlist is empty, all upstream URLs **MUST** be rejected.

The format and syntax of allowlist entries (e.g., glob patterns, regular expressions, exact matches) is implementation-defined. Implementations **MUST** document their allowlist syntax.

### 7.1. Redirect Blocking

Even when an allowed URL returns a redirect to another allowed URL, the proxy **MUST NOT** follow the redirect. Redirects are always rejected with `400 Bad Request` and error code `REDIRECT_NOT_ALLOWED`. This provides defense-in-depth against SSRF chains.

## 8. Pre-signed URLs

Pre-signed URLs are capability URLs that grant access to a specific stream without requiring separate authentication credentials. They follow the same pattern as S3 pre-signed URLs — possession of the URL is sufficient for access.

### 8.1. URL Format

```
{proxy-url}/{stream-id}?expires={timestamp}&signature={sig}
```

- **`expires`**: Unix timestamp in seconds when the URL expires.
- **`signature`**: A cryptographic signature verifying the stream ID and expiration. The encoding and algorithm are implementation-defined (see Section 8.2).

### 8.2. Signature Generation and Verification

The signing scheme is implementation-defined. Servers generate and verify pre-signed URLs using their own signing mechanism — clients never construct signatures themselves.

Implementations **MUST**:

- Use a cryptographically secure signing algorithm (e.g., HMAC-SHA256 or stronger)
- Use timing-safe comparison when verifying signatures to prevent timing attacks
- Reject expired URLs with `401 Unauthorized` and error code `SIGNATURE_EXPIRED` (except on write paths, see Section 8.5)
- Reject invalid signatures with `401 Unauthorized` and error code `SIGNATURE_INVALID`

### 8.3. Scope

A pre-signed URL grants:

- **Read access** (GET) to the specified stream
- **Abort access** (PATCH with `action=abort`) to the specified stream

A pre-signed URL does **NOT** grant:

- **Write access** (POST) — requires service authentication
- **Metadata access** (HEAD) — requires service authentication
- **Delete access** (DELETE) — requires service authentication
- **Access to other streams** — the signature is bound to a specific stream ID

### 8.4. Expiration and TTL

Implementations **SHOULD** set a default expiration period. The expiration period **SHOULD** be configurable server-side.

#### `Stream-Signed-URL-TTL` Header

Clients **MAY** request a specific TTL for generated pre-signed URLs by including the `Stream-Signed-URL-TTL` header on create, create-or-append, or connect requests:

```
Stream-Signed-URL-TTL: {seconds}
```

- The value is the desired TTL in seconds.
- If provided, the server uses this value as the expiry duration for the generated pre-signed URL. The TTL clock starts at response time.
- If omitted, the server uses its configured default.
- Servers **MAY** enforce a maximum TTL. If the requested TTL exceeds the server's maximum, the server **SHOULD** clamp to the maximum rather than rejecting the request.

The server **MUST** return a fresh pre-signed URL in the `Location` header on every successful create (`201`), create-or-append (`201`/`200`), and connect response. This ensures that active streams automatically have their read tokens refreshed on every successful operation.

### 8.5. Write and Connect Paths

Write operations (`POST {proxy-url}` and `POST {proxy-url}/{stream-id}`) use service authentication (see Section 10), not pre-signed URLs. Read and abort operations use pre-signed URLs as the standard authentication mechanism, with service auth as an optional fallback for reads (see Section 10.2).

| Path                            | Authentication                                   |
| ------------------------------- | ------------------------------------------------ |
| POST (create, create-or-append) | Service auth                                     |
| POST with `?action=connect`     | Service auth                                     |
| GET (read)                      | Pre-signed URL (service auth fallback, see 10.2) |
| PATCH (abort)                   | Pre-signed URL (service auth fallback, see 10.2) |

When a pre-signed read URL expires, a caller with valid service authentication can obtain a fresh URL via the connect operation: `POST {proxy-url}/{stream-id}?action=connect` (Section 4.4).

## 9. Upstream Fetch Lifecycle

### 9.1. Timeouts

The proxy defines two timeout boundaries for upstream communication:

| Timeout           | Recommended Default | Description                                                                                                                                                        |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Header resolution | 60 seconds          | Maximum time to receive response headers from upstream after initiating the request. If exceeded, return `504 Gateway Timeout` with error code `UPSTREAM_TIMEOUT`. |
| Body inactivity   | 10 minutes          | Maximum time between consecutive chunks from upstream during response piping. If exceeded, the proxy **SHOULD** write an Error frame and stop piping.              |

Implementations **MAY** make these timeouts configurable.

### 9.2. Response Piping and Framing

After the proxy receives a 2xx response from upstream and returns `201 Created` (or `200 OK` for append) to the client, it pipes the upstream response body into the durable stream in the background using the framing format (Section 5):

1. **Start frame**: Write a Start frame (`S`) containing the upstream response status and headers as JSON.

2. **Data frames**: As response body chunks arrive from upstream, batch and write them as Data frames (`D`). Implementations **SHOULD** batch small chunks before writing to reduce write overhead — for example, flushing on either a size threshold (e.g., 4KB accumulated) or a time threshold (e.g., 50ms elapsed), whichever comes first.

3. **Terminal frame**: When piping ends, write exactly one terminal frame:
   - **Complete** (`C`): The upstream response body was fully consumed.
   - **Abort** (`A`): The stream was aborted (see Section 9.3).
   - **Error** (`E`): An error occurred during piping (network error, storage error, inactivity timeout).

The proxy protocol does not manage stream closure — each response has its own terminal frame, so readers always know when a response is complete. Closing the underlying durable stream (via `Stream-Closed: true` in the base protocol) is an application-level concern. Clients or operators can close a stream using the base Durable Streams Protocol when it is no longer needed.

### 9.3. Abort Behavior

When an abort is received:

1. If a specific response ID was requested, the upstream connection for that response is cancelled. Otherwise, all active upstream connections for the stream are cancelled.
2. For each aborted response, any buffered data is flushed as a Data frame, followed by an Abort frame (`A`).
3. Data received before the abort is preserved and readable.
4. Non-targeted responses continue piping unaffected.

## 10. Authentication

Authentication and authorization mechanisms are implementation-defined. The proxy protocol distinguishes between two authentication contexts but does not mandate specific mechanisms:

### 10.1. Service Authentication

Service authentication authorizes callers to create and manage proxy streams. It is required for all write and management operations:

- **POST** (create, create-or-append, connect)
- **HEAD** (stream metadata)
- **DELETE** (delete stream)

Implementations **MAY** use any authentication mechanism, including but not limited to:

- Shared secrets (via query parameter or `Authorization` header)
- JWT tokens with claims
- API keys
- OAuth 2.0 tokens
- mTLS client certificates

The protocol does not prescribe how service authentication is conveyed or validated. Implementations **MUST** document their authentication requirements.

### 10.2. Stream Authentication

Stream authentication authorizes callers to read from and abort specific streams. The protocol defines pre-signed URLs (Section 8) as the standard mechanism for stream authentication.

For **GET** (read stream), servers **SHOULD** accept both pre-signed URLs and service authentication as fallback. This allows both direct client access (via pre-signed URL) and server-side access (via service credentials).

For **PATCH** (abort), servers **SHOULD** accept both pre-signed URLs and service authentication. This allows both direct client access (via pre-signed URL) and server-side access (via service credentials).

## 11. CORS

Proxy servers intended for browser clients **SHOULD** handle CORS (Cross-Origin Resource Sharing):

### 11.1. Preflight (OPTIONS)

Servers **MUST** respond to `OPTIONS` requests with appropriate CORS headers and `204 No Content`.

### 11.2. Response Headers

Servers **MUST** expose the following headers via `Access-Control-Expose-Headers` (or equivalent) so that browser clients can read them:

- `Location`, `Upstream-Content-Type`, `Upstream-Status`, and `Stream-Response-Id` (proxy-specific)
- All `Stream-*` headers from the base protocol that the server returns

Servers **MUST** allow the proxy-specific request headers (`Upstream-URL`, `Upstream-Authorization`, `Upstream-Method`, `Stream-Signed-URL-TTL`) via `Access-Control-Allow-Headers`.

The specific CORS policy (allowed origins, max age, etc.) is implementation-defined.

## 12. Error Codes

The proxy protocol defines the following error codes. Servers **SHOULD** return errors as JSON objects with a nested `error` object containing `code` and `message` fields:

```json
{ "error": { "code": "ERROR_CODE", "message": "Human-readable description" } }
```

### 12.1. Request Validation Errors

| HTTP Status | Error Code                | Description                                                   |
| ----------- | ------------------------- | ------------------------------------------------------------- |
| 400         | `MISSING_UPSTREAM_URL`    | `Upstream-URL` header is required but missing                 |
| 400         | `MISSING_UPSTREAM_METHOD` | `Upstream-Method` header is required but missing              |
| 400         | `INVALID_UPSTREAM_METHOD` | `Upstream-Method` is not one of GET, POST, PUT, PATCH, DELETE |
| 400         | `REDIRECT_NOT_ALLOWED`    | Upstream returned a 3xx redirect                              |
| 400         | `INVALID_ACTION`          | Unknown `action` query parameter value                        |

### 12.2. Authentication Errors

| HTTP Status | Error Code          | Description                                                                |
| ----------- | ------------------- | -------------------------------------------------------------------------- |
| 401         | `MISSING_SECRET`    | No service authentication provided                                         |
| 401         | `INVALID_SECRET`    | Service authentication credentials are invalid                             |
| 401         | `SIGNATURE_EXPIRED` | Pre-signed URL has expired (client can reconnect via connect, Section 4.4) |
| 401         | `SIGNATURE_INVALID` | Pre-signed URL signature verification failed                               |
| 401         | `MISSING_SIGNATURE` | Pre-signed URL parameters required but missing                             |
| 401         | `CONNECT_REJECTED`  | Auth endpoint returned non-2xx (client not authorized for stream)          |

### 12.3. Authorization Errors

| HTTP Status | Error Code             | Description                                       |
| ----------- | ---------------------- | ------------------------------------------------- |
| 403         | `UPSTREAM_NOT_ALLOWED` | Upstream URL does not match any allowlist pattern |

### 12.4. Upstream and Storage Errors

| HTTP Status | Error Code         | Description                                                                  |
| ----------- | ------------------ | ---------------------------------------------------------------------------- |
| 502         | `UPSTREAM_ERROR`   | Upstream returned a non-2xx, non-3xx response (see `Upstream-Status` header) |
| 502         | `STORAGE_ERROR`    | Failed to create or write to the durable stream backend                      |
| 504         | `UPSTREAM_TIMEOUT` | Upstream did not respond within the header resolution timeout                |

### 12.5. Stream State Errors

| HTTP Status | Error Code      | Description                                                               |
| ----------- | --------------- | ------------------------------------------------------------------------- |
| 409         | `STREAM_CLOSED` | Stream has been closed (via the base protocol) and cannot accept new data |

### 12.6. Standard Errors

| HTTP Status | Error Code         | Description                         |
| ----------- | ------------------ | ----------------------------------- |
| 404         | `NOT_FOUND`        | Route does not exist                |
| 404         | `STREAM_NOT_FOUND` | The specified stream does not exist |

## 13. Security Considerations

### 13.1. SSRF Prevention

Server-Side Request Forgery is the primary security concern for any HTTP proxy. The proxy protocol mitigates SSRF through defense-in-depth:

1. **Allowlist validation** (Section 7): All upstream URLs **MUST** be validated against a configured allowlist before any request is made.
2. **Redirect blocking** (Section 7.1): 3xx responses are always rejected to prevent allowlist bypass via redirect chains.
3. **Header filtering** (Section 6.2): Hop-by-hop and proxy-managed headers are stripped to prevent header injection attacks.

Implementations **SHOULD** additionally consider:

- Blocking requests to private/internal IP ranges (RFC 1918, link-local, loopback) unless explicitly allowed
- DNS rebinding protections
- Limiting the number of concurrent upstream connections per client

### 13.2. Pre-signed URL Security

Pre-signed URLs are bearer tokens — anyone possessing the URL has access. Implementations **MUST**:

- Use HMAC-SHA256 (or stronger) for signature generation
- Use timing-safe comparison for signature verification
- Set reasonable expiration times
- Use sufficient entropy in the signing secret

Implementations **SHOULD**:

- Transmit pre-signed URLs only over TLS
- Avoid logging pre-signed URLs in plain text
- Consider binding URLs to additional context (IP address, user agent) for high-security scenarios

### 13.3. Write-Path Authentication

Write operations (create, create-or-append) require service authentication (Section 10). Pre-signed URLs are not used for writes. An attacker would need valid service credentials to initiate upstream requests, and the upstream service must also accept the forwarded request. Stream IDs specified by clients are not secrets — access control is enforced by service authentication, not by stream ID obscurity.

### 13.4. Auth Endpoint Security

The auth endpoint used in connect operations is the developer's opportunity to enforce access control decisions (e.g., revoke access to a conversation). Implementers **SHOULD NOT** return `200` unconditionally from their auth endpoint. An auth endpoint that always approves effectively grants permanent access to the stream, regardless of the signed URL's expiration.

Simple deployments that do not need fine-grained access revocation can omit the `Upstream-URL` on connect (trusting service authentication alone) and use long TTLs.

### 13.5. Upstream Error Body Exposure

The proxy passes upstream error bodies through to the client. Implementations **SHOULD** truncate error bodies to a reasonable maximum size to prevent memory exhaustion from large error responses.

### 13.6. TLS

All protocol operations **MUST** be performed over HTTPS (TLS) in production environments, per Section 10.8 of the base protocol. This is especially important for the proxy protocol because:

- Pre-signed URLs in `Location` headers are bearer tokens
- `Upstream-Authorization` headers contain upstream credentials
- Upstream response bodies may contain sensitive data

### 13.7. Client-Specified Stream IDs

Stream IDs may be specified by clients and are visible in URL paths. Security does not rely on stream ID unguessability — access control is enforced by service authentication for writes and HMAC-signed URLs for reads. Clients **SHOULD** use non-guessable stream IDs (e.g., UUIDs) to prevent enumeration, but this is a defense-in-depth measure, not the primary access control.

## 14. References

### 14.1. Normative References

[RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, DOI 10.17487/RFC2119, March 1997, <https://www.rfc-editor.org/info/rfc2119>.

[RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, DOI 10.17487/RFC8174, May 2017, <https://www.rfc-editor.org/info/rfc8174>.

[RFC9110] Fielding, R., Ed., Nottingham, M., Ed., and J. Reschke, Ed., "HTTP Semantics", STD 97, RFC 9110, DOI 10.17487/RFC9110, June 2022, <https://www.rfc-editor.org/info/rfc9110>.

[BASE-PROTOCOL] ElectricSQL, "The Durable Streams Protocol", 2025, <../../PROTOCOL.md>.

### 14.2. Informative References

[RFC1918] Rekhter, Y., Moskowitz, B., Karelitz, D., Groot, G., and E. Lear, "Address Allocation for Private Internets", BCP 5, RFC 1918, DOI 10.17487/RFC1918, February 1996, <https://www.rfc-editor.org/info/rfc1918>.

---

**Full Copyright Statement**

Copyright (c) 2026 ElectricSQL

This document and the information contained herein are provided on an "AS IS" basis. ElectricSQL disclaims all warranties, express or implied, including but not limited to any warranty that the use of the information herein will not infringe any rights or any implied warranties of merchantability or fitness for a particular purpose.
