---
"@durable-streams/server-cloudflare": patch
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
---

Close-only POSTs (empty body with `Stream-Closed: true`) now refresh the sliding TTL like any other write, and CORS preflight responses allow the `If-None-Match` header for conditional cross-origin reads. Covered by new shared conformance tests.
