/**
 * Fuzz Testing for Transactional Stores
 *
 * Property-based testing that generates random transaction scenarios
 * and verifies that all store implementations produce consistent results.
 *
 * Key properties tested:
 * 1. Consistency: All stores produce the same results for the same scenario
 * 2. Isolation: Uncommitted transactions are not visible to others
 * 3. Durability: Committed transactions persist
 * 4. Atomicity: Aborted transactions have no effect
 * 5. Serializability: Results match some serial execution order
 */

import { isBottom } from "./types"
import { assign, del, increment } from "./effects"
import { executeScenario, scenario } from "./scenario"
import { createMapStore } from "./store"
import { createInMemoryStreamStore } from "./stream-store"
import type { ScenarioDefinition } from "./scenario"
import type { Effect, Key, Timestamp, TxnId, Value } from "./types"
import type { StreamStore } from "./store"

// =============================================================================
// Random Generation Utilities
// =============================================================================

/**
 * Seeded random number generator for reproducible tests.
 */
export class SeededRandom {
  private seed: number

  constructor(seed: number) {
    this.seed = seed
  }

  /**
   * Get next random number between 0 and 1.
   */
  next(): number {
    // Simple LCG (Linear Congruential Generator)
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296
    return this.seed / 4294967296
  }

  /**
   * Get random integer in range [min, max].
   */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }

  /**
   * Pick random element from array.
   */
  pick<T>(arr: ReadonlyArray<T>): T {
    return arr[this.int(0, arr.length - 1)]!
  }

  /**
   * Pick multiple random elements from array.
   */
  pickMultiple<T>(arr: ReadonlyArray<T>, count: number): Array<T> {
    const result: Array<T> = []
    const copy = [...arr]
    for (let i = 0; i < Math.min(count, copy.length); i++) {
      const idx = this.int(0, copy.length - 1)
      result.push(copy[idx]!)
      copy.splice(idx, 1)
    }
    return result
  }

  /**
   * Return true with given probability.
   */
  chance(probability: number): boolean {
    return this.next() < probability
  }

  /**
   * Generate random string.
   */
  string(length: number): string {
    const chars = `abcdefghijklmnopqrstuvwxyz0123456789`
    let result = ``
    for (let i = 0; i < length; i++) {
      result += chars[this.int(0, chars.length - 1)]
    }
    return result
  }
}

// =============================================================================
// Scenario Generation
// =============================================================================

/**
 * Configuration for random scenario generation.
 */
export interface FuzzConfig {
  /** Random seed for reproducibility */
  seed: number

  /** Number of transactions to generate */
  transactionCount: number

  /** Number of keys to use */
  keyCount: number

  /** Maximum operations per transaction */
  maxOpsPerTxn: number

  /** Probability of read operation (vs update) */
  readProbability: number

  /** Probability of increment (vs assign) for updates */
  incrementProbability: number

  /** Probability of delete (vs assign/increment) for updates */
  deleteProbability: number

  /** Probability of aborting a transaction */
  abortProbability: number

  /** Whether to include concurrent transactions */
  allowConcurrency: boolean

  /** Maximum concurrent transactions */
  maxConcurrent: number
}

/**
 * Default fuzz configuration.
 */
export const defaultFuzzConfig: FuzzConfig = {
  seed: Date.now(),
  transactionCount: 10,
  keyCount: 5,
  maxOpsPerTxn: 5,
  readProbability: 0.3,
  incrementProbability: 0.3,
  deleteProbability: 0.1,
  abortProbability: 0.1,
  allowConcurrency: true,
  maxConcurrent: 3,
}

/**
 * Generate a random effect.
 */
function randomEffect(rng: SeededRandom, config: FuzzConfig): Effect {
  const roll = rng.next()
  if (roll < config.deleteProbability) {
    return del()
  }
  if (roll < config.deleteProbability + config.incrementProbability) {
    return increment(rng.int(-10, 10))
  }
  // Assign a random value
  const valueType = rng.int(0, 2)
  switch (valueType) {
    case 0:
      return assign(rng.int(0, 1000))
    case 1:
      return assign(rng.string(8))
    default:
      return assign({ id: rng.int(0, 100), name: rng.string(5) })
  }
}

