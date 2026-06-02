---
"@durable-streams/server-conformance-tests": patch
"@durable-streams/server": patch
---

fix: close conformance gaps around soft-delete, fork content-type, and live SSE closure

Server conformance tests:

- Add a test asserting a live SSE reader caught up at the tail receives
  data appended atomically with a stream close (POST + `Stream-Closed`)
  before the closing control event. A server that emits the
  `streamClosed` control without first delivering the final append
  silently loses the last message; the test probes a spread of close
  timings to catch the race deterministically.
- Add a test asserting a fork rejected for a content-type mismatch does
  not leak a reference on the source (the source must still fully delete
  rather than being pinned in a soft-deleted state).

Reference server:

- Fix a reference-count leak in both the in-memory and file-backed
  stores: a fork rejected for a content-type mismatch incremented the
  source's `refCount` before validating the content type, pinning the
  source in a soft-deleted state forever. Content-type is now validated
  before the reference is taken.
