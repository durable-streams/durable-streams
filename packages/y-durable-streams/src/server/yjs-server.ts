/**
 * YjsServer - HTTP server implementing the Yjs Durable Streams Protocol.
 *
 * This server sits between Yjs clients and the durable streams server,
 * providing document abstraction with automatic compaction.
 *
 * Endpoints:
 * - GET  /v1/yjs/:service/docs/:docId           - Get index JSON
 * - POST /v1/yjs/:service/docs/:docId           - Append update (binary)
 * - GET  /v1/yjs/:service/docs/:docId/updates/:streamId - Read updates
 * - GET  /v1/yjs/:service/docs/:docId/snapshots/:snapshotId - Read snapshot
 * - GET  /v1/yjs/:service/docs/:docId/presence  - Subscribe to presence
 * - POST /v1/yjs/:service/docs/:docId/presence  - Broadcast presence
 */

import { createServer } from "node:http"
import { YjsStore } from "./yjs-store"
import { Compactor } from "./compaction"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { YjsIndex, YjsServerOptions } from "./types"

const STREAM_NEXT_OFFSET_HEADER = `Stream-Next-Offset`
const STREAM_UP_TO_DATE_HEADER = `Stream-Up-To-Date`

const DEFAULT_COMPACTION_THRESHOLD = 1024 * 1024 // 1MB
const DEFAULT_MIN_UPDATES = 100

/**
 * Route match result.
 */
interface RouteMatch {
  service: string
  docId: string
  streamId?: string
  snapshotId?: string
  endpoint: `index` | `update` | `updates` | `snapshot` | `presence`
}

/**
 * Route patterns for the Yjs protocol endpoints.
 */
const ROUTE_PATTERNS = {
  updates: /^\/v1\/yjs\/([^/]+)\/docs\/([^/]+)\/updates\/([^/]+)$/,
  snapshot: /^\/v1\/yjs\/([^/]+)\/docs\/([^/]+)\/snapshots\/([^/]+)$/,
  presence: /^\/v1\/yjs\/([^/]+)\/docs\/([^/]+)\/presence$/,
  index: /^\/v1\/yjs\/([^/]+)\/docs\/([^/]+)$/,
} as const

/**
 * Parse the URL path and extract route parameters.
 */
function parseRoute(path: string): RouteMatch | null {
  const updatesMatch = path.match(ROUTE_PATTERNS.updates)
  if (updatesMatch) {
    return {
      service: updatesMatch[1]!,
      docId: updatesMatch[2]!,
      streamId: updatesMatch[3],
      endpoint: `updates`,
    }
  }

  const snapshotMatch = path.match(ROUTE_PATTERNS.snapshot)
  if (snapshotMatch) {
    return {
      service: snapshotMatch[1]!,
      docId: snapshotMatch[2]!,
      snapshotId: snapshotMatch[3],
      endpoint: `snapshot`,
    }
  }

  const presenceMatch = path.match(ROUTE_PATTERNS.presence)
  if (presenceMatch) {
    return {
      service: presenceMatch[1]!,
      docId: presenceMatch[2]!,
      endpoint: `presence`,
    }
  }

  const indexMatch = path.match(ROUTE_PATTERNS.index)
  if (indexMatch) {
    return {
      service: indexMatch[1]!,
      docId: indexMatch[2]!,
      endpoint: `index`,
    }
  }

  return null
}

/**
 * HTTP server for the Yjs Durable Streams Protocol.
 */
export class YjsServer {
  private readonly store: YjsStore
  private readonly compactor: Compactor
  private readonly options: Required<
    Omit<YjsServerOptions, `dsServerHeaders`>
  > & {
    dsServerHeaders?: Record<string, string>
  }
  private server: Server | null = null
  private _url: string | null = null

