/**
 * Test Entry Point
 *
 * This module exports utilities for testing implementations
 * against the formal specification.
 *
 * Usage:
 * ```typescript
 * import { createConformanceTests } from '@durable-streams/txn-spec/test'
 *
 * // Create tests for your store implementation
 * const tests = createConformanceTests({
 *   name: 'MyStore',
 *   factory: () => new MyStore(),
 * })
 *
 * // Run with vitest
 * describe('MyStore conformance', tests)
 * ```
 */

import {
  executeScenario,
  filterSkipped,
  getOnlyScenarios,
  getStandardScenarios,
} from "./scenario"
import { referenceStores } from "./test-generator"
import type { Key } from "./types"

// Re-export everything needed for testing
export {
  // Scenario DSL
  scenario,
  type ScenarioDefinition,
  type ScenarioBuilder,
  type TransactionBuilder,
  getStandardScenarios,
  executeScenario,
} from "./scenario"

export {
  // Effects for building scenarios
  assign,
  increment,
  del,
  custom,
} from "./effects"

export {
  // Types
  BOTTOM,
} from "./types"

export { type StoreInterface } from "./transaction"

export {
  // Test execution
  type StoreFactory,
  type ScenarioTestResult,
  type TestSuiteResult,
  runScenario,
  runScenarios,
  runConformanceTests,
  referenceStores,
  formatReport,
} from "./test-generator"

export {
  // Reference stores for comparison
  createMapStore,
  createJournalStore,
  createWALMemtablePair,
  createTraceBuildingStore,
} from "./store"

// =============================================================================
// Vitest Integration
// =============================================================================

/**
 * Options for creating conformance tests.
 */
export interface ConformanceTestOptions {
  /** Name of the store being tested */
  name: string
  /** Factory function to create a fresh store */
  factory: StoreFactory
  /** Custom scenarios (defaults to standard) */
  scenarios?: Array<ScenarioDefinition>
  /** Whether to also test against reference stores for comparison */
  compareWithReference?: boolean
  /** Timeout per scenario (ms) */
  timeout?: number
}

/**
 * Create a vitest-compatible test function for conformance testing.
 *
 * @example
 * ```typescript
 * import { describe } from 'vitest'
 * import { createConformanceTests } from '@durable-streams/txn-spec/test'
 * import { MyStore } from './my-store'
 *
 * describe('MyStore', createConformanceTests({
 *   name: 'MyStore',
 *   factory: () => new MyStore(),
 * }))
 * ```
 */
export function createConformanceTests(
  options: ConformanceTestOptions
): () => void {
  return () => {
    const scenarios = options.scenarios ?? getStandardScenarios()
    const filtered = getOnlyScenarios(filterSkipped(scenarios))

    // Import vitest dynamically to avoid requiring it at build time
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const vitest = require(`vitest`) as typeof import(`vitest`)

    for (const scenario of filtered) {
      const testFn = scenario.metadata.skip
        ? vitest.it.skip
        : scenario.metadata.only
          ? vitest.it.only
          : vitest.it

      testFn(
        scenario.metadata.name,
        () => {
          const store = options.factory()
          const result = executeScenario(scenario, store)

          if (!result.success) {
            const failures = result.assertionResults.filter((r) => !r.passed)
            const messages = failures.map((f) => f.message).join(`\n`)
            throw new Error(`Scenario failed:\n${messages}`)
          }
        },
        options.timeout
      )
    }

    // Optional: compare with reference stores
    if (options.compareWithReference) {
      vitest.describe(`Reference comparison`, () => {
        for (const [refName, refFactory] of Object.entries(referenceStores)) {
          vitest.it(`matches ${refName} store behavior`, () => {
            for (const scenario of filtered) {
              const implStore = options.factory()
              const refStore = refFactory()

              const implResult = executeScenario(scenario, implStore)
              const refResult = executeScenario(scenario, refStore)

              // Both should have same success status
              if (implResult.success !== refResult.success) {
                throw new Error(
                  `Behavior mismatch with ${refName} on "${scenario.metadata.name}": ` +
                    `impl=${implResult.success}, ref=${refResult.success}`
                )
              }
            }
          })
        }
      })
    }
  }
}

/**
 * Create a standalone test runner (doesn't require vitest).
 */
