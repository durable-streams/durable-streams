---
"@durable-streams/state": minor
"@durable-streams/client": minor
---

Add first-class live mode configuration to `createStreamDB()` so callers can force `"sse"` or `"long-poll"`, and add `headers` to `IdempotentProducerOptions` for producer batch and close requests.
