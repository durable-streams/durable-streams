---
'@durable-streams/server-conformance-tests': patch
---

Add 7 concurrent readers to byte-exactness property tests to help detect race conditions in server implementations. All readers verify they receive byte-identical content.