  constructor(options: YjsServerOptions) {
    this.options = {
      port: options.port ?? 0,
      host: options.host ?? `127.0.0.1`,
      dsServerUrl: options.dsServerUrl,
      dsServerHeaders: options.dsServerHeaders,
      compactionThreshold:
        options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
      minUpdatesBeforeCompaction:
        options.minUpdatesBeforeCompaction ?? DEFAULT_MIN_UPDATES,
    }

    this.store = new YjsStore({
      dsServerUrl: this.options.dsServerUrl,
      dsServerHeaders: this.options.dsServerHeaders,
    })

    this.compactor = new Compactor(this.store)
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
          console.error(`[YjsServer] Request error:`, err)
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

    // Force-close all existing connections
    this.server.closeAllConnections()

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          reject(err)
          return
        }
        this.server = null
        this._url = null
        resolve()
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
   * Send a standard error response.
   */
  private sendError(
    res: ServerResponse,
    status: number,
    message: string
  ): void {
    res.writeHead(status, { "content-type": `text/plain` })
    res.end(message)
  }

  /**
   * Handle an incoming HTTP request.
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? `/`, `http://${req.headers.host}`)
    const path = url.pathname
    const method = req.method?.toUpperCase()

    // CORS headers
    res.setHeader(`access-control-allow-origin`, `*`)
    res.setHeader(`access-control-allow-methods`, `GET, POST, OPTIONS`)
    res.setHeader(`access-control-allow-headers`, `content-type`)
    res.setHeader(
      `access-control-expose-headers`,
      `${STREAM_NEXT_OFFSET_HEADER}, ${STREAM_UP_TO_DATE_HEADER}`
    )

    if (method === `OPTIONS`) {
      res.writeHead(204)
      res.end()
      return
    }

    const route = parseRoute(path)
    if (!route) {
      this.sendError(res, 404, `Not found`)
      return
    }

    try {
      switch (route.endpoint) {
        case `index`:
          if (method === `GET`) {
            await this.handleGetIndex(route.service, route.docId, res)
          } else if (method === `POST`) {
            await this.handlePostUpdate(route.service, route.docId, req, res)
          } else {
            this.sendError(res, 405, `Method not allowed`)
          }
          break

        case `updates`:
          if (method === `GET`) {
            await this.handleGetUpdates(
              route.service,
              route.docId,
              route.streamId!,
              url,
              res
            )
          } else {
            this.sendError(res, 405, `Method not allowed`)
          }
          break

        case `snapshot`:
          if (method === `GET`) {
            await this.handleGetSnapshot(
              route.service,
              route.docId,
              route.snapshotId!,
              res
            )
          } else {
            this.sendError(res, 405, `Method not allowed`)
          }
          break

        case `presence`:
          if (method === `GET`) {
            await this.handleGetPresence(route.service, route.docId, url, res)
          } else if (method === `POST`) {
            await this.handlePostPresence(route.service, route.docId, req, res)
          } else {
            this.sendError(res, 405, `Method not allowed`)
          }
          break

        default:
          this.sendError(res, 404, `Not found`)
      }
    } catch (err) {
      console.error(`[YjsServer] Error handling ${method} ${path}:`, err)
      if (!res.headersSent) {
        this.sendError(res, 500, `Internal server error`)
      }
    }
  }

  /**
   * GET /v1/yjs/:service/docs/:docId - Return index JSON.
   */
  private async handleGetIndex(
    service: string,
    docId: string,
    res: ServerResponse
  ): Promise<void> {
    const index = await this.store.getIndex(service, docId)

    if (!index) {
      // New document - return default index
      const defaultIndex: YjsIndex = {
        snapshot_stream: null,
        updates_stream: `updates-001`,
        update_offset: -1,
      }
      res.writeHead(200, { "content-type": `application/json` })
      res.end(JSON.stringify(defaultIndex))
      return
    }

    res.writeHead(200, { "content-type": `application/json` })
    res.end(JSON.stringify(index))
  }

  /**
   * POST /v1/yjs/:service/docs/:docId - Append update (binary).
   */
  private async handlePostUpdate(
    service: string,
    docId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req)

