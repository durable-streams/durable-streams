/**
 * Specification Test Vectors
 *
 * These tests are derived directly from SPEC.md and serve as the
 * authoritative conformance tests. If these fail, either the
 * implementation is wrong or the spec needs updating.
 *
 * Each test references its spec section (TV1, TV2, etc.)
 */

import { describe, expect, it } from "vitest"
import {
  BOTTOM,
  assign,
  createMapStore,
  del,
  executeScenario,
  increment,
  scenario,
} from "../src/index"

describe(`Specification Test Vectors`, () => {
  const store = createMapStore

  /**
   * TV1: Basic Read-Write
   *
   * T1 (st=0): update(x, assign(10)), commit(ct=5)
   * T2 (st=6): read(x) → 10
   */
  describe(`TV1: Basic Read-Write`, () => {
    it(`committed writes are visible after commit timestamp`, () => {
      const s = scenario(`TV1: basic read-write`)
        .description(`Committed writes are visible after commit timestamp`)
        .transaction(`t1`, { st: 0 })
        .update(`x`, assign(10))
        .commit({ ct: 5 })
        .transaction(`t2`, { st: 6 })
        .readExpect(`x`, 10)
        .commit({ ct: 10 })
        .build()

      const result = executeScenario(s, store())
      expect(result.success).toBe(true)
    })
  })

  /**
   * TV2: Snapshot Isolation
   *
   * T1 (st=0): update(x, assign(0)), commit(ct=1)
   * T2 (st=5): read(x) → 0, then concurrent T3 commits, T2 still sees 0
   */
  describe(`TV2: Snapshot Isolation`, () => {
    it(`transactions see consistent snapshot despite concurrent commits`, () => {
      // Simplified version: T2 starts after T3's commit but with earlier snapshot
      // This demonstrates that T2's snapshot (st=5) doesn't see T3's commit (ct=6)
      const s = scenario(`TV2: snapshot isolation`)
        .description(
          `Transactions see consistent snapshot despite concurrent commits`
        )
        // T1: Initialize x to 0
        .transaction(`t1`, { st: 0 })
        .update(`x`, assign(0))
        .commit({ ct: 1 })
        // T3: Update x to 1 (commits at ct=6)
        .transaction(`t3`, { st: 5 })
        .update(`x`, assign(1))
        .commit({ ct: 6 })
        // T2: Starts with snapshot=5, which is before T3's commit
        // Should see 0, not 1 (snapshot isolation)
        .transaction(`t2`, { st: 5 })
        .readExpect(`x`, 0) // Still sees 0 despite T3's commit
        .commit({ ct: 10 })
        .build()

      const result = executeScenario(s, store())
      expect(result.success).toBe(true)
    })
  })

  /**
   * TV3: Concurrent Increments (n-way merge)
   *
   * T1 (st=0): update(x, assign(0)), commit(ct=1)
   * T2 (st=2): update(x, increment(10)), commit(ct=10)
   * T3 (st=2): update(x, increment(20)), commit(ct=11)
   * T4 (st=2): update(x, increment(30)), commit(ct=12)
   * T5 (st=15): read(x) → 60   # 0 + 10 + 20 + 30
   */
  describe(`TV3: Concurrent Increments (n-way merge)`, () => {
    it(`concurrent increments merge additively`, () => {
      const s = scenario(`TV3: n-way concurrent increments`)
        .description(`Concurrent increments merge via recursive 2-way merge`)
        // T1: Initialize x to 0
        .transaction(`t1`, { st: 0 })
        .update(`x`, assign(0))
        .commit({ ct: 1 })
        // T2, T3, T4: Concurrent increments from same snapshot
        .transaction(`t2`, { st: 2 })
        .update(`x`, increment(10))
        .commit({ ct: 10 })
        .transaction(`t3`, { st: 2 })
        .update(`x`, increment(20))
        .commit({ ct: 11 })
        .transaction(`t4`, { st: 2 })
        .update(`x`, increment(30))
        .commit({ ct: 12 })
        // T5: Read after all commits
        .transaction(`t5`, { st: 15 })
        .readExpect(`x`, 60) // 0 + 10 + 20 + 30
        .commit({ ct: 20 })
        .build()

      const result = executeScenario(s, store())
      expect(result.success).toBe(true)
    })
  })

  /**
   * TV4: Concurrent Assign (LWW)
   *
   * T1 (st=0): update(x, assign("a")), commit(ct=5)
   * T2 (st=0): update(x, assign("b")), commit(ct=6)
   * T3 (st=10): read(x) → "b"   # Deterministic winner
   */
  describe(`TV4: Concurrent Assign (LWW)`, () => {
    it(`concurrent assigns resolve deterministically`, () => {
      const s = scenario(`TV4: concurrent assign LWW`)
        .description(`Concurrent assigns resolve via deterministic LWW`)
        // T1, T2: Concurrent assigns from same snapshot
        .transaction(`t1`, { st: 0 })
        .update(`x`, assign(`a`))
        .commit({ ct: 5 })
        .transaction(`t2`, { st: 0 })
        .update(`x`, assign(`b`))
        .commit({ ct: 6 })
        // T3: Read after both commits - "b" > "a" in string comparison
        .transaction(`t3`, { st: 10 })
        .readExpect(`x`, `b`)
        .commit({ ct: 15 })
        .build()

      const result = executeScenario(s, store())
      expect(result.success).toBe(true)
    })
  })

  /**
   * TV5: Delete vs Increment
   *
   * T1 (st=0): update(x, assign(50)), commit(ct=1)
   * T2 (st=2): update(x, delete()), commit(ct=10)
   * T3 (st=2): update(x, increment(10)), commit(ct=11)
   * T4 (st=15): read(x) → 60   # 50 + 10, increment wins
   */
  describe(`TV5: Delete vs Increment`, () => {
    it(`increment wins over concurrent delete`, () => {
      const s = scenario(`TV5: delete vs increment`)
        .description(`Increment wins over concurrent delete`)
        // T1: Initialize x to 50
        .transaction(`t1`, { st: 0 })
        .update(`x`, assign(50))
        .commit({ ct: 1 })
        // T2: Delete x
        .transaction(`t2`, { st: 2 })
        .update(`x`, del())
        .commit({ ct: 10 })
        // T3: Increment x (concurrent with delete)
        .transaction(`t3`, { st: 2 })
        .update(`x`, increment(10))
        .commit({ ct: 11 })
        // T4: Read - increment wins, so 50 + 10 = 60
        .transaction(`t4`, { st: 15 })
        .readExpect(`x`, 60)
        .commit({ ct: 20 })
        .build()

      const result = executeScenario(s, store())
      expect(result.success).toBe(true)
    })
  })

  /**
   * TV6: Read Own Writes
   *
   * T1 (st=0):
   *   read(x) → ⊥
   *   update(x, assign(42))
   *   read(x) → 42
   *   update(x, increment(8))
   *   read(x) → 50
   *   commit(ct=10)
   */
  describe(`TV6: Read Own Writes`, () => {
    it(`transaction sees its own uncommitted writes`, () => {
      const s = scenario(`TV6: read own writes`)
        .description(`Transaction sees its own uncommitted writes`)
        .transaction(`t1`, { st: 0 })
        .readExpect(`x`, BOTTOM) // Read uninitialized key
        .update(`x`, assign(42))
        .readExpect(`x`, 42) // See own write
        .update(`x`, increment(8))
        .readExpect(`x`, 50) // See incremented value
        .commit({ ct: 10 })
        .build()

      const result = executeScenario(s, store())
      expect(result.success).toBe(true)
    })
  })

  /**
   * TV7: Aborted Transaction
   *
   * T1 (st=0): update(x, assign(10)), commit(ct=5)
   * T2 (st=6): update(x, assign(99)), abort()
   * T3 (st=10): read(x) → 10   # T2's update not visible
   */
  describe(`TV7: Aborted Transaction`, () => {
    it(`aborted transactions have no visible effect`, () => {
      const s = scenario(`TV7: aborted transaction`)
        .description(`Aborted transactions have no visible effect`)
        // T1: Initialize x to 10
        .transaction(`t1`, { st: 0 })
        .update(`x`, assign(10))
        .commit({ ct: 5 })
        // T2: Try to update x to 99, but abort
        .transaction(`t2`, { st: 6 })
        .update(`x`, assign(99))
        .abort()
        // T3: Should still see 10
        .transaction(`t3`, { st: 10 })
        .readExpect(`x`, 10)
        .commit({ ct: 15 })
        .build()

      const result = executeScenario(s, store())
      expect(result.success).toBe(true)
    })
  })

  /**
   * Additional invariant tests from SPEC.md
   */
  describe(`Invariants`, () => {
    /**
     * I9: Increment on Bottom
     *
     * increment(n) applied to ⊥ returns n (treats ⊥ as 0)
     */
    describe(`I9: Increment on Bottom`, () => {
      it(`increment on uninitialized key returns the delta`, () => {
        const s = scenario(`I9: increment on bottom`)
          .description(
            `Concurrent increments without prior assignment sum correctly`
          )
          // Two concurrent increments with no prior assignment
          .transaction(`t1`, { st: 0 })
          .update(`counter`, increment(5))
          .commit({ ct: 1 })
          .transaction(`t2`, { st: 0 })
          .update(`counter`, increment(3))
          .commit({ ct: 2 })
          // Should sum to 8 (5 + 3), treating initial ⊥ as 0
          .transaction(`t3`, { st: 5 })
          .readExpect(`counter`, 8)
          .commit({ ct: 10 })
          .build()

        const result = executeScenario(s, store())
        expect(result.success).toBe(true)
      })
    })
  })

  /**
   * Semantic Decision tests from SPEC.md
   */
  describe(`Semantic Decisions`, () => {
    /**
     * SD3: Delete Has Lowest Precedence in Merge
     */
    describe(`SD3: Delete Has Lowest Precedence`, () => {
      it(`assign wins over concurrent delete`, () => {
        const s = scenario(`SD3: assign vs delete`)
          .description(`Assign wins over concurrent delete`)
          .transaction(`t1`, { st: 0 })
          .update(`x`, assign(100))
          .commit({ ct: 1 })
          // Concurrent delete and assign
          .transaction(`t2`, { st: 2 })
          .update(`x`, del())
          .commit({ ct: 10 })
          .transaction(`t3`, { st: 2 })
          .update(`x`, assign(200))
          .commit({ ct: 11 })
          // Assign wins
          .transaction(`t4`, { st: 15 })
          .readExpect(`x`, 200)
          .commit({ ct: 20 })
          .build()

        const result = executeScenario(s, store())
        expect(result.success).toBe(true)
      })
    })
  })
})
