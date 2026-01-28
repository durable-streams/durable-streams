/**
 * Main request router for the proxy server.
 *
 * Routes requests to the appropriate handlers based on URL path and method.
 *
 * Routes:
 *   POST   /v1/proxy/{service}                    → Create stream
 *   GET    /v1/proxy/{service}/{stream_id}        → Read stream (pre-signed URL)
 *   PATCH  /v1/proxy/{service}/{stream_id}        → Abort stream (pre-signed URL, ?action=abort)
 *   DELETE /v1/proxy/{service}/{stream_id}        → Delete stream (service token)
 */

import { handleCreateStream } from "./create-stream"
import { handleReadStream } from "./read-stream"
import { handleAbortStream } from "./abort-stream"
import { handleDeleteStream } from "./delete-stream"
import { createAllowlistValidator } from "./allowlist"
import type { ProxyServerOptions } from "./types"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * URL pattern matchers for proxy routes.
 *
 * CREATE: POST /v1/proxy/{service}
 * STREAM: GET/PATCH/DELETE /v1/proxy/{service}/{stream_id}
 */
const CREATE_STREAM_PATTERN = /^\/v1\/proxy\/([^/]+)$/
const STREAM_PATTERN = /^\/v1\/proxy\/([^/]+)\/([^/?]+)$/

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

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? ``, `http://${req.headers.host}`)
    const path = url.pathname
    const method = req.method ?? `GET`

    // Set CORS headers for all responses
    res.setHeader(`Access-Control-Allow-Origin`, `*`)
    res.setHeader(
      `Access-Control-Allow-Methods`,
      `GET, POST, PATCH, DELETE, OPTIONS`
    )
    res.setHeader(
      `Access-Control-Allow-Headers`,
      `Content-Type, Authorization, Accept, Upstream-URL, Upstream-Method, Upstream-Authorization`
    )
    res.setHeader(
      `Access-Control-Expose-Headers`,
      `Location, Upstream-Content-Type, Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date`
    )

    // Handle preflight requests
    if (method === `OPTIONS`) {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      // Route: POST /v1/proxy/{service}
      // Creates a new stream and starts proxying upstream response
      const createMatch = path.match(CREATE_STREAM_PATTERN)
      if (createMatch && method === `POST`) {
        const serviceName = createMatch[1]!
        await handleCreateStream(req, res, serviceName, options, isAllowed)
        return
      }

      // Route: GET/PATCH/DELETE /v1/proxy/{service}/{stream_id}
      const streamMatch = path.match(STREAM_PATTERN)
      if (streamMatch) {
        const serviceName = streamMatch[1]!
        const streamId = streamMatch[2]!

        // GET: Read from stream
        if (method === `GET`) {
          await handleReadStream(req, res, serviceName, streamId, options)
          return
        }

        // PATCH: Abort stream (with ?action=abort)
        if (method === `PATCH`) {
          handleAbortStream(req, res, serviceName, streamId, options)
          return
        }

        // DELETE: Delete stream
        if (method === `DELETE`) {
          await handleDeleteStream(req, res, serviceName, streamId, options)
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
      res.writeHead(404, { "Content-Type": `application/json` })
      res.end(
        JSON.stringify({
          error: {
            code: `NOT_FOUND`,
            message: `Unknown route: ${method} ${path}`,
          },
        })
      )
    } catch (error) {
      // Internal server error
      const message = error instanceof Error ? error.message : `Unknown error`
      console.error(`Proxy handler error:`, error)

      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": `application/json` })
        res.end(
          JSON.stringify({
            error: {
              code: `INTERNAL_ERROR`,
              message,
            },
          })
        )
      }
    }
  }
}
