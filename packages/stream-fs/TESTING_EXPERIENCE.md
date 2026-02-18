# Testing Guide Experience Report: Stream-FS

A writeup on applying "Building DSLs for Testing Complex Systems" to a real-world library.

## Context

**What is Stream-FS?** A shared filesystem abstraction for AI agents built on top of Durable Streams. Multiple agents can read/write files through a persistent, resumable event stream. Think "append-only log as a filesystem" with eventual consistency.

**Starting point:** We had ~95 basic unit tests covering happy paths and some error cases. Standard vitest setup, no formal specification.

**End state:** 425 tests across 10 test files, a formal SPEC.md with 11 invariants and 10 constraints, and several bugs caught before they shipped.

---

## What We Implemented

Following the guide, we built:

| Component                | Guide Concept          | Our Implementation                                            |
| ------------------------ | ---------------------- | ------------------------------------------------------------- |
| SPEC.md                  | Formal specification   | 11 invariants (I1-I11), 10 constraints (C1-C10)               |
| scenario-builder.ts      | Fluent DSL             | `scenario("name").createFile(...).expectContent(...).run(fs)` |
| invariants.ts            | Invariant checkers     | Functions that verify structural properties on any snapshot   |
| random.ts                | Seeded RNG             | LCG-based `SeededRandom` class for reproducible fuzz tests    |
| fuzz.test.ts             | Property-based testing | Random operation sequences verified against invariants        |
| path-properties.test.ts  | Algebraic properties   | Idempotence, canonical form tests for path normalization      |
| patch-properties.test.ts | Roundtrip properties   | `apply(diff(a,b), a) === b` for 100+ random text pairs        |
| multi-agent.test.ts      | Concurrency testing    | 2-10 agent convergence scenarios                              |
| adversarial.test.ts      | Tier-2 DSL             | Raw event injection, constraint violation tests               |
| exhaustive.test.ts       | Small-scope hypothesis | All 2-operation sequences, complete lifecycle coverage        |

---

## Concrete Bugs Caught

### Bug 1: Path Normalization Edge Case

**How we found it:** Writing exhaustive tests for path operations revealed that `//double//slashes.txt` wasn't being normalized before the parent directory check.

```typescript
// This test failed initially
it(`handles paths with multiple slashes`, async () => {
  await fs.mkdir(`/double`)
  await fs.createFile(`//double//slashes.txt`, `content`)
  expect(fs.exists(`/double/slashes.txt`)).toBe(true)
})
```

**Root cause:** The path was normalized for storage, but the parent directory lookup happened _before_ normalization. The fix was trivial once identified, but this edge case would have been nearly impossible to find through manual testing.

**Guide principle applied:** Exhaustive small-scope testing. By systematically testing all path edge cases (leading slashes, double slashes, dots, parent references), we caught what random testing might have missed.

### Bug 2: Sync vs Async Method Confusion

**How we found it:** When building the fluent DSL, we had to explicitly model which operations were sync vs async. This forced us to audit every method signature.

```typescript
// Original: async methods that never awaited
async exists(path: string): Promise<boolean> {
  return this.files.has(normalizePath(path))
}

// Fixed: sync methods for read-only operations
exists(path: string): boolean {
  return this.files.has(normalizePath(path))
}
```

**Root cause:** Copy-paste from async write methods. The methods worked fine, but returning `Promise<boolean>` when the operation was synchronous was misleading and could cause subtle bugs in calling code.

**Guide principle applied:** The DSL forced us to be explicit about operation semantics. Building the `Step` type system required thinking carefully about what each operation actually does.

### Bug 3: Missing Parent Directory Validation

**How we found it:** Adversarial tests for constraint C2 ("Parent Exists") uncovered that deeply nested paths weren't being validated correctly.

```typescript
// This should fail but didn't initially
await fs.createFile(`/a/b/c/d/e/file.txt`, `content`)
```

**Root cause:** We validated immediate parent but not the full ancestor chain. The fix required walking up the path tree.

**Guide principle applied:** Systematic constraint testing. By explicitly listing every constraint and writing a test for each, we caught gaps in validation logic.

---

## What the Formal Specification Revealed

Writing SPEC.md was the most valuable exercise. It forced clarity on several ambiguous behaviors:

### Clarification 1: What happens when you delete a file and recreate it?

Before: Undefined behavior, might keep old metadata.
After: Explicitly specified in I5 (Modification Time Monotonicity) - new file gets fresh timestamps.

### Clarification 2: Multi-agent consistency model

Before: Vague notion of "eventual consistency."
After: Formally defined in I8: "After all agents refresh, their file/directory sets are identical."

This distinction matters! We originally thought content would also be identical, but that's only true if no concurrent writes happened. The spec forced us to be precise.

### Clarification 3: Patch failure semantics

Before: "Patch fails if it doesn't apply."
After: Constraint C10 explicitly states patch failure doesn't modify the file, and I7 defines that empty patch is identity.

---

## The Two-Tier DSL in Practice

The guide recommends two tiers:

1. **Tier 1:** Type-safe fluent builder for valid operations
2. **Tier 2:** Raw event injection for adversarial testing

### Tier 1 Example (scenario-builder.ts)

```typescript
await scenario("read-after-write")
  .createFile("/test.txt", "hello")
  .expectContent("/test.txt", "hello")
  .writeFile("/test.txt", "world")
  .expectContent("/test.txt", "world")
  .run(fs)
