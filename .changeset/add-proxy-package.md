---
'@durable-streams/proxy': patch
---

Add new proxy package for durable AI streaming. Includes:
- Proxy server with endpoints for creating, reading, and aborting streams
- Client-side `createDurableFetch` wrapper with credential persistence and auto-resume
- AI SDK transports for Vercel AI SDK (`createDurableChatTransport`) and TanStack (`createDurableAdapter`)
- JWT-based read token authentication
- URL allowlist with glob pattern support and URL normalization
- Security hardening: SSRF redirect blocking, path traversal prevention, scoped storage keys
- Comprehensive README with full API documentation
- 70 conformance and integration tests with external server support (PROXY_CONFORMANCE_URL)
