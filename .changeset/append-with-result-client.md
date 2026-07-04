---
"@durable-streams/client": patch
---

Add `DurableStream.appendWithResult()`: a single POST carrying `Stream-Seq`, `Stream-Expected-Offset` and/or idempotent producer headers that returns a typed discriminated `AppendResult` (`ok` / `seq-conflict` / `closed` / `stale-epoch` / `producer-gap`) instead of throwing on protocol-level write conflicts. Also export the `Stream-Expected-Offset` constant and the fork header constants (`Stream-Forked-From`, `Stream-Fork-Offset`, `Stream-Fork-Sub-Offset`). No breaking changes to existing APIs.
