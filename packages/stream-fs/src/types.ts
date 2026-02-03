/**
 * Stream-FS Types
 *
 * Type definitions for the durable filesystem abstraction.
 */

import type { DurableStream } from "@durable-streams/client"

// =============================================================================
// Core Types
// =============================================================================

/**
 * Content type for files
 */
export type ContentType = "text" | "binary"

/**
 * File metadata stored in the metadata stream
 */
export interface FileMetadata {
  /** Absolute path (primary key), e.g., "/docs/notes.md" */
  path: string
  /** ID of the content stream for this file */
  contentStreamId: string
  /** Whether this is a text or binary file */
  contentType: ContentType
  /** MIME type, e.g., "text/markdown", "application/pdf" */
  mimeType?: string
  /** Current file size in bytes */
  size: number
  /** Creation timestamp (ms since epoch) */
  createdAt: number
  /** Last update timestamp (ms since epoch) */
  updatedAt: number
}

/**
 * Directory metadata stored in the metadata stream
 */
export interface DirectoryMetadata {
  /** Absolute path (primary key), e.g., "/docs" */
  path: string
  /** Creation timestamp (ms since epoch) */
  createdAt: number
}

/**
 * Entry returned from list()
 */
export interface Entry {
  /** Just the name, not full path */
  name: string
  /** Full path */
  path: string
  /** Entry type */
  type: "file" | "directory"
  /** Size in bytes (files only) */
  size?: number
  /** Content type (files only) */
  contentType?: ContentType
  /** MIME type (files only) */
  mimeType?: string
}

/**
 * Stat result
 */
export interface Stat {
  path: string
  type: "file" | "directory"
  size?: number
  contentType?: ContentType
  mimeType?: string
  createdAt: number
  updatedAt?: number
}

// =============================================================================
// Content Stream Types
// =============================================================================

/**
 * Text file content (stored in content stream)
 */
export interface TextFileContent {
  /** Same as contentStreamId */
  id: string
  /** Current full content */
  content: string
}

/**
 * Text file patch (for patch operations)
 */
export interface TextFilePatch {
  /** Same as contentStreamId */
  id: string
  /** diff-match-patch format */
  patch: string
  /** SHA-256 checksum of content after patch (for validation) */
  checksum?: string
}

/**
 * Binary file content (stored in content stream)
 */
export interface BinaryFileContent {
  /** Same as contentStreamId */
  id: string
  /** Current full content as base64 */
  content: string
}

/**
 * Binary file delta (for patch operations)
 */
export interface BinaryFileDelta {
  /** Same as contentStreamId */
  id: string
  /** xdelta3 delta as base64 */
  delta: string
  /** SHA-256 checksum of content after delta (for validation) */
  checksum?: string
}

/**
 * Union of content event value types
 */
export type ContentValue =
  | TextFileContent
  | TextFilePatch
  | BinaryFileContent
  | BinaryFileDelta

// =============================================================================
// Event Types (for change events in streams)
// =============================================================================

/**
 * Metadata event types
 */
export type MetadataEventType =
  | "file_created"
  | "file_updated"
  | "file_deleted"
  | "directory_created"
  | "directory_deleted"

/**
 * Metadata event payload
 */
export interface MetadataEvent {
  type: MetadataEventType
  path: string
  metadata?: FileMetadata | DirectoryMetadata
  timestamp: number
}

/**
 * Content event types
 */
export type ContentEventType =
  | "init"
  | "text_patch"
  | "binary_delta"
  | "full_replace"

/**
 * Content event payload
 */
export interface ContentEvent {
  type: ContentEventType
  contentStreamId: string
  timestamp: number
}

// =============================================================================
// Stream Factory Interface
// =============================================================================

/**
 * Factory for creating and managing streams.
 * Abstracts the underlying stream transport for testability.
 */
export interface StreamFactory {
  /**
   * Get an existing stream by ID
   */
  getStream(id: string): DurableStream

  /**
   * Create a new stream
   */
  createStream(id: string, options?: CreateStreamOptions): Promise<DurableStream>

  /**
   * Delete a stream
   */
  deleteStream(id: string): Promise<void>
}

/**
 * Options for creating a stream
 */
export interface CreateStreamOptions {
  contentType?: string
}

/**
 * Options for creating a file
 */
export interface CreateFileOptions {
  /** MIME type override */
  mimeType?: string
  /** Force content type (otherwise auto-detected) */
  contentType?: ContentType
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Base error class for stream-fs errors
 */
export class StreamFSError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StreamFSError"
  }
}

/**
 * Error thrown when a file or directory is not found
 */
export class NotFoundError extends StreamFSError {
  constructor(
    public readonly path: string,
    message?: string
  ) {
    super(message ?? `Not found: ${path}`)
    this.name = "NotFoundError"
  }
}

/**
 * Error thrown when a file already exists
 */
export class AlreadyExistsError extends StreamFSError {
  constructor(
    public readonly path: string,
    message?: string
  ) {
    super(message ?? `Already exists: ${path}`)
    this.name = "AlreadyExistsError"
  }
}

/**
 * Error thrown when a directory is not empty
 */
export class DirectoryNotEmptyError extends StreamFSError {
  constructor(
    public readonly path: string,
    message?: string
  ) {
    super(message ?? `Directory not empty: ${path}`)
    this.name = "DirectoryNotEmptyError"
  }
}

/**
 * Error thrown when a patch cannot be applied
 */
export class PatchApplicationError extends StreamFSError {
  constructor(
    public readonly path: string,
    public readonly reason: string,
    message?: string
  ) {
    super(message ?? `Patch application failed for ${path}: ${reason}`)
    this.name = "PatchApplicationError"
  }
}

/**
 * Error thrown when trying to write to a directory or read a directory as file
 */
export class TypeMismatchError extends StreamFSError {
  constructor(
    public readonly path: string,
    public readonly expected: "file" | "directory",
    public readonly actual: "file" | "directory",
    message?: string
  ) {
    super(message ?? `Expected ${expected} at ${path}, found ${actual}`)
    this.name = "TypeMismatchError"
  }
}
