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
  /** Optional sequence number for ordering (Stream-Seq header) */
  seq?: number
  /** Custom headers to include */
  headers?: Record<string, string>
  /** Producer ID for idempotent producers */
  producerId?: string
  /** Producer epoch for idempotent producers */
  producerEpoch?: number
  /** Producer sequence for idempotent producers */
  producerSeq?: number
}

/**
 * Append via IdempotentProducer client (tests client-side exactly-once semantics).
 */
export interface IdempotentAppendCommand {
  type: `idempotent-append`
  path: string
  /** Data to append (string - will be JSON parsed for JSON streams) */
  data: string
  /** Producer ID */
  producerId: string
  /** Producer epoch */
  epoch: number
  /** Auto-claim epoch on 403 */
  autoClaim: boolean
  /** Custom headers to include */
  headers?: Record<string, string>
}

/**
 * Batch append via IdempotentProducer client (tests client-side JSON batching).
 */
export interface IdempotentAppendBatchCommand {
  type: `idempotent-append-batch`
  path: string
  /** Items to append - will be batched by the client */
  items: Array<string>
  /** Producer ID */
  producerId: string
  /** Producer epoch */
  epoch: number
  /** Auto-claim epoch on 403 */
  autoClaim: boolean
  /** Max concurrent batches in flight (default 1, set higher to test 409 retry) */
  maxInFlight?: number
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
  /** Live mode: false for catch-up only, "auto", "long-poll" or "sse" for live */
  live?: false | `auto` | `long-poll` | `sse`
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

// =============================================================================
// Dynamic Headers/Params Commands
// =============================================================================

/**
 * Configure a dynamic header that is evaluated per-request.
 * The adapter should store this and apply it to subsequent operations.
 *
 * This tests the client's ability to support header functions for scenarios
 * like OAuth token refresh, request correlation IDs, etc.
 */
export interface SetDynamicHeaderCommand {
  type: `set-dynamic-header`
  /** Header name to set */
  name: string
  /** Type of dynamic value */
  valueType: `counter` | `timestamp` | `token`
  /** Initial value (for token type) */
  initialValue?: string
}

/**
 * Configure a dynamic URL parameter that is evaluated per-request.
 */
export interface SetDynamicParamCommand {
  type: `set-dynamic-param`
  /** Param name to set */
  name: string
  /** Type of dynamic value */
  valueType: `counter` | `timestamp`
}

/**
 * Clear all dynamic headers and params.
 */
export interface ClearDynamicCommand {
  type: `clear-dynamic`
}

// =============================================================================
// Validation Commands
// =============================================================================

/**
 * Test client-side input validation.
 *
 * This command tests that the client properly validates input parameters
 * before making any network requests. The adapter should attempt to create
 * the specified object with the given parameters and report whether
 * validation passed or failed.
 */
export interface ValidateCommand {
  type: `validate`
  /** What to validate */
  target: ValidateTarget
}

/**
 * Validation targets - what client-side validation to test.
 */
export type ValidateTarget = ValidateRetryOptions | ValidateIdempotentProducer

/**
 * Validate RetryOptions construction.
 */
export interface ValidateRetryOptions {
  target: `retry-options`
  /** Max retries (should reject < 0) */
  maxRetries?: number
  /** Initial delay in ms (should reject <= 0) */
  initialDelayMs?: number
  /** Max delay in ms (should reject < initialDelayMs) */
  maxDelayMs?: number
  /** Backoff multiplier (should reject < 1.0) */
  multiplier?: number
}

/**
 * Validate IdempotentProducer construction.
 */
export interface ValidateIdempotentProducer {
  target: `idempotent-producer`
  /** Producer ID (required, non-empty) */
  producerId?: string
  /** Starting epoch (should reject < 0) */
  epoch?: number
  /** Max batch bytes (should reject <= 0) */
  maxBatchBytes?: number
  /** Max batch items (should reject <= 0) */
  maxBatchItems?: number
}

// =============================================================================
// Benchmark Commands
// =============================================================================

/**
 * Execute a timed benchmark operation.
 * The adapter times the operation internally using high-resolution timing.
 */
export interface BenchmarkCommand {
  type: `benchmark`
  /** Unique ID for this benchmark iteration */
  iterationId: string
  /** The operation to benchmark */
  operation: BenchmarkOperation
}

/**
 * Benchmark operation types - what to measure.
 */
export type BenchmarkOperation =
  | BenchmarkAppendOp
  | BenchmarkReadOp
  | BenchmarkRoundtripOp
  | BenchmarkCreateOp
  | BenchmarkThroughputAppendOp
  | BenchmarkThroughputReadOp

export interface BenchmarkAppendOp {
  op: `append`
  path: string
  /** Size in bytes - adapter generates random payload */
  size: number
}

export interface BenchmarkReadOp {
  op: `read`
  path: string
  offset?: string
}

export interface BenchmarkRoundtripOp {
  op: `roundtrip`
  path: string
  /** Size in bytes */
  size: number
  /** Live mode for reading */
  live?: `long-poll` | `sse`
  /** Content type for SSE compatibility */
  contentType?: string
}

export interface BenchmarkCreateOp {
  op: `create`
  path: string
  contentType?: string
}

export interface BenchmarkThroughputAppendOp {
  op: `throughput_append`
  path: string
  /** Number of messages to send */
  count: number
  /** Size per message in bytes */
  size: number
  /** Concurrency level */
  concurrency: number
}

export interface BenchmarkThroughputReadOp {
  op: `throughput_read`
  path: string
  /** Expected number of JSON messages to read and parse */
  expectedCount?: number
}

/**
 * All possible commands from test runner to client.
 */
export type TestCommand =
  | InitCommand
  | CreateCommand
  | ConnectCommand
  | AppendCommand
  | IdempotentAppendCommand
  | IdempotentAppendBatchCommand
  | ReadCommand
  | HeadCommand
  | DeleteCommand
  | ShutdownCommand
  | SetDynamicHeaderCommand
  | SetDynamicParamCommand
  | ClearDynamicCommand
  | BenchmarkCommand
  | ValidateCommand

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
    /** Supports auto mode (catch-up then auto-select SSE or long-poll) */
    auto?: boolean
    /** Supports streaming reads */
    streaming?: boolean
    /** Supports dynamic headers/params (functions evaluated per-request) */
    dynamicHeaders?: boolean
    /** Supports RetryOptions validation (PHP-specific) */
    retryOptions?: boolean
    /** Supports maxBatchItems option (PHP-specific) */
    batchItems?: boolean
    /** Rejects zero values as invalid (vs treating 0 as "use default" like Go) */
    strictZeroValidation?: boolean
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
  /** Response headers */
  headers?: Record<string, string>
  /** Headers that were sent in the request (for dynamic header testing) */
  headersSent?: Record<string, string>
  /** Params that were sent in the request (for dynamic param testing) */
  paramsSent?: Record<string, string>
  /** Whether this was a duplicate (204 response) - for idempotent producers */
  duplicate?: boolean
  /** Current producer epoch from server (on 200 or 403) */
  producerEpoch?: number
  /** Server's highest accepted sequence for this (stream, producerId, epoch) - returned in Producer-Seq header on 200/204 */
  producerSeq?: number
  /** Expected producer sequence (on 409 sequence gap) */
  producerExpectedSeq?: number
  /** Received producer sequence (on 409 sequence gap) */
  producerReceivedSeq?: number
}

