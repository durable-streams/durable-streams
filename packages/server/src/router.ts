/**
 * Core router for durable streams HTTP endpoints.
 * Can be embedded into any Node.js HTTP server.
 */

import { deflateSync, gzipSync } from "node:zlib"
import { generateResponseCursor } from "./cursor"
import { formatJsonResponse, normalizeContentType } from "./store"
import type { CursorOptions } from "./cursor"
import type { IncomingMessage, ServerResponse } from "node:http"
import type {
  PendingLongPoll,
  RouterOptions,
  StreamLifecycleEvent,
  StreamMessage,
} from "./types"
import type { StreamStorage } from "./storage"

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
 * Router for durable streams HTTP endpoints.
 * Handles all stream operations (create, read, append, delete) and can be
 * embedded into any Node.js HTTP server (Express, Fastify, vanilla http, etc.).
 */
export class DurableStreamRouter {
  readonly store: StreamStorage
  private options: {
    longPollTimeout: number
    compression: boolean
    cors: boolean
    baseUrl: string | undefined
    cursorOptions: CursorOptions
    onStreamCreated?: (event: StreamLifecycleEvent) => void | Promise<void>
    onStreamDeleted?: (event: StreamLifecycleEvent) => void | Promise<void>
  }
  private activeSSEResponses = new Set<ServerResponse>()
  private isShuttingDown = false
  private pendingLongPolls: Array<PendingLongPoll> = []

  constructor(options: RouterOptions) {
    this.store = options.store

    this.options = {
      longPollTimeout: options.longPollTimeout ?? 30_000,
      compression: options.compression ?? true,
      cors: options.cors ?? true,
      baseUrl: options.baseUrl,
      cursorOptions: {
        intervalSeconds: options.cursorIntervalSeconds,
        epoch: options.cursorEpoch,
      },
      onStreamCreated: options.onStreamCreated,
      onStreamDeleted: options.onStreamDeleted,
    }
  }

  /**
   * Main request handler.
   * Call this from your HTTP server's request handler.
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? `/`, `http://${req.headers.host}`)
    let path = url.pathname
    const method = req.method?.toUpperCase()

    // Strip base URL prefix if configured
    if (this.options.baseUrl && path.startsWith(this.options.baseUrl)) {
      path = path.substring(this.options.baseUrl.length)
      // Ensure path starts with /
      if (!path.startsWith(`/`)) {
        path = `/${path}`
      }
    }

    // CORS headers for browser testing (if enabled)
    if (this.options.cors) {
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
    }

    // Handle CORS preflight
    if (method === `OPTIONS`) {
      res.writeHead(204)
      res.end()
      return
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
   * Gracefully shutdown the router.
   * Closes all active SSE connections and pending long-polls.
   */
  shutdown(): void {
    // Mark as shutting down to stop SSE handlers
    this.isShuttingDown = true

    // Cancel all pending long-polls and SSE waits to unblock connection handlers
    this.cancelAllWaits()

    // Force-close all active SSE connections
    for (const res of this.activeSSEResponses) {
      res.end()
    }
    this.activeSSEResponses.clear()

    this.isShuttingDown = false
  }

  /**
   * Clear all streams.
   */
  clear(): void {
    this.store.clear()
  }

  // ============================================================================
  // Request handling
  // ============================================================================

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
      const result = await this.waitForMessages(
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
    const responseData = this.formatResponse(path, messages)

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

    res.writeHead(200, headers)
    res.end(Buffer.from(finalData))
  }

  /**
   * Handle SSE (Server-Sent Events) mode
   */
  private async handleSSE(
    path: string,
    stream: ReturnType<StreamStorage[`get`]>,
    initialOffset: string,
    cursor: string | undefined,
    res: ServerResponse
  ): Promise<void> {
    // Track this SSE connection
    this.activeSSEResponses.add(res)

    // Set SSE headers
    res.writeHead(200, {
      "content-type": `text/event-stream`,
      "cache-control": `no-cache`,
      connection: `keep-alive`,
      "access-control-allow-origin": `*`,
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
          const jsonBytes = this.formatResponse(path, [message])
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
        const result = await this.waitForMessages(
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

    // Notify any pending long-polls
    this.notifyLongPolls(path)

    res.writeHead(200, {
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

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Format messages for HTTP response.
   * For JSON streams, wraps in array brackets and strips trailing commas.
   * For binary streams, concatenates raw data.
   */
  private formatResponse(
    path: string,
    messages: Array<StreamMessage>
  ): Uint8Array {
    const stream = this.store.get(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    // Concatenate all message data
    const concatenated = new Uint8Array(
      messages.reduce((total, msg) => total + msg.data.length, 0)
    )
    let offset = 0
    for (const message of messages) {
      concatenated.set(message.data, offset)
      offset += message.data.length
    }

    // For JSON mode, wrap in array brackets
    if (normalizeContentType(stream.contentType) === `application/json`) {
      return formatJsonResponse(concatenated)
    }

    return concatenated
  }

  /**
   * Wait for new messages to arrive (long-polling).
   */
  private async waitForMessages(
    path: string,
    offset: string,
    timeoutMs: number
  ): Promise<{ messages: Array<StreamMessage>; timedOut: boolean }> {
    const stream = this.store.get(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    // Check if there are already new messages
    const { messages } = this.store.read(path, offset)
    if (messages.length > 0) {
      return { messages, timedOut: false }
    }

    // Wait for new messages
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        // Remove from pending list
        this.pendingLongPolls = this.pendingLongPolls.filter(
          (p) => p !== pending
        )
        resolve({ messages: [], timedOut: true })
      }, timeoutMs)

      const pending: PendingLongPoll = {
        path,
        offset,
        resolve: (msgs) => {
          clearTimeout(timeoutId)
          resolve({ messages: msgs, timedOut: false })
        },
        timeoutId,
      }

      this.pendingLongPolls.push(pending)
    })
  }

  /**
   * Get the current offset of a stream.
   */
  private getCurrentOffset(path: string): string | undefined {
    return this.store.get(path)?.currentOffset
  }

  /**
   * Cancel all pending long-poll waits.
   * Used during server shutdown.
   */
  private cancelAllWaits(): void {
    for (const pending of this.pendingLongPolls) {
      clearTimeout(pending.timeoutId)
      // Resolve with empty result to unblock waiting handlers
      pending.resolve([])
    }
    this.pendingLongPolls = []
  }

  /**
   * Notify pending long-polls that new messages are available.
   */
  private notifyLongPolls(path: string): void {
    const toNotify = this.pendingLongPolls.filter((p) => p.path === path)

    for (const pending of toNotify) {
      const { messages } = this.store.read(path, pending.offset)
      if (messages.length > 0) {
        clearTimeout(pending.timeoutId)
        pending.resolve(messages)
        // Remove from pending list
        const index = this.pendingLongPolls.indexOf(pending)
        if (index !== -1) {
          this.pendingLongPolls.splice(index, 1)
        }
      }
    }
  }

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
