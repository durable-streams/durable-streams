---
---

feat: Add C client library for Durable Streams using libcurl

- Pure C implementation with libcurl for HTTP operations
- Full support for stream create, append, read, close, delete operations
- SSE and long-poll live modes for streaming reads
- Idempotent producer with batching support
- Conformance test adapter passing 220/267 tests (82% pass rate)
- Iterator-based API for reading stream data
- Base64 encoding/decoding for binary data in SSE mode

Known limitations:
- SSE live streaming doesn't receive new data after initial catchup
- JSON validation not implemented (accepts malformed JSON)
- autoClaim recovery doesn't re-send failed batches
- Error messages don't include stream path context
