---
"@durable-streams/y-durable-streams": patch
---

Fix `YjsProvider` silently dropping edits across a reconnect. Each connection now uses a fresh producer epoch, so the server no longer dedupes the reconnected writer's updates, and on initial sync the provider pushes any local state the server is missing (edits made while disconnected, lost batches, state hydrated from local persistence) before reporting `synced`.
