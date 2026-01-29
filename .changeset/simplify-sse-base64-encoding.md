---
'@durable-streams/client': patch
'@durable-streams/server': patch
'@durable-streams/proxy': patch
'@durable-streams/y-durable-streams': patch
---

Remove `encoding` option from SSE reads. Servers now automatically base64-encode binary content types and signal this via the `Stream-SSE-Data-Encoding: base64` response header. Clients decode automatically when this header is present.
