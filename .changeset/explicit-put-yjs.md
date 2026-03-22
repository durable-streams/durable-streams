---
"@durable-streams/y-durable-streams": patch
---

Require explicit PUT for document creation, matching the base Durable Streams protocol. Documents and awareness streams are created together on PUT. POST to a non-existent document now returns 404 instead of auto-creating. The YjsProvider issues an idempotent PUT on connect, fixing a bug where read-only clients would poll 404s indefinitely on non-existent documents.
