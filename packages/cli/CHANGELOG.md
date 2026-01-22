# @durable-streams/cli

## 0.1.9

### Patch Changes

- Fix CLI not running when invoked via npx by resolving symlinks in the isMainModule check. ([#194](https://github.com/durable-streams/durable-streams/pull/194))

## 0.1.8

### Patch Changes

- Add `--url` flag to override STREAM_URL environment variable and `--help`/`-h` flags for usage information. Improve validation with helpful error messages for URLs, auth headers, and stream IDs. Enhance success/error messages with better formatting including byte counts and HTTP status codes. ([#192](https://github.com/durable-streams/durable-streams/pull/192))

- Updated dependencies [[`447e102`](https://github.com/durable-streams/durable-streams/commit/447e10235a1732ec24e1d906487d6b2750a16063), [`095944a`](https://github.com/durable-streams/durable-streams/commit/095944a5fefdef0cbc87eef532c871cdd46ee7d8), [`e47081e`](https://github.com/durable-streams/durable-streams/commit/e47081e553e1e98466bca25faf929ac346816e6b)]:
  - @durable-streams/client@0.2.0

## 0.1.7

### Patch Changes

- Add authentication support via `--auth` flag and `STREAM_AUTH` environment variable ([#189](https://github.com/durable-streams/durable-streams/pull/189))

## 0.1.6

### Patch Changes

- Updated dependencies [[`a5ce923`](https://github.com/durable-streams/durable-streams/commit/a5ce923bf849bdde47a651be8200b560053f4997)]:
  - @durable-streams/client@0.1.5

## 0.1.5

### Patch Changes

- Add JSON support to CLI write command with two modes: ([#144](https://github.com/durable-streams/durable-streams/pull/144))
  - `--json`: Write JSON input as a single message
  - `--batch-json`: Write JSON array input as multiple messages (each element stored separately)

  Also improved error handling to reject unknown flags.

- Updated dependencies [[`67b5a4d`](https://github.com/durable-streams/durable-streams/commit/67b5a4dcaae69dbe651dc6ede3cac72d3390567f)]:
  - @durable-streams/client@0.1.4

## 0.1.4

### Patch Changes

- Add `--content-type` and `--json` flags to CLI write command. The CLI write command was missing Content-Type header support, causing 400 errors when writing to streams that require content-type validation. Also improved error handling to reject unknown flags instead of silently ignoring them. ([#130](https://github.com/durable-streams/durable-streams/pull/130))

- Updated dependencies [[`8d06625`](https://github.com/durable-streams/durable-streams/commit/8d06625eba26d79b7c5d317adf89047f6b44c8ce), [`8f500cf`](https://github.com/durable-streams/durable-streams/commit/8f500cf720e59ada83188ed67f244a40c4b04422)]:
  - @durable-streams/client@0.1.3

## 0.1.3

### Patch Changes

- Fix npx executable discovery for all CLI packages. When running `npx @durable-streams/<package>`, npm now correctly finds the executable. Also fixes vitest binary path resolution in server-conformance-tests for scoped packages installed via npx. ([#103](https://github.com/durable-streams/durable-streams/pull/103))

## 0.1.2

### Patch Changes

- Standardize package.json exports across all packages ([`bf9bc19`](https://github.com/durable-streams/durable-streams/commit/bf9bc19ef13eb22b2c0f98a175fad02b221d7860))
  - Add dual ESM/CJS exports to all packages
  - Fix export order to have "." first, then "./package.json"
  - Add proper main/module/types fields
  - Add sideEffects: false
  - Remove duplicate fields

- Updated dependencies [[`bf9bc19`](https://github.com/durable-streams/durable-streams/commit/bf9bc19ef13eb22b2c0f98a175fad02b221d7860)]:
  - @durable-streams/client@0.1.2

## 0.1.1

### Patch Changes

- new version to fix local manual release ([#97](https://github.com/durable-streams/durable-streams/pull/97))

- Updated dependencies [[`1873789`](https://github.com/durable-streams/durable-streams/commit/187378923ed743255ba741252b1617b13cbbab16)]:
  - @durable-streams/client@0.1.1
