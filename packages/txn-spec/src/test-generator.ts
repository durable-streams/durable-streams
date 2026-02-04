/**
 * Test Generator
 *
 * Generates vitest test files from scenario definitions.
 * Supports multiple output formats:
 * - Direct vitest execution (for reference stores)
 * - Generated test files (for custom implementations)
 * - YAML export (for cross-language conformance)
 *
 * @example
 * ```typescript
 * // Generate tests for a custom store implementation
 * const tests = generateTests(getStandardScenarios(), {
 *   storeFactory: () => myCustomStore,
 *   outputPath: './tests/conformance.test.ts'
 * })
 *
 * // Or run directly against reference stores
 * runConformanceTests(getStandardScenarios())
 * ```
 */

import {
  executeScenario,
  filterSkipped,
  getOnlyScenarios,
  getStandardScenarios,
} from "./scenario"

import {
  createJournalStore,
  createMapStore,
  createTraceBuildingStore,
  createWALMemtablePair,
} from "./store"
import { BOTTOM } from "./types"
// Import BOTTOM for use in generated code
import type { ScenarioAssertion, ScenarioDefinition } from "./scenario"
import type { StoreInterface } from "./transaction"
import type { Effect } from "./types"

// =============================================================================
// Test Runner Types
// =============================================================================

/**
 * Store factory - creates a fresh store for each test.
 */
export type StoreFactory = () => StoreInterface

/**
 * Test result for a single scenario.
 */
export interface ScenarioTestResult {
  scenario: ScenarioDefinition
  storeName: string
  passed: boolean
  duration: number
  assertionResults: Array<{
    assertion: ScenarioAssertion
    passed: boolean
    message?: string
  }>
  error?: Error
}

/**
 * Test suite result.
 */
export interface TestSuiteResult {
  totalScenarios: number
  passed: number
  failed: number
  skipped: number
  duration: number
  results: Array<ScenarioTestResult>
}

/**
 * Test generator options.
 */
export interface TestGeneratorOptions {
  /** Store factory to test against */
  storeFactory: StoreFactory
  /** Name of the store (for reporting) */
  storeName?: string
  /** Output path for generated test file */
  outputPath?: string
  /** Whether to run tests in parallel */
  parallel?: boolean
  /** Timeout per scenario (ms) */
  timeout?: number
  /** Custom scenarios (defaults to standard) */
  scenarios?: Array<ScenarioDefinition>
  /** Whether to run only 'only' scenarios */
  respectOnly?: boolean
  /** Whether to skip 'skip' scenarios */
  respectSkip?: boolean
}

// =============================================================================
// Built-in Store Factories
// =============================================================================

/**
 * Reference store factories for conformance testing.
 */
export const referenceStores: Record<string, StoreFactory> = {
  map: createMapStore,
  journal: createJournalStore,
  walMemtable: createWALMemtablePair,
  traceBuilding: createTraceBuildingStore,
}

// =============================================================================
// Test Execution
// =============================================================================

/**
 * Run a single scenario against a store.
 */
export function runScenario(
  scenario: ScenarioDefinition,
  storeFactory: StoreFactory,
  storeName: string
): ScenarioTestResult {
  const start = Date.now()
  let error: Error | undefined

  try {
    const store = storeFactory()
    const result = executeScenario(scenario, store)

    return {
      scenario,
      storeName,
      passed: result.success,
      duration: Date.now() - start,
      assertionResults: result.assertionResults,
    }
  } catch (e) {
    error = e as Error
    return {
      scenario,
      storeName,
      passed: false,
      duration: Date.now() - start,
      assertionResults: [],
      error,
    }
  }
}

/**
 * Run all scenarios against a store.
 */
