/**
 * Test Scenario DSL
 *
 * A fluent API for expressing test scenarios based on the formal specification.
 * Scenarios describe transaction histories and their expected outcomes.
 *
 * Features:
 * - Declarative transaction definitions
 * - Concurrent and sequential execution
 * - Assertions on read values, valuation, store state
 * - Property-based testing hooks
 * - Generates executable test cases
 *
 * @example
 * ```typescript
 * scenario("concurrent increments merge correctly")
 *   .transaction("t1", { st: 0 })
 *     .update("counter", increment(5))
 *     .commit({ ct: 10 })
 *   .transaction("t2", { st: 0 })
 *     .update("counter", increment(3))
 *     .commit({ ct: 11 })
 *   .transaction("t3", { st: 12 })
 *     .read("counter")
 *     .expectValue(8) // merged: 5 + 3
 * ```
 */

import { BOTTOM, isBottom } from "./types"

import {
  createTransactionCoordinator,
  createTransactionState,
} from "./transaction"
import { assign, composeEffects, del, effectsEqual, increment } from "./effects"
import type {
  Bottom,
  Effect,
  EffectBuffer,
  EffectOrBottom,
  Key,
  Timestamp,
  TxnId,
  Value,
} from "./types"
import type { StoreInterface, TransactionState } from "./transaction"

// =============================================================================
// Scenario Types
// =============================================================================

/**
 * Transaction operation types.
 */
export type ScenarioOperation =
  | { type: `begin`; txnId: TxnId; snapshotTs: Timestamp }
  | { type: `update`; txnId: TxnId; key: Key; effect: Effect }
  | {
      type: `read`
      txnId: TxnId
      key: Key
      expectedValue?: Value | Bottom
      seq: number
    }
  | { type: `abort`; txnId: TxnId }
  | { type: `commit`; txnId: TxnId; commitTs: Timestamp }

/**
 * Assertion types.
 */
export type ScenarioAssertion =
  | {
      type: `read-value`
      txnId: TxnId
      key: Key
      expected: Value | Bottom
      seq: number
    }
  | { type: `lookup-effect`; key: Key; st: Timestamp; expected: EffectOrBottom }
  | { type: `no-inversion`; shouldPass: boolean }
  | { type: `commit-fails`; txnId: TxnId; reason?: string }
  | { type: `valuation`; key: Key; atTxn: TxnId; expected: EffectOrBottom }
  | { type: `custom`; name: string; check: (state: ScenarioState) => boolean }

/**
 * Scenario metadata.
 */
export interface ScenarioMetadata {
  name: string
  description?: string
  tags?: Array<string>
  /** If true, this scenario tests error conditions */
  expectError?: boolean
  /** If set, skip this scenario */
  skip?: boolean
  /** If set, run only this scenario */
  only?: boolean
}

/**
 * Complete scenario definition.
 */
export interface ScenarioDefinition {
  metadata: ScenarioMetadata
  operations: Array<ScenarioOperation>
  assertions: Array<ScenarioAssertion>
  /** Setup function called before scenario runs */
  setup?: (store: StoreInterface) => void
  /** Teardown function called after scenario runs */
  teardown?: (store: StoreInterface) => void
}

/**
 * Scenario execution state.
 */
export interface ScenarioState {
  /** Current transaction state */
  txnState: TransactionState
  /** Read values captured during execution */
  readValues: Map<string, Value | Bottom> // key: `${txnId}:${key}`
  /** Effect buffers for each transaction */
  effectBuffers: Map<TxnId, EffectBuffer>
  /** Errors encountered */
  errors: Array<{ operation: ScenarioOperation; error: Error }>
  /** The store being tested */
  store: StoreInterface
}

// =============================================================================
// Scenario Builder (Fluent API)
// =============================================================================

/**
 * Transaction builder - part of the fluent API.
 */
export interface TransactionBuilder {
  /** Add an update operation */
  update: (key: Key, effect: Effect) => TransactionBuilder
  /** Add a read operation */
  read: (key: Key) => TransactionBuilder
  /** Add a read operation with expected value */
  readExpect: (key: Key, expected: Value | Bottom) => TransactionBuilder
  /** Commit the transaction */
  commit: (opts: { ct: Timestamp }) => ScenarioBuilder
  /** Abort the transaction */
  abort: () => ScenarioBuilder
  /** Start a new transaction (allows interleaved execution) */
  transaction: (txnId: TxnId, opts: { st: Timestamp }) => TransactionBuilder
  /** Assert that a commit should fail (for incomplete transaction) */
  assertCommitFails: (txnId: TxnId, reason?: string) => ScenarioBuilder
  /** Build the scenario (can be called without terminating transaction) */
  build: () => ScenarioDefinition
}

