/**
 * LLM Tools Tests
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { StreamFilesystem } from "../src/filesystem"
import { handleTool, isStreamFsTool, streamFsTools } from "../src/tools"
import type {
  AppendFileInput,
  CopyInput,
  CreateFileInput,
  DeleteFileInput,
  EditFileInput,
  ExistsInput,
  ListDirectoryInput,
  MkdirInput,
  MoveInput,
  ReadFileInput,
  RmdirInput,
  StatInput,
  TreeInput,
  WriteFileInput,
} from "../src/tools"

describe(`LLM Tools`, () => {
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

  describe(`tool definitions`, () => {
    it(`should have all expected tools`, () => {
      const toolNames = streamFsTools.map((t) => t.name)
      expect(toolNames).toContain(`read_file`)
      expect(toolNames).toContain(`write_file`)
      expect(toolNames).toContain(`create_file`)
      expect(toolNames).toContain(`delete_file`)
      expect(toolNames).toContain(`edit_file`)
      expect(toolNames).toContain(`list_directory`)
      expect(toolNames).toContain(`mkdir`)
      expect(toolNames).toContain(`rmdir`)
      expect(toolNames).toContain(`exists`)
      expect(toolNames).toContain(`stat`)
      expect(toolNames).toContain(`append_file`)
      expect(toolNames).toContain(`move`)
      expect(toolNames).toContain(`copy`)
      expect(toolNames).toContain(`tree`)
    })

    it(`should identify stream-fs tools`, () => {
      expect(isStreamFsTool(`read_file`)).toBe(true)
      expect(isStreamFsTool(`write_file`)).toBe(true)
      expect(isStreamFsTool(`append_file`)).toBe(true)
      expect(isStreamFsTool(`move`)).toBe(true)
      expect(isStreamFsTool(`copy`)).toBe(true)
      expect(isStreamFsTool(`tree`)).toBe(true)
      expect(isStreamFsTool(`unknown_tool`)).toBe(false)
    })
  })

  describe(`read_file`, () => {
    it(`should read file content`, async () => {
      await fs.createFile(`/test.txt`, `Hello, World!`)

      const result = await handleTool(fs, `read_file`, {
        path: `/test.txt`,
      } as ReadFileInput)

      expect(result.success).toBe(true)
      expect((result.result as { content: string }).content).toBe(
        `Hello, World!`
      )
    })

    it(`should return error for non-existent file`, async () => {
      const result = await handleTool(fs, `read_file`, {
        path: `/nonexistent.txt`,
      } as ReadFileInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`not_found`)
    })
  })

  describe(`create_file`, () => {
    it(`should create a new file`, async () => {
      const result = await handleTool(fs, `create_file`, {
        path: `/new.txt`,
        content: `New content`,
      } as CreateFileInput)

      expect(result.success).toBe(true)

      const content = await fs.readTextFile(`/new.txt`)
      expect(content).toBe(`New content`)
    })

    it(`should fail if file exists`, async () => {
      await fs.createFile(`/exists.txt`, `content`)

      const result = await handleTool(fs, `create_file`, {
        path: `/exists.txt`,
        content: `new content`,
      } as CreateFileInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`exists`)
    })
  })

  describe(`write_file`, () => {
    it(`should replace file content`, async () => {
      await fs.createFile(`/test.txt`, `Original`)

      const result = await handleTool(fs, `write_file`, {
        path: `/test.txt`,
        content: `Updated`,
      } as WriteFileInput)

      expect(result.success).toBe(true)

      const content = await fs.readTextFile(`/test.txt`)
      expect(content).toBe(`Updated`)
    })

    it(`should fail for non-existent file`, async () => {
      const result = await handleTool(fs, `write_file`, {
        path: `/nonexistent.txt`,
        content: `content`,
      } as WriteFileInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`not_found`)
    })
  })

  describe(`delete_file`, () => {
    it(`should delete a file`, async () => {
      await fs.createFile(`/test.txt`, `content`)

      const result = await handleTool(fs, `delete_file`, {
        path: `/test.txt`,
      } as DeleteFileInput)

      expect(result.success).toBe(true)
      expect(await fs.exists(`/test.txt`)).toBe(false)
    })
  })

  describe(`edit_file`, () => {
    it(`should edit file with unique string`, async () => {
      await fs.createFile(`/test.txt`, `Hello, World!`)

      const result = await handleTool(fs, `edit_file`, {
        path: `/test.txt`,
        old_str: `World`,
        new_str: `Universe`,
      } as EditFileInput)

      expect(result.success).toBe(true)

      const content = await fs.readTextFile(`/test.txt`)
      expect(content).toBe(`Hello, Universe!`)
    })

    it(`should fail if string not found`, async () => {
      await fs.createFile(`/test.txt`, `Hello, World!`)

      const result = await handleTool(fs, `edit_file`, {
        path: `/test.txt`,
        old_str: `NotFound`,
        new_str: `Something`,
      } as EditFileInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`validation`)
      expect(result.error).toContain(`not found`)
    })

    it(`should fail if string appears multiple times`, async () => {
      await fs.createFile(`/test.txt`, `Hello Hello Hello`)

      const result = await handleTool(fs, `edit_file`, {
        path: `/test.txt`,
        old_str: `Hello`,
        new_str: `Hi`,
      } as EditFileInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`validation`)
      expect(result.error).toContain(`3 times`)
    })
  })

  describe(`list_directory`, () => {
    it(`should list directory contents`, async () => {
      await fs.createFile(`/file1.txt`, `content1`)
      await fs.createFile(`/file2.txt`, `content2`)
      await fs.mkdir(`/subdir`)

      const result = await handleTool(fs, `list_directory`, {
        path: `/`,
      } as ListDirectoryInput)

      expect(result.success).toBe(true)
      const entries = (result.result as { entries: Array<unknown> }).entries
      expect(entries.length).toBe(3)
    })

    it(`should fail for non-directory`, async () => {
      await fs.createFile(`/file.txt`, `content`)

      const result = await handleTool(fs, `list_directory`, {
        path: `/file.txt`,
      } as ListDirectoryInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`not_directory`)
    })
  })

  describe(`mkdir`, () => {
    it(`should create a directory`, async () => {
      const result = await handleTool(fs, `mkdir`, {
        path: `/newdir`,
      } as MkdirInput)

      expect(result.success).toBe(true)
      expect(await fs.isDirectory(`/newdir`)).toBe(true)
    })
  })

  describe(`rmdir`, () => {
    it(`should remove an empty directory`, async () => {
      await fs.mkdir(`/emptydir`)

      const result = await handleTool(fs, `rmdir`, {
        path: `/emptydir`,
      } as RmdirInput)

      expect(result.success).toBe(true)
      expect(await fs.exists(`/emptydir`)).toBe(false)
    })

    it(`should fail for non-empty directory`, async () => {
      await fs.mkdir(`/dir`)
      await fs.createFile(`/dir/file.txt`, `content`)

      const result = await handleTool(fs, `rmdir`, {
        path: `/dir`,
      } as RmdirInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`not_empty`)
    })
  })

  describe(`exists`, () => {
    it(`should return true for existing path`, async () => {
      await fs.createFile(`/test.txt`, `content`)

      const result = await handleTool(fs, `exists`, {
        path: `/test.txt`,
      } as ExistsInput)

      expect(result.success).toBe(true)
      expect((result.result as { exists: boolean }).exists).toBe(true)
    })

    it(`should return false for non-existing path`, async () => {
      const result = await handleTool(fs, `exists`, {
        path: `/nonexistent`,
      } as ExistsInput)

      expect(result.success).toBe(true)
      expect((result.result as { exists: boolean }).exists).toBe(false)
    })
  })

  describe(`stat`, () => {
    it(`should return file stats`, async () => {
      await fs.createFile(`/test.txt`, `Hello`)

      const result = await handleTool(fs, `stat`, {
        path: `/test.txt`,
      } as StatInput)

      expect(result.success).toBe(true)
      const stat = result.result as {
        type: string
        size: number
        mime_type: string
      }
      expect(stat.type).toBe(`file`)
      expect(stat.size).toBe(5)
      expect(stat.mime_type).toBe(`text/plain`)
    })

    it(`should return directory stats`, async () => {
      await fs.mkdir(`/mydir`)

      const result = await handleTool(fs, `stat`, {
        path: `/mydir`,
      } as StatInput)

      expect(result.success).toBe(true)
      const stat = result.result as { type: string; size: number }
      expect(stat.type).toBe(`directory`)
      expect(stat.size).toBe(0)
    })
  })

  describe(`read_file with offset/limit`, () => {
    it(`should return full metadata when no offset/limit`, async () => {
      await fs.createFile(`/lines.txt`, `line1\nline2\nline3`)

      const result = await handleTool(fs, `read_file`, {
        path: `/lines.txt`,
      } as ReadFileInput)

      expect(result.success).toBe(true)
      const r = result.result as {
        content: string
        offset: number
        lines_read: number
        total_lines: number
        has_more: boolean
      }
      expect(r.content).toBe(`line1\nline2\nline3`)
      expect(r.offset).toBe(0)
      expect(r.total_lines).toBe(3)
      expect(r.lines_read).toBe(3)
      expect(r.has_more).toBe(false)
    })

    it(`should paginate with offset and limit`, async () => {
      await fs.createFile(`/big.txt`, `line0\nline1\nline2\nline3\nline4`)

      const result = await handleTool(fs, `read_file`, {
        path: `/big.txt`,
        offset: 1,
        limit: 2,
      } as ReadFileInput)

      expect(result.success).toBe(true)
      const r = result.result as {
        content: string
        offset: number
        lines_read: number
        total_lines: number
        has_more: boolean
      }
      expect(r.content).toBe(`line1\nline2`)
      expect(r.offset).toBe(1)
      expect(r.lines_read).toBe(2)
      expect(r.total_lines).toBe(5)
      expect(r.has_more).toBe(true)
    })

    it(`should handle offset past end of file`, async () => {
      await fs.createFile(`/short.txt`, `one\ntwo`)

      const result = await handleTool(fs, `read_file`, {
        path: `/short.txt`,
        offset: 10,
      } as ReadFileInput)

      expect(result.success).toBe(true)
      const r = result.result as {
        content: string
        lines_read: number
        has_more: boolean
      }
      expect(r.content).toBe(``)
      expect(r.lines_read).toBe(0)
      expect(r.has_more).toBe(false)
    })
  })

  describe(`append_file`, () => {
    it(`should append content to a file`, async () => {
      await fs.createFile(`/log.txt`, `entry1`)

      const result = await handleTool(fs, `append_file`, {
        path: `/log.txt`,
        content: `entry2`,
      } as AppendFileInput)

      expect(result.success).toBe(true)
      const content = await fs.readTextFile(`/log.txt`)
      expect(content).toBe(`entry1\nentry2`)
    })

    it(`should not double newline if file ends with one`, async () => {
      await fs.createFile(`/log.txt`, `entry1\n`)

      const result = await handleTool(fs, `append_file`, {
        path: `/log.txt`,
        content: `entry2`,
      } as AppendFileInput)

      expect(result.success).toBe(true)
      const content = await fs.readTextFile(`/log.txt`)
      expect(content).toBe(`entry1\nentry2`)
    })

    it(`should fail for non-existent file`, async () => {
      const result = await handleTool(fs, `append_file`, {
        path: `/nonexistent.txt`,
        content: `data`,
      } as AppendFileInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`not_found`)
    })
  })

  describe(`move`, () => {
    it(`should move a file`, async () => {
      await fs.createFile(`/source.txt`, `content`)

      const result = await handleTool(fs, `move`, {
        source: `/source.txt`,
        destination: `/dest.txt`,
      } as MoveInput)

      expect(result.success).toBe(true)
      expect(fs.exists(`/source.txt`)).toBe(false)
      expect(fs.exists(`/dest.txt`)).toBe(true)
      expect(await fs.readTextFile(`/dest.txt`)).toBe(`content`)
    })

    it(`should move a directory with contents`, async () => {
      await fs.mkdir(`/src`)
      await fs.createFile(`/src/file.txt`, `hello`)

      const result = await handleTool(fs, `move`, {
        source: `/src`,
        destination: `/dst`,
      } as MoveInput)

      expect(result.success).toBe(true)
      expect(fs.exists(`/src`)).toBe(false)
      expect(fs.exists(`/dst`)).toBe(true)
      expect(fs.exists(`/dst/file.txt`)).toBe(true)
      expect(await fs.readTextFile(`/dst/file.txt`)).toBe(`hello`)
    })

    it(`should fail if destination exists`, async () => {
      await fs.createFile(`/a.txt`, `a`)
      await fs.createFile(`/b.txt`, `b`)

      const result = await handleTool(fs, `move`, {
        source: `/a.txt`,
        destination: `/b.txt`,
      } as MoveInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`exists`)
    })
  })

  describe(`copy`, () => {
    it(`should copy a file`, async () => {
      await fs.createFile(`/original.txt`, `content`)

      const result = await handleTool(fs, `copy`, {
        source: `/original.txt`,
        destination: `/copy.txt`,
      } as CopyInput)

      expect(result.success).toBe(true)
      expect(await fs.readTextFile(`/original.txt`)).toBe(`content`)
      expect(await fs.readTextFile(`/copy.txt`)).toBe(`content`)
    })

    it(`should fail if destination exists`, async () => {
      await fs.createFile(`/a.txt`, `a`)
      await fs.createFile(`/b.txt`, `b`)

      const result = await handleTool(fs, `copy`, {
        source: `/a.txt`,
        destination: `/b.txt`,
      } as CopyInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`exists`)
    })

    it(`should fail for non-existent source`, async () => {
      const result = await handleTool(fs, `copy`, {
        source: `/nope.txt`,
        destination: `/copy.txt`,
      } as CopyInput)

      expect(result.success).toBe(false)
      expect(result.errorType).toBe(`not_found`)
    })
  })

  describe(`tree`, () => {
    it(`should return flat list of all entries`, async () => {
      await fs.mkdir(`/docs`)
      await fs.createFile(`/docs/readme.md`, `# Hello`)
      await fs.createFile(`/index.ts`, `export {}`)

      const result = await handleTool(fs, `tree`, {} as TreeInput)

      expect(result.success).toBe(true)
      const entries = (
        result.result as { entries: Array<{ path: string; type: string }> }
      ).entries
      expect(entries.length).toBe(3)
      expect(entries.map((e) => e.path)).toEqual([
        `/docs`,
        `/docs/readme.md`,
        `/index.ts`,
      ])
    })

    it(`should respect depth limit`, async () => {
      await fs.mkdir(`/a`)
      await fs.mkdir(`/a/b`)
      await fs.createFile(`/a/b/deep.txt`, `deep`)

      const result = await handleTool(fs, `tree`, {
        depth: 1,
      } as TreeInput)

      expect(result.success).toBe(true)
      const entries = (
        result.result as { entries: Array<{ path: string; type: string }> }
      ).entries
      expect(entries.map((e) => e.path)).toEqual([`/a`])
    })

    it(`should start from specified path`, async () => {
      await fs.mkdir(`/src`)
      await fs.createFile(`/src/main.ts`, `code`)
      await fs.mkdir(`/docs`)
      await fs.createFile(`/docs/readme.md`, `doc`)

      const result = await handleTool(fs, `tree`, {
        path: `/src`,
      } as TreeInput)

      expect(result.success).toBe(true)
      const entries = (result.result as { entries: Array<{ path: string }> })
        .entries
      expect(entries.map((e) => e.path)).toEqual([`/src/main.ts`])
    })
  })
})
