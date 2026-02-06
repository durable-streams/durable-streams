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

**Important caveat**: TypeScript's type system is not sound in the PL-theory sense—you can punch through with `any`. Separate three layers of enforcement:

| Layer                  | Purpose                   | Tradeoff                            |
| ---------------------- | ------------------------- | ----------------------------------- |
| **Static guardrails**  | Ergonomics, fast feedback | Can be bypassed; best-effort only   |
| **Runtime validation** | Actual enforcement        | Has cost; can't catch everything    |
| **Semantic checking**  | The real oracle           | May be slow; run on test/fuzz cases |

```typescript
// Layer 1: Static - TypeScript catches at compile time
function commit(txn: PendingTransaction): CommittedTransaction // Type error if wrong status

// Layer 2: Runtime - Explicit validation
function commit(txn: Transaction): CommittedTransaction {
  if (txn.status !== "pending") {
    throw new Error(`Cannot commit ${txn.status} transaction`)
  }
  // ...
}

// Layer 3: Semantic - Check invariants over entire history
function checkInvariant(history: History): boolean {
  // "No transaction commits twice"
  const commitCounts = new Map<TxnId, number>()
  for (const op of history) {
    if (op.type === "commit") {
      const count = (commitCounts.get(op.txnId) ?? 0) + 1
      if (count > 1) return false
      commitCounts.set(op.txnId, count)
    }
  }
  return true
}
```

This separation is an important formal-methods lesson: proofs/specs always have a _trusted computing base_; you want it small and explicit.

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

**Important tradeoff**: When you use an external oracle, it becomes part of your spec. If the oracle has quirks, you inherit them. You've chosen a _reference model_, and you must document the gaps where the oracle is underspecified, nondeterministic, or "bug-compatible."

