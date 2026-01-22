---
"@durable-streams/cli": patch
---

Fix `--content-type` and `--json` flags not being respected on `create` command. Previously, creating a stream always used `application/octet-stream` regardless of the content-type flag provided.
