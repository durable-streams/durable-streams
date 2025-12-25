---
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
---

Enforce 204 No Content for append responses

The protocol now mandates `204 No Content` for successful append operations,
removing the previous allowance for `200 OK`. This is a breaking change for
servers that returned 200, but clients should already accept both status codes.
