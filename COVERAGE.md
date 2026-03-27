# Protocol Requirement Coverage Matrix

Bidirectional mapping between [PROTOCOL.md](./PROTOCOL.md) requirements and test coverage.

**Last updated:** 2026-02-06

## Summary

| Status      | Count   | %     |
| ----------- | ------- | ----- |
| Covered     | 82      | 72.6% |
| Partial     | 14      | 12.4% |
| Not Covered | 10      | 8.8%  |
| N/A         | 7       | 6.2%  |
| **Total**   | **113** |       |

---

## Doc → Code

### Section 4: Stream Model

| Req# | Keyword        | Requirement                                                       | Coverage | Test Reference                                                                                       |
| ---- | -------------- | ----------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| 4-1  | MUST (implied) | Durability: written bytes persist until deletion/expiry           | Covered  | server: multiple read-after-write tests                                                              |
| 4-2  | MUST (implied) | Immutability by position: bytes at offset never change            | Covered  | server: `should preserve data immutability by position`; property: `data at offset never changes`    |
| 4-3  | MUST (implied) | Ordering: bytes strictly ordered by offset                        | Covered  | server: `should generate unique, monotonically increasing offsets`                                   |
| 4-4  | SHOULD NOT     | After deletion, new stream SHOULD NOT be created at same URL      | Partial  | server: `should properly isolate recreated stream after delete` tests recreation but not prohibition |
| 4-5  | MUST (implied) | Stream state: open or closed, transition is durable and monotonic | Covered  | client: `stream-closure.yaml` suite                                                                  |

### Section 4.1: Stream Closure

| Req#  | Keyword    | Requirement                                                     | Coverage    | Test Reference                                                                              |
| ----- | ---------- | --------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| 4.1-1 | MUST       | `Stream-Closed` value `true` is case-insensitive                | **Covered** | server: `Exhaustive Boundary Tests > Stream-Closed Header Value Parsing` (5 case variants)  |
| 4.1-2 | MUST       | Non-`true` values (`false`, `yes`, `1`, `""`) treated as absent | **Covered** | server: `Exhaustive Boundary Tests > Stream-Closed Header Value Parsing` (9 invalid values) |
| 4.1-3 | SHOULD NOT | Servers SHOULD NOT error on non-`true` values                   | **Covered** | server: `Exhaustive Boundary Tests > Stream-Closed Header Value Parsing`                    |

### Section 5.1: Create Stream (PUT)

| Req#  | Keyword     | Requirement                                                  | Coverage    | Test Reference                                                                                |
| ----- | ----------- | ------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------- |
| 5.1-1 | MUST        | Return 200 if existing stream config matches                 | Covered     | server: `should return 200 on idempotent PUT`                                                 |
| 5.1-2 | MUST        | Return 409 if existing stream config differs                 | Covered     | server: `should return 409 on PUT with different config`                                      |
| 5.1-3 | MUST        | Closure status matching on idempotent PUT (4 combinations)   | **Covered** | server: `Exhaustive Boundary Tests > PUT Idempotent Create with Closure Status` (all 4 cases) |
| 5.1-4 | MAY         | Default to `application/octet-stream` if CT omitted          | Covered     | server: `should accept PUT without Content-Type`                                              |
| 5.1-5 | MUST        | Stream-TTL: non-negative integer, no leading zeros/plus/etc. | Covered     | server: `TTL and Expiry Edge Cases` (4 format tests)                                          |
| 5.1-6 | SHOULD      | Reject 400 if both TTL and Expires-At supplied               | **Covered** | server: `Exhaustive Boundary Tests > TTL and Expires-At Conflict`                             |
| 5.1-7 | SHOULD      | Include Location header on 201                               | Covered     | server: `should return Location header on 201`                                                |
| 5.1-8 | (specified) | Stream-Closed: true creates stream in closed state           | **Covered** | server: `Exhaustive Boundary Tests > Create-and-Close in Single PUT` (3 tests)                |

### Section 5.2: Append to Stream (POST)

