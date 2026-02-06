/**
 * Adversarial Testing - Tier 2 DSL
 *
 * Tests malformed, invalid, and edge-case scenarios that the typed
 * builder DSL would normally prevent. This exercises error handling,
 * defensive checks, and robustness.
 *
 * The "typed builder DSL" (scenario()) is for well-formed histories.
 * This "raw events DSL" is for adversarial testing.
 */

import { describe, expect, it } from "vitest"
import {
  assign,
  createMapStore,
  createTimestampGenerator,
  createTransactionCoordinator,
  del,
  increment,
  isBottom,
} from "../src/index"
import type { Effect, Key, Timestamp, TxnId } from "../src/types"

/**
 * Raw event types for adversarial testing
 */
interface RawEvent {
  type: `begin` | `update` | `read` | `commit` | `abort`
  txnId: TxnId
  key?: Key
  effect?: Effect
  snapshotTs?: Timestamp
  commitTs?: Timestamp
}

/**
 * Execute raw events directly against the coordinator
 * Returns success/failure and any error thrown
 */
function executeRawEvents(events: Array<RawEvent>): {
  success: boolean
  error?: Error
  results: Array<unknown>
} {
  const store = createMapStore()
  const tsGen = createTimestampGenerator()
  const coordinator = createTransactionCoordinator(store, tsGen)
  const results: Array<unknown> = []

  try {
    for (const event of events) {
      switch (event.type) {
        case `begin`:
          coordinator.begin(event.txnId, { st: event.snapshotTs ?? 0 })
          results.push({ type: `begin`, txnId: event.txnId })
          break
        case `update`:
          coordinator.update(event.txnId, event.key!, event.effect!)
          results.push({ type: `update`, txnId: event.txnId, key: event.key })
          break
        case `read`: {
          const value = coordinator.read(event.txnId, event.key!)
          results.push({
            type: `read`,
            txnId: event.txnId,
            key: event.key,
            value,
          })
          break
        }
        case `commit`:
          coordinator.commit(event.txnId, { ct: event.commitTs ?? 100 })
          results.push({ type: `commit`, txnId: event.txnId })
          break
        case `abort`:
          coordinator.abort(event.txnId)
          results.push({ type: `abort`, txnId: event.txnId })
          break
      }
    }
    return { success: true, results }
  } catch (error) {
    return { success: false, error: error as Error, results }
  }
}

