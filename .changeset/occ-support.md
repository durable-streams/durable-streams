---
"@durable-streams/client": patch
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
"@durable-streams/client-conformance-tests": patch
---

Add Optimistic Concurrency Control (OCC) support via If-Match header

- Protocol: Add If-Match header support for append operations enabling clients to detect concurrent writes
- Servers: Implement 412 Precondition Failed response when ETag doesn't match
- Clients: Add ifMatch/if_match option to append methods with PreconditionFailedError for 412 responses
- Tests: Add server and client conformance tests for OCC behavior
