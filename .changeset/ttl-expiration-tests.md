---
"@durable-streams/server-conformance-tests": minor
"@durable-streams/server": minor
---

Add TTL expiration conformance tests and implement expiration in stores

- Add 7 new conformance tests verifying streams return 404 after TTL/Expires-At passes
- Add "recreate after expiry" test ensuring expired streams don't block new stream creation
- Add 4 new TTL format validation tests (leading zeros, plus sign, decimal, scientific notation)
- Implement expiration checking in both in-memory and file-backed stores
- Fix: expired streams no longer block PUT to recreate at same path
- Fix: malformed Expires-At dates now treated as expired (fail closed)
