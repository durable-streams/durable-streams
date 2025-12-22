/**
 * Protocol types for client conformance testing.
 *
 * This module defines the stdin/stdout protocol used for communication
 * between the test runner and client adapters in any language.
 *
 * Communication is line-based JSON over stdin/stdout:
 * - Test runner writes TestCommand as JSON line to client's stdin
 * - Client writes TestResult as JSON line to stdout
 * - Each command expects exactly one result
 */

// =============================================================================
// Commands (sent from test runner to client adapter via stdin)
// =============================================================================

/**
 * Initialize the client adapter with configuration.
 * Must be the first command sent.
 */
export interface InitCommand {
  type: `init`
  /** Base URL of the reference server */
  serverUrl: string
  /** Optional timeout in milliseconds for operations */
  timeoutMs?: number
}

/**
 * Create a new stream (PUT request).
 */
export interface CreateCommand {
  type: `create`
  /** Full URL path for the stream (relative to serverUrl) */
  path: string
  /** Content type for the stream */
  contentType?: string
  /** Optional TTL in seconds */
  ttlSeconds?: number
  /** Optional absolute expiry timestamp (ISO 8601) */
  expiresAt?: string
  /** Custom headers to include */
  headers?: Record<string, string>
}

/**
 * Connect to an existing stream without creating it.
 */
export interface ConnectCommand {
  type: `connect`
  path: string
  headers?: Record<string, string>
}

/**
 * Append data to a stream (POST request).
 */
export interface AppendCommand {
  type: `append`
  path: string
  /** Data to append - string for text, base64 for binary */
  data: string
  /** Whether data is base64 encoded binary */
  binary?: boolean
  /** Optional sequence number for ordering */
  seq?: number
  /** Custom headers to include */
  headers?: Record<string, string>
}

/**
 * Read from a stream (GET request).
 */
export interface ReadCommand {
  type: `read`
  path: string
  /** Starting offset (opaque string from previous reads) */
  offset?: string
  /** Live mode: false for catch-up only, "long-poll" or "sse" for live */
  live?: false | `long-poll` | `sse`
  /** Timeout for long-poll in milliseconds */
  timeoutMs?: number
  /** Maximum number of chunks to read (for testing) */
  maxChunks?: number
  /** Whether to wait until up-to-date before returning */
  waitForUpToDate?: boolean
  /** Custom headers to include */
  headers?: Record<string, string>
}

/**
 * Get stream metadata (HEAD request).
 */
export interface HeadCommand {
  type: `head`
  path: string
  headers?: Record<string, string>
}

/**
 * Delete a stream (DELETE request).
 */
export interface DeleteCommand {
  type: `delete`
  path: string
  headers?: Record<string, string>
}

/**
 * Shutdown the client adapter gracefully.
 */
export interface ShutdownCommand {
  type: `shutdown`
}

/**
 * All possible commands from test runner to client.
 */
export type TestCommand =
  | InitCommand
  | CreateCommand
  | ConnectCommand
  | AppendCommand
  | ReadCommand
  | HeadCommand
  | DeleteCommand
  | ShutdownCommand

// =============================================================================
// Results (sent from client adapter to test runner via stdout)
// =============================================================================

/**
 * Successful initialization result.
 */
export interface InitResult {
  type: `init`
  success: true
  /** Client implementation name (e.g., "typescript", "python", "go") */
  clientName: string
  /** Client implementation version */
  clientVersion: string
  /** Supported features */
  features?: {
    /** Supports automatic batching */
    batching?: boolean
    /** Supports SSE mode */
    sse?: boolean
    /** Supports long-poll mode */
    longPoll?: boolean
    /** Supports streaming reads */
    streaming?: boolean
  }
}

/**
 * Successful create result.
 */
export interface CreateResult {
  type: `create`
  success: true
  /** HTTP status code received */
  status: number
  /** Stream offset after creation */
  offset?: string
  /** Response headers of interest */
  headers?: Record<string, string>
}

/**
 * Successful connect result.
 */
export interface ConnectResult {
  type: `connect`
  success: true
  status: number
  offset?: string
  headers?: Record<string, string>
}

/**
 * Successful append result.
 */
