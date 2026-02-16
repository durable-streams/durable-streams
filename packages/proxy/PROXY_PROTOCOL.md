# DRAFT: The Durable Streams Proxy Protocol

**Document:** Durable Streams Proxy Protocol Extension  
**Version:** 0.1  
**Date:** 2026-02-XX  
**Author:** ElectricSQL  
**Base Protocol:** [The Durable Streams Protocol](../../PROTOCOL.md)

---

## Abstract

This document specifies the Durable Streams Proxy Protocol, an extension to the [Durable Streams Protocol](../../PROTOCOL.md) that adds a `proxy` operation for forwarding HTTP requests to upstream servers while persisting their streaming responses to durable streams. This enables clients to make any HTTP streaming response resumable — if a connection drops mid-stream, the client reconnects to the durable stream and continues reading from where it left off, without data loss or repeating the upstream request.

The proxy protocol is designed for the common case of "make this HTTP request resumable" and is particularly suited to AI token streaming, SSE feeds, and any long-running HTTP response where reliability matters.

## Copyright Notice

Copyright (c) 2026 ElectricSQL

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Protocol Overview](#3-protocol-overview)
4. [HTTP Operations](#4-http-operations)
   - 4.1. [Create Proxy Stream](#41-create-proxy-stream)
   - 4.2. [Read Proxy Stream](#42-read-proxy-stream)
   - 4.3. [Abort Upstream](#43-abort-upstream)
   - 4.4. [Stream Metadata](#44-stream-metadata)
   - 4.5. [Delete Proxy Stream](#45-delete-proxy-stream)
5. [Header Handling](#5-header-handling)
   - 5.1. [Upstream Request Headers](#51-upstream-request-headers)
   - 5.2. [Hop-by-Hop Header Filtering](#52-hop-by-hop-header-filtering)
6. [Upstream URL Allowlist](#6-upstream-url-allowlist)
   - 6.1. [Redirect Blocking](#61-redirect-blocking)
7. [Pre-signed URLs](#7-pre-signed-urls)
8. [Upstream Fetch Lifecycle](#8-upstream-fetch-lifecycle)
   - 8.1. [Timeouts](#81-timeouts)
   - 8.2. [Response Piping](#82-response-piping)
   - 8.3. [Abort Behavior](#83-abort-behavior)
9. [Authentication](#9-authentication)
10. [CORS](#10-cors)
11. [Error Codes](#11-error-codes)
12. [Security Considerations](#12-security-considerations)
13. [References](#13-references)

---

## 1. Introduction

The [Durable Streams Protocol](../../PROTOCOL.md) provides a minimal HTTP-based interface for durable, append-only byte streams with offset-based resumption. The base protocol requires clients to create a stream, make the upstream request, and pipe the response into the stream themselves. While flexible, this is unnecessary complexity for the most common use case: making an existing HTTP streaming response resumable.

The Proxy Protocol extension solves this by introducing a server-side proxy that:

1. Accepts an HTTP request destined for an upstream service
2. Forwards the request to the upstream service
3. Creates a durable stream and pipes the upstream response into it in the background
4. Returns a capability URL (pre-signed URL) that grants the client read and abort access to the stream

From the client's perspective, the flow becomes: send one request, receive a URL, read from that URL with automatic resumability.

```
┌──────────┐        ┌──────────────────┐        ┌──────────────┐
│  Client  │──POST─►│  Proxy Server    │──req──►│  Upstream    │
│          │◄─201───│                  │◄─res───│  (OpenAI,    │
│          │        │  Pipes response  │        │  Anthropic)  │
│          │──GET──►│  to durable      │        │              │
│          │◄─data──│  stream          │        └──────────────┘
│          │        │                  │
│  (resume │──GET──►│  ┌────────────┐  │
│  on      │◄─data──│  │  Durable   │  │
│  reconn) │        │  │  Streams   │  │
│          │        │  │  Backend   │  │
└──────────┘        │  └────────────┘  │
                    └──────────────────┘
```

### 1.1. Relationship to the Base Protocol

The proxy protocol is a pure superset of the base Durable Streams Protocol (see Section 9 of the base protocol). Proxy streams are regular durable streams — the read path uses the same `Stream-*` headers, offset semantics, and live modes (long-poll, SSE) defined in the base protocol. The proxy protocol adds:

- A creation mechanism that combines upstream fetching with stream creation
- Pre-signed capability URLs for per-stream authentication
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

**Service Authentication**: Authentication that identifies a trusted caller authorized to create and manage proxy streams. The mechanism is implementation-defined (see Section 9).

## 3. Protocol Overview

The proxy protocol defines five operations on two URL patterns:

| Method | Path                      | Description               |
| ------ | ------------------------- | ------------------------- |
| POST   | `{proxy-url}`             | Create a proxy stream     |
| GET    | `{proxy-url}/{stream-id}` | Read from a proxy stream  |
| HEAD   | `{proxy-url}/{stream-id}` | Get stream metadata       |
| PATCH  | `{proxy-url}/{stream-id}` | Abort upstream connection |
| DELETE | `{proxy-url}/{stream-id}` | Delete a proxy stream     |

The protocol does not prescribe a specific URL structure. The examples in this document use `/v1/proxy` as the base URL, but implementations **MAY** use any URL scheme they choose. The protocol is defined by the HTTP methods, query parameters, and headers applied to the proxy URLs.

**Stream IDs** are server-generated. Clients do not choose stream IDs; they are assigned by the proxy server on stream creation. Implementations **SHOULD** use UUIDs or another scheme that produces unique, URL-safe identifiers.

**Two-phase flow:**

1. **Create** (POST): Client sends the upstream request details to the proxy. The proxy fetches from upstream. On success, it returns `201 Created` with a `Location` header containing a pre-signed URL.
2. **Read** (GET): Client reads from the pre-signed URL, which delegates to the underlying durable stream. Supports offset-based resumption and live modes from the base protocol.

## 4. HTTP Operations

### 4.1. Create Proxy Stream

#### Request

```
POST {proxy-url}
```

Creates a new proxy stream by forwarding a request to an upstream service and persisting the response to a durable stream.

#### Request Headers

- `Upstream-URL` (required)
  - The full URL of the upstream service to forward the request to.
  - **MUST** be a valid absolute HTTP or HTTPS URL.
  - **MUST** match at least one pattern in the server's allowlist (see Section 6).

- `Upstream-Method` (required)
  - The HTTP method to use for the upstream request.
  - **MUST** be one of: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.

- `Upstream-Authorization` (optional)
  - Authorization credentials for the upstream service.
  - Sent as the `Authorization` header on the upstream request.
  - The client's `Authorization` header is used for proxy authentication and is **NOT** forwarded to upstream.

- `Content-Type` (optional)
  - Content type of the request body, forwarded to upstream.

- Other headers
  - All other headers are forwarded to upstream, subject to hop-by-hop filtering (see Section 5.2).

#### Request Body (Optional)

The request body is forwarded to the upstream service as-is. For example, when proxying to an AI chat completion API, the body would contain the JSON request payload.

#### Response — Success (upstream 2xx)

```http
HTTP/1.1 201 Created
Location: {proxy-url}/{stream-id}?expires={timestamp}&signature={sig}
Upstream-Content-Type: {content-type}
```

- **`201 Created`**: The proxy successfully received a 2xx response from upstream, created a durable stream, and began piping the upstream response body in the background.
- **`Location`**: A pre-signed capability URL for reading from and aborting the stream (see Section 7).
- **`Upstream-Content-Type`**: The `Content-Type` of the upstream response. Clients use this to interpret the stream data (e.g., `text/event-stream` for SSE).
- **No response body**: The response has no body. The upstream response body is piped to the durable stream in the background.

The proxy **MUST** return the `201` response before the upstream response body is fully consumed. The piping runs asynchronously — the client begins reading the stream via GET while the proxy continues writing to it.

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
- **`Content-Type`**: The content type of the upstream error response.
- **Body**: The upstream error response body. Implementations **SHOULD** truncate large error bodies to prevent memory exhaustion.

No stream is created. The upstream error body is passed through to help clients diagnose the issue.

#### Response — Upstream Redirect (3xx)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error": "REDIRECT_NOT_ALLOWED", "message": "Proxy cannot follow redirects"}
```

The proxy **MUST NOT** follow HTTP redirects from upstream. Redirects could be used to bypass the allowlist (e.g., an allowed URL redirects to an internal service). Servers **MUST** ensure redirects are not followed automatically when making the upstream request and **MUST** return `400 Bad Request` with error code `REDIRECT_NOT_ALLOWED` when a 3xx response is received.

#### Response — Other Errors

See Section 11 for the full error code table.

### 4.2. Read Proxy Stream

#### Request

```
GET {proxy-url}/{stream-id}?expires={ts}&signature={sig}[&offset={offset}][&live={mode}]
```

Reads data from an existing proxy stream. This operation delegates to the underlying durable stream, supporting the same offset-based reads and live modes defined in the base Durable Streams Protocol.

#### Authentication

Authenticates via pre-signed URL parameters (`expires` and `signature`) or via service authentication as a fallback. See Sections 7 and 9.

#### Query Parameters

- `expires`, `signature` — Pre-signed URL authentication (see Section 7)
- `offset` — Start offset (see base protocol Section 5.6)
- `live` — Live mode: `long-poll` or `sse` (see base protocol Sections 5.7, 5.8)
- `cursor` — Cursor for CDN collapsing (see base protocol Section 8.1)

#### Response Headers

All standard `Stream-*` response headers from the base protocol, plus:

- **`Upstream-Content-Type`**: The original content type of the upstream response. Servers **MUST** include this header on all successful read responses if the upstream content type is known.

#### Response Codes

- `200 OK`: Data available
- `204 No Content`: Long-poll timeout with no new data
- `401 Unauthorized`: Missing or invalid authentication
- `404 Not Found`: Stream does not exist

For full response semantics (offsets, live modes, stream closure), see the base Durable Streams Protocol Sections 5.6–5.8.

### 4.3. Abort Upstream

#### Request

```
PATCH {proxy-url}/{stream-id}?expires={ts}&signature={sig}&action=abort
```

Aborts the upstream connection for an in-progress stream. This is useful for cancelling expensive operations (e.g., stopping AI text generation mid-response).

#### Authentication

Pre-signed URL only. Servers **MUST NOT** fall back to service authentication for abort requests. This ensures that only the holder of the pre-signed URL (typically the client that initiated the request) can abort the upstream connection.

#### Query Parameters

- `action=abort` (required) — Specifies the abort action.
- `expires`, `signature` — Pre-signed URL authentication (see Section 7).

#### Behavior

- Cancels the upstream connection.
- Flushes any buffered data that has been received but not yet written to the stream.
- Data written up to the abort point remains readable.
- **Idempotent**: Aborting an already-aborted or completed stream succeeds silently.

> **Note:** The behavior of the stream's closure state after an abort (whether the stream is marked closed or left open) is not specified in this version of the protocol and will be defined in a future revision.

#### Response

```http
HTTP/1.1 204 No Content
```

### 4.4. Stream Metadata

#### Request

```
HEAD {proxy-url}/{stream-id}
```

Returns stream metadata headers without a body. Delegates to the underlying durable stream's HEAD operation.

#### Authentication

Service authentication only (see Section 9). Pre-signed URLs are not accepted for HEAD requests.

#### Response Headers

Same as the base protocol Section 5.5, plus:

- **`Upstream-Content-Type`**: The original upstream content type, if known.

#### Response Codes

- `200 OK`: Stream exists
- `401 Unauthorized`: Missing or invalid service authentication
- `404 Not Found`: Stream does not exist

### 4.5. Delete Proxy Stream

#### Request

```
DELETE {proxy-url}/{stream-id}
```

Deletes the stream and aborts any in-flight upstream connection.

#### Authentication

Service authentication only (see Section 9). Pre-signed URLs are not accepted for DELETE requests.

#### Behavior

- If an upstream connection is active for this stream, it is aborted.
- The underlying durable stream is deleted, removing all persisted data.
- **Idempotent**: Deleting a non-existent stream returns `204 No Content`.

#### Response

```http
HTTP/1.1 204 No Content
```

## 5. Header Handling

### 5.1. Upstream Request Headers

When forwarding the client's request to upstream, the proxy applies the following transformations:

| Client Header            | Upstream Behavior                                            |
| ------------------------ | ------------------------------------------------------------ |
| `Authorization`          | **NOT forwarded.** Used for proxy authentication.            |
| `Upstream-Authorization` | Sent as `Authorization` to upstream.                         |
| `Upstream-URL`           | Used as the upstream request URL. Not forwarded as a header. |
| `Upstream-Method`        | Used as the upstream HTTP method. Not forwarded as a header. |
| `Host`                   | Set to the upstream host. Client's `Host` is not forwarded.  |
| Hop-by-hop headers       | Stripped (see Section 5.2).                                  |
| All other headers        | Forwarded as-is to upstream.                                 |

### 5.2. Hop-by-Hop Header Filtering

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
- `Upstream-URL`, `Upstream-Method`, `Upstream-Authorization` (proxy-specific headers, not forwarded)

## 6. Upstream URL Allowlist

To prevent SSRF (Server-Side Request Forgery) attacks, the proxy **MUST** validate upstream URLs against a configured allowlist before forwarding any requests. If no allowlist is configured or the allowlist is empty, all upstream URLs **MUST** be rejected.

The format and syntax of allowlist entries (e.g., glob patterns, regular expressions, exact matches) is implementation-defined. Implementations **MUST** document their allowlist syntax.

### 6.1. Redirect Blocking

Even when an allowed URL returns a redirect to another allowed URL, the proxy **MUST NOT** follow the redirect. Redirects are always rejected with `400 Bad Request` and error code `REDIRECT_NOT_ALLOWED`. This provides defense-in-depth against SSRF chains.

## 7. Pre-signed URLs

Pre-signed URLs are capability URLs that grant access to a specific stream without requiring separate authentication credentials. They follow the same pattern as S3 pre-signed URLs — possession of the URL is sufficient for access.

### 7.1. URL Format

```
{proxy-url}/{stream-id}?expires={timestamp}&signature={hmac}
```

- **`expires`**: Unix timestamp in seconds when the URL expires.
- **`signature`**: A cryptographic signature verifying the stream ID and expiration. The encoding and algorithm are implementation-defined (see Section 7.2).

### 7.2. Signature Generation and Verification

The signing scheme is implementation-defined. Servers generate and verify pre-signed URLs using their own signing mechanism — clients never construct signatures themselves.

Implementations **MUST**:

- Use a cryptographically secure signing algorithm (e.g., HMAC-SHA256 or stronger)
- Use timing-safe comparison when verifying signatures to prevent timing attacks
- Reject expired URLs with `401 Unauthorized` and error code `SIGNATURE_EXPIRED`
- Reject invalid signatures with `401 Unauthorized` and error code `SIGNATURE_INVALID`

### 7.3. Scope

A pre-signed URL grants:

- **Read access** (GET) to the specified stream
- **Abort access** (PATCH with `action=abort`) to the specified stream

A pre-signed URL does **NOT** grant:

- **Metadata access** (HEAD) — requires service authentication
- **Delete access** (DELETE) — requires service authentication
- **Access to other streams** — the signature is bound to a specific stream ID

### 7.4. Expiration

Implementations **SHOULD** set a default expiration of 24 hours, matching the default stream TTL. The expiration period **SHOULD** be configurable.

## 8. Upstream Fetch Lifecycle

### 8.1. Timeouts

The proxy defines two timeout boundaries for upstream communication:

| Timeout           | Recommended Default | Description                                                                                                                                                        |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Header resolution | 60 seconds          | Maximum time to receive response headers from upstream after initiating the request. If exceeded, return `504 Gateway Timeout` with error code `UPSTREAM_TIMEOUT`. |
| Body inactivity   | 10 minutes          | Maximum time between consecutive chunks from upstream during response piping. If exceeded, the proxy **SHOULD** cancel the reader and flush any buffered data.     |

Implementations **MAY** make these timeouts configurable.

### 8.2. Response Piping

After the proxy receives a 2xx response from upstream and returns `201 Created` to the client, it pipes the upstream response body into the durable stream in the background:

1. **Chunk batching**: Implementations **SHOULD** batch small chunks before writing to the durable stream to reduce write overhead. For example, flushing on either a size threshold (e.g., 4KB accumulated) or a time threshold (e.g., 50ms elapsed), whichever comes first.

2. **Normal completion**: When the upstream response body is fully consumed, the proxy **MUST** flush any remaining buffered data and close the stream by sending `Stream-Closed: true` on the final write. This signals EOF to readers.

3. **Error during piping**: If an error occurs while piping (network error, storage error), the proxy **SHOULD** flush any buffered data. The handling of the stream's closure state after a piping error is not specified in this version of the protocol.

4. **Abort during piping**: If the stream is aborted (via PATCH), the proxy **MUST** flush any buffered data. See Section 8.3.

### 8.3. Abort Behavior

When an abort is received:

1. The upstream connection is cancelled.
2. Any data buffered but not yet written to the stream is flushed.
3. Data received before the abort is preserved and readable.

> **Note:** The handling of the stream's closure state after an abort or piping error (whether the stream is marked closed or left open) is not specified in this version of the protocol and will be defined in a future revision.

## 9. Authentication

Authentication and authorization mechanisms are implementation-defined. The proxy protocol distinguishes between two authentication contexts but does not mandate specific mechanisms:

### 9.1. Service Authentication

Service authentication authorizes callers to create and manage proxy streams. It is required for:

- **POST** (create stream)
- **HEAD** (stream metadata)
- **DELETE** (delete stream)

Implementations **MAY** use any authentication mechanism, including but not limited to:

- Shared secrets (via query parameter or `Authorization` header)
- JWT tokens with claims
- API keys
- OAuth 2.0 tokens
- mTLS client certificates

The protocol does not prescribe how service authentication is conveyed or validated. Implementations **MUST** document their authentication requirements.

### 9.2. Stream Authentication

Stream authentication authorizes callers to read from and abort specific streams. The protocol defines pre-signed URLs (Section 7) as the standard mechanism for stream authentication.

For **GET** (read stream), servers **SHOULD** accept both pre-signed URLs and service authentication as fallback. This allows both direct client access (via pre-signed URL) and server-side access (via service credentials).

For **PATCH** (abort), servers **MUST** require pre-signed URL authentication only, with no service authentication fallback. This scopes abort capability to the holder of the pre-signed URL.

## 10. CORS

Proxy servers intended for browser clients **SHOULD** handle CORS (Cross-Origin Resource Sharing):

### 10.1. Preflight (OPTIONS)

Servers **MUST** respond to `OPTIONS` requests with appropriate CORS headers and `204 No Content`.

### 10.2. Response Headers

Servers **MUST** expose the following headers via `Access-Control-Expose-Headers` (or equivalent) so that browser clients can read them:

- `Location` and `Upstream-Content-Type` (proxy-specific)
- `Upstream-Status` (on upstream errors)
- All `Stream-*` headers from the base protocol that the server returns

Servers **MUST** allow the proxy-specific request headers (`Upstream-URL`, `Upstream-Authorization`, `Upstream-Method`) via `Access-Control-Allow-Headers`.

The specific CORS policy (allowed origins, max age, etc.) is implementation-defined.

## 11. Error Codes

The proxy protocol defines the following error codes. Servers **SHOULD** return errors as JSON objects with `error` and `message` fields:

```json
{ "error": "ERROR_CODE", "message": "Human-readable description" }
```

### 11.1. Request Validation Errors

| HTTP Status | Error Code                | Description                                                   |
| ----------- | ------------------------- | ------------------------------------------------------------- |
| 400         | `MISSING_UPSTREAM_URL`    | `Upstream-URL` header is required but missing                 |
| 400         | `MISSING_UPSTREAM_METHOD` | `Upstream-Method` header is required but missing              |
| 400         | `INVALID_UPSTREAM_METHOD` | `Upstream-Method` is not one of GET, POST, PUT, PATCH, DELETE |
| 400         | `REDIRECT_NOT_ALLOWED`    | Upstream returned a 3xx redirect                              |
| 400         | `INVALID_ACTION`          | Unknown action in PATCH request (only `abort` is supported)   |

### 11.2. Authentication Errors

| HTTP Status | Error Code          | Description                                    |
| ----------- | ------------------- | ---------------------------------------------- |
| 401         | `UNAUTHORIZED`      | Missing or invalid service authentication      |
| 401         | `SIGNATURE_EXPIRED` | Pre-signed URL has expired                     |
| 401         | `SIGNATURE_INVALID` | Pre-signed URL signature verification failed   |
| 401         | `MISSING_SIGNATURE` | Pre-signed URL parameters required but missing |

### 11.3. Authorization Errors

| HTTP Status | Error Code             | Description                                       |
| ----------- | ---------------------- | ------------------------------------------------- |
| 403         | `UPSTREAM_NOT_ALLOWED` | Upstream URL does not match any allowlist pattern |

### 11.4. Upstream Errors

| HTTP Status | Error Code         | Description                                                                  |
| ----------- | ------------------ | ---------------------------------------------------------------------------- |
| 502         | `UPSTREAM_ERROR`   | Upstream returned a non-2xx, non-3xx response (see `Upstream-Status` header) |
| 504         | `UPSTREAM_TIMEOUT` | Upstream did not respond within the header resolution timeout                |

### 11.5. Standard Errors

| HTTP Status | Error Code  | Description                    |
| ----------- | ----------- | ------------------------------ |
| 404         | `NOT_FOUND` | Stream or route does not exist |

## 12. Security Considerations

### 12.1. SSRF Prevention

Server-Side Request Forgery is the primary security concern for any HTTP proxy. The proxy protocol mitigates SSRF through defense-in-depth:

1. **Allowlist validation** (Section 6): All upstream URLs **MUST** be validated against a configured allowlist before any request is made.
2. **Redirect blocking** (Section 6.1): 3xx responses are always rejected to prevent allowlist bypass via redirect chains.
3. **Header filtering** (Section 5.2): Hop-by-hop and proxy-managed headers are stripped to prevent header injection attacks.

Implementations **SHOULD** additionally consider:

- Blocking requests to private/internal IP ranges (RFC 1918, link-local, loopback) unless explicitly allowed
- DNS rebinding protections
- Limiting the number of concurrent upstream connections per client

### 12.2. Pre-signed URL Security

Pre-signed URLs are bearer tokens — anyone possessing the URL has access. Implementations **MUST**:

- Use HMAC-SHA256 (or stronger) for signature generation
- Use timing-safe comparison for signature verification
- Set reasonable expiration times (default: 24 hours)
- Use sufficient entropy in the signing secret

Implementations **SHOULD**:

- Transmit pre-signed URLs only over TLS
- Avoid logging pre-signed URLs in plain text
- Consider binding URLs to additional context (IP address, user agent) for high-security scenarios

### 12.3. Upstream Error Body Exposure

The proxy passes upstream error bodies through to the client. Implementations **SHOULD** truncate error bodies to a reasonable maximum size to prevent memory exhaustion from large error responses.

### 12.4. TLS

All protocol operations **MUST** be performed over HTTPS (TLS) in production environments, per Section 10.8 of the base protocol. This is especially important for the proxy protocol because:

- Pre-signed URLs in `Location` headers are bearer tokens
- `Upstream-Authorization` headers contain upstream credentials
- Upstream response bodies may contain sensitive data

## 13. References

### 13.1. Normative References

[RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, DOI 10.17487/RFC2119, March 1997, <https://www.rfc-editor.org/info/rfc2119>.

[RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, DOI 10.17487/RFC8174, May 2017, <https://www.rfc-editor.org/info/rfc8174>.

[RFC9110] Fielding, R., Ed., Nottingham, M., Ed., and J. Reschke, Ed., "HTTP Semantics", STD 97, RFC 9110, DOI 10.17487/RFC9110, June 2022, <https://www.rfc-editor.org/info/rfc9110>.

[BASE-PROTOCOL] ElectricSQL, "The Durable Streams Protocol", 2025, <../../PROTOCOL.md>.

### 13.2. Informative References

[RFC1918] Rekhter, Y., Moskowitz, B., Karelitz, D., Groot, G., and E. Lear, "Address Allocation for Private Internets", BCP 5, RFC 1918, DOI 10.17487/RFC1918, February 1996, <https://www.rfc-editor.org/info/rfc1918>.

---

**Full Copyright Statement**

Copyright (c) 2026 ElectricSQL

This document and the information contained herein are provided on an "AS IS" basis. ElectricSQL disclaims all warranties, express or implied, including but not limited to any warranty that the use of the information herein will not infringe any rights or any implied warranties of merchantability or fitness for a particular purpose.
