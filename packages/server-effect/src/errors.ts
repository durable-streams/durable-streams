/**
 * Typed errors for the durable streams server.
 */

/**
 * Stream not found error.
 */
export interface StreamNotFoundError {
  readonly _tag: "StreamNotFoundError"
  readonly path: string
}

export const StreamNotFoundError = (path: string): StreamNotFoundError => ({
  _tag: "StreamNotFoundError",
  path,
})

/**
 * Stream already exists with different configuration.
 */
export interface StreamConflictError {
  readonly _tag: "StreamConflictError"
  readonly path: string
  readonly message: string
}

export const StreamConflictError = (path: string, message: string): StreamConflictError => ({
  _tag: "StreamConflictError",
  path,
  message,
})

/**
 * Content-type mismatch error.
 */
export interface ContentTypeMismatchError {
  readonly _tag: "ContentTypeMismatchError"
  readonly expected: string
  readonly received: string
}

export const ContentTypeMismatchError = (
  expected: string,
  received: string
): ContentTypeMismatchError => ({
  _tag: "ContentTypeMismatchError",
  expected,
  received,
})

/**
 * Sequence conflict error (Stream-Seq regression).
 */
export interface SequenceConflictError {
  readonly _tag: "SequenceConflictError"
  readonly currentSeq: string
  readonly receivedSeq: string
}

export const SequenceConflictError = (
  currentSeq: string,
  receivedSeq: string
): SequenceConflictError => ({
  _tag: "SequenceConflictError",
  currentSeq,
  receivedSeq,
})

/**
 * Invalid JSON error.
 */
export interface InvalidJsonError {
  readonly _tag: "InvalidJsonError"
  readonly message: string
}

export const InvalidJsonError = (message: string): InvalidJsonError => ({
  _tag: "InvalidJsonError",
  message,
})

/**
 * Empty array error (for POST with JSON mode).
 */
export interface EmptyArrayError {
  readonly _tag: "EmptyArrayError"
}

export const EmptyArrayError = (): EmptyArrayError => ({
  _tag: "EmptyArrayError",
})

/**
 * Invalid offset error.
 */
export interface InvalidOffsetError {
  readonly _tag: "InvalidOffsetError"
  readonly offset: string
}

export const InvalidOffsetError = (offset: string): InvalidOffsetError => ({
  _tag: "InvalidOffsetError",
  offset,
})

/**
 * Invalid header value error.
 */
export interface InvalidHeaderError {
  readonly _tag: "InvalidHeaderError"
  readonly header: string
  readonly value: string
  readonly message: string
}

export const InvalidHeaderError = (
  header: string,
  value: string,
  message: string
): InvalidHeaderError => ({
  _tag: "InvalidHeaderError",
  header,
  value,
  message,
})

/**
 * Stale epoch error.
 */
export interface StaleEpochError {
  readonly _tag: "StaleEpochError"
  readonly currentEpoch: number
}

export const StaleEpochError = (currentEpoch: number): StaleEpochError => ({
  _tag: "StaleEpochError",
  currentEpoch,
})

/**
 * Invalid epoch sequence error.
 */
export interface InvalidEpochSeqError {
  readonly _tag: "InvalidEpochSeqError"
}

export const InvalidEpochSeqError = (): InvalidEpochSeqError => ({
  _tag: "InvalidEpochSeqError",
})

/**
 * Sequence gap error.
 */
export interface SequenceGapError {
  readonly _tag: "SequenceGapError"
  readonly expectedSeq: number
  readonly receivedSeq: number
}

export const SequenceGapError = (expectedSeq: number, receivedSeq: number): SequenceGapError => ({
  _tag: "SequenceGapError",
  expectedSeq,
  receivedSeq,
})

/**
 * Duplicate message error.
 */
export interface DuplicateMessageError {
  readonly _tag: "DuplicateMessageError"
  readonly lastSeq: number
}

export const DuplicateMessageError = (lastSeq: number): DuplicateMessageError => ({
  _tag: "DuplicateMessageError",
  lastSeq,
})

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
