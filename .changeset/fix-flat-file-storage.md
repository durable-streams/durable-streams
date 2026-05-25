---
"@durable-streams/server": patch
---

fix(server): flatten file-backed stream storage

The file-backed store now uses one segment log file per stream instead of a
nested per-stream directory, keeps offsets aligned to the actual frame layout,
and tightens crash recovery around truncated frames.

This also adds focused read/create microbench scripts for evaluating the file
store path and restores the server package typecheck configuration.
