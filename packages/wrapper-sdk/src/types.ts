/**
 * Core type definitions for @durable-streams/wrapper-sdk.
 */

// Import and re-export auth types from client for convenience
import type {
  Auth as AuthType,
  HeadersRecord as HeadersRecordType,
  Offset as OffsetType,
} from "@durable-streams/client"

export type Auth = AuthType
export type HeadersRecord = HeadersRecordType
export type Offset = OffsetType

/**
 * Key-value state storage interface.
 *
 * Implementations:
 * - InMemoryStorage: For development and testing
 * - (Future) DurableObjectStorage: For Cloudflare Workers production
 * - Custom: User-provided implementations
 */
export interface Storage {
  /**
   * Get a value by key.
   *
   * @param key - The storage key
   * @returns The value or undefined if not found
   */
  get: <T = unknown>(key: string) => Promise<T | undefined>

  /**
   * Set a value by key.
   *
   * @param key - The storage key
   * @param value - The value to store (must be JSON-serializable)
   */
  set: (key: string, value: unknown) => Promise<void>

  /**
   * Delete a value by key.
   *
   * @param key - The storage key
   */
  delete: (key: string) => Promise<void>

  /**
   * List all key-value pairs matching an optional prefix.
   *
   * @param prefix - Optional key prefix filter
   * @returns AsyncIterable of [key, value] tuples
   */
  list: (prefix?: string) => AsyncIterable<[string, unknown]>
}

/**
 * A handle to a durable stream with high-level operations.
 */
export interface Stream {
  /**
   * The stream's URL path (e.g., '/v1/stream/sessions/123').
   */
  readonly id: string

  /**
   * The full stream URL.
   */
  readonly url: string

  /**
   * The stream's content type.
   */
  readonly contentType: string | undefined

  /**
   * Read stream data starting from an offset.
   * Yields Uint8Array chunks without buffering the entire stream.
   *
   * Essential for compaction use cases where you need to process
   * large streams without loading them entirely into memory.
   *
   * @param offset - Starting offset (omit for beginning, or a previously returned offset)
   * @returns AsyncIterable of data chunks
   *
   * @example
   * ```typescript
   * // Read all updates for Yjs compaction
   * const doc = new Y.Doc()
   * for await (const chunk of stream.readFromOffset()) {
   *   Y.applyUpdate(doc, chunk)
   * }
   * const compacted = Y.encodeStateAsUpdate(doc)
   * ```
   */
  readFromOffset: (offset?: string) => AsyncIterable<Uint8Array>

  /**
   * Get stream metadata for introspection and compaction decisions.
   *
   * @returns Stream metadata including tail offset
   *
   * @example
   * ```typescript
   * const meta = await stream.getMetadata()
   * if (shouldCompact(meta.tailOffset)) {
   *   await this.compactStream(stream)
   * }
   * ```
   */
  getMetadata: () => Promise<StreamMetadata>

  /**
   * Append data to the stream.
   *
   * @param data - Data to append (Uint8Array or string)
   * @param options - Optional append options (seq for ordering)
   *
   * @example
   * ```typescript
   * await stream.append(JSON.stringify({ event: 'user.created' }))
   * ```
   */
  append: (
    data: Uint8Array | string,
    options?: StreamAppendOptions
  ) => Promise<void>
}

/**
 * Stream metadata for introspection.
 */
export interface StreamMetadata {
  /**
   * The stream's content type.
   */
  contentType: string | undefined

  /**
   * When the stream was created (if available).
   */
  createdAt: Date | null

  /**
   * Time-to-live in seconds (if set).
   */
  ttlSeconds: number | null

  /**
   * Absolute expiry time (if set).
   */
  expiresAt: Date | null

  /**
   * The tail offset (position after last byte).
   * Useful for compaction heuristics.
   */
  tailOffset: string

  /**
   * When data was last appended (if tracked).
   */
  lastAppendedAt: Date | null
}

/**
 * Options for stream append operations.
 */
export interface StreamAppendOptions {
  /**
   * Writer sequence for coordination.
   * If provided and lower than last seq, returns 409 Conflict.
   */
  seq?: string
}

/**
 * Options for creating a new stream.
 */
export interface CreateStreamOptions {
  /**
   * The stream URL path (appended to baseUrl).
   *
   * @example '/v1/stream/sessions/abc123'
   */
  url: string

  /**
   * Content type for the stream.
   *
   * @default 'application/octet-stream'
   */
  contentType?: string

  /**
   * Time-to-live in seconds.
   * Cannot be used with expiresAt.
   */
  ttlSeconds?: number

  /**
   * Absolute expiry time (RFC3339 format).
   * Cannot be used with ttlSeconds.
   */
  expiresAt?: string

  /**
   * Initial data to write to the stream.
   */
  data?: Uint8Array | string
}

/**
 * Filter options for listing streams.
 */
export interface FilterOptions {
  /**
   * Only return streams whose ID starts with this prefix.
   */
  prefix?: string
}

/**
 * Stream management operations exposed as `this.sdk`.
 */
export interface WrapperSDK {
  /**
   * Create a new durable stream.
   *
   * @param options - Stream creation options
   * @returns The created stream handle
   *
   * @example
   * ```typescript
   * const stream = await this.sdk.createStream({
   *   url: '/v1/stream/my-stream',
   *   contentType: 'application/json',
   *   ttlSeconds: 3600,
   * })
   * ```
   */
  createStream: (options: CreateStreamOptions) => Promise<Stream>

  /**
   * Get an existing stream by its URL path.
   * Returns null if the stream does not exist.
   *
   * @param id - The stream URL path (e.g., '/v1/stream/my-stream')
   * @returns The stream handle or null
   */
  getStream: (id: string) => Promise<Stream | null>

  /**
   * Delete a stream and all its data.
   *
   * @param id - The stream URL path
   * @throws WrapperSDKError if stream does not exist
   */
  deleteStream: (id: string) => Promise<void>

  /**
   * List streams matching an optional filter.
   * Note: This uses local state tracking; not all streams may be listed
   * if they were created outside this SDK instance.
   *
   * @param filter - Optional filter criteria
   * @returns AsyncIterable of stream handles
   */
  listStreams: (filter?: FilterOptions) => AsyncIterable<Stream>
}

/**
 * Configuration options for WrapperProtocol.
 */
export interface WrapperProtocolOptions {
  /**
   * Base URL of the durable streams server.
   * Stream URLs are constructed as `${baseUrl}${streamPath}`.
   *
   * @example 'https://streams.example.com'
   */
  baseUrl: string

  /**
   * State storage implementation.
   * Defaults to InMemoryStorage if not provided.
   *
   * @example new InMemoryStorage()
   */
  storage?: Storage

  /**
   * Authentication configuration for stream operations.
   * Passed through to the underlying DurableStream client.
   */
  auth?: Auth

  /**
   * Additional headers for all stream requests.
   */
  headers?: HeadersRecord

  /**
   * Custom fetch implementation.
   */
  fetch?: typeof globalThis.fetch
}

/**
 * Internal hooks interface for SDK to call protocol lifecycle methods.
 */
export interface SDKHooks {
  onStreamCreated?: (stream: Stream, metadata?: unknown) => Promise<void>
  onMessageAppended?: (stream: Stream, data: Uint8Array) => Promise<void>
  onStreamDeleted?: (stream: Stream) => Promise<void>
}

/**
 * Tracked stream info stored in storage for listStreams().
 */
export interface TrackedStreamInfo {
  id: string
  url: string
  contentType?: string
  createdAt: string
}
