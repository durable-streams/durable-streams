/**
 * Durable Streams TypeScript Client Types
 *
 * Following the Electric Durable Stream Protocol specification.
 */

import type { ReadableStreamAsyncIterable } from "./asyncIterableReadableStream"
import type { BackoffOptions } from "./fetch"

/**
 * Offset string - opaque to the client.
 * Format: "<read-seq>_<byte-offset>"
 *
 * **Special value**: `-1` means "start of stream" - use this to read from the beginning.
 *
 * Always use the returned `offset` field from reads/follows as the next `offset` you pass in.
 */
export type Offset = string

/**
 * Type for values that can be provided immediately or resolved asynchronously.
 */
export type MaybePromise<T> = T | Promise<T>

/**
 * Headers record where values can be static strings or async functions.
 * Following the @electric-sql/client pattern for dynamic headers.
 *
 * **Important**: Functions are called **for each request**, not once per session.
 * In live mode with long-polling, the same function may be called many times
 * to fetch fresh values (e.g., refreshed auth tokens) for each poll.
 *
 * @example
 * ```typescript
 * headers: {
 *   Authorization: `Bearer ${token}`,           // Static - same for all requests
 *   'X-Tenant-Id': () => getCurrentTenant(),    // Called per-request
 *   'X-Auth': async () => await refreshToken()  // Called per-request (can refresh)
 * }
 * ```
 */
export type HeadersRecord = {
  [key: string]: string | (() => MaybePromise<string>)
}

/**
 * Params record where values can be static or async functions.
 * Following the @electric-sql/client pattern for dynamic params.
 *
 * **Important**: Functions are called **for each request**, not once per session.
 * In live mode, the same function may be called multiple times to fetch
 * fresh parameter values for each poll.
 */
export type ParamsRecord = {
  [key: string]: string | (() => MaybePromise<string>) | undefined
}

// ============================================================================
// Live Mode Types
// ============================================================================

/**
 * Live mode for reading from a stream.
 * - false: Catch-up only, stop at first `upToDate`
 * - "auto": Behavior driven by consumption method (default)
 * - "long-poll": Explicit long-poll mode for live updates
 * - "sse": Explicit server-sent events for live updates
 */
export type LiveMode = false | `auto` | `long-poll` | `sse`

// ============================================================================
// Stream Options (Read API)
// ============================================================================

/**
 * Options for the stream() function (read-only API).
 */
export interface StreamOptions {
  /**
   * The full URL to the durable stream.
   * E.g., "https://streams.example.com/my-account/chat/room-1"
   */
  url: string | URL

  /**
   * HTTP headers to include in requests.
   * Values can be strings or functions (sync or async) that return strings.
   *
   * **Important**: Functions are evaluated **per-request** (not per-session).
   * In live mode, functions are called for each poll, allowing fresh values
   * like refreshed auth tokens.
   *
   * @example
   * ```typescript
   * headers: {
   *   Authorization: `Bearer ${token}`,           // Static
   *   'X-Tenant-Id': () => getCurrentTenant(),    // Evaluated per-request
   *   'X-Auth': async () => await refreshToken()  // Evaluated per-request
   * }
   * ```
   */
  headers?: HeadersRecord

  /**
   * Query parameters to include in requests.
   * Values can be strings or functions (sync or async) that return strings.
   *
   * **Important**: Functions are evaluated **per-request** (not per-session).
   */
  params?: ParamsRecord

  /**
   * AbortSignal for cancellation.
   */
  signal?: AbortSignal

  /**
   * Custom fetch implementation (for auth layers, proxies, etc.).
   * Defaults to globalThis.fetch.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Backoff options for retry behavior.
   * Defaults to exponential backoff with jitter.
   */
  backoffOptions?: BackoffOptions

  /**
   * Starting offset (query param ?offset=...).
   * If omitted, defaults to "-1" (start of stream).
   * You can also explicitly pass "-1" to read from the beginning.
   */
  offset?: Offset

  /**
   * Live mode behavior:
   * - false: Catch-up only, stop at first `upToDate`
   * - "auto" (default): Behavior driven by consumption method
   * - "long-poll": Explicit long-poll mode for live updates
   * - "sse": Explicit server-sent events for live updates
   */
  live?: LiveMode

