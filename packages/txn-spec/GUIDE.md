# Building DSLs for Testing Complex Systems

A practical guide for coding agents creating domain-specific languages for fuzz testing and formal verification of complex systems like databases, distributed systems, and transactional stores.

## Introduction

This guide distills lessons learned from building `@durable-streams/txn-spec`, a TypeScript DSL for testing transactional storage systems based on the CobbleDB/ASPLOS formal specification. The patterns here apply broadly to any complex system where correctness is critical.

**Key insight**: The goal isn't just to write tests—it's to create a _language_ that makes incorrect behavior impossible to express and correct behavior easy to verify.

---

## Part 0: Why—The Bounded Agents Problem

### 0.1 Everyone Has Limited Context

Humans hold roughly 4-7 concepts in working memory. AI agents have literal context limits. Neither can hold a full system in their head.

We live in a world of **multiple bounded agents**—human and AI—trying to co-evolve a shared system. The human can't see everything. The agent can't see everything. They can't even see the same things.

Without explicit contracts, small divergences compound. Tests pass but coherence collapses.

### 0.2 Configurancy: Shared Intelligibility

**Configurancy** (term from [Venkatesh Rao](https://contraptions.venkateshrao.com/p/configurancy)) is the shared intelligibility layer that allows agents with limited context to coherently co-evolve a system.

A configurancy layer establishes shared facts:

- **Affordances** (what you can do): _streams can be paused and resumed_
- **Invariants** (what you can rely on): _messages are delivered exactly once_
- **Constraints** (what you can't do): _max 100 concurrent streams per client_

High configurancy = any agent (human or AI) can act coherently.
Low configurancy = agents make locally correct changes that violate unstated assumptions.

### 0.3 Why DSLs Now?

We've always known specifications were valuable. But specs cost too much to write and more to maintain. So we invested sparingly, specs drifted, and eventually we just read the code.

**What changed is the economics.** Agents can propagate spec changes through implementations at machine speed. Conformance suites verify correctness. The spec becomes the source of truth again, because maintenance is now cheap.

A single spec change can ripple through dozens of files across multiple languages in minutes—verified correct by conformance tests. This makes formal DSLs tractable in ways they never were before.

### 0.4 The 30-Day Test

A useful heuristic: **Could any agent—human or AI—picking up this system after 30 days accurately predict its behavior from the configurancy model?**

If not, either your system is too complex or your model needs work.

---

## Part 1: Start From Formal Foundations

### 1.1 Find or Create a Specification

Before writing any code, establish what "correct" means. Sources include:

- **Academic papers** (like CobbleDB's "Formalising Transactional Storage Systems")
- **Protocol specifications** (like Raft, Paxos, TLA+ specs)
- **Industry standards** (SQL isolation levels, HTTP semantics)
- **Existing implementations** (use as reference, but verify assumptions)

```
Paper/Spec → Mathematical Model → DSL Types → Implementation → Tests
```

### 1.2 Map Mathematical Concepts Directly to Code

The CobbleDB paper defines effects algebraically:

```
δ_assign_v : constant function yielding v
δ_incr_n   : adds n to current value
δ_delete   : sets value to ⊥ (bottom)
```

This maps directly to TypeScript:

```typescript
// Types mirror the math exactly
type AssignEffect = { type: "assign"; value: Value }
type IncrementEffect = { type: "increment"; delta: number }
type DeleteEffect = { type: "delete" }
type Effect = AssignEffect | IncrementEffect | DeleteEffect

// Constructors match paper notation
const assign = (v: Value): AssignEffect => ({ type: "assign", value: v })
const increment = (n: number): IncrementEffect => ({
  type: "increment",
  delta: n,
})
const del = (): DeleteEffect => ({ type: "delete" })
```

**Why this matters**: When your code mirrors the specification, bugs become specification violations that are easier to identify and fix.

### 1.3 Encode Invariants in the Type System

Use TypeScript's type system to make illegal states unrepresentable:

```typescript
// Bad: allows invalid states
interface Transaction {
  status: string // Could be anything!
  commitTs?: number
}

// Good: encodes state machine in types
type Transaction =
  | { status: "pending"; snapshotTs: Timestamp }
  | { status: "committed"; snapshotTs: Timestamp; commitTs: Timestamp }
  | { status: "aborted"; snapshotTs: Timestamp }

// Now TypeScript enforces: committed transactions MUST have commitTs
```

### 1.4 Find External Hardness (Oracles)

The best configurancy enforcement relies on **verifiable ground truth that exists outside your system**.

Don't write the spec if someone else already has:

| Domain         | External Oracle                             |
| -------------- | ------------------------------------------- |
| SQL semantics  | PostgreSQL (run same query, compare)        |
| HTML parsing   | html5lib-tests (9,200 browser-vendor tests) |
| JSON parsing   | JSONTestSuite                               |
| HTTP semantics | RFC 7230-7235 + curl as reference           |
| Cryptography   | NIST test vectors                           |
| Time zones     | IANA tz database                            |

When you can verify against external hardness:

- Agents iterate rapidly (generate attempts, check against oracle)
- The spec never drifts—you compare against behavior, not documentation
- You inherit decades of edge-case discovery

```typescript
// Oracle testing: compare against authoritative source
async function testSQLExpression(expr: string) {
  const ourResult = await ourEngine.evaluate(expr)
  const pgResult = await postgres.query(`SELECT ${expr}`)
  expect(ourResult).toEqual(pgResult.rows[0])
}

// Generate hundreds of test cases, compare against oracle
for (const expr of generateRandomExpressions(1000)) {
  it(`matches Postgres: ${expr}`, () => testSQLExpression(expr))
}
```

If no external oracle exists, your conformance suite becomes the oracle. Invest heavily in its quality—future agents will trust it absolutely.

---

## Part 2: Design the DSL

### 2.1 Fluent Builder Pattern for Readable Scenarios

Tests should read like specifications. Compare:

```typescript
// Bad: imperative, hard to follow
const store = createStore()
const txn1 = coordinator.begin()
coordinator.update(txn1, "x", assign(10))
coordinator.commit(txn1, 5)
const txn2 = coordinator.begin(6)
const result = coordinator.read(txn2, "x")
expect(result).toBe(10)

// Good: declarative, self-documenting
scenario("read-after-write")
  .description("A transaction reads its own writes")
  .transaction("t1", { st: 0 })
  .update("x", assign(10))
  .commit({ ct: 5 })
  .transaction("t2", { st: 6 })
  .readExpect("x", 10)
  .commit({ ct: 10 })
  .build()
```

### 2.2 Builder Implementation Pattern

```typescript
class ScenarioBuilder {
  private steps: Step[] = []
  private currentTxn: TxnId | null = null

  transaction(id: TxnId, opts: { st: Timestamp }): this {
    this.steps.push({ type: "begin", txnId: id, snapshotTs: opts.st })
    this.currentTxn = id
    return this // Enable chaining
  }

  update(key: Key, effect: Effect): this {
    if (!this.currentTxn) throw new Error("No active transaction")
    this.steps.push({ type: "update", txnId: this.currentTxn, key, effect })
    return this
  }

  readExpect(key: Key, expected: Value): this {
    this.steps.push({
      type: "read",
      txnId: this.currentTxn!,
      key,
      expected,
    })
    return this
  }

  commit(opts: { ct: Timestamp }): this {
    this.steps.push({
      type: "commit",
      txnId: this.currentTxn!,
      commitTs: opts.ct,
    })
    this.currentTxn = null
    return this
  }

  build(): ScenarioDefinition {
    return { steps: this.steps /* metadata */ }
  }
}

// Factory function for clean API
const scenario = (name: string) => new ScenarioBuilder(name)
```

### 2.3 Provide Standard Scenarios

Create a library of canonical test cases:

```typescript
export const standardScenarios = [
  // Basic operations
  scenario("simple-read-write")...,
  scenario("read-own-writes")...,

  // Isolation boundaries
  scenario("snapshot-isolation")...,
  scenario("write-skew-anomaly")...,

  // Concurrent operations
  scenario("n-way-concurrent-increments")...,
  scenario("last-writer-wins")...,

  // Edge cases
  scenario("empty-transaction")...,
  scenario("delete-then-assign")...,
]
```

**Tag scenarios** for selective execution:

```typescript
scenario("concurrent-counters").tags("concurrent", "crdt", "increment")
// ...
```

---

## Part 3: Algebraic Property Testing

### 3.1 Verify Operator Properties

Mathematical operators have algebraic properties. Test them exhaustively:

```typescript
describe("Merge Properties", () => {
  const effects = [BOTTOM, assign(0), assign(1), increment(5), del()]

  // Commutativity: merge(a, b) = merge(b, a)
  for (const a of effects) {
    for (const b of effects) {
      it(`merge(${a}, ${b}) = merge(${b}, ${a})`, () => {
        expect(effectsEqual(merge(a, b), merge(b, a))).toBe(true)
      })
    }
  }

  // Associativity: merge(merge(a, b), c) = merge(a, merge(b, c))
  for (const a of effects) {
    for (const b of effects) {
      for (const c of effects) {
        it(`associativity for ${a}, ${b}, ${c}`, () => {
          const left = merge(merge(a, b), c)
          const right = merge(a, merge(b, c))
          expect(effectsEqual(left, right)).toBe(true)
        })
      }
    }
  }

  // Idempotence: merge(a, a) = a (for applicable types)
  // Identity: merge(BOTTOM, a) = a
})
```

### 3.2 Understand When Properties Don't Hold

Not all operations satisfy all properties. Document exceptions:

```typescript
describe("Idempotence", () => {
  /**
   * Idempotence applies at SET level (version deduplication),
   * not VALUE level for all types.
   *
   * - Assigns, deletes: idempotent (merge(a, a) = a)
   * - Increments: NOT idempotent (merge(inc(5), inc(5)) = inc(10))
   *   This is INTENTIONAL for counter CRDT semantics.
   */

  it("increments sum, not deduplicate", () => {
    expect(merge(increment(5), increment(5))).toEqual(increment(10))
  })
})
```

---

## Part 4: Fuzz Testing Framework

### 4.1 Seeded Random Generation

Reproducibility is critical. Use seeded PRNGs:

```typescript
class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed
  }

  // Linear Congruential Generator
  next(): number {
    this.state = (this.state * 1103515245 + 12345) & 0x7fffffff
    return this.state / 0x7fffffff
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }

  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)]
  }
}

// Failing test output: "Failed with seed 12345"
// Reproduce: new SeededRandom(12345)
```

### 4.2 Random Scenario Generation

Generate scenarios that explore the state space:

```typescript
interface FuzzConfig {
  seed: number
  numTransactions: { min: number; max: number }
  numKeys: { min: number; max: number }
  operationsPerTxn: { min: number; max: number }
  effectTypes: Array<"assign" | "increment" | "delete">
  abortProbability: number
}

function generateRandomScenario(config: FuzzConfig): ScenarioDefinition {
  const rng = new SeededRandom(config.seed)
  const keys = Array.from(
    { length: rng.int(config.numKeys.min, config.numKeys.max) },
    (_, i) => `key${i}`
  )

  const builder = scenario(`fuzz-${config.seed}`)
  let timestamp = 0

  const numTxns = rng.int(
    config.numTransactions.min,
    config.numTransactions.max
  )

  for (let t = 0; t < numTxns; t++) {
    const txnId = `t${t}`
    const snapshotTs = timestamp++

    builder.transaction(txnId, { st: snapshotTs })

    const numOps = rng.int(
      config.operationsPerTxn.min,
      config.operationsPerTxn.max
    )
    for (let o = 0; o < numOps; o++) {
      const key = rng.pick(keys)
      const effectType = rng.pick(config.effectTypes)

      switch (effectType) {
        case "assign":
          builder.update(key, assign(rng.int(0, 100)))
          break
        case "increment":
          builder.update(key, increment(rng.int(1, 10)))
          break
        case "delete":
          builder.update(key, del())
          break
      }
    }

    if (rng.chance(config.abortProbability)) {
      builder.abort()
    } else {
      builder.commit({ ct: timestamp++ })
    }
  }

  return builder.build()
}
```

### 4.3 Store Equivalence Testing

The most powerful fuzz technique: run the same scenario against multiple implementations and verify they agree:

```typescript
async function runFuzzTest(
  scenario: ScenarioDefinition,
  stores: Array<{ name: string; create: () => Promise<Store> }>
): Promise<FuzzResult> {
  const results = new Map<string, Map<Key, Value>>()

  for (const { name, create } of stores) {
    const store = await create()
    try {
      await executeScenario(scenario, store)
      results.set(name, await store.snapshot())
    } finally {
      await store.close()
    }
  }

  // Check all stores agree
  const storeNames = [...results.keys()]
  const reference = results.get(storeNames[0])!

  for (let i = 1; i < storeNames.length; i++) {
    const other = results.get(storeNames[i])!
    if (!mapsEqual(reference, other)) {
      return {
        success: false,
        inconsistency: {
          stores: [storeNames[0], storeNames[i]],
          reference: mapToObject(reference),
          actual: mapToObject(other),
        },
      }
    }
  }

  return { success: true }
}
```

### 4.4 Shrinking Failing Cases

When a fuzz test fails, minimize the scenario:

```typescript
async function shrinkFailingCase(
  scenario: ScenarioDefinition,
  stores: StoreFactory[],
  isFailure: (scenario: ScenarioDefinition) => Promise<boolean>
): Promise<ScenarioDefinition> {
  let current = scenario

  // Try removing transactions one at a time
  for (let i = current.transactions.length - 1; i >= 0; i--) {
    const smaller = removeTransaction(current, i)
    if (await isFailure(smaller)) {
      current = smaller // Still fails, keep the reduction
    }
  }

  // Try removing operations within transactions
  for (const txn of current.transactions) {
    for (let i = txn.operations.length - 1; i >= 0; i--) {
      const smaller = removeOperation(current, txn.id, i)
      if (await isFailure(smaller)) {
        current = smaller
      }
    }
  }

  return current // Minimal failing case
}
```

---

## Part 5: Jepsen-Inspired Techniques

[Jepsen](https://jepsen.io) has pioneered distributed systems testing. Key techniques:

### 5.1 History-Based Verification

Record a history of operations and verify it satisfies consistency models:

```typescript
interface Operation {
  type: "invoke" | "ok" | "fail"
  process: ProcessId
  action: "read" | "write" | "cas"
  key: Key
  value?: Value
  timestamp: number
}

type History = Operation[]

// Check if history is linearizable
function checkLinearizability(history: History): boolean {
  // For each possible linearization order...
  // (This is NP-complete in general, use heuristics)
  return tryLinearize(history, [])
}

// Check if history satisfies snapshot isolation
function checkSnapshotIsolation(history: History): boolean {
  // No write-write conflicts in concurrent transactions
  // Reads see a consistent snapshot
  // ...
}
```

### 5.2 Consistency Model Hierarchy

Test against multiple consistency models:

```
Linearizability (strongest)
    ↓
Sequential Consistency
    ↓
Snapshot Isolation
    ↓
Read Committed
    ↓
Read Uncommitted
    ↓
Eventual Consistency (weakest)
```

```typescript
const consistencyCheckers = {
  linearizable: checkLinearizability,
  sequential: checkSequentialConsistency,
  snapshotIsolation: checkSnapshotIsolation,
  readCommitted: checkReadCommitted,
}

function verifyHistory(
  history: History,
  model: keyof typeof consistencyCheckers
) {
  const checker = consistencyCheckers[model]
  return checker(history)
}
```

### 5.3 Fault Injection (Nemesis)

Jepsen's "nemesis" injects failures. Design your DSL to support this:

```typescript
interface Nemesis {
  // Network partitions
  partition(nodes: Node[][]): Promise<void>
  heal(): Promise<void>

  // Process failures
  kill(node: Node): Promise<void>
  restart(node: Node): Promise<void>

  // Clock skew
  skewClock(node: Node, delta: Duration): Promise<void>

  // Disk
  corruptFile(node: Node, path: string): Promise<void>
}

scenario("partition-during-write")
  .transaction("t1")
  .update("x", assign(1))
  .commit()
  .nemesis((n) => n.partition([["n1", "n2"], ["n3"]]))
  .transaction("t2")
  .update("x", assign(2))
  .commit()
  .nemesis((n) => n.heal())
  .transaction("t3")
  .readExpect("x" /* depends on consistency model */)
```

### 5.4 Elle: Dependency Graph Analysis

Jepsen's [Elle](https://github.com/jepsen-io/elle) checks consistency via dependency graphs:

```typescript
interface DependencyGraph {
  nodes: Transaction[]
  edges: Array<{
    from: Transaction
    to: Transaction
    type: "ww" | "wr" | "rw" // write-write, write-read, read-write
  }>
}

function buildDependencyGraph(history: History): DependencyGraph {
  // WW: t1 writes x, t2 writes x, t2 sees t1's write
  // WR: t1 writes x, t2 reads x (and sees t1's value)
  // RW: t1 reads x, t2 writes x (anti-dependency)
  // ...
}

function checkSerializable(graph: DependencyGraph): boolean {
  // No cycles in the dependency graph
  return !hasCycle(graph)
}
```

---

## Part 6: Practical Patterns

### 6.1 Multi-Implementation Testing

The most valuable test: same interface, multiple implementations:

```typescript
const implementations = [
  { name: "in-memory", create: createMapStore },
  { name: "wal-based", create: createStreamStore },
  { name: "rocksdb", create: createRocksDbStore },
  { name: "distributed", create: createDistributedStore },
]

describe("All implementations agree", () => {
  for (const scenario of standardScenarios) {
    it(scenario.name, async () => {
      const results = await Promise.all(
        implementations.map(async (impl) => ({
          name: impl.name,
          result: await runScenario(scenario, await impl.create()),
        }))
      )

      // All should match
      for (let i = 1; i < results.length; i++) {
        expect(results[i].result).toEqual(results[0].result)
      }
    })
  }
})
```

### 6.2 Conformance Test Suites

Separate specification tests from implementation tests:

```
test-cases/
  ├── core/
  │   ├── read-write.yaml
  │   ├── isolation.yaml
  │   └── atomicity.yaml
  ├── edge-cases/
  │   ├── empty-transactions.yaml
  │   └── clock-skew.yaml
  └── consistency-models/
      ├── snapshot-isolation.yaml
      └── serializable.yaml
```

### 6.3 YAML Test Definitions

For cross-language conformance, use data-driven tests:

```yaml
# snapshot-isolation.yaml
name: snapshot-isolation-basic
description: Transactions see consistent snapshots
tags: [isolation, snapshot]

setup:
  - { txn: init, ops: [{ write: { key: x, value: 0 } }], commit: 1 }

scenario:
  - { txn: t1, snapshot: 2, ops: [{ read: x, expect: 0 }] }
  - { txn: t2, snapshot: 2, ops: [{ write: { key: x, value: 1 } }], commit: 3 }
  - { txn: t1, ops: [{ read: x, expect: 0 }], commit: 4 } # Still sees 0!

expected:
  x: 1 # Final value after all commits
```

### 6.4 Differential Testing Against Reference

If you have a reference implementation (even a slow one), use it:

```typescript
class ReferenceStore {
  // Slow but obviously correct implementation
  // Every operation validates invariants
  // No optimizations, maximum clarity
}

it("optimized matches reference", async () => {
  const scenario = generateRandomScenario({ seed: 42 })

  const refResult = await runScenario(scenario, new ReferenceStore())
  const optResult = await runScenario(scenario, new OptimizedStore())

  expect(optResult).toEqual(refResult)
})
```

### 6.5 Bidirectional Enforcement

The configurancy model only matters if it's enforced. Review in both directions:

**Doc → Code**: If the spec claims an invariant, is it actually enforced?

```
For each invariant in the spec:
  [ ] Is it enforced by types?
  [ ] Is it covered by conformance tests?
  [ ] Are violations caught at runtime?
  [ ] If not enforced, why? (document the gap)
```

**Code → Doc**: If a test encodes an invariant, is it documented?

```
For each test/type/constraint in the PR:
  [ ] Does it encode an invariant?
  [ ] Is that invariant in the spec?
  [ ] If not, should it be added?
```

A spec that drifts from enforcement is worse than no spec—it actively misleads agents.

### 6.6 Configurancy Delta

Track **how shared understanding changed**, not just what lines changed:

```
Affordances:
  + [NEW] Users can now pause streams
  ~ [MODIFIED] Delete requires confirmation

Invariants:
  ↑ [STRENGTHENED] Delivery: at-least-once → exactly-once

Constraints:
  + [NEW] Max 100 concurrent streams per client
```

This is what agents need to know. Not the diff—the delta in what they should expect.

**Invisible changes are good**: Bug fixes and refactors should be invisible at the configurancy layer. If your "bug fix" requires updating the shared model, it's a behavior change.

---

## Part 7: LLM-Guided Testing

### 7.1 Scenario Generation via LLM

LLMs can generate meaningful edge cases:

```typescript
const prompt = `
Generate a test scenario for a transactional key-value store that tests
the following edge case: ${edgeCaseDescription}

Use this DSL format:
scenario("name")
  .transaction("t1", { st: 0 })
  .update("key", assign(value))
  .commit({ ct: 5 })
  ...
`

// LLM generates scenario, parse and execute
const generatedCode = await llm.complete(prompt)
const scenario = eval(generatedCode) // Or safer: parse DSL
await runScenario(scenario, store)
```

### 7.2 Invariant Discovery

LLMs can help identify invariants you missed:

```typescript
const prompt = `
Given this transactional storage system with these operations:
- assign(key, value): Set key to value
- increment(key, delta): Add delta to key
- delete(key): Remove key
- merge(a, b): Combine concurrent effects

What invariants should always hold? Consider:
1. Algebraic properties (commutativity, associativity, etc.)
2. Transaction isolation guarantees
3. Durability guarantees
4. Consistency across replicas
`
```

### 7.3 Failure Analysis

When fuzz tests fail, use LLM to analyze:

```typescript
const analysisPrompt = `
A fuzz test failed with this minimal scenario:
${JSON.stringify(shrunkScenario, null, 2)}

Store A produced: ${JSON.stringify(resultA)}
Store B produced: ${JSON.stringify(resultB)}

Analyze:
1. What invariant was violated?
2. What's the likely root cause?
3. Which store is correct according to the spec?
`
```

---

## Part 8: Lessons Learned

### 8.1 Start Simple, Add Complexity

1. **Day 1**: Basic types + single-key operations
2. **Day 2**: Multi-key transactions
3. **Day 3**: Concurrent transaction handling
4. **Day 4**: Property tests for operators
5. **Day 5**: Fuzz testing framework
6. **Day 6**: Multiple store implementations
7. **Day 7**: Consistency model verification

### 8.2 Debug Failures Systematically

When a test fails:

1. **Shrink** to minimal failing case
2. **Trace** the execution step by step
3. **Compare** against specification
4. **Identify** which invariant was violated
5. **Fix** in the implementation OR the test (sometimes tests are wrong!)

### 8.3 Document Semantic Decisions

When the spec is ambiguous, document your choices:

```typescript
/**
 * Increment applied to BOTTOM returns the delta value.
 *
 * Rationale: When concurrent increments occur without a common
 * predecessor assignment, we treat BOTTOM as 0. This enables
 * counter CRDT semantics where increment(5) || increment(3) = 8.
 *
 * Alternative interpretation: Could return BOTTOM (undefined + n = undefined).
 * We chose additive semantics for practical counter use cases.
 *
 * See: CobbleDB paper Section 4.2, Definition 3
 */
if (isBottom(value)) {
  return effect.delta // Not BOTTOM
}
```

### 8.4 Test the Tests

Meta-testing catches specification bugs:

```typescript
it("test suite covers all effect type combinations", () => {
  const coveredCombinations = new Set<string>()

  for (const scenario of standardScenarios) {
    for (const step of scenario.steps) {
      if (step.type === "update") {
        coveredCombinations.add(step.effect.type)
      }
    }
  }

  expect(coveredCombinations).toContain("assign")
  expect(coveredCombinations).toContain("increment")
  expect(coveredCombinations).toContain("delete")
})
```

---

## Part 9: Where This Breaks Down

This approach has costs and failure modes. Be honest about them:

### 9.1 Upfront Investment

Building conformance suites takes time. For throwaway prototypes or rapidly pivoting products, the overhead isn't worth it. The payoff comes from **reuse**—multiple implementations, long-lived systems, many agents touching the code.

### 9.2 Not Everything Is Specifiable

Some systems have emergent behavior that resists clean specification:

- Neural network edge cases
- Simulation chaos
- UI "feel"
- Performance characteristics

The configurancy layer can describe inputs and outputs, but some interesting behavior happens in between.

### 9.3 Conformance Suite Quality Is Critical

A weak conformance suite gives false confidence. JustHTML works because html5lib-tests is comprehensive and battle-tested over years by browser vendors. Rolling your own suite requires expertise and iteration.

**If your suite has gaps, agents will confidently produce incorrect implementations.**

### 9.4 Agents Propagate Mistakes Fast

If you update the spec incorrectly, agents will dutifully propagate that mistake across dozens of files. The velocity cuts both ways.

Mitigation: The conformance suite catches spec errors that break tests before propagation completes. But this only works if your suite is comprehensive.

### 9.5 Cultural Change Is Hard

Teams need to treat spec updates as first-class changes. If developers bypass the spec and edit code directly, you're back to documentation drift—now with extra steps.

### 9.6 When NOT to Use This Approach

- **Throwaway scripts**: Just write the code
- **Rapid prototypes**: Spec will change too fast
- **Emergent behavior**: Can't specify what you don't understand
- **Solo projects**: You ARE the shared context
- **Time pressure**: Ship first, formalize later (but actually do it later)

The approach pays off for **stable protocols**, **clear-contract libraries**, and **systems that must evolve without breaking**.

---

## Conclusion

Building a testing DSL for complex systems is an investment that pays dividends:

1. **Correctness confidence**: Property tests + fuzz tests + multi-implementation tests catch bugs that unit tests miss

2. **Living documentation**: The DSL serves as executable specification

3. **Regression prevention**: New implementations must pass the same conformance suite

4. **Faster debugging**: Minimal failing cases and clear semantics speed root cause analysis

The key insight: **Testing complex systems is itself a complex system**. Treat your test infrastructure with the same rigor as production code.

---

## References

- [Jepsen](https://jepsen.io) - Distributed systems testing
- [Elle](https://github.com/jepsen-io/elle) - Black-box transactional consistency checker
- [QuickCheck](https://hackage.haskell.org/package/QuickCheck) - Property-based testing origin
- [Hypothesis](https://hypothesis.readthedocs.io/) - Python property-based testing
- [TLA+](https://lamport.azurewebsites.net/tla/tla.html) - Formal specification language
- [Alloy](https://alloytools.org/) - Relational logic modeling
- [CobbleDB Paper](https://dl.acm.org/doi/10.1145/3582016.3582042) - Formal transactional storage specification
- [Hermitage](https://github.com/ept/hermitage) - Testing transaction isolation levels
