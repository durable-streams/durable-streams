---
name: "Feature: Stream-Allowed-Origins header for CSRF protection"
about: Add Origin header validation to protect SSE endpoints from CSRF attacks
title: "Add Stream-Allowed-Origins header for CSRF protection on SSE endpoints"
labels: enhancement, security
---

## Summary

SSE connections are vulnerable to CSRF attacks because they use GET requests and browsers will include cookies on cross-origin requests. An attacker's page can establish an SSE connection to steal a user's private stream data.

## Proposed Solution

Add a `Stream-Allowed-Origins` header that can be specified at stream creation time to restrict which origins can access the stream.

### Stream Creation

```http
PUT /v1/stream/my-stream
Content-Type: application/json
Stream-Allowed-Origins: https://app.example.com, https://admin.example.com
```

Special values:

- `same-origin` - Only allow requests from the same origin as the Host header
- `*` - Allow any origin (public stream)
- Comma-separated list - Allow specific origins

### Enforcement

On GET requests (especially SSE mode), the server checks the `Origin` header against the stored allowed origins:

| `Stream-Allowed-Origins` | `Origin` Header    | Result                                        |
| ------------------------ | ------------------ | --------------------------------------------- |
| Not set                  | Any                | ✅ Allowed (backwards compatible)             |
| `*`                      | Any                | ✅ Allowed                                    |
| `same-origin`            | Same as Host       | ✅ Allowed                                    |
| `same-origin`            | Different          | ❌ 403 Forbidden                              |
| `https://app.com`        | `https://app.com`  | ✅ Allowed                                    |
| `https://app.com`        | `https://evil.com` | ❌ 403 Forbidden                              |
| Any                      | None (non-browser) | ✅ Allowed (use auth for non-browser clients) |

### Why Per-Stream?

Different streams might have different trust levels:

- Public event feeds → `*`
- User-specific data → `same-origin` or explicit whitelist
- Internal APIs → specific origins only

This makes the security policy part of the stream's contract, explicit and auditable.

## Implementation Scope

1. Add `Stream-Allowed-Origins` header parsing to stream creation (PUT)
2. Store allowed origins in stream metadata
3. Check Origin header on GET requests, return 403 if not allowed
4. Update PROTOCOL.md security considerations section
5. Add server conformance tests
6. Update TypeScript and Go server implementations

## Related Security Research

- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [SSE Security Concerns](https://www.hahwul.com/sec/web-security/sse/)
- DNS rebinding attacks on SSE (led MCP to deprecate SSE in favor of Streamable HTTP)