```

This is readable, type-safe, and catches typos at compile time. The `.expectError()` method lets you verify that invalid operations fail correctly.

### Tier 2 Example (adversarial.test.ts)

```typescript
// Test that we reject operations on uninitialized filesystem
it(`should reject operations on uninitialized filesystem`, async () => {
  const uninitializedFs = new StreamFilesystem(baseUrl, `/uninitialized`)
  // Don't call initialize()
  await expect(
    uninitializedFs.createFile(`/test.txt`, `content`)
  ).rejects.toThrow()
})
```

Tier 2 tests bypass the normal API to test error handling and edge cases that the type-safe API intentionally prevents.

---

## Property Testing: What Worked

### Path Normalization Properties

The guide suggests testing algebraic properties. For paths:

```typescript
// Idempotence: normalizing twice equals normalizing once
expect(normalizePath(normalizePath(path))).toBe(normalizePath(path))

// Canonical form: result always starts with /
expect(normalizePath(path).startsWith("/")).toBe(true)
```

We tested these against 50 random paths plus edge cases. Found that `normalizePath("")` returned `""` instead of `"/"`. Fixed.

### Patch Roundtrip Properties

```typescript
// Roundtrip: apply(diff(a, b), a) === b
const patch = createPatch(original, modified)
const result = applyPatch(original, patch)
expect(result).toBe(modified)
```

Tested with 100 random text pairs. All passed, which gave us confidence in the diff/patch implementation (we use a library, but verifying the integration is valuable).

---

## Multi-Agent Testing: The Surprise

The most interesting tests were multi-agent scenarios. We tested:

- 2 agents creating different files, then refreshing
- 3 agents with interleaved operations
- 5 agents with concurrent writes
- 10 agents stress test
- Late-joining agent that should see full history

**Unexpected finding:** The 10-agent stress test consistently passes, but it revealed that our test infrastructure was the bottleneck. Each agent creates its own HTTP connection, and at 10 agents × 5 operations each, we were seeing connection pool exhaustion in CI (not in the library itself).

This is exactly the kind of operational insight you only get from realistic concurrency testing.

---

## Metrics: Before and After

| Metric             | Before | After      |
| ------------------ | ------ | ---------- |
| Test count         | 95     | 425        |
| Test files         | 4      | 10         |
| Lines of test code | ~800   | ~3,600     |
| Formal invariants  | 0      | 11         |
| Formal constraints | 0      | 10         |
| Bugs caught        | -      | 3+         |
| Edge cases covered | Ad-hoc | Systematic |

---

## What We'd Do Differently

### 1. Write SPEC.md First

We wrote the implementation first, then the spec. This meant the spec was partly descriptive rather than prescriptive. Next time, we'd write invariants and constraints _before_ coding.

### 2. Integrate Fuzz Testing Earlier

Fuzz tests found the path normalization bug. If we'd run them during development, we would have caught it sooner. Lesson: fuzz tests aren't just for "hardening" - they're for development.

### 3. More Mutation Testing

We didn't implement mutation testing (deliberately breaking code to verify tests catch it). The guide mentions this but we skipped it for time. Worth adding.

---

## Recommendations for the Guide

A few things we wish the guide had covered:

1. **Async operation modeling in DSLs.** Our filesystem has both sync and async operations, and the fluent builder had to handle this carefully. A section on this would help.

2. **Snapshot comparison strategies.** We wrote `snapshotsEqual()` to compare filesystem states, but handling floating-point timestamps and non-deterministic ordering required thought.

3. **Test performance at scale.** Our 10-agent tests take ~1 second each. At 425 tests, the suite runs in ~4 seconds, which is fine. But scaling advice would be useful.

---

## Conclusion

The guide's core insight - that tests should be derived from formal specifications, not just "does this work?" checks - fundamentally changed how we approached stream-fs testing.

**Most valuable concepts:**

- Invariants as executable specifications
- The two-tier DSL pattern
- Exhaustive small-scope testing (Alloy's hypothesis)
- Seeded randomness for reproducibility

**Tangible outcomes:**

- 3+ bugs caught before shipping
- Formal specification that serves as documentation
- Confidence in multi-agent behavior
- Regression protection for edge cases

The investment (roughly 3,600 lines of test code for 1,500 lines of implementation) is significant, but for a library where correctness matters - especially one involving concurrency - it's worth it.

---

_Written after implementing the guide's recommendations for @durable-streams/stream-fs_
