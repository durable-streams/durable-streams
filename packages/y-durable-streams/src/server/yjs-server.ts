/**
 * YjsServer - HTTP server implementing the Yjs Durable Streams Protocol.
 *
 * This server proxies Durable Streams protocol requests to an underlying DS server,
 * adding Yjs-specific logic:
 * - Single URL path per document with query parameters
 * - Snapshot discovery via offset=snapshot sentinel (307 redirects)
 * - Automatic compaction when updates exceed threshold
 * - Awareness via ?awareness=<name> query parameter
 *
 * Protocol: https://github.com/durable-streams/durable-streams/blob/main/packages/y-durable-streams/PROTOCOL.md
 */

import { createServer } from "node:http"
import {
  DurableStream,
  DurableStreamError,
  FetchError,
} from "@durable-streams/client"
import { Compactor, frameUpdate } from "./compaction"
import { PathUtils, YJS_HEADERS, YjsStreamPaths } from "./types"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { YjsDocumentState, YjsIndexEntry, YjsServerOptions } from "./types"

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
 * Check if an error is a 404 Not Found error.
 */
function isNotFoundError(err: unknown): boolean {
  return (
    (err instanceof DurableStreamError && err.code === `NOT_FOUND`) ||
    (err instanceof FetchError && err.status === 404)
  )
}

/**
 * Route match result.
 */
interface RouteMatch {
  service: string
  docPath: string
}

/**
 * Parse the URL path and extract route parameters.
 * Expected format: /v1/yjs/:service/docs/:docPath
 * where docPath can include forward slashes.
 */
function parseRoute(path: string): RouteMatch | null {
  const match = path.match(/^\/v1\/yjs\/([^/]+)\/docs\/(.+)$/)
  if (!match) return null

  const docPath = PathUtils.normalize(match[2]!)
  if (!docPath) return null

  return {
    service: match[1]!,
    docPath,
  }
}