export function runScenarios(
  scenarios: Array<ScenarioDefinition>,
  storeFactory: StoreFactory,
  storeName: string
): TestSuiteResult {
  const start = Date.now()
  const results: Array<ScenarioTestResult> = []

  // Handle only/skip
  let filtered = filterSkipped(scenarios)
  filtered = getOnlyScenarios(filtered)

  const skipped = scenarios.length - filtered.length

  for (const scenario of filtered) {
    results.push(runScenario(scenario, storeFactory, storeName))
  }

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length

  return {
    totalScenarios: scenarios.length,
    passed,
    failed,
    skipped,
    duration: Date.now() - start,
    results,
  }
}

/**
 * Run conformance tests against all reference stores.
 */
export function runConformanceTests(
  scenarios: Array<ScenarioDefinition> = getStandardScenarios()
): Map<string, TestSuiteResult> {
  const results = new Map<string, TestSuiteResult>()

  for (const [name, factory] of Object.entries(referenceStores)) {
    results.set(name, runScenarios(scenarios, factory, name))
  }

  return results
}

// =============================================================================
// Test Code Generation
// =============================================================================

/**
 * Generate vitest test code for scenarios.
 */
export function generateTestCode(
  scenarios: Array<ScenarioDefinition>,
  options: {
    storeName: string
    storeImport: string
    storeFactory: string
  }
): string {
  const lines: Array<string> = []

  // Header
  lines.push(`/**`)
  lines.push(` * Generated conformance tests for ${options.storeName}`)
  lines.push(` * Generated by @durable-streams/txn-spec`)
  lines.push(` */`)
  lines.push(``)
  lines.push(`import { describe, it, expect } from 'vitest'`)
  lines.push(`import {`)
  lines.push(`  executeScenario,`)
  lines.push(`  scenario,`)
  lines.push(`  assign,`)
  lines.push(`  increment,`)
  lines.push(`  del,`)
  lines.push(`  BOTTOM,`)
  lines.push(`} from '@durable-streams/txn-spec'`)
  lines.push(`import { ${options.storeImport} } from '${options.storeFactory}'`)
  lines.push(``)

  // Test suite
  lines.push(`describe('${options.storeName} conformance', () => {`)

  for (const scenarioDef of scenarios) {
    const testFn = scenarioDef.metadata.skip
      ? `it.skip`
      : scenarioDef.metadata.only
        ? `it.only`
        : `it`

    lines.push(
      `  ${testFn}('${escapeString(scenarioDef.metadata.name)}', () => {`
    )
    lines.push(`    const store = ${options.storeImport}()`)
    lines.push(``)

    // Generate scenario code
    lines.push(`    const scenarioDef = ${generateScenarioCode(scenarioDef)}`)
    lines.push(``)
    lines.push(`    const result = executeScenario(scenarioDef, store)`)
    lines.push(``)

    if (scenarioDef.metadata.expectError) {
      lines.push(`    // This scenario expects errors`)
      lines.push(`    expect(result.state.errors.length).toBeGreaterThan(0)`)
    } else {
      lines.push(`    expect(result.success).toBe(true)`)
      lines.push(`    if (!result.success) {`)
      lines.push(
        `      const failures = result.assertionResults.filter(r => !r.passed)`
      )
      lines.push(
        `      console.error('Assertion failures:', failures.map(f => f.message))`
      )
      lines.push(`    }`)
    }

    lines.push(`  })`)
    lines.push(``)
  }

  lines.push(`})`)

  return lines.join(`\n`)
}

/**
 * Generate scenario code as a string.
 */
