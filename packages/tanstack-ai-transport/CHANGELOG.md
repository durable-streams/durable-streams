# @durable-streams/tanstack-ai-transport

## 0.0.8

### Patch Changes

- Updated dependencies [[`92c0821`](https://github.com/durable-streams/durable-streams/commit/92c082152f7be8327f0c055d8b224494e5e71f76)]:
  - @durable-streams/client@0.2.6

## 0.0.7

### Patch Changes

- Updated dependencies [[`6afab5f`](https://github.com/durable-streams/durable-streams/commit/6afab5f8258999ff1794749ad9d0d9bd0c823625)]:
  - @durable-streams/client@0.2.5

## 0.0.6

### Patch Changes

- Engage client-side batching in AI SDK and TanStack AI transport response ([#356](https://github.com/durable-streams/durable-streams/pull/356))
  writers. The transports previously awaited every `stream.append(...)` call
  inside the source loop, which kept the client's internal batch queue idle
  and turned every chunk into its own POST. The writers now fire-and-track
  appends and drain pending writes before closing, restoring batching for
  high-frequency token streams. Documents the batching engagement contract
  on `DurableStream.append()` so library users don't reintroduce the pattern.

## 0.0.5

### Patch Changes

- docs(tanstack-ai): headers on connection, full read proxy, auth separation ([#337](https://github.com/durable-streams/durable-streams/pull/337))
  - Document that custom headers (API keys) go on `durableStreamConnection`, not `useChat`
  - Add full inline read proxy implementation (was "see examples/" which agents can't access)
  - Separate DS auth from AI auth with clear table
  - Add user-supplied API key pattern for apps with settings UI
  - Recommend query params over dynamic route segments for chat id

- Updated dependencies [[`a3ed371`](https://github.com/durable-streams/durable-streams/commit/a3ed371a56b28ec6abc00ecdd149e2e030710cf6), [`346bc42`](https://github.com/durable-streams/durable-streams/commit/346bc426f5e13705cdd5e0cc5f7a759c7735a888)]:
  - @durable-streams/client@0.2.4

## 0.0.4

### Patch Changes

- docs(tanstack-ai): show anthropicText adapter, warn against raw SDK usage ([#333](https://github.com/durable-streams/durable-streams/pull/333))

  Updated the skill to use `anthropicText` from `@tanstack/ai-anthropic` as the primary example instead of `openaiText`. Added explicit warning against calling LLM SDKs directly — agents were bypassing the adapter and getting 400 errors from message format mismatches.

- Updated dependencies []:
  - @durable-streams/client@0.2.3

## 0.0.3

### Patch Changes

- Add AI agent skills and intent CLI bin entry ([#331](https://github.com/durable-streams/durable-streams/pull/331))

- Updated dependencies []:
  - @durable-streams/client@0.2.3

## 0.0.2

### Patch Changes

- fix: wrong client version in published package.json ([#299](https://github.com/durable-streams/durable-streams/pull/299))

## 0.0.1

### Patch Changes

- Updated dependencies [[`5f50195`](https://github.com/durable-streams/durable-streams/commit/5f501950e7f9e3ffcd3c077b4ba90ce405d9f066)]:
  - @durable-streams/client@0.2.3
