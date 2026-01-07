---
"@durable-streams/cli": patch
---

Add JSON support to CLI write command with two modes:

- `--json`: Write JSON input as a single message
- `--batch-json`: Write JSON array input as multiple messages (each element stored separately)

Also improved error handling to reject unknown flags.
