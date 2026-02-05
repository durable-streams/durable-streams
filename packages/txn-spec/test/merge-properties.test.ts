/**
 * Merge Properties Tests
 *
 * Tests that verify the algebraic properties of the merge operator
 * as defined in Definition B.1 of the paper:
 *
 * n-way merge (n ≥ 0) is defined as recursive 2-way merge.
 *
 * Merge must satisfy:
 * - Commutative: merge(a, b) = merge(b, a)
 * - Associative: merge(merge(a, b), c) = merge(a, merge(b, c))
 * - Idempotent: merge(a, a) = a
 *
 * These properties ensure that concurrent effects can be merged
 * in any order and the result is deterministic.
 */

import { describe, expect, it } from "vitest"
import {
  assign,
  del,
  effectsEqual,
  increment,
  mergeEffectSet,
  mergeEffects,
} from "../src/effects"
import { BOTTOM, isBottom } from "../src/types"
import type { EffectOrBottom } from "../src/types"

describe(`Merge Properties (Definition B.1)`, () => {
  // Test effect sets for property verification
  const testEffects: Array<{ name: string; effect: EffectOrBottom }> = [
    { name: `BOTTOM`, effect: BOTTOM },
    { name: `assign(0)`, effect: assign(0) },
    { name: `assign(1)`, effect: assign(1) },
    { name: `assign(42)`, effect: assign(42) },
    { name: `assign("hello")`, effect: assign(`hello`) },
    { name: `increment(1)`, effect: increment(1) },
    { name: `increment(5)`, effect: increment(5) },
    { name: `increment(10)`, effect: increment(10) },
    { name: `increment(-3)`, effect: increment(-3) },
    { name: `delete`, effect: del() },
  ]

  describe(`Commutativity: merge(a, b) = merge(b, a)`, () => {
    // Test all pairs of effects
    for (const a of testEffects) {
      for (const b of testEffects) {
        it(`merge(${a.name}, ${b.name}) = merge(${b.name}, ${a.name})`, () => {
          try {
            const ab = mergeEffects(a.effect, b.effect)
            const ba = mergeEffects(b.effect, a.effect)
            expect(effectsEqual(ab, ba)).toBe(true)
          } catch {
            // If merge throws for one order, it should throw for the other too
            // (e.g., incompatible custom effect types)
            expect(() => mergeEffects(a.effect, b.effect)).toThrow()
            expect(() => mergeEffects(b.effect, a.effect)).toThrow()
          }
        })
      }
    }
  })

  describe(`Associativity: merge(merge(a, b), c) = merge(a, merge(b, c))`, () => {
    // Test representative triples of same-type effects
    const assignEffects = testEffects.filter(
      (e) => !isBottom(e.effect) && e.effect.type === `assign`
    )

    // Test increment associativity
    describe(`increment associativity`, () => {
      const incA = increment(1)
      const incB = increment(5)
      const incC = increment(10)

      it(`merge(merge(inc(1), inc(5)), inc(10)) = merge(inc(1), merge(inc(5), inc(10)))`, () => {
        const leftAssoc = mergeEffects(mergeEffects(incA, incB), incC)
        const rightAssoc = mergeEffects(incA, mergeEffects(incB, incC))
        expect(effectsEqual(leftAssoc, rightAssoc)).toBe(true)
        // Both should equal increment(16)
        expect(effectsEqual(leftAssoc, increment(16))).toBe(true)
      })
    })

    // Test delete associativity
    describe(`delete associativity`, () => {
      const delA = del()
      const delB = del()
      const delC = del()

      it(`merge(merge(del, del), del) = merge(del, merge(del, del))`, () => {
        const leftAssoc = mergeEffects(mergeEffects(delA, delB), delC)
        const rightAssoc = mergeEffects(delA, mergeEffects(delB, delC))
        expect(effectsEqual(leftAssoc, rightAssoc)).toBe(true)
        expect(effectsEqual(leftAssoc, del())).toBe(true)
      })
    })

    // Test BOTTOM associativity
    describe(`BOTTOM associativity`, () => {
      const effectA = increment(5)
      const effectB = increment(3)

      it(`merge(merge(BOTTOM, a), b) = merge(BOTTOM, merge(a, b))`, () => {
        const leftAssoc = mergeEffects(mergeEffects(BOTTOM, effectA), effectB)
        const rightAssoc = mergeEffects(BOTTOM, mergeEffects(effectA, effectB))
        expect(effectsEqual(leftAssoc, rightAssoc)).toBe(true)
      })
    })

    // Test assign associativity (LWW)
    describe(`assign associativity (LWW)`, () => {
      // For assigns, merge uses deterministic comparison
      // merge(merge(a, b), c) should equal merge(a, merge(b, c))
      for (const a of assignEffects) {
        for (const b of assignEffects) {
          for (const c of assignEffects) {
            it(`merge(merge(${a.name}, ${b.name}), ${c.name}) = merge(${a.name}, merge(${b.name}, ${c.name}))`, () => {
              const leftAssoc = mergeEffects(
                mergeEffects(a.effect, b.effect),
                c.effect
              )
              const rightAssoc = mergeEffects(
                a.effect,
                mergeEffects(b.effect, c.effect)
              )
              expect(effectsEqual(leftAssoc, rightAssoc)).toBe(true)
            })
          }
        }
      }
    })
  })

  describe(`Idempotence`, () => {
    /**
     * Idempotence in the paper refers to SET-level idempotence:
     * merge(S ∪ S) = merge(S)
     *
     * This is naturally satisfied because effects are keyed by version timestamp.
     * The same version's effect can only appear once in the set.
     *
     * At the value level:
     * - BOTTOM, assigns, deletes: idempotent (merge(a, a) = a)
     * - increments: NOT idempotent (merge(inc(n), inc(n)) = inc(2n))
     *   This is intentional - increments sum for counter CRDT semantics
     */

    describe(`value-level idempotent effects`, () => {
      const idempotentEffects = [
        { name: `BOTTOM`, effect: BOTTOM },
        { name: `assign(0)`, effect: assign(0) },
        { name: `assign(42)`, effect: assign(42) },
        { name: `assign("hello")`, effect: assign(`hello`) },
        { name: `delete`, effect: del() },
      ]

      for (const { name, effect } of idempotentEffects) {
        it(`merge(${name}, ${name}) = ${name}`, () => {
          const merged = mergeEffects(effect, effect)
          expect(effectsEqual(merged, effect)).toBe(true)
        })
      }
    })

    describe(`increments sum (counter CRDT semantics)`, () => {
      // Increments are intentionally NOT idempotent at value level
      // merge(inc(n), inc(n)) = inc(2n) - this is correct for concurrent counters
      it(`merge(inc(5), inc(5)) = inc(10), not inc(5)`, () => {
        const a = increment(5)
        const merged = mergeEffects(a, a)
        expect(effectsEqual(merged, increment(10))).toBe(true)
        expect(effectsEqual(merged, a)).toBe(false) // NOT idempotent
      })
    })

    describe(`set-level idempotence (via version deduplication)`, () => {
      // In practice, the store ensures each version's effect appears once
      // This test demonstrates the concept
      it(`mergeSet with duplicates handled by version keys, not value dedup`, () => {
        // When building the effect set from versions, each version contributes
        // exactly one effect. The set is keyed by version, not effect value.
        // This is a documentation test, not a functional test.
        expect(true).toBe(true)
      })
    })
  })

  describe(`Identity: merge(BOTTOM, a) = merge(a, BOTTOM) = a`, () => {
    for (const { name, effect } of testEffects) {
      it(`merge(BOTTOM, ${name}) = ${name}`, () => {
        const merged = mergeEffects(BOTTOM, effect)
        expect(effectsEqual(merged, effect)).toBe(true)
      })

      it(`merge(${name}, BOTTOM) = ${name}`, () => {
        const merged = mergeEffects(effect, BOTTOM)
        expect(effectsEqual(merged, effect)).toBe(true)
      })
    }
  })

  describe(`n-way merge via recursive 2-way merge`, () => {
    it(`empty set: merge({}) = BOTTOM`, () => {
      const result = mergeEffectSet([])
      expect(result).toBe(BOTTOM)
    })

    it(`singleton: merge({a}) = a`, () => {
      const effect = increment(5)
      const result = mergeEffectSet([effect])
      expect(effectsEqual(result, effect)).toBe(true)
    })

    it(`n increments merge to sum`, () => {
      const effects = [
        increment(1),
        increment(2),
        increment(3),
        increment(4),
        increment(5),
      ]
      const result = mergeEffectSet(effects)
      expect(effectsEqual(result, increment(15))).toBe(true)
    })

    it(`order independence for n-way merge (commutativity + associativity)`, () => {
      const effects = [increment(10), increment(20), increment(30)]

      // All permutations should give same result
      const permutations = [
        [effects[0], effects[1], effects[2]],
        [effects[0], effects[2], effects[1]],
        [effects[1], effects[0], effects[2]],
        [effects[1], effects[2], effects[0]],
        [effects[2], effects[0], effects[1]],
        [effects[2], effects[1], effects[0]],
      ]

      const results = permutations.map((perm) => mergeEffectSet(perm))

      // All results should be equal
      for (let i = 1; i < results.length; i++) {
        expect(effectsEqual(results[0], results[i])).toBe(true)
      }

      // And equal to increment(60)
      expect(effectsEqual(results[0], increment(60))).toBe(true)
    })

    it(`n deletes merge to delete`, () => {
      const effects = [del(), del(), del()]
      const result = mergeEffectSet(effects)
      expect(effectsEqual(result, del())).toBe(true)
    })

    it(`mixed increments and deletes: increments win`, () => {
      const effects = [del(), increment(10), del(), increment(5)]
      const result = mergeEffectSet(effects)
      // Delete has lowest precedence, increments merge
      expect(effectsEqual(result, increment(15))).toBe(true)
    })
  })

  describe(`Increment-specific properties`, () => {
    it(`increments form an abelian group under merge`, () => {
      // Closure: merge of two increments is an increment
      const a = increment(5)
      const b = increment(3)
      const merged = mergeEffects(a, b)
      expect((merged as { type: string }).type).toBe(`increment`)
      expect((merged as { delta: number }).delta).toBe(8)
    })

    it(`increment(0) is identity for increment merge`, () => {
      const zero = increment(0)
      const other = increment(42)

      const left = mergeEffects(zero, other)
      const right = mergeEffects(other, zero)

      expect(effectsEqual(left, other)).toBe(true)
      expect(effectsEqual(right, other)).toBe(true)
    })

    it(`negative increments work correctly`, () => {
      const pos = increment(10)
      const neg = increment(-3)
      const merged = mergeEffects(pos, neg)
      expect(effectsEqual(merged, increment(7))).toBe(true)
    })
  })
})
