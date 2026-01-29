# @durable-streams/proxy

## 0.1.1

### Patch Changes

- Add comprehensive SSE proxy e2e test suite covering data integrity, SSE format preservation, encoding, chunking, offset-based resumption, content-type handling, and edge cases. ([#233](https://github.com/durable-streams/durable-streams/pull/233))

- Remove `encoding` option from SSE reads. Servers now automatically base64-encode binary content types and signal this via the `Stream-SSE-Data-Encoding: base64` response header. Clients decode automatically when this header is present. ([#231](https://github.com/durable-streams/durable-streams/pull/231))

- Updated dependencies [[`5ceafb8`](https://github.com/durable-streams/durable-streams/commit/5ceafb896944e869f943f121dc9701c1aee4cb78), [`334a4fc`](https://github.com/durable-streams/durable-streams/commit/334a4fc80fc1483cebf9c0a02959f14875519a13), [`82a566a`](https://github.com/durable-streams/durable-streams/commit/82a566ace620b1b8d0d43cdf181356e6a6f6f4aa)]:
  - @durable-streams/client@0.2.1

## 0.1.0

### Minor Changes

- Bump all packages to version 0.2.0 ([#206](https://github.com/durable-streams/durable-streams/pull/206))

### Patch Changes

- Updated dependencies []:
  - @durable-streams/client@0.2.0

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
