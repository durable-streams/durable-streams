---
"@durable-streams/client": patch
"durable-streams-client-py": patch
"durable-streams-client-go": patch
---

Fix SSE event field parsing to comply with spec

Per the SSE specification, parsers should strip only a single leading space
after the colon in field values, not all whitespace. This fixes the `event:`
field parsing in all three client implementations to use the same correct
behavior already used for `data:` fields.
