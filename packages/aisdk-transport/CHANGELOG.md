# @durable-streams/aisdk-transport

## 0.0.4

### Patch Changes

- docs(vercel-ai-sdk): inline read proxy, remove broken examples/ refs ([#337](https://github.com/durable-streams/durable-streams/pull/337))
  - Inline the full read proxy implementation (hop-by-hop header stripping,
    query-param forwarding, Authorization header injection) so agents don't
    need to follow `examples/chat-aisdk/...` references that don't ship in
    the npm package
  - Drop prose "Source: examples/chat-aisdk/..." lines that pointed at files
    only present in the monorepo, not in the published skill

## 0.0.3

### Patch Changes

- Move "ai" package from dependency to peer dependency (^6.0.0) ([#303](https://github.com/durable-streams/durable-streams/pull/303))

- Add AI agent skills and intent CLI bin entry ([#331](https://github.com/durable-streams/durable-streams/pull/331))

- Updated dependencies []:
  - @durable-streams/client@0.2.3

## 0.0.2

### Patch Changes

- fix: include aisdk-transport in version bump changeset ([#302](https://github.com/durable-streams/durable-streams/pull/302))

## 0.0.1

### Patch Changes

- Updated dependencies [[`5f50195`](https://github.com/durable-streams/durable-streams/commit/5f501950e7f9e3ffcd3c077b4ba90ce405d9f066)]:
  - @durable-streams/client@0.2.3