  /**
   * Hint: treat content as JSON even if Content-Type doesn't say so.
   */
  json?: boolean

  /**
   * Error handler for recoverable errors (following Electric client pattern).
   */
  onError?: StreamErrorHandler

  /**
   * SSE resilience options.
   * When SSE connections fail repeatedly, the client can automatically
   * fall back to long-polling mode.
   */
  sseResilience?: SSEResilienceOptions

  /**
   * Whether to warn when using HTTP (not HTTPS) URLs in browser environments.
   * HTTP limits browsers to 6 concurrent connections (HTTP/1.1), which can
   * cause slow streams and app freezes with multiple active streams.
   *
   * @default true
   */
  warnOnHttp?: boolean
}

/**
 * Options for SSE connection resilience.
 */
export interface SSEResilienceOptions {
  /**
   * Minimum expected SSE connection duration in milliseconds.
   * Connections shorter than this are considered "short" and may indicate
   * proxy buffering or server misconfiguration.
   * @default 1000
   */
  minConnectionDuration?: number

  /**
   * Maximum number of consecutive short connections before falling back to long-poll.
   * @default 3
   */
  maxShortConnections?: number

  /**
   * Base delay for exponential backoff between short connection retries (ms).
   * @default 100
   */
  backoffBaseDelay?: number

  /**
   * Maximum delay cap for exponential backoff (ms).
   * @default 5000
   */
  backoffMaxDelay?: number

  /**
   * Whether to log warnings when falling back to long-poll.
   * @default true
   */
  logWarnings?: boolean
}

// ============================================================================
// Chunk & Batch Types
// ============================================================================

/**
 * Metadata for a JSON batch or chunk.
 */
export interface JsonBatchMeta {
  /**
   * Last Stream-Next-Offset for this batch.
   */
  offset: Offset

  /**
   * True if this batch ends at the current end of the stream.
   */
  upToDate: boolean

  /**
   * Last Stream-Cursor / streamCursor, if present.
   */
  cursor?: string
}

/**
 * A batch of parsed JSON items with metadata.
 */
export interface JsonBatch<T = unknown> extends JsonBatchMeta {
  /**
   * The parsed JSON items in this batch.
   */
  items: ReadonlyArray<T>
}

/**
 * A chunk of raw bytes with metadata.
 */
export interface ByteChunk extends JsonBatchMeta {
  /**
   * The raw byte data.
   */
  data: Uint8Array
}

/**
 * A chunk of text with metadata.
 */
export interface TextChunk extends JsonBatchMeta {
  /**
   * The text content.
   */
  text: string
}

// ============================================================================
// StreamHandle Options (Read/Write API)
// ============================================================================

/**
 * Base options for StreamHandle operations.
 */
export interface StreamHandleOptions {
  /**
   * The full URL to the durable stream.
   * E.g., "https://streams.example.com/my-account/chat/room-1"
   */
  url: string | URL

  /**
   * HTTP headers to include in requests.
   * Values can be strings or functions (sync or async) that return strings.
   *
   * Functions are evaluated **per-request** (not per-session).
   */
  headers?: HeadersRecord

  /**
   * Query parameters to include in requests.
   * Values can be strings or functions (sync or async) that return strings.
   *
   * Functions are evaluated **per-request** (not per-session).
   */
  params?: ParamsRecord

  /**
   * Custom fetch implementation.
   * Defaults to globalThis.fetch.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Default AbortSignal for operations.
   */
  signal?: AbortSignal

  /**
   * The content type for the stream.
   */
  contentType?: string

  /**
   * Error handler for recoverable errors.
   */
  onError?: StreamErrorHandler

  /**
   * Enable automatic batching for append() calls.
   * When true, multiple append() calls made while a POST is in-flight
   * will be batched together into a single request.
   *
   * @default true
   */
  batching?: boolean

  /**
   * Whether to warn when using HTTP (not HTTPS) URLs in browser environments.
   * HTTP limits browsers to 6 concurrent connections (HTTP/1.1), which can
   * cause slow streams and app freezes with multiple active streams.
   *
   * @default true
   */
  warnOnHttp?: boolean
}

/**
 * Options for creating a new stream.
 */
export interface CreateOptions extends StreamHandleOptions {
  /**
   * Time-to-live in seconds (relative TTL).
   */
  ttlSeconds?: number

