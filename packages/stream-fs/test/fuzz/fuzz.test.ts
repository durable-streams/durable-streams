/**
 * Fuzz Tests for Stream-FS
 *
 * Generates random operation sequences and verifies invariants hold.
 * Tests are reproducible via seed - if a test fails, rerun with the same seed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { StreamFilesystem } from "../../src/filesystem"
import { checkLiveFilesystem } from "../invariants"
import { SeededRandom, generateFuzzScenario } from "./random"
import type { FuzzOperation } from "./random"

describe(`Fuzz Tests`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string
  let fs: StreamFilesystem

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url

    fs = new StreamFilesystem({
      baseUrl,
      streamPrefix: `/fs/fuzz-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    await fs.initialize()
  })

  afterEach(async () => {
    fs.close()
    await server.stop()
  })

  async function executeFuzzOperation(
    filesystem: StreamFilesystem,
    op: FuzzOperation
  ): Promise<{ success: boolean; error?: string }> {
    try {
      switch (op.op) {
        case `createFile`:
          await filesystem.createFile(op.path, op.content ?? `content`)
          break
        case `writeFile`:
          await filesystem.writeFile(op.path, op.content ?? `updated`)
          break
        case `deleteFile`:
          await filesystem.deleteFile(op.path)
          break
        case `mkdir`:
          await filesystem.mkdir(op.path)
          break
        case `rmdir`:
          await filesystem.rmdir(op.path)
          break
        case `readFile`:
          await filesystem.readTextFile(op.path)
          break
        case `list`:
          filesystem.list(op.path)
          break
        case `move`:
          await filesystem.move(op.path, op.destination!)
          break
        case `copy`: {
          const content = await filesystem.readTextFile(op.path)
          const stat = filesystem.stat(op.path)
          await filesystem.createFile(op.destination!, content, {
            mimeType: stat.mimeType,
          })
          break
        }
        case `appendFile`: {
          const existing = await filesystem.readTextFile(op.path)
          const separator =
            existing.length > 0 && !existing.endsWith(`\n`) ? `\n` : ``
          await filesystem.writeFile(
            op.path,
            existing + separator + (op.content ?? `appended`)
          )
          break
        }
      }
      return { success: true }
    } catch (err) {
      // Expected errors are fine - the generated scenario may include
      // operations that fail due to state (e.g., delete non-existent file)
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // Run fuzz tests with different seeds
  const FUZZ_SEEDS = [42, 123, 456, 789, 1000, 2024, 3141, 9999]

  for (const seed of FUZZ_SEEDS) {
    it(`random scenario (seed=${seed}) maintains all invariants`, async () => {
      const scenario = generateFuzzScenario(seed, {
        maxOperations: 15,
        maxFiles: 4,
        maxDirs: 2,
      })

      // Execute operations
      for (const op of scenario.operations) {
        await executeFuzzOperation(fs, op)
      }

      // Verify all invariants hold
      const invariantResult = await checkLiveFilesystem(fs)

      if (!invariantResult.passed) {
        console.error(`Invariant check failed for seed ${seed}:`)
        console.error(`Failed invariants:`, invariantResult.failedInvariants)
        console.error(
          `Operations:`,
          JSON.stringify(scenario.operations, null, 2)
        )
      }

      expect(invariantResult.passed).toBe(true)
    })
  }

  describe(`specific seed reproduction`, () => {
    it(`can reproduce a scenario from seed`, () => {
      const seed = 42
      const scenario1 = generateFuzzScenario(seed)
      const scenario2 = generateFuzzScenario(seed)

      // Same seed produces same scenario
      expect(scenario1.operations.length).toBe(scenario2.operations.length)
      for (let i = 0; i < scenario1.operations.length; i++) {
        expect(scenario1.operations[i]).toEqual(scenario2.operations[i])
      }
    })
  })

  describe(`stress tests`, () => {
    it(`handles 50 random operations without invariant violations`, async () => {
      const scenario = generateFuzzScenario(12345, {
        maxOperations: 50,
        maxFiles: 10,
        maxDirs: 5,
      })

      for (const op of scenario.operations) {
        await executeFuzzOperation(fs, op)
      }

      const result = await checkLiveFilesystem(fs)
      expect(result.passed).toBe(true)
    })

    it(`handles rapid create-delete cycles`, async () => {
      for (let i = 0; i < 20; i++) {
        const path = `/rapid-${i}.txt`
        await fs.createFile(path, `content ${i}`)
        await fs.deleteFile(path)
      }

      const result = await checkLiveFilesystem(fs)
      expect(result.passed).toBe(true)
    })

    it(`handles deep directory nesting`, async () => {
      let currentPath = ``
      for (let depth = 1; depth <= 10; depth++) {
        currentPath += `/dir${depth}`
        await fs.mkdir(currentPath)
      }

      await fs.createFile(`${currentPath}/deep-file.txt`, `I am deeply nested`)

      const result = await checkLiveFilesystem(fs)
      expect(result.passed).toBe(true)

      // Verify we can read the deep file
      const content = await fs.readTextFile(`${currentPath}/deep-file.txt`)
      expect(content).toBe(`I am deeply nested`)
    })
  })

  describe(`content integrity`, () => {
    it(`maintains content integrity through many writes`, async () => {
      const rng = new SeededRandom(54321)
      await fs.createFile(`/evolving.txt`, `initial`)

      const contents: Array<string> = [`initial`]
      for (let i = 0; i < 20; i++) {
        const newContent = rng.text(10, 100)
        await fs.writeFile(`/evolving.txt`, newContent)
        contents.push(newContent)
      }

      // Final content should match last write
      const finalContent = await fs.readTextFile(`/evolving.txt`)
      expect(finalContent).toBe(contents[contents.length - 1])
    })
  })
})
