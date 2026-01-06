---
"@durable-streams/cli": patch
---

Add `--content-type` and `--json` flags to CLI write command. The CLI write command was missing Content-Type header support, causing 400 errors when writing to streams that require content-type validation. Also improved error handling to reject unknown flags instead of silently ignoring them.
