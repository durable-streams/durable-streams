# @durable-streams/conformance-tests

Protocol compliance test suite for Durable Streams server implementations.

This package provides a comprehensive test suite to verify that a server correctly implements the [Durable Streams protocol](../../PROTOCOL.md).

## Installation

```bash
npm install @durable-streams/conformance-tests
# or
pnpm add @durable-streams/conformance-tests
```

## CLI Usage

The easiest way to run conformance tests against your server:

### Run Once (CI)

```bash
npx @durable-streams/conformance-tests --run http://localhost:4437
```

### Watch Mode (Development)

Watch source files and automatically rerun tests when changes are detected:

```bash
npx @durable-streams/conformance-tests --watch src http://localhost:4437

# Watch multiple directories
npx @durable-streams/conformance-tests --watch src lib http://localhost:4437
```

### CLI Options

```
Usage:
  npx @durable-streams/conformance-tests --run <url>
  npx @durable-streams/conformance-tests --watch <path> [path...] <url>

Options:
  --run              Run tests once and exit (for CI)
  --watch <paths>    Watch source paths and rerun tests on changes (for development)
  --help, -h         Show help message

Arguments:
  <url>              Base URL of the Durable Streams server to test against
```

## Programmatic Usage

You can also run the conformance tests programmatically within your own test suite:

```typescript
import { runConformanceTests } from "@durable-streams/conformance-tests"

// In your test file (e.g., with vitest)
describe("My Server Implementation", () => {
  const config = { baseUrl: "" }

  beforeAll(async () => {
    // Start your server
    const server = await startMyServer({ port: 0 })
    config.baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  // Run all conformance tests
  runConformanceTests(config)
})
```

## CI Integration

Add conformance tests to your CI pipeline:

```yaml
# GitHub Actions example
jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install dependencies
        run: npm install

      - name: Start server
        run: npm run start:server &

      - name: Wait for server
        run: npx wait-on http://localhost:4437

      - name: Run conformance tests
        run: npx @durable-streams/conformance-tests --run http://localhost:4437
```

## Test Coverage

The conformance test suite covers:

- **Basic Stream Operations** - Create, delete, idempotent operations
- **Append Operations** - String data, chunking, sequence ordering
- **Read Operations** - Empty/full streams, offset reads
- **Long-Poll Operations** - Data waiting, immediate returns
- **HTTP Protocol** - Headers, status codes, content negotiation
- **TTL and Expiry** - TTL/Expires-At handling
- **Case-Insensitivity** - Content-type, header casing
- **Content-Type Validation** - Match enforcement
- **HEAD Metadata** - Metadata-only responses
- **Offset Validation** - Malformed offsets, resumable reads
- **Protocol Edge Cases** - Empty bodies, binary data, monotonic progression
- **Byte-Exactness** - Data integrity guarantees
- **Caching and ETag** - ETag and 304 responses
- **Chunking and Large Payloads** - Pagination, large files
- **Property-Based Fuzzing** - Random append/read sequences
- **Malformed Input Fuzzing** - Security-focused tests
- **Read-Your-Writes Consistency** - Immediate visibility after writes
- **SSE Mode** - Server-sent events streaming
- **JSON Mode** - JSON serialization and batching

## License

Apache 2.0
