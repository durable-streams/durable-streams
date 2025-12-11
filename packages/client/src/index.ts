/**
 * Durable Streams TypeScript Client
 *
 * A client library for the Electric Durable Streams protocol.
 *
 * @packageDocumentation
 */

// ============================================================================
// Primary Read API (new)
// ============================================================================

// Standalone stream() function - the fetch-like read API
export { stream } from "./stream-api"

// StreamResponse implementation
export { StreamResponseImpl } from "./response"

// ============================================================================
// Handle API (read/write)
// ============================================================================

// DurableStream class for read/write operations
export { DurableStream, type DurableStreamOptions } from "./stream"

// ============================================================================
// Types
// ============================================================================

export type {
  // Core types
  Offset,
  Auth,
  HeadersRecord,
  ParamsRecord,
  MaybePromise,

  // Stream options (new API)
  StreamOptions,
  StreamHandleOptions,
  LiveMode,

  // Chunk & batch types (new API)
  JsonBatchMeta,
  JsonBatch,
  ByteChunk,
  TextChunk,
  StreamResponse,

  // Legacy types (still used internally)
  CreateOptions,
  AppendOptions,
  ReadOptions,
  HeadResult,
  ReadResult,
  StreamChunk,
  LegacyLiveMode,

  // Error handling
  DurableStreamErrorCode,
  RetryOpts,
  StreamErrorHandler,
} from "./types"

// ============================================================================
// Errors
// ============================================================================

export {
  FetchError,
  FetchBackoffAbortError,
  DurableStreamError,
  MissingStreamUrlError,
  InvalidSignalError,
} from "./error"

// ============================================================================
// Fetch utilities
// ============================================================================

export {
  type BackoffOptions,
  BackoffDefaults,
  createFetchWithBackoff,
  createFetchWithConsumedBody,
} from "./fetch"

// ============================================================================
// Constants (for advanced users)
// ============================================================================

export {
  STREAM_OFFSET_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_UP_TO_DATE_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_TTL_HEADER,
  STREAM_EXPIRES_AT_HEADER,
  OFFSET_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  CURSOR_QUERY_PARAM,
  SSE_COMPATIBLE_CONTENT_TYPES,
  DURABLE_STREAM_PROTOCOL_QUERY_PARAMS,
} from "./constants"