| Req#   | Keyword  | Requirement                                              | Coverage    | Test Reference                                                                                   |
| ------ | -------- | -------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| 5.2-1  | MUST     | Content-Type MUST match stream's type                    | Covered     | server: `Content-Type Validation` suite                                                          |
| 5.2-2  | MAY      | Content-Type MAY be omitted on close-only (empty body)   | **Covered** | server: `Exhaustive Boundary Tests > Content-Type on Close-Only POST` (2 tests)                  |
| 5.2-3  | MUST NOT | Servers MUST NOT reject close-only based on Content-Type | **Covered** | server: `Exhaustive Boundary Tests > Content-Type on Close-Only POST > mismatched CT accepted`   |
| 5.2-4  | MUST     | Stream-Seq: byte-wise lexicographic ordering             | Covered     | server: `should enforce case-sensitive seq ordering`                                             |
| 5.2-5  | MUST     | Seq <= last → 409 Conflict                               | Covered     | server: `should enforce sequence ordering`                                                       |
| 5.2-6  | MUST     | Empty body without Stream-Closed → 400                   | Covered     | server: `should reject empty POST body with 400`                                                 |
| 5.2-7  | MUST     | Append to closed stream → 409 with Stream-Closed: true   | Covered     | client: `stream-closure.yaml#append-to-closed-fails`                                             |
| 5.2-8  | MUST     | 409 for closed stream includes Stream-Next-Offset        | Covered     | server: `409-includes-stream-offset`                                                             |
| 5.2-9  | SHOULD   | Error precedence: closed > content-type > sequence       | **Covered** | server: `Exhaustive Boundary Tests > Error Precedence for Closed Streams` (2 tests)              |
| 5.2-10 | SHOULD   | Close-only idempotent: 204 with Stream-Closed            | **Covered** | server: `Exhaustive Boundary Tests > Close-Only Request Idempotency`                             |
| 5.2-11 | MUST     | Append-and-close on closed stream (no producer) → 409    | **Covered** | server: `Exhaustive Boundary Tests > Close-Only Request Idempotency > append-and-close conflict` |

### Section 5.2.1: Idempotent Producers

| Req#     | Keyword | Requirement                                             | Coverage    | Test Reference                                                                                            |
| -------- | ------- | ------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| 5.2.1-1  | MUST    | All 3 headers together or none; partial → 400           | **Covered** | server: `Exhaustive Boundary Tests > Partial Producer Headers` (6 partial + 2 valid)                      |
| 5.2.1-2  | MUST    | Producer-Id non-empty; empty → 400                      | **Covered** | server: `Exhaustive Boundary Tests > Producer-Id Validation`                                              |
| 5.2.1-3  | MUST    | Producer-Epoch: non-negative integer ≤ 2^53-1           | **Covered** | server: `Exhaustive Boundary Tests > Producer Epoch/Seq Boundary Values` (epoch min/max/neg/float/string) |
| 5.2.1-4  | MUST    | Producer-Seq: non-negative integer ≤ 2^53-1             | **Covered** | server: `Exhaustive Boundary Tests > Producer Epoch/Seq Boundary Values` (seq neg/float)                  |
| 5.2.1-5  | MUST    | Stale epoch → 403 with Producer-Epoch header            | **Covered** | server: `Exhaustive Boundary Tests > Epoch Transition Boundary > stale epoch`                             |
| 5.2.1-6  | MUST    | New epoch with seq ≠ 0 → 400                            | **Covered** | server: `Exhaustive Boundary Tests > Epoch Transition Boundary > new epoch seq=1`                         |
| 5.2.1-7  | MUST    | Duplicate (seq ≤ lastSeq) → 204                         | Covered     | client: `sequence-validation.yaml#duplicate-returns-204`                                                  |
| 5.2.1-8  | MUST    | seq == lastSeq + 1 → accepted, 200                      | Covered     | client: `sequence-validation.yaml#sequential-sequences`                                                   |
| 5.2.1-9  | MUST    | Sequence gap → 409 with Expected/Received headers       | Covered     | client: `sequence-validation.yaml#sequence-gap-rejected`                                                  |
| 5.2.1-10 | MUST    | Serialize per (stream, producerId) pair                 | Partial     | client: `concurrent-requests.yaml` tests concurrency but not serialization directly                       |
| 5.2.1-11 | SHOULD  | Atomic commit of producer state + log append            | N/A         | Implementation-specific                                                                                   |
| 5.2.1-12 | MAY     | TTL-based cleanup for producer state                    | N/A         | Implementation-specific                                                                                   |
| 5.2.1-13 | SHOULD  | Duplicate close → 204 with Stream-Closed                | Covered     | client: `stream-closure.yaml`                                                                             |
| 5.2.1-14 | MUST    | Closed stream + matching tuple → 204 with Stream-Closed | Covered     | server: `close-with-different-body-dedup`                                                                 |

### Section 5.3–5.4: Close and Delete

