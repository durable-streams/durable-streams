/**
 * DSL Usage Tests
 *
 * Demonstrates and tests the fluent scenario builder DSL.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableFilesystem } from "../src/filesystem"
import { scenario } from "./dsl/scenario-builder"
import { checkAllInvariants } from "./invariants"

describe(`DSL Usage`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string
  let fs: DurableFilesystem

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url

    fs = new DurableFilesystem({
      baseUrl,
      streamPrefix: `/fs/dsl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    await fs.initialize()
  })

  afterEach(async () => {
    fs.close()
    await server.stop()
  })

  describe(`Basic Scenarios`, () => {
    it(`read after write`, async () => {
      const result = await scenario(`read-after-write`)
        .description(`A file can be read immediately after writing`)
        .tags(`basic`, `file`)
        .createFile(`/hello.txt`, `Hello, World!`)
        .expectContent(`/hello.txt`, `Hello, World!`)
        .run(fs)

      expect(result.success).toBe(true)
      expect(result.history.length).toBe(2)
    })

    it(`create directory and file`, async () => {
      const result = await scenario(`create-dir-and-file`)
        .description(`Create a directory then create a file inside it`)
        .mkdir(`/docs`)
        .createFile(`/docs/readme.md`, `# Documentation`)
        .expectExists(`/docs`)
        .expectIsDirectory(`/docs`)
        .expectContent(`/docs/readme.md`, `# Documentation`)
        .run(fs)

      expect(result.success).toBe(true)
    })

    it(`file lifecycle`, async () => {
      const result = await scenario(`file-lifecycle`)
        .description(`Create, modify, and delete a file`)
        .createFile(`/temp.txt`, `initial`)
        .expectContent(`/temp.txt`, `initial`)
        .writeFile(`/temp.txt`, `updated`)
        .expectContent(`/temp.txt`, `updated`)
        .deleteFile(`/temp.txt`)
        .expectNotExists(`/temp.txt`)
        .run(fs)

      expect(result.success).toBe(true)
    })
  })

  describe(`Error Expectations`, () => {
    it(`expects not found error`, async () => {
      const result = await scenario(`expect-not-found`)
        .description(`Reading non-existent file should fail`)
        .expectError(`not_found`)
        .readTextFile(`/nonexistent.txt`)
        .run(fs)

      expect(result.success).toBe(true)
    })

    it(`expects exists error`, async () => {
      const result = await scenario(`expect-exists-error`)
        .description(`Creating duplicate file should fail`)
        .createFile(`/existing.txt`, `original`)
        .expectError(`exists`)
        .createFile(`/existing.txt`, `duplicate`)
        .run(fs)

      expect(result.success).toBe(true)
    })

    it(`expects is_directory error`, async () => {
      const result = await scenario(`expect-is-directory-error`)
        .mkdir(`/mydir`)
        .expectError(`is_directory`)
        .readTextFile(`/mydir`)
        .run(fs)

      expect(result.success).toBe(true)
    })

    it(`expects not_directory error`, async () => {
      const result = await scenario(`expect-not-directory-error`)
        .createFile(`/myfile`, `content`)
        .expectError(`not_directory`)
        .list(`/myfile`)
        .run(fs)

      expect(result.success).toBe(true)
    })

    it(`expects not_empty error`, async () => {
      const result = await scenario(`expect-not-empty-error`)
        .mkdir(`/parent`)
        .createFile(`/parent/child.txt`, `content`)
        .expectError(`not_empty`)
        .rmdir(`/parent`)
        .run(fs)

      expect(result.success).toBe(true)
    })
  })

  describe(`Complex Scenarios`, () => {
    it(`nested directory structure`, async () => {
      const result = await scenario(`nested-structure`)
        .description(`Create a complex nested directory structure`)
        .mkdir(`/project`)
        .mkdir(`/project/src`)
        .mkdir(`/project/test`)
        .createFile(`/project/package.json`, `{"name": "project"}`)
        .createFile(`/project/src/index.ts`, `export const x = 1`)
        .createFile(`/project/test/index.test.ts`, `test("x", () => {})`)
        .expectEntries(`/project`, [
          { name: `package.json`, type: `file` },
          { name: `src`, type: `directory` },
          { name: `test`, type: `directory` },
        ])
        .run(fs)

      expect(result.success).toBe(true)

      // Verify invariants hold
      if (result.finalSnapshot) {
        const invariants = checkAllInvariants(
          result.finalSnapshot,
          result.history
        )
        expect(invariants.passed).toBe(true)
      }
    })

    it(`multiple file updates`, async () => {
      const result = await scenario(`multiple-updates`)
        .createFile(`/counter.txt`, `0`)
        .writeFile(`/counter.txt`, `1`)
        .writeFile(`/counter.txt`, `2`)
        .writeFile(`/counter.txt`, `3`)
        .expectContent(`/counter.txt`, `3`)
        .run(fs)

      expect(result.success).toBe(true)
    })

    it(`stats verification`, async () => {
      const result = await scenario(`stats-verification`)
        .createFile(`/data.txt`, `12345`)
        .expectStat(`/data.txt`, { type: `file`, size: 5 })
        .mkdir(`/emptydir`)
        .expectStat(`/emptydir`, { type: `directory`, size: 0 })
        .run(fs)

      expect(result.success).toBe(true)
    })
  })

  describe(`Binary Files`, () => {
    it(`binary file roundtrip`, async () => {
      const binary = new Uint8Array([0, 127, 255, 128, 64])

      const result = await scenario(`binary-roundtrip`)
        .createFile(`/binary.bin`, binary, { contentType: `binary` })
        .expectBytes(`/binary.bin`, binary)
        .run(fs)

      expect(result.success).toBe(true)
    })
  })

  describe(`Refresh Behavior`, () => {
    it(`refresh clears cache`, async () => {
      const result = await scenario(`refresh-test`)
        .createFile(`/cached.txt`, `original`)
        .expectContent(`/cached.txt`, `original`)
        .refresh()
        .expectContent(`/cached.txt`, `original`)
        .run(fs)

      expect(result.success).toBe(true)
    })
  })

  describe(`Scenario Metadata`, () => {
    it(`scenario has correct metadata`, () => {
      const scenarioDef = scenario(`test-scenario`)
        .description(`This is a test`)
        .tags(`unit`, `fast`, `important`)
        .createFile(`/test.txt`, `content`)
        .build()

      expect(scenarioDef.name).toBe(`test-scenario`)
      expect(scenarioDef.description).toBe(`This is a test`)
      expect(scenarioDef.tags).toEqual([`unit`, `fast`, `important`])
      expect(scenarioDef.steps.length).toBe(1)
    })
  })

  describe(`Result Analysis`, () => {
    it(`provides detailed history`, async () => {
      const result = await scenario(`history-test`)
        .createFile(`/a.txt`, `a`)
        .createFile(`/b.txt`, `b`)
        .deleteFile(`/a.txt`)
        .run(fs)

      expect(result.success).toBe(true)
      expect(result.history.length).toBe(3)

      // All operations succeeded
      for (const event of result.history) {
        expect(event.success).toBe(true)
      }

      // Check operation types
      expect(result.history[0]!.step.op).toBe(`createFile`)
      expect(result.history[1]!.step.op).toBe(`createFile`)
      expect(result.history[2]!.step.op).toBe(`deleteFile`)
    })

    it(`provides final snapshot`, async () => {
      const result = await scenario(`snapshot-test`)
        .mkdir(`/dir`)
        .createFile(`/file.txt`, `content`)
        .run(fs)

      expect(result.success).toBe(true)
      expect(result.finalSnapshot).toBeDefined()
      expect(result.finalSnapshot!.files.size).toBe(1)
      expect(result.finalSnapshot!.directories.size).toBe(2) // / and /dir
    })

    it(`reports failure details`, async () => {
      const result = await scenario(`failure-test`)
        .createFile(`/test.txt`, `content`)
        .expectContent(`/test.txt`, `wrong content`) // This will fail
        .run(fs)

      expect(result.success).toBe(false)
      expect(result.error).toContain(`mismatch`)
      expect(result.failedStep).toBe(1)
    })
  })
})
