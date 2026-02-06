/**
 * Algebraic Property Tests for Path Operations
 *
 * Verifies that path normalization satisfies the algebraic properties
 * defined in SPEC.md (I1, I2).
 */

import { describe, expect, it } from "vitest"
import { basename, dirname, joinPath, normalizePath } from "../../src/utils"
import {
  checkCanonicalPathForm,
  checkPathNormalizationIdempotence,
} from "../invariants"

describe(`Path Algebraic Properties`, () => {
  // Sample paths for property testing
  const samplePaths = [
    `/`,
    ``,
    `foo`,
    `/foo`,
    `/foo/bar`,
    `foo/bar`,
    `/foo/bar/`,
    `/foo//bar`,
    `/foo/./bar`,
    `/foo/../bar`,
    `./foo`,
    `../foo`,
    `/foo/bar/../baz`,
    `///`,
    `/./`,
    `/../`,
    `/a/b/c/d/e`,
    `relative/path/here`,
    `/with spaces/and stuff`,
  ]

  describe(`I1: Path Normalization Idempotence`, () => {
    // normalize(normalize(path)) = normalize(path)

    it.each(samplePaths)(`idempotent: normalize(normalize("%s"))`, (path) => {
      const once = normalizePath(path)
      const twice = normalizePath(once)
      expect(twice).toBe(once)
    })

    it(`passes invariant checker for all sample paths`, () => {
      const result = checkPathNormalizationIdempotence(samplePaths)
      expect(result.passed).toBe(true)
    })
  })

  describe(`I2: Canonical Path Form`, () => {
    // All normalized paths start with "/"
    // Non-root paths don't end with "/"

    it.each(samplePaths)(
      `canonical form: normalize("%s") starts with "/"`,
      (path) => {
        const normalized = normalizePath(path)
        expect(normalized.startsWith(`/`)).toBe(true)
      }
    )

    it.each(samplePaths.filter((p) => p !== `/`))(
      `canonical form: normalize("%s") does not end with "/" (if not root)`,
      (path) => {
        const normalized = normalizePath(path)
        if (normalized !== `/`) {
          expect(normalized.endsWith(`/`)).toBe(false)
        }
      }
    )

    it(`passes invariant checker for all sample paths`, () => {
      const result = checkCanonicalPathForm(samplePaths)
      expect(result.passed).toBe(true)
    })
  })

  describe(`dirname Properties`, () => {
    it(`dirname of root is root`, () => {
      expect(dirname(`/`)).toBe(`/`)
    })

    it(`dirname of top-level path is root`, () => {
      expect(dirname(`/foo`)).toBe(`/`)
      expect(dirname(`/bar`)).toBe(`/`)
    })

    it(`dirname is prefix of path`, () => {
      const paths = [`/a/b`, `/a/b/c`, `/x/y/z/w`]
      for (const path of paths) {
        const dir = dirname(path)
        expect(path.startsWith(dir)).toBe(true)
      }
    })

    it(`dirname + "/" + basename reconstructs path (for non-root)`, () => {
      const paths = [`/a/b`, `/foo/bar/baz`, `/x`]
      for (const path of paths) {
        const dir = dirname(path)
        const base = basename(path)
        const reconstructed = dir === `/` ? `/${base}` : `${dir}/${base}`
        expect(reconstructed).toBe(path)
      }
    })
  })

  describe(`basename Properties`, () => {
    it(`basename of root is empty`, () => {
      expect(basename(`/`)).toBe(``)
    })

    it(`basename contains no slashes`, () => {
      const paths = [`/a`, `/a/b`, `/a/b/c`, `/foo/bar.txt`]
      for (const path of paths) {
        const base = basename(path)
        expect(base.includes(`/`)).toBe(false)
      }
    })

    it(`basename is suffix of path`, () => {
      const paths = [`/a/b`, `/a/b/c`, `/x/y/z.txt`]
      for (const path of paths) {
        const base = basename(path)
        expect(path.endsWith(base)).toBe(true)
      }
    })
  })

  describe(`joinPath Properties`, () => {
    it(`joining with root produces normalized child`, () => {
      expect(joinPath(`/`, `foo`)).toBe(`/foo`)
      expect(joinPath(`/`, `foo`, `bar`)).toBe(`/foo/bar`)
    })

    it(`result is always normalized`, () => {
      const cases = [
        [`/foo`, `bar`],
        [`foo`, `bar`],
        [`/foo/`, `/bar/`],
        [`/a`, `b`, `c`],
      ]

      for (const parts of cases) {
        const joined = joinPath(...parts)
        expect(joined).toBe(normalizePath(joined))
      }
    })

    it(`single argument returns normalized path`, () => {
      expect(joinPath(`foo`)).toBe(`/foo`)
      expect(joinPath(`/foo`)).toBe(`/foo`)
    })

    it(`empty parts are skipped`, () => {
      expect(joinPath(`/foo`, ``, `bar`)).toBe(`/foo/bar`)
    })
  })

  describe(`Path Resolution Edge Cases`, () => {
    it(`handles . correctly`, () => {
      expect(normalizePath(`/foo/./bar`)).toBe(`/foo/bar`)
      expect(normalizePath(`./foo`)).toBe(`/foo`)
      expect(normalizePath(`/./`)).toBe(`/`)
    })

    it(`handles .. correctly`, () => {
      expect(normalizePath(`/foo/bar/../baz`)).toBe(`/foo/baz`)
      expect(normalizePath(`/foo/../bar`)).toBe(`/bar`)
      expect(normalizePath(`/foo/bar/../../baz`)).toBe(`/baz`)
    })

    it(`.. at root stays at root`, () => {
      expect(normalizePath(`/../foo`)).toBe(`/foo`)
      expect(normalizePath(`/../../foo`)).toBe(`/foo`)
    })

    it(`handles multiple slashes`, () => {
      expect(normalizePath(`//foo//bar//`)).toBe(`/foo/bar`)
      expect(normalizePath(`///`)).toBe(`/`)
    })

    it(`handles empty input`, () => {
      expect(normalizePath(``)).toBe(`/`)
    })
  })

  describe(`Path Comparison`, () => {
    it(`different representations normalize to same path`, () => {
      const equivalentPaths = [
        [`/foo/bar`, `/foo//bar`, `/foo/./bar`, `/foo/baz/../bar`],
        [`/a/b/c`, `/a/./b/./c`, `/a/b/c/`],
        [`/`, `/./`, `/../`, `//`],
      ]

      for (const group of equivalentPaths) {
        const normalized = group.map(normalizePath)
        const first = normalized[0]
        for (const path of normalized) {
          expect(path).toBe(first)
        }
      }
    })
  })
})
