---
"@durable-streams/client": patch
---

Fix producer flushing in browsers and other runtimes without Node.js `process` by replacing the `fastq` dependency with a built-in async queue.
