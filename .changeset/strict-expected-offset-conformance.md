---
"@durable-streams/server-conformance-tests": patch
---

Add an opt-in `strictAppend` option that runs conformance tests for the strict `Stream-Expected-Offset` compare-and-append extension: happy path, mismatch 409 with `Stream-Next-Offset`, producer-dedup precedence, `Stream-Seq` composition, closed-stream precedence, and fork isolation.
