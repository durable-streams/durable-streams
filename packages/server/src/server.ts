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

// Idempotent producer headers
const PRODUCER_ID_HEADER = `Producer-Id`
const PRODUCER_EPOCH_HEADER = `Producer-Epoch`
const PRODUCER_SEQ_HEADER = `Producer-Seq`
const PRODUCER_EXPECTED_SEQ_HEADER = `Producer-Expected-Seq`
const PRODUCER_RECEIVED_SEQ_HEADER = `Producer-Received-Seq`

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
 * Line terminators in the payload (CR, LF, or CRLF) become separate data: lines.
 * This prevents CRLF injection attacks where malicious payloads could inject
 * fake SSE events using CR-only line terminators.
 *
 * Note: We don't add a space after "data:" because clients strip exactly one
 * leading space per the SSE spec. Adding one would cause data starting with
 * spaces to lose an extra space character.
 */
function encodeSSEData(payload: string): string {
  // Split on all SSE-valid line terminators: CRLF, CR, or LF
  // Order matters: \r\n must be matched before \r alone
  const lines = payload.split(/\r\n|\r|\n/)
  return lines.map((line) => `data:${line}`).join(`\n`) + `\n\n`
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
 * Configuration for injected faults (for testing retry/resilience).
 * Supports various fault types beyond simple HTTP errors.
 */
interface InjectedFault {
  /** HTTP status code to return (if set, returns error response) */
  status?: number
  /** Number of times to trigger this fault (decremented on each use) */
  count: number
  /** Optional Retry-After header value (seconds) */
  retryAfter?: number
  /** Delay in milliseconds before responding */
  delayMs?: number
  /** Drop the connection after sending headers (simulates network failure) */
  dropConnection?: boolean
  /** Truncate response body to this many bytes */
  truncateBodyBytes?: number
  /** Probability of triggering fault (0-1, default 1.0 = always) */
  probability?: number
  /** Only match specific HTTP method (GET, POST, PUT, DELETE) */
  method?: string
  /** Corrupt the response body by flipping random bits */
  corruptBody?: boolean
  /** Add jitter to delay (random 0-jitterMs added to delayMs) */
  jitterMs?: number
  /** Inject an SSE event with custom type and data (for testing SSE parsing) */
  injectSseEvent?: {
    /** Event type (e.g., "unknown", "control", "data") */
    eventType: string
    /** Event data (will be sent as-is) */
    data: string
  }
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
   * Inject an error to be returned on the next N requests to a path.
   * Used for testing retry/resilience behavior.
   * @deprecated Use injectFault for full fault injection capabilities
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
   * Inject a fault to be triggered on the next N requests to a path.
   * Supports various fault types: delays, connection drops, body corruption, etc.
   */
  injectFault(
    path: string,
    fault: Omit<InjectedFault, `count`> & { count?: number }
  ): void {
    this.injectedFaults.set(path, { count: 1, ...fault })
  }

  /**
   * Clear all injected faults.
   */
  clearInjectedFaults(): void {
    this.injectedFaults.clear()
  }

  /**
   * Check if there's an injected fault for this path/method and consume it.
   * Returns the fault config if one should be triggered, null otherwise.
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
   * Apply delay from fault config (including jitter).
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
   * Apply body modifications from stored fault (truncation, corruption).
   * Returns modified body, or original if no modifications needed.
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

    // Corrupt body if configured - deterministically break JSON structure
    if (fault.corruptBody && modified.length > 0) {
      modified = new Uint8Array(modified) // Make a copy to avoid mutating original
      // Always corrupt the first byte (breaks JSON structure - the opening [ or {)
      // and add some random corruption for good measure
      modified[0] = 0x58 // 'X' - makes JSON syntactically invalid
      if (modified.length > 1) {
        modified[1] = 0x59 // 'Y'
      }
      // Also corrupt some bytes in the middle to catch edge cases
      const numCorrupt = Math.max(1, Math.floor(modified.length * 0.1))
      for (let i = 0; i < numCorrupt; i++) {
        const pos = Math.floor(Math.random() * modified.length)
        modified[pos] = 0x5a // 'Z' - valid UTF-8 but breaks JSON structure
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
      `content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Producer-Id, Producer-Epoch, Producer-Seq`
    )
    res.setHeader(
      `access-control-expose-headers`,
      `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary`
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

      // Store fault for response modification (truncation, corruption, SSE injection)
      if (
        fault.truncateBodyBytes !== undefined ||
        fault.corruptBody ||
        fault.injectSseEvent
      ) {
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

      // Validate offset format: must be "-1", "now", or match our offset format (digits_digits)
      // This prevents path traversal, injection attacks, and invalid characters
      const validOffsetPattern = /^(-1|now|\d+_\d+)$/
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
      // For SSE with offset=now, convert to actual tail offset
      const sseOffset = offset === `now` ? stream.currentOffset : offset!
      await this.handleSSE(path, stream, sseOffset, cursor, res)
      return
    }

    // For offset=now, convert to actual tail offset
    // This allows long-poll to immediately start waiting for new data
    const effectiveOffset = offset === `now` ? stream.currentOffset : offset

    // Handle catch-up mode offset=now: return empty response with tail offset
    // For long-poll mode, we fall through to wait for new data instead
    if (offset === `now` && live !== `long-poll`) {
      const headers: Record<string, string> = {
        [STREAM_OFFSET_HEADER]: stream.currentOffset,
        [STREAM_UP_TO_DATE_HEADER]: `true`,
        // Prevent caching - tail offset changes with each append
        [`cache-control`]: `no-store`,
      }

      if (stream.contentType) {
        headers[`content-type`] = stream.contentType
      }

      // No ETag for offset=now responses - Cache-Control: no-store makes ETag unnecessary
      // and some CDNs may behave unexpectedly with both headers

      // For JSON mode, return empty array; otherwise empty body
      const isJsonMode = stream.contentType?.includes(`application/json`)
      const responseBody = isJsonMode ? `[]` : ``

      res.writeHead(200, headers)
      res.end(responseBody)
      return
    }

    // Read current messages
    let { messages, upToDate } = this.store.read(path, effectiveOffset)

    // Only wait in long-poll if:
    // 1. long-poll mode is enabled
    // 2. Client provided an offset (not first request) OR used offset=now
    // 3. Client's offset matches current offset (already caught up)
    // 4. No new messages
    const clientIsCaughtUp =
      (effectiveOffset && effectiveOffset === stream.currentOffset) ||
      offset === `now`
    if (live === `long-poll` && clientIsCaughtUp && messages.length === 0) {
      const result = await this.store.waitForMessages(
        path,
        effectiveOffset ?? stream.currentOffset,
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
          [STREAM_OFFSET_HEADER]: effectiveOffset ?? stream.currentOffset,
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

    // Check for injected SSE event (for testing SSE parsing)
    const fault = (res as ServerResponse & { _injectedFault?: InjectedFault })
      ._injectedFault
    if (fault?.injectSseEvent) {
      // Send the injected SSE event before normal stream
      res.write(`event: ${fault.injectSseEvent.eventType}\n`)
      res.write(`data: ${fault.injectSseEvent.data}\n\n`)
    }

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

    // Extract producer headers
    const producerId = req.headers[PRODUCER_ID_HEADER.toLowerCase()] as
      | string
      | undefined
    const producerEpochStr = req.headers[
      PRODUCER_EPOCH_HEADER.toLowerCase()
    ] as string | undefined
    const producerSeqStr = req.headers[PRODUCER_SEQ_HEADER.toLowerCase()] as
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

    // Validate producer headers - all three must be present together or none
    // Also reject empty producer ID
    const hasProducerHeaders =
      producerId !== undefined ||
      producerEpochStr !== undefined ||
      producerSeqStr !== undefined
    const hasAllProducerHeaders =
      producerId !== undefined &&
      producerEpochStr !== undefined &&
      producerSeqStr !== undefined

    if (hasProducerHeaders && !hasAllProducerHeaders) {
      res.writeHead(400, { "content-type": `text/plain` })
      res.end(
        `All producer headers (Producer-Id, Producer-Epoch, Producer-Seq) must be provided together`
      )
      return
    }

    if (hasAllProducerHeaders && producerId === ``) {
      res.writeHead(400, { "content-type": `text/plain` })
      res.end(`Invalid Producer-Id: must not be empty`)
      return
    }

    // Parse and validate producer epoch and seq as integers
    // Use strict digit-only validation to reject values like "1abc" or "1e3"
    const STRICT_INTEGER_REGEX = /^\d+$/
    let producerEpoch: number | undefined
    let producerSeq: number | undefined
    if (hasAllProducerHeaders) {
      if (!STRICT_INTEGER_REGEX.test(producerEpochStr)) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid Producer-Epoch: must be a non-negative integer`)
        return
      }
      producerEpoch = Number(producerEpochStr)
      if (!Number.isSafeInteger(producerEpoch)) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid Producer-Epoch: must be a non-negative integer`)
        return
      }

      if (!STRICT_INTEGER_REGEX.test(producerSeqStr)) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid Producer-Seq: must be a non-negative integer`)
        return
      }
      producerSeq = Number(producerSeqStr)
      if (!Number.isSafeInteger(producerSeq)) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid Producer-Seq: must be a non-negative integer`)
        return
      }
    }

    // Build append options
    const appendOptions = {
      seq,
      contentType,
      producerId,
      producerEpoch,
      producerSeq,
    }

    // Use appendWithProducer for serialized producer operations
    let result
    if (producerId !== undefined) {
      result = await this.store.appendWithProducer(path, body, appendOptions)
    } else {
      result = await Promise.resolve(
        this.store.append(path, body, appendOptions)
      )
    }

    // Handle AppendResult with producer validation
    if (result && typeof result === `object` && `producerResult` in result) {
      const { message, producerResult } = result

      if (!producerResult || producerResult.status === `accepted`) {
        // Success - return offset
        const responseHeaders: Record<string, string> = {
          [STREAM_OFFSET_HEADER]: message!.offset,
        }
        // Echo back the producer epoch and seq (highest accepted)
        if (producerEpoch !== undefined) {
          responseHeaders[PRODUCER_EPOCH_HEADER] = producerEpoch.toString()
        }
        if (producerSeq !== undefined) {
          responseHeaders[PRODUCER_SEQ_HEADER] = producerSeq.toString()
        }
        res.writeHead(200, responseHeaders)
        res.end()
        return
      }

      // Handle producer validation failures
      switch (producerResult.status) {
        case `duplicate`:
          // 204 No Content for duplicates (idempotent success)
          // Return Producer-Seq as highest accepted (per PROTOCOL.md)
          res.writeHead(204, {
            [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
            [PRODUCER_SEQ_HEADER]: producerResult.lastSeq.toString(),
          })
          res.end()
          return

        case `stale_epoch`: {
          // 403 Forbidden for stale epochs (zombie fencing)
          res.writeHead(403, {
            "content-type": `text/plain`,
            [PRODUCER_EPOCH_HEADER]: producerResult.currentEpoch.toString(),
          })
          res.end(`Stale producer epoch`)
          return
        }

        case `invalid_epoch_seq`:
          // 400 Bad Request for epoch increase with seq != 0
          res.writeHead(400, { "content-type": `text/plain` })
          res.end(`New epoch must start with sequence 0`)
          return

        case `sequence_gap`:
          // 409 Conflict for sequence gaps
          res.writeHead(409, {
            "content-type": `text/plain`,
            [PRODUCER_EXPECTED_SEQ_HEADER]:
              producerResult.expectedSeq.toString(),
            [PRODUCER_RECEIVED_SEQ_HEADER]:
              producerResult.receivedSeq.toString(),
          })
          res.end(`Producer sequence gap`)
          return
      }
    }

    // Standard append (no producer) - result is StreamMessage
    const message = result as { offset: string }
    res.writeHead(204, {
      [STREAM_OFFSET_HEADER]: message.offset,
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
          // SSE event injection (for testing SSE parsing)
          injectSseEvent?: {
            eventType: string
            data: string
          }
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
          config.corruptBody ||
          config.injectSseEvent !== undefined
        if (!hasFaultType) {
          res.writeHead(400, { "content-type": `text/plain` })
          res.end(
            `Must specify at least one fault type: status, delayMs, dropConnection, truncateBodyBytes, corruptBody, or injectSseEvent`
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
          injectSseEvent: config.injectSseEvent,
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
