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
import { Compactor } from "./compaction"
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
      `authorization, content-type, stream-offset, stream-live, producer-id, producer-epoch, producer-seq, stream-producer-id, stream-producer-epoch, stream-producer-seq`
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
      // Check if this looks like a Yjs path but failed validation
      // (e.g., path traversal attempts)
      if (path.startsWith(`/v1/yjs/`)) {
        res.writeHead(400, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: {
              code: `INVALID_REQUEST`,
              message: `Invalid document path`,
            },
          })
        )
        return
      }

      // Not a Yjs route - proxy to DS server
      await this.proxyToDsServer(req, res, rawUrl)
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
      } else if (method === `HEAD`) {
        await this.handleDocumentHead(req, res, route)
      } else if (method === `POST`) {
        await this.handleUpdateWrite(req, res, route)
      } else if (method === `PUT`) {
        await this.handleDocumentCreate(req, res, route)
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

  // ---- Proxy for non-Yjs routes ----

  /**
   * Proxy requests that don't match Yjs routes to the underlying DS server.
   * This allows clients to use a single endpoint for both Yjs and raw DS operations.
   */
  private async proxyToDsServer(
    req: IncomingMessage,
    res: ServerResponse,
    path: string
  ): Promise<void> {
    const targetUrl = `${this.dsServerUrl}${path}`
    const method = req.method ?? `GET`

    // Read request body if present
    let body: Buffer | undefined
    if (method !== `GET` && method !== `HEAD`) {
      const chunks: Array<Buffer> = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      if (chunks.length > 0) {
        body = Buffer.concat(chunks)
      }
    }

    // Forward headers, excluding host
    const headers: Record<string, string> = { ...this.dsServerHeaders }
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() !== `host` && value) {
        headers[key] = Array.isArray(value) ? value.join(`, `) : value
      }
    }

    try {
      const response = await fetch(targetUrl, {
        method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
      })

      // Copy response status and headers
      // Note: fetch() automatically decompresses gzip/deflate responses,
      // so we must NOT forward content-encoding (data is already decompressed)
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        // Skip headers that don't apply after fetch decompression
        if (key === `content-encoding` || key === `content-length`) return
        responseHeaders[key] = value
      })

      res.writeHead(response.status, responseHeaders)

      // Stream response body
      if (response.body) {
        for await (const chunk of response.body) {
          res.write(chunk)
        }
      }

      res.end()
    } catch (err) {
      console.error(`[YjsServer] Proxy error for ${method} ${path}:`, err)
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": `application/json` })
        res.end(
          JSON.stringify({
            error: { code: `PROXY_ERROR`, message: `Failed to proxy request` },
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

      // Prefer JSON array format (DS JSON streams return arrays)
      try {
        const parsed = JSON.parse(body) as unknown
        if (Array.isArray(parsed)) {
          const last = parsed[parsed.length - 1] as YjsIndexEntry | undefined
          if (last?.snapshotOffset) {
            return last.snapshotOffset
          }
        } else if (
          parsed &&
          typeof parsed === `object` &&
          `snapshotOffset` in parsed
        ) {
          return (parsed as YjsIndexEntry).snapshotOffset
        }
      } catch {
        // Fall through to newline-delimited parsing
      }

      // Fallback: parse newline-delimited entries
      const lines = body.trim().split(`\n`)
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]?.trim()
        if (!line) continue
        try {
          const entry = JSON.parse(line) as YjsIndexEntry
          if (entry.snapshotOffset) {
            return entry.snapshotOffset
          }
        } catch {
          // Keep scanning
        }
      }

      return null
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

  // ---- Proxies to .updates stream ----

  /**
   * GET - Proxy to read from .updates stream.
   * Maps live=true to long-poll for updates.
   */
  private async handleUpdatesRead(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteMatch,
    offset: string | null,
    live: string | null,
    _url: URL
  ): Promise<void> {
    let dsPath = YjsStreamPaths.dsStream(route.service, route.docPath)

    // Build query string
    const params = new URLSearchParams()
    if (offset !== null) {
      params.set(`offset`, offset)
    }
    if (live) {
      // live=true means "server picks transport" - use long-poll for updates
      params.set(`live`, live === `true` ? `long-poll` : live)
    }
    const query = params.toString()
    if (query) {
      dsPath = `${dsPath}?${query}`
    }

    await this.proxyToDsServer(req, res, dsPath)
  }

  /**
   * HEAD - Proxy to check .updates stream existence.
   */
  private async handleDocumentHead(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteMatch
  ): Promise<void> {
    const dsPath = YjsStreamPaths.dsStream(route.service, route.docPath)
    await this.proxyToDsServer(req, res, dsPath)
  }

  /**
   * PUT - Proxy to create .updates stream.
   */
  private async handleDocumentCreate(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteMatch
  ): Promise<void> {
    const dsPath = YjsStreamPaths.dsStream(route.service, route.docPath)
    await this.proxyToDsServer(req, res, dsPath)
  }

  /**
   * POST - Streaming proxy to write to .updates stream.
   * Client sends lib0-framed updates; we pass through directly.
   */
  private async handleUpdateWrite(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteMatch
  ): Promise<void> {
    const stateKey = this.stateKey(route.service, route.docPath)

    // Client sends lib0-framed updates - pass through directly
    // (Client frames each update before batching to handle IdempotentProducer concatenation)
    const body = await this.readBody(req)

    const dsPath = YjsStreamPaths.dsStream(route.service, route.docPath)
    const dsUrl = new URL(dsPath, this.dsServerUrl)

    // Forward headers including producer headers
    const headers: Record<string, string> = {
      ...this.dsServerHeaders,
      "content-type": `application/octet-stream`,
    }
    for (const h of [
      `producer-id`,
      `producer-epoch`,
      `producer-seq`,
      `stream-producer-id`,
      `stream-producer-epoch`,
      `stream-producer-seq`,
    ]) {
      const v = req.headers[h]
      if (typeof v === `string`) headers[h] = v
    }

    const dsResponse = await fetch(dsUrl.toString(), {
      method: `POST`,
      headers,
      body: Buffer.from(body),
    })

    // Forward response headers (skip content-encoding/length - fetch decompresses)
    const responseHeaders: Record<string, string> = {}
    dsResponse.headers.forEach((value, key) => {
      if (key === `content-encoding` || key === `content-length`) return
      responseHeaders[key] = value
    })

    res.writeHead(dsResponse.status, responseHeaders)

    if (dsResponse.body) {
      for await (const chunk of dsResponse.body) {
        res.write(chunk)
      }
    }

    res.end()

    // Track for compaction on success
    if (dsResponse.status >= 200 && dsResponse.status < 300) {
      if (!this.documentStates.has(stateKey)) {
        this.documentStates.set(stateKey, {
          snapshotOffset: null,
          updatesSizeBytes: 0,
          updatesCount: 0,
          compacting: false,
        })
      }
      const state = this.documentStates.get(stateKey)!
      state.updatesSizeBytes += body.length
      state.updatesCount += 1

      // Trigger compaction if thresholds met
      if (this.shouldTriggerCompaction(state)) {
        this.compactor
          .triggerCompaction(route.service, route.docPath)
          .catch((err) => {
            console.error(`[YjsServer] Compaction error:`, err)
          })
      }
    }
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
    const dsPath = YjsStreamPaths.awarenessStream(
      route.service,
      route.docPath,
      awarenessName
    )

    if (method === `POST`) {
      // Ensure awareness stream exists, then append base64-encoded payload
      await this.ensureAwarenessStream(
        route.service,
        route.docPath,
        awarenessName
      )

      const body = await this.readBody(req)
      // Awareness writes are binary, but SSE is text-only. Encode to base64
      // before appending so reads over SSE deliver base64 strings.
      const base64 = Buffer.from(body).toString(`base64`)

      const dsUrl = new URL(dsPath, this.dsServerUrl)

      // Forward producer headers if present
      const headers: Record<string, string> = {
        ...this.dsServerHeaders,
        "content-type": `text/plain`,
      }
      for (const h of [
        `producer-id`,
        `producer-epoch`,
        `producer-seq`,
        `stream-producer-id`,
        `stream-producer-epoch`,
        `stream-producer-seq`,
      ]) {
        const v = req.headers[h]
        if (typeof v === `string`) headers[h] = v
      }

      const dsResponse = await fetch(dsUrl.toString(), {
        method: `POST`,
        headers,
        body: Buffer.from(base64),
      })

      // Forward response headers (skip content-encoding/length - fetch decompresses)
      const responseHeaders: Record<string, string> = {}
      dsResponse.headers.forEach((value, key) => {
        if (key === `content-encoding` || key === `content-length`) return
        responseHeaders[key] = value
      })

      res.writeHead(dsResponse.status, responseHeaders)

      if (dsResponse.body) {
        for await (const chunk of dsResponse.body) {
          res.write(chunk)
        }
      }

      res.end()
    } else if (method === `GET`) {
      // Build path with query params
      const offset = url.searchParams.get(`offset`)
      const live = url.searchParams.get(`live`)

      const params = new URLSearchParams()
      if (offset !== null) {
        params.set(`offset`, offset)
      }
      if (live) {
        // live=true means "server picks transport" - use SSE for awareness
        params.set(`live`, live === `true` ? `sse` : live)
      }

      const query = params.toString()
      const fullPath = query ? `${dsPath}?${query}` : dsPath

      // For SSE, we need special handling with flush
      if (live === `sse` || live === `true`) {
        await this.proxyWithSseFlush(req, res, fullPath)
      } else {
        await this.proxyToDsServer(req, res, fullPath)
      }
    } else if (method === `HEAD`) {
      await this.proxyToDsServer(req, res, dsPath)
    } else {
      res.writeHead(405, { "content-type": `application/json` })
      res.end(
        JSON.stringify({
          error: { code: `INVALID_REQUEST`, message: `Method not allowed` },
        })
      )
    }
  }

  /**
   * Proxy with SSE-specific handling: flush after each chunk for immediate delivery.
   */
  private async proxyWithSseFlush(
    req: IncomingMessage,
    res: ServerResponse,
    path: string
  ): Promise<void> {
    const targetUrl = `${this.dsServerUrl}${path}`

    const response = await fetch(targetUrl, {
      method: `GET`,
      headers: this.dsServerHeaders,
    })

    // Forward headers with SSE additions (skip content-encoding/length - fetch decompresses)
    const responseHeaders: Record<string, string> = {
      "cache-control": `no-cache`,
      connection: `keep-alive`,
    }
    response.headers.forEach((value, key) => {
      if (key === `content-encoding` || key === `content-length`) return
      responseHeaders[key] = value
    })

    res.writeHead(response.status, responseHeaders)

    if (response.body) {
      for await (const chunk of response.body) {
        res.write(chunk)
        // Flush for SSE to ensure immediate delivery
        const flushable = res as unknown as { flush?: () => void }
        flushable.flush?.()
      }
    }

    res.end()
  }

  // ---- Stream management ----

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
