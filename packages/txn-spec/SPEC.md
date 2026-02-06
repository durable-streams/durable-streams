# Transactional Storage Specification

This document defines the behavior of transactional storage systems implementing the `txn-spec` DSL. It serves as the **configurancy layer**—the shared understanding that allows multiple agents (human and AI) to coherently work with this system.

Based on: "Formalising Transactional Storage Systems" (CobbleDB, ASPLOS 2026)

---

## Core Concepts

### Values and Bottom

- **Value**: Any JSON-serializable data (number, string, boolean, object, array, null)
- **Bottom (⊥)**: Represents "no value" / "undefined" / "deleted". Distinct from `null`.

### Effects

Effects are transformations on values. They are the primitive building blocks of transactions.

| Effect        | Notation     | Behavior                                                  |
| ------------- | ------------ | --------------------------------------------------------- |
| **Assign**    | `δ_assign_v` | Constant function: always returns `v` regardless of input |
| **Increment** | `δ_incr_n`   | Adds `n` to the current numeric value                     |
| **Delete**    | `δ_delete`   | Sets value to ⊥                                           |

### Transactions

A transaction is a sequence of operations that execute atomically.

- **Begin**: Start a transaction with a snapshot timestamp
- **Update**: Apply an effect to a key
- **Read**: Observe the value of a key
- **Commit**: Make all updates visible at a commit timestamp
- **Abort**: Discard all updates

---

## Affordances (What You Can Do)

### A1: Create Transactions

You can begin a transaction at any snapshot timestamp `st`. The transaction sees a consistent snapshot of all commits where `commitTs ≤ st`.

### A2: Read Keys

Within a transaction, you can read any key. Reading returns:

- The value from committed transactions visible at your snapshot
- Your own uncommitted writes (read-your-writes)
- ⊥ if the key has never been assigned or was deleted

### A3: Update Keys

Within a transaction, you can apply effects to keys:

- `assign(v)`: Set key to value `v`
- `increment(n)`: Add `n` to current numeric value
- `del()`: Delete the key

### A4: Commit or Abort

You can commit (making updates permanent) or abort (discarding updates).

### A5: Concurrent Transactions

Multiple transactions can execute concurrently. Their effects merge according to the merge rules.

---

## Invariants (What You Can Rely On)

### I1: Snapshot Isolation

A transaction sees a **consistent snapshot** at its snapshot timestamp. Concurrent commits do not affect reads within the transaction.

```
Transaction T1 (st=5):
  read(x) → 10    # Sees value at time 5

Transaction T2 (st=5, ct=7):
  update(x, assign(20))
  commit()

Transaction T1:
  read(x) → 10    # Still sees 10, not 20
```

### I2: Read Your Own Writes

A transaction always sees its own uncommitted updates.

```
Transaction T1:
  read(x) → ⊥
  update(x, assign(10))
  read(x) → 10    # Sees own write
```

### I3: Atomic Commits

All updates in a committed transaction become visible atomically at the commit timestamp. There is no state where some updates are visible and others are not.

### I4: Aborted Transactions Have No Effect

If a transaction aborts, none of its updates are visible to any other transaction.

### I5: Effect Composition (Sequential)

Within a transaction, effects compose sequentially:

| First          | Then           | Result             |
| -------------- | -------------- | ------------------ |
| `assign(x)`    | `assign(y)`    | `assign(y)`        |
| `assign(x)`    | `increment(n)` | `assign(x + n)`    |
| `assign(x)`    | `delete`       | `delete`           |
| `increment(a)` | `increment(b)` | `increment(a + b)` |
| `delete`       | `assign(x)`    | `assign(x)`        |
| `delete`       | `increment(n)` | `delete`           |

### I6: Effect Merge (Concurrent)

When concurrent transactions commit effects to the same key, effects **merge**:

**Merge Properties:**

- **Commutative**: `merge(a, b) = merge(b, a)`
- **Associative**: `merge(merge(a, b), c) = merge(a, merge(b, c))`
- **Identity**: `merge(⊥, a) = a`

**Merge Rules:**

| Effect A       | Effect B       | merge(A, B)                      |
| -------------- | -------------- | -------------------------------- |
| `increment(a)` | `increment(b)` | `increment(a + b)`               |
| `assign(x)`    | `assign(y)`    | Last-writer-wins (deterministic) |
| `delete`       | `delete`       | `delete`                         |
| `delete`       | `increment(n)` | `increment(n)` (increment wins)  |
| `delete`       | `assign(x)`    | `assign(x)` (assign wins)        |
| `assign(x)`    | `increment(n)` | `assign(x + n)`                  |

### I7: Timestamp Ordering

For any committed transaction: `snapshotTs < commitTs`

### I8: Visibility Rule (OTSP)

Transaction T2 sees transaction T1's effects if and only if:
`T1.commitTs < T2.snapshotTs`

This is the **Ordered Timestamp Pair (OTSP)** rule. Note: The implementation uses **strict inequality** (`<`), meaning a transaction at snapshotTs=5 does NOT see commits at commitTs=5. This was verified through exhaustive boundary testing.

### I9: Increment on Bottom

