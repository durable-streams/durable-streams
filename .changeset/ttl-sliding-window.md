---
"@durable-streams/server": minor
"@durable-streams/server-conformance-tests": minor
---

feat: TTL sliding window renewal — Stream-TTL now resets on read and write, with conformance tests for expiration, renewal, and fork TTL behavior. Conformance tests hardened against timing flakiness (polling-based expiry checks, wider Expires-At windows, fast-check time limits).