export interface AppendResult {
  type: `append`
  success: true
  status: number
  /** New offset after append */
  offset?: string
  headers?: Record<string, string>
}

/**
 * A chunk of data read from the stream.
 */
export interface ReadChunk {
  /** Data content - string for text, base64 for binary */
  data: string
  /** Whether data is base64 encoded */
  binary?: boolean
  /** Offset of this chunk */
  offset?: string
}

/**
 * Successful read result.
 */
export interface ReadResult {
  type: `read`
  success: true
  status: number
  /** Chunks of data read */
  chunks: Array<ReadChunk>
  /** Final offset after reading */
  offset?: string
  /** Whether stream is up-to-date (caught up to head) */
  upToDate?: boolean
  /** Cursor value if provided */
  cursor?: string
  headers?: Record<string, string>
}

/**
 * Successful head result.
 */
export interface HeadResult {
  type: `head`
  success: true
  status: number
  /** Current tail offset */
  offset?: string
  /** Stream content type */
  contentType?: string
  /** TTL remaining in seconds */
  ttlSeconds?: number
  /** Absolute expiry (ISO 8601) */
  expiresAt?: string
  headers?: Record<string, string>
}

/**
 * Successful delete result.
 */
export interface DeleteResult {
  type: `delete`
  success: true
  status: number
  headers?: Record<string, string>
}

/**
 * Successful shutdown result.
 */
export interface ShutdownResult {
  type: `shutdown`
  success: true
}

/**
 * Error result for any failed operation.
 */
export interface ErrorResult {
  type: `error`
  success: false
  /** Original command type that failed */
  commandType: TestCommand[`type`]
  /** HTTP status code if available */
  status?: number
  /** Error code (e.g., "NETWORK_ERROR", "TIMEOUT", "CONFLICT") */
  errorCode: string
  /** Human-readable error message */
  message: string
  /** Additional error details */
  details?: Record<string, unknown>
}

/**
 * All possible results from client to test runner.
 */
export type TestResult =
  | InitResult
  | CreateResult
  | ConnectResult
  | AppendResult
  | ReadResult
  | HeadResult
  | DeleteResult
  | ShutdownResult
  | ErrorResult

// =============================================================================
// Utilities
// =============================================================================

/**
 * Parse a JSON line into a TestCommand.
 */
export function parseCommand(line: string): TestCommand {
  return JSON.parse(line) as TestCommand
}

/**
 * Serialize a TestResult to a JSON line.
 */
export function serializeResult(result: TestResult): string {
  return JSON.stringify(result)
}

/**
 * Parse a JSON line into a TestResult.
 */
export function parseResult(line: string): TestResult {
  return JSON.parse(line) as TestResult
}

/**
 * Serialize a TestCommand to a JSON line.
 */
export function serializeCommand(command: TestCommand): string {
  return JSON.stringify(command)
}

/**
 * Encode binary data to base64 for transmission.
 */
export function encodeBase64(data: Uint8Array): string {
  return Buffer.from(data).toString(`base64`)
}

/**
 * Decode base64 string back to binary data.
 */
export function decodeBase64(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, `base64`))
}

/**
 * Standard error codes for ErrorResult.
 */
export const ErrorCodes = {
  /** Network connection failed */
  NETWORK_ERROR: `NETWORK_ERROR`,
  /** Operation timed out */
  TIMEOUT: `TIMEOUT`,
  /** Stream already exists (409 Conflict) */
  CONFLICT: `CONFLICT`,
  /** Stream not found (404) */
  NOT_FOUND: `NOT_FOUND`,
  /** Sequence number conflict (409) */
  SEQUENCE_CONFLICT: `SEQUENCE_CONFLICT`,
  /** Invalid offset format */
  INVALID_OFFSET: `INVALID_OFFSET`,
  /** Server returned unexpected status */
  UNEXPECTED_STATUS: `UNEXPECTED_STATUS`,
  /** Failed to parse response */
  PARSE_ERROR: `PARSE_ERROR`,
  /** Client internal error */
  INTERNAL_ERROR: `INTERNAL_ERROR`,
  /** Operation not supported by this client */
  NOT_SUPPORTED: `NOT_SUPPORTED`,
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]
