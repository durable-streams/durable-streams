/**
 * YjsServer - DS-protocol-compatible proxy for Yjs documents.
 *
 * This server proxies Durable Streams protocol requests to an underlying DS server,
 * adding Yjs-specific logic:
 * - Auto-creates streams when they don't exist
 * - Maintains an index stream pointing to current snapshot/updates
 * - Runs compaction in the background
 *
 * The client uses DurableStream client to talk to this server using standard DS protocol.
 */

import { createServer } from "node:http"
import {
  DurableStream,
  DurableStreamError,
  FetchError,
} from "@durable-streams/client"
import { Compactor } from "./compaction"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { YjsDocumentState, YjsIndex, YjsServerOptions } from "./types"

const DEFAULT_COMPACTION_THRESHOLD = 1024 * 1024 // 1MB
const DEFAULT_MIN_UPDATES = 100

/**
 * Check if an error is a 409 Conflict (already exists) error.
 */
function isConflictExistsError(err: unknown): boolean {
  return (
    (err instanceof DurableStreamError && err.code === `CONFLICT_EXISTS`) ||
    (err instanceof FetchError && err.status === 409)
  )
}

/**
 * Route match result.
 */
interface RouteMatch {
  service: string
  docId: string
  streamType: `index` | `updates` | `snapshots` | `awareness`
  streamId?: string
}

/**
 * Parse the URL path and extract route parameters.
 * Expected format: /v1/yjs/:service/docs/:docId/:streamType[/:streamId]
 */
function parseRoute(path: string): RouteMatch | null {
  const match = path.match(
    /^\/v1\/yjs\/([^/]+)\/docs\/([^/]+)\/(index|updates|snapshots|awareness)(?:\/([^/]+))?$/
  )
  if (!match) return null

  return {
    service: match[1]!,
    docId: match[2]!,
    streamType: match[3] as RouteMatch[`streamType`],
    streamId: match[4],
  }
}

/**
 * HTTP server implementing DS-compatible proxy for Yjs documents.
 */
export class YjsServer {
  private readonly dsServerUrl: string
  private readonly dsServerHeaders: Record<string, string>
  private readonly compactionThreshold: number
  private readonly minUpdatesBeforeCompaction: number
  private readonly port: number
  private readonly host: string

  private readonly compactor: Compactor
  private readonly documentStates = new Map<string, YjsDocumentState>()

  private stateKey(service: string, docId: string): string {
    return `${service}/${docId}`
  }

  private server: Server | null = null
  private _url: string | null = null

  constructor(options: YjsServerOptions) {
    this.dsServerUrl = options.dsServerUrl
    this.dsServerHeaders = options.dsServerHeaders ?? {}
    this.compactionThreshold =
      options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD
    this.minUpdatesBeforeCompaction =
      options.minUpdatesBeforeCompaction ?? DEFAULT_MIN_UPDATES
    this.port = options.port ?? 0
    this.host = options.host ?? `127.0.0.1`

    this.compactor = new Compactor(this)
  }

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

