/**
 * Fluent Scenario Builder for Stream-FS Testing
 *
 * @example
 * ```typescript
 * await scenario("read-after-write")
 *   .description("A file can be read after writing")
 *   .createFile("/test.txt", "Hello")
 *   .expectContent("/test.txt", "Hello")
 *   .writeFile("/test.txt", "World")
 *   .expectContent("/test.txt", "World")
 *   .run(fs)
 * ```
 */

import {
  DirectoryNotEmptyError,
  ExistsError,
  IsDirectoryError,
  NotDirectoryError,
  NotFoundError,
  PatchApplicationError,
} from "../../src/types"
import type { DurableFilesystem } from "../../src/filesystem"
import type {
  FileSnapshot,
  FilesystemSnapshot,
  HistoryEvent,
  ScenarioDefinition,
  ScenarioResult,
  Step,
} from "./types"

// Scenario Builder

export class ScenarioBuilder {
  private readonly _name: string
  private _description?: string
  private _tags: Array<string> = []
  private _steps: Array<Step> = []

  constructor(name: string) {
    this._name = name
  }

  description(desc: string): this {
    this._description = desc
    return this
  }

  tags(...tags: Array<string>): this {
    this._tags.push(...tags)
    return this
  }

  // File Operations

  createFile(
    path: string,
    content: string | Uint8Array,
    options?: { contentType?: `text` | `binary`; mimeType?: string }
  ): this {
    this._steps.push({ op: `createFile`, path, content, options })
    return this
  }

  writeFile(path: string, content: string | Uint8Array): this {
    this._steps.push({ op: `writeFile`, path, content })
    return this
  }

  readFile(path: string): this {
    this._steps.push({ op: `readFile`, path })
    return this
  }

  readTextFile(path: string): this {
    this._steps.push({ op: `readTextFile`, path })
    return this
  }

  deleteFile(path: string): this {
    this._steps.push({ op: `deleteFile`, path })
    return this
  }

  applyPatch(path: string, patch: string): this {
    this._steps.push({ op: `applyPatch`, path, patch })
    return this
  }

  // Directory Operations

  mkdir(path: string): this {
    this._steps.push({ op: `mkdir`, path })
    return this
  }

  rmdir(path: string): this {
    this._steps.push({ op: `rmdir`, path })
    return this
  }

  list(path: string): this {
    this._steps.push({ op: `list`, path })
    return this
  }

  // Assertions

  expectContent(path: string, expected: string): this {
    this._steps.push({ op: `readTextFile`, path, expectContent: expected })
    return this
  }

  expectBytes(path: string, expected: Uint8Array): this {
    this._steps.push({ op: `readFile`, path, expectBytes: expected })
    return this
  }

  expectExists(path: string, exists: boolean = true): this {
    this._steps.push({ op: `exists`, path, expect: exists })
    return this
  }

  expectNotExists(path: string): this {
    return this.expectExists(path, false)
  }

  expectIsDirectory(path: string, isDir: boolean = true): this {
    this._steps.push({ op: `isDirectory`, path, expect: isDir })
    return this
  }

  expectStat(
    path: string,
    expectations: { type?: `file` | `directory`; size?: number }
  ): this {
    this._steps.push({
      op: `stat`,
      path,
      expectType: expectations.type,
      expectSize: expectations.size,
    })
    return this
  }

  expectEntries(
    path: string,
    entries: Array<{ name: string; type: `file` | `directory` }>
  ): this {
    this._steps.push({ op: `list`, path, expectEntries: entries })
    return this
  }

  expectError(
    errorType:
      | `not_found`
      | `exists`
      | `is_directory`
      | `not_directory`
      | `not_empty`
      | `patch_failed`
      | `not_initialized`
  ): this {
    this._steps.push({ op: `expectError`, errorType })
    return this
  }

  // Build & Run

  build(): ScenarioDefinition {
    return {
      name: this._name,
      description: this._description,
      tags: this._tags,
      steps: [...this._steps],
    }
  }

  async run(fs: DurableFilesystem): Promise<ScenarioResult> {
    return executeScenario(this.build(), fs)
  }
}

// Scenario Execution

export async function executeScenario(
  scenarioDef: ScenarioDefinition,
  fs: DurableFilesystem
): Promise<ScenarioResult> {
  const history: Array<HistoryEvent> = []
  const startTime = Date.now()
  let expectingError: string | null = null

  for (let i = 0; i < scenarioDef.steps.length; i++) {
    const step = scenarioDef.steps[i]!
    const stepStart = Date.now()

    if (step.op === `expectError`) {
      expectingError = step.errorType
      history.push({
        timestamp: stepStart,
        step,
        success: true,
        durationMs: 0,
      })
      continue
    }

    try {
      const result = await executeStep(fs, step)

      if (expectingError) {
        return {
          scenario: scenarioDef,
          success: false,
          history,
          error: `Expected error "${expectingError}" but operation succeeded`,
          failedStep: i,
          durationMs: Date.now() - startTime,
        }
      }

      history.push({
        timestamp: stepStart,
        step,
        success: true,
        result,
        durationMs: Date.now() - stepStart,
      })
    } catch (err) {
      const errorType = classifyError(err)

      if (expectingError === errorType) {
        history.push({
          timestamp: stepStart,
          step,
          success: true,
          error: err instanceof Error ? err.message : String(err),
          errorType,
          durationMs: Date.now() - stepStart,
        })
        expectingError = null
        continue
      }

      history.push({
        timestamp: stepStart,
        step,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        errorType,
        durationMs: Date.now() - stepStart,
      })

      return {
        scenario: scenarioDef,
        success: false,
        history,
        error: err instanceof Error ? err.message : String(err),
        failedStep: i,
        durationMs: Date.now() - startTime,
      }
    }
  }

  const finalSnapshot = await takeSnapshot(fs)

  return {
    scenario: scenarioDef,
    success: true,
    history,
    finalSnapshot,
    durationMs: Date.now() - startTime,
  }
}

