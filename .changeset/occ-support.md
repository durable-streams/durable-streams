---
"@durable-streams/client": patch
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
"@durable-streams/client-conformance-tests": patch
---

Add Optimistic Concurrency Control (OCC) support via If-Match header

- Protocol: Add `If-Match` header for append operations enabling compare-and-swap semantics
- Servers: Implement atomic CAS with `412 Precondition Failed` when ETag doesn't match, proper error precedence (409 closure > 412 precondition), `ETag` on 204 success for chained CAS
- Clients: Add `ifMatch`/`if_match` option to append methods with `PreconditionFailedError` for 412 responses
- Tests: Server and client conformance tests covering matching, stale, wildcard rejection, chained CAS, error precedence, and malformed values
- Spec: Formal OCC specification (OCC_SPEC.md) with invariants, affordances, and conformance test mapping
