/**
 * DSL Types for Stream-FS Testing
 *
 * Provides type definitions for the fluent scenario builder and history-based verification.
 */

// Types imported from src/types.ts are re-exported or used inline in this module

// ============================================================================
// Step Types (Operations in a Scenario)
// ============================================================================

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

export interface RefreshStep {
  op: `refresh`
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
  | RefreshStep
  | ExpectErrorStep

// ============================================================================
// History Event Types (Recorded During Execution)
// ============================================================================

export interface HistoryEvent {
  timestamp: number
  step: Step
  success: boolean
  error?: string
  errorType?: string
  result?: unknown
  durationMs: number
}

// ============================================================================
// Filesystem Snapshot (State at a Point in Time)
// ============================================================================

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

// ============================================================================
// Scenario Definition
// ============================================================================

export interface ScenarioDefinition {
  name: string
  description?: string
  tags: Array<string>
  steps: Array<Step>
}

// ============================================================================
// Scenario Result
// ============================================================================

export interface ScenarioResult {
  scenario: ScenarioDefinition
  success: boolean
  history: Array<HistoryEvent>
  finalSnapshot?: FilesystemSnapshot
  error?: string
  failedStep?: number
  durationMs: number
}

// ============================================================================
// Invariant Checker Types
// ============================================================================

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

// ============================================================================
// Fuzz Configuration
// ============================================================================

export interface FuzzConfig {
  seed: number
  numOperations: { min: number; max: number }
  numFiles: { min: number; max: number }
  numDirs: { min: number; max: number }
  contentLength: { min: number; max: number }
  operationWeights: {
    createFile: number
    writeFile: number
    deleteFile: number
    mkdir: number
    rmdir: number
    readFile: number
    list: number
  }
}

export const DEFAULT_FUZZ_CONFIG: FuzzConfig = {
  seed: 42,
  numOperations: { min: 10, max: 30 },
  numFiles: { min: 1, max: 5 },
  numDirs: { min: 1, max: 3 },
  contentLength: { min: 1, max: 100 },
  operationWeights: {
    createFile: 3,
    writeFile: 2,
    deleteFile: 1,
    mkdir: 2,
    rmdir: 1,
    readFile: 2,
    list: 1,
  },
}
