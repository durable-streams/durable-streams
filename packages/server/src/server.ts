/**
 * HTTP server for durable streams testing.
 */

import { createServer } from "node:http"
import { deflateSync, gzipSync } from "node:zlib"
import { StreamStore } from "./store"
import { FileBackedStreamStore } from "./file-store"
import { generateResponseCursor } from "./cursor"
import type { CursorOptions } from "./cursor"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { StreamLifecycleEvent, TestServerOptions } from "./types"

// Protocol headers (aligned with PROTOCOL.md)
const STREAM_OFFSET_HEADER = `Stream-Next-Offset`
const STREAM_CURSOR_HEADER = `Stream-Cursor`
const STREAM_UP_TO_DATE_HEADER = `Stream-Up-To-Date`
const STREAM_SEQ_HEADER = `Stream-Seq`
const STREAM_TTL_HEADER = `Stream-TTL`
const STREAM_EXPIRES_AT_HEADER = `Stream-Expires-At`

// SSE control event fields (Protocol Section 5.7)
const SSE_OFFSET_FIELD = `streamNextOffset`
const SSE_CURSOR_FIELD = `streamCursor`
const SSE_UP_TO_DATE_FIELD = `upToDate`

// Query params
const OFFSET_QUERY_PARAM = `offset`
const LIVE_QUERY_PARAM = `live`
const CURSOR_QUERY_PARAM = `cursor`

/**
 * Encode data for SSE format.
 * Per SSE spec, each line in the payload needs its own "data:" prefix.
 * Newlines in the payload become separate data: lines.
 */
function encodeSSEData(payload: string): string {
  const lines = payload.split(`\n`)
  return lines.map((line) => `data: ${line}`).join(`\n`) + `\n\n`
}

/**
 * Minimum response size to consider for compression.
 * Responses smaller than this won't benefit from compression.
 */
const COMPRESSION_THRESHOLD = 1024

/**
 * Determine the best compression encoding from Accept-Encoding header.
 * Returns 'gzip', 'deflate', or null if no compression should be used.
 */
function getCompressionEncoding(
  acceptEncoding: string | undefined
): `gzip` | `deflate` | null {
  if (!acceptEncoding) return null

  // Parse Accept-Encoding header (e.g., "gzip, deflate, br" or "gzip;q=1.0, deflate;q=0.5")
  const encodings = acceptEncoding
    .toLowerCase()
    .split(`,`)
    .map((e) => e.trim())

  // Prefer gzip over deflate (better compression, wider support)
  for (const encoding of encodings) {
    const name = encoding.split(`;`)[0]?.trim()
    if (name === `gzip`) return `gzip`
  }
  for (const encoding of encodings) {
    const name = encoding.split(`;`)[0]?.trim()
    if (name === `deflate`) return `deflate`
  }

  return null
}

/**
 * Compress data using the specified encoding.
 */
function compressData(
  data: Uint8Array,
  encoding: `gzip` | `deflate`
): Uint8Array {
  if (encoding === `gzip`) {
    return gzipSync(data)
  } else {
    return deflateSync(data)
  }
}

/**
 * HTTP server for testing durable streams.
 * Supports both in-memory and file-backed storage modes.
 */
/**
 * Configuration for injected faults used to test client retry and resilience behavior.
 *
 * Fault injection allows simulating various server and network failure modes to verify
 * that clients handle errors correctly. Faults can simulate HTTP errors, network delays,
 * connection drops, and data corruption.
 *
 * ## Fault Types
 *
 * Faults can be combined to create complex failure scenarios:
 *
 * - **HTTP Errors**: Return specific status codes (500, 503, 429, etc.)
 * - **Delays**: Add latency before responding (with optional jitter)
 * - **Connection Drops**: Destroy the socket to simulate network failures
 * - **Body Corruption**: Flip random bits in the response body
 * - **Body Truncation**: Return incomplete response bodies
 *
 * ## Fault Lifecycle
 *
 * 1. Faults are registered via {@link DurableStreamTestServer.injectFault}
 * 2. Each matching request decrements the fault's `count`
 * 3. When `count` reaches 0, the fault is automatically removed
 * 4. Faults with `probability < 1.0` only trigger probabilistically
 *
 * ## Method Filtering
 *
 * Faults can target specific HTTP methods using the `method` field.
 * This allows testing method-specific retry behavior (e.g., only fail POST requests).
 *
 * @example
 * ```typescript
 * // Simple 500 error injection
 * server.injectFault('/my-stream', { status: 500 })
 *
 * // Delay with jitter (simulates variable network latency)
 * server.injectFault('/my-stream', { delayMs: 100, jitterMs: 50 })
 *
 * // Connection drop (simulates network failure)
 * server.injectFault('/my-stream', { dropConnection: true })
 *
 * // Combined: delay then error
 * server.injectFault('/my-stream', { delayMs: 200, status: 503 })
 *
 * // Method-specific fault (only affect POST/append)
 * server.injectFault('/my-stream', { status: 503, method: 'POST' })
 *
 * // Probabilistic fault (50% chance of triggering)
 * server.injectFault('/my-stream', { status: 500, probability: 0.5, count: 10 })
 * ```
 */
