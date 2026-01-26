/**
 * Type definitions for the Effect-based Durable Streams client.
 */

import type { Effect, Stream } from "effect"

// =============================================================================
// Core Types
// =============================================================================

/**
 * Opaque offset string - clients MUST NOT interpret the format.
 */
export type Offset = string

/**
 * Live mode for streaming reads.
 * - false: Catch-up only, return immediately when up-to-date
 * - true: Auto-select live mode (long-poll or SSE based on content type)
 * - "long-poll": Use HTTP long-polling
 * - "sse": Use Server-Sent Events
 */
export type LiveMode = false | true | `long-poll` | `sse`

/**
 * Function that returns a value, optionally wrapped in Effect.
 */
export type DynamicValue<T> = T | (() => T) | (() => Effect.Effect<T>)

/**
 * Headers record with support for dynamic values.
 */
export type HeadersRecord = Record<string, DynamicValue<string> | undefined>

/**
 * Query parameters record with support for dynamic values.
 */
export type ParamsRecord = Record<string, DynamicValue<string> | undefined>

// =============================================================================
// Client Options
// =============================================================================

/**
 * Base options for stream operations.
 */
export interface BaseOptions {
  /**
   * Additional headers to include in requests.
   */
  readonly headers?: HeadersRecord

  /**
   * Additional query parameters to include in requests.
   */
  readonly params?: ParamsRecord
}

/**
 * Options for creating a stream.
 */
export interface CreateOptions extends BaseOptions {
  /**
   * Content type for the stream (e.g., "application/json", "application/octet-stream").
   */
  readonly contentType?: string

  /**
   * TTL in seconds from creation time.
   */
  readonly ttlSeconds?: number

  /**
   * Absolute expiry timestamp (ISO 8601).
   */
  readonly expiresAt?: string

  /**
   * Initial body to append on creation.
   */
  readonly body?: Uint8Array | string
}

/**
 * Options for appending to a stream.
 */
export interface AppendOptions extends BaseOptions {
  /**
   * Sequence number for writer coordination.
   */
  readonly seq?: string

  /**
   * Content type override for this append.
   */
  readonly contentType?: string
}

/**
 * Options for reading from a stream.
 */
export interface StreamOptions extends BaseOptions {
  /**
   * Starting offset (use "-1" for beginning).
   */
  readonly offset?: Offset

  /**
   * Live mode for real-time updates.
   */
  readonly live?: LiveMode

  /**
   * Parse responses as JSON.
   */
  readonly json?: boolean
}

/**
 * Options for the idempotent producer.
 */
export interface ProducerOptions extends BaseOptions {
  /**
   * Starting epoch (default 0).
   */
  readonly epoch?: number

  /**
   * Auto-claim epoch on 403 stale epoch response.
   */
  readonly autoClaim?: boolean

  /**
   * Maximum bytes per batch before sending.
   */
  readonly maxBatchBytes?: number

  /**
   * Maximum in-flight batches (pipelining).
   */
  readonly maxInFlight?: number

  /**
   * Milliseconds to wait before sending a partial batch.
   */
  readonly lingerMs?: number
}

// =============================================================================
// Result Types
// =============================================================================

/**
 * Result of creating a stream.
 */
export interface CreateResult {
  readonly offset: Offset
  readonly contentType?: string
}

/**
 * Result of HEAD request.
 */
export interface HeadResult {
  readonly exists: true
  readonly offset?: Offset
  readonly contentType?: string
  readonly etag?: string
  readonly cacheControl?: string
}

/**
 * Result of appending to a stream.
 */
export interface AppendResult {
  readonly offset: Offset
}

/**
 * Metadata for a chunk of data.
 */
export interface ChunkMeta {
  readonly offset: Offset
  readonly upToDate: boolean
  readonly cursor?: string
}

/**
 * A batch of items with metadata.
 */
export interface Batch<T> extends ChunkMeta {
  readonly items: ReadonlyArray<T>
}

/**
 * A chunk of bytes with metadata.
 */
export interface ByteChunk extends ChunkMeta {
  readonly data: Uint8Array
}

// =============================================================================
// Stream Session Types
// =============================================================================

/**
 * A read session for consuming stream data.
 */
export interface StreamSession<T = unknown> {
  /**
   * Current offset.
   */
  readonly offset: Effect.Effect<Offset>

  /**
   * Whether the session is up-to-date with the stream head.
   */
  readonly upToDate: Effect.Effect<boolean>

  /**
   * HTTP status from the initial response.
   */
  readonly status: number

  /**
   * Content type of the stream.
   */
  readonly contentType: string | undefined

  /**
   * Accumulate all bytes until up-to-date.
   */
  readonly body: () => Effect.Effect<Uint8Array>

  /**
   * Accumulate all text until up-to-date.
   */
  readonly text: () => Effect.Effect<string>

  /**
   * Accumulate all JSON items until up-to-date.
   */
  readonly json: () => Effect.Effect<ReadonlyArray<T>>

  /**
   * Stream of byte chunks.
   */
  readonly bodyStream: () => Stream.Stream<ByteChunk>

  /**
   * Stream of text chunks.
   */
  readonly textStream: () => Stream.Stream<string>

  /**
   * Stream of parsed JSON items.
   */
  readonly jsonStream: () => Stream.Stream<T>

  /**
   * Stream of JSON batches with metadata.
   */
  readonly jsonBatches: () => Stream.Stream<Batch<T>>

  /**
   * Cancel the session.
   */
  readonly cancel: () => Effect.Effect<void>
}

// =============================================================================
// HTTP Constants
// =============================================================================

/**
 * HTTP header names used by the protocol.
 */
export const Headers = {
  // Response headers
  StreamOffset: `Stream-Next-Offset`,
  StreamCursor: `Stream-Cursor`,
  StreamUpToDate: `Stream-Up-To-Date`,

  // Request headers
  StreamSeq: `Stream-Seq`,
  StreamTtl: `Stream-TTL`,
  StreamExpiresAt: `Stream-Expires-At`,

  // Producer headers
  ProducerId: `Producer-Id`,
  ProducerEpoch: `Producer-Epoch`,
  ProducerSeq: `Producer-Seq`,
  ProducerExpectedSeq: `Producer-Expected-Seq`,
  ProducerReceivedSeq: `Producer-Received-Seq`,
} as const

/**
 * Query parameter names used by the protocol.
 */
export const QueryParams = {
  Offset: `offset`,
  Live: `live`,
  Cursor: `cursor`,
} as const

/**
 * SSE control event field names (camelCase per protocol).
 */
export const SSEFields = {
  Offset: `streamNextOffset`,
  Cursor: `streamCursor`,
} as const
