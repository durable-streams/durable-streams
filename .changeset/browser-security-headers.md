---
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
---

Add browser security headers per Protocol Section 10.7:
- `X-Content-Type-Options: nosniff` on all responses
- `Cross-Origin-Resource-Policy: cross-origin` on all responses
- `Cache-Control: no-store` on HEAD responses

Includes conformance tests for security header presence on GET, PUT, POST, HEAD, SSE, long-poll, and error responses.
