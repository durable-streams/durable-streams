# Conformance Test Skip Catalog

This document catalogs all skipped conformance tests across client implementations and evaluates what it would take to get them fully passing.

## Executive Summary

**Total explicitly skipped tests:** 2 (Swift SSE base64 issues)
**Total tests skipped via feature flags:** ~10 tests across various clients
**Remaining gaps:** `strictZeroValidation` (7 clients)

---

## 1. Explicit Test Skips

These tests are explicitly marked as `skip:` in the YAML test files:

| Test ID | File | Skip Reason | Affected Client |
|---------|------|-------------|-----------------|
| `sse-base64-data-integrity-multiline` | `read-sse-base64.yaml:55` | "Swift implementation broken" | Swift |
| `sse-base64-large-payload-4kb` | `read-sse-base64.yaml:367` | "Swift implementation broken" | Swift |

**Remediation:** Fix Swift client's SSE base64 handling for multiline text and large (4KB) payloads with potential line splits.

---

## 2. Feature Support Matrix

Clients report which features they support. Tests with `requires:` skip for clients that don't report the feature.

| Client     | batching | sse | longPoll | auto | streaming | dynamicHeaders | strictZeroValidation |
|------------|:--------:|:---:|:--------:|:----:|:---------:|:--------------:|:-------------------:|
| TypeScript | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Python     | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Go         | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Elixir     | ✓ | ⚠️ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Swift      | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| PHP        | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Java       | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Rust       | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Ruby       | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| .NET       | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |

⚠️ Elixir SSE support is conditional on Finch HTTP client availability

---

## 3. Tests Skipped Per Missing Feature

### `strictZeroValidation` feature
**Test:** `producer-zero-max-batch-bytes` in `input-validation.yaml`
**Only supported by:** TypeScript, Python, PHP
**Skipped by:** Go, Elixir, Swift, Java, Rust, Ruby, .NET (7 clients)

These clients have different behavior for `maxBatchBytes: 0`:
- **Go**: Treats 0 as "use default" (idiomatic Go)
- **Java, .NET**: Actually reject 0 as invalid (could enable this feature)
- **Swift, Ruby, Rust, Elixir**: Accept 0 but it causes immediate flushing (buggy)

**Remediation effort:** Low - add validation to reject 0 values for maxBatchBytes in IdempotentProducer constructor.

### `sse` feature
**Files requiring SSE:**
- `read-sse.yaml` (entire file)
- `read-sse-base64.yaml` (entire file)
- `sse-parsing-errors.yaml` (entire file)
- Individual tests in: `streaming-equivalence.yaml`, `error-handling.yaml`, `offset-handling.yaml`, `message-ordering.yaml`, `stream-closure.yaml`

**Conditional support:** Elixir (requires Finch HTTP client)

**Remediation effort:** For Elixir, ensure Finch is always available in test environments.

### All other features
**All clients now report:** ✓
- `batching`
- `longPoll`
- `auto` (live: true mode)
- `streaming`
- `dynamicHeaders`

---

## 4. Priority Remediation Plan

### High Priority (Real Bugs)
1. **Swift SSE base64 handling** - 2 explicit skips due to broken implementation
   - Fix multiline text decoding in SSE base64 mode
   - Fix large payload (4KB) handling with line splits

### Low Priority (Language Differences)
2. **`strictZeroValidation`** - 7 clients don't reject 0 for maxBatchBytes
   - Go: Intentional (idiomatic Go treats 0 as default)
   - Java/.NET: Could easily enable (already reject 0)
   - Swift/Ruby/Rust/Elixir: Should probably add validation

---

## 5. Potential "Cheating" Assessment

After analysis, the feature-based skipping appears mostly legitimate:

1. **Legitimate language differences:** Go treating `0` as default is idiomatic Go
2. **All clients now support `auto` mode:** `live: true` works everywhere
3. **PHP-specific features removed:** `retryOptions` and `batchItems` tests were removed as they were PHP-specific implementation details, not protocol requirements

**One concern:** The Swift explicit skips have been present for some time. These represent real bugs that should be fixed rather than indefinitely skipped.

---

## 6. Commented-Out Test

One test is commented out in `stream-closure.yaml` (lines 395-402):

```yaml
# - id: state-catching-up-closed-stream
#   Requires server-side chunk pagination to properly test partial reads
```

This requires server infrastructure changes, not client fixes.
