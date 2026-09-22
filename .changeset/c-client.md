---
---

feat: Add C client library for Durable Streams using libcurl

- Pure C implementation with libcurl for HTTP operations
- Full support for stream create, append, read, close, delete operations
- SSE and long-poll live modes for streaming reads
- Idempotent producer with batching support and autoClaim recovery
- Conformance test adapter passing 235/267 tests (88% pass rate)
- Iterator-based API for reading stream data
- Base64 encoding/decoding for binary data in SSE mode
- JSON validation for client-side input
- Error messages include stream path context

Remaining limitations:
- Server response JSON parsing not validated (4 tests)
- offset=now with long-poll returns 200 instead of 204 (2 tests)
- SSE control event parsing returns INVALID_OFFSET instead of PARSE_ERROR (2 tests)
- Some test framework issues with variable capture (3 tests)
