---
title: JSON Schema validation for JSON Mode
version: "1.0"
status: draft
owner: samwillis
contributors: []
created: 2026-03-06
last_updated: 2026-03-06
prd: n/a
prd_version: "n/a"
---

# JSON Schema validation for JSON Mode

## Summary

This RFC adds optional JSON Schema support to Durable Streams JSON mode. An `application/json` stream may be created with no schema, with an inline schema document, or with a schema URL. When a schema is attached, the server validates initial data and all later appends against a pinned effective schema document and exposes that schema through stream metadata and a retrieval endpoint.

## Background

Durable Streams already defines special behavior for `application/json` streams: the server validates JSON syntax, preserves logical message boundaries, and flattens one level of arrays on append. Stream creation currently uses `PUT`, where `Content-Type` identifies the stream content type and the request body, if present, is initial stream data.

## Problem

JSON mode currently validates syntax but not structure. That makes it harder to reject malformed application events early, share a stable contract with frontend consumers, and expose machine-readable schema metadata from the stream itself.

The main constraint is that `PUT` already uses the request body for initial stream data, so any schema-aware creation flow must avoid ambiguity and keep HTTP `Content-Type` semantics truthful.

**Link to PRD hypothesis:** n/a

## Goals & Non-Goals

### Goals

- Allow `application/json` streams to be created with no schema, an inline schema document, or a schema URL.
- Keep `Content-Type` truthful for the request body in all creation modes.
- Validate initial JSON data and subsequent JSON appends against the attached schema.
- Let clients retrieve the effective schema for a stream from the stream server.
- Keep stream creation idempotent by treating schema identity as part of stream configuration.

### Non-Goals

- Updating or replacing a stream schema after creation.
- Supporting multiple schemas on one stream.
- Standardizing schema evolution or compatibility policies.
- Adding schema validation for non-JSON stream payloads in this RFC.
- Defining rich error body formats for validation failures.

## Proposal

This RFC adds an optional schema attachment model for streams whose payload type is `application/json`.

The schema attachment headers and retrieval behavior defined by this RFC are invalid for non-JSON streams.

### Creation Modes

The three creation modes are mutually exclusive. A create request must use exactly one of:

- no schema attachment
- inline schema attachment
- schema URL attachment

Requests that combine inline schema attachment with `Stream-Schema-Url` must fail with `400 Bad Request`.

#### 1. No schema

This remains the current behavior.

```http
PUT /streams/orders
Content-Type: application/json

[{"event":"created"}]
```

- `Content-Type` describes both the request body and the stream payload type.
- The body, if present, is initial stream data.
- No schema metadata is attached.

#### 2. Inline schema document

In this mode, the request body contains a schema document instead of initial stream data:

```http
PUT /streams/orders
Content-Type: application/schema+json
Stream-Content-Type: application/json

{
  "type": "object",
  "required": ["event"],
  "properties": {
    "event": { "type": "string" }
  }
}
```

- `Content-Type` describes the request body.
- `Stream-Content-Type` declares the stream payload type.
- The body is the attached JSON Schema document.
- This request creates the stream with no initial messages.
- Initial data, if needed, is sent in a later `POST`.
- Servers must reject this mode with `400 Bad Request` unless `Stream-Content-Type` is exactly `application/json`.

#### 3. Schema URL with optional initial data

In this mode, the schema is provided by URL:

```http
PUT /streams/orders
Content-Type: application/json
Stream-Schema-Url: https://example.com/schemas/order-event.schema.json

[{"event":"created"}]
```

- `Content-Type` continues to describe the request body and stream payload type.
- The body, if present, is initial stream data.
- `Stream-Schema-Url` identifies the schema to attach.
- The server resolves the schema at create time, stores a pinned effective schema document, and validates the initial body if present.
- Servers must reject this mode with `400 Bad Request` unless `Content-Type` is exactly `application/json`.

### Validation Rules

Schema validation applies only to streams whose payload type is `application/json`.

