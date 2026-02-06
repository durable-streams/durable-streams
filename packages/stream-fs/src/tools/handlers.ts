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
import type { StreamFilesystem } from "../filesystem"
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
  offset?: number
  limit?: number
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

export interface AppendFileInput {
  path: string
  content: string
}

export interface MoveInput {
  source: string
  destination: string
}

export interface CopyInput {
  source: string
  destination: string
}

export interface TreeInput {
  path?: string
  depth?: number
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
  | AppendFileInput
  | MoveInput
  | CopyInput
  | TreeInput

export async function handleTool(
  fs: StreamFilesystem,
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
      case `append_file`:
        return await handleAppendFile(fs, input as AppendFileInput)
      case `move`:
        return await handleMove(fs, input as MoveInput)
      case `copy`:
        return await handleCopy(fs, input as CopyInput)
      case `tree`:
        return handleTree(fs, input as TreeInput)
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
  fs: StreamFilesystem,
  input: ReadFileInput
): Promise<ToolResult> {
  const fullContent = await fs.readTextFile(input.path)
  const lines = fullContent.split(`\n`)
  const totalLines = lines.length
  const offset = input.offset ?? 0
  const limit = input.limit

  const sliced =
    limit !== undefined
      ? lines.slice(offset, offset + limit)
      : lines.slice(offset)
  const content = sliced.join(`\n`)
  const linesRead = sliced.length
  const hasMore = offset + linesRead < totalLines

  return {
    success: true,
    result: {
      content,
      offset,
      lines_read: linesRead,
      total_lines: totalLines,
      has_more: hasMore,
    },
  }
}

async function handleWriteFile(
  fs: StreamFilesystem,
  input: WriteFileInput
): Promise<ToolResult> {
  await fs.writeFile(input.path, input.content)
  return { success: true, result: { written: true } }
}

async function handleCreateFile(
  fs: StreamFilesystem,
  input: CreateFileInput
): Promise<ToolResult> {
  await fs.createFile(input.path, input.content, {
    mimeType: input.mime_type,
  })
  return { success: true, result: { created: true } }
}

async function handleDeleteFile(
  fs: StreamFilesystem,
  input: DeleteFileInput
): Promise<ToolResult> {
  await fs.deleteFile(input.path)
  return { success: true, result: { deleted: true } }
}

async function handleEditFile(
  fs: StreamFilesystem,
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
      error: `Must provide either old_str/new_str or edits array. Example: {"path": "/file.txt", "old_str": "text to find", "new_str": "replacement text"} or {"path": "/file.txt", "edits": [{"old_str": "find this", "new_str": "replace with"}]}`,
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
  fs: StreamFilesystem,
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
  fs: StreamFilesystem,
  input: MkdirInput
): Promise<ToolResult> {
  await fs.mkdir(input.path)
  return { success: true, result: { created: true } }
}

async function handleRmdir(
  fs: StreamFilesystem,
  input: RmdirInput
): Promise<ToolResult> {
  await fs.rmdir(input.path)
  return { success: true, result: { removed: true } }
}

function handleExists(fs: StreamFilesystem, input: ExistsInput): ToolResult {
  const exists = fs.exists(input.path)
  return { success: true, result: { exists } }
}

function handleStat(fs: StreamFilesystem, input: StatInput): ToolResult {
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

async function handleAppendFile(
  fs: StreamFilesystem,
  input: AppendFileInput
): Promise<ToolResult> {
  const existing = await fs.readTextFile(input.path)
  const separator = existing.length > 0 && !existing.endsWith(`\n`) ? `\n` : ``
  await fs.writeFile(input.path, existing + separator + input.content)
  return { success: true, result: { appended: true } }
}

async function handleMove(
  fs: StreamFilesystem,
  input: MoveInput
): Promise<ToolResult> {
  await fs.move(input.source, input.destination)
  return { success: true, result: { moved: true } }
}

async function handleCopy(
  fs: StreamFilesystem,
  input: CopyInput
): Promise<ToolResult> {
  const content = await fs.readTextFile(input.source)
  const stat = fs.stat(input.source)
  await fs.createFile(input.destination, content, {
    mimeType: stat.mimeType,
  })
  return { success: true, result: { copied: true } }
}

function handleTree(fs: StreamFilesystem, input: TreeInput): ToolResult {
  const rootPath = input.path ?? `/`
  const maxDepth = input.depth

  const entries: Array<{ path: string; type: string; size: number }> = []

  function walk(dirPath: string, currentDepth: number): void {
    const children = fs.list(dirPath)
    for (const child of children) {
      const childPath =
        dirPath === `/` ? `/${child.name}` : `${dirPath}/${child.name}`
      entries.push({
        path: childPath,
        type: child.type,
        size: child.size,
      })
      if (
        child.type === `directory` &&
        (maxDepth === undefined || currentDepth < maxDepth)
      ) {
        walk(childPath, currentDepth + 1)
      }
    }
  }

  walk(rootPath, 1)
  entries.sort((a, b) => a.path.localeCompare(b.path))

  return { success: true, result: { entries } }
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
