# Proxy Conformance Tests

This directory contains reusable conformance tests for proxy server implementations.

## Programmatic usage

```ts
import { runProxyConformanceTests } from "@durable-streams/proxy/conformance-tests"

runProxyConformanceTests({
  baseUrl: "https://proxy.example.com",
})
```

## CLI usage

```bash
npx durable-streams-proxy-conformance --run https://proxy.example.com
```

## Adapter options

`runProxyConformanceTests` accepts adapters for implementations with different
route/auth shapes:

- `adapter.createUrl(baseUrl)`
- `adapter.streamUrl(baseUrl, streamId)`
- `adapter.connectUrl(baseUrl, streamId)`
- `adapter.applyServiceAuth(url, headers)`
- `adapter.normalizeLocation(location, baseUrl)`

Use `capabilities` to disable optional protocol surfaces when validating partial
implementations:

- `connect`
- `targetedAbort`
- `framing`
