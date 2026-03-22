---
'@durable-streams/y-durable-streams': patch
---

Add Yjs document sync over Durable Streams with automatic server-side compaction and presence support. Includes YjsProvider (client) and YjsServer (protocol layer) that handle index, updates, snapshots, and awareness streams transparently. Initial sync fetches snapshot and updates in parallel for faster load times.
