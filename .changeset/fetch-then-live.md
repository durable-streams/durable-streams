---
"@durable-streams/client": patch
"@durable-streams/client-conformance-tests": patch
---

Implement fetch-then-live pattern: initial requests omit the `live` query parameter so catch-up responses are cacheable by CDNs and browsers. Live mode (long-poll or SSE) activates only after the client reaches up-to-date.

For SSE mode, a dedicated `startSSE` path opens a persistent connection only after HTTP catch-up completes, replacing the previous single-connection approach.
