/**
 * Conformance Tests for Reference Stores
 *
 * These tests verify that all reference store implementations
 * behave correctly according to the formal specification.
 */

import { describe, expect, it } from "vitest"
import {
  BOTTOM,
  assign,
  createJournalStore,
  createMapStore,
  createWALMemtablePair,
  del,
  executeScenario,
  formatReport,
  getStandardScenarios,
  increment,
  runConformanceTests,
  scenario,
} from "../src/index"

describe(`Reference Store Conformance`, () => {
  describe(`Map Store`, () => {
    const storeFactory = createMapStore

    it(`handles single transaction assign and read`, () => {
      const s = scenario(`assign and read`)
        .transaction(`t1`, { st: 0 })
        .update(`key1`, assign(42))
        .readExpect(`key1`, 42)
        .commit({ ct: 1 })
        .build()

      const store = storeFactory()
      const result = executeScenario(s, store)
      expect(result.success).toBe(true)
    })

    it(`handles concurrent increments`, () => {
      const s = scenario(`concurrent increments`)
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
        .readExpect(`counter`, 8)
        .commit({ ct: 15 })
        .build()

      const store = storeFactory()
      const result = executeScenario(s, store)
      expect(result.success).toBe(true)
    })

    it(`handles delete`, () => {
      const s = scenario(`delete`)
        .transaction(`t1`, { st: 0 })
        .update(`key`, assign(42))
        .commit({ ct: 5 })
        .transaction(`t2`, { st: 10 })
        .update(`key`, del())
        .commit({ ct: 15 })
        .transaction(`t3`, { st: 20 })
        .readExpect(`key`, BOTTOM)
        .commit({ ct: 25 })
        .build()

      const store = storeFactory()
      const result = executeScenario(s, store)
      expect(result.success).toBe(true)
    })
  })

  describe(`Journal Store`, () => {
    const storeFactory = createJournalStore

    it(`handles single transaction assign and read`, () => {
      const s = scenario(`assign and read`)
        .transaction(`t1`, { st: 0 })
        .update(`key1`, assign(42))
        .readExpect(`key1`, 42)
        .commit({ ct: 1 })
        .build()

      const store = storeFactory()
      const result = executeScenario(s, store)
      expect(result.success).toBe(true)
    })

    it(`handles sequential transactions`, () => {
      const s = scenario(`sequential transactions`)
        .transaction(`t1`, { st: 0 })
        .update(`x`, assign(10))
        .commit({ ct: 5 })
        .transaction(`t2`, { st: 10 })
        .readExpect(`x`, 10)
        .update(`x`, increment(5))
        .readExpect(`x`, 15)
        .commit({ ct: 15 })
        .transaction(`t3`, { st: 20 })
        .readExpect(`x`, 15)
        .commit({ ct: 25 })
        .build()

      const store = storeFactory()
      const result = executeScenario(s, store)
      expect(result.success).toBe(true)
    })
  })

  describe(`WAL-MemTable Pair`, () => {
    const storeFactory = createWALMemtablePair

    it(`handles single transaction assign and read`, () => {
      const s = scenario(`assign and read`)
        .transaction(`t1`, { st: 0 })
        .update(`key1`, assign(42))
        .readExpect(`key1`, 42)
        .commit({ ct: 1 })
        .build()

      const store = storeFactory()
      const result = executeScenario(s, store)
      expect(result.success).toBe(true)
    })
  })
})

describe(`Standard Scenarios`, () => {
  const scenarios = getStandardScenarios()

  describe(`against Map Store`, () => {
    for (const s of scenarios) {
      if (s.metadata.skip) continue

      it(s.metadata.name, () => {
        const store = createMapStore()
        const result = executeScenario(s, store)

        if (s.metadata.expectError) {
          expect(result.state.errors.length).toBeGreaterThan(0)
        } else {
          if (!result.success) {
            const failures = result.assertionResults
              .filter((r) => !r.passed)
              .map((r) => r.message)
            console.error(`Failures:`, failures)
          }
          expect(result.success).toBe(true)
        }
      })
    }
  })
})

describe(`Conformance Report`, () => {
  it(`generates a report for all reference stores`, () => {
    const results = runConformanceTests()
    const report = formatReport(results)

    // Just verify the report is generated
    expect(report).toContain(`Conformance Test Report`)
    expect(report).toContain(`map`)
    expect(report).toContain(`journal`)
  })
})
