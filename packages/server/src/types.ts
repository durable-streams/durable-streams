/**
 * Types for the in-memory durable streams test server.
 */

/**
 * A single message in a stream.
 */
export interface StreamMessage {
  /**
   * The raw bytes of the message.
   */
  data: Uint8Array

  /**
   * The offset after this message.
   * Format: "<read-seq>_<byte-offset>"
   */
  offset: string

  /**
   * Timestamp when the message was appended.
   */
  timestamp: number
}

/**
 * Stream metadata and data.
 */
export interface Stream {
  /**
   * The stream URL path (key).
   */
  path: string

  /**
   * Content type of the stream.
   */
  contentType?: string

  /**
   * Messages in the stream.
   */
  messages: Array<StreamMessage>

  /**
   * Current offset (next offset to write to).
   */
  currentOffset: string

  /**
   * Last sequence number for writer coordination.
   */
  lastSeq?: string

  /**
   * TTL in seconds.
   */
  ttlSeconds?: number

  /**
   * Absolute expiry time (ISO 8601).
   */
  expiresAt?: string

  /**
   * Timestamp when the stream was created.
   */
  createdAt: number
}

/**
 * Event data for stream lifecycle hooks.
 */
export interface StreamLifecycleEvent {
  /**
   * Type of event.
   */
  type: `created` | `deleted`

  /**
   * Stream path.
   */
  path: string

  /**
   * Content type (only for 'created' events).
   */
  contentType?: string

  /**
   * Timestamp of the event.
   */
  timestamp: number
}

/**
 * Hook function called when a stream is created or deleted.
 */
export type StreamLifecycleHook = (
  event: StreamLifecycleEvent
) => void | Promise<void>

/**
 * Options for creating the test server.
 */
export interface TestServerOptions {
  /**
   * Port to listen on. Default: 0 (auto-assign).
   */
  port?: number

  /**
   * Host to bind to. Default: "127.0.0.1".
   */
  host?: string

  /**
   * Default long-poll timeout in milliseconds.
   * Default: 30000 (30 seconds).
   */
  longPollTimeout?: number

  /**
   * Data directory for file-backed storage.
   * If provided, enables file-backed mode using LMDB and append-only logs.
   * If omitted, uses in-memory storage.
   */
  dataDir?: string

  /**
   * Hook called when a stream is created.
   */
  onStreamCreated?: StreamLifecycleHook

  /**
   * Hook called when a stream is deleted.
   */
  onStreamDeleted?: StreamLifecycleHook

  /**
   * Enable gzip/deflate compression for responses.
   * Default: true.
   */
  compression?: boolean
}

/**
 * Pending long-poll request.
 */
export interface PendingLongPoll {
  /**
   * Stream path.
   */
  path: string

  /**
   * Offset to wait for.
   */
  offset: string

  /**
   * Resolve function.
   */
  resolve: (messages: Array<StreamMessage>) => void

  /**
   * Timeout ID.
   */
  timeoutId: ReturnType<typeof setTimeout>
}
