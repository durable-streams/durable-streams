---
"@durable-streams/client-conformance-tests": patch
---

Escape Unicode line separator characters in the JSONL adapter protocol so Node 24 readline does not split conformance test commands mid-payload.
