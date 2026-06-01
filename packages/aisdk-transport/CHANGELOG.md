# @durable-streams/aisdk-transport

## 0.0.7

### Patch Changes

- Updated dependencies [[`92c0821`](https://github.com/durable-streams/durable-streams/commit/92c082152f7be8327f0c055d8b224494e5e71f76)]:
  - @durable-streams/client@0.2.6

## 0.0.6

### Patch Changes

- Updated dependencies [[`6afab5f`](https://github.com/durable-streams/durable-streams/commit/6afab5f8258999ff1794749ad9d0d9bd0c823625)]:
  - @durable-streams/client@0.2.5

## 0.0.5

### Patch Changes

- Engage client-side batching in AI SDK and TanStack AI transport response ([#356](https://github.com/durable-streams/durable-streams/pull/356))
  writers. The transports previously awaited every `stream.append(...)` call
  inside the source loop, which kept the client's internal batch queue idle
  and turned every chunk into its own POST. The writers now fire-and-track
  appends and drain pending writes before closing, restoring batching for
  high-frequency token streams. Documents the batching engagement contract
  on `DurableStream.append()` so library users don't reintroduce the pattern.

## 0.0.4

### Patch Changes

- docs(vercel-ai-sdk): inline read proxy, remove broken examples/ refs ([#337](https://github.com/durable-streams/durable-streams/pull/337))
  - Inline the full read proxy implementation (hop-by-hop header stripping,
    query-param forwarding, Authorization header injection) so agents don't
    need to follow `examples/chat-aisdk/...` references that don't ship in
    the npm package
  - Drop prose "Source: examples/chat-aisdk/..." lines that pointed at files
    only present in the monorepo, not in the published skill

- Updated dependencies [[`a3ed371`](https://github.com/durable-streams/durable-streams/commit/a3ed371a56b28ec6abc00ecdd149e2e030710cf6), [`346bc42`](https://github.com/durable-streams/durable-streams/commit/346bc426f5e13705cdd5e0cc5f7a759c7735a888)]:
  - @durable-streams/client@0.2.4

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
