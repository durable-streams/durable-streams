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

export { DurableFilesystem } from "./filesystem"

export type {
  ContentType,
  EntryType,
  BaseMetadata,
  FileMetadata,
  DirectoryMetadata,
  Metadata,
  ContentEvent,
  InitContentEvent,
  PatchContentEvent,
  ReplaceContentEvent,
  Stat,
  Entry,
  CreateFileOptions,
  DurableFilesystemOptions,
  WatchEventType,
  WatchEvent,
  WatchOptions,
  Watcher,
} from "./types"

export {
  isFileMetadata,
  isDirectoryMetadata,
  isInitEvent,
  isPatchEvent,
  isReplaceEvent,
} from "./types"

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

export {
  normalizePath,
  dirname,
  basename,
  joinPath,
  generateContentStreamId,
  calculateChecksum,
  createPatch,
  applyPatch,
  canApplyPatch,
  detectMimeType,
  detectContentType,
  isTextContent,
  encodeBase64,
  decodeBase64,
} from "./utils"

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
