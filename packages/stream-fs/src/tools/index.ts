/**
 * LLM Tools for Stream-FS
 *
 * Tool definitions and handlers for AI agents to interact with the filesystem.
 * Compatible with Claude, GPT, and other LLM tool calling interfaces.
 */

import type { DurableFilesystem } from "../durable-filesystem"
import {
  NotFoundError,
  AlreadyExistsError,
  DirectoryNotEmptyError,
  PatchApplicationError,
  TypeMismatchError,
} from "../types"

// =============================================================================
// Tool Definitions (for LLM function calling)
// =============================================================================

/**
 * Tool definition format compatible with Claude/OpenAI
 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<
      string,
      {
        type: string
        description: string
        enum?: string[]
      }
    >
    required: string[]
  }
}

/**
 * Read file tool
 */
export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read the contents of a text file",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file (e.g., /docs/notes.md)",
      },
    },
    required: ["path"],
  },
}

/**
 * List directory tool
 */
export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description:
    "List files and directories in a path. Returns name, type, and size for each entry.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the directory (e.g., /docs)",
      },
    },
    required: ["path"],
  },
}

/**
 * Create file tool
 */
export const createFileTool: ToolDefinition = {
  name: "create_file",
  description: "Create a new file with the given content",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path for the new file (e.g., /docs/new-file.md)",
      },
      content: {
        type: "string",
        description: "Initial content for the file",
      },
    },
    required: ["path", "content"],
  },
}

/**
 * Edit file tool (find and replace)
 */
export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "Edit a text file by replacing a unique string. The old_str must appear exactly once in the file.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to edit",
      },
      old_str: {
        type: "string",
        description:
          "Exact text to find and replace (must appear exactly once in the file)",
      },
      new_str: {
        type: "string",
        description: "Text to replace the old_str with",
      },
    },
    required: ["path", "old_str", "new_str"],
  },
}

/**
 * Write file tool (full replacement)
 */
export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Write content to an existing file, replacing its entire contents. Use edit_file for targeted changes.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "New content for the file",
      },
    },
    required: ["path", "content"],
  },
}

/**
 * Delete file tool
 */
export const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  description: "Delete a file",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to delete",
      },
    },
    required: ["path"],
  },
}

/**
 * Make directory tool
 */
export const mkdirTool: ToolDefinition = {
  name: "mkdir",
  description: "Create a new directory. Parent directory must exist.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path for the new directory",
      },
    },
    required: ["path"],
  },
}

/**
 * Remove directory tool
 */
export const rmdirTool: ToolDefinition = {
  name: "rmdir",
  description: "Remove an empty directory",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the directory to remove",
      },
    },
    required: ["path"],
  },
}

/**
 * File exists tool
 */
export const existsTool: ToolDefinition = {
  name: "exists",
  description: "Check if a file or directory exists at the given path",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to check",
      },
    },
    required: ["path"],
  },
}

/**
 * Stat tool
 */
export const statTool: ToolDefinition = {
  name: "stat",
  description:
    "Get metadata about a file or directory (type, size, timestamps)",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to get info about",
      },
    },
    required: ["path"],
  },
}

/**
 * All available tools
 */
export const allTools: ToolDefinition[] = [
  readFileTool,
  listDirectoryTool,
  createFileTool,
  editFileTool,
  writeFileTool,
  deleteFileTool,
  mkdirTool,
  rmdirTool,
  existsTool,
  statTool,
]

// =============================================================================
// Tool Result Types
// =============================================================================

export interface ToolSuccess<T = unknown> {
  success: true
  result: T
}

