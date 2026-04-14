---
"@durable-streams/server": patch
---

fix(server): serialize file-backed appends per stream

File-backed streams could lose track of the latest logical tail when two append requests hit the same stream at the same time without producer headers. The bytes were written to disk, but stale metadata could leave `currentOffset` behind the real file tail, which caused live readers to treat newer updates as already caught up until a restart or recovery reconciled the offsets.
