---
"@durable-streams/client": patch
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
"@durable-streams/client-conformance-tests": patch
---

Add Optimistic Concurrency Control (OCC) support via If-Match header

- Protocol: `If-Match` header on append for compare-and-swap semantics, `ETag` on 204 success for chained CAS
- Servers: Atomic CAS under store-level lock (no TOCTOU race), error precedence (404 → 409 closed → 409 content-type → 412), `ETag` in success response
- Clients (all 10): `ifMatch`/`if_match` append option, `PreconditionFailedError` for 412 responses
- Conformance tests: 7 client YAML tests + 5 server tests covering matching, stale, wildcard rejection, chained CAS, malformed values, and error precedence
- Spec: Formal OCC specification (OCC_SPEC.md) with invariants, affordances, and conformance test mapping
