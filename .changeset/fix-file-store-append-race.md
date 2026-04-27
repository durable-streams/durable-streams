---
"@durable-streams/server": patch
---

fix(server): serialize concurrent appends to the same stream

Without per-stream serialization, the file-backed `append()` had a race
in the read-modify-write of `streamMeta.currentOffset`: two concurrent
appenders could read the same starting offset, both compute the same
`newOffset`, both write a frame to the segment file, and only one's
LMDB metadata update would win. The file then contained two frames at
positions past the LMDB-tracked `currentOffset`, so subsequent
`getTailOffset` lookups (and `stream-next-offset` headers) lagged the
actual stream contents — causing valid `done`-callback acks at offsets
that the server's stale tail had never seen to be rejected with
`INVALID_OFFSET`.

Reproduced with N concurrent appends to one stream collapsing to a
single offset value (added as a regression test in
`packages/server/test/file-backed.test.ts`). The fix wraps `append()`
in a per-stream lock (mirrors `acquireProducerLock`), so the
read-currentOffset → write-frame → fsync → put-LMDB sequence runs
atomically per stream.