interface InjectedFault {
  /**
   * HTTP status code to return as an error response.
   *
   * When set, the server returns this status code with a plain text body
   * "Injected error for testing" instead of processing the request.
   *
   * Common values:
   * - `400`: Bad Request (client should not retry)
   * - `404`: Not Found (client should not retry)
   * - `429`: Too Many Requests (client should retry with backoff)
   * - `500`: Internal Server Error (client should retry)
   * - `503`: Service Unavailable (client should retry)
   *
   * @example
   * ```typescript
   * // Return 503 Service Unavailable
   * server.injectFault('/my-stream', { status: 503 })
   * ```
   */
  status?: number

  /**
   * Number of times this fault will trigger before being automatically removed.
   *
   * Each matching request decrements this counter. When it reaches 0, the fault
   * is deleted from the fault map. This allows simulating transient failures
   * that resolve after N retries.
   *
   * @default 1 (when using injectFault method)
   *
   * @example
   * ```typescript
   * // Fail the first 3 requests, then succeed
   * server.injectFault('/my-stream', { status: 500, count: 3 })
   * ```
   */
  count: number

  /**
   * Value for the `Retry-After` response header (in seconds).
   *
   * Only included when `status` is set. Tells the client how long to wait
   * before retrying. Commonly used with 429 (Too Many Requests) or 503
   * (Service Unavailable) status codes.
   *
   * @example
   * ```typescript
   * // Rate limit with 5 second backoff
   * server.injectFault('/my-stream', { status: 429, retryAfter: 5 })
   * ```
   */
  retryAfter?: number

  /**
   * Delay in milliseconds before the server responds.
   *
   * This simulates network latency or slow server processing. The delay
   * is applied before any other fault effects (status codes, body modifications).
   *
   * Can be combined with `jitterMs` to add randomness to the delay.
   *
   * @example
   * ```typescript
   * // Add 500ms latency
   * server.injectFault('/my-stream', { delayMs: 500 })
   *
   * // Variable latency: 300-600ms
   * server.injectFault('/my-stream', { delayMs: 300, jitterMs: 300 })
   * ```
   */
  delayMs?: number

  /**
   * If true, destroy the socket connection after receiving the request.
   *
   * This simulates network failures like connection resets, timeouts, or
   * infrastructure issues. The client will receive a connection error
   * rather than an HTTP response.
   *
   * Note: When `dropConnection` is true, other fault effects (status, body
   * modifications) are ignored since no response is sent.
   *
   * @example
   * ```typescript
   * // Simulate network failure
   * server.injectFault('/my-stream', { dropConnection: true })
   *
   * // Drop after delay (simulates mid-request timeout)
   * server.injectFault('/my-stream', { delayMs: 1000, dropConnection: true })
   * ```
   */
  dropConnection?: boolean

  /**
   * Truncate the response body to this many bytes.
   *
   * This simulates incomplete responses due to connection issues or
   * server crashes. Useful for testing client handling of partial data.
   *
   * Applied after successful request processing but before sending the response.
   * Only affects responses with bodies (not HEAD or 204 responses).
   *
   * @example
   * ```typescript
   * // Return only first 100 bytes of response
   * server.injectFault('/my-stream', { truncateBodyBytes: 100 })
   * ```
   */
  truncateBodyBytes?: number

  /**
   * Probability of triggering this fault (0.0 to 1.0).
   *
   * - `1.0` (default): Always trigger
   * - `0.5`: 50% chance of triggering
   * - `0.0`: Never trigger
   *
   * When the fault doesn't trigger due to probability, the request is
   * processed normally and the fault's `count` is NOT decremented.
   *
   * This is useful for chaos testing where you want intermittent failures
   * over a period of time.
   *
   * @default 1.0
   *
   * @example
   * ```typescript
   * // 20% failure rate for next 100 requests
   * server.injectFault('/my-stream', { status: 500, probability: 0.2, count: 100 })
   * ```
   */
  probability?: number

  /**
   * Only trigger the fault for requests matching this HTTP method.
   *
   * If not set, the fault triggers for all methods. Method comparison
   * is case-insensitive.
   *
   * Common values: `'GET'`, `'POST'`, `'PUT'`, `'DELETE'`, `'HEAD'`
   *
   * @example
   * ```typescript
   * // Only fail append (POST) requests, reads (GET) work normally
   * server.injectFault('/my-stream', { status: 503, method: 'POST' })
   * ```
   */
  method?: string

  /**
   * If true, corrupt the response body by flipping random bits.
   *
   * This simulates data corruption from network issues, faulty hardware,
   * or man-in-the-middle attacks. Approximately 3% of bytes are modified.
   *
   * Useful for testing:
   * - Checksum validation
   * - JSON parsing error handling
   * - Data integrity verification
   *
   * @example
   * ```typescript
   * // Corrupt response data
   * server.injectFault('/my-stream', { corruptBody: true })
   * ```
   */
  corruptBody?: boolean

  /**
   * Random jitter to add to `delayMs` (in milliseconds).
   *
   * The actual delay will be `delayMs + random(0, jitterMs)`. This creates
   * more realistic latency patterns where response times vary.
   *
   * Requires `delayMs` to be set (jitter without base delay has no effect).
   *
   * @example
   * ```typescript
   * // Delay between 100-200ms
   * server.injectFault('/my-stream', { delayMs: 100, jitterMs: 100 })
   * ```
   */
  jitterMs?: number
}

