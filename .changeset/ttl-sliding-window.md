---
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
---

feat: TTL sliding window renewal — Stream-TTL now resets on read and write, with conformance tests for expiration, renewal, and fork TTL behavior. Conformance tests hardened against timing flakiness (polling-based expiry checks, wider Expires-At windows, fast-check time limits).
