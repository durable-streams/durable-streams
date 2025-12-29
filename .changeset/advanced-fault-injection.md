---
"@durable-streams/server": minor
"@durable-streams/server-conformance-tests": minor
"@durable-streams/client-conformance-tests": minor
---

Add advanced fault injection and conformance tests

Server fault injection improvements:
- Extended fault injection with new capabilities: delayMs, dropConnection, truncateBodyBytes, probability, method filtering, corruptBody, and jitterMs
- Updated /_test/inject-error endpoint to accept all new fault parameters
- Added body modification support for response truncation and corruption

New server conformance tests:
- Concurrent writer stress tests (seq conflicts, racing writers, mixed readers/writers)
- State hash verification tests (replay consistency, deterministic ordering)

New client conformance tests:
- 8 fault injection test cases covering delay recovery, connection drops, method-specific faults, and retry scenarios
