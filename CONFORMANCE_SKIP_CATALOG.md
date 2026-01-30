# Conformance Test Skip Catalog

This document catalogs all skipped conformance tests across client implementations and evaluates what it would take to get them fully passing.

## Executive Summary

**Total explicitly skipped tests:** 2 (Swift SSE base64 issues)
**Total tests skipped via feature flags:** ~50+ tests across various clients
**Clients with potential gaps:** All clients except TypeScript and PHP have feature gaps

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

| Client     | batching | sse | longPoll | auto | streaming | dynamicHeaders | strictZeroValidation | retryOptions | batchItems |
|------------|:--------:|:---:|:--------:|:----:|:---------:|:--------------:|:-------------------:|:------------:|:----------:|
| TypeScript | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Python     | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Go         | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Elixir     | ✓ | ⚠️ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Swift      | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| PHP        | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Java       | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Rust       | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Ruby       | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| .NET       | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |

⚠️ Elixir SSE support is conditional on Finch HTTP client availability

---

## 3. Tests Skipped Per Missing Feature

### `auto` feature (live: true mode)
**File:** `read-auto.yaml` (entire file requires this)
**Only supported by:** TypeScript, Rust
**Skipped by:** Python, Go, Elixir, Swift, PHP, Java, Ruby, .NET (8 clients)

This is the auto-selection mode where `live: true` automatically chooses SSE or long-poll based on server capability.

**Remediation effort:** Medium - requires implementing detection logic to choose between SSE and long-poll.

### `strictZeroValidation` feature
**Test:** `producer-zero-max-batch-bytes` in `input-validation.yaml`
**Only supported by:** TypeScript, Python, PHP
**Skipped by:** Go, Elixir, Swift, Java, Rust, Ruby, .NET (7 clients)

These clients treat `0` as "use default" rather than rejecting it as invalid.

**Remediation effort:** Low - add validation to reject 0 values for maxBatchBytes in IdempotentProducer constructor.

### `retryOptions` feature
**Tests:** 6 tests in `input-validation.yaml`
- `retry-options-valid`
- `retry-options-negative-max-retries`
- `retry-options-zero-initial-delay`
- `retry-options-negative-initial-delay`
- `retry-options-max-less-than-initial`
- `retry-options-multiplier-less-than-one`

**Only supported by:** PHP
**Skipped by:** TypeScript, Python, Go, Elixir, Swift, Java, Rust, Ruby, .NET (9 clients)

PHP has a dedicated `RetryOptions` class; other clients don't expose this as a separate validated configuration object.

**Remediation effort:** Medium - requires adding RetryOptions class with validation to each client, or documenting this as PHP-specific.

### `batchItems` feature
**Tests:** 2 tests in `input-validation.yaml`
- `producer-zero-max-batch-items`
- `producer-negative-max-batch-items`

**Only supported by:** PHP
**Skipped by:** All other clients (9 clients)

PHP has `maxBatchItems` option in IdempotentProducer; other clients don't expose this parameter.

**Remediation effort:** Medium - requires adding maxBatchItems parameter to IdempotentProducer in each client, or documenting this as PHP-specific.

### `sse` feature
**Files requiring SSE:**
- `read-sse.yaml` (entire file)
- `read-sse-base64.yaml` (entire file)
- `sse-parsing-errors.yaml` (entire file)
- Individual tests in: `streaming-equivalence.yaml`, `error-handling.yaml`, `offset-handling.yaml`, `message-ordering.yaml`, `stream-closure.yaml`

**Conditional support:** Elixir (requires Finch HTTP client)

**Remediation effort:** For Elixir, ensure Finch is always available in test environments.

### `longPoll` feature
**All clients report:** ✓
No skips for this feature.

### `batching` feature
**All clients report:** ✓
No skips for this feature.

### `dynamicHeaders` feature
**All clients report:** ✓
No skips for this feature.

---

## 4. Feature Source Locations

Where each client reports its features:

| Client | File | Line |
|--------|------|------|
| TypeScript | `packages/client-conformance-tests/src/adapters/typescript-adapter.ts` | 180-188 |
| Python | `packages/client-py/conformance_adapter.py` | 207-214 |
| Go | `packages/client-go/cmd/conformance-adapter/main.go` | 345-351 |
| Elixir | `packages/client-elixir/lib/durable_streams/conformance_adapter.ex` | 128-134 |
| Swift | `packages/client-swift/Sources/ConformanceAdapter/main.swift` | 443-449 |
| PHP | `packages/client-php/bin/conformance-adapter` | 210-219 |
| Java | `packages/client-java/conformance-adapter/.../ConformanceAdapter.java` | 124-130 |
| Rust | `packages/client-rust/src/bin/conformance_adapter.rs` | 272-278 |
| Ruby | `packages/client-rb/conformance_adapter.rb` | 172-177 |
| .NET | `packages/client-dotnet/src/.../Program.cs` | 106-111 |

---

## 5. Priority Remediation Plan

### High Priority (Real Bugs)
1. **Swift SSE base64 handling** - 2 explicit skips due to broken implementation
   - Fix multiline text decoding in SSE base64 mode
   - Fix large payload (4KB) handling with line splits

### Medium Priority (Feature Parity)
2. **Add `auto` feature to 8 clients** - Python, Go, Elixir, Swift, PHP, Java, Ruby, .NET
   - Implement `live: true` mode that auto-detects SSE vs long-poll
   - This enables the `read-auto.yaml` test suite

3. **Add `strictZeroValidation` to 7 clients** - Go, Elixir, Swift, Java, Rust, Ruby, .NET
   - Reject `0` for `maxBatchBytes` in IdempotentProducer constructor
   - Simple validation change

### Low Priority (Optional Feature Parity)
4. **Evaluate `retryOptions` and `batchItems`**
   - These may be intentionally PHP-specific
   - Either add to other clients or document as PHP-specific in test files

---

## 6. Potential "Cheating" Assessment

After analysis, the feature-based skipping appears mostly legitimate:

1. **Legitimate language differences:** Go treating `0` as default is idiomatic Go
2. **Feature gaps, not cheating:** Missing `auto` mode is a real feature gap, not avoidance
3. **PHP-specific features:** `retryOptions` and `batchItems` appear intentionally PHP-specific

**One concern:** The Swift explicit skips have been present for some time. These represent real bugs that should be fixed rather than indefinitely skipped.

---

## 7. Commented-Out Test

One test is commented out in `stream-closure.yaml` (lines 395-402):

```yaml
# - id: state-catching-up-closed-stream
#   Requires server-side chunk pagination to properly test partial reads
```

This requires server infrastructure changes, not client fixes.
