---
'@durable-streams/cli': patch
---

Allow slash-delimited stream IDs in CLI commands. Stream IDs like `org/project/stream` are now parsed correctly instead of being rejected or misinterpreted.