    if (body.length === 0) {
      this.sendError(res, 400, `Empty body`)
      return
    }

    // Append the update
    const result = await this.store.appendUpdate(service, docId, body)

    // Check if compaction should be triggered
    const state = await this.store.getDocumentState(service, docId)
    if (
      this.store.shouldTriggerCompaction(
        state,
        this.options.compactionThreshold,
        this.options.minUpdatesBeforeCompaction
      )
    ) {
      // Trigger compaction in the background
      this.compactor.triggerCompaction(service, docId).catch((err) => {
        console.error(
          `[YjsServer] Compaction error for ${service}/${docId}:`,
          err
        )
      })
    }

    res.writeHead(200, {
      "content-type": `text/plain`,
      [STREAM_NEXT_OFFSET_HEADER]: result.offset,
    })
    res.end()
  }

  /**
   * GET /v1/yjs/:service/docs/:docId/updates/:streamId - Read updates.
   */
  private async handleGetUpdates(
    service: string,
    docId: string,
    streamId: string,
    url: URL,
    res: ServerResponse
  ): Promise<void> {
    const offset = url.searchParams.get(`offset`) ?? undefined
    const live = url.searchParams.get(`live`)

    // Verify this is the current updates stream
    const state = await this.store.getDocumentState(service, docId)
    if (state.index.updates_stream !== streamId) {
      this.sendError(res, 404, `Stream not found`)
      return
    }

    const result = await this.store.readUpdates(service, docId, {
      offset,
      live: live === `long-poll` ? `long-poll` : false,
    })

    const headers: Record<string, string> = {
      "content-type": `application/octet-stream`,
      [STREAM_NEXT_OFFSET_HEADER]: result.nextOffset,
    }

    if (result.upToDate) {
      headers[STREAM_UP_TO_DATE_HEADER] = `true`
    }

    res.writeHead(200, headers)
    res.end(Buffer.from(result.data))
  }

  /**
   * GET /v1/yjs/:service/docs/:docId/snapshots/:snapshotId - Read snapshot.
   */
  private async handleGetSnapshot(
    service: string,
    docId: string,
    snapshotId: string,
    res: ServerResponse
  ): Promise<void> {
    const snapshot = await this.store.readSnapshot(service, docId, snapshotId)

    if (!snapshot) {
      this.sendError(res, 404, `Snapshot not found`)
      return
    }

    res.writeHead(200, { "content-type": `application/octet-stream` })
    res.end(Buffer.from(snapshot))
  }

  /**
   * GET /v1/yjs/:service/docs/:docId/presence - Subscribe to presence.
   */
  private async handleGetPresence(
    service: string,
    docId: string,
    url: URL,
    res: ServerResponse
  ): Promise<void> {
    const offset = url.searchParams.get(`offset`) ?? `now`
    const live = url.searchParams.get(`live`)

    // Ensure presence stream exists before reading (for long-poll to work)
    await this.store.ensurePresenceStream(service, docId)

    const result = await this.store.readPresence(service, docId, {
      offset,
      live: live === `long-poll` ? `long-poll` : false,
    })

    const headers: Record<string, string> = {
      "content-type": `application/octet-stream`,
      [STREAM_NEXT_OFFSET_HEADER]: result.nextOffset,
    }

    if (result.upToDate) {
      headers[STREAM_UP_TO_DATE_HEADER] = `true`
    }

    res.writeHead(200, headers)
    res.end(Buffer.from(result.data))
  }

  /**
   * POST /v1/yjs/:service/docs/:docId/presence - Broadcast presence.
   */
  private async handlePostPresence(
    service: string,
    docId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req)

    if (body.length === 0) {
      this.sendError(res, 400, `Empty body`)
      return
    }

    await this.store.appendPresence(service, docId, body)

    res.writeHead(200, { "content-type": `text/plain` })
    res.end()
  }

  /**
   * Read request body as Uint8Array.
   */
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
