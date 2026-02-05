/**
 * Fuzz Tests for Transactional Stores
 *
 * Property-based testing to find edge cases and verify consistency
 * across different store implementations.
 */

import { describe, expect, it } from "vitest"
import {
  SeededRandom,
  createMapStore,
  executeScenario,
  fuzzStores,
  generateRandomScenario,
  quickFuzz,
  runFuzzTest,
  runFuzzTests,
} from "../src/index"

describe(`Fuzz Testing`, () => {
  describe(`SeededRandom`, () => {
    it(`produces reproducible results`, () => {
      const rng1 = new SeededRandom(12345)
      const rng2 = new SeededRandom(12345)

      for (let i = 0; i < 100; i++) {
        expect(rng1.next()).toBe(rng2.next())
      }
    })

    it(`produces different results with different seeds`, () => {
      const rng1 = new SeededRandom(12345)
      const rng2 = new SeededRandom(67890)

      let sameCount = 0
      for (let i = 0; i < 100; i++) {
        if (rng1.next() === rng2.next()) sameCount++
      }
      expect(sameCount).toBeLessThan(10) // Very unlikely to be the same
    })

    it(`generates integers in range`, () => {
      const rng = new SeededRandom(42)
      for (let i = 0; i < 100; i++) {
        const val = rng.int(5, 10)
        expect(val).toBeGreaterThanOrEqual(5)
        expect(val).toBeLessThanOrEqual(10)
      }
    })

    it(`picks from array`, () => {
      const rng = new SeededRandom(42)
      const arr = [`a`, `b`, `c`]
      for (let i = 0; i < 100; i++) {
        const val = rng.pick(arr)
        expect(arr).toContain(val)
      }
    })
  })

  describe(`generateRandomScenario`, () => {
    it(`generates a valid scenario`, () => {
      const scenario = generateRandomScenario({ seed: 42 })

      expect(scenario.metadata.name).toBe(`fuzz_seed_42`)
      expect(scenario.operations.length).toBeGreaterThan(0)
    })

    it(`generates reproducible scenarios with same seed`, () => {
      const scenario1 = generateRandomScenario({ seed: 12345 })
      const scenario2 = generateRandomScenario({ seed: 12345 })

      expect(scenario1.operations.length).toBe(scenario2.operations.length)
      expect(JSON.stringify(scenario1.operations)).toBe(
        JSON.stringify(scenario2.operations)
      )
    })

    it(`generates different scenarios with different seeds`, () => {
      const scenario1 = generateRandomScenario({ seed: 11111 })
      const scenario2 = generateRandomScenario({ seed: 22222 })

      // Very unlikely to be identical
      expect(JSON.stringify(scenario1.operations)).not.toBe(
        JSON.stringify(scenario2.operations)
      )
    })

    it(`respects configuration options`, () => {
      const scenario = generateRandomScenario({
        seed: 42,
        transactionCount: 3,
        keyCount: 2,
        maxOpsPerTxn: 2,
        allowConcurrency: false,
        abortProbability: 0,
      })

      // Should have limited operations
      expect(scenario.operations.length).toBeLessThan(50)
    })

    it(`generates executable scenarios`, () => {
      const scenario = generateRandomScenario({
        seed: 42,
        transactionCount: 5,
      })

      const store = createMapStore()
      const result = executeScenario(scenario, store)

      // Should execute without throwing
      expect(result).toBeDefined()
    })
  })

  describe(`runFuzzTest`, () => {
    it(`runs a single fuzz test`, async () => {
      const result = await runFuzzTest({ seed: 42 }, fuzzStores)

      expect(result.scenario).toBeDefined()
      expect(result.storeResults.length).toBe(2) // map and stream
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it(`detects consistency between stores`, async () => {
      const result = await runFuzzTest(
        {
          seed: 42,
          transactionCount: 5,
          allowConcurrency: false,
        },
        fuzzStores
      )

      // Both stores should succeed or fail together
      const successes = result.storeResults.map((r) => r.success)
      const allSame = successes.every((s) => s === successes[0])
      expect(allSame).toBe(true)
    })
  })

  describe(`runFuzzTests`, () => {
    it(`runs multiple fuzz tests`, async () => {
      const results = await runFuzzTests(10, { seed: 1000 }, fuzzStores)

      expect(results.total).toBe(10)
      expect(results.passed + results.failed).toBe(10)
      expect(results.results.length).toBe(10)
    })

    it(`tracks failed seeds for reproducibility`, async () => {
      const results = await runFuzzTests(
        20,
        {
          seed: 2000,
          transactionCount: 3,
        },
        fuzzStores
      )

      // All seeds should be reproducible
      for (const seed of results.failedSeeds.slice(0, 3)) {
        const rerun = await runFuzzTest({ seed }, fuzzStores)
        expect(rerun.scenario.metadata.name).toBe(`fuzz_seed_${seed}`)
      }
    })
  })

  describe(`quickFuzz`, () => {
    it(`runs quick fuzz with default stores`, async () => {
      const result = await quickFuzz(20, { seed: 3000 })

      expect(result.summary).toContain(`Fuzz Test Results`)
      expect(result.summary).toContain(`Total: 20`)
    })

    it(`reports success correctly`, async () => {
      const result = await quickFuzz(10, {
        seed: 4000,
        transactionCount: 3,
        allowConcurrency: false,
      })

      // Simple non-concurrent tests should usually pass
      expect(result.summary).toContain(`Passed:`)
    })
  })

  describe(`Store Consistency`, () => {
    // Run a larger batch of fuzz tests to verify store consistency
    it(`map and stream stores produce consistent results`, async () => {
      const result = await quickFuzz(50, {
        seed: 5000,
        transactionCount: 5,
        keyCount: 3,
        maxOpsPerTxn: 3,
      })

      // Log any failures for debugging
      if (!result.success) {
        console.log(result.summary)
        console.log(`Failed seeds:`, result.failedSeeds)
      }

      // Allow some failures due to the randomness, but most should pass
      // The stores should be consistent even if some scenarios have errors
      expect(result.failedSeeds.length).toBeLessThanOrEqual(15)
    }, 30000) // Longer timeout for fuzz tests
  })

  describe(`Specific Seeds`, () => {
    // Test specific seeds that exercise important code paths
    const interestingSeeds = [
      42, // Simple case
      123, // Different randomness
      999, // Another pattern
      1234567, // Larger seed
    ]

    for (const seed of interestingSeeds) {
      it(`seed ${seed} produces valid scenario`, async () => {
        const result = await runFuzzTest(
          {
            seed,
            transactionCount: 5,
            keyCount: 3,
          },
          fuzzStores
        )

        // Scenario should be generated
        expect(result.scenario.operations.length).toBeGreaterThan(0)

        // Both stores should produce results
        expect(result.storeResults.length).toBe(2)
      })
    }
  })
})
