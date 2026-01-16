/**
 * Main request router for the proxy server.
 *
 * Routes requests to the appropriate handlers based on URL path and method.
 */

import { handleCreateStream } from "./create-stream"
import { handleReadStream } from "./read-stream"
import { handleAbortStream } from "./abort-stream"
import { createAllowlistValidator } from "./allowlist"
import type { ProxyServerOptions } from "./types"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * URL pattern matchers for proxy routes.
 */
const CREATE_STREAM_PATTERN = /^\/v1\/proxy\/([^/]+)$/
const READ_STREAM_PATTERN = /^\/v1\/proxy\/([^/]+)\/streams\/([^/]+)$/
const ABORT_STREAM_PATTERN = /^\/v1\/proxy\/([^/]+)\/streams\/([^/]+)\/abort$/

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
      `GET, POST, PUT, DELETE, OPTIONS`
    )
    res.setHeader(
      `Access-Control-Allow-Headers`,
      `Content-Type, Authorization, Accept`
    )
    res.setHeader(
      `Access-Control-Expose-Headers`,
      `Durable-Streams-Path, Durable-Streams-Read-Token, Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date`
    )

    // Handle preflight requests
    if (method === `OPTIONS`) {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      // Route: POST /v1/proxy/{service}?stream_key=...&upstream=...
      // Creates a new stream and starts proxying upstream response
      const createMatch = path.match(CREATE_STREAM_PATTERN)
      if (createMatch && method === `POST`) {
        const serviceName = createMatch[1]!
        await handleCreateStream(req, res, serviceName, options, isAllowed)
        return
      }

      // Route: POST /v1/proxy/{service}/streams/{key}/abort
      // Aborts an in-progress stream
      const abortMatch = path.match(ABORT_STREAM_PATTERN)
      if (abortMatch && method === `POST`) {
        const serviceName = abortMatch[1]!
        const streamKey = abortMatch[2]!
        handleAbortStream(req, res, serviceName, streamKey, options)
        return
      }

      // Route: GET /v1/proxy/{service}/streams/{key}?offset=...&live=...
      // Reads from an existing stream
      const readMatch = path.match(READ_STREAM_PATTERN)
      if (readMatch && method === `GET`) {
        const serviceName = readMatch[1]!
        const streamKey = readMatch[2]!
        await handleReadStream(req, res, serviceName, streamKey, options)
        return
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
