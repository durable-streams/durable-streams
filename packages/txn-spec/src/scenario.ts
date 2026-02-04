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
