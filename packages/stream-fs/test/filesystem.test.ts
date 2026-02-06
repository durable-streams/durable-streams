/**
 * StreamFilesystem Tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { StreamFilesystem } from "../src/filesystem"
import { createPatch } from "../src/utils"
import {
  DirectoryNotEmptyError,
  ExistsError,
  IsDirectoryError,
  NotDirectoryError,
  NotFoundError,
  PreconditionFailedError,
} from "../src/types"

function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeout)
        return reject(new Error(`waitFor timed out`))
      setTimeout(check, 10)
    }
    check()
  })
}

describe(`StreamFilesystem`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string
  let fs: StreamFilesystem

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url

    fs = new StreamFilesystem({
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
      const fs2 = new StreamFilesystem({
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

    it(`should see changes via watching`, async () => {
      const fs2 = new StreamFilesystem({
        baseUrl,
        streamPrefix: fs.streamPrefix,
      })
      await fs2.initialize()

      try {
        await fs.createFile(`/new-file.txt`, `New content`)

        const watcher = fs2.watch()
        await waitFor(() => fs2.exists(`/new-file.txt`))
        expect(fs2.exists(`/new-file.txt`)).toBe(true)
        watcher.close()
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

  describe(`watching`, () => {
    let fs2: StreamFilesystem

    async function syncFs2() {
      fs2.close()
      fs2 = new StreamFilesystem({ baseUrl, streamPrefix: fs.streamPrefix })
      await fs2.initialize()
    }

    beforeEach(async () => {
      fs2 = new StreamFilesystem({ baseUrl, streamPrefix: fs.streamPrefix })
      await fs2.initialize()
    })

    afterEach(() => {
      fs2.close()
    })

    it(`emits add when another agent creates a file`, async () => {
      const events: Array<{ type: string; path: string }> = []
      const watcher = fs.watch()
      watcher.on(`add`, (path) => events.push({ type: `add`, path }))

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      await fs2.createFile(`/remote.txt`, `hello from agent 2`)

      await waitFor(() => events.length > 0)
      expect(events[0]).toEqual({ type: `add`, path: `/remote.txt` })

      watcher.close()
    })

    it(`emits change when another agent writes a file`, async () => {
      await fs.createFile(`/shared.txt`, `original`)
      await syncFs2()

      const events: Array<{ type: string; path: string }> = []
      const watcher = fs.watch()
      watcher.on(`change`, (path) => events.push({ type: `change`, path }))

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      await fs2.writeFile(`/shared.txt`, `updated by agent 2`)

      await waitFor(() => events.length > 0)
      expect(events[0]).toEqual({ type: `change`, path: `/shared.txt` })

      watcher.close()
    })

    it(`emits unlink when another agent deletes a file`, async () => {
      await fs.createFile(`/doomed.txt`, `content`)
      await syncFs2()

      const events: Array<{ type: string; path: string }> = []
      const watcher = fs.watch()
      watcher.on(`unlink`, (path) => events.push({ type: `unlink`, path }))

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      await fs2.deleteFile(`/doomed.txt`)

      await waitFor(() => events.length > 0)
      expect(events[0]).toEqual({ type: `unlink`, path: `/doomed.txt` })

      watcher.close()
    })

    it(`emits addDir and unlinkDir for directory operations`, async () => {
      const events: Array<{ type: string; path: string }> = []
      const watcher = fs.watch()
      watcher.on(`all`, (eventType, path) =>
        events.push({ type: eventType, path })
      )

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      await fs2.mkdir(`/newdir`)
      await waitFor(() => events.some((e) => e.type === `addDir`))

      await fs2.rmdir(`/newdir`)
      await waitFor(() => events.some((e) => e.type === `unlinkDir`))

      expect(events).toContainEqual({ type: `addDir`, path: `/newdir` })
      expect(events).toContainEqual({ type: `unlinkDir`, path: `/newdir` })

      watcher.close()
    })

    it(`I12: readTextFile returns fresh content after watch change`, async () => {
      await fs.createFile(`/live.txt`, `version 1`)
      await syncFs2()

      const watcher = fs.watch()
      const changed = new Promise<void>((resolve) => {
        watcher.on(`change`, () => resolve())
      })

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      await fs2.writeFile(`/live.txt`, `version 2`)
      await changed

      const content = await fs.readTextFile(`/live.txt`)
      expect(content).toBe(`version 2`)

      watcher.close()
    })

    it(`path filter: watcher on /src ignores /docs events`, async () => {
      await fs.mkdir(`/src`)
      await fs.mkdir(`/docs`)
      await syncFs2()

      const events: Array<string> = []
      const watcher = fs.watch({ path: `/src` })
      watcher.on(`all`, (_eventType, path) => events.push(path))

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      await fs2.createFile(`/docs/readme.md`, `doc content`)
      await fs2.createFile(`/src/main.ts`, `code content`)

      await waitFor(() => events.includes(`/src/main.ts`))

      expect(events).not.toContain(`/docs/readme.md`)
      expect(events).toContain(`/src/main.ts`)

      watcher.close()
    })

    it(`path filter with recursive: false only gets direct children`, async () => {
      await fs.mkdir(`/root`)
      await fs.mkdir(`/root/deep`)
      await syncFs2()

      const events: Array<string> = []
      const watcher = fs.watch({ path: `/root`, recursive: false })
      watcher.on(`all`, (_eventType, path) => events.push(path))

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      await fs2.createFile(`/root/shallow.txt`, `s`)
      await fs2.createFile(`/root/deep/nested.txt`, `n`)

      await waitFor(() => events.includes(`/root/shallow.txt`))
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(events).toContain(`/root/shallow.txt`)
      expect(events).not.toContain(`/root/deep/nested.txt`)

      watcher.close()
    })

    it(`watcher.close() stops receiving events`, async () => {
      const events: Array<string> = []
      const watcher = fs.watch()
      watcher.on(`add`, (path) => events.push(path))

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      watcher.close()

      await fs2.createFile(`/after-close.txt`, `content`)
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(events).not.toContain(`/after-close.txt`)
    })

    it(`multiple watchers with different filters coexist`, async () => {
      await fs.mkdir(`/a`)
      await fs.mkdir(`/b`)
      await syncFs2()

      const eventsA: Array<string> = []
      const eventsB: Array<string> = []

      const watcherA = fs.watch({ path: `/a` })
      const watcherB = fs.watch({ path: `/b` })

      watcherA.on(`all`, (_type, path) => eventsA.push(path))
      watcherB.on(`all`, (_type, path) => eventsB.push(path))

      await Promise.all([
        new Promise<void>((resolve) => {
          watcherA.on(`ready`, resolve)
        }),
        new Promise<void>((resolve) => {
          watcherB.on(`ready`, resolve)
        }),
      ])

      await fs2.createFile(`/a/file.txt`, `a`)
      await fs2.createFile(`/b/file.txt`, `b`)

      await waitFor(() => eventsA.length > 0 && eventsB.length > 0)

      expect(eventsA).toContain(`/a/file.txt`)
      expect(eventsA).not.toContain(`/b/file.txt`)
      expect(eventsB).toContain(`/b/file.txt`)
      expect(eventsB).not.toContain(`/a/file.txt`)

      watcherA.close()
      watcherB.close()
    })

    it(`fs.close() resolves all watchers' closed promises`, async () => {
      const watcher1 = fs.watch()
      const watcher2 = fs.watch()

      fs.close()

      await watcher1.closed
      await watcher2.closed
    })
  })

  describe(`stale-write detection`, () => {
    let fs2: StreamFilesystem

    async function syncFs2() {
      fs2.close()
      fs2 = new StreamFilesystem({ baseUrl, streamPrefix: fs.streamPrefix })
      await fs2.initialize()
    }

    beforeEach(async () => {
      fs2 = new StreamFilesystem({ baseUrl, streamPrefix: fs.streamPrefix })
      await fs2.initialize()
    })

    afterEach(() => {
      fs2.close()
    })

    it(`writeFile throws PreconditionFailedError after remote modification via watch`, async () => {
      await fs.createFile(`/shared.txt`, `version 1`)
      await fs.readTextFile(`/shared.txt`)
      await syncFs2()

      const watcher = fs.watch()
      const changed = new Promise<void>((resolve) => {
        watcher.on(`change`, () => resolve())
      })

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      await fs2.writeFile(`/shared.txt`, `version 2`)
      await changed

      await expect(fs.writeFile(`/shared.txt`, `version 3`)).rejects.toThrow(
        PreconditionFailedError
      )

      watcher.close()
    })

    it(`applyTextPatch throws PreconditionFailedError after remote modification via watch`, async () => {
      await fs.createFile(`/patch.txt`, `line one`)
      await fs.readTextFile(`/patch.txt`)
      await syncFs2()

      const watcher = fs.watch()
      const changed = new Promise<void>((resolve) => {
        watcher.on(`change`, () => resolve())
      })

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      await fs2.writeFile(`/patch.txt`, `line one modified`)
      await changed

      const patch = createPatch(`line one`, `line one\nline two`)
      await expect(fs.applyTextPatch(`/patch.txt`, patch)).rejects.toThrow(
        PreconditionFailedError
      )

      watcher.close()
    })

    it(`writeFile succeeds when no intervening modification`, async () => {
      await fs.createFile(`/stable.txt`, `content`)
      await fs.readTextFile(`/stable.txt`)

      await fs.writeFile(`/stable.txt`, `updated`)

      expect(await fs.readTextFile(`/stable.txt`)).toBe(`updated`)
    })

    it(`re-reading after remote change clears staleness`, async () => {
      await fs.createFile(`/evolving.txt`, `v1`)
      await fs.readTextFile(`/evolving.txt`)
      await syncFs2()

      const watcher = fs.watch()
      const changed = new Promise<void>((resolve) => {
        watcher.on(`change`, () => resolve())
      })

      await new Promise<void>((resolve) => {
        watcher.on(`ready`, resolve)
      })

      await fs2.writeFile(`/evolving.txt`, `v2`)
      await changed

      await fs.readTextFile(`/evolving.txt`)

      await fs.writeFile(`/evolving.txt`, `v3`)
      expect(await fs.readTextFile(`/evolving.txt`)).toBe(`v3`)

      watcher.close()
    })

    it(`sequential writes by the same agent succeed`, async () => {
      await fs.createFile(`/mine.txt`, `v1`)
      await fs.readTextFile(`/mine.txt`)

      await fs.writeFile(`/mine.txt`, `v2`)
      await fs.readTextFile(`/mine.txt`)
      await fs.writeFile(`/mine.txt`, `v3`)

      expect(await fs.readTextFile(`/mine.txt`)).toBe(`v3`)
    })

    it(`createFile is not affected by stale-write detection`, async () => {
      await fs.createFile(`/new.txt`, `content`)
      expect(await fs.readTextFile(`/new.txt`)).toBe(`content`)
    })
  })

  describe(`partial failure recovery`, () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it(`should rollback createFile when metadata append fails`, async () => {
      const spy = vi.spyOn(StreamFilesystem.prototype as any, `appendMetadata`)
      // Allow the root directory insert during initialize (already done),
      // then fail on the next call (createFile's metadata insert)
      spy.mockRejectedValueOnce(new Error(`metadata write failed`))

      await expect(fs.createFile(`/fail.txt`, `content`)).rejects.toThrow(
        `metadata write failed`
      )

      expect(fs.exists(`/fail.txt`)).toBe(false)

      spy.mockRestore()

      // Subsequent createFile with the same path should succeed
      await fs.createFile(`/fail.txt`, `recovered content`)
      expect(await fs.readTextFile(`/fail.txt`)).toBe(`recovered content`)
    })

    it(`should compensate writeFile when metadata append fails`, async () => {
      await fs.createFile(`/doc.txt`, `original`)

      const spy = vi.spyOn(StreamFilesystem.prototype as any, `appendMetadata`)
      spy.mockRejectedValueOnce(new Error(`metadata write failed`))

      await expect(fs.writeFile(`/doc.txt`, `updated`)).rejects.toThrow(
        `metadata write failed`
      )

      spy.mockRestore()

      // In-memory cache should reflect the old content
      expect(await fs.readTextFile(`/doc.txt`)).toBe(`original`)

      // Subsequent writeFile should succeed
      await fs.writeFile(`/doc.txt`, `final`)
      expect(await fs.readTextFile(`/doc.txt`)).toBe(`final`)
    })

    it(`should compensate applyTextPatch when metadata append fails`, async () => {
      await fs.createFile(`/patch.txt`, `line one`)
      const patch = createPatch(`line one`, `line one\nline two`)

      const spy = vi.spyOn(StreamFilesystem.prototype as any, `appendMetadata`)
      spy.mockRejectedValueOnce(new Error(`metadata write failed`))

      await expect(fs.applyTextPatch(`/patch.txt`, patch)).rejects.toThrow(
        `metadata write failed`
      )

      spy.mockRestore()

      expect(await fs.readTextFile(`/patch.txt`)).toBe(`line one`)

      // Subsequent patch should succeed
      await fs.applyTextPatch(`/patch.txt`, patch)
      expect(await fs.readTextFile(`/patch.txt`)).toBe(`line one\nline two`)
    })

    it(`should succeed deleteFile even when content stream deletion fails`, async () => {
      await fs.createFile(`/doomed.txt`, `content`)

      const spy = vi.spyOn(DurableStream, `delete`)
      spy.mockRejectedValueOnce(new Error(`content delete failed`))

      // deleteFile should succeed (metadata committed, content failure swallowed)
      await fs.deleteFile(`/doomed.txt`)
      expect(fs.exists(`/doomed.txt`)).toBe(false)

      spy.mockRestore()
    })

    it(`should maintain consistency after failed createFile`, async () => {
      const spy = vi.spyOn(StreamFilesystem.prototype as any, `appendMetadata`)
      spy.mockRejectedValueOnce(new Error(`metadata write failed`))

      await expect(fs.createFile(`/ghost.txt`, `content`)).rejects.toThrow(
        `metadata write failed`
      )

      spy.mockRestore()

      expect(fs.exists(`/ghost.txt`)).toBe(false)

      // Fresh instance confirms stream state is clean
      const fresh = new StreamFilesystem({
        baseUrl,
        streamPrefix: fs.streamPrefix,
      })
      await fresh.initialize()
      expect(fresh.exists(`/ghost.txt`)).toBe(false)
      fresh.close()
    })

    it(`should maintain consistency after failed writeFile`, async () => {
      await fs.createFile(`/stable.txt`, `original`)

      const spy = vi.spyOn(StreamFilesystem.prototype as any, `appendMetadata`)
      spy.mockRejectedValueOnce(new Error(`metadata write failed`))

      await expect(fs.writeFile(`/stable.txt`, `updated`)).rejects.toThrow(
        `metadata write failed`
      )

      spy.mockRestore()

      // In-memory cache should reflect the old content
      expect(await fs.readTextFile(`/stable.txt`)).toBe(`original`)

      // Fresh instance confirms stream state matches
      const fresh = new StreamFilesystem({
        baseUrl,
        streamPrefix: fs.streamPrefix,
      })
      await fresh.initialize()
      expect(await fresh.readTextFile(`/stable.txt`)).toBe(`original`)
      fresh.close()
    })
  })
})
