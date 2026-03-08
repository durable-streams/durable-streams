/**
 * Exhaustive Small-Scope Tests
 *
 * Systematically tests all combinations within a bounded state space.
 * Based on Alloy's "small scope hypothesis" - most bugs manifest in small examples.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { StreamFilesystem } from "../src/filesystem"
import { checkLiveFilesystem } from "./invariants"

describe(`Exhaustive Small-Scope Tests`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string
  let fs: StreamFilesystem

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url

    fs = new StreamFilesystem({
      baseUrl,
      streamPrefix: `/fs/exhaustive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    await fs.initialize()
  })

  afterEach(async () => {
    fs.close()
    await server.stop()
  })

  // Helper to safely execute an operation (catching expected errors)
  async function safeOp(op: () => Promise<void>): Promise<boolean> {
    try {
      await op()
      return true
    } catch {
      return false
    }
  }

  describe(`All Single Operations`, () => {
    const paths = [`/a`, `/b`, `/a/b`] as const
    const contents = [`x`, `y`, ``] as const

    describe(`createFile exhaustive`, () => {
      for (const path of paths) {
        for (const content of contents) {
          it(`createFile("${path}", "${content}")`, async () => {
            // Setup: create parent if needed
            if (path === `/a/b`) {
              await fs.mkdir(`/a`)
            }

            await safeOp(() => fs.createFile(path, content))
            const result = await checkLiveFilesystem(fs)
            expect(result.passed).toBe(true)
          })
        }
      }
    })

    describe(`mkdir exhaustive`, () => {
      for (const path of paths) {
        it(`mkdir("${path}")`, async () => {
          // Setup: create parent if needed
          if (path === `/a/b`) {
            await fs.mkdir(`/a`)
          }

          await safeOp(() => fs.mkdir(path))
          const result = await checkLiveFilesystem(fs)
          expect(result.passed).toBe(true)
        })
      }
    })
  })

  describe(`Two-Operation Sequences`, () => {
    type Op = `createFile` | `writeFile` | `deleteFile` | `mkdir` | `rmdir`

    // Pairs that are interesting to test
    const interestingPairs: Array<[Op, Op]> = [
      [`createFile`, `writeFile`],
      [`createFile`, `deleteFile`],
      [`createFile`, `createFile`],
      [`mkdir`, `createFile`],
      [`mkdir`, `mkdir`],
      [`mkdir`, `rmdir`],
      [`createFile`, `rmdir`],
      [`deleteFile`, `createFile`],
    ]

    for (const [op1, op2] of interestingPairs) {
      it(`${op1} then ${op2}`, async () => {
        // Execute first operation
        switch (op1) {
          case `createFile`:
            await safeOp(() => fs.createFile(`/test.txt`, `content`))
            break
          case `writeFile`:
            await safeOp(() => fs.createFile(`/test.txt`, `old`))
            await safeOp(() => fs.writeFile(`/test.txt`, `new`))
            break
          case `deleteFile`:
            await safeOp(() => fs.createFile(`/test.txt`, `content`))
            await safeOp(() => fs.deleteFile(`/test.txt`))
            break
          case `mkdir`:
            await safeOp(() => fs.mkdir(`/testdir`))
            break
          case `rmdir`:
            await safeOp(() => fs.mkdir(`/testdir`))
            await safeOp(() => fs.rmdir(`/testdir`))
            break
        }

        // Execute second operation
        switch (op2) {
          case `createFile`:
            await safeOp(() => fs.createFile(`/test2.txt`, `content2`))
            break
          case `writeFile`:
            if (fs.exists(`/test.txt`)) {
              await safeOp(() => fs.writeFile(`/test.txt`, `updated`))
            }
            break
          case `deleteFile`:
            if (fs.exists(`/test.txt`)) {
              await safeOp(() => fs.deleteFile(`/test.txt`))
            }
            break
          case `mkdir`:
            await safeOp(() => fs.mkdir(`/testdir2`))
            break
          case `rmdir`:
            if (fs.exists(`/testdir`)) {
              await safeOp(() => fs.rmdir(`/testdir`))
            }
            break
        }

        // Verify invariants hold
        const result = await checkLiveFilesystem(fs)
        expect(result.passed).toBe(true)
      })
    }
  })

  describe(`File Lifecycle Exhaustive`, () => {
    // Test all possible file state transitions: nonexistent -> exists -> deleted

    it(`nonexistent -> exists (create)`, async () => {
      await fs.createFile(`/file.txt`, `content`)
      expect(fs.exists(`/file.txt`)).toBe(true)
    })

    it(`exists -> exists (write)`, async () => {
      await fs.createFile(`/file.txt`, `v1`)
      await fs.writeFile(`/file.txt`, `v2`)
      expect(fs.exists(`/file.txt`)).toBe(true)
      expect(await fs.readTextFile(`/file.txt`)).toBe(`v2`)
    })

    it(`exists -> deleted (delete)`, async () => {
      await fs.createFile(`/file.txt`, `content`)
      await fs.deleteFile(`/file.txt`)
      expect(fs.exists(`/file.txt`)).toBe(false)
    })

    it(`deleted -> exists (recreate)`, async () => {
      await fs.createFile(`/file.txt`, `v1`)
      await fs.deleteFile(`/file.txt`)
      await fs.createFile(`/file.txt`, `v2`)
      expect(fs.exists(`/file.txt`)).toBe(true)
      expect(await fs.readTextFile(`/file.txt`)).toBe(`v2`)
    })

    it(`nonexistent -> deleted (noop - error)`, async () => {
      await expect(fs.deleteFile(`/file.txt`)).rejects.toThrow()
    })
  })

  describe(`Directory Lifecycle Exhaustive`, () => {
    it(`nonexistent -> exists (mkdir)`, async () => {
      await fs.mkdir(`/dir`)
      expect(fs.isDirectory(`/dir`)).toBe(true)
    })

    it(`exists -> deleted (rmdir empty)`, async () => {
      await fs.mkdir(`/dir`)
      await fs.rmdir(`/dir`)
      expect(fs.exists(`/dir`)).toBe(false)
    })

    it(`exists with content -> rmdir fails`, async () => {
      await fs.mkdir(`/dir`)
      await fs.createFile(`/dir/file.txt`, `content`)
      await expect(fs.rmdir(`/dir`)).rejects.toThrow()
    })

    it(`deleted -> exists (recreate)`, async () => {
      await fs.mkdir(`/dir`)
      await fs.rmdir(`/dir`)
      await fs.mkdir(`/dir`)
      expect(fs.isDirectory(`/dir`)).toBe(true)
    })
  })

  describe(`Boundary Conditions`, () => {
    it(`max depth directory creation`, async () => {
      const maxDepth = 5
      let path = ``
      for (let i = 1; i <= maxDepth; i++) {
        path += `/d${i}`
        await fs.mkdir(path)
      }

      // All directories should exist
      let checkPath = ``
      for (let i = 1; i <= maxDepth; i++) {
        checkPath += `/d${i}`
        expect(fs.isDirectory(checkPath)).toBe(true)
      }

      const result = await checkLiveFilesystem(fs)
      expect(result.passed).toBe(true)
    })

    it(`many siblings in one directory`, async () => {
      const count = 20
      for (let i = 0; i < count; i++) {
        await fs.createFile(`/file-${i}.txt`, `content ${i}`)
      }

      const entries = fs.list(`/`)
      expect(entries.length).toBe(count)

      const result = await checkLiveFilesystem(fs)
      expect(result.passed).toBe(true)
    })

    it(`empty filename edge cases`, async () => {
      // These should normalize properly
      await safeOp(() => fs.createFile(`/`, `content`))

      // Root should still be a directory
      expect(fs.isDirectory(`/`)).toBe(true)
    })
  })

  describe(`Content Size Boundaries`, () => {
    const sizes = [0, 1, 10, 100, 1000, 10000]

    for (const size of sizes) {
      it(`file with ${size} bytes`, async () => {
        const content = `x`.repeat(size)
        await fs.createFile(`/sized.txt`, content)

        const stat = fs.stat(`/sized.txt`)
        expect(stat.size).toBe(size)

        const read = await fs.readTextFile(`/sized.txt`)
        expect(read.length).toBe(size)
      })
    }
  })

  describe(`Patch Threshold Boundary`, () => {
    // The implementation uses patches when patch.length < content.length * 0.9
    // Test around this boundary

    it(`small change uses patch`, async () => {
      const original = `x`.repeat(100)
      const modified = `x`.repeat(99) + `y`

      await fs.createFile(`/file.txt`, original)
      await fs.writeFile(`/file.txt`, modified)

      const content = await fs.readTextFile(`/file.txt`)
      expect(content).toBe(modified)
    })

    it(`large change uses replace`, async () => {
      const original = `x`.repeat(100)
      const modified = `y`.repeat(100)

      await fs.createFile(`/file.txt`, original)
      await fs.writeFile(`/file.txt`, modified)

      const content = await fs.readTextFile(`/file.txt`)
      expect(content).toBe(modified)
    })
  })

  describe(`Error Recovery`, () => {
    it(`filesystem remains consistent after failed operation`, async () => {
      await fs.createFile(`/existing.txt`, `content`)

      // This should fail
      await expect(
        fs.createFile(`/existing.txt`, `duplicate`)
      ).rejects.toThrow()

      // But filesystem should still be consistent
      const result = await checkLiveFilesystem(fs)
      expect(result.passed).toBe(true)

      // And original file intact
      const content = await fs.readTextFile(`/existing.txt`)
      expect(content).toBe(`content`)
    })

    it(`filesystem remains consistent after series of failed operations`, async () => {
      // Try various invalid operations
      await safeOp(() => fs.deleteFile(`/nonexistent`))
      await safeOp(() => fs.rmdir(`/nonexistent`))
      await safeOp(() => fs.writeFile(`/nonexistent`, `content`))
      await safeOp(() => fs.mkdir(`/a/b/c/d`))

      // Filesystem should still be consistent (just root dir)
      const result = await checkLiveFilesystem(fs)
      expect(result.passed).toBe(true)
    })
  })
})