  /**
   * Absolute expiry time (RFC3339 format).
   */
  expiresAt?: string

  /**
   * Initial body to append on creation.
   */
  body?: BodyInit | Uint8Array | string

  /**
   * Enable automatic batching for append() calls.
   * When true, multiple append() calls made while a POST is in-flight
   * will be batched together into a single request.
   *
   * @default true
   */
  batching?: boolean
}

/**
 * Options for appending data to a stream.
 */
export interface AppendOptions {
  /**
   * Writer coordination sequence (stream-seq header).
   * Monotonic, lexicographic sequence for coordinating multiple writers.
   * If lower than last appended seq, server returns 409 Conflict.
   * Not related to read offsets.
   */
  seq?: string

  /**
   * Content type for this append.
   * Must match the stream's content type.
   */
  contentType?: string

  /**
   * AbortSignal for this operation.
   */
  signal?: AbortSignal

  /**
   * Producer ID for idempotent writes.
   * Client-supplied stable identifier (e.g., "order-service-1").
   * Must be provided together with producerEpoch and producerSeq.
   */
  producerId?: string

  /**
   * Producer epoch for idempotent writes.
   * Client-declared, server-validated monotonically increasing.
   * Increment on producer restart.
   */
  producerEpoch?: number

  /**
   * Producer sequence for idempotent writes.
   * Monotonically increasing per epoch, per-batch.
   */
  producerSeq?: number
}

/**
 * Legacy live mode type (internal use only).
 * @internal
 */
export type LegacyLiveMode = `long-poll` | `sse`

/**
 * Options for reading from a stream (internal iterator options).
 * @internal
 */
export interface ReadOptions {
  /**
   * Starting offset, passed as ?offset=...
   * If omitted, defaults to "-1" (start of stream).
   */
  offset?: Offset

  /**
   * Live mode behavior:
   * - undefined/true (default): Catch-up then auto-select SSE or long-poll for live updates
   * - false: Only catch-up, stop after up-to-date (no live updates)
   * - "long-poll": Use long-polling for live updates
   * - "sse": Use SSE for live updates (throws if unsupported)
   */
  live?: boolean | LegacyLiveMode

  /**
   * Override cursor for the request.
   * By default, the client echoes the last stream-cursor value.
   */
  cursor?: string

  /**
   * AbortSignal for this operation.
   */
  signal?: AbortSignal
}

/**
 * Result from a HEAD request on a stream.
 */
export interface HeadResult {
  /**
   * Whether the stream exists.
   */
  exists: true

  /**
   * The stream's content type.
   */
  contentType?: string

  /**
   * The tail offset (next offset after current end of stream).
   * Provided by server as stream-offset header on HEAD.
   */
  offset?: Offset

  /**
   * ETag for the stream (format: {internal_stream_id}:{end_offset}).
   */
  etag?: string

  /**
   * Cache-Control header value.
   */
  cacheControl?: string
}

/**
 * Metadata extracted from a stream response.
 * Contains headers and control information from the stream server.
 */
export interface ResponseMetadata {
  /**
   * Next offset to read from (stream-offset header).
   */
  offset: string

  /**
   * Cursor for CDN collapsing (stream-cursor header).
   */
  cursor?: string

  /**
   * True if stream-up-to-date header was present.
   */
  upToDate: boolean

  /**
   * ETag for caching.
   */
  etag?: string

  /**
   * Content type of the stream.
   */
  contentType?: string
}

/**
 * Error codes for DurableStreamError.
 */
export type DurableStreamErrorCode =
  | `NOT_FOUND`
  | `CONFLICT_SEQ`
  | `CONFLICT_EXISTS`
  | `BAD_REQUEST`
  | `BUSY`
  | `SSE_NOT_SUPPORTED`
  | `UNAUTHORIZED`
  | `FORBIDDEN`
  | `RATE_LIMITED`
  | `ALREADY_CONSUMED`
  | `ALREADY_CLOSED`
  | `PARSE_ERROR`
  | `UNKNOWN`

/**
 * Options returned from onError handler to retry with modified params/headers.
 * Following the Electric client pattern.
 */
export type RetryOpts = {
  params?: ParamsRecord
  headers?: HeadersRecord
}