- A stream without attached schema behaves exactly as current JSON mode.
- A stream with attached schema validates the `PUT` body when that body is initial stream data.
- A stream with attached schema validates every later `POST` append.
- Validation occurs per logical JSON message after the existing one-level array flattening rules.
- If any message in a batch fails validation, the entire request fails and no messages are appended.
- If a schema document omits `$schema`, servers must treat it as JSON Schema 2020-12 and materialize that default in the pinned effective schema document.
- If a schema document declares `$schema`, servers must reject creation when that version is unsupported.
- Servers must validate that the schema document itself is a valid JSON Schema for the supported dialect. Parseable JSON plus a supported `$schema` value is not sufficient if the document fails schema validation.
- External `$ref` resolution is unsupported in v1. Attached schemas must be self-contained after retrieval, and servers must reject schema documents that require external reference resolution.

### Retrieval

The server exposes schema metadata in two ways.

#### `HEAD {stream-url}`

When a schema is attached, the server returns:

- `Link: <absolute-schema-url>; rel="describedby"; type="application/schema+json"`
- `Stream-Schema-Digest: <digest>`
- `Stream-Schema-Url: <url>` when the stream was created from a schema URL

Example:

```http
HEAD /streams/orders

HTTP/1.1 200 OK
Link: <https://streams.example.com/streams/orders?schema>; rel="describedby"; type="application/schema+json"
Stream-Schema-Digest: sha-256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

#### `GET {stream-url}?schema`

Returns the effective schema document for the stream:

- `200 OK`
- `Content-Type: application/schema+json`
- body is the pinned effective schema document used for validation

If the stream exists but has no attached schema, servers must return `404 Not Found`.

This endpoint returns the stored effective schema document even when the stream was created from `Stream-Schema-Url`. Clients do not need direct access to the original external URL.

The effective schema document is the normalized schema used for validation:

- if the original schema omitted `$schema`, the pinned effective schema must include `$schema: "https://json-schema.org/draft/2020-12/schema"`
- formatting differences in the original input do not need to be preserved

Schema retrieval uses the single endpoint shape `GET {stream-url}?schema`.

`schema` is mutually exclusive with stream read parameters. Requests that combine `schema` with `offset`, `live`, or `cursor` must fail with `400 Bad Request`.

### Schema URL Resolution

Schema URL attachment is intentionally constrained in v1.

- `Stream-Schema-Url` must be an absolute `http` or `https` URL.
- Servers resolve the schema URL exactly once at create time.
- Servers must not forward caller credentials such as `Authorization` headers or cookies when resolving schema URLs.
- A successful resolution requires an HTTP `200 OK` response whose body parses as JSON and passes the same schema validation rules as inline schema creation.
- Unsupported URL schemes, non-absolute URLs, resolution failures, non-`200` responses, invalid JSON, invalid schema documents, or blocked fetches must cause the create request to fail with `400 Bad Request`.
- Servers may apply timeout, redirect, response-size, and allowlist restrictions to schema URL resolution. If those restrictions block resolution, the create request fails with `400 Bad Request`.
- Servers should reject resolution to loopback, link-local, private, and other non-public address ranges unless explicitly configured to allow them.
- Failed create operations must not leave partial stream state behind. A create request that fails during schema URL resolution must behave as if no stream was created.

### TypeScript Client Integration

The TypeScript client should expose schema retrieval through both the static and instance APIs.

- `DurableStream.getSchema({ url, headers, params, fetch, signal })` performs authenticated one-off schema retrieval.
- `handle.getSchema()` reuses the existing URL, headers, params, fetch implementation, and signal from the `DurableStream` instance.
- This allows schema retrieval to reuse the same auth headers used for `head()`, `stream()`, and write operations.

Example:

```typescript
const handle = new DurableStream({
  url: "https://streams.example.com/orders",
  headers: {
    Authorization: `Bearer ${token}`,
  },
})

