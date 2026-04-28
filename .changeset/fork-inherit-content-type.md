---
"@durable-streams/server": patch
"@durable-streams/server-conformance-tests": patch
---

fix(server): fork PUT inherits source content type when Content-Type header is omitted

Per the protocol (Section 4.2), when forking a stream the `Content-Type` header is
optional — an omitted header means "inherit from source." The TS dev server was
defaulting empty Content-Type to `application/octet-stream` before the store could
inherit, causing fork creation to fail with `409 Conflict` (content-type mismatch)
whenever the source's content type differed from the default.

Adds a server conformance test (`Fork - Creation > should fork inheriting
content-type when header omitted`) that exercises this behavior end-to-end:
fork response, HEAD, and a follow-up POST with the inherited content type.