```typescript
// Document oracle limitations explicitly
const ORACLE_GAPS = {
  postgres: {
    "NULL comparison":
      "Postgres NULL semantics differ from SQL standard in some edge cases",
    "float precision": "Postgres may round differently than IEEE 754 strict",
  },
}

// Test against oracle, but track known divergences
async function testAgainstOracle(expr: string) {
  const ourResult = await ourEngine.evaluate(expr)
  const pgResult = await postgres.query(`SELECT ${expr}`)

  if (isKnownDivergence(expr, ORACLE_GAPS.postgres)) {
    // Log but don't fail - this is documented behavior difference
    console.log(`Known divergence for: ${expr}`)
    return
  }

  expect(ourResult).toEqual(pgResult.rows[0])
}
```

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

  abort(): this {
    this.steps.push({
      type: "abort",
      txnId: this.currentTxn!,
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

### 2.4 Two-Tier Language Design

There are two distinct DSL jobs, and conflating them causes problems:

1. **Valid-behavior DSL** (high configurancy): Makes it hard to write nonsense, guides authors to meaningful scenarios. This is what typed builders give you.

2. **Adversarial DSL** (low-level): Deliberately constructs "illegal" sequences to test defensive behavior, error handling, and robustness.

Formal verification history is littered with disasters where the spec excluded behaviors that later happened in reality—often because the spec quietly assumed something about the environment.

**Design pattern**: A "typed builder DSL" for well-formed histories, plus a "raw event DSL" (or mutation layer) for malformed, reordered, duplicated, replayed, or partitioned scenarios.

```typescript
// Tier 1: Typed builder - makes illegal states hard to express
const validScenario = scenario("normal-operation")
  .transaction("t1", { st: 0 })
  .update("x", assign(10))
  .commit({ ct: 5 }) // Builder enforces: can only commit active transactions

// Tier 2: Raw events - for adversarial testing
const adversarialScenario = rawEvents([
  { type: "begin", txnId: "t1", snapshotTs: 0 },
  { type: "commit", txnId: "t1", commitTs: 5 }, // Commit without any operations
  { type: "commit", txnId: "t1", commitTs: 6 }, // Double commit!
  { type: "update", txnId: "t1", key: "x", effect: assign(10) }, // Update after commit!
])

// Tier 2: Mutation layer - corrupt valid scenarios
const corruptedScenario = validScenario
  .mutate()
  .duplicateEvent(2) // Replay an event
  .reorderEvents(1, 3) // Swap event order
  .dropEvent(4) // Lose an event
  .build()
```

The typed builder is for authors writing test cases. The raw layer is for:

- Testing error handling and recovery
- Simulating Byzantine failures
- Fuzzing protocol parsers
- Verifying defensive checks work

Your nemesis/fault injection (Part 5.3) is one example of this pattern. Make it explicit.

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

  chance(probability: number): boolean {
    return this.next() < probability
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

When a fuzz test fails, minimize the scenario. This is essentially **delta debugging**—systematically minimize failure-inducing inputs while preserving the failure.

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

**Critical constraint**: Shrinking must respect _semantic well-formedness_. Don't delete the begin of a transaction but keep its commit—that's a malformed history. QuickCheck-style shrinkers bake these constraints into their shrink functions.

```typescript
function shrinkTransaction(txn: Transaction): Transaction[] {
  const candidates: Transaction[] = []

  // Can shrink operations, but must keep begin and commit/abort
  for (let i = 0; i < txn.operations.length; i++) {
    candidates.push({
      ...txn,
      operations: [
        ...txn.operations.slice(0, i),
        ...txn.operations.slice(i + 1),
      ],
    })
  }

  // Can shrink values, but must maintain types
  for (let i = 0; i < txn.operations.length; i++) {
    const op = txn.operations[i]
    if (op.type === "assign" && typeof op.value === "number" && op.value > 0) {
      candidates.push({
        ...txn,
        operations: txn.operations.map((o, j) =>
          j === i ? { ...o, value: Math.floor(op.value / 2) } : o
        ),
      })
    }
  }

  return candidates
}
```

**References**:

- [Delta Debugging: Simplifying and Isolating Failure-Inducing Input](https://www.cs.purdue.edu/homes/xyzhang/fall07/Papers/delta-debugging.pdf)
- [QuickCheck: A Lightweight Tool for Random Testing](https://www.cs.tufts.edu/~nr/cs257/archive/john-hughes/quick.pdf)

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

**Important nuance**: This ladder is pedagogically useful but can mislead. The real picture is a _partial order_ with incomparable points:

- "Eventual consistency" isn't one model—there's causal, PRAM, session guarantees, etc.
- Transactional isolation levels and distributed consistency models form different axes.
- Some pairs are incomparable: Snapshot Isolation vs Strict Serializability have different tradeoffs.

Ground your hierarchy in one formalism (e.g., [Adya-style dependency graphs](https://publications.csail.mit.edu/lcs/pubs/pdf/MIT-LCS-TR-786.pdf)) and admit the ladder is a projection.

**Reference**: [A Critique of ANSI SQL Isolation Levels](https://arxiv.org/abs/cs/0701157)

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

### 5.5 Soundness vs Completeness

Formal methods people are allergic to unstated tradeoffs. Every checker makes a choice:

| Property     | Definition                                                 | Tradeoff                                   |
| ------------ | ---------------------------------------------------------- | ------------------------------------------ |
| **Sound**    | Never false positives—if it says "violation," there is one | May miss real bugs (false negatives)       |
| **Complete** | Never false negatives—finds all real bugs in scope         | May flag spurious issues (false positives) |

Most practical checkers are **sound but incomplete**—they guarantee no false alarms but may miss bugs. This is usually the right choice for CI/CD, where false positives erode trust.

**Label your checkers explicitly**:

```typescript
interface Checker<T> {
  name: string
  /**
   * Soundness guarantee:
   * - "sound": no false positives (if returns violation, it's real)
   * - "unsound": may have false positives
   */
  soundness: "sound" | "unsound"
  /**
   * Completeness guarantee:
   * - "complete": finds all violations in scope
   * - "incomplete": may miss some violations
   */
  completeness: "complete" | "incomplete"
  /** What scope/bounds does this checker operate within? */
  scope: string
  check(input: T): CheckResult
}

const serializabilityChecker: Checker<History> = {
  name: "Cycle-based serializability",
  soundness: "sound", // No false positives
  completeness: "incomplete", // May miss predicate-based anomalies
  scope: "Single-key read/write operations",
  check: checkSerializable,
}
```

Elle's claims are carefully scoped—e.g., predicate anomalies are excluded in some contexts. Your guide should teach readers to label their checkers the same way.

**Linearizability is NP-complete**: Checking a history for linearizability is computationally hard in general. That matters because it shapes DSL design: you want histories that are _informative_ (expose dependency structure) but also _checkable_. Practical checkers use heuristics, pruning, and bounded search.

**Reference**: [Testing for Linearizability (Lowe)](https://www.cs.ox.ac.uk/people/gavin.lowe/LinearizabiltyTesting/paper.pdf)

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

## Part 10: Formal Verification Background

Understanding the history of formal verification helps you make better DSL design decisions. Each milestone introduced ideas you can steal for testing work.

### 10.1 Hoare Logic (1969): Contracts and Pre/Post Conditions

**Core idea**: Correctness can be stated as compositional pre/post conditions on program fragments.

Hoare's 1969 paper introduced what became known as Hoare triples `{P} C {Q}`—a way to reason about programs by local reasoning rules. This is the intellectual ancestor of all design-by-contract systems.

**What you can steal**:

- Your DSL steps are essentially commands; you can attach pre/post assertions to each step and have the runner check them as runtime contracts.
- This naturally suggests **assume/guarantee** style scenario blocks: "under these environment assumptions, these guarantees must hold."

```typescript
scenario("transfer-funds")
  .assume({ balance: { gte: 100 } }) // Precondition
  .transaction("t1", { st: 0 })
  .update("balance", increment(-100))
  .guarantee({ balance: { gte: 0 } }) // Postcondition
  .commit({ ct: 5 })
```

**Reference**: [Hoare, "An Axiomatic Basis for Computer Programming" (1969)](https://dl.acm.org/doi/10.1145/363235.363259)

### 10.2 Dijkstra's Guarded Commands (1975): Nondeterminism as a Feature

**Core idea**: Instead of testing after the fact, derive programs from specs using calculational reasoning. Nondeterminism is a first-class modeling tool.

**What you can steal**:

- Treat nondeterminism as a spec feature, not a bug. Your DSL can express "any of these schedules" or "any of these interleavings," and your checker verifies properties across all of them.
- This is why TLA+/model checking work well for distributed systems—nondeterminism is explicit.

```typescript
// Express "any ordering is valid"
scenario("concurrent-writes")
  .anyOrder([
    () => builder.transaction("t1").update("x", assign(1)).commit(),
    () => builder.transaction("t2").update("x", assign(2)).commit(),
  ])
  .verify((result) => result.x === 1 || result.x === 2)
```

**Reference**: [Dijkstra, "Guarded Commands, Nondeterminacy and Formal Derivation of Programs" (1975)](https://dl.acm.org/doi/10.1145/360933.360975)

### 10.3 Abstract Interpretation (1977): Sound Approximation

**Core idea**: Analyze programs by mapping them into an abstract domain that's cheaper to explore, while staying sound (no false negatives for properties you care about).

Cousot & Cousot introduced abstract interpretation as a unified theory of static analysis. It's the philosophical antidote to "we can't hold it all in our heads"—a theory of compressing semantics.

**What you can steal**:

- Your "configurancy layer" is an abstraction boundary. Make it explicit: what observations matter, what internal details are abstracted away.
- Your fuzz generator is selecting points in the abstract domain; your oracle/checker is validating projected properties.

```typescript
// Abstract domain: just track whether value is BOTTOM, ZERO, POSITIVE, NEGATIVE
type AbstractValue = "bottom" | "zero" | "positive" | "negative"

function abstractIncrement(v: AbstractValue, delta: number): AbstractValue {
  if (v === "bottom")
    return delta > 0 ? "positive" : delta < 0 ? "negative" : "zero"
  // ... sound over-approximation
}
```

**Reference**: [Cousot & Cousot, "Abstract Interpretation: A Unified Lattice Model" (1977)](https://www.di.ens.fr/~cousot/publications.www/CousotCousot-POPL-77-ACM-p238--252-1977.pdf)

### 10.4 Temporal Logic (1977): From States to Traces

**Core idea**: For concurrent/distributed systems, correctness is about sequences over time, not just single end states.

Pnueli's 1977 work introduced temporal logic into program reasoning. Lamport later developed TLA ("Temporal Logic of Actions") and emphasized specs as formulas over behaviors.

**What you can steal**:

- Your history-based verification is already trace-thinking. Add explicit mention of **safety vs liveness**:
  - **Safety**: "nothing bad happens" (bad state not reachable)
  - **Liveness**: "something good eventually happens" (progress, no deadlock/starvation)
- Your DSL currently centers safety; nemesis/fault injection introduces liveness bugs (can the system make progress under failure?).

```typescript
// Safety property: no overdraft ever occurs
const noOverdraft: SafetyProperty = (history) =>
  history.every((state) => state.balance >= 0)

// Liveness property: every request eventually completes
const eventualCompletion: LivenessProperty = (history) =>
  history
    .filter((e) => e.type === "request")
    .every((req) =>
      history.some(
        (resp) => resp.type === "response" && resp.requestId === req.id
      )
    )
```

**Reference**: [Pnueli, "The Temporal Logic of Programs" (1977)](https://amturing.acm.org/bib/pnueli_4725172.cfm)

### 10.5 Model Checking (1980s): Exhaustive but Disciplined

**Core idea**: Exhaustively explore a finite state space automatically, find counterexamples you didn't imagine.

Clarke, Emerson, and Sifakis received the 2007 Turing Award for model checking. It became one of the big success stories of formal verification.

**What you can steal**:

- Your fuzzing is "Monte Carlo model checking"—random exploration of the state space.
- Add a **state-space budget** as a first-class concept: max states, max depth, max transactions.
- Model checking wins by producing counterexample traces. Your shrinker is already trying to get there—lean into that.

```typescript
interface ExplorationBudget {
  maxStates: number
  maxDepth: number
  maxTransactions: number
  timeoutMs: number
}

function explore(
  initial: State,
  budget: ExplorationBudget
): Counterexample | null {
  const visited = new Set<StateHash>()
  const queue: Array<{ state: State; trace: Step[] }> = [
    { state: initial, trace: [] },
  ]

  while (queue.length > 0 && visited.size < budget.maxStates) {
    const { state, trace } = queue.shift()!
    if (violatesInvariant(state)) {
      return { trace, finalState: state }
    }
    for (const next of successors(state)) {
      if (!visited.has(hash(next))) {
        visited.add(hash(next))
        queue.push({ state: next, trace: [...trace, lastStep] })
      }
    }
  }
  return null
}
```

**Reference**: [Clarke, Emerson, Sifakis, "Model Checking" (2007 Turing Award)](https://www-verimag.imag.fr/~sifakis/TuringAwardPaper-Apr14.pdf)

### 10.6 SAT/SMT and Bounded Model Checking (2000s): Verification Meets Constraint Solving

**Core idea**: Translate bounded executions into SAT/SMT and let solvers find counterexamples.

Bounded model checking (BMC) is a key bridge: you don't explore the whole system, you explore all behaviors up to depth _k_ using solvers. Then CEGAR (counterexample-guided abstraction refinement) turns this into a loop: start abstract, get a counterexample, refine if spurious, repeat.

**What you can steal**:

- Your "shrinking failing cases" is a cousin of CEGAR: refining toward the smallest real counterexample.
- Consider making the checker explain failures in a solver-friendly way (constraints, witnesses), not just "expected vs got."

A killer example in your domain: **Cobra** uses SMT to check serializability for transactional KV stores at scale. It's "Elle + solver horsepower + engineering."

```typescript
// Encode serializability as constraints
function encodeAsConstraints(history: History): SMTFormula {
  const constraints: Clause[] = []

  // For each pair of transactions, one must come before the other
  for (const t1 of history.transactions) {
    for (const t2 of history.transactions) {
      if (t1.id !== t2.id) {
        constraints.push(or(before(t1, t2), before(t2, t1)))
      }
    }
  }

  // Dependencies must be respected
  for (const edge of buildDependencyEdges(history)) {
    constraints.push(before(edge.from, edge.to))
  }

  return and(...constraints) // SAT iff serializable
}
```

**References**:

- [Bounded Model Checking (CMU)](https://www.cs.cmu.edu/~emc/papers/Books%20and%20Edited%20Volumes/Bounded%20Model%20Checking.pdf)
- [CEGAR (Stanford)](https://web.stanford.edu/class/cs357/cegar.pdf)
- [Cobra: Verifiably Serializable KV Stores (OSDI '20)](https://www.usenix.org/conference/osdi20/presentation/tan)

### 10.7 Alloy and the Small Scope Hypothesis (2000s)

**Core idea**: Most design bugs show up in small counterexamples; search small scopes exhaustively.

Daniel Jackson's Alloy work popularized this: you don't prove, you _find counterexamples fast_ within a bound, guided by the "small scope hypothesis."

**What you can steal**:

- Your "start simple, add complexity" is the same tactic.
- Make **scope** explicit in DSL and fuzz configs: number of transactions, keys, concurrency degree, failure injections.
- Consider an "exhaust small scope" mode in addition to fuzzing—surprisingly potent.

```typescript
// Exhaustively test all scenarios with ≤3 transactions, ≤2 keys
function exhaustSmallScope(): void {
  for (const numTxns of [1, 2, 3]) {
    for (const numKeys of [1, 2]) {
      for (const scenario of generateAllScenarios(numTxns, numKeys)) {
        const result = executeScenario(scenario, store())
        expect(result.valid).toBe(true)
      }
    }
  }
}
```

**Reference**: [Jackson, "Alloy: A Language and Tool for Exploring Software Designs" (2019)](https://groups.csail.mit.edu/sdg/pubs/2019/alloy-cacm-18-feb-22-2019.pdf)

### 10.8 Refinement Proofs: seL4 and CompCert

**Core idea**: Prove that an implementation _refines_ a spec; then properties proven about the spec carry to the implementation.

- **seL4**: Formally verified OS kernel using refinement across multiple specification layers.
- **CompCert**: Formally verified C compiler demonstrating semantic preservation across compilation.

**What you can steal**:

- Your "ReferenceStore" section is a testing analog of refinement: implementation should match a simpler model.
- Formalize this: define a refinement relation `R(impl_state, spec_state)` and check it dynamically after each step. That gives you localization: the failure happens at the first step where `R` breaks.

```typescript
interface RefinementCheck<ImplState, SpecState> {
  abstract(impl: ImplState): SpecState
  equivalent(impl: ImplState, spec: SpecState): boolean
}

function checkRefinement<I, S>(
  impl: Store<I>,
  spec: Store<S>,
  scenario: ScenarioDefinition,
  refinement: RefinementCheck<I, S>
): { valid: boolean; failingStep?: number } {
  for (let i = 0; i < scenario.steps.length; i++) {
    executeStep(impl, scenario.steps[i])
    executeStep(spec, scenario.steps[i])

    if (!refinement.equivalent(impl.getState(), spec.getState())) {
      return { valid: false, failingStep: i }
    }
  }
  return { valid: true }
}
```

**References**:

- [seL4: Formal Verification of an OS Kernel (2009)](https://read.seas.harvard.edu/~kohler/class/cs260r-17/klein10sel4.pdf)
- [CompCert: Formal Verification of a Realistic Compiler (2009)](https://xavierleroy.org/publi/compcert-CACM.pdf)

### 10.9 Industrial Adoption: TLA+ at Amazon

The AWS experience reports are worth calling out: complicated distributed systems produce subtle bugs that tests miss; a small spec can catch them earlier.

**What you can steal**:

- Treat the DSL as a _design tool_ as much as a test tool. The spec is not post-hoc documentation; it's how you think.
- Amazon found TLA+ caught bugs in DynamoDB, S3, EBS, and other services—bugs that extensive testing had missed.

**Reference**: [How Amazon Web Services Uses Formal Methods (2015)](https://dl.acm.org/doi/10.1145/2699417)

---

## Part 11: Choosing Your Specification Style

There are stable "spec shapes," and picking one early prevents later pain.

### 11.1 Operational Spec (State Machine / Interpreter)

**Shape**: An executable model that steps through states.

```typescript
function interpret(state: State, command: Command): State {
  switch (command.type) {
    case "assign":
      return { ...state, [command.key]: command.value }
    case "increment":
      return {
        ...state,
        [command.key]: (state[command.key] ?? 0) + command.delta,
      }
    case "delete":
      const { [command.key]: _, ...rest } = state
      return rest
  }
}
```

**Pros**: Easy to execute, easy to diff-test, natural for DSL runners.
**Cons**: Can obscure invariants in procedural logic.
**Best for**: Implementation reference, fuzz oracle.

### 11.2 Axiomatic/Declarative Spec (Constraints on Histories)

**Shape**: Properties that must hold over execution traces.

```typescript
// "Snapshot isolation" as a constraint on histories
function satisfiesSnapshotIsolation(history: History): boolean {
  // No write-write conflicts between concurrent transactions
  for (const t1 of history.transactions) {
    for (const t2 of history.transactions) {
      if (t1.id !== t2.id && overlap(t1, t2)) {
        if (writeConflict(t1, t2)) return false
      }
    }
  }
  // Each transaction's reads are consistent with some snapshot
  for (const txn of history.transactions) {
    if (!readsFromConsistentSnapshot(txn, history)) return false
  }
  return true
}
```

**Pros**: Natural for isolation/consistency; matches Adya/Elle style.
**Cons**: Harder to execute directly; often needs solvers for checking.
**Best for**: Consistency model verification, anomaly detection.

### 11.3 Algebraic/Equational Spec (Laws of Operators)

**Shape**: Equations that operators must satisfy.

```typescript
// Merge forms a semilattice
const mergeLaws = {
  commutativity: (a, b) => equal(merge(a, b), merge(b, a)),
  associativity: (a, b, c) =>
    equal(merge(merge(a, b), c), merge(a, merge(b, c))),
  idempotence: (a) => equal(merge(a, a), a), // For applicable types
}

// Apply effect is monotonic
const applyLaws = {
  identity: (v) => equal(apply(v, BOTTOM), v),
  composition: (v, e1, e2) =>
    equal(apply(apply(v, e1), e2), apply(v, compose(e1, e2))),
}
```

**Pros**: Perfect for CRDT-ish merge/effect algebras; enables algebraic property testing.
**Cons**: Not all systems have clean algebraic structure.
**Best for**: Merge semantics, effect composition, conflict resolution.

### 11.4 Hybrid Approaches

Mature systems usually need _more than one_ spec style, connected by refinement/simulation arguments. That's the seL4 lesson: multiple abstraction layers, each with its own spec style, with proofs that adjacent layers refine correctly.

For your transactional store DSL:

| Component          | Best Spec Style | Why                                       |
| ------------------ | --------------- | ----------------------------------------- |
| Effect application | Algebraic       | Clean equations for merge, apply, compose |
| Transaction model  | Operational     | State machine semantics                   |
| Isolation checking | Axiomatic       | Constraints over histories (Adya-style)   |
| Store interface    | Operational     | Reference implementation for diff-testing |

---

## Part 12: Case Study - Applying This Guide to Itself

We applied the techniques in this guide to the `txn-spec` DSL itself. This section documents what we learned—both validations of the approach and surprises.

### 12.1 Exhaustive Testing Found a Real Spec/Implementation Gap

**Technique used**: Small-scope exhaustive testing (Section 10.7)

We wrote exhaustive boundary tests for the visibility rule (OTSP):

```typescript
// Test ALL combinations of commitTs and snapshotTs from 0-5
for (let commitTs = 1; commitTs <= 5; commitTs++) {
  for (let snapshotTs = 0; snapshotTs <= 5; snapshotTs++) {
    const shouldSee = snapshotTs > commitTs // What we discovered

    it(`commit@${commitTs} ${shouldSee ? "visible" : "invisible"} at snapshot@${snapshotTs}`, () => {
      const s = scenario("boundary")
        .transaction("writer", { st: 0 })
        .update("x", assign(100))
        .commit({ ct: commitTs })
        .transaction("reader", { st: snapshotTs })
        .readExpect("x", shouldSee ? 100 : BOTTOM)
        .commit({ ct: 10 })
        .build()

      expect(executeScenario(s, createMapStore()).success).toBe(true)
    })
  }
}
```

**What we found**: The spec said `T1.commitTs ≤ T2.snapshotTs` for visibility, but the implementation uses strict `<`. A transaction at `snapshotTs=5` does NOT see commits at `commitTs=5`.

This is exactly the kind of boundary bug that's invisible to random fuzzing (low probability of hitting exact boundaries) but obvious to exhaustive enumeration. The small-scope hypothesis paid off.

**Lesson**: Fuzz testing alone isn't enough. Add exhaustive coverage for small scopes, especially around boundary conditions.

### 12.2 Two-Tier DSL Pattern in Practice

**Technique used**: Two-tier language design (Section 2.4)

We implemented both tiers:

**Tier 1 (Typed Builder)** - for well-formed scenarios:

```typescript
// The builder prevents nonsense at compile time
scenario("normal-operation")
  .transaction("t1", { st: 0 })
  .update("x", assign(10))
  .commit({ ct: 5 }) // Can only commit an active transaction
  .build()
```

**Tier 2 (Raw Events)** - for adversarial testing:

```typescript
// Direct event injection bypasses all safety checks
function executeRawEvents(events: RawEvent[]): {
  success: boolean
  error?: Error
  results: unknown[]
} {
  const coordinator = createTransactionCoordinator(store, tsGen)
  for (const event of events) {
    switch (event.type) {
      case "begin":
        coordinator.begin(event.txnId, { st: event.snapshotTs ?? 0 })
        break
      case "commit":
        coordinator.commit(event.txnId, { ct: event.commitTs ?? 100 })
        break
      // ... etc
    }
  }
}

// Now we can test malformed sequences
const result = executeRawEvents([
  { type: "begin", txnId: "t1", snapshotTs: 0 },
  { type: "commit", txnId: "t1", commitTs: 5 },
  { type: "commit", txnId: "t1", commitTs: 10 }, // Double commit!
])
expect(result.success).toBe(false)
expect(result.error?.message).toMatch(/not running|already|committed/i)
```

**What we tested with Tier 2**:

- Double commits (C2 violation)
- Operations after commit/abort (C3 violation)
- Operations on non-existent transactions
- Duplicate transaction IDs

**Lesson**: The typed builder made it _impossible_ to accidentally write these malformed cases in normal tests. We needed a separate escape hatch to test error handling. Keep both tiers explicit.

### 12.3 Bidirectional Enforcement Checklist

**Technique used**: Spec shape awareness (Part 11) + enforcement tracking

We created a bidirectional checklist in SPEC.md:

**Doc → Code**: Is each invariant actually enforced?

| Invariant              | Types         | Runtime          | Tests         |
| ---------------------- | ------------- | ---------------- | ------------- |
| I1: Snapshot Isolation | -             | ✓ Store lookup   | ✓ conformance |
| I5: Effect Composition | ✓ Effect type | ✓ composeEffects | ✓ algebraic   |
| I6: Effect Merge       | -             | ✓ mergeEffects   | ✓ algebraic   |
| I8: OTSP Visibility    | -             | ✓ Store lookup   | ✓ exhaustive  |

**Code → Doc**: Is each test derived from spec?

| Test File                | Spec Section            | Coverage            |
| ------------------------ | ----------------------- | ------------------- |
| conformance.test.ts      | Affordances, Invariants | Core behavior       |
| merge-properties.test.ts | I6 (CAI properties)     | 203 algebraic laws  |
| exhaustive.test.ts       | I8 boundary             | All timestamp pairs |
| adversarial.test.ts      | Constraints C2, C3      | Error handling      |

**Gaps identified**:

| Gap                | Status     | Action Taken                 |
| ------------------ | ---------- | ---------------------------- |
| C4 (numeric check) | Not tested | Added to adversarial.test.ts |
| Adversarial inputs | Not tested | Created adversarial.test.ts  |

**Lesson**: The checklist revealed that "adversarial inputs" was listed as a gap. This directly motivated creating the Tier 2 DSL. Bidirectional verification isn't just bookkeeping—it drives development.

### 12.4 Refinement Checking Between Implementations

**Technique used**: Refinement proofs (Section 10.8), adapted to testing

We have two store implementations: `MapStore` (simple reference) and `StreamStore` (optimized). We verify they're equivalent:

```typescript
function checkRefinement(
  referenceFactory: () => StoreInterface,
  implementationFactory: () => StoreInterface,
  operations: Operation[]
): RefinementResult {
  const refStore = referenceFactory()
  const implStore = implementationFactory()
  const refCoord = createTransactionCoordinator(refStore, tsGen())
  const implCoord = createTransactionCoordinator(implStore, tsGen())

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]

    // Execute on both
    executeOp(refCoord, op)
    executeOp(implCoord, op)

    // After each commit, check refinement
    if (op.type === "commit") {
      const refSnapshot = getStoreSnapshot(refStore, allKeys, maxTs)
      const implSnapshot = getStoreSnapshot(implStore, allKeys, maxTs)

      if (!snapshotsEqual(refSnapshot, implSnapshot)) {
        return {
          valid: false,
          failingStep: i,
          failingOperation: `${op.type}(${op.txnId})`,
        }
      }
    }
  }
  return { valid: true }
}
```

**Key insight**: Refinement checking gives you _localization_. When a test fails, you know exactly which step diverged. This is vastly better than "final state doesn't match."

We run this against fuzz-generated scenarios:

```typescript
for (const seed of [100, 200, 300, 400, 500]) {
  it(`random scenario (seed=${seed}) refines correctly`, () => {
    const scenario = generateRandomScenario({ seed, transactionCount: 5 })
    const result = checkRefinement(
      createMapStore,
      createStreamStore,
      scenario.operations
    )
    expect(result.valid).toBe(true)
  })
}
```

**Lesson**: Refinement checking is the testing analog of refinement proofs. If you have a "reference implementation" and an "optimized implementation," check them step-by-step, not just at the end.

### 12.5 Checker Metadata with Soundness/Completeness Labels

**Technique used**: Soundness vs completeness labeling (Section 5.5)

We added explicit metadata to our consistency checkers:

```typescript
export interface CheckerMetadata {
  name: string
  soundness: "sound" | "unsound"
  completeness: "complete" | "incomplete"
  scope: string
  limitations: string[]
}

export const SERIALIZABILITY_CHECKER: CheckerMetadata = {
  name: "Cycle-based Serializability",
  soundness: "sound",
  completeness: "incomplete",
  scope: "Single-key read/write operations with known commit order",
  limitations: [
    "Predicate-based anomalies (e.g., phantom reads)",
    "Multi-key constraints",
    "Operations without explicit read/write logging",
  ],
}
```

The formatted output now includes these labels:

```
Checker: Cycle-based Serializability
  Soundness: sound
  Completeness: incomplete
  Scope: Single-key read/write operations with known commit order

INVALID: Consistency violation detected
  Type: cycle
  Cycle: t1 -> t2 -> t1
  ...

Note: This checker has limitations:
  - Predicate-based anomalies (e.g., phantom reads)
  - Multi-key constraints
```

**Lesson**: Labeling checkers prevents overconfidence. When someone sees "VALID," they know exactly what was checked and what wasn't.

### 12.6 Summary: What Worked

| Technique                     | Section | Outcome                                  |
| ----------------------------- | ------- | ---------------------------------------- |
| Exhaustive small-scope        | 10.7    | Found real spec/impl boundary bug        |
| Two-tier DSL                  | 2.4     | Clean separation of valid vs adversarial |
| Bidirectional checklist       | 11.4    | Revealed gaps, drove test creation       |
| Refinement checking           | 10.8    | Step-by-step equivalence verification    |
| Soundness/completeness labels | 5.5     | Clear checker guarantees                 |

**Meta-lesson**: These techniques are synergistic. The checklist identified gaps → we built adversarial DSL → we ran exhaustive tests → we found a real bug → we fixed the spec. Each technique fed the next.

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

### Testing Tools & Frameworks

- [Jepsen](https://jepsen.io) - Distributed systems testing
- [Elle](https://github.com/jepsen-io/elle) - Black-box transactional consistency checker
- [QuickCheck](https://hackage.haskell.org/package/QuickCheck) - Property-based testing origin
- [Hypothesis](https://hypothesis.readthedocs.io/) - Python property-based testing
- [Hermitage](https://github.com/ept/hermitage) - Testing transaction isolation levels
- [Delta Debugging](https://www.cs.purdue.edu/homes/xyzhang/fall07/Papers/delta-debugging.pdf) - Simplifying failure-inducing input

### Formal Specification Languages

- [TLA+](https://lamport.azurewebsites.net/tla/tla.html) - Formal specification language
- [Alloy](https://alloytools.org/) - Relational logic modeling
- CobbleDB Paper: "Formalising Transactional Storage Systems" - Formal transactional storage specification (ASPLOS '23)

### Foundational Papers

- [Hoare, "An Axiomatic Basis for Computer Programming" (1969)](https://dl.acm.org/doi/10.1145/363235.363259)
- [Dijkstra, "Guarded Commands" (1975)](https://dl.acm.org/doi/10.1145/360933.360975)
- [Cousot & Cousot, "Abstract Interpretation" (1977)](https://www.di.ens.fr/~cousot/publications.www/CousotCousot-POPL-77-ACM-p238--252-1977.pdf)
- [Pnueli, "Temporal Logic of Programs" (1977)](https://amturing.acm.org/bib/pnueli_4725172.cfm)

### Verification Techniques

- [Clarke, Emerson, Sifakis, "Model Checking" (2007 Turing Award)](https://www-verimag.imag.fr/~sifakis/TuringAwardPaper-Apr14.pdf)
- [Bounded Model Checking (CMU)](https://www.cs.cmu.edu/~emc/papers/Books%20and%20Edited%20Volumes/Bounded%20Model%20Checking.pdf)
- [CEGAR (Stanford)](https://web.stanford.edu/class/cs357/cegar.pdf)
- [Testing for Linearizability (Lowe)](https://www.cs.ox.ac.uk/people/gavin.lowe/LinearizabiltyTesting/paper.pdf)

### Industrial Applications

- [How Amazon Web Services Uses Formal Methods (2015)](https://dl.acm.org/doi/10.1145/2699417)
- [Cobra: Verifiably Serializable KV Stores (OSDI '20)](https://www.usenix.org/conference/osdi20/presentation/tan)
- [seL4: Formal Verification of an OS Kernel (2009)](https://read.seas.harvard.edu/~kohler/class/cs260r-17/klein10sel4.pdf)
- [CompCert: Formal Verification of a Realistic Compiler (2009)](https://xavierleroy.org/publi/compcert-CACM.pdf)
- [Jackson, "Alloy" (2019)](https://groups.csail.mit.edu/sdg/pubs/2019/alloy-cacm-18-feb-22-2019.pdf)

### Consistency & Isolation

- [Adya, "Weak Consistency" (MIT TR-786)](https://publications.csail.mit.edu/lcs/pubs/pdf/MIT-LCS-TR-786.pdf)
- [A Critique of ANSI SQL Isolation Levels](https://arxiv.org/abs/cs/0701157)
- [Elle: Inferring Isolation Anomalies (VLDB '20)](https://www.vldb.org/pvldb/vol14/p268-alvaro.pdf)
