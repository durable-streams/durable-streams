# @durable-streams/y-durable-streams

## 0.2.3

### Patch Changes

- Use consistent lib0 framing for awareness updates, matching document updates. Awareness data is now length-prefixed with lib0's `writeVarUint8Array` on send and decoded with `readVarUint8Array` on receive. ([#290](https://github.com/durable-streams/durable-streams/pull/290))

- Require explicit PUT for document creation, matching the base Durable Streams protocol. Documents and awareness streams are created together on PUT. POST to a non-existent document now returns 404 instead of auto-creating. The YjsProvider issues an idempotent PUT on connect, fixing a bug where read-only clients would poll 404s indefinitely on non-existent documents. ([#295](https://github.com/durable-streams/durable-streams/pull/295))

- Add Yjs document sync over Durable Streams with automatic server-side compaction and presence support. Includes YjsProvider (client) and YjsServer (protocol layer) that handle index, updates, snapshots, and awareness streams transparently. Initial sync fetches snapshot and updates in parallel for faster load times. ([#202](https://github.com/durable-streams/durable-streams/pull/202))

- Updated dependencies [[`5f50195`](https://github.com/durable-streams/durable-streams/commit/5f501950e7f9e3ffcd3c077b4ba90ce405d9f066)]:
  - @durable-streams/client@0.2.3

## 0.2.2

### Patch Changes

- Add TanStack Intent skills for AI coding agents. Skills cover getting started, reading streams, writing data, server deployment, go-to-production checklist, state schema, stream-db, and Yjs sync. Fix `live: "auto"` references in README to `live: true`. ([#270](https://github.com/durable-streams/durable-streams/pull/270))

- Updated dependencies [[`6d50b29`](https://github.com/durable-streams/durable-streams/commit/6d50b29b544a48cca161232d881a06b44cdebcb8), [`054de99`](https://github.com/durable-streams/durable-streams/commit/054de99b0a3b97009a55e94d6f829ef38b520d41), [`054de99`](https://github.com/durable-streams/durable-streams/commit/054de99b0a3b97009a55e94d6f829ef38b520d41)]:
  - @durable-streams/client@0.2.2

## 0.2.1

### Patch Changes

- Remove `encoding` option from SSE reads. Servers now automatically base64-encode binary content types and signal this via the `Stream-SSE-Data-Encoding: base64` response header. Clients decode automatically when this header is present. ([#231](https://github.com/durable-streams/durable-streams/pull/231))

- Updated dependencies [[`5ceafb8`](https://github.com/durable-streams/durable-streams/commit/5ceafb896944e869f943f121dc9701c1aee4cb78), [`334a4fc`](https://github.com/durable-streams/durable-streams/commit/334a4fc80fc1483cebf9c0a02959f14875519a13), [`82a566a`](https://github.com/durable-streams/durable-streams/commit/82a566ace620b1b8d0d43cdf181356e6a6f6f4aa)]:
  - @durable-streams/client@0.2.1

## 0.2.0

### Minor Changes

- Bump all packages to version 0.2.0 ([#206](https://github.com/durable-streams/durable-streams/pull/206))

### Patch Changes

- Updated dependencies []:
  - @durable-streams/client@0.2.0

## 0.1.4

### Patch Changes

- Updated dependencies [[`447e102`](https://github.com/durable-streams/durable-streams/commit/447e10235a1732ec24e1d906487d6b2750a16063), [`095944a`](https://github.com/durable-streams/durable-streams/commit/095944a5fefdef0cbc87eef532c871cdd46ee7d8), [`e47081e`](https://github.com/durable-streams/durable-streams/commit/e47081e553e1e98466bca25faf929ac346816e6b)]:
  - @durable-streams/client@0.2.0

## 0.1.3

### Patch Changes

- Use offset=now in presence stream ([#150](https://github.com/durable-streams/durable-streams/pull/150))

## 0.1.2

### Patch Changes

- Updated dependencies [[`a5ce923`](https://github.com/durable-streams/durable-streams/commit/a5ce923bf849bdde47a651be8200b560053f4997)]:
  - @durable-streams/client@0.1.5

## 0.1.1

### Patch Changes

- added y-durable-streams ([#81](https://github.com/durable-streams/durable-streams/pull/81))

- Updated dependencies [[`67b5a4d`](https://github.com/durable-streams/durable-streams/commit/67b5a4dcaae69dbe651dc6ede3cac72d3390567f)]:
  - @durable-streams/client@0.1.4
