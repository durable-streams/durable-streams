---
'@durable-streams/server-conformance-tests': patch
'@durable-streams/server': patch
---

Expand server conformance test suite from ~515 to 1042 tests with property-based tests, exhaustive boundary tests, history-based invariant checking, and adversarial testing. Fix Stream-Closed header to use case-insensitive comparison per protocol §4.1. Add COVERAGE.md mapping 142 protocol requirements to tests.
