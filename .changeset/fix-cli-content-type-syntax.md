---
"@durable-streams/cli": patch
---

Add support for `--flag=value` syntax for all CLI flags that take values (`--url`, `--auth`, `--content-type`). Previously only the space-separated syntax (`--flag value`) was supported, causing the `=` syntax to be silently ignored. Also improves error messages when command-specific flags like `--content-type` are placed before the command instead of after.