const schema = await handle.getSchema()
```

### Python Client Integration

The Python client should expose the same capabilities through both synchronous and asynchronous handle APIs.

- Python create APIs should prefer semantic keyword arguments over raw protocol details in common cases.
- Recommended create-time keywords are `schema=...` for inline schema documents and `schema_url=...` for URL-based schema attachment.
- `stream_content_type="application/json"` is only needed for inline schema creation, where the request body is the schema document rather than initial stream data.
- `DurableStream.get_schema_static(url, *, headers=None, params=None, client=None, timeout=None)` performs authenticated one-off schema retrieval.
- `AsyncDurableStream.get_schema_static(url, *, headers=None, params=None, client=None, timeout=None)` performs the async equivalent.
- `handle.get_schema()` and `await async_handle.get_schema()` reuse the handle's configured URL, headers, params, client, and timeout.

Example:

```python
handle = DurableStream.create(
    "https://streams.example.com/orders",
    content_type="application/json",
    schema_url="https://example.com/schemas/order.schema.json",
    body={"event": "created"},
    headers={"Authorization": f"Bearer {token}"},
)

inline_handle = DurableStream.create(
    "https://streams.example.com/orders-inline",
    schema=my_schema,
    stream_content_type="application/json",
    headers={"Authorization": f"Bearer {token}"},
)

handle = DurableStream(
    "https://streams.example.com/orders",
    headers={"Authorization": f"Bearer {token}"},
)

