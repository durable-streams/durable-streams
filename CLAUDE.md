# Claude Development Guidelines

## Changesets

All packages are pre-1.0. Use `patch` for changesets, not `minor`, unless it's a breaking change.

## Repository Overview

Durable Streams is a protocol and set of implementations for persistent, resumable event streams over HTTP. Think "append-only log as a service" with exactly-once semantics via idempotent producers.

### Key Files

- `PROTOCOL.md` - The protocol specification (source of truth)
- `README.md` - User-facing documentation
- `packages/` - All implementations live here

### Package Structure

| Package                    | Language   | Description                             |
| -------------------------- | ---------- | --------------------------------------- |
| `client`                   | TypeScript | Reference client library                |
| `client-py`                | Python     | Python client library                   |
| `client-go`                | Go         | Go client library                       |
| `client-elixir`            | Elixir     | Elixir client library                   |
| `client-dotnet`            | C#/.NET    | .NET client library                     |
| `client-swift`             | Swift      | Swift client library                    |
| `client-php`               | PHP        | PHP client library                      |
| `client-java`              | Java       | Java client library                     |
| `client-rust`              | Rust       | Rust client library                     |
| `client-rb`                | Ruby       | Ruby client library                     |
| `caddy-plugin`             | Go         | Production server (Caddy plugin)        |
| `server`                   | TypeScript | Development server (not for production) |
| `client-conformance-tests` | TypeScript | Cross-language client test suite        |
| `server-conformance-tests` | TypeScript | Server protocol compliance tests        |
| `cli`                      | TypeScript | Command-line tools                      |
| `benchmarks`               | TypeScript | Performance benchmarks                  |

### Common Commands

```bash
# Install dependencies
pnpm install

# Run all conformance tests (starts server automatically)
pnpm test:run

# Run specific client's conformance tests
pnpm test:run -- --client typescript
pnpm test:run -- --client python
pnpm test:run -- --client go

# Run just the server conformance tests
pnpm vitest run --project server

# Run a specific server test file
pnpm vitest run --project server packages/server/test/conformance.test.ts

# Run Go tests directly
cd packages/caddy-plugin && go test ./...

# Build everything
pnpm build
```

### Architecture

```
Client (TS/Python/Go/Elixir/.NET/Swift/PHP/Java/Rust/Ruby)
        │
        ▼ HTTP
┌───────────────────┐
│   Caddy Server    │
│  (caddy-plugin)   │
├───────────────────┤
│   Store Layer     │
│  ┌─────┬────────┐ │
│  │Memory│ File  │ │
│  │Store │ Store │ │
│  └─────┴────────┘ │
└───────────────────┘
```

- **Idempotent Producers**: Clients use `(producerId, epoch, seq)` headers for exactly-once writes
- **Live Modes**: Long-poll and SSE for real-time updates
- **JSON Mode**: Native array handling with automatic flattening

---

## Testing Philosophy

### Prefer Conformance Tests Over Unit Tests

When adding new functionality or fixing bugs, **always prefer server or client conformance tests** over per-client unit tests:

1. **Server Conformance Tests** (`packages/client-conformance-tests/test-cases/`): These YAML-based tests verify that the server correctly implements the Durable Streams protocol. They run against the reference server and are language-agnostic.

2. **Client Conformance Tests**: These test that client implementations (TypeScript, Python, Go) correctly interact with the protocol. They use the conformance test runner with language-specific adapters.

3. **Unit Tests**: Only use per-client unit tests when absolutely necessary, such as:
   - Testing internal utility functions that don't interact with the protocol
   - Testing edge cases that cannot be expressed in conformance tests
   - Mocking infrastructure-level concerns (network, filesystem)

### Test-Driven Bug Fixes

When fixing a bug or addressing a problem:

1. **First, evaluate how a conformance test would have caught it.** Consider:
   - What protocol behavior was violated?
   - What client behavior was incorrect?
   - Could this have been caught by an existing test category?

2. **Write a failing conformance test** that demonstrates the bug. Add it to the appropriate test case file in `packages/client-conformance-tests/test-cases/`.

3. **Then fix the bug** and verify the test passes.

This ensures:

- The fix works across all client implementations
- Regression protection for the specific scenario
- Documentation of expected behavior through tests

### Example Workflow

```
# Bug: Idempotent producer doesn't handle JSON batching correctly

1. Identify: This is client behavior when batching JSON values
2. Write test: Add test case to idempotent-producer.yaml or create json-batching.yaml
3. Run test: Verify it fails for affected clients
4. Fix: Update client implementations
5. Verify: All clients now pass the conformance test
```

## Code Style

- Follow existing patterns in the codebase
- Use TypeScript strict mode
- Format with Prettier (runs on commit via lint-staged)
- Lint with ESLint