`increment(n)` applied to ⊥ returns `n` (treats ⊥ as 0).

This enables counter CRDT semantics: concurrent increments without a common predecessor still sum correctly.

```
T1 (st=0): update(x, assign(0)), commit(ct=1)
T2 (st=2): update(x, increment(5)), commit(ct=10)
T3 (st=2): update(x, increment(3)), commit(ct=11)
T4 (st=15): read(x) → 8   # 0 + 5 + 3
```

---

## Constraints (What You Cannot Do)

### C1: No Time Travel

You cannot commit at a timestamp less than or equal to your snapshot timestamp.
`commitTs > snapshotTs` (strictly greater)

### C2: No Double Commit

A transaction can only be committed once. Attempting to commit an already-committed transaction is an error.

### C3: No Operations After Commit/Abort

Once a transaction is committed or aborted, no further operations are allowed on it.

### C4: Increment Requires Numeric

`increment(n)` on a non-numeric value (other than ⊥) throws an error.

### C5: No Nested Transactions

Transactions cannot be nested. Each transaction is independent.

---

## Semantic Decisions

These are implementation choices where the paper was ambiguous or we made pragmatic decisions:

### SD1: Increment on Bottom Returns Delta

**Decision**: `increment(n)` applied to ⊥ returns `n`, not ⊥.

**Rationale**: Enables counter CRDT semantics. Concurrent increments work without requiring all transactions to see a common assignment.

**Alternative**: Could return ⊥ (undefined + n = undefined). We chose additive semantics.

### SD2: Last-Writer-Wins for Concurrent Assigns

**Decision**: When concurrent transactions assign different values to the same key, we use deterministic comparison (JSON string comparison) to pick the winner.

**Rationale**: Ensures merge is commutative and deterministic without requiring vector clocks.

**Alternative**: Could use timestamps, but concurrent transactions may have the same commit time.

### SD3: Delete Has Lowest Precedence in Merge

**Decision**: When merging delete with assign or increment, delete loses.

**Rationale**: "Add wins" semantics from CRDT literature. Deleting and adding concurrently results in the value existing.

---

## Test Vectors

These examples are derived from the paper and serve as conformance tests.

### TV1: Basic Read-Write

```
T1 (st=0): update(x, assign(10)), commit(ct=5)
T2 (st=6): read(x) → 10
```

### TV2: Snapshot Isolation

```
T1 (st=0): update(x, assign(0)), commit(ct=1)
T2 (st=5): read(x) → 0
T3 (st=5): update(x, assign(1)), commit(ct=6)
T2: read(x) → 0   # Still sees 0
T2: commit(ct=10)
```

### TV3: Concurrent Increments (n-way merge)

```
T1 (st=0): update(x, assign(0)), commit(ct=1)
T2 (st=2): update(x, increment(10)), commit(ct=10)
T3 (st=2): update(x, increment(20)), commit(ct=11)
T4 (st=2): update(x, increment(30)), commit(ct=12)
T5 (st=15): read(x) → 60   # 0 + 10 + 20 + 30
```

### TV4: Concurrent Assign (LWW)

```
T1 (st=0): update(x, assign("a")), commit(ct=5)
T2 (st=0): update(x, assign("b")), commit(ct=6)
T3 (st=10): read(x) → "b"   # Deterministic winner
```

### TV5: Delete vs Increment

```
T1 (st=0): update(x, assign(50)), commit(ct=1)
T2 (st=2): update(x, delete()), commit(ct=10)
T3 (st=2): update(x, increment(10)), commit(ct=11)
T4 (st=15): read(x) → 60   # 50 + 10, increment wins
```

### TV6: Read Own Writes

```
T1 (st=0):
  read(x) → ⊥
  update(x, assign(42))
  read(x) → 42
  update(x, increment(8))
  read(x) → 50
  commit(ct=10)
```

### TV7: Aborted Transaction

```
T1 (st=0): update(x, assign(10)), commit(ct=5)
T2 (st=6): update(x, assign(99)), abort()
T3 (st=10): read(x) → 10   # T2's update not visible
```

---

## Consistency Model

This specification implements **Snapshot Isolation (SI)** with the following properties:

1. **No Dirty Reads**: Transactions only see committed data
2. **No Non-Repeatable Reads**: Within a transaction, reads are stable
3. **No Phantom Reads**: The snapshot is fixed at begin time
4. **Write Skew Possible**: SI does not prevent all anomalies

For **Serializable** isolation, additional checks (like write-write conflict detection) would be needed.

---

## Safety vs Liveness

Following temporal logic conventions, we categorize properties:

### Safety Properties ("Nothing Bad Happens")

These properties can be violated by a finite trace. If violated, we can point to the exact moment it went wrong.

| Property                   | Description                      | Invariant |
| -------------------------- | -------------------------------- | --------- |
| **No Double Commit** (C2)  | Transaction commits at most once | I3        |
| **Snapshot Consistency**   | Reads within a txn are stable    | I1        |
| **Atomic Visibility**      | All-or-nothing commit            | I3        |
| **Timestamp Ordering**     | commitTs > snapshotTs            | I7, C1    |
| **Effect Well-Formedness** | Increments on non-numeric fail   | C4        |

