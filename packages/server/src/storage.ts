/**
 * Storage abstraction for durable streams.
 * Implemented by both in-memory (StreamStore) and persistent (FileBackedStreamStore) backends.
 */

import type { Stream, StreamMessage } from "./types"

/**
 * Options for creating a new stream.
 */
export interface CreateStreamOptions {
  /**
   * MIME type of the stream content.
   * Default: "application/octet-stream"
   *
   * Special handling for "application/json":
   * - Messages are validated as JSON fragments
   * - Responses wrap concatenated messages in array brackets
   */
  contentType?: string

  /**
   * Time-to-live in seconds, relative to stream creation time.
   * The stream will automatically expire `ttlSeconds` seconds after creation.
   *
   * Expiry time = createdAt + ttlSeconds
   *
   * Example: ttlSeconds: 3600 (stream expires 1 hour after creation)
   *
   * Note: Cannot be used together with `expiresAt` - they are mutually exclusive.
   * If both are specified, the server returns a 400 error.
   */
  ttlSeconds?: number

  /**
   * Absolute expiration timestamp (ISO 8601 format).
   * The stream will automatically expire at this specific time,
   * regardless of when it was created.
   *
   * Example: expiresAt: "2025-12-31T23:59:59Z"
   *
   * Note: Cannot be used together with `ttlSeconds` - they are mutually exclusive.
   * If both are specified, the server returns a 400 error.
   * Invalid timestamps are treated as expired (fail-closed).
   */
  expiresAt?: string

  /**
   * Optional initial data to write to the stream upon creation.
   * If provided, this data is appended immediately after stream creation.
   *
   * For JSON streams, this can be an empty array ([]) to create an empty stream.
   */
  initialData?: Uint8Array
}

/**
 * Options for appending data to a stream.
 */
export interface AppendOptions {
  /**
   * Sequence number for writer coordination.
   * Used to detect and prevent conflicting concurrent writes.
   *
   * If provided, the server checks that seq > lastSeq.
   * If seq <= lastSeq, the server returns a sequence conflict error.
   *
   * This enables optimistic concurrency control for multiple writers.
   */
  seq?: string

  /**
   * Content type for validation.
   * If provided, must match the stream's content type (normalized).
   * Mismatches result in a 400 error.
   *
   * This prevents accidentally appending data of the wrong type
   * (e.g., binary data to a JSON stream).
   */
  contentType?: string
}

/**
 * Result of reading messages from a stream.
 */
export interface ReadResult {
  /**
   * Messages read from the stream, starting after the requested offset.
   * Empty array if no new messages are available.
   */
  messages: Array<StreamMessage>

  /**
   * Indicates whether the reader is caught up with the stream.
   * Always true for current implementation (no pagination yet).
   */
  upToDate: boolean
}

/**
 * Result of waiting for new messages (long-poll).
 */
export interface WaitResult {
  /**
   * New messages that arrived during the wait.
   * Empty array if the wait timed out with no new messages.
   */
  messages: Array<StreamMessage>

  /**
   * Indicates whether the wait timed out.
   * - true: Wait timed out without new messages arriving
   * - false: New messages arrived before timeout
   */
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