function generateScenarioCode(scenario: ScenarioDefinition): string {
  const lines: Array<string> = []
  lines.push(`scenario('${escapeString(scenario.metadata.name)}')`)

  if (scenario.metadata.description) {
    lines.push(`.description('${escapeString(scenario.metadata.description)}')`)
  }

  if (scenario.metadata.expectError) {
    lines.push(`.expectError()`)
  }

  // Group operations by transaction
  let currentTxn: string | null = null

  for (const op of scenario.operations) {
    switch (op.type) {
      case `begin`:
        if (currentTxn !== null) {
          // Previous transaction wasn't terminated - unusual but handle it
        }
        currentTxn = op.txnId
        lines.push(`.transaction('${op.txnId}', { st: ${op.snapshotTs} })`)
        break

      case `update`:
        lines.push(`  .update('${op.key}', ${effectToCode(op.effect)})`)
        break

      case `read`:
        if (op.expectedValue !== undefined) {
          lines.push(
            `  .readExpect('${op.key}', ${valueToCode(op.expectedValue)})`
          )
        } else {
          lines.push(`  .read('${op.key}')`)
        }
        break

      case `commit`:
        lines.push(`  .commit({ ct: ${op.commitTs} })`)
        currentTxn = null
        break

      case `abort`:
        lines.push(`  .abort()`)
        currentTxn = null
        break
    }
  }

  // Add assertions
  for (const assertion of scenario.assertions) {
    switch (assertion.type) {
      case `commit-fails`:
        lines.push(`.assertCommitFails('${assertion.txnId}')`)
        break
      case `no-inversion`:
        lines.push(`.assertNoInversion()`)
        break
      case `lookup-effect`:
        lines.push(
          `.assertLookup('${assertion.key}', ${assertion.st}, ${effectToCode(assertion.expected)})`
        )
        break
    }
  }

  lines.push(`.build()`)

  return lines.join(`\n      `)
}

/**
 * Convert an effect to code representation.
 */
function effectToCode(effect: unknown): string {
  if (effect === BOTTOM) {
    return `BOTTOM`
  }

  const e = effect as Effect
  switch (e.type) {
    case `assign`:
      return `assign(${JSON.stringify(e.value)})`
    case `increment`:
      return `increment(${e.delta})`
    case `delete`:
      return `del()`
    case `custom`:
      return `/* custom effect: ${e.name} */`
    default:
      return `/* unknown effect */`
  }
}

/**
 * Convert a value to code representation.
 */
function valueToCode(value: unknown): string {
  if (value === BOTTOM) {
    return `BOTTOM`
  }
  return JSON.stringify(value)
}

/**
 * Escape a string for use in generated code.
 */
