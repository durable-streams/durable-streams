/**
 * Error types for @durable-streams/wrapper-sdk.
 */

/**
 * Error codes for WrapperSDKError.
 */
export type WrapperSDKErrorCode =
  | `STREAM_NOT_FOUND`
  | `STREAM_EXISTS`
  | `STORAGE_ERROR`
  | `INVALID_OPTIONS`
  | `UNKNOWN`

/**
 * Protocol-level error for Wrapper SDK operations.
 * Provides structured error handling with error codes.
 */
export class WrapperSDKError extends Error {
  /**
   * Structured error code for programmatic handling.
   */
  readonly code: WrapperSDKErrorCode

  /**
   * Additional error details.
   */
  readonly details?: unknown

  /**
   * The underlying cause of the error, if any.
   */
  readonly cause?: Error

  constructor(
    message: string,
    code: WrapperSDKErrorCode,
    options?: { details?: unknown; cause?: Error }
  ) {
    super(message, { cause: options?.cause })
    this.name = `WrapperSDKError`
    this.code = code
    this.details = options?.details
    this.cause = options?.cause
  }

  /**
   * Create a stream not found error.
   */
  static streamNotFound(id: string): WrapperSDKError {
    return new WrapperSDKError(`Stream not found: ${id}`, `STREAM_NOT_FOUND`, {
      details: { id },
    })
  }

  /**
   * Create a stream already exists error.
   */
  static streamExists(id: string): WrapperSDKError {
    return new WrapperSDKError(
      `Stream already exists: ${id}`,
      `STREAM_EXISTS`,
      { details: { id } }
    )
  }

  /**
   * Create an invalid options error.
   */
  static invalidOptions(message: string, details?: unknown): WrapperSDKError {
    return new WrapperSDKError(
      `Invalid options: ${message}`,
      `INVALID_OPTIONS`,
      { details }
    )
  }

  /**
   * Wrap an unknown error.
   */
  static fromError(error: unknown, context?: string): WrapperSDKError {
    const message = context
      ? `${context}: ${error instanceof Error ? error.message : String(error)}`
      : error instanceof Error
        ? error.message
        : String(error)

    return new WrapperSDKError(message, `UNKNOWN`, {
      cause: error instanceof Error ? error : undefined,
    })
  }
}
