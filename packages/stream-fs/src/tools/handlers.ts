/**
 * LLM Tool Handlers for Stream-FS
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
  old_str?: string
  new_str?: string
  edits?: Array<{ old_str: string; new_str: string }>
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
        return handleListDirectory(fs, input as ListDirectoryInput)
      case `mkdir`:
        return await handleMkdir(fs, input as MkdirInput)
      case `rmdir`:
        return await handleRmdir(fs, input as RmdirInput)
      case `exists`:
        return handleExists(fs, input as ExistsInput)
      case `stat`:
        return handleStat(fs, input as StatInput)
      default:
        return {
          success: false,
          error: `Unknown tool: ${toolName}`,
          errorType: `unknown`,
        }
    }
  } catch (err) {
    return classifyError(err)
  }
}

async function handleReadFile(
  fs: DurableFilesystem,
  input: ReadFileInput
): Promise<ToolResult> {
  const content = await fs.readTextFile(input.path)
  return { success: true, result: { content } }
}

async function handleWriteFile(
  fs: DurableFilesystem,
  input: WriteFileInput
): Promise<ToolResult> {
  await fs.writeFile(input.path, input.content)
  return { success: true, result: { written: true } }
}

async function handleCreateFile(
  fs: DurableFilesystem,
  input: CreateFileInput
): Promise<ToolResult> {
  await fs.createFile(input.path, input.content, {
    mimeType: input.mime_type,
  })
  return { success: true, result: { created: true } }
}

async function handleDeleteFile(
  fs: DurableFilesystem,
  input: DeleteFileInput
): Promise<ToolResult> {
  await fs.deleteFile(input.path)
  return { success: true, result: { deleted: true } }
}

async function handleEditFile(
  fs: DurableFilesystem,
  input: EditFileInput
): Promise<ToolResult> {
  const { path } = input

  // Normalize to an array of edits
  let edits: Array<{ old_str: string; new_str: string }>
  if (input.edits && input.edits.length > 0) {
    edits = input.edits
  } else if (input.old_str !== undefined && input.new_str !== undefined) {
    edits = [{ old_str: input.old_str, new_str: input.new_str }]
  } else {
    return {
      success: false,
      error: `Must provide either old_str/new_str or edits array`,
      errorType: `validation`,
    }
  }

  let currentContent = await fs.readTextFile(path)

  // Validate all edits first before applying any
  for (const edit of edits) {
    const occurrences = currentContent.split(edit.old_str).length - 1

    if (occurrences === 0) {
      return {
        success: false,
        error: `String not found in file: "${edit.old_str.slice(0, 50)}${edit.old_str.length > 50 ? `...` : ``}"`,
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
  }

  // Apply edits sequentially
  for (const edit of edits) {
    currentContent = currentContent.replace(edit.old_str, () => edit.new_str)
  }

  await fs.writeFile(path, currentContent)

  return { success: true, result: { edited: true, edits: edits.length } }
}

function handleListDirectory(
  fs: DurableFilesystem,
  input: ListDirectoryInput
): ToolResult {
  const entries = fs.list(input.path)
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

async function handleMkdir(
  fs: DurableFilesystem,
  input: MkdirInput
): Promise<ToolResult> {
  await fs.mkdir(input.path)
  return { success: true, result: { created: true } }
}

async function handleRmdir(
  fs: DurableFilesystem,
  input: RmdirInput
): Promise<ToolResult> {
  await fs.rmdir(input.path)
  return { success: true, result: { removed: true } }
}

function handleExists(fs: DurableFilesystem, input: ExistsInput): ToolResult {
  const exists = fs.exists(input.path)
  return { success: true, result: { exists } }
}

function handleStat(fs: DurableFilesystem, input: StatInput): ToolResult {
  const stat = fs.stat(input.path)
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

const ERROR_TYPE_MAP: Array<
  [new (...args: Array<never>) => Error, ToolResult[`errorType`]]
> = [
  [NotFoundError, `not_found`],
  [ExistsError, `exists`],
  [IsDirectoryError, `is_directory`],
  [NotDirectoryError, `not_directory`],
  [DirectoryNotEmptyError, `not_empty`],
  [PatchApplicationError, `conflict`],
]

function classifyError(err: unknown): ToolResult {
  if (err instanceof Error) {
    for (const [ErrorClass, errorType] of ERROR_TYPE_MAP) {
      if (err instanceof ErrorClass) {
        return { success: false, error: err.message, errorType }
      }
    }
    return { success: false, error: err.message, errorType: `unknown` }
  }

  return { success: false, error: String(err), errorType: `unknown` }
}
