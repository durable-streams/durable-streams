/**
 * @durable-streams/stream-fs
 *
 * A shared filesystem for AI agents built on durable streams.
 *
 * @example
 * ```typescript
 * import { DurableFilesystem } from "@durable-streams/stream-fs"
 *
 * const fs = new DurableFilesystem({
 *   baseUrl: "http://localhost:8787",
 *   streamPrefix: "/fs/myproject",
 * })
 *
 * await fs.initialize()
 *
 * // Create and read files
 * await fs.createFile("/notes.md", "# My Notes\n\nHello, world!")
 * const content = await fs.readTextFile("/notes.md")
 *
 * // List directories
 * const entries = await fs.list("/")
 *
 * // Clean up
 * fs.close()
 * ```
 */

// ============================================================================
// Core Filesystem
// ============================================================================

export { DurableFilesystem } from "./filesystem"

// ============================================================================
// Types
// ============================================================================

export type {
  // Metadata types
  ContentType,
  EntryType,
  BaseMetadata,
  FileMetadata,
  DirectoryMetadata,
  Metadata,
  // Content event types
  ContentEvent,
  InitContentEvent,
  PatchContentEvent,
  ReplaceContentEvent,
  // Result types
  Stat,
  Entry,
  // Options
  CreateFileOptions,
  DurableFilesystemOptions,
} from "./types"

// Type guards
export {
  isFileMetadata,
  isDirectoryMetadata,
  isInitEvent,
  isPatchEvent,
  isReplaceEvent,
} from "./types"

// ============================================================================
// Errors
// ============================================================================

export {
  StreamFsError,
  NotFoundError,
  ExistsError,
  IsDirectoryError,
  NotDirectoryError,
  DirectoryNotEmptyError,
  PatchApplicationError,
  PreconditionFailedError,
} from "./types"

// ============================================================================
// Utilities
// ============================================================================

export {
  // Path utilities
  normalizePath,
  dirname,
  basename,
  joinPath,
  // Content utilities
  generateContentStreamId,
  calculateChecksum,
  createPatch,
  applyPatch,
  canApplyPatch,
  // MIME type detection
  detectMimeType,
  detectContentType,
  isTextContent,
  // Binary encoding
  encodeBase64,
  decodeBase64,
} from "./utils"

// ============================================================================
// LLM Tools
// ============================================================================

export {
  streamFsTools,
  isStreamFsTool,
  handleTool,
  type StreamFsToolName,
  type ToolResult,
  type ToolInput,
  type ReadFileInput,
  type WriteFileInput,
  type CreateFileInput,
  type DeleteFileInput,
  type EditFileInput,
  type ListDirectoryInput,
  type MkdirInput,
  type RmdirInput,
  type ExistsInput,
  type StatInput,
} from "./tools"
