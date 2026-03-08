/**
 * Algebraic Property Tests for Patch Operations
 *
 * Verifies that createPatch and applyPatch satisfy the algebraic properties
 * defined in SPEC.md (I6, I7).
 */

import { describe, expect, it } from "vitest"
import { applyPatch, canApplyPatch, createPatch } from "../../src/utils"
import { SeededRandom } from "../fuzz/random"

describe(`Patch Algebraic Properties`, () => {
  // Sample texts for property testing
  const sampleTexts = [
    ``,
    `a`,
    `hello`,
    `Hello, World!`,
    `The quick brown fox jumps over the lazy dog.`,
    `Line 1\nLine 2\nLine 3`,
    `function foo() {\n  return 42;\n}`,
    `{"key": "value", "number": 123}`,
    `Special chars: <>&"'\`~!@#$%^*()`,
    `Unicode: 你好世界 🎉`,
  ]

  // Generate random text pairs for exhaustive testing
  function generateTextPairs(
    count: number,
    seed: number = 42
  ): Array<[string, string]> {
    const rng = new SeededRandom(seed)
    const pairs: Array<[string, string]> = []

    for (let i = 0; i < count; i++) {
      const text1 = rng.text(0, 100)
      const text2 = rng.text(0, 100)
      pairs.push([text1, text2])
    }

    return pairs
  }

  describe(`I6: Patch Roundtrip Correctness`, () => {
    // applyPatch(a, createPatch(a, b)) = b

    for (const a of sampleTexts) {
      for (const b of sampleTexts) {
        const testName = `apply(create("${a.slice(0, 15)}...", "${b.slice(0, 15)}...")) = b`

        it(testName, () => {
          const patch = createPatch(a, b)
          const result = applyPatch(a, patch)
          expect(result).toBe(b)
        })
      }
    }

    it(`roundtrip property holds for 100 random pairs`, () => {
      const pairs = generateTextPairs(100)

      for (const [a, b] of pairs) {
        const patch = createPatch(a, b)
        const result = applyPatch(a, patch)
        expect(result).toBe(b)
      }
    })
  })

  describe(`I7: Patch Identity`, () => {
    // createPatch(a, a) = ""
    // applyPatch(a, "") = a

    for (const text of sampleTexts) {
      it(`createPatch("${text.slice(0, 20)}...", same) = empty`, () => {
        const patch = createPatch(text, text)
        expect(patch).toBe(``)
      })

      it(`applyPatch("${text.slice(0, 20)}...", empty) = same`, () => {
        const result = applyPatch(text, ``)
        expect(result).toBe(text)
      })
    }
  })

  describe(`Patch Size Efficiency`, () => {
    it(`patch is smaller than full content for small changes`, () => {
      const original = `This is a long string with some content that should not change much.`
      const modified = `This is a long string with SOME content that should not change much.`

      const patch = createPatch(original, modified)

      // Patch should be smaller than the modified content
      expect(patch.length).toBeLessThan(modified.length)
    })

    it(`patch contains only the changed portion`, () => {
      const original = `Hello World`
      const modified = `Hello Universe`

      const patch = createPatch(original, modified)

      expect(patch).toContain(`World`)
      expect(patch).toContain(`Universe`)
      // Should not repeat unchanged content
      expect(patch.split(`Hello`).length).toBeLessThanOrEqual(2)
    })
  })

  describe(`canApplyPatch Validation`, () => {
    it(`returns true for valid patch`, () => {
      const a = `Hello World`
      const b = `Hello Universe`
      const patch = createPatch(a, b)

      expect(canApplyPatch(a, patch)).toBe(true)
    })

    it(`returns false for mismatched context`, () => {
      const patch = createPatch(`Original text`, `Modified text`)

      expect(canApplyPatch(`Completely different`, patch)).toBe(false)
    })

    it(`returns true for empty patch on any content`, () => {
      expect(canApplyPatch(`anything`, ``)).toBe(true)
      expect(canApplyPatch(``, ``)).toBe(true)
    })
  })

  describe(`Edge Cases`, () => {
    it(`handles adding content to empty string`, () => {
      const patch = createPatch(``, `hello`)
      expect(applyPatch(``, patch)).toBe(`hello`)
    })

    it(`handles removing all content`, () => {
      const patch = createPatch(`hello`, ``)
      expect(applyPatch(`hello`, patch)).toBe(``)
    })

    it(`handles inserting at beginning`, () => {
      const patch = createPatch(`world`, `hello world`)
      expect(applyPatch(`world`, patch)).toBe(`hello world`)
    })

    it(`handles inserting at end`, () => {
      const patch = createPatch(`hello`, `hello world`)
      expect(applyPatch(`hello`, patch)).toBe(`hello world`)
    })

    it(`handles multiple disjoint changes`, () => {
      const original = `AAA BBB CCC`
      const modified = `XXX BBB YYY`
      const patch = createPatch(original, modified)
      expect(applyPatch(original, patch)).toBe(modified)
    })

    it(`handles newline-only content`, () => {
      const patch = createPatch(`\n\n\n`, `\n\n`)
      expect(applyPatch(`\n\n\n`, patch)).toBe(`\n\n`)
    })

    it(`handles whitespace changes`, () => {
      const patch = createPatch(`a  b`, `a b`)
      expect(applyPatch(`a  b`, patch)).toBe(`a b`)
    })
  })

  describe(`Composition (derived property)`, () => {
    // While patches don't compose directly, sequential application should work

    it(`sequential patches produce correct result`, () => {
      const v1 = `Original`
      const v2 = `Modified`
      const v3 = `Final`

      const patch1 = createPatch(v1, v2)
      const patch2 = createPatch(v2, v3)

      const afterPatch1 = applyPatch(v1, patch1)
      expect(afterPatch1).toBe(v2)

      const afterPatch2 = applyPatch(afterPatch1, patch2)
      expect(afterPatch2).toBe(v3)
    })
  })
})
