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
}

/**
 * A pending batch waiting for earlier sequences to arrive.
 */
export interface PendingBatch {
  /**
   * The sequence number of this batch.
   */
  sequence: number

  /**
   * The data to write when sequence is ready.
   */
  data: Uint8Array

  /**
   * Content type of the batch.
   */
  contentType?: string

  /**
   * Timestamp when the batch was received.
   */
  receivedAt: number
}

/**
 * State for an idempotent producer.
 */
export interface ProducerState {
  /**
   * The unique producer identifier.
   */
  producerId: string

  /**
   * The stream this producer writes to.
   */
  streamPath: string

  /**
   * Current epoch for zombie fencing.
   * Increments when producer re-registers.
   */
  epoch: number

  /**
   * The highest committed sequence number.
   * -1 means no sequences have been committed yet.
   */
  lastSequence: number

  /**
   * Out-of-order batches waiting for earlier sequences.
   * Maximum 4 pending batches allowed.
   */
  pendingBatches: Array<PendingBatch>

  /**
   * Timestamp of last activity for expiration.
   */
  lastActivityAt: number
}

/**
 * Error codes for idempotent producer operations.
 */
export type IdempotentProducerErrorCode =
  | `DUPLICATE_SEQUENCE`
  | `OUT_OF_ORDER_SEQUENCE`
  | `PRODUCER_FENCED`
  | `UNKNOWN_PRODUCER`

/**
 * Error response for idempotent producer operations.
 */
export interface IdempotentProducerError {
  /**
   * The error code.
   */
  error: IdempotentProducerErrorCode

  /**
   * Human-readable error message.
   */
  message: string

  /**
   * Expected sequence number (for sequence errors).
   */
  expectedSequence?: number

  /**
   * Last committed sequence number (for sequence errors).
   */
  lastSequence?: number

  /**
   * Current epoch (for fencing errors).
   */
  currentEpoch?: number
}

/**
 * Result of an idempotent append operation.
 */
export interface IdempotentAppendResult {
  /**
   * Whether the operation was a success (including duplicate detection).
   */
  success: boolean

  /**
   * Whether this was a duplicate (already committed).
   */
  duplicate: boolean

  /**
   * The message that was written (or the existing message for duplicates).
   */
  message?: StreamMessage

  /**
   * The producer state after the operation.
   */
  producerState: ProducerState

  /**
   * Error details if operation failed.
   */
  error?: IdempotentProducerError

  /**
   * HTTP status code to return.
   */
  statusCode: number

  /**
   * Whether the batch was accepted but pending (202 Accepted).
   */
  pending?: boolean
}

/**
 * Options for idempotent append operations.
 */
export interface IdempotentAppendOptions {
  /**
   * Producer ID (or '?' to request new ID).
   */
  producerId: string

  /**
   * Producer epoch (or '?' to bump epoch).
   */
  producerEpoch: string | number

  /**
   * Sequence number for this batch.
   */
  sequence: number

  /**
   * Content type of the data.
   */
  contentType?: string
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
