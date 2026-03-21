/**
 * Node.js HTTP server adapter for durable streams.
 * Wraps the runtime-agnostic fetch handler with node:http for local dev/testing.
 */

import { createServer } from "node:http"
import { deflateSync, gzipSync } from "node:zlib"
import { MemoryStore } from "./storage/memory"
import { FileBackedStreamStore } from "./file-store"
import { DurableStreamHandler } from "./handler"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { TestServerOptions } from "./types"

const COMPRESSION_THRESHOLD = 1024

function getCompressionEncoding(
  acceptEncoding: string | undefined
): `gzip` | `deflate` | null {
  if (!acceptEncoding) return null

  const encodings = acceptEncoding
    .toLowerCase()
    .split(`,`)
    .map((e) => e.trim())

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

async function nodeRequestToWebRequest(
  req: IncomingMessage,
  baseUrl: string
): Promise<Request> {
  const url = new URL(req.url ?? `/`, baseUrl)
  const method = req.method ?? `GET`

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === `string`) {
      headers.set(key, value)
    } else if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v)
      }
    }
  }

  const hasBody = method !== `GET` && method !== `HEAD` && method !== `OPTIONS`
  let body: ArrayBuffer | null = null
  if (hasBody) {
    body = await new Promise<ArrayBuffer>((resolve, reject) => {
      const chunks: Array<Buffer> = []
      req.on(`data`, (chunk: Buffer) => chunks.push(chunk))
      req.on(`end`, () => {
        const buf = Buffer.concat(chunks)
        resolve(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        )
      })
      req.on(`error`, reject)
    })
  }

  return new Request(url.toString(), {
    method,
    headers,
    body,
    duplex: `half` as any,
  })
}

async function writeWebResponseToNode(
  webResponse: Response,
  nodeRes: ServerResponse,
  compression: boolean,
  acceptEncoding: string | undefined
): Promise<void> {
  const headers: Record<string, string> = {}
  webResponse.headers.forEach((value, key) => {
    headers[key] = value
  })

  const contentType = headers[`content-type`] ?? ``
  const isSSE = contentType === `text/event-stream`

  if (isSSE) {
    nodeRes.writeHead(webResponse.status, headers)

    if (webResponse.body) {
      const reader = webResponse.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const canContinue = nodeRes.write(value)
          if (!canContinue) {
            await new Promise<void>((resolve) => nodeRes.once(`drain`, resolve))
          }
        }
      } catch {
        // Connection closed
      } finally {
        reader.releaseLock()
      }
    }

    nodeRes.end()
    return
  }

  if (!webResponse.body) {
    nodeRes.writeHead(webResponse.status, headers)
    nodeRes.end()
    return
  }

  let bodyData = new Uint8Array(await webResponse.arrayBuffer())

  if (compression && bodyData.length >= COMPRESSION_THRESHOLD) {
    const compressionEncoding = getCompressionEncoding(acceptEncoding)
    if (compressionEncoding) {
      bodyData = compressData(bodyData, compressionEncoding)
      headers[`content-encoding`] = compressionEncoding
      headers[`vary`] = `accept-encoding`
    }
  }

  nodeRes.writeHead(webResponse.status, headers)
  nodeRes.end(Buffer.from(bodyData))
}

export class DurableStreamTestServer {
  readonly store: MemoryStore | FileBackedStreamStore
  readonly handler: DurableStreamHandler
  private server: Server | null = null
  private options: {
    port: number
    host: string
    dataDir?: string
    compression: boolean
  }
  private _url: string | null = null
  private activeSSEResponses = new Set<ServerResponse>()
  private isShuttingDown = false

  constructor(options: TestServerOptions = {}) {
    if (options.dataDir) {
      this.store = new FileBackedStreamStore({
        dataDir: options.dataDir,
      })
    } else {
      this.store = new MemoryStore()
    }

    this.options = {
      port: options.port ?? 4437,
      host: options.host ?? `127.0.0.1`,
      dataDir: options.dataDir,
      compression: options.compression ?? true,
    }

    this.handler = new DurableStreamHandler({
      store: this.store,
      longPollTimeout: options.longPollTimeout ?? 30_000,
      onStreamCreated: options.onStreamCreated,
      onStreamDeleted: options.onStreamDeleted,
      cursorOptions: {
        intervalSeconds: options.cursorIntervalSeconds,
        epoch: options.cursorEpoch,
      },
    })
  }

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
        this.handler.options.baseUrl = this._url!
        resolve(this._url!)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    this.isShuttingDown = true
    await this.handler.shutdown()

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
          if (this.store instanceof FileBackedStreamStore) {
            await this.store.close()
          }

          this.server = null
          this._url = null
          this.isShuttingDown = false
          this.handler.resetShutdown()
          resolve()
        } catch (closeErr) {
          reject(closeErr)
        }
      })
    })
  }

  get url(): string {
    if (!this._url) {
      throw new Error(`Server not started`)
    }
    return this._url
  }

  clear(): void {
    this.store.clear()
  }

  /** @deprecated Use injectFault for full fault injection capabilities */
  injectError(
    path: string,
    status: number,
    count: number = 1,
    retryAfter?: number
  ): void {
    this.handler.injectFault(path, { status, count, retryAfter })
  }

  injectFault(
    path: string,
    fault: { count?: number; [key: string]: unknown }
  ): void {
    this.handler.injectFault(path, fault as any)
  }

  clearInjectedFaults(): void {
    this.handler.clearInjectedFaults()
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const baseUrl =
      this._url ?? `http://${this.options.host}:${this.options.port}`
    const webRequest = await nodeRequestToWebRequest(req, baseUrl)

    const isSSE =
      webRequest.method === `GET` &&
      new URL(webRequest.url).searchParams.get(`live`) === `sse`

    if (isSSE) {
      this.activeSSEResponses.add(res)
      res.on(`close`, () => {
        this.activeSSEResponses.delete(res)
      })
    }

    const acceptEncoding = req.headers[`accept-encoding`]

    const webResponse = await this.handler.fetch(webRequest)

    // Handle dropConnection: the handler signals this with a custom header
    // since it can't actually destroy the socket
    if (webResponse.headers.get(`x-drop-connection`) === `true`) {
      res.socket?.destroy()
      return
    }

    await writeWebResponseToNode(
      webResponse,
      res,
      this.options.compression,
      acceptEncoding
    )
  }
}
