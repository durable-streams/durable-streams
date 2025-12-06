/**
 * Durable Streams TypeScript Client Types
 *
 * Following the Electric Durable Stream Protocol specification.
 */

/**
 * Offset string - opaque to the client.
 * Format: "<read-seq>_<byte-offset>"
 *
 * Always use the returned `offset` field from reads/follows as the next `offset` you pass in.
 */
export type Offset = string

/**
 * Type for values that can be provided immediately or resolved asynchronously.
 */
export type MaybePromise<T> = T | Promise<T>

/**
 * Auth configuration for requests.
 *
 * Supports:
 * - Fixed tokens with optional custom header name
 * - Arbitrary static headers
 * - Async header resolution (e.g., for short-lived tokens)
 */
export type Auth =
  | { token: string; headerName?: string } // default "authorization: Bearer <token>"
  | { headers: Record<string, string> }
  | { getHeaders: () => Promise<Record<string, string>> }

/**
 * Headers record where values can be static strings or async functions.
 * Following the @electric-sql/client pattern for dynamic headers.
 */
export type HeadersRecord = {
  [key: string]: string | (() => MaybePromise<string>)
}

/**
 * Params record where values can be static or async functions.
 * Following the @electric-sql/client pattern for dynamic params.
 */
export type ParamsRecord = {
  [key: string]: string | (() => MaybePromise<string>) | undefined
}

/**
 * Base options for all stream operations.
 */
export interface StreamOptions {
  /**
   * The full URL to the durable stream.
   * E.g., "https://streams.example.com/my-account/chat/room-1"
   */
  url: string

  /**
   * Authentication configuration.
   * If using auth, you can provide:
   * - A token (sent as Bearer token in Authorization header by default)
   * - Custom headers
   * - An async function to get headers (for refreshing tokens)
   */
  auth?: Auth

  /**
   * Additional headers to include in requests.
   * Values can be strings or functions (sync or async) that return strings.
   * Function values are resolved when needed, making this useful
   * for dynamic headers like authentication tokens.
   */
  headers?: HeadersRecord

  /**
   * Additional query parameters to include in requests.
   * Values can be strings or functions (sync or async) that return strings.
   */
  params?: ParamsRecord

  /**
   * Custom fetch implementation.
   * Defaults to globalThis.fetch.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Default AbortSignal for operations.
   * Individual operations can override this.
   */
  signal?: AbortSignal
}

/**
 * Options for creating a new stream.
 */
export interface CreateOptions extends StreamOptions {
  /**
   * The content type for the stream.
   * This is set once on creation and cannot be changed.
   */
  contentType?: string

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
}

/**
 * Live mode for reading from a stream.
 * - "long-poll": Use long-polling for live updates
 * - "sse": Use Server-Sent Events for live updates (throws if unsupported)
 */
export type LiveMode = `long-poll` | `sse`

/**
 * Options for reading from a stream.
 */
export interface ReadOptions {
  /**
   * Starting offset, passed as ?offset=...
   * If omitted, reads from the start of the stream.
   */
  offset?: Offset

  /**
   * Live mode behavior:
   * - undefined/true (default): Catch-up then auto-select SSE or long-poll for live updates
   * - false: Only catch-up, stop after up-to-date (no live updates)
   * - "long-poll": Use long-polling for live updates
   * - "sse": Use SSE for live updates (throws if unsupported)
   */
  live?: boolean | LiveMode

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
 * Result from a read operation.
 */
export interface ReadResult {
  /**
   * The data read from the stream.
   */
  data: Uint8Array

  /**
   * Next offset to read from.
   * This is the HTTP stream-offset header value.
   */
  offset: Offset

  /**
   * Cursor for CDN collapsing (stream-cursor header).
   */
  cursor?: string

  /**
   * True if stream-up-to-date header was present.
   * Indicates the response ends at the current end of the stream.
   */
  upToDate: boolean

  /**
   * ETag for caching.
   */
  etag?: string

  /**
   * Content type of the data.
   */
  contentType?: string
}

/**
 * A chunk returned from follow() or toReadableStream().
 * Same structure as ReadResult.
 */
export interface StreamChunk extends ReadResult {}

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
 * - Return `{}` to retry with the same params/headers
 * - Return `{ params }` to retry with merged params (existing params are preserved)
 * - Return `{ headers }` to retry with merged headers (existing headers are preserved)
 * - Return `void`/`undefined` to stop the stream and propagate the error
 *
 * Note: Automatic retries with exponential backoff are already applied
 * for 5xx server errors, network errors, and 429 rate limits before
 * this handler is called.
 *
 * @example
 * ```typescript
 * // Retry on any error
 * onError: (error) => ({})
 *
 * // Refresh auth token on 401
 * onError: async (error) => {
 *   if (error instanceof FetchError && error.status === 401) {
 *     const newToken = await refreshAuthToken()
 *     return { headers: { Authorization: `Bearer ${newToken}` } }
 *   }
 *   // Don't retry other errors
 * }
 * ```
 */
export type StreamErrorHandler = (
  error: Error
) => void | RetryOpts | Promise<void | RetryOpts>