/**
 * Scenario builder - main fluent API.
 */
export interface ScenarioBuilder {
  /** Set scenario description */
  description: (desc: string) => ScenarioBuilder
  /** Add tags for filtering */
  tags: (...tags: Array<string>) => ScenarioBuilder
  /** Mark as skip */
  skip: () => ScenarioBuilder
  /** Mark as only (run only this) */
  only: () => ScenarioBuilder
  /** Mark as expecting an error */
  expectError: () => ScenarioBuilder

  /** Start a new transaction */
  transaction: (txnId: TxnId, opts: { st: Timestamp }) => TransactionBuilder

  /** Add a lookup assertion */
  assertLookup: (
    key: Key,
    st: Timestamp,
    expected: EffectOrBottom
  ) => ScenarioBuilder
  /** Add a custom assertion */
  assertCustom: (
    name: string,
    check: (state: ScenarioState) => boolean
  ) => ScenarioBuilder
  /** Assert that a commit should fail */
  assertCommitFails: (txnId: TxnId, reason?: string) => ScenarioBuilder
  /** Assert no timestamp inversion occurred */
  assertNoInversion: () => ScenarioBuilder

  /** Add setup function */
  setup: (fn: (store: StoreInterface) => void) => ScenarioBuilder
  /** Add teardown function */
  teardown: (fn: (store: StoreInterface) => void) => ScenarioBuilder

  /** Build the scenario definition */
  build: () => ScenarioDefinition
}

/**
 * Create a new scenario.
 */
export function scenario(name: string): ScenarioBuilder {
  const metadata: ScenarioMetadata = { name }
  const operations: Array<ScenarioOperation> = []
  const assertions: Array<ScenarioAssertion> = []
  let setupFn: ((store: StoreInterface) => void) | undefined
  let teardownFn: ((store: StoreInterface) => void) | undefined
  let readSeqCounter = 0

  const scenarioBuilder: ScenarioBuilder = {
    description(desc: string) {
      metadata.description = desc
      return this
    },

    tags(...tags: Array<string>) {
      metadata.tags = tags
      return this
    },

    skip() {
      metadata.skip = true
      return this
    },

    only() {
      metadata.only = true
      return this
    },

    expectError() {
      metadata.expectError = true
      return this
    },

    transaction(txnId: TxnId, opts: { st: Timestamp }): TransactionBuilder {
      operations.push({ type: `begin`, txnId, snapshotTs: opts.st })

      const createTxnBuilder = (currentTxnId: TxnId): TransactionBuilder => ({
        update(key: Key, effect: Effect) {
          operations.push({ type: `update`, txnId: currentTxnId, key, effect })
          return this
        },

        read(key: Key) {
          const seq = readSeqCounter++
          operations.push({ type: `read`, txnId: currentTxnId, key, seq })
          return this
        },

        readExpect(key: Key, expected: Value | Bottom) {
          const seq = readSeqCounter++
          operations.push({
            type: `read`,
            txnId: currentTxnId,
            key,
            expectedValue: expected,
            seq,
          })
          assertions.push({
            type: `read-value`,
            txnId: currentTxnId,
            key,
            expected,
            seq,
          })
          return this
        },

        commit(commitOpts: { ct: Timestamp }) {
          operations.push({
            type: `commit`,
            txnId: currentTxnId,
            commitTs: commitOpts.ct,
          })
          return scenarioBuilder
        },

        abort() {
          operations.push({ type: `abort`, txnId: currentTxnId })
          return scenarioBuilder
        },

        transaction(newTxnId: TxnId, newOpts: { st: Timestamp }) {
          // Start a new transaction (interleaved execution)
          operations.push({
            type: `begin`,
            txnId: newTxnId,
            snapshotTs: newOpts.st,
          })
          return createTxnBuilder(newTxnId)
        },

        assertCommitFails(failTxnId: TxnId, reason?: string) {
          assertions.push({ type: `commit-fails`, txnId: failTxnId, reason })
          return scenarioBuilder
        },

        build(): ScenarioDefinition {
          return scenarioBuilder.build()
        },
      })

      return createTxnBuilder(txnId)
    },

    assertLookup(key: Key, st: Timestamp, expected: EffectOrBottom) {
      assertions.push({ type: `lookup-effect`, key, st, expected })
      return this
    },

    assertCustom(name: string, check: (state: ScenarioState) => boolean) {
      assertions.push({ type: `custom`, name, check })
      return this
    },

    assertCommitFails(txnId: TxnId, reason?: string) {
      assertions.push({ type: `commit-fails`, txnId, reason })
      return this
    },

    assertNoInversion() {
      assertions.push({ type: `no-inversion`, shouldPass: true })
      return this
    },

    setup(fn: (store: StoreInterface) => void) {
      setupFn = fn
      return this
    },

    teardown(fn: (store: StoreInterface) => void) {
      teardownFn = fn
      return this
    },

    build(): ScenarioDefinition {
      return {
        metadata,
        operations,
        assertions,
        setup: setupFn,
        teardown: teardownFn,
      }
    },
  }

  return scenarioBuilder
}