export class DurableStreamTestServer {
  readonly store: StreamStore | FileBackedStreamStore
  private server: Server | null = null
  private options: Required<
    Omit<
      TestServerOptions,
      | `dataDir`
      | `onStreamCreated`
      | `onStreamDeleted`
      | `compression`
      | `cursorIntervalSeconds`
      | `cursorEpoch`
    >
  > & {
    dataDir?: string
    onStreamCreated?: (event: StreamLifecycleEvent) => void | Promise<void>
    onStreamDeleted?: (event: StreamLifecycleEvent) => void | Promise<void>
    compression: boolean
    cursorOptions: CursorOptions
  }
  private _url: string | null = null
  private activeSSEResponses = new Set<ServerResponse>()
  private isShuttingDown = false
  /** Injected faults for testing retry/resilience */
  private injectedFaults = new Map<string, InjectedFault>()

  constructor(options: TestServerOptions = {}) {
    // Choose store based on dataDir option
    if (options.dataDir) {
      this.store = new FileBackedStreamStore({
        dataDir: options.dataDir,
      })
    } else {
      this.store = new StreamStore()
    }

    this.options = {
      port: options.port ?? 4437,
      host: options.host ?? `127.0.0.1`,
      longPollTimeout: options.longPollTimeout ?? 30_000,
      dataDir: options.dataDir,
      onStreamCreated: options.onStreamCreated,
      onStreamDeleted: options.onStreamDeleted,
      compression: options.compression ?? true,
      cursorOptions: {
        intervalSeconds: options.cursorIntervalSeconds,
        epoch: options.cursorEpoch,
      },
    }
  }

