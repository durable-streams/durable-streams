---
"@durable-streams/client": patch
---

Fix FetchError.fromResponse() and DurableStreamError.fromResponse() failing on HEAD responses with null body, which caused infinite retries in the backoff wrapper
