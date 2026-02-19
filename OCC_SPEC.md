# OCC Formal Specification

**Feature:** Optimistic Concurrency Control via `If-Match` header
**Protocol Section:** 5.2.2
**Status:** Implemented

---

## Invariants

| ID                 | Name                   | Description                                                                                                                               |
| ------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| I_ATOMICITY        | Atomic CAS             | The ETag comparison and append MUST be performed atomically — no interleaving appends between comparison and write                        |
| I_PRECEDENCE       | Error Precedence       | When multiple error conditions apply, servers check: 404 → 409 (closed) → 409 (content-type) → 400 (mutual exclusivity) → 412 (If-Match)  |
| I_MUTUAL_EXCLUSION | Producer/OCC Exclusion | `If-Match` and producer headers (`Producer-Id`, `Producer-Epoch`, `Producer-Seq`) MUST NOT appear in the same request; servers return 400 |
| I_412_USABLE       | Usable 412 Response    | A 412 response MUST include `ETag` and `Stream-Next-Offset` reflecting the current stream state, enabling direct retry                    |
| I_ETAG_ON_SUCCESS  | ETag on Success        | A successful append (204) MUST include `ETag: "<new-offset>"` in the response, enabling chained CAS without HEAD                          |
| I_NO_WILDCARD      | No Wildcard Support    | `If-Match: *` is not supported; servers treat it as a non-matching ETag value (returns 412)                                               |

## Affordances

| Affordance            | Description                                                               | Enabled By                |
| --------------------- | ------------------------------------------------------------------------- | ------------------------- |
| Single-shot CAS       | HEAD → POST with If-Match → success or 412                                | I_ATOMICITY               |
| Chained CAS           | Use ETag from 204 success as If-Match for next append (no HEAD roundtrip) | I_ETAG_ON_SUCCESS         |
| Direct retry from 412 | Use Stream-Next-Offset from 412 response as new If-Match value            | I_412_USABLE              |
| Conflict detection    | Detect concurrent modifications at the application level                  | I_ATOMICITY, I_412_USABLE |

## Constraints

| Constraint                 | Rationale                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| No producer header mixing  | Conflicting retry semantics — producer retries succeed (deduplicated), OCC retries may fail (offset changed) |
| No guaranteed convergence  | Under high contention, CAS retries may loop indefinitely; clients SHOULD cap retries (recommended: 3)        |
| No built-in retry          | OCC is single-shot; retry logic is the client's responsibility                                               |
| ETag format is transparent | ETags are quoted offset strings (e.g., `"42"`), not opaque tokens; clients may parse them                    |

## Error Precedence Table

When an append request triggers multiple error conditions simultaneously:

| Condition                                       | Expected Status | Headers                                                        |
| ----------------------------------------------- | --------------- | -------------------------------------------------------------- |
| Stream does not exist                           | 404             | —                                                              |
| Stream closed (non-close, non-producer request) | 409             | `Stream-Closed: true`, `Stream-Next-Offset`                    |
| Content-Type mismatch                           | 409             | —                                                              |
| If-Match + producer headers                     | 400             | —                                                              |
| If-Match precondition failed                    | 412             | `ETag`, `Stream-Next-Offset`, optionally `Stream-Closed: true` |
| Producer validation errors                      | 400/403/409     | varies                                                         |

**Key precedence rule:** A closed stream with a stale If-Match returns **409** (not 412), because closure is checked first.

## Bidirectional Enforcement Checklist

| Invariant          | Types/Compile-time               | Runtime (server)                                                                 | Conformance Tests                                                             |
| ------------------ | -------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| I_ATOMICITY        | —                                | Store-level atomic append                                                        | `append with matching If-Match succeeds`, `second writer fails with 412`      |
| I_PRECEDENCE       | —                                | Error checks ordered: 404 → closure → content-type → mutual-exclusion → If-Match | `closed stream returns 409 (not 412)`                                         |
| I_MUTUAL_EXCLUSION | Client types prevent mixing (TS) | 400 on mixed headers                                                             | `If-Match with producer headers returns 400`                                  |
| I_412_USABLE       | —                                | 412 response includes ETag + Stream-Next-Offset                                  | `412 response includes current ETag for retry`, `successful append after 412` |
| I_ETAG_ON_SUCCESS  | —                                | 204 response includes ETag header                                                | `successful append returns ETag`                                              |
| I_NO_WILDCARD      | —                                | Wildcard not special-cased                                                       | `wildcard If-Match returns 412`                                               |

## Conformance Test Map

| Test Name                                                 | Invariant(s)                   |
| --------------------------------------------------------- | ------------------------------ |
| `append with matching If-Match succeeds`                  | I_ATOMICITY                    |
| `append with stale If-Match returns 412`                  | I_ATOMICITY, I_412_USABLE      |
| `wildcard If-Match returns 412`                           | I_NO_WILDCARD                  |
| `append with If-Match to non-existent stream returns 404` | I_PRECEDENCE                   |
| `append with If-Match to closed stream returns 409`       | I_PRECEDENCE                   |
| `second writer fails with 412 after first writer appends` | I_ATOMICITY                    |
| `412 response includes current ETag for retry`            | I_412_USABLE                   |
| `If-Match with producer headers returns 400`              | I_MUTUAL_EXCLUSION             |
| `successful append after 412 with updated If-Match`       | I_412_USABLE, I_ATOMICITY      |
| `successful append returns ETag`                          | I_ETAG_ON_SUCCESS              |
| `chained CAS using ETag from success`                     | I_ETAG_ON_SUCCESS, I_ATOMICITY |
| `unquoted If-Match returns 412`                           | I_NO_WILDCARD (boundary)       |
