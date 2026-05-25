---
"@durable-streams/state": patch
---

feat(state): expose StreamDB offsets and subscription hooks

StreamDB can now reuse an existing DurableStream instance, expose the latest
consumed offset, and notify callers around JSON stream batches. Collection IDs
are scoped by stream URL to avoid cross-stream collisions, and live replayed
inserts are normalized to updates when they match existing rows.
