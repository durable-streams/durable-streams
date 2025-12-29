/**
 * CORS middleware for cross-origin resource sharing support.
 */

import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Options for configuring CORS middleware.
 */
export interface CORSOptions {
  /**
   * Access-Control-Allow-Origin header value.
   * Default: "*" (allow all origins)
   */
  origin?: string

  /**
   * Access-Control-Allow-Methods header value.
   * Default: "GET, POST, PUT, DELETE, HEAD, OPTIONS"
   */
  methods?: string

  /**
   * Access-Control-Allow-Headers header value.
   * Default: "content-type, x-cursor-epoch, x-cursor-interval"
   */
  headers?: string

  /**
   * Access-Control-Max-Age header value (in seconds).
   * Default: 86400 (24 hours)
   */
  maxAge?: number
}

/**
 * Middleware for adding CORS headers to responses.
 * Automatically handles OPTIONS preflight requests.
 */
export class CORSMiddleware {
  private options: Required<CORSOptions>

  constructor(options: CORSOptions = {}) {
    this.options = {
      origin: options.origin ?? `*`,
      methods: options.methods ?? `GET, POST, PUT, DELETE, HEAD, OPTIONS`,
      headers:
        options.headers ?? `content-type, x-cursor-epoch, x-cursor-interval`,
      maxAge: options.maxAge ?? 86400,
    }
  }

  /**
   * Middleware handler.
   * Adds CORS headers to all responses and handles OPTIONS preflight requests.
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => Promise<void>
  ): Promise<void> {
    // Add CORS headers
    res.setHeader(`access-control-allow-origin`, this.options.origin)
    res.setHeader(`access-control-allow-methods`, this.options.methods)
    res.setHeader(`access-control-allow-headers`, this.options.headers)
    res.setHeader(`access-control-max-age`, this.options.maxAge.toString())

    // Handle preflight OPTIONS request
    if (req.method?.toUpperCase() === `OPTIONS`) {
      res.writeHead(204)
      res.end()
      return
    }

    // Continue to next handler
    await next()
  }
}