describe(`Adversarial Testing - Malformed Scenarios`, () => {
  describe(`Constraint Violations`, () => {
    describe(`C2: No Double Commit`, () => {
      it(`rejects committing an already-committed transaction`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(1) },
          { type: `commit`, txnId: `t1`, commitTs: 5 },
          { type: `commit`, txnId: `t1`, commitTs: 10 }, // Double commit!
        ])

        expect(result.success).toBe(false)
        // Error message varies: "not running", "already committed", etc.
        expect(result.error?.message).toMatch(
          /not running|already|committed|invalid/i
        )
      })
    })

    describe(`C3: No Operations After Commit/Abort`, () => {
      it(`rejects update after commit`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `commit`, txnId: `t1`, commitTs: 5 },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(1) }, // After commit!
        ])

        expect(result.success).toBe(false)
      })

      it(`rejects read after commit`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(1) },
          { type: `commit`, txnId: `t1`, commitTs: 5 },
          { type: `read`, txnId: `t1`, key: `x` }, // After commit!
        ])

        expect(result.success).toBe(false)
      })

      it(`rejects update after abort`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `abort`, txnId: `t1` },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(1) }, // After abort!
        ])

        expect(result.success).toBe(false)
      })

      it(`rejects commit after abort`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `abort`, txnId: `t1` },
          { type: `commit`, txnId: `t1`, commitTs: 5 }, // After abort!
        ])

        expect(result.success).toBe(false)
      })
    })

    describe(`Non-existent Transactions`, () => {
      it(`rejects update on non-existent transaction`, () => {
        const result = executeRawEvents([
          { type: `update`, txnId: `ghost`, key: `x`, effect: assign(1) },
        ])

        expect(result.success).toBe(false)
      })

      it(`rejects read on non-existent transaction`, () => {
        const result = executeRawEvents([
          { type: `read`, txnId: `ghost`, key: `x` },
        ])

        expect(result.success).toBe(false)
      })

      it(`rejects commit on non-existent transaction`, () => {
        const result = executeRawEvents([
          { type: `commit`, txnId: `ghost`, commitTs: 5 },
        ])

        expect(result.success).toBe(false)
      })

      it(`rejects abort on non-existent transaction`, () => {
        const result = executeRawEvents([{ type: `abort`, txnId: `ghost` }])

        expect(result.success).toBe(false)
      })
    })

    describe(`Duplicate Transaction IDs`, () => {
      it(`rejects beginning a transaction with an existing ID`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `begin`, txnId: `t1`, snapshotTs: 5 }, // Duplicate!
        ])

        expect(result.success).toBe(false)
      })
    })
  })

  describe(`Edge Cases`, () => {
    describe(`Empty Transactions`, () => {
      it(`allows committing a transaction with no operations`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `commit`, txnId: `t1`, commitTs: 5 },
        ])

        // Empty transactions are valid (no-op)
        expect(result.success).toBe(true)
      })

      it(`allows aborting a transaction with no operations`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `abort`, txnId: `t1` },
        ])

        expect(result.success).toBe(true)
      })
    })

    describe(`Same Key Multiple Times`, () => {
      it(`allows multiple updates to the same key`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(1) },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(2) },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(3) },
          { type: `commit`, txnId: `t1`, commitTs: 5 },
        ])

        expect(result.success).toBe(true)
      })

      it(`reads see accumulated updates`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(10) },
          { type: `update`, txnId: `t1`, key: `x`, effect: increment(5) },
          { type: `read`, txnId: `t1`, key: `x` },
          { type: `commit`, txnId: `t1`, commitTs: 5 },
        ])

        expect(result.success).toBe(true)
        const readResult = result.results.find(
          (r: unknown) => (r as { type: string }).type === `read`
        ) as { value: unknown }
        expect(readResult.value).toBe(15)
      })
    })

    describe(`Interleaved Transactions`, () => {
      it(`handles interleaved operations on different transactions`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `begin`, txnId: `t2`, snapshotTs: 0 },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(1) },
          { type: `update`, txnId: `t2`, key: `y`, effect: assign(2) },
          { type: `read`, txnId: `t1`, key: `x` },
          { type: `read`, txnId: `t2`, key: `y` },
          { type: `commit`, txnId: `t2`, commitTs: 5 },
          { type: `commit`, txnId: `t1`, commitTs: 6 },
        ])

        expect(result.success).toBe(true)
      })
    })

    describe(`Large Number of Operations`, () => {
      it(`handles 100 operations in a single transaction`, () => {
        const events: Array<RawEvent> = [
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
        ]

        for (let i = 0; i < 100; i++) {
          events.push({
            type: `update`,
            txnId: `t1`,
            key: `x`,
            effect: increment(1),
          })
        }

        events.push({ type: `read`, txnId: `t1`, key: `x` })
        events.push({ type: `commit`, txnId: `t1`, commitTs: 100 })

        const result = executeRawEvents(events)

        expect(result.success).toBe(true)
        const readResult = result.results.find(
          (r: unknown) => (r as { type: string }).type === `read`
        ) as { value: unknown }
        expect(readResult.value).toBe(100)
      })
    })

    describe(`Many Concurrent Transactions`, () => {
      it(`handles 20 concurrent transactions`, () => {
        const events: Array<RawEvent> = []

        // Begin all
        for (let i = 0; i < 20; i++) {
          events.push({ type: `begin`, txnId: `t${i}`, snapshotTs: 0 })
        }

        // Each updates a different key
        for (let i = 0; i < 20; i++) {
          events.push({
            type: `update`,
            txnId: `t${i}`,
            key: `key${i}`,
            effect: assign(i),
          })
        }

        // Commit all
        for (let i = 0; i < 20; i++) {
          events.push({ type: `commit`, txnId: `t${i}`, commitTs: 100 + i })
        }

        const result = executeRawEvents(events)
        expect(result.success).toBe(true)
      })
    })
  })

  describe(`Semantic Edge Cases`, () => {
    describe(`Delete Semantics`, () => {
      it(`delete followed by assign results in assigned value`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `update`, txnId: `t1`, key: `x`, effect: del() },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(42) },
          { type: `read`, txnId: `t1`, key: `x` },
          { type: `commit`, txnId: `t1`, commitTs: 5 },
        ])

        expect(result.success).toBe(true)
        const readResult = result.results.find(
          (r: unknown) => (r as { type: string }).type === `read`
        ) as { value: unknown }
        expect(readResult.value).toBe(42)
      })

      it(`assign followed by delete results in BOTTOM`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `update`, txnId: `t1`, key: `x`, effect: assign(42) },
          { type: `update`, txnId: `t1`, key: `x`, effect: del() },
          { type: `read`, txnId: `t1`, key: `x` },
          { type: `commit`, txnId: `t1`, commitTs: 5 },
        ])

        expect(result.success).toBe(true)
        const readResult = result.results.find(
          (r: unknown) => (r as { type: string }).type === `read`
        ) as { value: unknown }
        expect(isBottom(readResult.value)).toBe(true)
      })
    })

    describe(`Increment on Uninitialized Key`, () => {
      it(`increment on never-assigned key treats it as 0 (I9)`, () => {
        const result = executeRawEvents([
          { type: `begin`, txnId: `t1`, snapshotTs: 0 },
          { type: `update`, txnId: `t1`, key: `x`, effect: increment(5) },
          { type: `read`, txnId: `t1`, key: `x` },
          { type: `commit`, txnId: `t1`, commitTs: 5 },
        ])

        expect(result.success).toBe(true)
        const readResult = result.results.find(
          (r: unknown) => (r as { type: string }).type === `read`
        ) as { value: unknown }
        expect(readResult.value).toBe(5)
      })
    })
  })
})
