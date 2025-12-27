/**
 * HTTP server for durable streams testing.
 */

import { createServer } from "node:http"
import { StreamStore } from "./store"
import { FileBackedStreamStore } from "./file-store"
import { DurableStreamRouter } from "./router"
import { FaultInjectionMiddleware } from "./fault-injection"
import type { Server } from "node:http"
import type { TestServerOptions } from "./types"

/**
 * HTTP server for testing durable streams.
 * Supports both in-memory and file-backed storage modes.
 * Includes fault injection capabilities for testing retry/resilience.
 */
export class DurableStreamTestServer {
  readonly store: StreamStore | FileBackedStreamStore
  private router: DurableStreamRouter
  private faultInjection: FaultInjectionMiddleware
  private server: Server | null = null
  private options: Required<Pick<TestServerOptions, `port` | `host`>> & {
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
      port: options.port ?? 4437,
      host: options.host ?? `127.0.0.1`,
      dataDir: options.dataDir,
    }

    // Create router with all routing options
    this.router = new DurableStreamRouter({
      store: this.store,
      longPollTimeout: options.longPollTimeout,
      compression: options.compression,
      cors: true, // Always enabled for test server
      cursorIntervalSeconds: options.cursorIntervalSeconds,
      cursorEpoch: options.cursorEpoch,
      onStreamCreated: options.onStreamCreated,
      onStreamDeleted: options.onStreamDeleted,
    })

    // Create fault injection middleware with test endpoint enabled
    this.faultInjection = new FaultInjectionMiddleware({
      enableTestEndpoint: true,
    })
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
        // Compose fault injection middleware with router
        this.faultInjection
          .handleRequest(req, res, () => this.router.handleRequest(req, res))
          .catch((err) => {
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

    // Shutdown router (closes SSE connections, cancels pending polls)
    await this.router.shutdown()

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
    this.router.clear()
  }

  /**
   * Inject an error to be returned on the next N requests to a path.
   * Used for testing retry/resilience behavior.
   */
  injectError(
    path: string,
    status: number,
    count: number = 1,
    retryAfter?: number
  ): void {
    this.faultInjection.injectError(path, status, count, retryAfter)
  }

  /**
   * Clear all injected errors.
   */
  clearInjectedErrors(): void {
    this.faultInjection.clearInjectedErrors()
  }
}
