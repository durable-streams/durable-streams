/**
 * Core types for the Effect-based durable streams server.
 */

/**
 * A single message in a stream.
 */
export interface StreamMessage {
  /** The raw bytes of the message */
  data: Uint8Array
  /** The offset after this message. Format: "<read-seq>_<byte-offset>" */
  offset: string
  /** Timestamp when the message was appended */
  timestamp: number
}

/**
 * Producer state for idempotent writes.
 */
export interface ProducerState {
  /** Current epoch for this producer */
  epoch: number
  /** Last sequence number received in this epoch */
  lastSeq: number
  /** Timestamp when this producer state was last updated */
  lastUpdated: number
}

/**
 * Stream metadata and data.
 */
export interface Stream {
  /** The stream URL path (key) */
  path: string
  /** Content type of the stream */
  contentType?: string
  /** Messages in the stream */
  messages: StreamMessage[]
  /** Current offset (next offset to write to) */
  currentOffset: string
  /** Last sequence number for writer coordination (Stream-Seq) */
  lastSeq?: string
  /** TTL in seconds */
  ttlSeconds?: number
  /** Absolute expiry time (ISO 8601) */
  expiresAt?: string
  /** Timestamp when the stream was created */
  createdAt: number
  /** Producer states for idempotent writes */
  producers: Map<string, ProducerState>
}

/**
 * Result of producer validation.
 */
export type ProducerValidationResult =
  | {
      status: "accepted"
      isNew: boolean
      producerId: string
      proposedState: ProducerState
    }
  | { status: "duplicate"; lastSeq: number }
  | { status: "stale_epoch"; currentEpoch: number }
  | { status: "invalid_epoch_seq" }
  | { status: "sequence_gap"; expectedSeq: number; receivedSeq: number }

/**
 * Options for creating a stream.
 */
export interface CreateStreamOptions {
  contentType?: string
  ttlSeconds?: number
  expiresAt?: string
  initialData?: Uint8Array
}

/**
 * Options for append operations.
 */
export interface AppendOptions {
  seq?: string
  contentType?: string
  producerId?: string
  producerEpoch?: number
  producerSeq?: number
}

/**
 * Result of an append operation.
 */
export interface AppendResult {
  message: StreamMessage | null
  producerResult?: ProducerValidationResult
}

/**
 * Server configuration options.
 */
export interface ServerConfig {
  /** Port to listen on. Default: 4437 */
  port: number
  /** Host to bind to. Default: "127.0.0.1" */
  host: string
  /** Default long-poll timeout in milliseconds. Default: 30000 */
  longPollTimeout: number
  /** Cursor interval in seconds. Default: 20 */
  cursorIntervalSeconds: number
  /** Cursor epoch timestamp */
  cursorEpoch: Date
}

/**
 * Initial offset for a new stream.
 */
export const INITIAL_OFFSET = "0000000000000000_0000000000000000"

/**
 * Protocol headers.
 */
export const Headers = {
  STREAM_NEXT_OFFSET: "stream-next-offset",
  STREAM_CURSOR: "stream-cursor",
  STREAM_UP_TO_DATE: "stream-up-to-date",
  STREAM_SEQ: "stream-seq",
  STREAM_TTL: "stream-ttl",
  STREAM_EXPIRES_AT: "stream-expires-at",
  PRODUCER_ID: "producer-id",
  PRODUCER_EPOCH: "producer-epoch",
  PRODUCER_SEQ: "producer-seq",
  PRODUCER_EXPECTED_SEQ: "producer-expected-seq",
  PRODUCER_RECEIVED_SEQ: "producer-received-seq",
} as const