schema = handle.get_schema()
```

### Other Client Libraries

Other client libraries should follow the same broad pattern:

- expose schema-aware stream creation without requiring callers to manually construct protocol headers in common cases
- expose authenticated one-off schema retrieval
- expose handle-based schema retrieval that reuses the client's existing auth and request configuration

Exact API shape may vary by language, but the capabilities should remain consistent across clients.

### Idempotency and Configuration Matching

Attached schema identity is part of stream configuration for `PUT` idempotency.

- Repeating a create request with the same payload type and same schema identity returns `200 OK`.
- Creating an existing stream with different schema settings returns `409 Conflict`.
- `Stream-Schema-Digest` is the canonical identity of the pinned effective schema document.
- Schema identity is digest-based. An inline schema create and a schema-URL create are idempotently equivalent when they produce the same pinned effective schema document.
- `Stream-Schema-Url` is informational metadata and does not participate in config matching.
- "No schema attached" and "schema attached" are always different configurations, even if the attached schema is permissive.

`Stream-Schema-Digest` should use the form `sha-256:<lowercase-hex>`.

The digest is computed over the pinned effective schema document after canonical JSON serialization per RFC 8785 (JSON Canonicalization Scheme), using UTF-8 bytes as the digest input.

This ensures equivalent schema documents produce the same digest even when their original formatting differs.

### Error Handling

- `400 Bad Request`: malformed JSON, malformed schema document, invalid schema URL, or unsupported header combination
- `409 Conflict`: stream already exists with different schema configuration
- `422 Unprocessable Content`: valid JSON that does not satisfy the attached schema

### Data Model

Each stream may store the following schema metadata:

- `stream_content_type`
- `schema_digest` optional
- `schema_document` optional
- `schema_source_url` optional

At most one schema may be attached to a stream.

### Implementation Notes

- Servers should normalize and pin the effective schema document at create time.
- `GET {stream-url}?schema` should return that pinned effective schema document.
- `Stream-Schema-Url` must be an absolute `http` or `https` URL.
- Servers should not re-fetch external schema URLs during later appends.
- The minimum supported schema version is JSON Schema 2020-12.
- Servers must treat missing `$schema` as JSON Schema 2020-12.
- Servers must validate the schema document's `$schema` value at creation time and reject schema documents that declare an unsupported version.
- Servers should recognize `application/schema+json` by convention for inline schema creation, even though it is not currently an IANA-registered media type.
- Attached schema is immutable for the lifetime of the stream.

### Protocol Integration Notes

When this RFC is incorporated into `PROTOCOL.md`, the header registry section should add:

- `Stream-Content-Type`
  - Declares the stream payload content type when `Content-Type` describes the request body rather than the stream.
- `Stream-Schema-Url`
- `Stream-Schema-Digest`

### Server Conformance Test Plan

This RFC should be covered by protocol-level conformance tests in `packages/server-conformance-tests`.

The first pass should add a dedicated `JSON Schema Validation` section to the server conformance suite and keep the scope intentionally narrow.

#### Test Harness Additions

- Add shared constants for `Stream-Content-Type`, `Stream-Schema-Url`, and `Stream-Schema-Digest`.
- Add reusable schema fixtures for:
  - valid JSON Schema 2020-12 document
  - valid schema document with omitted `$schema`
  - unsupported `$schema` version
  - valid JSON payloads
  - invalid JSON payloads
- Add a helper for `GET {stream-url}?schema`.
- Add a small schema fixture HTTP server for schema URL tests rather than relying on external network dependencies.
- Make the schema fixture base URL configurable so schema URL tests can run when the system under test is in a container, VM, or remote environment.
- The conformance runner should expose a `schemaFixtureBaseUrl`-style configuration value and schema URL tests should use that externally reachable base URL instead of assuming `localhost`.

#### Minimum First-Pass Test Coverage

1. Create `application/json` stream without schema to confirm existing behavior remains unchanged.
2. Create JSON stream with inline schema using `Content-Type: application/schema+json` and `Stream-Content-Type: application/json`.
3. Create JSON stream with `Stream-Schema-Url` and valid initial body.
4. Accept schema creation when `$schema` is omitted and treat the schema as JSON Schema 2020-12.
5. Reject inline schema creation when `$schema` declares an unsupported version.
6. Reject non-absolute or non-`http`/`https` schema URLs.
7. Reject schema attachment modes on non-JSON streams with `400 Bad Request`.
8. Reject `GET {stream-url}?schema` when combined with read parameters such as `offset`, `live`, or `cursor`.
9. Reject invalid initial JSON data with `422 Unprocessable Content`.
10. Reject invalid `POST` appends with `422 Unprocessable Content`.
11. Reject a mixed JSON batch atomically when any flattened logical message fails schema validation.
12. Preserve `400 Bad Request` for malformed JSON syntax errors.
13. Reject schema documents that are not semantically valid JSON Schemas.
14. Reject schemas that require external `$ref` resolution.
15. Advertise schema metadata on `HEAD`, including an absolute `Link` target.
16. Return the effective schema document from `GET {stream-url}?schema`.
17. Return `404 Not Found` from `GET {stream-url}?schema` when the stream exists but has no attached schema.
18. Treat inline-schema create and schema-URL create as idempotently equivalent when they produce the same digest.
19. Preserve idempotent `PUT` behavior when schema configuration matches and return `409` when it does not.

#### Implementation Order

1. Add constants, fixtures, and helper functions.
2. Add create and create-rejection tests.
3. Add validation tests for initial `PUT` and later `POST` requests.
4. Add retrieval tests for `HEAD` and `GET ?schema`.
5. Add idempotency and configuration mismatch tests.

#### Explicit Deferrals

The initial conformance pass should defer:

- rich error body assertions
- schema evolution and compatibility policy tests
- support matrices for schema versions beyond the minimum required 2020-12 baseline
- non-JSON bootstrap metadata patterns
- mutable remote schema source behavior beyond verifying that schema URLs are absolute `http`/`https` URLs and retrieval returns the stored effective schema

### Implementation Strategy for `packages/caddy-plugin` and `packages/server`

This RFC requires implementation in both `packages/caddy-plugin` and `packages/server`.

The two implementations have similar architecture today:

- an HTTP handler layer that parses protocol headers, routes `PUT` / `POST` / `HEAD` / `GET`, and shapes protocol responses
- a store layer that owns stream metadata, append validation, read behavior, and idempotent create/config matching

The recommended implementation strategy is to keep schema parsing and schema metadata in the store layer, while keeping the HTTP layer responsible for request decoding, response headers, and status code mapping.

#### Shared Implementation Phases

1. Extend stream metadata and create options.
2. Add schema validation utilities and schema-document parsing.
3. Update `PUT` create flows for inline schema and schema URL modes.
4. Update `POST` append flows to validate logical JSON messages against attached schema.
5. Update `HEAD` and `GET ?schema` retrieval behavior.
6. Add conformance coverage and implementation-specific tests.

#### Store-Layer Changes

Both implementations should extend their store metadata to retain:

- stream payload content type
- schema digest
- pinned schema document
- schema source URL when created from URL

Both implementations should also canonicalize the pinned effective schema document before computing `Stream-Schema-Digest`, and make schema identity part of create-time config matching so idempotent `PUT` semantics continue to work correctly.

#### HTTP-Layer Changes

Both implementations should:

- recognize `Content-Type: application/schema+json` with `Stream-Content-Type: application/json` for inline schema creation
- recognize `Stream-Schema-Url` for URL-based schema attachment
- enforce the schema URL resolution policy for absolute `http` / `https` URLs without forwarding caller credentials
- return `422 Unprocessable Content` for schema validation failures
- advertise schema metadata on `HEAD`
- serve the pinned schema from `GET {stream-url}?schema`

#### `packages/caddy-plugin`

`packages/caddy-plugin` should be treated as the primary production implementation for this RFC.

Recommended approach:

- Add the new schema headers to the protocol header constants and CORS allow/expose lists.
- Extend `store.CreateOptions` and `store.StreamMetadata` with schema fields.
- Implement schema-aware config matching in the store so repeated `PUT` requests compare schema identity as part of stream configuration.
- Add store-level JSON Schema validation during create and append paths so HTTP handlers can map store errors to `400`, `409`, and `422`.
- Update `handleCreate`, `handleAppend`, and `handleHead` in `handler.go` and add explicit `GET ?schema` handling in the read path.
- Keep schema URL resolution as a create-time operation only and persist the resolved schema snapshot.

Because the Caddy plugin already centralizes protocol behavior in `handler.go` and durable metadata in `store`, it should be the production-grade target that converges with the finalized conformance suite after protocol semantics are proven in `packages/server`.

#### `packages/server`

`packages/server` should implement the same external protocol behavior as `packages/caddy-plugin`, but can optimize for developer simplicity over production hardening.

Recommended approach:

- Extend the `Stream` shape and store create options with schema fields in the TypeScript store layer.
- Add JSON Schema validation in the store's JSON-mode append path so validation remains consistent for initial create and later appends.
- Update `handleCreate`, `handleAppend`, `handleHead`, and `handleRead` in `src/server.ts` to support the new headers, `422` responses, schema metadata headers, and `GET ?schema`.
- Use the in-memory server implementation as the fastest place to iterate on protocol semantics before, or in parallel with, the Caddy plugin.
- Keep behavior aligned with the conformance suite even if the internal implementation is simpler than the production plugin.

#### Rollout Recommendation

Recommended rollout order:

1. Implement the behavior in `packages/server` first to iterate quickly on protocol shape and tests.
2. Add or finalize server conformance coverage in `packages/server-conformance-tests`.
3. Implement the same behavior in `packages/caddy-plugin`.
4. Use the shared conformance suite to verify parity between the development server and production server.
5. Treat `packages/caddy-plugin` as the production reference once it passes the finalized conformance suite.

This gives a fast feedback loop during design while ensuring the production implementation becomes the long-term reference target.

### Complexity Check

_Before finalizing, answer these questions:_

- **Is this the simplest approach?** Yes. It adds one new creation pattern, one optional schema URL header, validation rules, and one retrieval endpoint without changing append or read semantics.
- **What could we cut?** We could defer schema URL support and ship only inline schema attachment plus retrieval.
- **What's the 90/10 solution?** Support inline schema creation, validate appends, and expose `GET ?schema`. Schema URL attachment adds value for atomic create-with-data flows and for avoiding repeated transmission of large schemas, but it can still be deferred if implementation time is constrained.

## Open Questions

None currently.

## Definition of Success

_How do we know if this proposal was successful? Tie success to the PRD hypothesis._

### Primary Hypothesis

> We believe that implementing **JSON Schema validation for JSON Mode** will enable **schema-aware JSON streams with server-enforced validation and client-visible contracts**.
>
> We'll know we're right if **developers can create schema-bound JSON streams, receive validation failures on invalid writes, and retrieve the effective schema from clients without out-of-band configuration**.
>
> We'll know we're wrong if **schema attachment remains ambiguous, retrieval is not useful to clients, or validation adds enough operational friction that users continue to rely on unvalidated JSON streams**.

### Functional Requirements

| Requirement                                        | Acceptance Criteria                                                                                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create JSON stream with no schema                  | Existing `PUT` behavior continues unchanged                                                                                                                                                   |
| Create JSON stream with inline schema              | `PUT` with `Content-Type: application/schema+json` and `Stream-Content-Type: application/json` creates an empty schema-bound stream                                                           |
| Create JSON stream with schema URL                 | `PUT` with `Stream-Schema-Url` attaches a pinned schema snapshot and validates any initial body                                                                                               |
| Validate writes                                    | Invalid JSON remains `400`; schema-invalid JSON returns `422`; valid JSON appends succeed                                                                                                     |
| Retrieve schema                                    | `HEAD` advertises schema presence and `GET {stream-url}?schema` returns the effective schema document                                                                                         |
| Retrieve schema from the TypeScript client         | `DurableStream.getSchema(...)` accepts headers and `handle.getSchema()` reuses the handle's configured auth and request options                                                               |
| Create schema-bound streams from the Python client | Python create APIs expose semantic kwargs such as `schema` and `schema_url` instead of requiring manual protocol header construction in common cases                                          |
| Retrieve schema from the Python client             | `DurableStream.get_schema_static(...)` and `AsyncDurableStream.get_schema_static(...)` accept auth and request options; handle methods reuse the handle's configured auth and request options |
| Preserve idempotency                               | Repeated `PUT` with matching schema config returns `200`; mismatched config returns `409`                                                                                                     |

### Learning Goals

_Beyond success/failure, what do we want to learn from this implementation?_

1. Whether users prefer inline schema creation or schema URL creation in real workflows.
2. Whether the bootstrap pattern using `Content-Type` plus `Stream-Content-Type` is useful for future stream metadata creation flows.

## Alternatives Considered

_What other approaches did we consider? Why did we choose this one?_

### Alternative 1: Put inline schema in the normal `PUT` body with `Content-Type: application/json`

**Description:** Reuse `PUT` and let the request body contain a schema document, while still using `Content-Type: application/json`.

**Why not:** This makes `Content-Type` ambiguous because the body is schema metadata, not initial stream data.

### Alternative 2: Multipart create request with schema and initial data

**Description:** Use a multipart request so a single `PUT` can carry both the schema and initial messages.

**Why not:** It is more complex than needed for the first version and introduces a second structured create format with limited immediate benefit.

### Alternative 3: Schema URL only

**Description:** Allow schemas only by URL and keep all inline schema documents out of band.

**Why not:** It blocks fully self-contained stream creation and makes schema creation dependent on an external registry or network fetch path.

## Revision History

| Version | Date       | Author    | Changes         |
| ------- | ---------- | --------- | --------------- |
| 1.0     | 2026-03-06 | samwillis | Initial version |

---

## RFC Quality Checklist

Before submitting for review, verify:

**Alignment**

- [x] RFC implements what the PRD specifies (not more, not less)
- [x] API naming matches ElectricSQL conventions (snake_case params, kebab-case headers)
- [x] Success criteria link back to PRD hypothesis

**Calibration for Level 1-2 PMF**

- [x] This is the simplest approach that validates the hypothesis
- [x] Non-goals explicitly defer Level 3-4 concerns
- [x] Complexity Check section is filled out honestly
- [x] An engineer could start implementing tomorrow

**Completeness**

- [x] Happy path is clear
- [x] Critical failure modes are addressed (not all possible failures)
- [x] Open questions are acknowledged, not glossed over
