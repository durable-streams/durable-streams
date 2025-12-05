/**
 * HTTP server for durable streams testing.
 */

import { createServer } from "node:http"
import { StreamStore } from "./store"
import { FileBackedStreamStore } from "./file-store"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { TestServerOptions } from "./types"

// Protocol headers (aligned with PROTOCOL.md)
const STREAM_OFFSET_HEADER = `Stream-Next-Offset`
const STREAM_CURSOR_HEADER = `Stream-Cursor`
const STREAM_UP_TO_DATE_HEADER = `Stream-Up-To-Date`
const STREAM_SEQ_HEADER = `Stream-Seq`
const STREAM_TTL_HEADER = `Stream-TTL`
const STREAM_EXPIRES_AT_HEADER = `Stream-Expires-At`

// Query params
const OFFSET_QUERY_PARAM = `offset`
const LIVE_QUERY_PARAM = `live`
const CURSOR_QUERY_PARAM = `cursor`

/**
 * HTTP server for testing durable streams.
 * Supports both in-memory and file-backed storage modes.
 */
export class DurableStreamTestServer {
  readonly store: StreamStore | FileBackedStreamStore
  private server: Server | null = null
  private options: Required<Omit<TestServerOptions, `dataDir`>> & {
    dataDir?: string
  }
  private _url: string | null = null

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
      port: options.port ?? 0,
      host: options.host ?? `127.0.0.1`,
      longPollTimeout: options.longPollTimeout ?? 30_000,
      dataDir: options.dataDir,
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
      `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, etag, content-type`
    )

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
          await this.handleRead(path, url, res)
          break
        case `POST`:
          await this.handleAppend(path, req, res)
          break
        case `DELETE`:
          this.handleDelete(path, res)
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
          res.writeHead(400, { "content-type": `text/plain` })
          res.end(`Content-type mismatch`)
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
    const contentType = req.headers[`content-type`]
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
      ttlSeconds = parseInt(ttlHeader, 10)
      if (isNaN(ttlSeconds) || ttlSeconds < 0) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid Stream-TTL value`)
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

    // Return 201 for new streams, 200 for idempotent creates
    res.writeHead(isNew ? 201 : 200, {
      "content-type": contentType ?? `application/octet-stream`,
      [STREAM_OFFSET_HEADER]: stream.currentOffset,
    })
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

    // Generate ETag: {path}:{offset}
    headers[`etag`] =
      `"${Buffer.from(path).toString(`base64`)}:${stream.currentOffset}"`

    res.writeHead(200, headers)
    res.end()
  }

  /**
   * Handle GET - read data
   */
  private async handleRead(
    path: string,
    url: URL,
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

    // Validate offset format (must not contain commas or spaces)
    if (offset) {
      if (offset.includes(`,`) || offset.includes(` `)) {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid offset format`)
        return
      }
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
        // Return 204 No Content on timeout
        res.writeHead(204, {
          [STREAM_OFFSET_HEADER]: offset,
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
    headers[STREAM_OFFSET_HEADER] = lastMessage?.offset ?? stream.currentOffset

    // Echo cursor if provided
    if (cursor) {
      headers[STREAM_CURSOR_HEADER] = cursor
    }

    // Set up-to-date header
    if (upToDate) {
      headers[STREAM_UP_TO_DATE_HEADER] = `true`
    }

    // Format response (wraps JSON in array brackets)
    const responseData = this.store.formatResponse(path, messages)

    res.writeHead(200, headers)
    res.end(Buffer.from(responseData))
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

    // Support both sync (StreamStore) and async (FileBackedStreamStore) append
    const message = await Promise.resolve(
      this.store.append(path, body, { seq, contentType })
    )

    res.writeHead(200, {
      [STREAM_OFFSET_HEADER]: message.offset,
    })
    res.end()
  }

  /**
   * Handle DELETE - delete stream
   */
  private handleDelete(path: string, res: ServerResponse): void {
    if (!this.store.has(path)) {
      res.writeHead(404, { "content-type": `text/plain` })
      res.end(`Stream not found`)
      return
    }

    this.store.delete(path)
    res.writeHead(204)
    res.end()
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
