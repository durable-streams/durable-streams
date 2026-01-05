# Claude Development Guidelines

## Changesets

All packages are pre-1.0. Use `patch` for changesets, not `minor`, unless it's a breaking change.

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
