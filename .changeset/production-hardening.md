---
'@durable-streams/client': patch
---

Add production hardening features ported from Electric's TypeScript client: 7-state machine (InitialState, SyncingState, StaleRetryState, LiveState, ReplayingState, PausedState, ErrorState), PauseLock for multi-reason pause coordination, system wake detection, fast-loop detection with CDN cache busting, resumable mid-stream error recovery via ErrorState/onError, response header validation middleware (MissingHeadersError), split chunk/SSE fetch clients, replay mode with pluggable UpToDateTracker, and chunk prefetching. Backoff defaults aligned to industry standards (1s/2x/32s). Includes formal SPEC.md with truth table, testing DSL, and 498 tests.