export interface ToolError {
  success: false
  error: string
  errorType?: string
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolError

// =============================================================================
// Tool Handlers
// =============================================================================

/**
 * Handle read_file tool call
 */
export async function handleReadFile(
  fs: DurableFilesystem,
  params: { path: string }
): Promise<ToolResult<{ content: string }>> {
  try {
    const content = await fs.readTextFile(params.path)
    return { success: true, result: { content } }
  } catch (err) {
    return formatError(err)
  }
}

/**
 * Handle list_directory tool call
 */
export async function handleListDirectory(
  fs: DurableFilesystem,
  params: { path: string }
): Promise<
  ToolResult<{
    entries: Array<{
      name: string
      type: "file" | "directory"
      size?: number
    }>
  }>
> {
  try {
    const entries = await fs.list(params.path)
    return {
      success: true,
      result: {
        entries: entries.map((e) => ({
          name: e.name,
          type: e.type,
          size: e.size,
        })),
      },
    }
  } catch (err) {
    return formatError(err)
  }
}

/**
 * Handle create_file tool call
 */
export async function handleCreateFile(
  fs: DurableFilesystem,
  params: { path: string; content: string }
): Promise<ToolResult<{ created: true }>> {
  try {
    await fs.createFile(params.path, params.content)
    return { success: true, result: { created: true } }
  } catch (err) {
    return formatError(err)
  }
}

/**
 * Handle edit_file tool call
 */
export async function handleEditFile(
  fs: DurableFilesystem,
  params: { path: string; old_str: string; new_str: string }
): Promise<ToolResult<{ edited: true }>> {
  const { path, old_str, new_str } = params

  try {
    // 1. Read current content
    const current = await fs.readTextFile(path)

    // 2. Validate uniqueness
    const occurrences = current.split(old_str).length - 1
    if (occurrences === 0) {
      return {
        success: false,
        error: `String not found in file: "${old_str.slice(0, 50)}${old_str.length > 50 ? "..." : ""}"`,
        errorType: "not_found",
      }
    }
    if (occurrences > 1) {
      return {
        success: false,
        error: `String appears ${occurrences} times in file, must be unique. Add more context to make the match unique.`,
        errorType: "ambiguous",
      }
    }

    // 3. Apply edit
    const newContent = current.replace(old_str, new_str)

    // 4. Write (this generates diff-match-patch internally)
    await fs.writeFile(path, newContent)
    return { success: true, result: { edited: true } }
  } catch (err) {
    if (err instanceof PatchApplicationError) {
      return {
        success: false,
        error: `Concurrent edit conflict: ${err.reason}. Try refreshing and re-reading the file.`,
        errorType: "conflict",
      }
    }
    return formatError(err)
  }
}

/**
 * Handle write_file tool call
 */
export async function handleWriteFile(
  fs: DurableFilesystem,
  params: { path: string; content: string }
): Promise<ToolResult<{ written: true }>> {
  try {
    await fs.writeFile(params.path, params.content)
    return { success: true, result: { written: true } }
  } catch (err) {
    return formatError(err)
  }
}

/**
 * Handle delete_file tool call
 */
export async function handleDeleteFile(
  fs: DurableFilesystem,
  params: { path: string }
): Promise<ToolResult<{ deleted: true }>> {
  try {
    await fs.deleteFile(params.path)
    return { success: true, result: { deleted: true } }
  } catch (err) {
    return formatError(err)
  }
}

/**
 * Handle mkdir tool call
 */
export async function handleMkdir(
  fs: DurableFilesystem,
  params: { path: string }
): Promise<ToolResult<{ created: true }>> {
  try {
    await fs.mkdir(params.path)
    return { success: true, result: { created: true } }
  } catch (err) {
    return formatError(err)
  }
}

/**
 * Handle rmdir tool call
 */
export async function handleRmdir(
  fs: DurableFilesystem,
  params: { path: string }
): Promise<ToolResult<{ removed: true }>> {
  try {
    await fs.rmdir(params.path)
    return { success: true, result: { removed: true } }
  } catch (err) {
    return formatError(err)
  }
}

/**
 * Handle exists tool call
 */
export async function handleExists(
  fs: DurableFilesystem,
  params: { path: string }
): Promise<ToolResult<{ exists: boolean }>> {
  try {
    const exists = await fs.exists(params.path)
    return { success: true, result: { exists } }
  } catch (err) {
    return formatError(err)
  }
}

/**
 * Handle stat tool call
 */
export async function handleStat(
  fs: DurableFilesystem,
  params: { path: string }
): Promise<
  ToolResult<{
    type: "file" | "directory"
    size?: number
    createdAt: number
    updatedAt?: number
  }>
> {
  try {
    const stat = await fs.stat(params.path)
    return {
      success: true,
      result: {
        type: stat.type,
        size: stat.size,
        createdAt: stat.createdAt,
        updatedAt: stat.updatedAt,
      },
    }
  } catch (err) {
    return formatError(err)
  }
}

// =============================================================================
// Unified Tool Handler
// =============================================================================

/**
 * Handle any tool call by name
 */
export async function handleToolCall(
  fs: DurableFilesystem,
  toolName: string,
  params: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case "read_file":
      return handleReadFile(fs, params as { path: string })
    case "list_directory":
      return handleListDirectory(fs, params as { path: string })
    case "create_file":
      return handleCreateFile(fs, params as { path: string; content: string })
    case "edit_file":
      return handleEditFile(
        fs,
        params as { path: string; old_str: string; new_str: string }
      )
    case "write_file":
      return handleWriteFile(fs, params as { path: string; content: string })
    case "delete_file":
      return handleDeleteFile(fs, params as { path: string })
    case "mkdir":
      return handleMkdir(fs, params as { path: string })
    case "rmdir":
      return handleRmdir(fs, params as { path: string })
    case "exists":
      return handleExists(fs, params as { path: string })
    case "stat":
      return handleStat(fs, params as { path: string })
    default:
      return {
        success: false,
        error: `Unknown tool: ${toolName}`,
        errorType: "unknown_tool",
      }
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format an error for tool response
 */
function formatError(err: unknown): ToolError {
  if (err instanceof NotFoundError) {
    return {
      success: false,
      error: `Not found: ${err.path}`,
      errorType: "not_found",
    }
  }
  if (err instanceof AlreadyExistsError) {
    return {
      success: false,
      error: `Already exists: ${err.path}`,
      errorType: "already_exists",
    }
  }
  if (err instanceof DirectoryNotEmptyError) {
    return {
      success: false,
      error: `Directory not empty: ${err.path}`,
      errorType: "directory_not_empty",
    }
  }
  if (err instanceof PatchApplicationError) {
    return {
      success: false,
      error: `Patch failed: ${err.reason}`,
      errorType: "patch_failed",
    }
  }
  if (err instanceof TypeMismatchError) {
    return {
      success: false,
      error: `Type mismatch at ${err.path}: expected ${err.expected}, found ${err.actual}`,
      errorType: "type_mismatch",
    }
  }
  if (err instanceof Error) {
    return {
      success: false,
      error: err.message,
      errorType: "error",
    }
  }
  return {
    success: false,
    error: String(err),
    errorType: "unknown",
  }
}

// =============================================================================
// Claude API Helpers
// =============================================================================

/**
 * Convert tool definitions to Claude API format
 */
export function toClaudeTools(): Array<{
  name: string
  description: string
  input_schema: {
    type: "object"
    properties: Record<string, unknown>
    required: string[]
  }
}> {
  return allTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: tool.parameters.properties,
      required: tool.parameters.required,
    },
  }))
}

/**
 * Convert tool definitions to OpenAI API format
 */
export function toOpenAITools(): Array<{
  type: "function"
  function: {
    name: string
    description: string
    parameters: {
      type: "object"
      properties: Record<string, unknown>
      required: string[]
    }
  }
}> {
  return allTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: tool.parameters.properties,
        required: tool.parameters.required,
      },
    },
  }))
}
