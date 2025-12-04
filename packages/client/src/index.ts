/**
 * Durable Streams TypeScript Client
 *
 * A client library for the Electric Durable Streams protocol.
 *
 * @packageDocumentation
 */

// Main class
export { DurableStream, type DurableStreamOptions } from "./stream"

// Types
export type {
  Offset,
  Auth,
  HeadersRecord,
  ParamsRecord,
  StreamOptions,
  CreateOptions,
  AppendOptions,
  ReadOptions,
  HeadResult,
  ReadResult,
  StreamChunk,
  LiveMode,
  DurableStreamErrorCode,
  RetryOpts,
  StreamErrorHandler,
  MaybePromise,
} from "./types"

// Errors
export {
  FetchError,
  FetchBackoffAbortError,
  DurableStreamError,
  MissingStreamUrlError,
  InvalidSignalError,
} from "./error"

// Fetch utilities
export {
  type BackoffOptions,
  BackoffDefaults,
  createFetchWithBackoff,
  createFetchWithConsumedBody,
} from "./fetch"

// Constants (for advanced users)
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