async function executeStep(
  fs: DurableFilesystem,
  step: Step
): Promise<unknown> {
  switch (step.op) {
    case `createFile`:
      await fs.createFile(step.path, step.content, step.options)
      return undefined

    case `writeFile`:
      await fs.writeFile(step.path, step.content)
      return undefined

    case `readFile`: {
      const bytes = await fs.readFile(step.path)
      if (step.expectBytes) {
        if (!arraysEqual(bytes, step.expectBytes)) {
          throw new Error(
            `Content mismatch: expected ${step.expectBytes.length} bytes, got ${bytes.length} bytes`
          )
        }
      }
      return bytes
    }

    case `readTextFile`: {
      const content = await fs.readTextFile(step.path)
      if (step.expectContent !== undefined && content !== step.expectContent) {
        throw new Error(
          `Content mismatch: expected "${step.expectContent}", got "${content}"`
        )
      }
      return content
    }

    case `deleteFile`:
      await fs.deleteFile(step.path)
      return undefined

    case `applyPatch`:
      await fs.applyTextPatch(step.path, step.patch)
      return undefined

    case `mkdir`:
      await fs.mkdir(step.path)
      return undefined

    case `rmdir`:
      await fs.rmdir(step.path)
      return undefined

    case `list`: {
      const entries = fs.list(step.path)
      if (step.expectEntries) {
        const actual = entries.map((e) => ({ name: e.name, type: e.type }))
        if (!entriesMatch(actual, step.expectEntries)) {
          throw new Error(
            `Entries mismatch: expected ${JSON.stringify(step.expectEntries)}, got ${JSON.stringify(actual)}`
          )
        }
      }
      return entries
    }

    case `exists`: {
      const exists = fs.exists(step.path)
      if (exists !== step.expect) {
        throw new Error(
          `exists("${step.path}") = ${exists}, expected ${step.expect}`
        )
      }
      return exists
    }

    case `isDirectory`: {
      const isDir = fs.isDirectory(step.path)
      if (isDir !== step.expect) {
        throw new Error(
          `isDirectory("${step.path}") = ${isDir}, expected ${step.expect}`
        )
      }
      return isDir
    }

    case `stat`: {
      const stat = fs.stat(step.path)
      if (step.expectType && stat.type !== step.expectType) {
        throw new Error(
          `stat("${step.path}").type = "${stat.type}", expected "${step.expectType}"`
        )
      }
      if (step.expectSize !== undefined && stat.size !== step.expectSize) {
        throw new Error(
          `stat("${step.path}").size = ${stat.size}, expected ${step.expectSize}`
        )
      }
      return stat
    }

    case `expectError`:
      return undefined
  }
}

function classifyError(err: unknown): string {
  if (err instanceof NotFoundError) return `not_found`
  if (err instanceof ExistsError) return `exists`
  if (err instanceof IsDirectoryError) return `is_directory`
  if (err instanceof NotDirectoryError) return `not_directory`
  if (err instanceof DirectoryNotEmptyError) return `not_empty`
  if (err instanceof PatchApplicationError) return `patch_failed`
  if (err instanceof Error && err.message.includes(`not initialized`))
    return `not_initialized`
  return `unknown`
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function entriesMatch(
  actual: Array<{ name: string; type: string }>,
  expected: Array<{ name: string; type: string }>
): boolean {
  if (actual.length !== expected.length) return false
  const sortedActual = [...actual].sort((a, b) => a.name.localeCompare(b.name))
  const sortedExpected = [...expected].sort((a, b) =>
    a.name.localeCompare(b.name)
  )
  for (let i = 0; i < sortedActual.length; i++) {
    if (
      sortedActual[i]!.name !== sortedExpected[i]!.name ||
      sortedActual[i]!.type !== sortedExpected[i]!.type
    ) {
      return false
    }
  }
  return true
}

// Snapshot

export async function takeSnapshot(
  fs: DurableFilesystem
): Promise<FilesystemSnapshot> {
  const files = new Map<string, FileSnapshot>()
  const directories = new Set<string>()

  async function walk(path: string): Promise<void> {
    if (!fs.exists(path)) return

    if (fs.isDirectory(path)) {
      directories.add(path)
      const entries = fs.list(path)
      for (const entry of entries) {
        const childPath =
          path === `/` ? `/${entry.name}` : `${path}/${entry.name}`
        await walk(childPath)
      }
    } else {
      const stat = fs.stat(path)
      const content = await fs.readTextFile(path).catch(() => `[binary]`)
      files.set(path, {
        path,
        content,
        size: stat.size,
        contentType: stat.contentType ?? `text`,
        mimeType: stat.mimeType ?? `application/octet-stream`,
        createdAt: stat.createdAt,
        modifiedAt: stat.modifiedAt,
      })
    }
  }

  await walk(`/`)

  return {
    files,
    directories,
    timestamp: Date.now(),
  }
}

// Factory Function

export function scenario(name: string): ScenarioBuilder {
  return new ScenarioBuilder(name)
}
