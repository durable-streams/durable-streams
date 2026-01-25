/**
 * Typed errors for the durable streams server using Effect's Schema.TaggedError.
 * These errors are yieldable in Effect generators and serializable.
 */
import { Schema } from "effect"

/**
 * Stream not found error.
 */
export class StreamNotFoundError extends Schema.TaggedError<StreamNotFoundError>()(
  `StreamNotFoundError`,
  { path: Schema.String }
) {}

/**
 * Stream already exists with different configuration.
 */
export class StreamConflictError extends Schema.TaggedError<StreamConflictError>()(
  `StreamConflictError`,
  { path: Schema.String, message: Schema.String }
) {}

/**
 * Content-type mismatch error.
 */
export class ContentTypeMismatchError extends Schema.TaggedError<ContentTypeMismatchError>()(
  `ContentTypeMismatchError`,
  { expected: Schema.String, received: Schema.String }
) {}

/**
 * Sequence conflict error (Stream-Seq regression).
 */
export class SequenceConflictError extends Schema.TaggedError<SequenceConflictError>()(
  `SequenceConflictError`,
  { currentSeq: Schema.String, receivedSeq: Schema.String }
) {}

/**
 * Invalid JSON error.
 */
export class InvalidJsonError extends Schema.TaggedError<InvalidJsonError>()(
  `InvalidJsonError`,
  { message: Schema.String }
) {}

/**
 * Empty array error (for POST with JSON mode).
 */
export class EmptyArrayError extends Schema.TaggedError<EmptyArrayError>()(
  `EmptyArrayError`,
  {}
) {}

/**
 * Invalid offset error.
 */
export class InvalidOffsetError extends Schema.TaggedError<InvalidOffsetError>()(
  `InvalidOffsetError`,
  { offset: Schema.String }
) {}

/**
 * Invalid header value error.
 */
export class InvalidHeaderError extends Schema.TaggedError<InvalidHeaderError>()(
  `InvalidHeaderError`,
  { header: Schema.String, value: Schema.String, message: Schema.String }
) {}

/**
 * Stale epoch error.
 */
export class StaleEpochError extends Schema.TaggedError<StaleEpochError>()(
  `StaleEpochError`,
  { currentEpoch: Schema.Number }
) {}

/**
 * Invalid epoch sequence error.
 */
export class InvalidEpochSeqError extends Schema.TaggedError<InvalidEpochSeqError>()(
  `InvalidEpochSeqError`,
  {}
) {}

/**
 * Sequence gap error.
 */
export class SequenceGapError extends Schema.TaggedError<SequenceGapError>()(
  `SequenceGapError`,
  { expectedSeq: Schema.Number, receivedSeq: Schema.Number }
) {}

/**
 * Duplicate message error.
 */
export class DuplicateMessageError extends Schema.TaggedError<DuplicateMessageError>()(
  `DuplicateMessageError`,
  { lastSeq: Schema.Number }
) {}

/**
 * Union of all server errors.
 */
export type ServerError =
  | StreamNotFoundError
  | StreamConflictError
  | ContentTypeMismatchError
  | SequenceConflictError
  | InvalidJsonError
  | EmptyArrayError
  | InvalidOffsetError
  | InvalidHeaderError
  | StaleEpochError
  | InvalidEpochSeqError
  | SequenceGapError
  | DuplicateMessageError
