/**
 * Typed errors for the durable streams client using Effect's Schema.TaggedError.
 * These errors are yieldable in Effect generators and serializable.
 */
import { Schema } from "effect"

// =============================================================================
// Stream Lifecycle Errors
// =============================================================================

/**
 * Stream not found (404).
 */
export class StreamNotFoundError extends Schema.TaggedError<StreamNotFoundError>()(
  `StreamNotFoundError`,
  { url: Schema.String }
) {}

/**
 * Stream already exists with different configuration (409).
 */
export class StreamConflictError extends Schema.TaggedError<StreamConflictError>()(
  `StreamConflictError`,
  { url: Schema.String, message: Schema.String }
) {}

/**
 * Content-type mismatch between request and stream.
 */
export class ContentTypeMismatchError extends Schema.TaggedError<ContentTypeMismatchError>()(
  `ContentTypeMismatchError`,
  { expected: Schema.String, received: Schema.String }
) {}

// =============================================================================
// Offset and Sequence Errors
// =============================================================================

/**
 * Invalid offset format.
 */
export class InvalidOffsetError extends Schema.TaggedError<InvalidOffsetError>()(
  `InvalidOffsetError`,
  { offset: Schema.String }
) {}

/**
 * Sequence conflict (Stream-Seq regression).
 */
export class SequenceConflictError extends Schema.TaggedError<SequenceConflictError>()(
  `SequenceConflictError`,
  { currentSeq: Schema.String, receivedSeq: Schema.String }
) {}

// =============================================================================
// Producer Errors
// =============================================================================

/**
 * Producer epoch is stale (403).
 */
export class StaleEpochError extends Schema.TaggedError<StaleEpochError>()(
  `StaleEpochError`,
  { currentEpoch: Schema.Number }
) {}

/**
 * Producer sequence gap (409).
 */
export class SequenceGapError extends Schema.TaggedError<SequenceGapError>()(
  `SequenceGapError`,
  { expectedSeq: Schema.Number, receivedSeq: Schema.Number }
) {}

/**
 * Producer is closed.
 */
export class ProducerClosedError extends Schema.TaggedError<ProducerClosedError>()(
  `ProducerClosedError`,
  {}
) {}

// =============================================================================
// HTTP and Network Errors
// =============================================================================

/**
 * HTTP error with status and body.
 */
export class HttpError extends Schema.TaggedError<HttpError>()(
  `HttpError`,
  {
    status: Schema.Number,
    statusText: Schema.String,
    url: Schema.String,
    body: Schema.optional(Schema.String),
  }
) {}

/**
 * Network error (connection refused, timeout, etc.).
 */
export class NetworkError extends Schema.TaggedError<NetworkError>()(
  `NetworkError`,
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) }
) {}

/**
 * Request timeout.
 */
export class TimeoutError extends Schema.TaggedError<TimeoutError>()(
  `TimeoutError`,
  { message: Schema.String }
) {}

// =============================================================================
// Parsing Errors
// =============================================================================

/**
 * Failed to parse JSON response.
 */
export class ParseError extends Schema.TaggedError<ParseError>()(
  `ParseError`,
  { message: Schema.String }
) {}

/**
 * SSE event parsing error.
 */
export class SSEParseError extends Schema.TaggedError<SSEParseError>()(
  `SSEParseError`,
  { message: Schema.String }
) {}

// =============================================================================
// Error Union Type
// =============================================================================

/**
 * Union of all client errors.
 */
export type ClientError =
  | StreamNotFoundError
  | StreamConflictError
  | ContentTypeMismatchError
  | InvalidOffsetError
  | SequenceConflictError
  | StaleEpochError
  | SequenceGapError
  | ProducerClosedError
  | HttpError
  | NetworkError
  | TimeoutError
  | ParseError
  | SSEParseError
