---
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
"@durable-streams-internal/caddy-plugin": patch
---

Standardize HTTP status codes for protocol operations

- Append (POST): Now mandates `204 No Content` (previously allowed 200 or 204)
- Idempotent create (PUT): Now mandates `200 OK` (previously allowed 200 or 204)

This removes ambiguity from the protocol. Clients should already accept these status codes.