/**
 * Successful idempotent-append result.
 */
export interface IdempotentAppendResult {
  type: `idempotent-append`
  success: true
  status: number
  /** New offset after append */
  offset?: string
  /** Whether this was a duplicate */
  duplicate?: boolean
  /** Server's highest accepted sequence for this (stream, producerId, epoch) - returned in Producer-Seq header */
  producerSeq?: number
}

/**
 * Successful idempotent-append-batch result.
 */
export interface IdempotentAppendBatchResult {
  type: `idempotent-append-batch`
  success: true
  status: number
  /** Server's highest accepted sequence for this (stream, producerId, epoch) - returned in Producer-Seq header */
  producerSeq?: number
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
  /** Response headers */
  headers?: Record<string, string>
  /** Headers that were sent in the request (for dynamic header testing) */
  headersSent?: Record<string, string>
  /** Params that were sent in the request (for dynamic param testing) */
  paramsSent?: Record<string, string>
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
 * Successful set-dynamic-header result.
 */
export interface SetDynamicHeaderResult {
  type: `set-dynamic-header`
  success: true
}

/**
 * Successful set-dynamic-param result.
 */
export interface SetDynamicParamResult {
  type: `set-dynamic-param`
  success: true
}

/**
 * Successful clear-dynamic result.
 */
export interface ClearDynamicResult {
  type: `clear-dynamic`
  success: true
}

/**
 * Successful validate result (validation passed).
 */
export interface ValidateResult {
  type: `validate`
  success: true
}

/**
 * Successful benchmark result with timing.
 */
export interface BenchmarkResult {
  type: `benchmark`
  success: true
  iterationId: string
  /** Timing in nanoseconds (as string since bigint doesn't JSON serialize) */
  durationNs: string
  /** Optional metrics */
  metrics?: {
    /** Bytes transferred */
    bytesTransferred?: number
    /** Messages processed */
    messagesProcessed?: number
    /** Operations per second (for throughput tests) */
    opsPerSecond?: number
    /** Bytes per second (for throughput tests) */
    bytesPerSecond?: number
  }
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
  | IdempotentAppendResult
  | IdempotentAppendBatchResult
  | ReadResult
  | HeadResult
  | DeleteResult
  | ShutdownResult
  | SetDynamicHeaderResult
  | SetDynamicParamResult
  | ClearDynamicResult
  | ValidateResult
  | BenchmarkResult
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
  /** Invalid argument passed to client API */
  INVALID_ARGUMENT: `INVALID_ARGUMENT`,
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

// =============================================================================
// Benchmark Statistics
// =============================================================================

/**
 * Statistical summary of benchmark results.
 */
export interface BenchmarkStats {
  /** Minimum value in milliseconds */
  min: number
  /** Maximum value in milliseconds */
  max: number
  /** Arithmetic mean in milliseconds */
  mean: number
  /** Median (p50) in milliseconds */
  median: number
  /** 75th percentile in milliseconds */
  p75: number
  /** 95th percentile in milliseconds */
  p95: number
  /** 99th percentile in milliseconds */
  p99: number
  /** Standard deviation in milliseconds */
  stdDev: number
  /** Margin of error (95% confidence) in milliseconds */
  marginOfError: number
  /** Number of samples */
  sampleCount: number
}

/**
 * Calculate statistics from an array of durations in nanoseconds.
 */
export function calculateStats(durationsNs: Array<bigint>): BenchmarkStats {
  if (durationsNs.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p75: 0,
      p95: 0,
      p99: 0,
      stdDev: 0,
      marginOfError: 0,
      sampleCount: 0,
    }
  }

