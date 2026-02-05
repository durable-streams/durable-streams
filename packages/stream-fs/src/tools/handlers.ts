/**
 * LLM Tool Handlers for Stream-FS
 *
 * Handles tool invocations from Claude.
 */

import {
  DirectoryNotEmptyError,
  ExistsError,
  IsDirectoryError,
  NotDirectoryError,
  NotFoundError,
  PatchApplicationError,
} from "../types"
import type { DurableFilesystem } from "../filesystem"
import type { StreamFsToolName } from "./definitions"

/**
 * Tool result type
 */
export interface ToolResult {
  success: boolean
  result?: unknown
  error?: string
  errorType?:
    | `not_found`
    | `exists`
    | `is_directory`
    | `not_directory`
    | `conflict`
    | `not_empty`
    | `validation`
    | `unknown`
}

/**
 * Tool input types
 */
export interface ReadFileInput {
  path: string
}

export interface WriteFileInput {
  path: string
  content: string
}

export interface CreateFileInput {
  path: string
  content: string
  mime_type?: string
}

export interface DeleteFileInput {
  path: string
}

export interface EditFileInput {
  path: string
  old_str: string
  new_str: string
}

export interface ListDirectoryInput {
  path: string
}

export interface MkdirInput {
  path: string
}

export interface RmdirInput {
  path: string
}

export interface ExistsInput {
  path: string
}

export interface StatInput {
  path: string
}

/**
 * Union of all tool inputs
 */
export type ToolInput =
  | ReadFileInput
  | WriteFileInput
  | CreateFileInput
  | DeleteFileInput
  | EditFileInput
  | ListDirectoryInput
  | MkdirInput
  | RmdirInput
  | ExistsInput
  | StatInput

/**
 * Handle a tool invocation
 */
export async function handleTool(
  fs: DurableFilesystem,
  toolName: StreamFsToolName,
  input: ToolInput
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case `read_file`:
        return await handleReadFile(fs, input as ReadFileInput)
      case `write_file`:
        return await handleWriteFile(fs, input as WriteFileInput)
      case `create_file`:
        return await handleCreateFile(fs, input as CreateFileInput)
      case `delete_file`:
        return await handleDeleteFile(fs, input as DeleteFileInput)
      case `edit_file`:
        return await handleEditFile(fs, input as EditFileInput)
      case `list_directory`:
        return await handleListDirectory(fs, input as ListDirectoryInput)
      case `mkdir`:
        return await handleMkdir(fs, input as MkdirInput)
      case `rmdir`:
        return await handleRmdir(fs, input as RmdirInput)
      case `exists`:
        return await handleExists(fs, input as ExistsInput)
      case `stat`:
        return await handleStat(fs, input as StatInput)
      default:
        return {
          success: false,
          error: `Unknown tool: ${toolName}`,
          errorType: `unknown`,
        }
    }
  } catch (err) {
    return handleError(err)
  }
}

/**
 * Handle read_file tool
 */
async function handleReadFile(
  fs: DurableFilesystem,
  input: ReadFileInput
): Promise<ToolResult> {
  const content = await fs.readTextFile(input.path)
  return {
    success: true,
    result: { content },
  }
}

/**
 * Handle write_file tool
 */
async function handleWriteFile(
  fs: DurableFilesystem,
  input: WriteFileInput
): Promise<ToolResult> {
  await fs.writeFile(input.path, input.content)
  return {
    success: true,
    result: { written: true },
  }
}

/**
 * Handle create_file tool
 */
async function handleCreateFile(
  fs: DurableFilesystem,
  input: CreateFileInput
): Promise<ToolResult> {
  await fs.createFile(input.path, input.content, {
    mimeType: input.mime_type,
  })
  return {
    success: true,
    result: { created: true },
  }
}

/**
 * Handle delete_file tool
 */