export function createTestRunner(options: ConformanceTestOptions): {
  run: () => {
    passed: number
    failed: number
    results: Array<ScenarioTestResult>
  }
  report: () => string
} {
  let results: Array<ScenarioTestResult> = []

  return {
    run() {
      const scenarios = options.scenarios ?? getStandardScenarios()
      const suiteResult = runScenarios(scenarios, options.factory, options.name)
      results = suiteResult.results
      return {
        passed: suiteResult.passed,
        failed: suiteResult.failed,
        results,
      }
    },

    report() {
      const passed = results.filter((r) => r.passed).length
      const failed = results.filter((r) => !r.passed).length
      const lines: Array<string> = []

      lines.push(`Conformance Test Results: ${options.name}`)
      lines.push(`=`.repeat(50))
      lines.push(`Passed: ${passed}`)
      lines.push(`Failed: ${failed}`)
      lines.push(``)

      for (const result of results) {
        const status = result.passed ? `✓` : `✗`
        lines.push(`${status} ${result.scenario.metadata.name}`)
        if (!result.passed) {
          for (const assertion of result.assertionResults) {
            if (!assertion.passed) {
              lines.push(`    ${assertion.message}`)
            }
          }
          if (result.error) {
            lines.push(`    Error: ${result.error.message}`)
          }
        }
      }

      return lines.join(`\n`)
    },
  }
}

// =============================================================================
// Property-Based Testing Hooks
// =============================================================================

/**
 * Generate random scenarios for property-based testing.
 * Useful with libraries like fast-check.
 */
export interface RandomScenarioOptions {
  /** Maximum number of transactions */
  maxTransactions: number
  /** Maximum operations per transaction */
  maxOperationsPerTxn: number
  /** Key pool to choose from */
  keys: Array<Key>
  /** Random seed (for reproducibility) */
  seed?: number
}

/**
 * Generate a random scenario.
 * For use with property-based testing frameworks.
 */
export function generateRandomScenario(
  options: RandomScenarioOptions,
  rng: () => number = Math.random
): ScenarioDefinition {
  const { maxTransactions, maxOperationsPerTxn, keys } = options

  const numTransactions = Math.floor(rng() * maxTransactions) + 1
  let currentTs = 0

  let builder = scenario(`random-${Date.now()}`)

  for (let i = 0; i < numTransactions; i++) {
    const txnId = `txn-${i}`
    const st = currentTs
    currentTs += Math.floor(rng() * 10) + 1

    let txnBuilder = builder.transaction(txnId, { st })

    const numOps = Math.floor(rng() * maxOperationsPerTxn) + 1
    for (let j = 0; j < numOps; j++) {
      const key = keys[Math.floor(rng() * keys.length)]!
      const opType = rng()

      if (opType < 0.4) {
        // Assign
        txnBuilder = txnBuilder.update(key, assign(Math.floor(rng() * 100)))
      } else if (opType < 0.7) {
        // Increment
        txnBuilder = txnBuilder.update(
          key,
          increment(Math.floor(rng() * 10) - 5)
        )
      } else if (opType < 0.8) {
        // Delete
        txnBuilder = txnBuilder.update(key, del())
      } else {
        // Read
        txnBuilder = txnBuilder.read(key)
      }
    }

    // Randomly commit or abort
    if (rng() < 0.9) {
      currentTs += Math.floor(rng() * 5) + 1
      builder = txnBuilder.commit({ ct: currentTs })
    } else {
      builder = txnBuilder.abort()
    }
  }

  return builder.build()
}

/**
 * Property: All stores should return the same lookup results.
 */
export function storesAreEquivalent(
  scenarios: Array<ScenarioDefinition>,
  stores: Map<string, StoreFactory>
): { allEquivalent: boolean; differences: Array<string> } {
  const differences: Array<string> = []

  for (const scenario of scenarios) {
    const results = new Map<string, boolean>()

    for (const [name, factory] of stores) {
      const store = factory()
      const result = executeScenario(scenario, store)
      results.set(name, result.success)
    }

    // Check all stores agree
    const values = [...results.values()]
    const allSame = values.every((v) => v === values[0])
    if (!allSame) {
      const entries = [...results.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join(`, `)
      differences.push(`Scenario "${scenario.metadata.name}": ${entries}`)
    }
  }

  return {
    allEquivalent: differences.length === 0,
    differences,
  }
}
