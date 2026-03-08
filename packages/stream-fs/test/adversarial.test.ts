/**
 * Adversarial Tests (Tier 2 DSL)
 *
 * Tests that verify the system handles invalid inputs, edge cases, and
 * constraint violations correctly. These tests intentionally try to break
 * invariants to verify defensive behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { StreamFilesystem } from "../src/filesystem"
import {
  DirectoryNotEmptyError,
  ExistsError,
  IsDirectoryError,
  NotDirectoryError,
  NotFoundError,
} from "../src/types"

describe(`Adversarial Tests`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string
  let fs: StreamFilesystem

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url

    fs = new StreamFilesystem({
      baseUrl,
      streamPrefix: `/fs/adversarial-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    await fs.initialize()
  })

  afterEach(async () => {
    fs.close()
    await server.stop()
  })

  describe(`C10: Operations Before Initialize`, () => {
    it(`should reject operations on uninitialized filesystem`, async () => {
      const uninitializedFs = new StreamFilesystem({
        baseUrl,
        streamPrefix: `/fs/uninit`,
      })
      // DON'T call initialize()

      expect(() => uninitializedFs.exists(`/foo`)).toThrow(`not initialized`)
      expect(() => uninitializedFs.list(`/`)).toThrow(`not initialized`)
      expect(() => uninitializedFs.stat(`/foo`)).toThrow(`not initialized`)
      expect(() => uninitializedFs.isDirectory(`/foo`)).toThrow(
        `not initialized`
      )

      await expect(uninitializedFs.createFile(`/foo`, `bar`)).rejects.toThrow(
        `not initialized`
      )
      await expect(uninitializedFs.writeFile(`/foo`, `bar`)).rejects.toThrow(
        `not initialized`
      )
      await expect(uninitializedFs.readFile(`/foo`)).rejects.toThrow(
        `not initialized`
      )
      await expect(uninitializedFs.deleteFile(`/foo`)).rejects.toThrow(
        `not initialized`
      )
      await expect(uninitializedFs.mkdir(`/foo`)).rejects.toThrow(
        `not initialized`
      )
      await expect(uninitializedFs.rmdir(`/foo`)).rejects.toThrow(
        `not initialized`
      )
    })
  })

  describe(`C1: No File Without Parent`, () => {
    it(`rejects creating file in non-existent directory`, async () => {
      await expect(
        fs.createFile(`/nonexistent/file.txt`, `content`)
      ).rejects.toThrow(NotFoundError)
    })

    it(`rejects creating file in deeply nested non-existent path`, async () => {
      await expect(
        fs.createFile(`/a/b/c/d/e/file.txt`, `content`)
      ).rejects.toThrow(NotFoundError)
    })

    it(`rejects creating file when parent is a file`, async () => {
      await fs.createFile(`/parent`, `I am a file`)

      await expect(
        fs.createFile(`/parent/child.txt`, `content`)
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe(`C2: No Directory Without Parent`, () => {
    it(`rejects creating directory in non-existent parent`, async () => {
      await expect(fs.mkdir(`/nonexistent/child`)).rejects.toThrow(
        NotFoundError
      )
    })

    it(`rejects creating directory when parent is a file`, async () => {
      await fs.createFile(`/file`, `content`)

      await expect(fs.mkdir(`/file/subdir`)).rejects.toThrow(NotFoundError)
    })
  })

  describe(`C3: No Duplicate Paths`, () => {
    it(`rejects creating file at existing file path`, async () => {
      await fs.createFile(`/existing.txt`, `original`)

      await expect(fs.createFile(`/existing.txt`, `duplicate`)).rejects.toThrow(
        ExistsError
      )
    })

    it(`rejects creating file at existing directory path`, async () => {
      await fs.mkdir(`/mydir`)

      await expect(fs.createFile(`/mydir`, `content`)).rejects.toThrow(
        ExistsError
      )
    })

    it(`rejects creating directory at existing file path`, async () => {
      await fs.createFile(`/myfile`, `content`)

      await expect(fs.mkdir(`/myfile`)).rejects.toThrow(ExistsError)
    })

    it(`rejects creating directory at existing directory path`, async () => {
      await fs.mkdir(`/mydir`)

      await expect(fs.mkdir(`/mydir`)).rejects.toThrow(ExistsError)
    })
  })

  describe(`C4: No Write to Non-Existent File`, () => {
    it(`rejects writing to non-existent file`, async () => {
      await expect(fs.writeFile(`/nonexistent.txt`, `content`)).rejects.toThrow(
        NotFoundError
      )
    })

    it(`rejects writing to directory`, async () => {
      await fs.mkdir(`/mydir`)

      await expect(fs.writeFile(`/mydir`, `content`)).rejects.toThrow(
        IsDirectoryError
      )
    })
  })

  describe(`C5: No Remove Non-Empty Directory`, () => {
    it(`rejects removing directory with files`, async () => {
      await fs.mkdir(`/parent`)
      await fs.createFile(`/parent/child.txt`, `content`)

      await expect(fs.rmdir(`/parent`)).rejects.toThrow(DirectoryNotEmptyError)
    })

    it(`rejects removing directory with subdirectories`, async () => {
      await fs.mkdir(`/parent`)
      await fs.mkdir(`/parent/child`)

      await expect(fs.rmdir(`/parent`)).rejects.toThrow(DirectoryNotEmptyError)
    })

    it(`rejects removing directory with deeply nested content`, async () => {
      await fs.mkdir(`/a`)
      await fs.mkdir(`/a/b`)
      await fs.mkdir(`/a/b/c`)
      await fs.createFile(`/a/b/c/deep.txt`, `content`)

      await expect(fs.rmdir(`/a`)).rejects.toThrow(DirectoryNotEmptyError)
      await expect(fs.rmdir(`/a/b`)).rejects.toThrow(DirectoryNotEmptyError)
      await expect(fs.rmdir(`/a/b/c`)).rejects.toThrow(DirectoryNotEmptyError)
    })
  })

  describe(`C6: No Remove Root`, () => {
    it(`rejects removing root directory`, async () => {
      await expect(fs.rmdir(`/`)).rejects.toThrow()
    })

    it(`rejects removing root via normalized paths`, async () => {
      await expect(fs.rmdir(`/.`)).rejects.toThrow()
      await expect(fs.rmdir(`/..`)).rejects.toThrow()
    })
  })

  describe(`C7: No Read Directory as File`, () => {
    it(`rejects reading directory as file`, async () => {
      await fs.mkdir(`/mydir`)

      await expect(fs.readFile(`/mydir`)).rejects.toThrow(IsDirectoryError)
      await expect(fs.readTextFile(`/mydir`)).rejects.toThrow(IsDirectoryError)
    })

    it(`rejects reading root as file`, async () => {
      await expect(fs.readFile(`/`)).rejects.toThrow(IsDirectoryError)
    })
  })

  describe(`C8: No List File as Directory`, () => {
    it(`rejects listing file as directory`, async () => {
      await fs.createFile(`/myfile.txt`, `content`)

      expect(() => fs.list(`/myfile.txt`)).toThrow(NotDirectoryError)
    })
  })

  describe(`C9: No Binary Patch`, () => {
    it(`rejects applying patch to binary file`, async () => {
      const binary = new Uint8Array([0, 1, 2, 255])
      await fs.createFile(`/binary.bin`, binary, { contentType: `binary` })

      await expect(
        fs.applyTextPatch(`/binary.bin`, `some patch`)
      ).rejects.toThrow(`binary`)
    })
  })

  describe(`Edge Cases: Path Normalization`, () => {
    it(`handles paths with ..`, async () => {
      await fs.mkdir(`/a`)
      await fs.mkdir(`/a/b`)
      await fs.createFile(`/a/b/../c.txt`, `content`) // Should create /a/c.txt

      expect(fs.exists(`/a/c.txt`)).toBe(true)
    })

    it(`handles paths with .`, async () => {
      await fs.createFile(`/./test.txt`, `content`)
      expect(fs.exists(`/test.txt`)).toBe(true)
    })

    it(`handles paths with multiple slashes`, async () => {
      await fs.mkdir(`/double`)
      await fs.createFile(`//double//slashes.txt`, `content`)
      expect(fs.exists(`/double/slashes.txt`)).toBe(true)
    })

    it(`handles paths without leading slash`, async () => {
      await fs.createFile(`no-leading-slash.txt`, `content`)
      expect(fs.exists(`/no-leading-slash.txt`)).toBe(true)
    })
  })

  describe(`Edge Cases: Empty Content`, () => {
    it(`allows creating empty file`, async () => {
      await fs.createFile(`/empty.txt`, ``)
      const content = await fs.readTextFile(`/empty.txt`)
      expect(content).toBe(``)
    })

    it(`allows writing empty content`, async () => {
      await fs.createFile(`/file.txt`, `original`)
      await fs.writeFile(`/file.txt`, ``)
      const content = await fs.readTextFile(`/file.txt`)
      expect(content).toBe(``)
    })
  })

  describe(`Edge Cases: Special Characters`, () => {
    it(`handles filenames with spaces`, async () => {
      await fs.createFile(`/file with spaces.txt`, `content`)
      expect(fs.exists(`/file with spaces.txt`)).toBe(true)
    })

    it(`handles unicode filenames`, async () => {
      await fs.createFile(`/文件.txt`, `内容`)
      const content = await fs.readTextFile(`/文件.txt`)
      expect(content).toBe(`内容`)
    })

    it(`handles emoji in content`, async () => {
      await fs.createFile(`/emoji.txt`, `Hello 🎉 World 🌍`)
      const content = await fs.readTextFile(`/emoji.txt`)
      expect(content).toBe(`Hello 🎉 World 🌍`)
    })
  })

  describe(`Edge Cases: Large Content`, () => {
    it(`handles moderately large files`, async () => {
      const largeContent = `x`.repeat(100000)
      await fs.createFile(`/large.txt`, largeContent)
      const content = await fs.readTextFile(`/large.txt`)
      expect(content.length).toBe(100000)
    })
  })

  describe(`Rapid Operations`, () => {
    it(`handles rapid create-delete cycles`, async () => {
      for (let i = 0; i < 50; i++) {
        await fs.createFile(`/rapid.txt`, `iteration ${i}`)
        await fs.deleteFile(`/rapid.txt`)
      }
      expect(fs.exists(`/rapid.txt`)).toBe(false)
    })

    it(`handles rapid writes to same file`, async () => {
      await fs.createFile(`/rapid-write.txt`, `v0`)
      for (let i = 1; i <= 50; i++) {
        await fs.writeFile(`/rapid-write.txt`, `v${i}`)
      }
      const content = await fs.readTextFile(`/rapid-write.txt`)
      expect(content).toBe(`v50`)
    })
  })

  describe(`Delete then Recreate`, () => {
    it(`allows recreating deleted file`, async () => {
      await fs.createFile(`/recreate.txt`, `original`)
      await fs.deleteFile(`/recreate.txt`)
      await fs.createFile(`/recreate.txt`, `new`)

      const content = await fs.readTextFile(`/recreate.txt`)
      expect(content).toBe(`new`)
    })

    it(`allows recreating deleted directory`, async () => {
      await fs.mkdir(`/recreate-dir`)
      await fs.rmdir(`/recreate-dir`)
      await fs.mkdir(`/recreate-dir`)

      expect(fs.isDirectory(`/recreate-dir`)).toBe(true)
    })
  })

  describe(`Mixed File/Directory Operations`, () => {
    it(`delete file allows creating directory at same path`, async () => {
      await fs.createFile(`/path`, `I was a file`)
      await fs.deleteFile(`/path`)
      await fs.mkdir(`/path`)

      expect(fs.isDirectory(`/path`)).toBe(true)
    })

    it(`delete directory allows creating file at same path`, async () => {
      await fs.mkdir(`/path`)
      await fs.rmdir(`/path`)
      await fs.createFile(`/path`, `I am now a file`)

      expect(fs.isDirectory(`/path`)).toBe(false)
      const content = await fs.readTextFile(`/path`)
      expect(content).toBe(`I am now a file`)
    })
  })
})