async function handleDeleteFile(
  fs: DurableFilesystem,
  input: DeleteFileInput
): Promise<ToolResult> {
  await fs.deleteFile(input.path)
  return {
    success: true,
    result: { deleted: true },
  }
}

/**
 * Handle edit_file tool
 */
async function handleEditFile(
  fs: DurableFilesystem,
  input: EditFileInput
): Promise<ToolResult> {
  const { path, old_str, new_str } = input

  // Read current content
  const currentContent = await fs.readTextFile(path)

  // Count occurrences
  const occurrences = currentContent.split(old_str).length - 1

  if (occurrences === 0) {
    return {
      success: false,
      error: `String not found in file: "${old_str.slice(0, 50)}${old_str.length > 50 ? `...` : ``}"`,
      errorType: `validation`,
    }
  }

  if (occurrences > 1) {
    return {
      success: false,
      error: `String appears ${occurrences} times in file. It must appear exactly once for edit_file to work. Use write_file instead.`,
      errorType: `validation`,
    }
  }

  // Apply edit
  const newContent = currentContent.replace(old_str, new_str)
  await fs.writeFile(path, newContent)

  return {
    success: true,
    result: { edited: true },
  }
}

/**
 * Handle list_directory tool
 */
async function handleListDirectory(
  fs: DurableFilesystem,
  input: ListDirectoryInput
): Promise<ToolResult> {
  const entries = await fs.list(input.path)
  return {
    success: true,
    result: {
      entries: entries.map((entry) => ({
        name: entry.name,
        type: entry.type,
        size: entry.size,
        modified_at: entry.modifiedAt,
      })),
    },
  }
}

/**
 * Handle mkdir tool
 */
async function handleMkdir(
  fs: DurableFilesystem,
  input: MkdirInput
): Promise<ToolResult> {
  await fs.mkdir(input.path)
  return {
    success: true,
    result: { created: true },
  }
}

/**
 * Handle rmdir tool
 */
async function handleRmdir(
  fs: DurableFilesystem,
  input: RmdirInput
): Promise<ToolResult> {
  await fs.rmdir(input.path)
  return {
    success: true,
    result: { removed: true },
  }
}

/**
 * Handle exists tool
 */
async function handleExists(
  fs: DurableFilesystem,
  input: ExistsInput
): Promise<ToolResult> {
  const exists = await fs.exists(input.path)
  return {
    success: true,
    result: { exists },
  }
}

/**
 * Handle stat tool
 */
async function handleStat(
  fs: DurableFilesystem,
  input: StatInput
): Promise<ToolResult> {
  const stat = await fs.stat(input.path)
  return {
    success: true,
    result: {
      type: stat.type,
      size: stat.size,
      created_at: stat.createdAt,
      modified_at: stat.modifiedAt,
      mime_type: stat.mimeType,
      content_type: stat.contentType,
    },
  }
}

/**
 * Convert errors to ToolResult
 */
function handleError(err: unknown): ToolResult {
  if (err instanceof NotFoundError) {
    return {
      success: false,
      error: err.message,
      errorType: `not_found`,
    }
  }

  if (err instanceof ExistsError) {
    return {
      success: false,
      error: err.message,
      errorType: `exists`,
    }
  }

  if (err instanceof IsDirectoryError) {
    return {
      success: false,
      error: err.message,
      errorType: `is_directory`,
    }
  }

  if (err instanceof NotDirectoryError) {
    return {
      success: false,
      error: err.message,
      errorType: `not_directory`,
    }
  }

  if (err instanceof DirectoryNotEmptyError) {
    return {
      success: false,
      error: err.message,
      errorType: `not_empty`,
    }
  }

  if (err instanceof PatchApplicationError) {
    return {
      success: false,
      error: err.message,
      errorType: `conflict`,
    }
  }

  if (err instanceof Error) {
    return {
      success: false,
      error: err.message,
      errorType: `unknown`,
    }
  }

  return {
    success: false,
    error: String(err),
    errorType: `unknown`,
  }
}
