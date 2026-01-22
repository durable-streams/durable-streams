---
"@durable-streams/state": patch
---

Increase default `awaitTxId` timeout from 5 seconds to 30 seconds to better handle complex sync scenarios like Electric's TopK/ORDER BY operations that can involve multiple data loading cycles.