/**
 * Error handler callback type.
 *
 * Called when a recoverable error occurs during streaming.
 *
 * **Return value behavior** (following Electric client pattern):
 * - Return `{}` (empty object) → Retry immediately with same params/headers
 * - Return `{ params }` → Retry with merged params (existing params preserved)
 * - Return `{ headers }` → Retry with merged headers (existing headers preserved)
 * - Return `void` or `undefined` → Stop stream and propagate the error
 * - Return `null` → INVALID (will cause error - use `{}` instead)
 *
 * **Important**: To retry, you MUST return an object (can be empty `{}`).
 * Returning nothing (`void`), explicitly returning `undefined`, or omitting
 * a return statement all stop the stream. Do NOT return `null`.
 *
 * Note: Automatic retries with exponential backoff are already applied
 * for 5xx server errors, network errors, and 429 rate limits before
 * this handler is called.
 *
 * @example
 * ```typescript
 * // Retry on any error (returns empty object)
 * onError: (error) => ({})
 *
 * // Refresh auth token on 401, propagate other errors
 * onError: async (error) => {
 *   if (error instanceof FetchError && error.status === 401) {
 *     const newToken = await refreshAuthToken()
 *     return { headers: { Authorization: `Bearer ${newToken}` } }
 *   }
 *   // Implicitly returns undefined - error will propagate
 * }
 *
 * // Conditionally retry with explicit propagation
 * onError: (error) => {
 *   if (shouldRetry(error)) {
 *     return {} // Retry
 *   }
 *   return undefined // Explicitly propagate error
 * }
 * ```
 */
export type StreamErrorHandler = (
  error: Error
) => void | RetryOpts | Promise<void | RetryOpts>

// ============================================================================
// StreamResponse Interface
// ============================================================================

/**
 * A streaming session returned by stream() or DurableStream.stream().
 *
 * Represents a live session with fixed `url`, `offset`, and `live` parameters.
 * Supports multiple consumption styles: Promise helpers, ReadableStreams,
 * and Subscribers.
 *
 * @typeParam TJson - The type of JSON items in the stream.
 */
export interface StreamResponse<TJson = unknown> {
  // --- Static session info (known after first response) ---

  /**
   * The stream URL.
   */
  readonly url: string

  /**
   * The stream's content type (from first response).
   */
  readonly contentType?: string

  /**
   * The live mode for this session.
   */
  readonly live: LiveMode

  /**
   * The starting offset for this session.
   */
  readonly startOffset: Offset

  // --- Response metadata (updated on each response) ---

  /**
   * HTTP response headers from the most recent server response.
   * Updated on each long-poll/SSE response.
   */
  readonly headers: Headers

  /**
   * HTTP status code from the most recent server response.
   * Updated on each long-poll/SSE response.
   */
  readonly status: number

  /**
   * HTTP status text from the most recent server response.
   * Updated on each long-poll/SSE response.
   */
  readonly statusText: string

  /**
   * Whether the most recent response was successful (status 200-299).
   * Always true for active streams (errors are thrown).
   */
  readonly ok: boolean

  /**
   * Whether the stream is waiting for initial data.
   *
   * Note: Always false in current implementation because stream() awaits
   * the first response before returning. A future async iterator API
   * could expose this as true during initial connection.
   */
  readonly isLoading: boolean

  // --- Evolving state as data arrives ---

  /**
   * The next offset to read from (Stream-Next-Offset header).
   *
   * **Important**: This value advances **after data is delivered to the consumer**,
   * not just after fetching from the server. The offset represents the position
   * in the stream that follows the data most recently provided to your consumption
   * method (body(), json(), bodyStream(), subscriber callback, etc.).
   *
   * Use this for resuming reads after a disconnect or saving checkpoints.
   */
  offset: Offset

  /**
   * Stream cursor for CDN collapsing (stream-cursor header).
   *
   * Updated after each chunk is delivered to the consumer.
   */
  cursor?: string

  /**
   * Whether we've reached the current end of the stream (stream-up-to-date header).
   *
   * Updated after each chunk is delivered to the consumer.
   */
  upToDate: boolean

  // =================================
  // 1) Accumulating helpers (Promise)
  // =================================
  // Accumulate until first `upToDate`, then resolve and stop.

  /**
   * Accumulate raw bytes until first `upToDate` batch, then resolve.
   * When used with `live: "auto"`, signals the session to stop after upToDate.
   */
  body: () => Promise<Uint8Array>