      this.server.listen(this.port, this.host, () => {
        const addr = this.server!.address()
        if (typeof addr === `string`) {
          this._url = addr
        } else if (addr) {
          this._url = `http://${this.host}:${addr.port}`
        }
        resolve(this._url!)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return

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

  get url(): string {
    if (!this._url) {
      throw new Error(`Server not started`)
    }
    return this._url
  }

  // ---- Request handling ----

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? `/`, `http://${req.headers.host}`)
    const path = url.pathname
    const method = req.method?.toUpperCase()

    // CORS headers
    res.setHeader(`access-control-allow-origin`, `*`)
    res.setHeader(
      `access-control-allow-methods`,
      `GET, POST, PUT, DELETE, OPTIONS`
    )
    res.setHeader(
      `access-control-allow-headers`,
      `content-type, stream-offset, stream-live, stream-producer-id, stream-producer-epoch, stream-producer-seq`
    )
    res.setHeader(
      `access-control-expose-headers`,
      `stream-offset, stream-up-to-date, stream-cursor`
    )

    if (method === `OPTIONS`) {
      res.writeHead(204)
      res.end()
      return
    }

    const route = parseRoute(path)
    if (!route) {
      res.writeHead(404, { "content-type": `text/plain` })
      res.end(`Not found`)
      return
    }

    try {
      // Build the DS server URL
      const dsPath = this.buildDsPath(route)
      const dsUrl = new URL(dsPath, this.dsServerUrl)

      // Copy query params
      url.searchParams.forEach((value, key) => {
        dsUrl.searchParams.set(key, value)
      })

      // Handle special cases
      if (method === `POST` && route.streamType === `updates`) {
        await this.handleUpdateAppend(req, res, route, dsUrl)
        return
      }

      if (method === `POST` && route.streamType === `awareness`) {
        await this.handleAwarenessAppend(req, res, route, dsUrl)
        return
      }

      // For all other requests, proxy directly
      await this.proxyRequest(req, res, method!, dsUrl)
    } catch (err) {
      console.error(`[YjsServer] Error handling ${method} ${path}:`, err)
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": `text/plain` })
        res.end(`Internal server error`)
      }
    }
  }

  private buildDsPath(route: RouteMatch): string {
    const base = `/v1/stream/yjs/${route.service}/docs/${route.docId}`
    if (route.streamId) {
      return `${base}/${route.streamType}/${route.streamId}`
    }
    return `${base}/${route.streamType}`
  }

  // ---- Proxy logic ----

  private async proxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    dsUrl: URL
  ): Promise<void> {
    // Read request body if present
    const body = await this.readBody(req)

    // Build headers for DS request
    const headers: Record<string, string> = {
      ...this.dsServerHeaders,
    }

    // Copy relevant headers from client request
    const headersToCopy = [
      `content-type`,
      `stream-offset`,
      `stream-live`,
      `stream-producer-id`,
      `stream-producer-epoch`,
      `stream-producer-seq`,
    ]
    for (const header of headersToCopy) {
      const value = req.headers[header]
      if (typeof value === `string`) {
        headers[header] = value
      }
    }

    // Make request to DS server
    const dsResponse = await fetch(dsUrl.toString(), {
      method,
      headers,
      body: body.length > 0 ? Buffer.from(body) : undefined,
    })

    // Copy response headers
    const responseHeaders: Record<string, string> = {}
    const headersToForward = [
      `content-type`,
      `stream-offset`,
      `stream-up-to-date`,
      `stream-cursor`,
    ]
    for (const header of headersToForward) {
      const value = dsResponse.headers.get(header)
      if (value) {
        responseHeaders[header] = value
      }
    }

    // Stream the response body
    res.writeHead(dsResponse.status, responseHeaders)

    if (dsResponse.body) {
      const reader = dsResponse.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      } finally {
        reader.releaseLock()
      }
    }

    res.end()
  }

  // ---- Update handling with index management ----

  private async handleUpdateAppend(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteMatch,
    dsUrl: URL
  ): Promise<void> {
    const stateKey = this.stateKey(route.service, route.docId)

    // Ensure streams exist
    await this.ensureStreamsExist(route.service, route.docId, route.streamId!)

    // Proxy the append request
    await this.proxyRequest(req, res, `POST`, dsUrl)

    // Track update size for compaction (approximate from request)
    const contentLength = parseInt(req.headers[`content-length`] ?? `0`, 10)
    const state = this.documentStates.get(stateKey)
    if (state) {
      state.updatesSizeBytes += contentLength
      state.updatesCount += 1

      // Check if compaction should be triggered
      if (this.shouldTriggerCompaction(state)) {
        this.compactor
          .triggerCompaction(route.service, route.docId)
          .catch((err) => {
            console.error(`[YjsServer] Compaction error:`, err)
          })
      }
    }
  }

  // ---- Awareness handling with base64 encoding ----

  private async handleAwarenessAppend(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteMatch,
    dsUrl: URL
  ): Promise<void> {
    // Ensure awareness stream exists
    await this.ensureAwarenessStream(route.service, route.docId)

    // Proxy the append request
    await this.proxyRequest(req, res, `POST`, dsUrl)
  }

  // ---- Stream management ----

  private async ensureStreamsExist(
    service: string,
    docId: string,
    updatesStreamId: string
  ): Promise<void> {
    const stateKey = this.stateKey(service, docId)

    if (this.documentStates.has(stateKey)) {
      return
    }

    // Create index stream if needed
    const indexUrl = `${this.dsServerUrl}/v1/stream/yjs/${service}/docs/${docId}/index`
    try {
      await DurableStream.create({
        url: indexUrl,
        headers: this.dsServerHeaders,
        contentType: `application/json`,
      })

      // Write initial index
      const stream = new DurableStream({
        url: indexUrl,
        headers: this.dsServerHeaders,
        contentType: `application/json`,
      })

      const defaultIndex: YjsIndex = {
        snapshot_stream: null,
        updates_stream: updatesStreamId,
        update_offset: `-1`,
      }
      await stream.append(defaultIndex, { contentType: `application/json` })
    } catch (err) {
      if (!isConflictExistsError(err)) {
        throw err
      }
    }

    // Create updates stream if needed
    const updatesUrl = `${this.dsServerUrl}/v1/stream/yjs/${service}/docs/${docId}/updates/${updatesStreamId}`
    try {
      await DurableStream.create({
        url: updatesUrl,
        headers: this.dsServerHeaders,
        contentType: `application/octet-stream`,
      })
    } catch (err) {
      if (!isConflictExistsError(err)) {
        throw err
      }
    }

    // Initialize document state
    this.documentStates.set(stateKey, {
      index: {
        snapshot_stream: null,
        updates_stream: updatesStreamId,
        update_offset: `-1`,
      },
      updatesSizeBytes: 0,
      updatesCount: 0,
      compacting: false,
    })
  }

  private async ensureAwarenessStream(
    service: string,
    docId: string
  ): Promise<void> {
    const awarenessUrl = `${this.dsServerUrl}/v1/stream/yjs/${service}/docs/${docId}/awareness`
    try {
      await DurableStream.create({
        url: awarenessUrl,
        headers: this.dsServerHeaders,
        contentType: `text/plain`,
      })
    } catch (err) {
      if (!isConflictExistsError(err)) {
        throw err
      }
    }
  }

  // ---- Compaction support ----

  shouldTriggerCompaction(state: YjsDocumentState): boolean {
    return (
      !state.compacting &&
      state.updatesSizeBytes >= this.compactionThreshold &&
      state.updatesCount >= this.minUpdatesBeforeCompaction
    )
  }

  getDocumentState(
    service: string,
    docId: string
  ): YjsDocumentState | undefined {
    return this.documentStates.get(this.stateKey(service, docId))
  }

  /**
   * Atomically check if compaction can start and set compacting=true if so.
   * Returns true if compaction was started, false if already compacting or state not found.
   */
  tryStartCompaction(service: string, docId: string): boolean {
    const state = this.documentStates.get(this.stateKey(service, docId))
    if (!state || state.compacting) {
      return false
    }
    state.compacting = true
    return true
  }

  setCompacting(service: string, docId: string, compacting: boolean): void {
    const state = this.documentStates.get(this.stateKey(service, docId))
    if (state) {
      state.compacting = compacting
    }
  }

  resetUpdateCounters(service: string, docId: string): void {
    const state = this.documentStates.get(this.stateKey(service, docId))
    if (state) {
      state.updatesSizeBytes = 0
      state.updatesCount = 0
    }
  }

  getDsServerUrl(): string {
    return this.dsServerUrl
  }

  getDsServerHeaders(): Record<string, string> {
    return this.dsServerHeaders
  }

  async saveIndex(
    service: string,
    docId: string,
    index: YjsIndex
  ): Promise<void> {
    const indexUrl = `${this.dsServerUrl}/v1/stream/yjs/${service}/docs/${docId}/index`
    const stream = new DurableStream({
      url: indexUrl,
      headers: this.dsServerHeaders,
      contentType: `application/json`,
    })
    await stream.append(index, { contentType: `application/json` })

    const state = this.documentStates.get(this.stateKey(service, docId))
    if (state) {
      state.index = index
    }
  }

  // ---- Helpers ----

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
