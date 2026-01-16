---
'@durable-streams/client': patch
---

Improve client API safety and flexibility:

- Refactor `writable()` to use `IdempotentProducer` for streaming writes with exactly-once semantics and automatic batching. Errors during writes now cause `pipeTo()` to reject instead of being silently swallowed.
- Make `StreamResponse.offset`, `cursor`, and `upToDate` readonly via getters to prevent external mutation of internal state.
- Allow subscriber callbacks (`subscribeJson`, `subscribeBytes`, `subscribeText`) to be sync or async (`void | Promise<void>`).
- Fix `warnOnHttp` not being called in standalone `stream()` function.
