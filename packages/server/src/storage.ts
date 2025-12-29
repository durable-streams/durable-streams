/**
 * Storage abstraction for durable streams.
 * Implemented by both in-memory (StreamStore) and persistent (FileBackedStreamStore) backends.
 */

import type { Stream, StreamMessage } from "./types"

/**
 * Options for creating a new stream.
 */
export interface CreateStreamOptions {
  contentType?: string
  ttlSeconds?: number
  expiresAt?: string
  initialData?: Uint8Array
}

/**
 * Options for appending data to a stream.
 */
export interface AppendOptions {
  seq?: string
  contentType?: string
}

/**
 * Result of reading messages from a stream.
 */
export interface ReadResult {
  messages: Array<StreamMessage>
  upToDate: boolean
}

/**
 * Result of waiting for new messages (long-poll).
 */
export interface WaitResult {
  messages: Array<StreamMessage>
  timedOut: boolean
}

/**
 * Abstract storage interface for durable streams.
 *
 * This interface defines the contract that all storage backends must implement.
 * It supports both synchronous (in-memory) and asynchronous (file-backed) implementations
 * through the use of `Promise<T> | T` return types for methods that may be async.
 *
 * Implementations:
 * - `StreamStore` - In-memory storage (synchronous)
 * - `FileBackedStreamStore` - File-backed persistent storage with LMDB (asynchronous)
 */
export interface StreamStorage {
  /**
   * Create a new stream.
   *
   * @param path - Stream path (URL path component)
   * @param options - Creation options (content type, TTL, initial data)
   * @returns The created stream (or existing stream if idempotent)
   * @throws Error if stream already exists with different configuration
   */
  create: (
    path: string,
    options?: CreateStreamOptions
  ) => Stream | Promise<Stream>

  /**
   * Get a stream by path.
   *
   * @param path - Stream path
   * @returns Stream metadata, or undefined if not found
   */
  get: (path: string) => Stream | undefined

  /**
   * Check if a stream exists.
   *
   * @param path - Stream path
   * @returns true if stream exists, false otherwise
   */
  has: (path: string) => boolean

  /**
   * Delete a stream.
   *
   * @param path - Stream path
   * @returns true if stream was deleted, false if not found
   */
  delete: (path: string) => boolean

  /**
   * Append data to a stream.
   *
   * @param path - Stream path
   * @param data - Data to append
   * @param options - Append options (sequence number, content type)
   * @returns The appended message, or null for empty initial arrays
   * @throws Error if stream not found, sequence conflict, or content-type mismatch
   */
  append: (
    path: string,
    data: Uint8Array,
    options?: AppendOptions
  ) => StreamMessage | null | Promise<StreamMessage | null>

  /**
   * Read messages from a stream starting at an offset.
   *
   * @param path - Stream path
   * @param offset - Optional starting offset (exclusive). If omitted, reads from beginning.
   * @returns Read result with messages and up-to-date flag
   * @throws Error if stream not found or offset is invalid
   */
  read: (path: string, offset?: string) => ReadResult

  /**
   * Clear all streams from storage.
   */
  clear: () => void

  /**
   * List all stream paths.
   *
   * @returns Array of stream paths
   */
  list: () => Array<string>
}
