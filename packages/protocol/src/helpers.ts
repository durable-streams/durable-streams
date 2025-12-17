/**
 * Helper functions for building protocols.
 */

import { Hono } from "hono"
import type { Context } from "hono"
import type { Protocol, ProtocolConfig, ProtocolHonoEnv } from "./types"
import { createStreamMiddleware } from "./context"

/**
 * Define a protocol with a simple factory function.
 *
 * @example
 * ```typescript
 * const myProtocol = defineProtocol({
 *   name: 'my-protocol',
 *   namespace: '/my',
 *   setup: (app, config) => {
 *     app.get('/docs/:id', (c) => {
 *       const stream = c.var.stream(`docs/${c.req.param('id')}`)
 *       // ... use stream
 *     })
 *   }
 * })
 * ```
 */
export function defineProtocol(options: {
  name: string
  namespace: string
  setup: (app: Hono<ProtocolHonoEnv>, config: ProtocolConfig) => void
}): Protocol {
  return {
    name: options.name,
    namespace: options.namespace,
    createApp(config: ProtocolConfig) {
      const app = new Hono<ProtocolHonoEnv>()

      // Add middleware to set up stream context
      app.use(`*`, createStreamMiddleware(options.namespace, config))

      // Run user setup
      options.setup(app, config)

      return app
    },
  }
}

/**
 * Get a stream handle from the Hono context.
 * Shorthand for `c.var.stream(subpath)`.
 */
export function stream(c: Context<ProtocolHonoEnv>, subpath: string) {
  return c.var.stream(subpath)
}

/**
 * HTTP error that can be thrown to return an error response.
 */
export class HTTPError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown
  ) {
    super(message)
    this.name = `HTTPError`
  }
}

/**
 * Throw a 400 Bad Request error.
 */
export function badRequest(message: string, details?: unknown): never {
  throw new HTTPError(400, message, details)
}

/**
 * Throw a 404 Not Found error.
 */
export function notFound(message = `Not found`): never {
  throw new HTTPError(404, message)
}

/**
 * Throw a 409 Conflict error.
 */
export function conflict(message: string, details?: unknown): never {
  throw new HTTPError(409, message, details)
}

/**
 * Throw a 500 Internal Server Error.
 */
export function serverError(message = `Internal server error`): never {
  throw new HTTPError(500, message)
}

/**
 * Error handler middleware for protocols.
 * Catches HTTPError and returns JSON error responses.
 */
export function errorHandler(): import("hono").MiddlewareHandler<ProtocolHonoEnv> {
  return async (c, next) => {
    try {
      await next()
    } catch (error) {
      if (error instanceof HTTPError) {
        return c.json(
          { error: error.message, details: error.details },
          error.status as 400
        )
      }
      throw error
    }
  }
}
