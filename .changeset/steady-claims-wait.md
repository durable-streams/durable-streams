---
"@durable-streams/client": patch
"@durable-streams/server": patch
"@durable-streams/state": patch
---

Fix idempotent producer auto-claim sequencing so later batches wait for the
first running batch to claim its epoch before reserving and sending subsequent
sequence numbers. `flush()` now also waits for batches held behind the initial
auto-claim barrier.
