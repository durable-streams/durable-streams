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

  /**
   * Producer states for idempotent writes.
   * Maps producer ID to their epoch and sequence state.
   */
  producers?: Map<string, ProducerState>

  /**
   * Whether the stream is closed (no further appends permitted).
   * Once set to true, this is permanent and durable.
   */
  closed?: boolean

  /**
   * The producer tuple that closed this stream (for idempotent close).
   * If set, duplicate close requests with this tuple return 204.
   */
  closedBy?: {
    producerId: string
    epoch: number
    seq: number
  }
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

  /**
   * Interval in seconds for cursor calculation.
   * Used for CDN cache collapsing to prevent infinite cache loops.
   * Default: 20 seconds.
   */
  cursorIntervalSeconds?: number

  /**
   * Epoch timestamp for cursor interval calculation.
   * Default: October 9, 2024 00:00:00 UTC.
   */
  cursorEpoch?: Date
}

/**
 * Producer state for idempotent writes.
 * Tracks epoch and sequence number per producer ID for deduplication.
 */
export interface ProducerState {
  /**
   * Current epoch for this producer.
   * Client-declared, server-validated monotonically increasing.
   */
  epoch: number

  /**
   * Last sequence number received in this epoch.
   */
  lastSeq: number

  /**
   * Timestamp when this producer state was last updated.
   * Used for TTL-based cleanup.
   */
  lastUpdated: number
}

/**
 * Result of producer validation for append operations.
 * For 'accepted' status, includes proposedState to commit after successful append.
 */
export type ProducerValidationResult =
  | {
      status: `accepted`
      isNew: boolean
      /** State to commit after successful append (deferred mutation) */
      proposedState: ProducerState
      producerId: string
    }
  | { status: `duplicate`; lastSeq: number }
  | { status: `stale_epoch`; currentEpoch: number }
  | { status: `invalid_epoch_seq` }
  | { status: `sequence_gap`; expectedSeq: number; receivedSeq: number }
  | { status: `stream_closed` }

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

export type MaybePromise<T> = T | Promise<T>

export interface AppendOptions {
  seq?: string
  contentType?: string
  producerId?: string
  producerEpoch?: number
  producerSeq?: number
  close?: boolean
}

export interface AppendResult {
  message: StreamMessage | null
  producerResult?: ProducerValidationResult
  streamClosed?: boolean
}

export interface DurableStreamStore {
  has: (path: string) => MaybePromise<boolean>
  create: (
    path: string,
    options: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
      initialData?: Uint8Array
      closed?: boolean
    }
  ) => MaybePromise<Stream>
  get: (path: string) => MaybePromise<Stream | undefined>
  read: (
    path: string,
    offset?: string
  ) => MaybePromise<{ messages: Array<StreamMessage>; upToDate: boolean }>
  formatResponse: (
    path: string,
    messages: Array<StreamMessage>
  ) => MaybePromise<Uint8Array>
  waitForMessages: (
    path: string,
    offset: string,
    timeoutMs: number
  ) => Promise<{
    messages: Array<StreamMessage>
    timedOut: boolean
    streamClosed?: boolean
  }>
  append: (
    path: string,
    data: Uint8Array,
    options?: AppendOptions
  ) => MaybePromise<StreamMessage | AppendResult>
  appendWithProducer: (
    path: string,
    data: Uint8Array,
    options: AppendOptions
  ) => Promise<AppendResult>
  closeStream: (
    path: string
  ) => MaybePromise<{ finalOffset: string; alreadyClosed: boolean } | null>
  closeStreamWithProducer: (
    path: string,
    options: {
      producerId: string
      producerEpoch: number
      producerSeq: number
    }
  ) => Promise<{
    finalOffset: string
    alreadyClosed: boolean
    producerResult?: ProducerValidationResult
  } | null>
  delete: (path: string) => MaybePromise<boolean>
  clear: () => MaybePromise<void>
  cancelAllWaits: () => MaybePromise<void>
  getCurrentOffset: (path: string) => MaybePromise<string | undefined>
  list: () => MaybePromise<Array<string>>
}
