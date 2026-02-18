/**
 * Utility Functions Tests
 */

import { describe, expect, it } from "vitest"
import {
  applyPatch,
  basename,
  canApplyPatch,
  createPatch,
  decodeBase64,
  detectContentType,
  detectMimeType,
  dirname,
  encodeBase64,
  joinPath,
  normalizePath,
} from "../src/utils"

describe(`Path utilities`, () => {
  describe(`normalizePath`, () => {
    it(`should add leading slash`, () => {
      expect(normalizePath(`foo/bar`)).toBe(`/foo/bar`)
    })

    it(`should remove trailing slashes`, () => {
      expect(normalizePath(`/foo/bar/`)).toBe(`/foo/bar`)
      expect(normalizePath(`/foo/bar///`)).toBe(`/foo/bar`)
    })

    it(`should keep root as single slash`, () => {
      expect(normalizePath(`/`)).toBe(`/`)
      expect(normalizePath(``)).toBe(`/`)
    })

    it(`should remove . components`, () => {
      expect(normalizePath(`/foo/./bar`)).toBe(`/foo/bar`)
      expect(normalizePath(`./foo`)).toBe(`/foo`)
    })

    it(`should handle .. components`, () => {
      expect(normalizePath(`/foo/bar/../baz`)).toBe(`/foo/baz`)
      expect(normalizePath(`/foo/../bar`)).toBe(`/bar`)
    })

    it(`should remove double slashes`, () => {
      expect(normalizePath(`/foo//bar`)).toBe(`/foo/bar`)
    })
  })

  describe(`dirname`, () => {
    it(`should return parent directory`, () => {
      expect(dirname(`/foo/bar`)).toBe(`/foo`)
      expect(dirname(`/foo/bar/baz`)).toBe(`/foo/bar`)
    })

    it(`should return root for top-level paths`, () => {
      expect(dirname(`/foo`)).toBe(`/`)
    })

    it(`should return root for root`, () => {
      expect(dirname(`/`)).toBe(`/`)
    })
  })

  describe(`basename`, () => {
    it(`should return filename`, () => {
      expect(basename(`/foo/bar.txt`)).toBe(`bar.txt`)
      expect(basename(`/foo/bar/baz`)).toBe(`baz`)
    })

    it(`should return empty for root`, () => {
      expect(basename(`/`)).toBe(``)
    })
  })

  describe(`joinPath`, () => {
    it(`should join path segments`, () => {
      expect(joinPath(`/foo`, `bar`, `baz`)).toBe(`/foo/bar/baz`)
    })

    it(`should normalize result`, () => {
      expect(joinPath(`foo`, `bar`)).toBe(`/foo/bar`)
      expect(joinPath(`/foo/`, `/bar/`)).toBe(`/foo/bar`)
    })
  })
})

describe(`MIME type detection`, () => {
  describe(`detectMimeType`, () => {
    it(`should detect text files`, () => {
      expect(detectMimeType(`/file.txt`)).toBe(`text/plain`)
      expect(detectMimeType(`/doc.md`)).toBe(`text/markdown`)
      expect(detectMimeType(`/page.html`)).toBe(`text/html`)
      expect(detectMimeType(`/styles.css`)).toBe(`text/css`)
    })

    it(`should detect code files`, () => {
      expect(detectMimeType(`/app.js`)).toBe(`text/javascript`)
      expect(detectMimeType(`/app.ts`)).toBe(`text/typescript`)
      expect(detectMimeType(`/data.json`)).toBe(`application/json`)
      expect(detectMimeType(`/script.py`)).toBe(`text/x-python`)
    })

    it(`should detect image files`, () => {
      expect(detectMimeType(`/image.png`)).toBe(`image/png`)
      expect(detectMimeType(`/photo.jpg`)).toBe(`image/jpeg`)
      expect(detectMimeType(`/icon.svg`)).toBe(`image/svg+xml`)
    })

    it(`should return octet-stream for unknown`, () => {
      expect(detectMimeType(`/file.xyz`)).toBe(`application/octet-stream`)
      expect(detectMimeType(`/noext`)).toBe(`application/octet-stream`)
    })
  })

  describe(`detectContentType`, () => {
    it(`should detect text content types`, () => {
      expect(detectContentType(`text/plain`)).toBe(`text`)
      expect(detectContentType(`text/markdown`)).toBe(`text`)
      expect(detectContentType(`application/json`)).toBe(`text`)
      expect(detectContentType(`application/xml`)).toBe(`text`)
    })

    it(`should detect binary content types`, () => {
      expect(detectContentType(`image/png`)).toBe(`binary`)
      expect(detectContentType(`application/octet-stream`)).toBe(`binary`)
      expect(detectContentType(`application/pdf`)).toBe(`binary`)
    })
  })
})

describe(`Diff-match-patch utilities`, () => {
  describe(`createPatch`, () => {
    it(`should create a patch for changes`, () => {
      const patch = createPatch(`Hello, World!`, `Hello, Universe!`)
      expect(patch).toContain(`@@`)
      expect(patch).toContain(`World`)
      expect(patch).toContain(`Universe`)
    })

    it(`should create empty patch for identical content`, () => {
      const patch = createPatch(`same`, `same`)
      expect(patch).toBe(``)
    })
  })

  describe(`applyPatch`, () => {
    it(`should apply a patch successfully`, () => {
      const original = `Hello, World!`
      const modified = `Hello, Universe!`
      const patch = createPatch(original, modified)

      const result = applyPatch(original, patch)
      expect(result).toBe(modified)
    })

    it(`should handle multi-line patches`, () => {
      const original = `Line 1\nLine 2\nLine 3`
      const modified = `Line 1\nModified Line 2\nLine 3`
      const patch = createPatch(original, modified)

      const result = applyPatch(original, patch)
      expect(result).toBe(modified)
    })
  })

  describe(`canApplyPatch`, () => {
    it(`should return true for valid patch`, () => {
      const original = `Hello`
      const modified = `Hello World`
      const patch = createPatch(original, modified)

      expect(canApplyPatch(original, patch)).toBe(true)
    })

    it(`should return false for invalid context`, () => {
      const patch = createPatch(`Original text`, `Modified text`)

      expect(canApplyPatch(`Completely different`, patch)).toBe(false)
    })
  })
})

describe(`Base64 encoding`, () => {
  describe(`encodeBase64`, () => {
    it(`should encode binary data`, () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
      const encoded = encodeBase64(data)
      expect(encoded).toBe(`SGVsbG8=`)
    })
  })

  describe(`decodeBase64`, () => {
    it(`should decode base64 string`, () => {
      const decoded = decodeBase64(`SGVsbG8=`)
      expect(Array.from(decoded)).toEqual([72, 101, 108, 108, 111])
    })
  })

  it(`should round-trip binary data`, () => {
    const original = new Uint8Array([0, 127, 255, 128, 64])
    const encoded = encodeBase64(original)
    const decoded = decodeBase64(encoded)
    expect(Array.from(decoded)).toEqual(Array.from(original))
  })
})
