---
"@durable-streams/client": patch
---

Refactor StreamResponseImpl to use an immutable state machine for sync state (offset, cursor, upToDate, streamClosed).