  // Convert to milliseconds for statistics
  const samplesMs = durationsNs.map((ns) => Number(ns) / 1_000_000)
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const n = sorted.length

  const min = sorted[0]!
  const max = sorted[n - 1]!
  const mean = samplesMs.reduce((a, b) => a + b, 0) / n

  // Percentiles (nearest rank method, 0-based indexing)
  const percentile = (p: number) => {
    const idx = Math.floor((n - 1) * p)
    return sorted[idx]!
  }

  const median = percentile(0.5)
  const p75 = percentile(0.75)
  const p95 = percentile(0.95)
  const p99 = percentile(0.99)

  // Standard deviation
  const squaredDiffs = samplesMs.map((v) => Math.pow(v - mean, 2))
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / n
  const stdDev = Math.sqrt(variance)

  // Margin of error (95% confidence, z = 1.96)
  const marginOfError = (1.96 * stdDev) / Math.sqrt(n)

  return {
    min,
    max,
    mean,
    median,
    p75,
    p95,
    p99,
    stdDev,
    marginOfError,
    sampleCount: n,
  }
}

/**
 * Format a BenchmarkStats object for display.
 */
export function formatStats(
  stats: BenchmarkStats,
  unit = `ms`
): Record<string, string> {
  const fmt = (v: number) => `${v.toFixed(2)} ${unit}`
  return {
    Min: fmt(stats.min),
    Max: fmt(stats.max),
    Mean: fmt(stats.mean),
    Median: fmt(stats.median),
    P75: fmt(stats.p75),
    P95: fmt(stats.p95),
    P99: fmt(stats.p99),
    StdDev: fmt(stats.stdDev),
    "Margin of Error": fmt(stats.marginOfError),
    Samples: stats.sampleCount.toString(),
  }
}