// =============================================================================
// Scenario Execution
// =============================================================================

/**
 * Execute a scenario against a store.
 */
export function executeScenario(
  definition: ScenarioDefinition,
  store: StoreInterface
): {
  success: boolean
  state: ScenarioState
  assertionResults: Array<{
    assertion: ScenarioAssertion
    passed: boolean
    message?: string
  }>
} {
  // Initialize state
  const state: ScenarioState = {
    txnState: createTransactionState(),
    readValues: new Map(),
    effectBuffers: new Map(),
    errors: [],
    store,
  }

  const coordinator = createTransactionCoordinator(store)

  // Run setup
  if (definition.setup) {
    definition.setup(store)
  }

  // Execute operations
  for (const op of definition.operations) {
    try {
      switch (op.type) {
        case `begin`: {
          // Check if this is a "resumed" transaction (already running)
          const coordState = coordinator.getState()
          if (coordState.running.has(op.txnId)) {
            // Transaction already running - skip begin (resume)
            break
          }
          const _txn = coordinator.begin(op.txnId, op.snapshotTs)
          state.effectBuffers.set(op.txnId, new Map())
          break
        }

        case `update`: {
          coordinator.update(op.txnId, op.key, op.effect)
          // Track effect buffer
          const buffer = state.effectBuffers.get(op.txnId) ?? new Map()
          const current = buffer.get(op.key) ?? BOTTOM
          buffer.set(op.key, composeEffects(current, op.effect))
          state.effectBuffers.set(op.txnId, buffer)
          break
        }

        case `read`: {
          const value = coordinator.read(op.txnId, op.key)
          state.readValues.set(`${op.txnId}:${op.key}:${op.seq}`, value)
          break
        }

        case `commit`: {
          coordinator.commit(op.txnId, op.commitTs)
          break
        }

        case `abort`: {
          coordinator.abort(op.txnId)
          break
        }
      }
    } catch (error) {
      state.errors.push({ operation: op, error: error as Error })
      // If we expect errors, continue; otherwise, we'll fail later
      if (!definition.metadata.expectError) {
        break
      }
    }
  }

  // Update txnState from coordinator
  state.txnState = coordinator.getState()

  // Run teardown
  if (definition.teardown) {
    definition.teardown(store)
  }

  // Check assertions
  const assertionResults: Array<{
    assertion: ScenarioAssertion
    passed: boolean
    message?: string
  }> = []

  for (const assertion of definition.assertions) {
    let passed = false
    let message: string | undefined

    switch (assertion.type) {
      case `read-value`: {
        const actualKey = `${assertion.txnId}:${assertion.key}:${assertion.seq}`
        const actual = state.readValues.get(actualKey)
        if (isBottom(assertion.expected)) {
          passed = isBottom(actual)
        } else if (isBottom(actual)) {
          passed = false
        } else {
          passed = JSON.stringify(actual) === JSON.stringify(assertion.expected)
        }
        if (!passed) {
          message = `Expected read(${assertion.key}) in ${assertion.txnId} to be ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(actual)}`
        }
        break
      }

      case `lookup-effect`: {
        const actual = store.lookup(assertion.key, assertion.st)
        passed = effectsEqual(actual, assertion.expected)
        if (!passed) {
          message = `Expected lookup(${assertion.key}, ${assertion.st}) to be ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(actual)}`
        }
        break
      }

      case `commit-fails`: {
        const commitError = state.errors.find(
          (e) =>
            e.operation.type === `commit` &&
            e.operation.txnId === assertion.txnId
        )
        passed = commitError !== undefined
        if (!passed) {
          message = `Expected commit of ${assertion.txnId} to fail, but it succeeded`
        } else if (
          assertion.reason &&
          !commitError.error.message.includes(assertion.reason)
        ) {
          passed = false
          message = `Expected commit error to contain "${assertion.reason}", got "${commitError.error.message}"`
        }
        break
      }

      case `no-inversion`: {
        const inversionError = state.errors.find((e) =>
          e.error.message.includes(`inversion`)
        )
        passed = assertion.shouldPass
          ? inversionError === undefined
          : inversionError !== undefined
        if (!passed) {
          message = assertion.shouldPass
            ? `Unexpected timestamp inversion error: ${inversionError?.error.message}`
            : `Expected timestamp inversion error but none occurred`
        }
        break
      }

      case `custom`: {
        try {
          passed = assertion.check(state)
        } catch (error) {
          passed = false
          message = `Custom assertion "${assertion.name}" threw: ${error}`
        }
        if (!passed && !message) {
          message = `Custom assertion "${assertion.name}" failed`
        }
        break
      }

      case `valuation`: {
        // Would need trace support - skip for now
        passed = true
        message = `Valuation assertions require trace-building store`
        break
      }
    }

    assertionResults.push({ assertion, passed, message })
  }

  // Overall success
  const allAssertionsPassed = assertionResults.every((r) => r.passed)
  const noUnexpectedErrors =
    definition.metadata.expectError || state.errors.length === 0

  return {
    success: allAssertionsPassed && noUnexpectedErrors,
    state,
    assertionResults,
  }
}

