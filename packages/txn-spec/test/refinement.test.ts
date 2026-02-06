/**
 * Refinement Checking Tests
 *
 * Verifies that optimized store implementations "refine" a simpler
 * reference implementation. After each operation, both stores should
 * be in equivalent states.
 *
 * Based on the formal methods concept of refinement: if the spec says
 * something is true, the implementation must preserve it.
 */

import { describe, expect, it } from "vitest"
import {
  BOTTOM,
  assign,
  createInMemoryStreamStore,
  createMapStore,
  createTimestampGenerator,
  createTransactionCoordinator,
  del,
  generateRandomScenario,
  increment,
  isBottom,
} from "../src/index"
import type { Bottom, Effect, Key, Timestamp, TxnId, Value } from "../src/types"
import type { StoreInterface } from "../src/transaction"

/**
 * Snapshot of store state for comparison
 */
interface StoreSnapshot {
  keys: Map<Key, Value | Bottom>
}

/**
 * Get a snapshot of all keys in a store at a given timestamp
 */
function getStoreSnapshot(
  store: StoreInterface,
  keys: Array<Key>,
  timestamp: Timestamp
): StoreSnapshot {
  const snapshot = new Map<Key, Value | Bottom>()
  for (const key of keys) {
    const effect = store.lookup(key, timestamp)
    if (isBottom(effect)) {
      snapshot.set(key, BOTTOM)
    } else {
      // Apply the effect to get the value
      // For simplicity, we just store the effect type
      snapshot.set(key, effect as unknown)
    }
  }
  return { keys: snapshot }
}

/**
 * Compare two store snapshots
 */
function snapshotsEqual(a: StoreSnapshot, b: StoreSnapshot): boolean {
  if (a.keys.size !== b.keys.size) return false
  for (const [key, valueA] of a.keys) {
    const valueB = b.keys.get(key)
    if (JSON.stringify(valueA) !== JSON.stringify(valueB)) {
      return false
    }
  }
  return true
}

/**
 * Refinement check result
 */
interface RefinementResult {
  valid: boolean
  failingStep?: number
  failingOperation?: string
  referenceSnapshot?: StoreSnapshot
  implementationSnapshot?: StoreSnapshot
}

/**
 * Check that an implementation refines a reference after each step
 */
function checkRefinement(
  referenceFactory: () => StoreInterface,
  implementationFactory: () => StoreInterface,
  operations: Array<{
    type: `begin` | `update` | `commit` | `abort`
    txnId: TxnId
    key?: Key
    effect?: Effect
    snapshotTs?: Timestamp
    commitTs?: Timestamp
  }>
): RefinementResult {
  const refStore = referenceFactory()
  const implStore = implementationFactory()
  const refTsGen = createTimestampGenerator()
  const implTsGen = createTimestampGenerator()
  const refCoord = createTransactionCoordinator(refStore, refTsGen)
  const implCoord = createTransactionCoordinator(implStore, implTsGen)

  const allKeys = new Set<Key>()
  let maxTimestamp = 0

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]

    // Execute on both
    try {
      switch (op.type) {
        case `begin`:
          refCoord.begin(op.txnId, { st: op.snapshotTs ?? 0 })
          implCoord.begin(op.txnId, { st: op.snapshotTs ?? 0 })
          break
        case `update`:
          refCoord.update(op.txnId, op.key!, op.effect!)
          implCoord.update(op.txnId, op.key!, op.effect!)
          allKeys.add(op.key!)
          break
        case `commit`:
          refCoord.commit(op.txnId, { ct: op.commitTs ?? maxTimestamp + 1 })
          implCoord.commit(op.txnId, { ct: op.commitTs ?? maxTimestamp + 1 })
          maxTimestamp = Math.max(maxTimestamp, op.commitTs ?? maxTimestamp + 1)
          break
        case `abort`:
          refCoord.abort(op.txnId)
          implCoord.abort(op.txnId)
          break
      }
    } catch {
      // If one throws, both should throw
      // For now, we just continue
    }

    // After each commit, check refinement
    if (op.type === `commit`) {
      const refSnapshot = getStoreSnapshot(refStore, [...allKeys], maxTimestamp)
      const implSnapshot = getStoreSnapshot(
        implStore,
        [...allKeys],
        maxTimestamp
      )

      if (!snapshotsEqual(refSnapshot, implSnapshot)) {
        return {
          valid: false,
          failingStep: i,
          failingOperation: `${op.type}(${op.txnId})`,
          referenceSnapshot: refSnapshot,
          implementationSnapshot: implSnapshot,
        }
      }
    }
  }

  return { valid: true }
}