  /**
   * Accumulate JSON *items* across batches into a single array, resolve at `upToDate`.
   * Only valid in JSON-mode; throws otherwise.
   * When used with `live: "auto"`, signals the session to stop after upToDate.
   */
  json: <T = TJson>() => Promise<Array<T>>

  /**
   * Accumulate text chunks into a single string, resolve at `upToDate`.
   * When used with `live: "auto"`, signals the session to stop after upToDate.
   */
  text: () => Promise<string>

  // =====================
  // 2) ReadableStreams
  // =====================

  /**
   * Raw bytes as a ReadableStream<Uint8Array>.
   *
   * The returned stream is guaranteed to be async-iterable, so you can use
   * `for await...of` syntax even on Safari/iOS which may lack native support.
   */
  bodyStream: () => ReadableStreamAsyncIterable<Uint8Array>

  /**
   * Individual JSON items (flattened) as a ReadableStream<TJson>.
   * Built on jsonBatches().
   *
   * The returned stream is guaranteed to be async-iterable, so you can use
   * `for await...of` syntax even on Safari/iOS which may lack native support.
   */
  jsonStream: () => ReadableStreamAsyncIterable<TJson>

  /**
   * Text chunks as ReadableStream<string>.
   *
   * The returned stream is guaranteed to be async-iterable, so you can use
   * `for await...of` syntax even on Safari/iOS which may lack native support.
   */
  textStream: () => ReadableStreamAsyncIterable<string>

  // =====================
  // 3) Subscriber APIs
  // =====================
  // Subscribers return Promise<void> for backpressure control.
  // Note: Only one consumption method can be used per StreamResponse.

  /**
   * Subscribe to JSON batches as they arrive.
   * Returns unsubscribe function.
   */
  subscribeJson: <T = TJson>(
    subscriber: (batch: JsonBatch<T>) => Promise<void>
  ) => () => void

  /**
   * Subscribe to raw byte chunks as they arrive.
   * Returns unsubscribe function.
   */
  subscribeBytes: (
    subscriber: (chunk: ByteChunk) => Promise<void>
  ) => () => void

  /**
   * Subscribe to text chunks as they arrive.
   * Returns unsubscribe function.
   */
  subscribeText: (subscriber: (chunk: TextChunk) => Promise<void>) => () => void

  // =====================
  // 4) Lifecycle
  // =====================

  /**
   * Cancel the underlying session (abort HTTP, close SSE, stop long-polls).
   */
  cancel: (reason?: unknown) => void

  /**
   * Resolves when the session has fully closed:
   * - `live:false` and up-to-date reached,
   * - manual cancellation,
   * - terminal error.
   */
  readonly closed: Promise<void>
}

// ============================================================================
// Idempotent Producer Types
// ============================================================================

/**
 * Options for creating an IdempotentProducer.
 */
export interface IdempotentProducerOptions {
  /**
   * Starting epoch (default: 0).
   * Increment this on producer restart.
   */
  epoch?: number

  /**
   * On 403 Forbidden (stale epoch), automatically retry with epoch+1.
   * Useful for serverless/ephemeral producers.
   * @default false
   */
  autoClaim?: boolean

  /**
   * Maximum bytes before sending a batch.
   * @default 1048576 (1MB)
   */
  maxBatchBytes?: number

  /**
   * Maximum time to wait for more messages before sending batch (ms).
   * @default 5
   */
  lingerMs?: number

  /**
   * Maximum number of concurrent batches in flight.
   * Higher values improve throughput at the cost of more memory.
   * @default 5
   */
  maxInFlight?: number

  /**
   * Custom fetch implementation.
   */
  fetch?: typeof globalThis.fetch

  /**
   * AbortSignal for the producer lifecycle.
   */
  signal?: AbortSignal

  /**
   * Callback for batch errors in fire-and-forget mode.
   * Since append() returns immediately, errors are reported via this callback.
   * @param error - The error that occurred
   */
  onError?: (error: Error) => void
}

/**
 * Result of an append operation from IdempotentProducer.
 */
export interface IdempotentAppendResult {
  /**
   * The offset after this message was appended.
   */
  offset: Offset

  /**
   * Whether this was a duplicate (idempotent success).
   */
  duplicate: boolean
}
