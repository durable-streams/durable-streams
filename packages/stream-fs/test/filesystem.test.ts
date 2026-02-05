/**
 * DurableFilesystem Tests
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableFilesystem } from "../src/filesystem"
import {
  DirectoryNotEmptyError,
  ExistsError,
  IsDirectoryError,
  NotDirectoryError,
  NotFoundError,
} from "../src/types"

describe(`DurableFilesystem`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string
  let fs: DurableFilesystem

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url

    fs = new DurableFilesystem({
      baseUrl,
      streamPrefix: `/fs/test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    await fs.initialize()
  })

  afterEach(async () => {
    fs.close()
    await server.stop()
  })

  describe(`initialization`, () => {
    it(`should create root directory on initialize`, async () => {
      const exists = await fs.exists(`/`)
      expect(exists).toBe(true)

      const isDir = await fs.isDirectory(`/`)
      expect(isDir).toBe(true)
    })

    it(`should be idempotent`, async () => {
      await fs.initialize()
      await fs.initialize()
      const exists = await fs.exists(`/`)
      expect(exists).toBe(true)
    })
  })

  describe(`file operations`, () => {
    describe(`createFile`, () => {
      it(`should create a text file`, async () => {
        await fs.createFile(`/hello.txt`, `Hello, World!`)

        const content = await fs.readTextFile(`/hello.txt`)
        expect(content).toBe(`Hello, World!`)
      })

      it(`should create a file with custom MIME type`, async () => {
        await fs.createFile(`/data.json`, `{"key": "value"}`, {
          mimeType: `application/json`,
        })

        const stat = await fs.stat(`/data.json`)
        expect(stat.mimeType).toBe(`application/json`)
      })

      it(`should fail if file already exists`, async () => {
        await fs.createFile(`/test.txt`, `content`)

        await expect(fs.createFile(`/test.txt`, `new content`)).rejects.toThrow(
          ExistsError
        )
      })

      it(`should fail if parent directory does not exist`, async () => {
        await expect(
          fs.createFile(`/nonexistent/file.txt`, `content`)
        ).rejects.toThrow(NotFoundError)
      })

      it(`should normalize paths`, async () => {
        await fs.createFile(`hello.txt`, `content`)
        const exists = await fs.exists(`/hello.txt`)
        expect(exists).toBe(true)
      })
    })

    describe(`readFile`, () => {
      it(`should read file as bytes`, async () => {
        await fs.createFile(`/test.txt`, `Hello`)

        const bytes = await fs.readFile(`/test.txt`)
        expect(new TextDecoder().decode(bytes)).toBe(`Hello`)
      })

      it(`should fail if file does not exist`, async () => {
        await expect(fs.readFile(`/nonexistent.txt`)).rejects.toThrow(
          NotFoundError
        )
      })

      it(`should fail if path is a directory`, async () => {
        await fs.mkdir(`/mydir`)

        await expect(fs.readFile(`/mydir`)).rejects.toThrow(IsDirectoryError)
      })
    })

    describe(`readTextFile`, () => {
      it(`should read file as text`, async () => {
        await fs.createFile(`/test.txt`, `Hello, World!`)

        const content = await fs.readTextFile(`/test.txt`)
        expect(content).toBe(`Hello, World!`)
      })
    })

    describe(`writeFile`, () => {
      it(`should replace file content`, async () => {
        await fs.createFile(`/test.txt`, `Original`)
        await fs.writeFile(`/test.txt`, `Updated`)

        const content = await fs.readTextFile(`/test.txt`)
        expect(content).toBe(`Updated`)
      })

      it(`should update modification time`, async () => {
        await fs.createFile(`/test.txt`, `content`)
        const stat1 = await fs.stat(`/test.txt`)

        // Small delay to ensure time difference
        await new Promise((resolve) => setTimeout(resolve, 10))

        await fs.writeFile(`/test.txt`, `new content`)
        const stat2 = await fs.stat(`/test.txt`)

        expect(new Date(stat2.modifiedAt).getTime()).toBeGreaterThanOrEqual(
          new Date(stat1.modifiedAt).getTime()
        )
      })

      it(`should fail if file does not exist`, async () => {
        await expect(
          fs.writeFile(`/nonexistent.txt`, `content`)
        ).rejects.toThrow(NotFoundError)
      })
    })

    describe(`deleteFile`, () => {
      it(`should delete a file`, async () => {
        await fs.createFile(`/test.txt`, `content`)
        await fs.deleteFile(`/test.txt`)

        const exists = await fs.exists(`/test.txt`)
        expect(exists).toBe(false)
      })

      it(`should fail if file does not exist`, async () => {
        await expect(fs.deleteFile(`/nonexistent.txt`)).rejects.toThrow(
          NotFoundError
        )
      })

      it(`should fail if path is a directory`, async () => {
        await fs.mkdir(`/mydir`)

        await expect(fs.deleteFile(`/mydir`)).rejects.toThrow(IsDirectoryError)
      })
    })
  })

  describe(`directory operations`, () => {
    describe(`mkdir`, () => {
      it(`should create a directory`, async () => {
        await fs.mkdir(`/mydir`)

        const exists = await fs.exists(`/mydir`)
        expect(exists).toBe(true)

        const isDir = await fs.isDirectory(`/mydir`)
        expect(isDir).toBe(true)
      })

      it(`should fail if directory already exists`, async () => {
        await fs.mkdir(`/mydir`)

        await expect(fs.mkdir(`/mydir`)).rejects.toThrow(ExistsError)
      })

      it(`should fail if file with same name exists`, async () => {
        await fs.createFile(`/myfile`, `content`)

        await expect(fs.mkdir(`/myfile`)).rejects.toThrow(ExistsError)
      })

      it(`should fail if parent does not exist`, async () => {
        await expect(fs.mkdir(`/nonexistent/child`)).rejects.toThrow(
          NotFoundError
        )
      })
    })

    describe(`rmdir`, () => {
      it(`should remove an empty directory`, async () => {
        await fs.mkdir(`/mydir`)
        await fs.rmdir(`/mydir`)

        const exists = await fs.exists(`/mydir`)
        expect(exists).toBe(false)
      })

      it(`should fail if directory is not empty`, async () => {
        await fs.mkdir(`/mydir`)
        await fs.createFile(`/mydir/file.txt`, `content`)

        await expect(fs.rmdir(`/mydir`)).rejects.toThrow(DirectoryNotEmptyError)
      })

      it(`should fail if path is a file`, async () => {
        await fs.createFile(`/myfile`, `content`)

        await expect(fs.rmdir(`/myfile`)).rejects.toThrow(NotDirectoryError)
      })

      it(`should not allow removing root`, async () => {
        await expect(fs.rmdir(`/`)).rejects.toThrow()
      })
    })

    describe(`list`, () => {
      it(`should list directory contents`, async () => {
        await fs.createFile(`/file1.txt`, `content1`)
        await fs.createFile(`/file2.txt`, `content2`)
        await fs.mkdir(`/subdir`)

        const entries = await fs.list(`/`)

        expect(entries.length).toBe(3)
        expect(entries.map((e) => e.name).sort()).toEqual([
          `file1.txt`,
          `file2.txt`,
          `subdir`,
        ])
      })

      it(`should return empty array for empty directory`, async () => {
        await fs.mkdir(`/empty`)

        const entries = await fs.list(`/empty`)
        expect(entries).toEqual([])
      })

      it(`should only list direct children`, async () => {
        await fs.mkdir(`/parent`)
        await fs.mkdir(`/parent/child`)
        await fs.createFile(`/parent/child/file.txt`, `content`)

        const entries = await fs.list(`/parent`)

        expect(entries.length).toBe(1)
        expect(entries[0]!.name).toBe(`child`)
      })

      it(`should fail if path does not exist`, () => {
        expect(() => fs.list(`/nonexistent`)).toThrow(NotFoundError)
      })

      it(`should fail if path is a file`, async () => {
        await fs.createFile(`/myfile`, `content`)

        expect(() => fs.list(`/myfile`)).toThrow(NotDirectoryError)
      })
    })
  })

  describe(`metadata operations`, () => {
    describe(`exists`, () => {
      it(`should return true for existing file`, async () => {
        await fs.createFile(`/test.txt`, `content`)

        expect(await fs.exists(`/test.txt`)).toBe(true)
      })

      it(`should return true for existing directory`, async () => {
        await fs.mkdir(`/mydir`)

        expect(await fs.exists(`/mydir`)).toBe(true)
      })

      it(`should return false for non-existent path`, async () => {
        expect(await fs.exists(`/nonexistent`)).toBe(false)
      })
    })

    describe(`isDirectory`, () => {
      it(`should return true for directory`, async () => {
        await fs.mkdir(`/mydir`)

        expect(await fs.isDirectory(`/mydir`)).toBe(true)
      })

      it(`should return false for file`, async () => {
        await fs.createFile(`/myfile`, `content`)

        expect(await fs.isDirectory(`/myfile`)).toBe(false)
      })

      it(`should return false for non-existent path`, async () => {
        expect(await fs.isDirectory(`/nonexistent`)).toBe(false)
      })
    })

    describe(`stat`, () => {
      it(`should return file stats`, async () => {
        await fs.createFile(`/test.txt`, `Hello, World!`)

        const stat = await fs.stat(`/test.txt`)

        expect(stat.type).toBe(`file`)
        expect(stat.size).toBe(13) // "Hello, World!".length in bytes
        expect(stat.mimeType).toBe(`text/plain`)
        expect(stat.contentType).toBe(`text`)
        expect(stat.createdAt).toBeDefined()
        expect(stat.modifiedAt).toBeDefined()
      })

      it(`should return directory stats`, async () => {
        await fs.mkdir(`/mydir`)

        const stat = await fs.stat(`/mydir`)

        expect(stat.type).toBe(`directory`)
        expect(stat.size).toBe(0)
        expect(stat.mimeType).toBeUndefined()
      })

      it(`should fail if path does not exist`, () => {
        expect(() => fs.stat(`/nonexistent`)).toThrow(NotFoundError)
      })
    })
  })

  describe(`multi-agent collaboration`, () => {
    it(`should share state between two filesystem instances`, async () => {
      // Agent 1 creates a file
      await fs.createFile(`/shared.txt`, `Hello from Agent 1`)

      // Agent 2 connects to the same prefix
      const fs2 = new DurableFilesystem({
        baseUrl,
        streamPrefix: fs.streamPrefix,
      })
      await fs2.initialize()

      try {
        // Agent 2 can read the file
        const content = await fs2.readTextFile(`/shared.txt`)
        expect(content).toBe(`Hello from Agent 1`)
      } finally {
        fs2.close()
      }
    })

    it(`should see changes after refresh`, async () => {
      // Create a second instance with the same prefix
      const fs2 = new DurableFilesystem({
        baseUrl,
        streamPrefix: fs.streamPrefix,
      })
      await fs2.initialize()

      try {
        // Agent 1 creates a file
        await fs.createFile(`/new-file.txt`, `New content`)

        // Agent 2 refreshes and sees the file
        await fs2.refresh()
        const exists = await fs2.exists(`/new-file.txt`)
        expect(exists).toBe(true)
      } finally {
        fs2.close()
      }
    })
  })

  describe(`patching`, () => {
    it(`should use patches for small changes`, async () => {
      await fs.createFile(`/doc.md`, `# Title\n\nOriginal content here.`)
      await fs.writeFile(`/doc.md`, `# Title\n\nUpdated content here.`)

      const content = await fs.readTextFile(`/doc.md`)
      expect(content).toBe(`# Title\n\nUpdated content here.`)
    })

    it(`should handle multiple edits`, async () => {
      await fs.createFile(`/doc.txt`, `Line 1`)
      await fs.writeFile(`/doc.txt`, `Line 1\nLine 2`)
      await fs.writeFile(`/doc.txt`, `Line 1\nLine 2\nLine 3`)

      const content = await fs.readTextFile(`/doc.txt`)
      expect(content).toBe(`Line 1\nLine 2\nLine 3`)
    })
  })

  describe(`binary files`, () => {
    it(`should handle binary content`, async () => {
      const binary = new Uint8Array([0, 1, 2, 255, 254, 253])
      await fs.createFile(`/binary.bin`, binary, { contentType: `binary` })

      const read = await fs.readFile(`/binary.bin`)
      expect(read).toEqual(binary)
    })
  })

  describe(`cache management`, () => {
    it(`should evict file from cache`, async () => {
      await fs.createFile(`/cached.txt`, `cached content`)

      // Read to populate cache
      await fs.readTextFile(`/cached.txt`)

      // Evict
      fs.evictFromCache(`/cached.txt`)

      // Should still be readable
      const content = await fs.readTextFile(`/cached.txt`)
      expect(content).toBe(`cached content`)
    })

    it(`should clear all content cache`, async () => {
      await fs.createFile(`/file1.txt`, `content1`)
      await fs.createFile(`/file2.txt`, `content2`)

      await fs.readTextFile(`/file1.txt`)
      await fs.readTextFile(`/file2.txt`)

      fs.clearContentCache()

      // Files should still be readable
      expect(await fs.readTextFile(`/file1.txt`)).toBe(`content1`)
      expect(await fs.readTextFile(`/file2.txt`)).toBe(`content2`)
    })
  })
})
