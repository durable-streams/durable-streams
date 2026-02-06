/**
 * DSL Types for Stream-FS Testing
 */

// Step Types (Operations in a Scenario)

export interface CreateFileStep {
  op: `createFile`
  path: string
  content: string | Uint8Array
  options?: { contentType?: `text` | `binary`; mimeType?: string }
}

export interface WriteFileStep {
  op: `writeFile`
  path: string
  content: string | Uint8Array
}

export interface ReadFileStep {
  op: `readFile`
  path: string
  expectBytes?: Uint8Array
}

export interface ReadTextFileStep {
  op: `readTextFile`
  path: string
  expectContent?: string
}

export interface DeleteFileStep {
  op: `deleteFile`
  path: string
}

export interface ApplyPatchStep {
  op: `applyPatch`
  path: string
  patch: string
}

export interface MkdirStep {
  op: `mkdir`
  path: string
}

export interface RmdirStep {
  op: `rmdir`
  path: string
}

export interface ListStep {
  op: `list`
  path: string
  expectEntries?: Array<{ name: string; type: `file` | `directory` }>
}

export interface ExistsStep {
  op: `exists`
  path: string
  expect: boolean
}

export interface IsDirectoryStep {
  op: `isDirectory`
  path: string
  expect: boolean
}

export interface StatStep {
  op: `stat`
  path: string
  expectType?: `file` | `directory`
  expectSize?: number
}

export interface ExpectErrorStep {
  op: `expectError`
  errorType:
    | `not_found`
    | `exists`
    | `is_directory`
    | `not_directory`
    | `not_empty`
    | `patch_failed`
    | `not_initialized`
}

export type Step =
  | CreateFileStep
  | WriteFileStep
  | ReadFileStep
  | ReadTextFileStep
  | DeleteFileStep
  | ApplyPatchStep
  | MkdirStep
  | RmdirStep
  | ListStep
  | ExistsStep
  | IsDirectoryStep
  | StatStep
  | ExpectErrorStep

// History Event Types (Recorded During Execution)

export interface HistoryEvent {
  timestamp: number
  step: Step
  success: boolean
  error?: string
  errorType?: string
  result?: unknown
  durationMs: number
}

// Filesystem Snapshot (State at a Point in Time)

export interface FilesystemSnapshot {
  files: Map<string, FileSnapshot>
  directories: Set<string>
  timestamp: number
}

export interface FileSnapshot {
  path: string
  content: string
  size: number
  contentType: `text` | `binary`
  mimeType: string
  createdAt: string
  modifiedAt: string
}

// Scenario Definition and Result

export interface ScenarioDefinition {
  name: string
  description?: string
  tags: Array<string>
  steps: Array<Step>
}

export interface ScenarioResult {
  scenario: ScenarioDefinition
  success: boolean
  history: Array<HistoryEvent>
  finalSnapshot?: FilesystemSnapshot
  error?: string
  failedStep?: number
  durationMs: number
}

// Invariant Checker Types

export interface InvariantCheckResult {
  invariant: string
  passed: boolean
  message?: string
  details?: Record<string, unknown>
}

export type InvariantChecker = (
  snapshot: FilesystemSnapshot,
  history?: Array<HistoryEvent>
) => InvariantCheckResult