function escapeString(s: string): string {
  return s.replace(/'/g, `\\'`).replace(/\n/g, `\\n`)
}

// =============================================================================
// YAML Export (for cross-language conformance)
// =============================================================================

/**
 * Export scenarios to YAML format for cross-language testing.
 */
export function exportToYAML(scenarios: Array<ScenarioDefinition>): string {
  const lines: Array<string> = []

  lines.push(`# Transactional Storage Conformance Tests`)
  lines.push(`# Generated by @durable-streams/txn-spec`)
  lines.push(``)

  for (const scenario of scenarios) {
    lines.push(`- name: "${scenario.metadata.name}"`)
    if (scenario.metadata.description) {
      lines.push(`  description: "${scenario.metadata.description}"`)
    }
    if (scenario.metadata.skip) {
      lines.push(`  skip: true`)
    }
    if (scenario.metadata.expectError) {
      lines.push(`  expectError: true`)
    }

    lines.push(`  operations:`)
    for (const op of scenario.operations) {
      switch (op.type) {
        case `begin`:
          lines.push(`    - type: begin`)
          lines.push(`      txnId: "${op.txnId}"`)
          lines.push(`      snapshotTs: ${op.snapshotTs}`)
          break
        case `update`:
          lines.push(`    - type: update`)
          lines.push(`      txnId: "${op.txnId}"`)
          lines.push(`      key: "${op.key}"`)
          lines.push(`      effect: ${effectToYAML(op.effect)}`)
          break
        case `read`:
          lines.push(`    - type: read`)
          lines.push(`      txnId: "${op.txnId}"`)
          lines.push(`      key: "${op.key}"`)
          if (op.expectedValue !== undefined) {
            lines.push(`      expectedValue: ${valueToYAML(op.expectedValue)}`)
          }
          break
        case `commit`:
          lines.push(`    - type: commit`)
          lines.push(`      txnId: "${op.txnId}"`)
          lines.push(`      commitTs: ${op.commitTs}`)
          break
        case `abort`:
          lines.push(`    - type: abort`)
          lines.push(`      txnId: "${op.txnId}"`)
          break
      }
    }

    if (scenario.assertions.length > 0) {
      lines.push(`  assertions:`)
      for (const assertion of scenario.assertions) {
        lines.push(`    - type: ${assertion.type}`)
        if (assertion.type === `read-value`) {
          lines.push(`      txnId: "${assertion.txnId}"`)
          lines.push(`      key: "${assertion.key}"`)
          lines.push(`      expected: ${valueToYAML(assertion.expected)}`)
        } else if (assertion.type === `commit-fails`) {
          lines.push(`      txnId: "${assertion.txnId}"`)
        } else if (assertion.type === `lookup-effect`) {
          lines.push(`      key: "${assertion.key}"`)
          lines.push(`      st: ${assertion.st}`)
          lines.push(`      expected: ${effectToYAML(assertion.expected)}`)
        }
      }
    }

    lines.push(``)
  }

  return lines.join(`\n`)
}

/**
 * Convert effect to YAML representation.
 */
function effectToYAML(effect: unknown): string {
  if (effect === BOTTOM) {
    return `null`
  }

  const e = effect as Effect
  switch (e.type) {
    case `assign`:
      return `{ type: assign, value: ${JSON.stringify(e.value)} }`
    case `increment`:
      return `{ type: increment, delta: ${e.delta} }`
    case `delete`:
      return `{ type: delete }`
    default:
      return `{ type: unknown }`
  }
}

/**
 * Convert value to YAML representation.
 */
function valueToYAML(value: unknown): string {
  if (value === BOTTOM) {
    return `null`
  }
  return JSON.stringify(value)
}

// =============================================================================
// Reporting
// =============================================================================

/**
 * Format test results as a string report.
 */
export function formatReport(results: Map<string, TestSuiteResult>): string {
  const lines: Array<string> = []

  lines.push(`=`.repeat(60))
  lines.push(`Conformance Test Report`)
  lines.push(`=`.repeat(60))
  lines.push(``)

  for (const [storeName, result] of results) {
    lines.push(`Store: ${storeName}`)
    lines.push(`-`.repeat(40))
    lines.push(`  Total:   ${result.totalScenarios}`)
    lines.push(`  Passed:  ${result.passed}`)
    lines.push(`  Failed:  ${result.failed}`)
    lines.push(`  Skipped: ${result.skipped}`)
    lines.push(`  Duration: ${result.duration}ms`)
    lines.push(``)

    // Failed scenarios
    const failed = result.results.filter((r) => !r.passed)
    if (failed.length > 0) {
      lines.push(`  Failed scenarios:`)
      for (const failure of failed) {
        lines.push(`    - ${failure.scenario.metadata.name}`)
        if (failure.error) {
          lines.push(`      Error: ${failure.error.message}`)
        }
        for (const assertion of failure.assertionResults) {
          if (!assertion.passed) {
            lines.push(`      Assertion: ${assertion.message}`)
          }
        }
      }
      lines.push(``)
    }
  }

  // Summary
  const totalPassed = [...results.values()].reduce(
    (sum, r) => sum + r.passed,
    0
  )
  const totalFailed = [...results.values()].reduce(
    (sum, r) => sum + r.failed,
    0
  )

  lines.push(`=`.repeat(60))
  lines.push(`Summary: ${totalPassed} passed, ${totalFailed} failed`)
  lines.push(`=`.repeat(60))

  return lines.join(`\n`)
}

// =============================================================================
// CLI Entry Point
// =============================================================================

/**
 * Run conformance tests from CLI.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function runCLI(): Promise<void> {
  console.log(`Running conformance tests against reference stores...`)
  console.log(``)

  const results = runConformanceTests()
  console.log(formatReport(results))

  const totalFailed = [...results.values()].reduce(
    (sum, r) => sum + r.failed,
    0
  )
  if (totalFailed > 0) {
    process.exit(1)
  }
}