| Req#  | Keyword     | Requirement                                          | Coverage | Test Reference                                            |
| ----- | ----------- | ---------------------------------------------------- | -------- | --------------------------------------------------------- |
| 5.3-1 | (specified) | POST with Stream-Closed and empty body closes stream | Covered  | client: `stream-closure.yaml#close-empty-stream`          |
| 5.3-2 | (specified) | Returns 204 (idempotent)                             | Covered  | client: `stream-closure.yaml#close-idempotent`            |
| 5.3-3 | (specified) | Returns 404 if stream doesn't exist                  | Covered  | server: `close-nonexistent-stream-404`                    |
| 5.4-1 | (specified) | DELETE returns 204 on success                        | Covered  | server: `should return 204 on successful DELETE`          |
| 5.4-2 | (specified) | DELETE returns 404 if not found                      | Covered  | server: `should return 404 on DELETE non-existent stream` |

### Section 5.5: Stream Metadata (HEAD)

| Req#  | Keyword     | Requirement                             | Coverage | Test Reference                                           |
| ----- | ----------- | --------------------------------------- | -------- | -------------------------------------------------------- |
| 5.5-1 | (specified) | Returns 200 with CT, Stream-Next-Offset | Covered  | server: `HEAD Metadata` suite                            |
| 5.5-2 | (specified) | Returns 404 if not found                | Covered  | server: `HEAD Metadata` suite                            |
| 5.5-3 | (specified) | Stream-Closed present when closed       | Covered  | client: `stream-closure.yaml#head-closed-stream`         |
| 5.5-4 | SHOULD      | Cache-Control: no-store on HEAD         | Covered  | server: `should include Cache-Control: no-store on HEAD` |

### Section 5.6: Read Stream - Catch-up

| Req#   | Keyword     | Requirement                                         | Coverage    | Test Reference                                                         |
| ------ | ----------- | --------------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| 5.6-1  | (specified) | Returns 200 with data from offset                   | Covered     | server: `Read Operations` suite                                        |
| 5.6-2  | (specified) | No offset = stream start (-1)                       | Covered     | server: `should return same data for offset=-1 and no offset`          |
| 5.6-3  | SHOULD      | 200 + empty body + offset at tail                   | Covered     | server: `should return empty response when reading from tail offset`   |
| 5.6-4  | MUST        | Stream-Closed at tail of closed stream              | Covered     | client: `stream-closure.yaml#closure-via-empty-body-at-tail`           |
| 5.6-5  | MUST        | Stream-Up-To-Date when all data returned            | Covered     | multiple tests                                                         |
| 5.6-6  | SHOULD NOT  | No Up-To-Date when partial data                     | Partial     | Not explicitly tested in isolation                                     |
| 5.6-7  | MUST        | Stream-Closed when closed + at final offset         | Covered     | client: `stream-closure.yaml`                                          |
| 5.6-8  | SHOULD NOT  | No Stream-Closed on partial data from closed stream | Not Covered | No test for partial reads of closed streams                            |
| 5.6-9  | MUST        | Generate ETag on GET                                | Covered     | server: `Caching and ETag` suite                                       |
| 5.6-10 | MUST        | 304 for matching If-None-Match                      | Covered     | server: `should return 304 Not Modified`                               |
| 5.6-11 | MUST        | ETag varies with closure status                     | **Covered** | server: `Exhaustive Boundary Tests > ETag Closure Variation` (2 tests) |

### Section 5.7: Long-poll

| Req#  | Keyword  | Requirement                                         | Coverage    | Test Reference                                                                 |
| ----- | -------- | --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| 5.7-1 | MUST     | Offset required for long-poll                       | Covered     | server: `should require offset parameter for long-poll`                        |
| 5.7-2 | MUST     | Stream-Cursor on long-poll responses                | Covered     | server: cursor tests                                                           |
| 5.7-3 | MUST     | 204 includes Stream-Next-Offset                     | Covered     | server: `204 timeout` test                                                     |
| 5.7-4 | MUST     | 204 includes Stream-Up-To-Date                      | Covered     | server: same                                                                   |
| 5.7-5 | MUST NOT | MUST NOT wait for timeout when closed at tail       | **Covered** | server: `Exhaustive Boundary Tests > Long-poll Closed Stream Immediate Return` |
| 5.7-6 | MUST     | Immediately return 204 + Stream-Closed + Up-To-Date | **Covered** | same as 5.7-5                                                                  |

### Section 5.8: SSE

