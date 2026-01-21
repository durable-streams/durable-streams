# @durable-streams/proxy

## 0.0.3

### Patch Changes

- Updated dependencies [[`447e102`](https://github.com/durable-streams/durable-streams/commit/447e10235a1732ec24e1d906487d6b2750a16063), [`095944a`](https://github.com/durable-streams/durable-streams/commit/095944a5fefdef0cbc87eef532c871cdd46ee7d8), [`e47081e`](https://github.com/durable-streams/durable-streams/commit/e47081e553e1e98466bca25faf929ac346816e6b)]:
  - @durable-streams/client@0.2.0

## 0.0.2

### Patch Changes

- Add new proxy package for durable AI streaming. Includes: ([#179](https://github.com/durable-streams/durable-streams/pull/179))
  - Proxy server with endpoints for creating, reading, and aborting streams
  - Client-side `createDurableFetch` wrapper with credential persistence and auto-resume
  - AI SDK transports for Vercel AI SDK (`createDurableChatTransport`) and TanStack (`createDurableAdapter`)
  - JWT-based read token authentication
  - URL allowlist with glob pattern support and URL normalization
  - Security hardening: SSRF redirect blocking, path traversal prevention, scoped storage keys
  - Comprehensive README with full API documentation
  - 70 conformance and integration tests with external server support (PROXY_CONFORMANCE_URL)
