---
"@durable-streams/state": patch
"@durable-streams/server-conformance-tests": patch
---

Increase default timeouts to better handle complex sync scenarios:

- `@durable-streams/state`: `awaitTxId` default timeout increased from 5s to 30s
- `@durable-streams/server-conformance-tests`: long-poll test timeout increased from 20s to 30s, SSE fetch timeout increased from 2s to 30s
