---
"@durable-streams/y-durable-streams": patch
---

Add service-scoped webhook subscriptions for `snapshot.available` events, backed by Durable Streams subscriptions over Yjs snapshot index streams. Isolate internal awareness bookkeeping from snapshot triggers and reject awareness names that could collide with reserved stream paths.
