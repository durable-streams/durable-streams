/**
 * Custom error classes for durable stream storage operations.
 * These errors map to specific HTTP status codes in the router.
 */

/**
 * Base class for all durable stream errors.
 * Provides a consistent structure for error handling across storage implementations.
 */
export class DurableStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

/**
 * Stream not found error (404).
 * Thrown when attempting to access, modify, or delete a stream that doesn't exist.
 */
export class StreamNotFoundError extends DurableStreamError {
  constructor(path: string) {
    super(`Stream not found: ${path}`)
  }
}

/**
 * Stream already exists error (409).
 * Thrown when attempting to create a stream that already exists with different configuration.
 * Idempotent creates (same config) should succeed, not throw this error.
 */
export class StreamAlreadyExistsError extends DurableStreamError {
  constructor(path: string) {
    super(`Stream already exists with different configuration: ${path}`)
  }
}

/**
 * Sequence conflict error (409).
 * Thrown when a sequence number is less than or equal to the last recorded sequence.
 * Used for optimistic concurrency control to prevent conflicting writes.
 */
export class SequenceConflictError extends DurableStreamError {
  constructor(seq: string, lastSeq: string) {
    super(`Sequence conflict: ${seq} <= ${lastSeq}`)
  }
}

/**
 * Content type mismatch error (409).
 * Thrown when attempting to append data with a content type that doesn't match
 * the stream's configured content type.
 */
export class ContentTypeMismatchError extends DurableStreamError {
  constructor(expected: string, received: string) {
    super(`Content-type mismatch: expected ${expected}, got ${received}`)
  }
}

/**
 * Invalid JSON error (400).
 * Thrown when appending invalid JSON data to an application/json stream.
 * JSON streams require data to be valid JSON fragments.
 */
export class InvalidJsonError extends DurableStreamError {
  constructor(message: string = `Invalid JSON`) {
    super(message)
  }
}

/**
 * Empty array not allowed error (400).
 * Thrown when attempting to append an empty JSON array to an existing stream.
 * Empty arrays are only allowed during stream creation (initialData).
 */
export class EmptyArrayNotAllowedError extends DurableStreamError {
  constructor() {
    super(`Empty arrays are not allowed in append operations`)
  }
}