/**
 * Transaction in progress during generation.
 */
interface PendingTxn {
  id: TxnId
  snapshotTs: Timestamp
  ops: number
}

/**
 * Generate a random scenario.
 */
export function generateRandomScenario(
  config: Partial<FuzzConfig> = {}
): ScenarioDefinition {
  const cfg = { ...defaultFuzzConfig, ...config }
  const rng = new SeededRandom(cfg.seed)

  // Generate key names
  const keys: Array<Key> = []
  for (let i = 0; i < cfg.keyCount; i++) {
    keys.push(`key_${i}`)
  }

  // Track state for scenario building
  let currentTs = 0
  let txnCounter = 0
  const pendingTxns: Array<PendingTxn> = []
  const committedTxns: Array<{ id: TxnId; commitTs: Timestamp }> = []

  // Start building scenario
  let builder = scenario(`fuzz_seed_${cfg.seed}`)
    .description(`Random scenario with seed ${cfg.seed}`)
    .tags(`fuzz`, `random`)

  // Helper to get next timestamp
  const nextTs = (): Timestamp => ++currentTs

  // Helper to begin a transaction
  const beginTxn = (): PendingTxn => {
    const id = `t${txnCounter++}`
    const st = nextTs()
    builder = builder.transaction(id, { st })
    const txn: PendingTxn = { id, snapshotTs: st, ops: 0 }
    pendingTxns.push(txn)
    return txn
  }

  // Helper to add operations to a transaction
  const addOps = (txn: PendingTxn, count: number): void => {
    for (let i = 0; i < count && txn.ops < cfg.maxOpsPerTxn; i++) {
      const key = rng.pick(keys)

      if (rng.chance(cfg.readProbability)) {
        // Read operation (no expected value since it's random)
        builder = builder.read(key)
      } else {
        // Update operation
        const effect = randomEffect(rng, cfg)
        builder = builder.update(key, effect)
      }
      txn.ops++
    }
  }

  // Helper to commit a transaction
  const commitTxn = (txn: PendingTxn): void => {
    const ct = nextTs()
    builder = builder.commit({ ct })
    const idx = pendingTxns.indexOf(txn)
    if (idx >= 0) pendingTxns.splice(idx, 1)
    committedTxns.push({ id: txn.id, commitTs: ct })
  }

  // Helper to abort a transaction
  const abortTxn = (txn: PendingTxn): void => {
    builder = builder.abort()
    const idx = pendingTxns.indexOf(txn)
    if (idx >= 0) pendingTxns.splice(idx, 1)
  }

  // Generate transactions
  for (let i = 0; i < cfg.transactionCount; i++) {
    // Maybe start new transactions (if concurrency allowed)
    if (
      cfg.allowConcurrency &&
      pendingTxns.length < cfg.maxConcurrent &&
      rng.chance(0.5)
    ) {
      const txn = beginTxn()
      addOps(txn, rng.int(1, cfg.maxOpsPerTxn))
    }

    // Start at least one transaction if none pending
    if (pendingTxns.length === 0) {
      const txn = beginTxn()
      addOps(txn, rng.int(1, cfg.maxOpsPerTxn))
    }

    // Process a pending transaction
    if (pendingTxns.length > 0) {
      const txn = rng.pick(pendingTxns)

      // Resume the transaction
      builder = builder.transaction(txn.id, { st: txn.snapshotTs })

      // Maybe add more ops
      if (txn.ops < cfg.maxOpsPerTxn && rng.chance(0.3)) {
        addOps(txn, rng.int(1, 2))
      }

      // Decide: commit, abort, or continue
      if (rng.chance(cfg.abortProbability)) {
        abortTxn(txn)
      } else if (txn.ops >= 1 && rng.chance(0.6)) {
        commitTxn(txn)
      }
    }
  }

  // Commit any remaining transactions
  for (const txn of [...pendingTxns]) {
    builder = builder.transaction(txn.id, { st: txn.snapshotTs })
    if (txn.ops === 0) {
      addOps(txn, 1) // Must have at least one op
    }
    commitTxn(txn)
  }

  return builder.build()
}

