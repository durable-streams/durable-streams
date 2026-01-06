---
"@durable-streams/client": patch
"@durable-streams/server-conformance-tests": patch
---

Add CRLF injection security tests for SSE and fix TypeScript client SSE parser to normalize line endings per SSE spec.

- Server conformance tests now verify CRLF injection attacks in SSE payloads are properly escaped
- TypeScript SSE parser now normalizes `\r\n` and lone `\r` to `\n` per SSE specification
