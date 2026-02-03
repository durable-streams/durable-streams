/**
 * @durable-streams/stream-fs
 *
 * A shared filesystem abstraction for AI agents built on durable streams.
 */

// Main class and options
export { DurableFilesystem } from "./durable-filesystem"
export type { DurableFilesystemOptions } from "./durable-filesystem"

// Types
export type {
  ContentType,
  FileMetadata,
  DirectoryMetadata,
  Entry,
  Stat,
  StreamFactory,
  CreateStreamOptions,
  CreateFileOptions,
  TextFileContent,
  TextFilePatch,
  BinaryFileContent,
  BinaryFileDelta,
  ContentValue,
  MetadataEventType,
  MetadataEvent,
  ContentEventType,
  ContentEvent,
} from "./types"

// Errors
export {
  StreamFSError,
  NotFoundError,
  AlreadyExistsError,
  DirectoryNotEmptyError,
  PatchApplicationError,
  TypeMismatchError,
} from "./types"

// Schemas (for advanced usage)
export {
  fileMetadataSchema,
  directoryMetadataSchema,
  textContentSchema,
  textPatchSchema,
  binaryContentSchema,
  binaryDeltaSchema,
} from "./schemas"

// Stream factory implementations
export { InMemoryStreamFactory } from "./in-memory-stream-factory"