### Liveness Properties ("Something Good Eventually Happens")

These require infinite traces to verify. We currently focus on safety; liveness would apply to distributed/async extensions.

| Property                 | Description                                    | Status                      |
| ------------------------ | ---------------------------------------------- | --------------------------- |
| **Transaction Progress** | Every transaction eventually commits or aborts | Not specified (single-node) |
| **Conflict Resolution**  | Concurrent writes eventually merge             | Implicit in merge rules     |

**Current scope**: This spec focuses on safety properties. Liveness properties become relevant when extending to distributed systems with network partitions, crash recovery, etc.

---

## Specification Shapes

This specification uses multiple "spec shapes" for different components:

| Component           | Spec Shape  | Why                                                |
| ------------------- | ----------- | -------------------------------------------------- |
| **Effects**         | Algebraic   | Clean equations for composition and merge (I5, I6) |
| **Transactions**    | Operational | State machine: pending → committed \| aborted      |
| **Isolation**       | Axiomatic   | Constraints on observable histories (I1, I8)       |
| **Store Interface** | Operational | Reference implementation for diff-testing          |

### Algebraic (Effects)

Effects satisfy algebraic laws that can be tested exhaustively:

```
Merge Laws:
  merge(a, b) = merge(b, a)                    // Commutativity
  merge(merge(a, b), c) = merge(a, merge(b, c)) // Associativity
  merge(⊥, a) = a                              // Identity

Compose Laws:
  compose(compose(a, b), c) = compose(a, compose(b, c)) // Associativity
```

### Operational (Transactions)

Transaction lifecycle as a state machine:

```
         begin(st)
            │
            ▼
       ┌─────────┐
       │ pending │──────────────┐
       └────┬────┘              │
            │                   │
      ┌─────┴─────┐        abort()
      │           │             │
  commit(ct)      │             │
      │           │             ▼
      ▼           │      ┌──────────┐
┌───────────┐     │      │ aborted  │
│ committed │     │      └──────────┘
└───────────┘     │
                  └──────────────────────────
```

### Axiomatic (Isolation)

Isolation expressed as constraints on histories (Adya-style):

```
Snapshot Isolation:
  ∀ T1, T2: concurrent(T1, T2) ∧ writeSet(T1) ∩ writeSet(T2) ≠ ∅
    → conflict detected (abort one)

  ∀ T, read r in T:
    value(r) = latest write where write.commitTs ≤ T.snapshotTs
```

---

## Enforcement Checklist

Bidirectional verification that spec and implementation match.

### Doc → Code: Is Each Invariant Enforced?

| Invariant               | Types         | Runtime          | Tests          | Notes     |
| ----------------------- | ------------- | ---------------- | -------------- | --------- |
| I1: Snapshot Isolation  | -             | ✓ Store lookup   | ✓ conformance  |           |
| I2: Read Own Writes     | -             | ✓ Txn buffer     | ✓ conformance  |           |
| I3: Atomic Commits      | -             | ✓ Store.commit   | ✓ conformance  |           |
| I4: Aborted No Effect   | -             | ✓ Skip in lookup | ✓ conformance  |           |
| I5: Effect Composition  | ✓ Effect type | ✓ composeEffects | ✓ algebraic    |           |
| I6: Effect Merge        | -             | ✓ mergeEffects   | ✓ algebraic    | 203 tests |
| I7: Timestamp Ordering  | -             | ✓ Coordinator    | ✓ spec-vectors |           |
| I8: OTSP Visibility     | -             | ✓ Store lookup   | ✓ conformance  |           |
| I9: Increment on Bottom | -             | ✓ applyEffect    | ✓ spec-vectors |           |

### Code → Doc: Is Each Test Derived From Spec?

| Test File                | Spec Section            | Coverage           |
| ------------------------ | ----------------------- | ------------------ |
| conformance.test.ts      | Affordances, Invariants | Core behavior      |
| merge-properties.test.ts | I6 (CAI properties)     | Algebraic laws     |
| spec-vectors.test.ts     | Test Vectors TV1-TV7    | Paper examples     |
| history.test.ts          | Consistency Model       | SI/Serializability |
| fuzz.test.ts             | All                     | Random exploration |

### Gaps

| Gap                   | Status       | Notes                       |
| --------------------- | ------------ | --------------------------- |
| C4 (numeric check)    | Not tested   | Need error case tests       |
| Adversarial inputs    | Not tested   | Need malformed scenario DSL |
| Multi-key constraints | Out of scope | Single-key only             |
| Predicate anomalies   | Out of scope | Checker limitation          |

---

## Version History

| Version | Date    | Changes                                       |
| ------- | ------- | --------------------------------------------- |
| 0.1.0   | 2026-02 | Initial specification based on CobbleDB paper |

---

## References

- CobbleDB: "Formalising Transactional Storage Systems" (ASPLOS 2026)
- Adya, A. "Weak Consistency: A Generalized Theory and Optimistic Implementations for Distributed Transactions"
- Shapiro et al. "Conflict-free Replicated Data Types"