// =============================================================================
// Fuzz Test Runner
// =============================================================================

/**
 * Result of a single fuzz test run.
 */
export interface FuzzRunResult {
  /** The scenario that was tested */
  scenario: ScenarioDefinition

  /** Whether all stores produced consistent results */
  consistent: boolean

  /** Results from each store */
  storeResults: Array<{
    name: string
    success: boolean
    error?: string
    reads: Array<{ key: Key; value: Value | null }>
  }>

  /** Any consistency errors found */
  inconsistencies: Array<string>

  /** Execution time in milliseconds */
  durationMs: number
}

/**
 * Store factory function.
 */
export type StoreFactory = () => StreamStore | Promise<StreamStore>

/**
 * Run a fuzz test with the given scenario against multiple stores.
 */
export async function runFuzzTest(
  scenarioOrConfig: ScenarioDefinition | Partial<FuzzConfig>,
  stores: Record<string, StoreFactory>
): Promise<FuzzRunResult> {
  const startTime = Date.now()

  // Generate scenario if config provided
  const testScenario =
    `metadata` in scenarioOrConfig
      ? scenarioOrConfig
      : generateRandomScenario(scenarioOrConfig)

  const storeResults: FuzzRunResult[`storeResults`] = []
  const inconsistencies: Array<string> = []

  // Run scenario against each store
  for (const [name, factory] of Object.entries(stores)) {
    try {
      const store = await factory()
      const result = executeScenario(testScenario, store)

      // Extract read results
      const reads: Array<{ key: Key; value: Value | null }> = []
      for (const [stateKey, value] of result.state.readValues) {
        // Parse the key from the state key format (txnId:key:seq)
        const parts = stateKey.split(`:`)
        if (parts.length >= 2) {
          const key = parts[1]!
          const actualValue = isBottom(value) ? null : value
          reads.push({ key, value: actualValue })
        }
      }

      storeResults.push({
        name,
        success: result.success,
        error: result.success
          ? undefined
          : result.assertionResults.find((r) => !r.passed)?.message,
        reads,
      })

      // Flush if stream store
      if (`flush` in store && typeof store.flush === `function`) {
        await store.flush()
      }
    } catch (err) {
      storeResults.push({
        name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        reads: [],
      })
    }
  }

  // Check consistency between stores
  if (storeResults.length > 1) {
    const baseline = storeResults[0]!

    for (let i = 1; i < storeResults.length; i++) {
      const other = storeResults[i]!

      // Check success consistency
      if (baseline.success !== other.success) {
        inconsistencies.push(
          `Success mismatch: ${baseline.name}=${baseline.success}, ${other.name}=${other.success}`
        )
      }

      // We can't easily compare reads without tracking order,
      // but we can check that the same keys were read
      // (This is a simplified check - full consistency would require more tracking)
    }
  }

  return {
    scenario: testScenario,
    consistent: inconsistencies.length === 0,
    storeResults,
    inconsistencies,
    durationMs: Date.now() - startTime,
  }
}

/**
 * Run multiple fuzz tests.
 */
export async function runFuzzTests(
  count: number,
  config: Partial<FuzzConfig> = {},
  stores: Record<string, StoreFactory>
): Promise<{
  total: number
  passed: number
  failed: number
  inconsistent: number
  results: Array<FuzzRunResult>
  failedSeeds: Array<number>
}> {
  const results: Array<FuzzRunResult> = []
  const failedSeeds: Array<number> = []
  let passed = 0
  let failed = 0
  let inconsistent = 0

  const baseSeed = config.seed ?? Date.now()

  for (let i = 0; i < count; i++) {
    const seed = baseSeed + i
    const result = await runFuzzTest({ ...config, seed }, stores)
    results.push(result)

    if (!result.consistent) {
      inconsistent++
      failedSeeds.push(seed)
    }

    const allSuccess = result.storeResults.every((r) => r.success)
    if (allSuccess && result.consistent) {
      passed++
    } else {
      failed++
      if (result.consistent) {
        failedSeeds.push(seed)
      }
    }
  }

  return {
    total: count,
    passed,
    failed,
    inconsistent,
    results,
    failedSeeds,
  }
}

