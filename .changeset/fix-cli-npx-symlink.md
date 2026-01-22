---
'@durable-streams/cli': patch
---

Fix CLI not running when invoked via npx by resolving symlinks in the isMainModule check.
