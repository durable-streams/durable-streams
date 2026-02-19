---
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
---

Add webhook subscriptions for push-based event delivery. Subscriptions map glob patterns to webhook URLs, spawning consumer instances that track offsets across streams with epoch fencing, wake ID claims, and a scoped callback API. Includes TLA+-inspired temporal property checkers and ENABLED predicates in the conformance test DSL.