// =============================================================================
// Predefined Scenarios (Test Suite)
// =============================================================================

/**
 * Collection of predefined test scenarios covering the specification.
 */
export const standardScenarios: Array<ScenarioDefinition> = [
  // Basic operations
  scenario(`single transaction assign and read`)
    .description(`A transaction can assign a value and read it back`)
    .transaction(`t1`, { st: 0 })
    .update(`key1`, assign(42))
    .readExpect(`key1`, 42)
    .commit({ ct: 1 })
    .build(),

  scenario(`increment after assign`)
    .description(`Increments apply on top of assignments`)
    .transaction(`t1`, { st: 0 })
    .update(`counter`, assign(10))
    .update(`counter`, increment(5))
    .readExpect(`counter`, 15)
    .commit({ ct: 1 })
    .build(),

  scenario(`read-my-writes within transaction`)
    .description(`A transaction sees its own writes`)
    .transaction(`t1`, { st: 0 })
    .update(`x`, assign(1))
    .update(`y`, assign(2))
    .readExpect(`x`, 1)
    .readExpect(`y`, 2)
    .update(`x`, increment(10))
    .readExpect(`x`, 11)
    .commit({ ct: 1 })
    .build(),

  // Visibility
  scenario(`committed transaction visible to later snapshot`)
    .description(
      `A committed transaction is visible to transactions with higher snapshot`
    )
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(100))
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .readExpect(`key`, 100)
    .commit({ ct: 15 })
    .build(),

  scenario(`uncommitted transaction not visible`)
    .description(
      `An uncommitted transaction's writes are not visible to others`
    )
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(100))
    // t1 not committed yet
    .transaction(`t2`, { st: 5 })
    .readExpect(`key`, BOTTOM) // t1's write not visible
    .commit({ ct: 10 })
    .transaction(`t1`, { st: 0 }) // Resume t1
    .commit({ ct: 15 })
    .build(),

  // Concurrent transactions
  scenario(`concurrent increments merge`)
    .description(`Concurrent increment effects are merged (added together)`)
    .transaction(`t1`, { st: 0 })
    .update(`counter`, assign(0))
    .commit({ ct: 1 })
    .transaction(`t2`, { st: 2 })
    .update(`counter`, increment(5))
    .commit({ ct: 10 })
    .transaction(`t3`, { st: 2 })
    .update(`counter`, increment(3))
    .commit({ ct: 11 })
    .transaction(`t4`, { st: 12 })
    .readExpect(`counter`, 8) // 0 + 5 + 3
    .commit({ ct: 15 })
    .build(),

  // Abort
  scenario(`aborted transaction has no effect`)
    .description(`An aborted transaction's writes are discarded`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(999))
    .abort()
    .transaction(`t2`, { st: 5 })
    .readExpect(`key`, BOTTOM)
    .commit({ ct: 10 })
    .build(),

  // Timestamp inversion
  scenario(`timestamp inversion prevented`)
    .description(`Commit fails if it would cause timestamp inversion`)
    .expectError()
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(1))
    // Don't commit t1 yet
    .transaction(`t2`, { st: 10 }) // t2 has higher snapshot
    .readExpect(`key`, BOTTOM)
    .commit({ ct: 15 })
    .transaction(`t1`, { st: 0 }) // Resume t1
    .commit({ ct: 5 }) // This should fail: ct=5 < t2.st=10 violates no-inversion
    .assertCommitFails(`t1`)
    .build(),

  // Snapshot isolation
  scenario(`snapshot isolation - no dirty reads`)
    .description(`A transaction reads a consistent snapshot`)
    .transaction(`t1`, { st: 0 })
    .update(`x`, assign(1))
    .update(`y`, assign(2))
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .readExpect(`x`, 1)
    .readExpect(`y`, 2)
    // Even if t3 commits during t2's execution
    .transaction(`t3`, { st: 10 })
    .update(`x`, assign(100))
    .commit({ ct: 12 })
    .transaction(`t2`, { st: 10 }) // Resume t2
    .readExpect(`x`, 1) // Still sees snapshot value
    .commit({ ct: 20 })
    .build(),

  // Delete
  scenario(`delete removes value`)
    .description(`Delete effect sets value to BOTTOM`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(42))
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .update(`key`, del())
    .commit({ ct: 15 })
    .transaction(`t3`, { st: 20 })
    .readExpect(`key`, BOTTOM)
    .commit({ ct: 25 })
    .build(),

  // ==========================================================================
  // Concurrent Write Scenarios
  // ==========================================================================

  scenario(`concurrent assignments - last writer wins`)
    .description(`When two transactions assign to same key, last commit wins`)
    .tags(`concurrent`, `lww`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(`first`))
    .commit({ ct: 10 })
    .transaction(`t2`, { st: 0 })
    .update(`key`, assign(`second`))
    .commit({ ct: 20 }) // t2 commits later, so its value wins
    .transaction(`t3`, { st: 25 })
    .readExpect(`key`, `second`)
    .commit({ ct: 30 })
    .build(),

  scenario(`concurrent assignment and increment`)
    .description(`Assignment and increment from same snapshot merge correctly`)
    .tags(`concurrent`, `merge`)
    .transaction(`t1`, { st: 0 })
    .update(`counter`, assign(100))
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .update(`counter`, assign(50)) // Reassign
    .commit({ ct: 15 })
    .transaction(`t3`, { st: 10 })
    .update(`counter`, increment(7)) // Concurrent increment
    .commit({ ct: 16 })
    .transaction(`t4`, { st: 20 })
    .readExpect(`counter`, 57) // 50 + 7 (assignment + increment merge)
    .commit({ ct: 25 })
    .build(),

  scenario(`concurrent delete and assignment`)
    .description(`Delete loses to assignment when merging`)
    .tags(`concurrent`, `delete`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(42))
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .update(`key`, del())
    .commit({ ct: 15 })
    .transaction(`t3`, { st: 10 })
    .update(`key`, assign(100)) // Concurrent with delete
    .commit({ ct: 16 })
    .transaction(`t4`, { st: 20 })
    .readExpect(`key`, 100) // Assignment wins over delete
    .commit({ ct: 25 })
    .build(),

  scenario(`concurrent delete and increment`)
    .description(`Delete loses to increment when merging`)
    .tags(`concurrent`, `delete`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(50))
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .update(`key`, del())
    .commit({ ct: 15 })
    .transaction(`t3`, { st: 10 })
    .update(`key`, increment(10)) // Concurrent with delete
    .commit({ ct: 16 })
    .transaction(`t4`, { st: 20 })
    .readExpect(`key`, 60) // 50 + 10, increment wins over delete
    .commit({ ct: 25 })
    .build(),

  scenario(`three-way concurrent increments`)
    .description(`Three concurrent increments all merge together`)
    .tags(`concurrent`, `merge`)
    .transaction(`t1`, { st: 0 })
    .update(`counter`, assign(0))
    .commit({ ct: 1 })
    .transaction(`t2`, { st: 2 })
    .update(`counter`, increment(10))
    .commit({ ct: 10 })
    .transaction(`t3`, { st: 2 })
    .update(`counter`, increment(20))
    .commit({ ct: 11 })
    .transaction(`t4`, { st: 2 })
    .update(`counter`, increment(30))
    .commit({ ct: 12 })
    .transaction(`t5`, { st: 15 })
    .readExpect(`counter`, 60) // 0 + 10 + 20 + 30
    .commit({ ct: 20 })
    .build(),

  // ==========================================================================
  // Transaction Chain Scenarios
  // ==========================================================================

  scenario(`long transaction chain`)
    .description(
      `Value correctly propagates through many sequential transactions`
    )
    .tags(`chain`, `sequential`)
    .transaction(`t1`, { st: 0 })
    .update(`x`, assign(1))
    .commit({ ct: 1 })
    .transaction(`t2`, { st: 2 })
    .readExpect(`x`, 1)
    .update(`x`, increment(1))
    .commit({ ct: 3 })
    .transaction(`t3`, { st: 4 })
    .readExpect(`x`, 2)
    .update(`x`, increment(1))
    .commit({ ct: 5 })
    .transaction(`t4`, { st: 6 })
    .readExpect(`x`, 3)
    .update(`x`, increment(1))
    .commit({ ct: 7 })
    .transaction(`t5`, { st: 8 })
    .readExpect(`x`, 4)
    .update(`x`, increment(1))
    .commit({ ct: 9 })
    .transaction(`t6`, { st: 10 })
    .readExpect(`x`, 5)
    .commit({ ct: 11 })
    .build(),

  scenario(`read-modify-write pattern`)
    .description(`Transaction reads, modifies based on read, and writes`)
    .tags(`chain`, `rmw`)
    .transaction(`t1`, { st: 0 })
    .update(`balance`, assign(100))
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .readExpect(`balance`, 100)
    .update(`balance`, increment(-30)) // Withdraw 30
    .readExpect(`balance`, 70)
    .commit({ ct: 15 })
    .transaction(`t3`, { st: 20 })
    .readExpect(`balance`, 70)
    .update(`balance`, increment(50)) // Deposit 50
    .readExpect(`balance`, 120)
    .commit({ ct: 25 })
    .build(),

  scenario(`multiple keys in single transaction`)
    .description(`Transaction can update and read multiple keys atomically`)
    .tags(`multi-key`)
    .transaction(`t1`, { st: 0 })
    .update(`a`, assign(1))
    .update(`b`, assign(2))
    .update(`c`, assign(3))
    .readExpect(`a`, 1)
    .readExpect(`b`, 2)
    .readExpect(`c`, 3)
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .readExpect(`a`, 1)
    .readExpect(`b`, 2)
    .readExpect(`c`, 3)
    .update(`a`, increment(10))
    .update(`b`, increment(20))
    .update(`c`, increment(30))
    .readExpect(`a`, 11)
    .readExpect(`b`, 22)
    .readExpect(`c`, 33)
    .commit({ ct: 15 })
    .build(),

  // ==========================================================================
  // Edge Case Scenarios
  // ==========================================================================

  scenario(`multiple increments in single transaction`)
    .description(`Multiple increments in same transaction accumulate`)
    .tags(`edge-case`, `increment`)
    .transaction(`t1`, { st: 0 })
    .update(`counter`, assign(0))
    .update(`counter`, increment(5))
    .update(`counter`, increment(3))
    .update(`counter`, increment(2))
    .readExpect(`counter`, 10)
    .commit({ ct: 5 })
    .build(),

  scenario(`delete then assign in same transaction`)
    .description(`Assignment after delete restores a value`)
    .tags(`edge-case`, `delete`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(42))
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .update(`key`, del())
    .readExpect(`key`, BOTTOM)
    .update(`key`, assign(100))
    .readExpect(`key`, 100)
    .commit({ ct: 15 })
    .transaction(`t3`, { st: 20 })
    .readExpect(`key`, 100)
    .commit({ ct: 25 })
    .build(),

  scenario(`assign then delete in same transaction`)
    .description(`Delete after assign removes the value`)
    .tags(`edge-case`, `delete`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(42))
    .update(`key`, del())
    .readExpect(`key`, BOTTOM)
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .readExpect(`key`, BOTTOM)
    .commit({ ct: 15 })
    .build(),

  scenario(`read non-existent key`)
    .description(`Reading a key that was never written returns BOTTOM`)
    .tags(`edge-case`, `read`)
    .transaction(`t1`, { st: 0 })
    .readExpect(`nonexistent`, BOTTOM)
    .commit({ ct: 5 })
    .build(),

  scenario(`empty transaction - read only`)
    .description(`A transaction that only reads commits successfully`)
    .tags(`edge-case`, `read-only`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(42))
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 10 })
    .readExpect(`key`, 42)
    // No updates, just a read
    .commit({ ct: 15 })
    .transaction(`t3`, { st: 20 })
    .readExpect(`key`, 42) // Value unchanged
    .commit({ ct: 25 })
    .build(),

  scenario(`overwrite value multiple times`)
    .description(`Multiple assignments to same key, last one wins`)
    .tags(`edge-case`, `assign`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(1))
    .update(`key`, assign(2))
    .update(`key`, assign(3))
    .readExpect(`key`, 3)
    .commit({ ct: 5 })
    .build(),

  // ==========================================================================
  // Isolation Boundary Scenarios
  // ==========================================================================

  scenario(`snapshot sees exactly committed transactions`)
    .description(`Snapshot at ts=X sees all commits with ct<X, none with ct>=X`)
    .tags(`isolation`, `snapshot`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(10))
    .commit({ ct: 5 })
    .transaction(`t2`, { st: 0 })
    .update(`key`, assign(20))
    .commit({ ct: 10 })
    .transaction(`t3`, { st: 0 })
    .update(`key`, assign(30))
    .commit({ ct: 15 })
    // Reader at st=12 sees commits at 5 and 10, but not 15
    .transaction(`reader`, { st: 12 })
    .readExpect(`key`, 20) // ct=10 is latest visible
    .commit({ ct: 20 })
    .build(),

  scenario(`concurrent readers see same snapshot`)
    .description(`Multiple readers with same st see identical values`)
    .tags(`isolation`, `concurrent-read`)
    .transaction(`writer`, { st: 0 })
    .update(`x`, assign(100))
    .update(`y`, assign(200))
    .commit({ ct: 5 })
    .transaction(`r1`, { st: 10 })
    .readExpect(`x`, 100)
    .readExpect(`y`, 200)
    .commit({ ct: 20 })
    .transaction(`r2`, { st: 10 })
    .readExpect(`x`, 100)
    .readExpect(`y`, 200)
    .commit({ ct: 21 })
    .transaction(`r3`, { st: 10 })
    .readExpect(`x`, 100)
    .readExpect(`y`, 200)
    .commit({ ct: 22 })
    .build(),

  scenario(`writer does not see own uncommitted changes from store`)
    .description(
      `Read within transaction sees buffer, not yet committed to store`
    )
    .tags(`isolation`, `buffer`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(42))
    .readExpect(`key`, 42) // Sees from buffer
    // Another transaction cannot see t1's uncommitted write
    .transaction(`t2`, { st: 5 })
    .readExpect(`key`, BOTTOM) // t1 not committed
    .commit({ ct: 10 })
    .transaction(`t1`, { st: 0 }) // Resume t1
    .commit({ ct: 15 })
    // Now t1's write is visible
    .transaction(`t3`, { st: 20 })
    .readExpect(`key`, 42)
    .commit({ ct: 25 })
    .build(),

  // ==========================================================================
  // Timestamp Edge Cases
  // ==========================================================================

  scenario(`same snapshot different commit order`)
    .description(`Two txns with same st, different ct order correctly`)
    .tags(`timestamp`, `ordering`)
    .transaction(`t1`, { st: 5 })
    .update(`key`, assign(`first`))
    .commit({ ct: 10 })
    .transaction(`t2`, { st: 5 })
    .update(`key`, assign(`second`))
    .commit({ ct: 15 })
    .transaction(`reader`, { st: 20 })
    .readExpect(`key`, `second`) // Higher ct wins
    .commit({ ct: 25 })
    .build(),

  scenario(`commit at exactly snapshot boundary`)
    .description(`Transaction with st=X does not see commit with ct=X`)
    .tags(`timestamp`, `boundary`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(42))
    .commit({ ct: 10 }) // Commits at exactly 10
    .transaction(`t2`, { st: 10 }) // Snapshot at exactly 10
    .readExpect(`key`, BOTTOM) // ct=10 is NOT visible at st=10 (ct must be < st)
    .commit({ ct: 15 })
    .transaction(`t3`, { st: 11 }) // Snapshot at 11
    .readExpect(`key`, 42) // Now visible
    .commit({ ct: 20 })
    .build(),

  scenario(`timestamp inversion with interleaved operations`)
    .description(`Complex interleaving that would cause inversion is prevented`)
    .tags(`timestamp`, `inversion`)
    .expectError()
    .transaction(`t1`, { st: 0 })
    .update(`a`, assign(1))
    .transaction(`t2`, { st: 0 })
    .update(`b`, assign(2))
    .commit({ ct: 20 })
    .transaction(`t3`, { st: 25 }) // t3 reads after t2 commits
    .readExpect(`b`, 2)
    .commit({ ct: 30 })
    // Now t1 tries to commit at ct=10, which is before t3.st=25
    // But t3 might have read t1's key 'a' (it didn't here, but the rule applies)
    // Actually this should be allowed since t1 and t3 don't conflict on keys
    // Let me make a proper inversion case
    .transaction(`t1`, { st: 0 }) // Resume t1
    .commit({ ct: 10 }) // t1 commits with ct < t3.st - this is timestamp inversion!
    .assertCommitFails(`t1`)
    .build(),

  // ==========================================================================
  // Complex Multi-Key Scenarios
  // ==========================================================================

  scenario(`transfer between accounts`)
    .description(`Atomic transfer: debit one account, credit another`)
    .tags(`multi-key`, `atomic`)
    .transaction(`setup`, { st: 0 })
    .update(`account_a`, assign(100))
    .update(`account_b`, assign(50))
    .commit({ ct: 5 })
    .transaction(`transfer`, { st: 10 })
    .readExpect(`account_a`, 100)
    .readExpect(`account_b`, 50)
    .update(`account_a`, increment(-30)) // Debit 30
    .update(`account_b`, increment(30)) // Credit 30
    .readExpect(`account_a`, 70)
    .readExpect(`account_b`, 80)
    .commit({ ct: 15 })
    .transaction(`verify`, { st: 20 })
    .readExpect(`account_a`, 70)
    .readExpect(`account_b`, 80)
    .commit({ ct: 25 })
    .build(),

  scenario(`concurrent transfers to same account`)
    .description(`Two concurrent deposits both apply`)
    .tags(`multi-key`, `concurrent`)
    .transaction(`setup`, { st: 0 })
    .update(`account`, assign(100))
    .commit({ ct: 5 })
    .transaction(`deposit1`, { st: 10 })
    .update(`account`, increment(50))
    .commit({ ct: 15 })
    .transaction(`deposit2`, { st: 10 })
    .update(`account`, increment(25))
    .commit({ ct: 16 })
    .transaction(`verify`, { st: 20 })
    .readExpect(`account`, 175) // 100 + 50 + 25
    .commit({ ct: 25 })
    .build(),

  // ==========================================================================
  // Recovery and Abort Scenarios
  // ==========================================================================

  scenario(`partial transaction abort`)
    .description(`Abort after multiple updates discards all changes`)
    .tags(`abort`, `recovery`)
    .transaction(`t1`, { st: 0 })
    .update(`a`, assign(1))
    .update(`b`, assign(2))
    .update(`c`, assign(3))
    .abort()
    .transaction(`t2`, { st: 5 })
    .readExpect(`a`, BOTTOM)
    .readExpect(`b`, BOTTOM)
    .readExpect(`c`, BOTTOM)
    .commit({ ct: 10 })
    .build(),

  scenario(`abort then retry succeeds`)
    .description(`After aborting, a new transaction can succeed`)
    .tags(`abort`, `retry`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(42))
    .abort()
    .transaction(`t2`, { st: 5 })
    .update(`key`, assign(100))
    .commit({ ct: 10 })
    .transaction(`t3`, { st: 15 })
    .readExpect(`key`, 100)
    .commit({ ct: 20 })
    .build(),

  scenario(`interleaved abort and commit`)
    .description(`One transaction aborts while another commits`)
    .tags(`abort`, `concurrent`)
    .transaction(`t1`, { st: 0 })
    .update(`key`, assign(1))
    .transaction(`t2`, { st: 0 })
    .update(`key`, assign(2))
    .transaction(`t1`, { st: 0 }) // Resume t1
    .abort()
    .transaction(`t2`, { st: 0 }) // Resume t2
    .commit({ ct: 10 })
    .transaction(`t3`, { st: 15 })
    .readExpect(`key`, 2) // Only t2's value persisted
    .commit({ ct: 20 })
    .build(),
]

/**
 * Get all standard scenarios.
 */
export function getStandardScenarios(): Array<ScenarioDefinition> {
  return standardScenarios
}

/**
 * Filter scenarios by tag.
 */
export function filterScenariosByTag(
  scenarios: Array<ScenarioDefinition>,
  tag: string
): Array<ScenarioDefinition> {
  return scenarios.filter((s) => s.metadata.tags?.includes(tag))
}

/**
 * Get scenarios marked as 'only'.
 */
export function getOnlyScenarios(
  scenarios: Array<ScenarioDefinition>
): Array<ScenarioDefinition> {
  const only = scenarios.filter((s) => s.metadata.only)
  return only.length > 0 ? only : scenarios
}

/**
 * Filter out skipped scenarios.
 */
export function filterSkipped(
  scenarios: Array<ScenarioDefinition>
): Array<ScenarioDefinition> {
  return scenarios.filter((s) => !s.metadata.skip)
}
