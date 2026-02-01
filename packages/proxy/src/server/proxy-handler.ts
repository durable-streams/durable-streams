/**
 * Main request router for the proxy server.
 *
 * Routes requests to the appropriate handlers based on URL path and method.
 */

import { handleCreateStream } from "./create-stream"
import { handleReadStream } from "./read-stream"
import { handleHeadStream } from "./head-stream"
import { handleAbortStream } from "./abort-stream"
import { handleDeleteStream } from "./delete-stream"
import { handleRenewStream } from "./renew-stream"
import { createAllowlistValidator } from "./allowlist"
import { sendError } from "./response"
import type { ProxyServerOptions } from "./types"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * URL pattern matchers for proxy routes.
 */
const PROXY_BASE = /^\/v1\/proxy\/?$/ // POST /v1/proxy
const PROXY_RENEW = /^\/v1\/proxy\/renew\/?$/ // POST /v1/proxy/renew
const PROXY_STREAM = /^\/v1\/proxy\/([^/]+)$/ // GET/HEAD/PATCH/DELETE /v1/proxy/:streamId

/**
 * Set CORS headers on response.
 */
function setCorsHeaders(res: ServerResponse): void {
  res.setHeader(`Access-Control-Allow-Origin`, `*`)
  res.setHeader(
    `Access-Control-Allow-Methods`,
    `GET, POST, HEAD, PATCH, DELETE, OPTIONS`
  )
  res.setHeader(
    `Access-Control-Allow-Headers`,
    `Upstream-URL, Upstream-Authorization, Upstream-Method, Content-Type, Authorization, Use-Stream-Url, X-Stream-TTL`
  )
  res.setHeader(
    `Access-Control-Expose-Headers`,
    [
      `Location`,
      `Upstream-Content-Type`,
      `Upstream-Status`,
      `Stream-Next-Offset`,
      `Stream-Up-To-Date`,
      `Stream-Total-Size`,
      `Stream-Write-Units`,
      `Stream-Closed`,
      `Stream-Expires-At`,
    ].join(`, `)
  )
}

/**
 * Create the main request handler for the proxy server.
 *
 * @param options - Proxy server options
 * @returns Request handler function
 */
export function createProxyHandler(
  options: ProxyServerOptions
): (req: IncomingMessage, res: ServerResponse) => void {
  // Create the allowlist validator
  const isAllowed = createAllowlistValidator(options.allowlist ?? [])

  // Content type store for tracking upstream content types
  const contentTypeStore = new Map<string, string>()

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? ``, `http://${req.headers.host}`)
    const path = url.pathname
    const method = req.method ?? `GET`

    // Set CORS headers for all responses
    setCorsHeaders(res)

    // Handle preflight requests
    if (method === `OPTIONS`) {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      // Route: POST /v1/proxy/renew - Renew stream URL
      // (must check before PROXY_STREAM to avoid matching "renew" as streamId)
      if (PROXY_RENEW.test(path) && method === `POST`) {
        await handleRenewStream(req, res, options, isAllowed)
        return
      }

      // Route: POST /v1/proxy - Create stream
      if (PROXY_BASE.test(path) && method === `POST`) {
        await handleCreateStream(req, res, options, isAllowed, contentTypeStore)
        return
      }

      // Routes with streamId
      const match = path.match(PROXY_STREAM)
      if (match) {
        const streamId = decodeURIComponent(match[1]!)

        switch (method) {
          case `GET`:
            await handleReadStream(
              req,
              res,
              streamId,
              options,
              contentTypeStore
            )
            return

          case `HEAD`:
            await handleHeadStream(
              req,
              res,
              streamId,
              options,
              contentTypeStore
            )
            return

          case `PATCH`:
            handleAbortStream(req, res, streamId, options)
            return

          case `DELETE`:
            await handleDeleteStream(
              req,
              res,
              streamId,
              options,
              contentTypeStore
            )
            return
        }
      }

      // Health check endpoint
      if (path === `/health` && method === `GET`) {
        res.writeHead(200, { "Content-Type": `application/json` })
        res.end(JSON.stringify({ status: `ok` }))
        return
      }

      // Not found
      sendError(res, 404, `NOT_FOUND`, `Unknown route: ${method} ${path}`)
    } catch (error) {
      // Internal server error
      const message = error instanceof Error ? error.message : `Unknown error`
      console.error(`Proxy handler error:`, error)

      if (!res.headersSent) {
        sendError(res, 500, `INTERNAL_ERROR`, message)
      }
    }
  }
}
