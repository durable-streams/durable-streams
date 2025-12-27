/**
 * Fault injection middleware for testing retry/resilience behavior.
 */

import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Configuration for injected errors (for testing retry/resilience).
 */
export interface InjectedError {
  /** HTTP status code to return */
  status: number
  /** Number of times to return this error (decremented on each use) */
  count: number
  /** Optional Retry-After header value (seconds) */
  retryAfter?: number
}

/**
 * Options for configuring fault injection middleware.
 */
export interface FaultInjectionOptions {
  /**
   * Enable the /_test/inject-error test endpoint.
   * Default: false (disabled for production safety).
   */
  enableTestEndpoint?: boolean
}

/**
 * Middleware for injecting errors to test retry/resilience behavior.
 * This is intended for testing only and should not be used in production.
 */
export class FaultInjectionMiddleware {
  private injectedErrors = new Map<string, InjectedError>()
  private options: Required<FaultInjectionOptions>

  constructor(options: FaultInjectionOptions = {}) {
    this.options = {
      enableTestEndpoint: options.enableTestEndpoint ?? false,
    }
  }

  /**
   * Middleware handler.
   * Call this before your main router handler.
   * If an error is injected for the path, it will be returned and next() won't be called.
   * Otherwise, next() will be called to continue to the main handler.
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => Promise<void>
  ): Promise<void> {
    const url = new URL(req.url ?? `/`, `http://${req.headers.host}`)
    const path = url.pathname
    const method = req.method?.toUpperCase()

    // Handle test control endpoint if enabled
    if (this.options.enableTestEndpoint && path === `/_test/inject-error`) {
      await this.handleTestEndpoint(method, req, res)
      return
    }

    // Check for injected errors
    const injectedError = this.consumeInjectedError(path)
    if (injectedError) {
      const headers: Record<string, string> = {
        "content-type": `text/plain`,
      }
      if (injectedError.retryAfter !== undefined) {
        headers[`retry-after`] = injectedError.retryAfter.toString()
      }
      res.writeHead(injectedError.status, headers)
      res.end(`Injected error for testing`)
      return
    }

    // No error injected, continue to next handler
    await next()
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
    this.injectedErrors.set(path, { status, count, retryAfter })
  }

  /**
   * Clear all injected errors.
   */
  clearInjectedErrors(): void {
    this.injectedErrors.clear()
  }

  /**
   * Check if there's an injected error for this path and consume it.
   * Returns the error config if one should be returned, null otherwise.
   */
  private consumeInjectedError(path: string): InjectedError | null {
    const error = this.injectedErrors.get(path)
    if (!error) return null

    error.count--
    if (error.count <= 0) {
      this.injectedErrors.delete(path)
    }

    return error
  }

  /**
   * Handle test control endpoints for error injection.
   * POST /_test/inject-error - inject an error
   * DELETE /_test/inject-error - clear all injected errors
   */
  private async handleTestEndpoint(
    method: string | undefined,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (method === `POST`) {
      const body = await this.readBody(req)
      try {
        const config = JSON.parse(new TextDecoder().decode(body)) as {
          path: string
          status: number
          count?: number
          retryAfter?: number
        }

        if (!config.path || !config.status) {
          res.writeHead(400, { "content-type": `text/plain` })
          res.end(`Missing required fields: path, status`)
          return
        }

        this.injectError(
          config.path,
          config.status,
          config.count ?? 1,
          config.retryAfter
        )

        res.writeHead(200, { "content-type": `application/json` })
        res.end(JSON.stringify({ ok: true }))
      } catch {
        res.writeHead(400, { "content-type": `text/plain` })
        res.end(`Invalid JSON body`)
      }
    } else if (method === `DELETE`) {
      this.clearInjectedErrors()
      res.writeHead(200, { "content-type": `application/json` })
      res.end(JSON.stringify({ ok: true }))
    } else {
      res.writeHead(405, { "content-type": `text/plain` })
      res.end(`Method not allowed`)
    }
  }

  /**
   * Read request body.
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
