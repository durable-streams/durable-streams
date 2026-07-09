---
'@durable-streams/client-py': patch
---

Validate missing `Stream-Cursor` on explicit live Python stream responses even when the initial catch-up request omits the `live` query parameter for cacheability.