/**
 * HTTP server implementing the Yjs Durable Streams Protocol.
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

  private stateKey(service: string, docPath: string): string {
    return `${service}/${docPath}`
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
            res.writeHead(500, { "content-type": `application/json` })
            res.end(
              JSON.stringify({
                error: { code: `INTERNAL_ERROR`, message: `Internal error` },
              })
            )
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
    const rawUrl = req.url ?? `/`
    const url = new URL(rawUrl, `http://${req.headers.host}`)
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
      `authorization, content-type, stream-offset, stream-live, stream-producer-id, stream-producer-epoch, stream-producer-seq`
    )
    res.setHeader(
      `access-control-expose-headers`,
      `stream-next-offset, stream-up-to-date, stream-cursor, location`
    )

    if (method === `OPTIONS`) {
      res.writeHead(204)
      res.end()
      return
    }

    // Check for path traversal in raw URL (before URL normalization)
    // This catches attempts to use /.. or /. segments
    if (
      rawUrl.includes(`/..`) ||
      rawUrl.includes(`/./`) ||
      rawUrl.endsWith(`/.`)
    ) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Invalid document path` },
        })
      )
      return
    }

    const route = parseRoute(path)
    if (!route) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Invalid document path` },
        })
      )
      return
    }

    const offset = url.searchParams.get(`offset`)
    const awareness = url.searchParams.get(`awareness`)
    const live = url.searchParams.get(`live`)

    try {
      // Handle awareness streams
      if (awareness !== null) {
        await this.handleAwareness(req, res, route, awareness, url)
        return
      }

      // Handle snapshot discovery
      if (offset === `snapshot`) {
        await this.handleSnapshotDiscovery(res, route, url)
        return
      }

      // Handle snapshot read
      if (offset && offset.endsWith(`_snapshot`)) {
        await this.handleSnapshotRead(req, res, route, offset, url)
        return
      }

      // Handle document updates
      if (method === `GET`) {
        await this.handleUpdatesRead(req, res, route, offset, live, url)
      } else if (method === `POST`) {
        await this.handleUpdateWrite(req, res, route)
      } else {
        res.writeHead(405, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: { code: `INVALID_REQUEST`, message: `Method not allowed` },
          })
        )
      }
    } catch (err) {
      console.error(`[YjsServer] Error handling ${method} ${path}:`, err)
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: { code: `INTERNAL_ERROR`, message: `Internal error` },
          })
        )
      }
    }
  }

  // ---- Snapshot Discovery ----

  private async handleSnapshotDiscovery(
    res: ServerResponse,
    route: RouteMatch,
    originalUrl: URL
  ): Promise<void> {
    const state = this.getOrCreateDocumentState(route.service, route.docPath)

    // If no snapshot in memory, try to load from index stream
    if (!state.snapshotOffset) {
      const loadedOffset = await this.loadSnapshotOffsetFromIndex(
        route.service,
        route.docPath
      )
      if (loadedOffset) {
        state.snapshotOffset = loadedOffset
      }
    }

    // Build redirect URL
    const redirectUrl = new URL(originalUrl.href)

    if (state.snapshotOffset) {
      // Snapshot exists - redirect to snapshot URL
      redirectUrl.searchParams.set(
        `offset`,
        YjsStreamPaths.snapshotKey(state.snapshotOffset)
      )
    } else {
      // No snapshot - redirect to beginning of stream
      redirectUrl.searchParams.set(`offset`, `-1`)
    }

    // Build relative redirect path
    const redirectPath = `${redirectUrl.pathname}${redirectUrl.search}`

    res.writeHead(307, {
      location: redirectPath,
      "cache-control": `private, max-age=5`,
      "content-type": `application/json`,
    })
    res.end(JSON.stringify({ redirect: redirectPath }))
  }

  /**
   * Load the latest snapshot offset from the internal index stream.
   * Returns null if no index exists or it's empty.
   */
  private async loadSnapshotOffsetFromIndex(
    service: string,
    docPath: string
  ): Promise<string | null> {
    const indexUrl = `${this.dsServerUrl}${YjsStreamPaths.indexStream(service, docPath)}`

    try {
      const stream = new DurableStream({
        url: indexUrl,
        headers: this.dsServerHeaders,
        contentType: `application/json`,
      })

      const response = await stream.stream({ offset: `-1` })
      const body = await response.text()

      if (!body || body.trim().length === 0) {
        return null
      }

      // Parse all entries and return the last one (most recent)
      const lines = body.trim().split(`\n`)
      const lastLine = lines[lines.length - 1]

      if (!lastLine) {
        return null
      }

      const entry = JSON.parse(lastLine) as YjsIndexEntry
      return entry.snapshotOffset
    } catch (err) {
      if (isNotFoundError(err)) {
        // No index stream yet - that's fine
        return null
      }
      console.error(
        `[YjsServer] Error loading index for ${service}/${docPath}:`,
        err
      )
      return null
    }
  }

  // ---- Snapshot Read ----

  private async handleSnapshotRead(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteMatch,
    offset: string,
    _url: URL
  ): Promise<void> {
    const snapshotOffset = YjsStreamPaths.parseSnapshotOffset(offset)
    if (!snapshotOffset) {
      res.writeHead(400, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `INVALID_REQUEST`,
            message: `Invalid snapshot offset`,
          },
        })
      )
      return
    }

    // Build DS URL for snapshot storage
    const dsPath = YjsStreamPaths.snapshotStream(
      route.service,
      route.docPath,
      offset
    )
    const dsUrl = new URL(dsPath, this.dsServerUrl)

    try {
      const dsResponse = await fetch(dsUrl.toString(), {
        method: `GET`,
        headers: {
          ...this.dsServerHeaders,
          "stream-offset": `-1`, // Read from beginning of snapshot stream
        },
      })

      if (!dsResponse.ok) {
        if (dsResponse.status === 404) {
          res.writeHead(404, { "content-type": `application/json` })
          res.end(
            JSON.stringify({
              error: {
                code: `SNAPSHOT_NOT_FOUND`,
                message: `Snapshot not found`,
              },
            })
          )
          return
        }
        throw new Error(`DS server returned ${dsResponse.status}`)
      }

      // Set headers - the next offset to read updates from is snapshotOffset + 1
      // But we return the snapshot offset so client knows where to continue
      const responseHeaders: Record<string, string> = {
        "content-type": `application/octet-stream`,
        [YJS_HEADERS.STREAM_NEXT_OFFSET]: this.incrementOffset(snapshotOffset),
      }

      res.writeHead(200, responseHeaders)

      // Stream the snapshot body
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
    } catch (err) {
      if (isNotFoundError(err)) {
        res.writeHead(404, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: {
              code: `SNAPSHOT_NOT_FOUND`,
              message: `Snapshot not found`,
            },
          })
        )
        return
      }
      throw err
    }
  }

  /**
   * Increment an offset string for the next read position.
   * Offsets are formatted as "{timestamp}_{sequence}" padded strings.
   */
  private incrementOffset(offset: string): string {
    // For now, return the offset as-is - the client will read from this position
    // The DS server handles offset semantics
    return offset
  }

  // ---- Updates Read ----

  private async handleUpdatesRead(
    _req: IncomingMessage,
    res: ServerResponse,
    route: RouteMatch,
    offset: string | null,
    live: string | null,
    _url: URL
  ): Promise<void> {
    // Build DS URL with query params (DS server expects these as query params)
    const dsPath = YjsStreamPaths.dsStream(route.service, route.docPath)
    const dsUrl = new URL(dsPath, this.dsServerUrl)

    // Forward query params to DS server
    if (offset !== null) {
      dsUrl.searchParams.set(`offset`, offset)
    }
    if (live === `true`) {
      dsUrl.searchParams.set(`live`, `true`)
    }

    // Build headers
    const headers: Record<string, string> = {
      ...this.dsServerHeaders,
    }

    // Proxy to DS server
    const dsResponse = await fetch(dsUrl.toString(), {
      method: `GET`,
      headers,
    })

    // Copy response headers
    const responseHeaders: Record<string, string> = {
      "content-type":
        dsResponse.headers.get(`content-type`) ?? `application/octet-stream`,
    }

    const headersToForward = [
      YJS_HEADERS.STREAM_NEXT_OFFSET,
      YJS_HEADERS.STREAM_UP_TO_DATE,
      YJS_HEADERS.STREAM_CURSOR,
      `stream-offset`, // Also check lowercase variants
    ]
    for (const header of headersToForward) {
      const value = dsResponse.headers.get(header)
      if (value) {
        responseHeaders[header] = value
      }
    }

    res.writeHead(dsResponse.status, responseHeaders)

    // Stream the response body
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

  // ---- Update Write ----

  private async handleUpdateWrite(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteMatch
  ): Promise<void> {
    const stateKey = this.stateKey(route.service, route.docPath)

    // Ensure document stream exists
    await this.ensureDocumentStream(route.service, route.docPath)

    // Read the raw update from request
    const body = await this.readBody(req)

    // Frame the update with lib0 encoding for storage
    const framedUpdate = frameUpdate(body)

    // Build DS URL
    const dsPath = YjsStreamPaths.dsStream(route.service, route.docPath)
    const dsUrl = new URL(dsPath, this.dsServerUrl)

    // Copy producer headers if present
    const headers: Record<string, string> = {
      ...this.dsServerHeaders,
      "content-type": `application/octet-stream`,
    }

    const producerHeaders = [
      `stream-producer-id`,
      `stream-producer-epoch`,
      `stream-producer-seq`,
    ]
    for (const header of producerHeaders) {
      const value = req.headers[header]
      if (typeof value === `string`) {
        headers[header] = value
      }
    }

    // Append to DS server
    const dsResponse = await fetch(dsUrl.toString(), {
      method: `POST`,
      headers,
      body: Buffer.from(framedUpdate),
    })

    // Forward all response headers from DS server
    const responseHeaders: Record<string, string> = {}

    // Check multiple possible header names for offset
    const offsetHeaderNames = [
      YJS_HEADERS.STREAM_NEXT_OFFSET,
      `stream-offset`,
      `Stream-Offset`,
      `Stream-Next-Offset`,
    ]
    for (const headerName of offsetHeaderNames) {
      const value = dsResponse.headers.get(headerName)
      if (value) {
        responseHeaders[YJS_HEADERS.STREAM_NEXT_OFFSET] = value
        responseHeaders[`stream-offset`] = value // Also set stream-offset for compatibility
        break
      }
    }

    if (!dsResponse.ok) {
      // Clone the response to read body safely
      const text = await dsResponse.text()
      res.writeHead(dsResponse.status, {
        "content-type":
          dsResponse.headers.get(`content-type`) ?? `application/json`,
        ...responseHeaders,
      })
      res.end(text)
      return
    }

    // Track update size for compaction
    const state = this.documentStates.get(stateKey)
    if (state) {
      state.updatesSizeBytes += body.length
      state.updatesCount += 1

      // Check if compaction should be triggered
      if (this.shouldTriggerCompaction(state)) {
        this.compactor
          .triggerCompaction(route.service, route.docPath)
          .catch((err) => {
            console.error(`[YjsServer] Compaction error:`, err)
          })
      }
    }

    res.writeHead(204, responseHeaders)
    res.end()
  }

  // ---- Awareness ----

  private async handleAwareness(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteMatch,
    awarenessName: string,
    url: URL
  ): Promise<void> {
    const method = req.method?.toUpperCase()

    // Build DS URL for awareness stream
    const dsPath = YjsStreamPaths.awarenessStream(
      route.service,
      route.docPath,
      awarenessName
    )
    const dsUrl = new URL(dsPath, this.dsServerUrl)

    if (method === `POST`) {
      // Ensure awareness stream exists
      await this.ensureAwarenessStream(
        route.service,
        route.docPath,
        awarenessName
      )

      // Read body and append
      const body = await this.readBody(req)

      const dsResponse = await fetch(dsUrl.toString(), {
        method: `POST`,
        headers: {
          ...this.dsServerHeaders,
          "content-type": `text/plain`,
        },
        body: Buffer.from(body),
      })

      const responseHeaders: Record<string, string> = {}
      const nextOffset =
        dsResponse.headers.get(YJS_HEADERS.STREAM_NEXT_OFFSET) ??
        dsResponse.headers.get(`stream-offset`)
      if (nextOffset) {
        responseHeaders[YJS_HEADERS.STREAM_NEXT_OFFSET] = nextOffset
      }

      res.writeHead(dsResponse.ok ? 204 : dsResponse.status, responseHeaders)
      res.end()
    } else if (method === `GET`) {
      const offset = url.searchParams.get(`offset`)
      const live = url.searchParams.get(`live`)

      // Forward query params to DS server
      if (offset !== null) {
        dsUrl.searchParams.set(`offset`, offset)
      }
      if (live === `true`) {
        dsUrl.searchParams.set(`live`, `sse`) // Use SSE for awareness
      }

      const dsResponse = await fetch(dsUrl.toString(), {
        method: `GET`,
        headers: this.dsServerHeaders,
      })

      // Copy response headers
      const responseHeaders: Record<string, string> = {
        "content-type":
          dsResponse.headers.get(`content-type`) ?? `text/event-stream`,
      }

      const headersToForward = [
        YJS_HEADERS.STREAM_NEXT_OFFSET,
        YJS_HEADERS.STREAM_UP_TO_DATE,
        YJS_HEADERS.STREAM_CURSOR,
        `stream-offset`,
      ]
      for (const header of headersToForward) {
        const value = dsResponse.headers.get(header)
        if (value) {
          responseHeaders[header] = value
        }
      }

      res.writeHead(dsResponse.status, responseHeaders)

      // Stream the response
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
    } else {
      res.writeHead(405, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Method not allowed` },
        })
      )
    }
  }

  // ---- Stream management ----

  // Track which streams have been created on the DS server
  private readonly createdStreams = new Set<string>()

  private async ensureDocumentStream(
    service: string,
    docPath: string
  ): Promise<void> {
    const stateKey = this.stateKey(service, docPath)

    // Check if we've already created this stream on the DS server
    if (this.createdStreams.has(stateKey)) {
      return
    }

    // Create document stream on DS server
    const streamUrl = `${this.dsServerUrl}${YjsStreamPaths.dsStream(service, docPath)}`

    try {
      await DurableStream.create({
        url: streamUrl,
        headers: this.dsServerHeaders,
        contentType: `application/octet-stream`,
      })
    } catch (err) {
      if (!isConflictExistsError(err)) {
        throw err
      }
      // Stream already exists - that's fine
    }

    // Mark as created
    this.createdStreams.add(stateKey)

    // Initialize document state if not already present
    if (!this.documentStates.has(stateKey)) {
      this.documentStates.set(stateKey, {
        snapshotOffset: null,
        updatesSizeBytes: 0,
        updatesCount: 0,
        compacting: false,
      })
    }
  }

  private async ensureAwarenessStream(
    service: string,
    docPath: string,
    awarenessName: string
  ): Promise<void> {
    const awarenessUrl = `${this.dsServerUrl}${YjsStreamPaths.awarenessStream(service, docPath, awarenessName)}`
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

  private getOrCreateDocumentState(
    service: string,
    docPath: string
  ): YjsDocumentState {
    const stateKey = this.stateKey(service, docPath)
    let state = this.documentStates.get(stateKey)
    if (!state) {
      state = {
        snapshotOffset: null,
        updatesSizeBytes: 0,
        updatesCount: 0,
        compacting: false,
      }
      this.documentStates.set(stateKey, state)
    }
    return state
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
    docPath: string
  ): YjsDocumentState | undefined {
    return this.documentStates.get(this.stateKey(service, docPath))
  }

  /**
   * Atomically check if compaction can start and set compacting=true if so.
   * Returns true if compaction was started, false if already compacting or state not found.
   */
  tryStartCompaction(service: string, docPath: string): boolean {
    const state = this.documentStates.get(this.stateKey(service, docPath))
    if (!state || state.compacting) {
      return false
    }
    state.compacting = true
    return true
  }

  setCompacting(service: string, docPath: string, compacting: boolean): void {
    const state = this.documentStates.get(this.stateKey(service, docPath))
    if (state) {
      state.compacting = compacting
    }
  }

  resetUpdateCounters(service: string, docPath: string): void {
    const state = this.documentStates.get(this.stateKey(service, docPath))
    if (state) {
      state.updatesSizeBytes = 0
      state.updatesCount = 0
    }
  }

  updateSnapshotOffset(service: string, docPath: string, offset: string): void {
    const state = this.documentStates.get(this.stateKey(service, docPath))
    if (state) {
      state.snapshotOffset = offset
    }
  }

  getDsServerUrl(): string {
    return this.dsServerUrl
  }

  getDsServerHeaders(): Record<string, string> {
    return this.dsServerHeaders
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