| Req#   | Keyword | Requirement                                    | Coverage    | Test Reference                                               |
| ------ | ------- | ---------------------------------------------- | ----------- | ------------------------------------------------------------ |
| 5.8-1  | MUST    | Content-Type: text/event-stream                | Covered     | server: SSE content-type test                                |
| 5.8-2  | MUST    | Auto base64-encode for binary streams          | Covered     | server + client: `read-sse-base64.yaml`                      |
| 5.8-3  | MUST    | stream-sse-data-encoding: base64 header        | Covered     | server: encoding header test                                 |
| 5.8-4  | MUST    | Control events include streamNextOffset        | Covered     | server: control event tests                                  |
| 5.8-5  | MUST    | Control includes streamCursor when open        | Covered     | server: cursor tests                                         |
| 5.8-6  | MUST    | Control includes upToDate when caught up       | Covered     | server: upToDate test                                        |
| 5.8-7  | MUST    | streamClosed when closed and all data sent     | Covered     | client: `stream-closure.yaml#sse-closed-final-event`         |
| 5.8-8  | MUST    | Close SSE connection after final control event | Covered     | client: SSE closure tests                                    |
| 5.8-9  | MUST    | Offset required for SSE                        | Covered     | server: `should require offset parameter for SSE mode`       |
| 5.8-10 | SHOULD  | Close SSE connections ~every 60 seconds        | Not Covered | Timing test not implemented                                  |
| 5.8-11 | MUST    | Client reconnect using last streamNextOffset   | Covered     | server: `should support reconnection with last known offset` |

### Section 6: Offsets

| Req# | Keyword  | Requirement                                              | Coverage    | Test Reference                                                               |
| ---- | -------- | -------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------- |
| 6-1  | MUST     | Offsets strictly increasing (lexicographic)              | Covered     | server: monotonic offset tests; property tests                               |
| 6-2  | MUST NOT | Offsets must not contain `,`, `&`, `=`, `?`, `/`         | Partial     | server: tests comma and space but not all forbidden chars                    |
| 6-3  | MUST     | Recognize -1 as stream beginning                         | Covered     | server: sentinel tests                                                       |
| 6-4  | MUST     | offset=-1 equivalent to omitting offset                  | Covered     | server: `should return same data for offset=-1 and no offset`                |
| 6-5  | MUST     | offset=now catch-up: 200 + empty + offset + upToDate     | Covered     | server: `offset=now` suite                                                   |
| 6-6  | MUST     | offset=now JSON: returns `[]`                            | Covered     | server: `should return empty JSON array for offset=now`                      |
| 6-7  | MUST     | offset=now long-poll: immediately wait                   | Covered     | server: `offset=now with long-poll`                                          |
| 6-8  | MUST     | offset=now SSE: start from tail                          | Covered     | server: `offset=now with SSE`                                                |
| 6-9  | MUST     | offset=now on closed stream: immediate closure signal    | **Covered** | server: `Exhaustive Boundary Tests > offset=now on Closed Streams` (3 modes) |
| 6-10 | MUST NOT | Server must not generate "-1" or "now" as actual offsets | Not Covered | No test verifies actual offsets aren't sentinels                             |

### Section 7.1: JSON Mode

| Req#  | Keyword     | Requirement                                    | Coverage    | Test Reference                                                           |
| ----- | ----------- | ---------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| 7.1-1 | MUST        | Preserve message boundaries; GET returns array | Covered     | server: `JSON Mode` suite                                                |
| 7.1-2 | MUST        | Flatten exactly one level of array             | Covered     | server: JSON Mode flatten tests                                          |
| 7.1-3 | MUST        | Reject POST with empty array `[]` with 400     | **Covered** | server: `Exhaustive Boundary Tests > JSON Mode Empty Array`              |
| 7.1-4 | (specified) | PUT with `[]` creates empty stream             | **Covered** | server: `Exhaustive Boundary Tests > JSON Mode Empty Array > PUT valid`  |
| 7.1-5 | MUST        | Validate appended data is valid JSON           | **Covered** | server: `Exhaustive Boundary Tests > JSON Validation` (4 invalid bodies) |
| 7.1-6 | MUST        | GET returns Content-Type: application/json     | Covered     | server: JSON Mode tests                                                  |
| 7.1-7 | MUST        | Empty range returns `[]`                       | Covered     | server: offset=now JSON test                                             |

### Section 8: Caching and Collapsing