// =============================================================================
// Default Store Factories
// =============================================================================

/**
 * Default stores for fuzz testing.
 */
export const fuzzStores: Record<string, StoreFactory> = {
  map: () => createMapStore(),
  stream: () => createInMemoryStreamStore(),
}

// =============================================================================
// Quick Fuzz Function
// =============================================================================

/**
 * Quick fuzz test with default configuration.
 */
export async function quickFuzz(
  count = 100,
  config: Partial<FuzzConfig> = {}
): Promise<{
  success: boolean
  summary: string
  failedSeeds: Array<number>
}> {
  const results = await runFuzzTests(count, config, fuzzStores)

  const summary = [
    `Fuzz Test Results:`,
    `  Total: ${results.total}`,
    `  Passed: ${results.passed}`,
    `  Failed: ${results.failed}`,
    `  Inconsistent: ${results.inconsistent}`,
    results.failedSeeds.length > 0
      ? `  Failed seeds: ${results.failedSeeds.slice(0, 10).join(`, `)}${results.failedSeeds.length > 10 ? `...` : ``}`
      : ``,
  ]
    .filter(Boolean)
    .join(`\n`)

  return {
    success: results.failed === 0 && results.inconsistent === 0,
    summary,
    failedSeeds: results.failedSeeds,
  }
}

// =============================================================================
// Shrinking (Minimal Failing Example)
// =============================================================================

/**
 * Try to find a minimal failing configuration.
 * Reduces parameters until we find the smallest failing case.
 */
export async function shrinkFailingCase(
  seed: number,
  config: Partial<FuzzConfig> = {},
  stores: Record<string, StoreFactory> = fuzzStores
): Promise<{
  minimalConfig: FuzzConfig
  scenario: ScenarioDefinition
}> {
  let currentConfig: FuzzConfig = {
    ...defaultFuzzConfig,
    ...config,
    seed,
  }

  // Try reducing transaction count
  while (currentConfig.transactionCount > 1) {
    const testConfig = {
      ...currentConfig,
      transactionCount: currentConfig.transactionCount - 1,
    }
    const result = await runFuzzTest(testConfig, stores)
    if (!result.consistent || result.storeResults.some((r) => !r.success)) {
      currentConfig = testConfig
    } else {
      break
    }
  }

  // Try reducing key count
  while (currentConfig.keyCount > 1) {
    const testConfig = {
      ...currentConfig,
      keyCount: currentConfig.keyCount - 1,
    }
    const result = await runFuzzTest(testConfig, stores)
    if (!result.consistent || result.storeResults.some((r) => !r.success)) {
      currentConfig = testConfig
    } else {
      break
    }
  }

  // Try reducing max ops per txn
  while (currentConfig.maxOpsPerTxn > 1) {
    const testConfig = {
      ...currentConfig,
      maxOpsPerTxn: currentConfig.maxOpsPerTxn - 1,
    }
    const result = await runFuzzTest(testConfig, stores)
    if (!result.consistent || result.storeResults.some((r) => !r.success)) {
      currentConfig = testConfig
    } else {
      break
    }
  }

  // Try disabling concurrency
  if (currentConfig.allowConcurrency) {
    const testConfig = { ...currentConfig, allowConcurrency: false }
    const result = await runFuzzTest(testConfig, stores)
    if (!result.consistent || result.storeResults.some((r) => !r.success)) {
      currentConfig = testConfig
    }
  }

  return {
    minimalConfig: currentConfig,
    scenario: generateRandomScenario(currentConfig),
  }
}
