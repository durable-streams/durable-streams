---
"@durable-streams/proxy": patch
---

Implement RFC v1.1 proxy protocol with pre-signed URLs

- Server now auto-generates UUIDv7 stream IDs instead of accepting client-provided keys
- POST endpoint uses headers (Upstream-URL, Upstream-Method, Upstream-Authorization) instead of query params
- Returns 201 with Location header containing pre-signed URL
- Authentication uses HMAC-SHA256 pre-signed URLs (expires/signature params) instead of JWT Bearer tokens
- Abort endpoint changed from POST to PATCH with ?action=abort query param
- Added DELETE endpoint with service token authentication
- Client library updated to store streamId/expires/signature instead of path/readToken
