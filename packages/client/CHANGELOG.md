# @durable-streams/client

## 0.1.3

### Patch Changes

- Add console warning when using HTTP URLs in browser environments. HTTP limits browsers to 6 concurrent connections per host (HTTP/1.1), which can cause slow streams and app freezes. The warning can be disabled with `warnOnHttp: false`. ([#126](https://github.com/durable-streams/durable-streams/pull/126))

- Add CRLF injection security tests for SSE and fix TypeScript client SSE parser to normalize line endings per SSE spec. ([#112](https://github.com/durable-streams/durable-streams/pull/112))
  - Server conformance tests now verify CRLF injection attacks in SSE payloads are properly escaped
  - TypeScript SSE parser now normalizes `\r\n` and lone `\r` to `\n` per SSE specification

## 0.1.2

### Patch Changes

- Standardize package.json exports across all packages ([`bf9bc19`](https://github.com/durable-streams/durable-streams/commit/bf9bc19ef13eb22b2c0f98a175fad02b221d7860))
  - Add dual ESM/CJS exports to all packages
  - Fix export order to have "." first, then "./package.json"
  - Add proper main/module/types fields
  - Add sideEffects: false
  - Remove duplicate fields

## 0.1.1

### Patch Changes

- new version to fix local manual release ([#97](https://github.com/durable-streams/durable-streams/pull/97))