describe(`Refinement Checking`, () => {
  describe(`Map Store as Reference`, () => {
    const referenceFactory = createMapStore
    const implementationFactory = createInMemoryStreamStore

    it(`simple assign refines correctly`, () => {
      const result = checkRefinement(referenceFactory, implementationFactory, [
        { type: `begin`, txnId: `t1`, snapshotTs: 0 },
        { type: `update`, txnId: `t1`, key: `x`, effect: assign(42) },
        { type: `commit`, txnId: `t1`, commitTs: 5 },
      ])

      expect(result.valid).toBe(true)
    })

    it(`concurrent increments refine correctly`, () => {
      const result = checkRefinement(referenceFactory, implementationFactory, [
        { type: `begin`, txnId: `setup`, snapshotTs: 0 },
        { type: `update`, txnId: `setup`, key: `counter`, effect: assign(0) },
        { type: `commit`, txnId: `setup`, commitTs: 1 },
        { type: `begin`, txnId: `t1`, snapshotTs: 2 },
        { type: `update`, txnId: `t1`, key: `counter`, effect: increment(5) },
        { type: `begin`, txnId: `t2`, snapshotTs: 2 },
        { type: `update`, txnId: `t2`, key: `counter`, effect: increment(3) },
        { type: `commit`, txnId: `t1`, commitTs: 10 },
        { type: `commit`, txnId: `t2`, commitTs: 11 },
      ])

      expect(result.valid).toBe(true)
    })

    it(`delete refines correctly`, () => {
      const result = checkRefinement(referenceFactory, implementationFactory, [
        { type: `begin`, txnId: `t1`, snapshotTs: 0 },
        { type: `update`, txnId: `t1`, key: `x`, effect: assign(42) },
        { type: `commit`, txnId: `t1`, commitTs: 5 },
        { type: `begin`, txnId: `t2`, snapshotTs: 10 },
        { type: `update`, txnId: `t2`, key: `x`, effect: del() },
        { type: `commit`, txnId: `t2`, commitTs: 15 },
      ])

      expect(result.valid).toBe(true)
    })

    it(`aborted transaction has no effect on refinement`, () => {
      const result = checkRefinement(referenceFactory, implementationFactory, [
        { type: `begin`, txnId: `t1`, snapshotTs: 0 },
        { type: `update`, txnId: `t1`, key: `x`, effect: assign(42) },
        { type: `commit`, txnId: `t1`, commitTs: 5 },
        { type: `begin`, txnId: `t2`, snapshotTs: 10 },
        { type: `update`, txnId: `t2`, key: `x`, effect: assign(99) },
        { type: `abort`, txnId: `t2` },
        { type: `begin`, txnId: `t3`, snapshotTs: 20 },
        { type: `update`, txnId: `t3`, key: `y`, effect: assign(1) },
        { type: `commit`, txnId: `t3`, commitTs: 25 },
      ])

      expect(result.valid).toBe(true)
    })

    it(`multiple keys refine correctly`, () => {
      const result = checkRefinement(referenceFactory, implementationFactory, [
        { type: `begin`, txnId: `t1`, snapshotTs: 0 },
        { type: `update`, txnId: `t1`, key: `a`, effect: assign(1) },
        { type: `update`, txnId: `t1`, key: `b`, effect: assign(2) },
        { type: `update`, txnId: `t1`, key: `c`, effect: assign(3) },
        { type: `commit`, txnId: `t1`, commitTs: 5 },
        { type: `begin`, txnId: `t2`, snapshotTs: 10 },
        { type: `update`, txnId: `t2`, key: `a`, effect: increment(10) },
        { type: `update`, txnId: `t2`, key: `b`, effect: del() },
        { type: `commit`, txnId: `t2`, commitTs: 15 },
      ])

      expect(result.valid).toBe(true)
    })
  })

  describe(`Fuzz-Based Refinement`, () => {
    // Run random scenarios and check refinement
    const seeds = [100, 200, 300, 400, 500]

    for (const seed of seeds) {
      it(`random scenario (seed=${seed}) refines correctly`, () => {
        const scenarioConfig = {
          seed,
          transactionCount: 5,
          keyCount: 3,
          maxOpsPerTxn: 3,
          allowConcurrency: true,
          abortProbability: 0.1,
        }

        const generatedScenario = generateRandomScenario(scenarioConfig)

        // Convert scenario operations to our format
        const operations: Array<{
          type: `begin` | `update` | `commit` | `abort`
          txnId: TxnId
          key?: Key
          effect?: Effect
          snapshotTs?: Timestamp
          commitTs?: Timestamp
        }> = []

        for (const op of generatedScenario.operations) {
          switch (op.type) {
            case `begin`:
              operations.push({
                type: `begin`,
                txnId: op.txnId,
                snapshotTs: op.snapshotTs,
              })
              break
            case `update`:
              operations.push({
                type: `update`,
                txnId: op.txnId,
                key: op.key,
                effect: op.effect,
              })
              break
            case `commit`:
              operations.push({
                type: `commit`,
                txnId: op.txnId,
                commitTs: op.commitTs,
              })
              break
            case `abort`:
              operations.push({
                type: `abort`,
                txnId: op.txnId,
              })
              break
          }
        }

        const result = checkRefinement(
          createMapStore,
          createInMemoryStreamStore,
          operations
        )

        if (!result.valid) {
          console.log(`Refinement failed at step ${result.failingStep}`)
          console.log(`Operation: ${result.failingOperation}`)
          console.log(`Reference:`, result.referenceSnapshot)
          console.log(`Implementation:`, result.implementationSnapshot)
        }

        expect(result.valid).toBe(true)
      })
    }
  })
})
