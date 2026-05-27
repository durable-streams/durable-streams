---
"@durable-streams/client": patch
"@durable-streams/server": patch
---

Restore the TypeScript client surface expected by Durable Streams consumers:
publish the SSE control-event constants from the package entrypoint and expose
`IdempotentProducer.lastSuccessfulOffset` after successful writes or closes.

Republish the server against the fixed client package so `DurableStreamTestServer`
can import the SSE constants from `@durable-streams/client`.
