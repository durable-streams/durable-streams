/**
 * Stream-FS Type Definitions
 *
 * Types for filesystem operations on top of durable streams.
 */

// ============================================================================
// Content Types
// ============================================================================

/**
 * Content type for files
 */
export type ContentType = `text` | `binary`

/**
 * Entry type (file or directory)
 */
export type EntryType = `file` | `directory`

// ============================================================================
// Metadata Types
// ============================================================================

/**
 * Base metadata for files and directories
 */
export interface BaseMetadata {
  /** Entry type */
  type: EntryType
  /** Creation timestamp (ISO 8601) */
  createdAt: string
  /** Last modification timestamp (ISO 8601) */
  modifiedAt: string
}

/**
 * File metadata stored in the metadata stream
 */
export interface FileMetadata extends BaseMetadata {
  type: `file`
  /** Content stream ID for this file */
  contentStreamId: string
  /** Content type (text or binary) */
  contentType: ContentType
  /** MIME type of the file */
  mimeType: string
  /** File size in bytes (updated on write) */
  size: number
}

/**
 * Directory metadata stored in the metadata stream
 */
export interface DirectoryMetadata extends BaseMetadata {
  type: `directory`
}

/**
 * Combined metadata type
 */
export type Metadata = FileMetadata | DirectoryMetadata

/**
 * Type guard for file metadata
 */
export function isFileMetadata(meta: Metadata): meta is FileMetadata {
  return meta.type === `file`
}

/**
 * Type guard for directory metadata
 */
export function isDirectoryMetadata(meta: Metadata): meta is DirectoryMetadata {
  return meta.type === `directory`
}

// ============================================================================
// Content Event Types
// ============================================================================

/**
 * Base content event with common fields
 */
interface BaseContentEvent {
  /** SHA-256 checksum of content after applying operation */
  checksum: string
}

/**
 * Initial content event - first event in a content stream
 */
export interface InitContentEvent extends BaseContentEvent {
  op: `init`
  /** Initial file content */
  content: string
}

/**
 * Patch content event - applies a diff-match-patch to existing content
 */
export interface PatchContentEvent extends BaseContentEvent {
  op: `patch`
  /** diff-match-patch format patch string */
  patch: string
}

/**
 * Replace content event - full content replacement
 * Used for binary files or when patch is too large
 */
export interface ReplaceContentEvent extends BaseContentEvent {
  op: `replace`
  /** New content (base64 encoded for binary) */
  content: string
  /** Encoding type (only present for binary) */
  encoding?: `base64`
}

/**
 * Union of all content event types
 */
export type ContentEvent =
  | InitContentEvent
  | PatchContentEvent
  | ReplaceContentEvent

/**
 * Type guards for content events
 */
export function isInitEvent(event: ContentEvent): event is InitContentEvent {
  return event.op === `init`
}

export function isPatchEvent(event: ContentEvent): event is PatchContentEvent {
  return event.op === `patch`
}

export function isReplaceEvent(
  event: ContentEvent
): event is ReplaceContentEvent {
  return event.op === `replace`
}

// ============================================================================
// Stat Result
// ============================================================================

/**
 * Result from stat() operation
 */
export interface Stat {
  /** Entry type */
  type: EntryType
  /** Size in bytes (0 for directories) */
  size: number
  /** Creation time (ISO 8601) */
  createdAt: string
  /** Modification time (ISO 8601) */
  modifiedAt: string
  /** MIME type (files only) */
  mimeType?: string
  /** Content type (files only) */
  contentType?: ContentType
}

// ============================================================================
// Directory Entry
// ============================================================================

/**
 * Entry in a directory listing
 */
export interface Entry {
  /** Entry name (not full path) */
  name: string
  /** Entry type */
  type: EntryType
  /** Size in bytes (0 for directories) */
  size: number
  /** Modification time (ISO 8601) */
  modifiedAt: string
}

// ============================================================================
// Options
// ============================================================================

/**
 * Options for creating a file
 */
export interface CreateFileOptions {
  /** MIME type (default: auto-detect or text/plain) */
  mimeType?: string
  /** Content type (default: auto-detect based on content) */
  contentType?: ContentType
}

/**
 * Options for DurableFilesystem constructor
 */
export interface DurableFilesystemOptions {
  /** Base URL for the durable streams server (e.g., "http://localhost:8787") */
  baseUrl: string
  /** Stream path prefix for this filesystem (e.g., "/fs/myproject") */
  streamPrefix: string
  /** Optional headers for authentication */
  headers?: Record<string, string>
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base error for Stream-FS operations
 */
export class StreamFsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = `StreamFsError`
  }
}

/**
 * Error thrown when a file or directory is not found
 */
export class NotFoundError extends StreamFsError {
  readonly path: string
  readonly code = `ENOENT`

  constructor(path: string) {
    super(`ENOENT: no such file or directory, '${path}'`)
    this.name = `NotFoundError`
    this.path = path
  }
}

/**
 * Error thrown when a file or directory already exists
 */
export class ExistsError extends StreamFsError {
  readonly path: string
  readonly code = `EEXIST`

  constructor(path: string) {
    super(`EEXIST: file already exists, '${path}'`)
    this.name = `ExistsError`
    this.path = path
  }
}

/**
 * Error thrown when trying to perform file operation on directory
 */
export class IsDirectoryError extends StreamFsError {
  readonly path: string
  readonly code = `EISDIR`

  constructor(path: string) {
    super(`EISDIR: illegal operation on a directory, '${path}'`)
    this.name = `IsDirectoryError`
    this.path = path
  }
}

/**
 * Error thrown when trying to perform directory operation on file
 */
export class NotDirectoryError extends StreamFsError {
  readonly path: string
  readonly code = `ENOTDIR`

  constructor(path: string) {
    super(`ENOTDIR: not a directory, '${path}'`)
    this.name = `NotDirectoryError`
    this.path = path
  }
}

/**
 * Error thrown when trying to remove non-empty directory
 */
export class DirectoryNotEmptyError extends StreamFsError {
  readonly path: string
  readonly code = `ENOTEMPTY`

  constructor(path: string) {
    super(`ENOTEMPTY: directory not empty, '${path}'`)
    this.name = `DirectoryNotEmptyError`
    this.path = path
  }
}

/**
 * Error thrown when patch application fails
 */
export class PatchApplicationError extends StreamFsError {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string, message?: string) {
    super(message ?? `Patch application failed for '${path}': ${reason}`)
    this.name = `PatchApplicationError`
    this.path = path
    this.reason = reason
  }
}

/**
 * Error thrown on precondition failure (OCC conflict)
 */
export class PreconditionFailedError extends StreamFsError {
  readonly path: string
  readonly code = `ECONFLICT`

  constructor(path: string, message?: string) {
    super(
      message ?? `Precondition failed: concurrent modification of '${path}'`
    )
    this.name = `PreconditionFailedError`
    this.path = path
  }
}