  /**
   * Start the server.
   */
  async start(): Promise<string> {
    if (this.server) {
      throw new Error(`Server already started`)
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error(`Request error:`, err)
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": `text/plain` })
            res.end(`Internal server error`)
          }
        })
      })

      this.server.on(`error`, reject)

      this.server.listen(this.options.port, this.options.host, () => {
        const addr = this.server!.address()
        if (typeof addr === `string`) {
          this._url = addr
        } else if (addr) {
          this._url = `http://${this.options.host}:${addr.port}`
        }
        resolve(this._url!)
      })
    })
  }

  /**
   * Stop the server.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    // Mark as shutting down to stop SSE handlers
    this.isShuttingDown = true

    // Cancel all pending long-polls and SSE waits to unblock connection handlers
    if (`cancelAllWaits` in this.store) {
      ;(this.store as { cancelAllWaits: () => void }).cancelAllWaits()
    }

    // Force-close all active SSE connections
    for (const res of this.activeSSEResponses) {
      res.end()
    }
    this.activeSSEResponses.clear()

    return new Promise((resolve, reject) => {
      this.server!.close(async (err) => {
        if (err) {
          reject(err)
          return
        }

        try {
          // Close file-backed store if used
          if (this.store instanceof FileBackedStreamStore) {
            await this.store.close()
          }

          this.server = null
          this._url = null
          this.isShuttingDown = false
          resolve()
        } catch (closeErr) {
          reject(closeErr)
        }
      })
    })
  }

  /**
   * Get the server URL.
   */
  get url(): string {
    if (!this._url) {
      throw new Error(`Server not started`)
    }
    return this._url
  }

  /**
   * Clear all streams.
   */
  clear(): void {
    this.store.clear()
  }

  /**
   * Inject an HTTP error to be returned on the next N requests to a path.
   *
   * @deprecated Use {@link injectFault} for full fault injection capabilities
   * including delays, connection drops, body corruption, and more.
   *
   * @param path - The stream path to inject the error for (e.g., '/my-stream')
   * @param status - HTTP status code to return (e.g., 500, 503)
   * @param count - Number of times to return this error (default: 1)
   * @param retryAfter - Optional Retry-After header value in seconds
   *
   * @example
   * ```typescript
   * // Return 500 error on next request
   * server.injectError('/my-stream', 500)
   *
   * // Return 429 with Retry-After header
   * server.injectError('/my-stream', 429, 1, 5)
   * ```
   */
  injectError(
    path: string,
    status: number,
    count: number = 1,
    retryAfter?: number
  ): void {
    this.injectedFaults.set(path, { status, count, retryAfter })
  }

  /**
   * Inject a fault to be triggered on requests to a specific path.
   *
   * This is the primary API for testing client resilience. Faults can simulate
   * various failure modes including HTTP errors, network delays, connection drops,
   * and data corruption.
   *
   * ## Fault Matching
   *
   * Faults are matched by exact path. Only one fault can be active per path at
   * a time - calling `injectFault` again for the same path replaces any existing
   * fault.
   *
   * ## Fault Consumption
   *
   * - Each matching request decrements the fault's `count`
   * - When `count` reaches 0, the fault is automatically removed
   * - If `probability` is set, the fault only triggers probabilistically
   * - When probability check fails, `count` is NOT decremented
   *
   * ## Fault Ordering
   *
   * When a fault is triggered, effects are applied in this order:
   * 1. Delay (if `delayMs` is set)
   * 2. Connection drop (if `dropConnection` is true) - returns early
   * 3. HTTP error response (if `status` is set) - returns early
   * 4. Body modifications (truncation, corruption) - applied to normal response
   *
   * @param path - The stream path to inject the fault for (e.g., '/my-stream')
   * @param fault - Fault configuration (see {@link InjectedFault} for options)
   *
   * @example
   * ```typescript
   * // Basic HTTP error
   * server.injectFault('/my-stream', { status: 503 })
   *
   * // Multiple consecutive errors
   * server.injectFault('/my-stream', { status: 500, count: 3 })
   *
   * // Rate limiting with Retry-After
   * server.injectFault('/my-stream', { status: 429, retryAfter: 5 })
   *
   * // Simulate network latency
   * server.injectFault('/my-stream', { delayMs: 1000 })
   *
   * // Variable latency (500-1000ms)
   * server.injectFault('/my-stream', { delayMs: 500, jitterMs: 500 })
   *
   * // Connection drop (network failure)
   * server.injectFault('/my-stream', { dropConnection: true, count: 2 })
   *
   * // Delay then error
   * server.injectFault('/my-stream', { delayMs: 200, status: 503 })
   *
   * // Method-specific fault (only POST requests)
   * server.injectFault('/my-stream', { status: 503, method: 'POST' })
   *
   * // Probabilistic fault (20% chance over next 100 requests)
   * server.injectFault('/my-stream', {
   *   status: 500,
   *   probability: 0.2,
   *   count: 100
   * })
   *
   * // Corrupt response body
   * server.injectFault('/my-stream', { corruptBody: true })
   *
   * // Truncate response (partial data)
   * server.injectFault('/my-stream', { truncateBodyBytes: 50 })
   * ```
   */
  injectFault(
    path: string,
    fault: Omit<InjectedFault, `count`> & { count?: number }
  ): void {
    this.injectedFaults.set(path, { count: 1, ...fault })
  }

  /**
   * Remove all injected faults.
   *
   * Call this in test cleanup to ensure faults from one test don't affect
   * subsequent tests. This is especially important when tests share a server
   * instance.
   *
   * @example
   * ```typescript
   * // In test teardown
   * afterEach(() => {
   *   server.clearInjectedFaults()
   * })
   *
   * // Or after a specific test scenario
   * test('retry behavior', async () => {
   *   server.injectFault('/my-stream', { status: 500, count: 2 })
   *   // ... test code ...
   *   server.clearInjectedFaults()
   * })
   * ```
   */
  clearInjectedFaults(): void {
    this.injectedFaults.clear()
  }

  /**
   * Check if there's an injected fault for this path/method and consume it.
   *
   * This method implements the fault matching and consumption logic:
   * 1. Looks up fault by exact path match
   * 2. Checks HTTP method filter (if configured)
   * 3. Applies probability check (if configured)
   * 4. Decrements count and removes fault when exhausted
   *
   * The fault is only "consumed" (count decremented) if it passes all checks.
   * This ensures probabilistic faults don't get removed before their intended
   * number of actual triggers.
   *
   * @param path - The request path to check for faults
   * @param method - The HTTP method of the request (GET, POST, etc.)
   * @returns The fault config if triggered, null if no fault or checks failed
   *
   * @internal
   */
  private consumeInjectedFault(
    path: string,
    method: string
  ): InjectedFault | null {
    const fault = this.injectedFaults.get(path)
    if (!fault) return null

    // Check method filter
    if (fault.method && fault.method.toUpperCase() !== method.toUpperCase()) {
      return null
    }

    // Check probability
    if (fault.probability !== undefined && Math.random() > fault.probability) {
      return null
    }

    fault.count--
    if (fault.count <= 0) {
      this.injectedFaults.delete(path)
    }

    return fault
  }

  /**
   * Apply the delay configured in a fault (including random jitter).
   *
   * The actual delay is calculated as: `delayMs + random(0, jitterMs)`
   *
   * This is the first effect applied when a fault is triggered, allowing
   * simulation of slow responses before any error or body modification.
   *
   * @param fault - The fault configuration containing delay settings
   *
   * @internal
   */
  private async applyFaultDelay(fault: InjectedFault): Promise<void> {
    if (fault.delayMs !== undefined && fault.delayMs > 0) {
      const jitter = fault.jitterMs ? Math.random() * fault.jitterMs : 0
      await new Promise((resolve) =>
        setTimeout(resolve, fault.delayMs! + jitter)
      )
    }
  }

  /**
   * Apply body modifications (truncation and/or corruption) from a stored fault.
   *
   * This method checks for a fault stored on the response object (set earlier
   * in request handling) and applies any body modifications:
   *
   * - **Truncation**: Slices the body to `truncateBodyBytes` length
   * - **Corruption**: Flips random bits in ~3% of bytes
   *
   * Truncation is applied before corruption if both are configured.
   *
   * @param res - The ServerResponse object (may have `_injectedFault` attached)
   * @param body - The original response body
   * @returns The modified body, or original if no modifications configured
   *
   * @internal
   */
  private applyFaultBodyModification(
    res: ServerResponse,
    body: Uint8Array
  ): Uint8Array {
    const fault = (res as ServerResponse & { _injectedFault?: InjectedFault })
      ._injectedFault
    if (!fault) return body

    let modified = body

    // Truncate body if configured
    if (
      fault.truncateBodyBytes !== undefined &&
      modified.length > fault.truncateBodyBytes
    ) {
      modified = modified.slice(0, fault.truncateBodyBytes)
    }

    // Corrupt body if configured (flip random bits)
    if (fault.corruptBody && modified.length > 0) {
      modified = new Uint8Array(modified) // Make a copy to avoid mutating original
      // Flip 1-5% of bytes
      const numCorrupt = Math.max(1, Math.floor(modified.length * 0.03))
      for (let i = 0; i < numCorrupt; i++) {
        const pos = Math.floor(Math.random() * modified.length)
        modified[pos] = modified[pos]! ^ (1 << Math.floor(Math.random() * 8))
      }
    }

    return modified
  }

  // ============================================================================
  // Request handling
  // ============================================================================

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? `/`, `http://${req.headers.host}`)
    const path = url.pathname
    const method = req.method?.toUpperCase()

    // CORS headers for browser testing
    res.setHeader(`access-control-allow-origin`, `*`)
    res.setHeader(
      `access-control-allow-methods`,
      `GET, POST, PUT, DELETE, HEAD, OPTIONS`
    )
    res.setHeader(
      `access-control-allow-headers`,
      `content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At`
    )
    res.setHeader(
      `access-control-expose-headers`,
      `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, etag, content-type, content-encoding, vary`
    )

    // Browser security headers (Protocol Section 10.7)
    res.setHeader(`x-content-type-options`, `nosniff`)
    res.setHeader(`cross-origin-resource-policy`, `cross-origin`)

    // Handle CORS preflight
    if (method === `OPTIONS`) {
      res.writeHead(204)
      res.end()
      return
    }

    // Handle test control endpoints (for error injection)
    if (path === `/_test/inject-error`) {
      await this.handleTestInjectError(method, req, res)
      return
    }

    // Check for injected faults (for testing retry/resilience)
    const fault = this.consumeInjectedFault(path, method ?? `GET`)
    if (fault) {
      // Apply delay if configured
      await this.applyFaultDelay(fault)

      // Drop connection if configured (simulates network failure)
      if (fault.dropConnection) {
        res.socket?.destroy()
        return
      }

      // If status is set, return an error response
      if (fault.status !== undefined) {
        const headers: Record<string, string> = {
          "content-type": `text/plain`,
        }
        if (fault.retryAfter !== undefined) {
          headers[`retry-after`] = fault.retryAfter.toString()
        }
        res.writeHead(fault.status, headers)
        res.end(`Injected error for testing`)
        return
      }

      // Store fault for response modification (truncation, corruption)
      if (fault.truncateBodyBytes !== undefined || fault.corruptBody) {
        ;(
          res as ServerResponse & { _injectedFault?: InjectedFault }
        )._injectedFault = fault
      }
    }

    try {
      switch (method) {
        case `PUT`:
          await this.handleCreate(path, req, res)
          break
        case `HEAD`:
          this.handleHead(path, res)
          break
        case `GET`:
          await this.handleRead(path, url, req, res)
          break
        case `POST`:
          await this.handleAppend(path, req, res)
          break
        case `DELETE`:
          await this.handleDelete(path, res)
          break
        default:
          res.writeHead(405, { "content-type": `text/plain` })
          res.end(`Method not allowed`)
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes(`not found`)) {
          res.writeHead(404, { "content-type": `text/plain` })
          res.end(`Stream not found`)
        } else if (
          err.message.includes(`already exists with different configuration`)
        ) {
          res.writeHead(409, { "content-type": `text/plain` })
          res.end(`Stream already exists with different configuration`)
        } else if (err.message.includes(`Sequence conflict`)) {
          res.writeHead(409, { "content-type": `text/plain` })
          res.end(`Sequence conflict`)
        } else if (err.message.includes(`Content-type mismatch`)) {
          res.writeHead(409, { "content-type": `text/plain` })
          res.end(`Content-type mismatch`)
        } else if (err.message.includes(`Invalid JSON`)) {
          res.writeHead(400, { "content-type": `text/plain` })
          res.end(`Invalid JSON`)
        } else if (err.message.includes(`Empty arrays are not allowed`)) {
          res.writeHead(400, { "content-type": `text/plain` })
          res.end(`Empty arrays are not allowed`)
        } else {
          throw err
        }
      } else {
        throw err
      }
    }
  }

  /**
   * Handle PUT - create stream
   */
  private async handleCreate(
    path: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    let contentType = req.headers[`content-type`]

    // Sanitize content-type: if empty or invalid, use default
    if (
      !contentType ||
      contentType.trim() === `` ||
      !/^[\w-]+\/[\w-]+/.test(contentType)
    ) {
      contentType = `application/octet-stream`
    }

    const ttlHeader = req.headers[STREAM_TTL_HEADER.toLowerCase()] as
      | string
      | undefined
    const expiresAtHeader = req.headers[
      STREAM_EXPIRES_AT_HEADER.toLowerCase()
    ] as string | undefined

    // Validate TTL and Expires-At headers
    if (ttlHeader && expiresAtHeader) {
      res.writeHead(400, { "content-type": `text/plain` })
      res.end(`Cannot specify both Stream-TTL and Stream-Expires-At`)
      return
    }

    let ttlSeconds: number | undefined
    if (ttlHeader) {
      // Strict TTL validation: must be a positive integer without leading zeros,
      // plus signs, decimals, whitespace, or non-decimal notation
      const ttlPattern = /^(0|[1-9]\d*)$/
      if (!ttlPattern.test(ttlHeader)) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid Stream-TTL value`)
        return
      }

      ttlSeconds = parseInt(ttlHeader, 10)
      if (isNaN(ttlSeconds) || ttlSeconds < 0) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid Stream-TTL value`)
        return
      }
    }

    // Validate Expires-At timestamp format (ISO 8601)
    if (expiresAtHeader) {
      const timestamp = new Date(expiresAtHeader)
      if (isNaN(timestamp.getTime())) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid Stream-Expires-At timestamp`)
        return
      }
    }

    // Read body if present
    const body = await this.readBody(req)

    const isNew = !this.store.has(path)

    // Support both sync (StreamStore) and async (FileBackedStreamStore) create
    await Promise.resolve(
      this.store.create(path, {
        contentType,
        ttlSeconds,
        expiresAt: expiresAtHeader,
        initialData: body.length > 0 ? body : undefined,
      })
    )

    const stream = this.store.get(path)!

    // Call lifecycle hook for new streams
    if (isNew && this.options.onStreamCreated) {
      await Promise.resolve(
        this.options.onStreamCreated({
          type: `created`,
          path,
          contentType,
          timestamp: Date.now(),
        })
      )
    }

    // Return 201 for new streams, 200 for idempotent creates
    const headers: Record<string, string> = {
      "content-type": contentType,
      [STREAM_OFFSET_HEADER]: stream.currentOffset,
    }

    // Add Location header for 201 Created responses
    if (isNew) {
      headers[`location`] = `${this._url}${path}`
    }

    res.writeHead(isNew ? 201 : 200, headers)
    res.end()
  }

  /**
   * Handle HEAD - get metadata
   */
  private handleHead(path: string, res: ServerResponse): void {
    const stream = this.store.get(path)
    if (!stream) {
      res.writeHead(404, { "content-type": `text/plain` })
      res.end()
      return
    }

    const headers: Record<string, string> = {
      [STREAM_OFFSET_HEADER]: stream.currentOffset,
      // HEAD responses should not be cached to avoid stale tail offsets (Protocol Section 5.4)
      "cache-control": `no-store`,
    }

    if (stream.contentType) {
      headers[`content-type`] = stream.contentType
    }

    // Generate ETag: {path}:-1:{offset} (consistent with GET format)
    headers[`etag`] =
      `"${Buffer.from(path).toString(`base64`)}:-1:${stream.currentOffset}"`

    res.writeHead(200, headers)
    res.end()
  }

  /**
   * Handle GET - read data
   */
  private async handleRead(
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const stream = this.store.get(path)
    if (!stream) {
      res.writeHead(404, { "content-type": `text/plain` })
      res.end(`Stream not found`)
      return
    }

    const offset = url.searchParams.get(OFFSET_QUERY_PARAM) ?? undefined
    const live = url.searchParams.get(LIVE_QUERY_PARAM)
    const cursor = url.searchParams.get(CURSOR_QUERY_PARAM) ?? undefined

    // Validate offset parameter
    if (offset !== undefined) {
      // Reject empty offset
      if (offset === ``) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Empty offset parameter`)
        return
      }

      // Reject multiple offset parameters
      const allOffsets = url.searchParams.getAll(OFFSET_QUERY_PARAM)
      if (allOffsets.length > 1) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Multiple offset parameters not allowed`)
        return
      }

      // Validate offset format: must be "-1" or match our offset format (digits_digits)
      // This prevents path traversal, injection attacks, and invalid characters
      const validOffsetPattern = /^(-1|\d+_\d+)$/
      if (!validOffsetPattern.test(offset)) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid offset format`)
        return
      }
    }

    // Require offset parameter for long-poll and SSE per protocol spec
    if ((live === `long-poll` || live === `sse`) && !offset) {
      res.writeHead(400, { "content-type": `text/plain` })
      res.end(
        `${live === `sse` ? `SSE` : `Long-poll`} requires offset parameter`
      )
      return
    }

    // Handle SSE mode
    if (live === `sse`) {
      await this.handleSSE(path, stream, offset!, cursor, res)
      return
    }

    // Read current messages
    let { messages, upToDate } = this.store.read(path, offset)

    // Only wait in long-poll if:
    // 1. long-poll mode is enabled
    // 2. Client provided an offset (not first request)
    // 3. Client's offset matches current offset (already caught up)
    // 4. No new messages
    const clientIsCaughtUp = offset && offset === stream.currentOffset
    if (live === `long-poll` && clientIsCaughtUp && messages.length === 0) {
      const result = await this.store.waitForMessages(
        path,
        offset,
        this.options.longPollTimeout
      )

      if (result.timedOut) {
        // Return 204 No Content on timeout (per Protocol Section 5.6)
        // Generate cursor for CDN cache collapsing (Protocol Section 8.1)
        const responseCursor = generateResponseCursor(
          cursor,
          this.options.cursorOptions
        )
        res.writeHead(204, {
          [STREAM_OFFSET_HEADER]: offset,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
          [STREAM_CURSOR_HEADER]: responseCursor,
        })
        res.end()
        return
      }

      messages = result.messages
      upToDate = true
    }

    // Build response
    const headers: Record<string, string> = {}

    if (stream.contentType) {
      headers[`content-type`] = stream.contentType
    }

    // Set offset header to the last message's offset, or current if no messages
    const lastMessage = messages[messages.length - 1]
    const responseOffset = lastMessage?.offset ?? stream.currentOffset
    headers[STREAM_OFFSET_HEADER] = responseOffset

    // Generate cursor for live mode responses (Protocol Section 8.1)
    if (live === `long-poll`) {
      headers[STREAM_CURSOR_HEADER] = generateResponseCursor(
        cursor,
        this.options.cursorOptions
      )
    }

    // Set up-to-date header
    if (upToDate) {
      headers[STREAM_UP_TO_DATE_HEADER] = `true`
    }

    // Generate ETag: based on path, start offset, and end offset
    const startOffset = offset ?? `-1`
    const etag = `"${Buffer.from(path).toString(`base64`)}:${startOffset}:${responseOffset}"`
    headers[`etag`] = etag

    // Check If-None-Match for conditional GET (Protocol Section 8.1)
    const ifNoneMatch = req.headers[`if-none-match`]
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, { etag })
      res.end()
      return
    }

    // Format response (wraps JSON in array brackets)
    const responseData = this.store.formatResponse(path, messages)

    // Apply compression if enabled and response is large enough
    let finalData: Uint8Array = responseData
    if (
      this.options.compression &&
      responseData.length >= COMPRESSION_THRESHOLD
    ) {
      const acceptEncoding = req.headers[`accept-encoding`]
      const encoding = getCompressionEncoding(acceptEncoding)
      if (encoding) {
        finalData = compressData(responseData, encoding)
        headers[`content-encoding`] = encoding
        // Add Vary header to indicate response varies by Accept-Encoding
        headers[`vary`] = `accept-encoding`
      }
    }

    // Apply fault body modifications (truncation, corruption) if configured
    finalData = this.applyFaultBodyModification(res, finalData)

    res.writeHead(200, headers)
    res.end(Buffer.from(finalData))
  }

  /**
   * Handle SSE (Server-Sent Events) mode
   */
  private async handleSSE(
    path: string,
    stream: ReturnType<StreamStore[`get`]>,
    initialOffset: string,
    cursor: string | undefined,
    res: ServerResponse
  ): Promise<void> {
    // Track this SSE connection
    this.activeSSEResponses.add(res)

    // Set SSE headers (explicitly including security headers for clarity)
    res.writeHead(200, {
      "content-type": `text/event-stream`,
      "cache-control": `no-cache`,
      connection: `keep-alive`,
      "access-control-allow-origin": `*`,
      "x-content-type-options": `nosniff`,
      "cross-origin-resource-policy": `cross-origin`,
    })

    let currentOffset = initialOffset
    let isConnected = true
    const decoder = new TextDecoder()

    // Handle client disconnect
    res.on(`close`, () => {
      isConnected = false
      this.activeSSEResponses.delete(res)
    })

    // Get content type for formatting
    const isJsonStream = stream?.contentType?.includes(`application/json`)

    // Send initial data and then wait for more
    // Note: isConnected and isShuttingDown can change asynchronously
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (isConnected && !this.isShuttingDown) {
      // Read current messages from offset
      const { messages, upToDate } = this.store.read(path, currentOffset)

      // Send data events for each message
      for (const message of messages) {
        // Format data based on content type
        let dataPayload: string
        if (isJsonStream) {
          // Use formatResponse to get properly formatted JSON (strips trailing commas)
          const jsonBytes = this.store.formatResponse(path, [message])
          dataPayload = decoder.decode(jsonBytes)
        } else {
          dataPayload = decoder.decode(message.data)
        }

        // Send data event - encode multiline payloads per SSE spec
        // Each line in the payload needs its own "data:" prefix
        res.write(`event: data\n`)
        res.write(encodeSSEData(dataPayload))

        currentOffset = message.offset
      }

      // Compute offset the same way as HTTP GET: last message's offset, or stream's current offset
      const controlOffset =
        messages[messages.length - 1]?.offset ?? stream!.currentOffset

      // Send control event with current offset/cursor (Protocol Section 5.7)
      // Generate cursor for CDN cache collapsing (Protocol Section 8.1)
      const responseCursor = generateResponseCursor(
        cursor,
        this.options.cursorOptions
      )
      const controlData: Record<string, string | boolean> = {
        [SSE_OFFSET_FIELD]: controlOffset,
        [SSE_CURSOR_FIELD]: responseCursor,
      }

      // Include upToDate flag when client has caught up to head
      if (upToDate) {
        controlData[SSE_UP_TO_DATE_FIELD] = true
      }

      res.write(`event: control\n`)
      res.write(encodeSSEData(JSON.stringify(controlData)))

      // Update currentOffset for next iteration (use controlOffset for consistency)
      currentOffset = controlOffset

      // If caught up, wait for new messages
      if (upToDate) {
        const result = await this.store.waitForMessages(
          path,
          currentOffset,
          this.options.longPollTimeout
        )

        // Check if we should exit after wait returns (values can change during await)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.isShuttingDown || !isConnected) break

        if (result.timedOut) {
          // Send keep-alive control event on timeout (Protocol Section 5.7)
          // Generate cursor for CDN cache collapsing (Protocol Section 8.1)
          const keepAliveCursor = generateResponseCursor(
            cursor,
            this.options.cursorOptions
          )
          const keepAliveData: Record<string, string | boolean> = {
            [SSE_OFFSET_FIELD]: currentOffset,
            [SSE_CURSOR_FIELD]: keepAliveCursor,
            [SSE_UP_TO_DATE_FIELD]: true, // Still caught up after timeout
          }
          res.write(`event: control\n`)
          res.write(encodeSSEData(JSON.stringify(keepAliveData)))
        }
        // Loop will continue and read new messages
      }
    }

    this.activeSSEResponses.delete(res)
    res.end()
  }

  /**
   * Handle POST - append data
   */
  private async handleAppend(
    path: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const contentType = req.headers[`content-type`]
    const seq = req.headers[STREAM_SEQ_HEADER.toLowerCase()] as
      | string
      | undefined

    const body = await this.readBody(req)

    if (body.length === 0) {
      res.writeHead(400, { "content-type": `text/plain` })
      res.end(`Empty body`)
      return
    }

    // Content-Type is required per protocol
    if (!contentType) {
      res.writeHead(400, { "content-type": `text/plain` })
      res.end(`Content-Type header is required`)
      return
    }

    // Support both sync (StreamStore) and async (FileBackedStreamStore) append
    // Note: append returns null only for empty arrays with isInitialCreate=true,
    // which doesn't apply to POST requests (those throw on empty arrays)
    const message = await Promise.resolve(
      this.store.append(path, body, { seq, contentType })
    )

    res.writeHead(204, {
      [STREAM_OFFSET_HEADER]: message!.offset,
    })
    res.end()
  }

  /**
   * Handle DELETE - delete stream
   */
  private async handleDelete(path: string, res: ServerResponse): Promise<void> {
    if (!this.store.has(path)) {
      res.writeHead(404, { "content-type": `text/plain` })
      res.end(`Stream not found`)
      return
    }

    this.store.delete(path)

    // Call lifecycle hook
    if (this.options.onStreamDeleted) {
      await Promise.resolve(
        this.options.onStreamDeleted({
          type: `deleted`,
          path,
          timestamp: Date.now(),
        })
      )
    }

    res.writeHead(204)
    res.end()
  }

  /**
   * Handle test control endpoints for error injection.
   * POST /_test/inject-error - inject an error
   * DELETE /_test/inject-error - clear all injected errors
   */
  private async handleTestInjectError(
    method: string | undefined,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (method === `POST`) {
      const body = await this.readBody(req)
      try {
        const config = JSON.parse(new TextDecoder().decode(body)) as {
          path: string
          // Legacy fields (still supported)
          status?: number
          count?: number
          retryAfter?: number
          // New fault injection fields
          delayMs?: number
          dropConnection?: boolean
          truncateBodyBytes?: number
          probability?: number
          method?: string
          corruptBody?: boolean
          jitterMs?: number
        }

        if (!config.path) {
          res.writeHead(400, { "content-type": `text/plain` })
          res.end(`Missing required field: path`)
          return
        }

        // Must have at least one fault type specified
        const hasFaultType =
          config.status !== undefined ||
          config.delayMs !== undefined ||
          config.dropConnection ||
          config.truncateBodyBytes !== undefined ||
          config.corruptBody
        if (!hasFaultType) {
          res.writeHead(400, { "content-type": `text/plain` })
          res.end(
            `Must specify at least one fault type: status, delayMs, dropConnection, truncateBodyBytes, or corruptBody`
          )
          return
        }

        this.injectFault(config.path, {
          status: config.status,
          count: config.count ?? 1,
          retryAfter: config.retryAfter,
          delayMs: config.delayMs,
          dropConnection: config.dropConnection,
          truncateBodyBytes: config.truncateBodyBytes,
          probability: config.probability,
          method: config.method,
          corruptBody: config.corruptBody,
          jitterMs: config.jitterMs,
        })

        res.writeHead(200, { "content-type": `application/json` })
        res.end(JSON.stringify({ ok: true }))
      } catch {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid JSON body`)
      }
    } else if (method === `DELETE`) {
      this.clearInjectedFaults()
      res.writeHead(200, { "content-type": `application/json` })
      res.end(JSON.stringify({ ok: true }))
    } else {
      res.writeHead(405, { "content-type": `text/plain` })
      res.end(`Method not allowed`)
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private readBody(req: IncomingMessage): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const chunks: Array<Buffer> = []

      req.on(`data`, (chunk: Buffer) => {
        chunks.push(chunk)
      })

      req.on(`end`, () => {
        const body = Buffer.concat(chunks)
        resolve(new Uint8Array(body))
      })

      req.on(`error`, reject)
    })
  }
}