| Req# | Keyword | Requirement                                        | Coverage    | Test Reference                                                               |
| ---- | ------- | -------------------------------------------------- | ----------- | ---------------------------------------------------------------------------- |
| 8-1  | MUST    | Generate ETag on GET (except offset=now)           | Covered     | server: `Caching and ETag` suite                                             |
| 8-2  | MUST    | 304 for matching If-None-Match                     | Covered     | server: If-None-Match test                                                   |
| 8-3  | MUST    | ETag varies with closure status                    | **Covered** | server: `Exhaustive Boundary Tests > ETag Closure Variation`                 |
| 8-4  | MUST    | If-None-Match with old ETag on closed stream → 200 | **Covered** | server: `Exhaustive Boundary Tests > ETag Closure Variation > If-None-Match` |
| 8-5  | MUST    | Cursors on all live mode responses                 | Covered     | server: cursor tests                                                         |
| 8-6  | MUST    | Monotonic cursor progression                       | Covered     | server: `cursor collision with jitter`                                       |

### Section 10: Security

| Req# | Keyword | Requirement                             | Coverage    | Test Reference                           |
| ---- | ------- | --------------------------------------- | ----------- | ---------------------------------------- |
| 10-1 | MUST    | Validate content types match            | Covered     | server: `Content-Type Validation`        |
| 10-2 | MUST    | Reject sequence regressions             | Covered     | server: sequence ordering tests          |
| 10-3 | SHOULD  | X-Content-Type-Options: nosniff         | Covered     | server: `Browser Security Headers` suite |
| 10-4 | SHOULD  | Cross-Origin-Resource-Policy header     | Covered     | server: CORP header test                 |
| 10-5 | MUST    | All operations over HTTPS in production | Not Covered | Environmental, test uses HTTP            |

---

## Critical Gaps

Uncovered MUST/MUST NOT requirements that should be prioritized:

| Req#   | Section | Requirement                                                           | Risk                                    |
| ------ | ------- | --------------------------------------------------------------------- | --------------------------------------- |
| 5.6-8  | §5.6    | Stream-Closed SHOULD NOT be present on partial reads of closed stream | Low — only affects chunked reads        |
| 5.8-10 | §5.8    | SSE connections SHOULD close ~every 60 seconds                        | Low — timing test, hard to verify       |
| 6-2    | §6      | Offsets must not contain all forbidden chars (`&`, `=`, `?`, `/`)     | Medium — only comma and space tested    |
| 6-10   | §6      | Server must not generate "-1" or "now" as actual offsets              | Medium — sentinel/real offset ambiguity |
| 10-5   | §10     | HTTPS in production                                                   | Low — environmental                     |

---

## Code → Doc: Orphan Tests

Tests providing valuable coverage beyond specific protocol requirements:

| Test                      | File                                   | Description                                                  |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| Fault injection suite     | `consumer/fault-injection.yaml`        | Client resilience to delays, drops, combined faults          |
| Retry resilience          | `consumer/retry-resilience.yaml`       | Client retry on 500, 503, 429                                |
| JSON parsing errors       | `consumer/json-parsing-errors.yaml`    | Client handling of corrupted JSON                            |
| SSE parsing errors        | `consumer/sse-parsing-errors.yaml`     | Client handling of unknown SSE events                        |
| Error context             | `consumer/error-context.yaml`          | Helpful debugging info in errors                             |
| Dynamic headers           | `lifecycle/dynamic-headers.yaml`       | Per-request header evaluation                                |
| Property-based tests      | server: `Property-Based Tests`         | Fuzz-style tests for byte-exactness, sequences, immutability |
| CRLF injection            | server: SSE CRLF tests                 | Security: prevents event injection via newlines              |
| Read-your-writes          | server: `Read-Your-Writes Consistency` | Immediate visibility of appended data                        |
| Streaming equivalence     | `consumer/streaming-equivalence.yaml`  | SSE and long-poll produce identical results                  |
| Exhaustive boundary tests | server: `Exhaustive Boundary Tests`    | Systematic boundary value testing across protocol features   |

---

## Notes

1. **Bolded "Covered"** entries in the table indicate requirements newly covered by the Exhaustive Boundary Tests added in this review cycle.
2. Coverage is assessed across both server conformance tests (`packages/server-conformance-tests/src/index.ts`) and client conformance tests (`packages/client-conformance-tests/test-cases/**/*.yaml`).
3. The most impactful gaps closed in this cycle were: Stream-Closed case-insensitive parsing (which revealed a server bug), PUT closure status matching, error precedence, and ETag closure variation.
