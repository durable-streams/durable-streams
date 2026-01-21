/**
 * Handler for reading proxy streams.
 *
 * GET /v1/proxy/{service}/streams/{key}?offset=-1&live=...
 *
 * Proxies read requests to the underlying durable streams server.
 * Requires a valid read token for authentication.
 */

import { authorizeStreamRequest } from "./tokens"
import { sendError } from "./response"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ProxyServerOptions } from "./types"

/**
 * Handle a read stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param serviceName - The service name from the URL path
 * @param streamKey - The stream key from the URL path
 * @param options - Proxy server options
 */
export async function handleReadStream(
  req: IncomingMessage,
  res: ServerResponse,
  serviceName: string,
  streamKey: string,
  options: ProxyServerOptions
): Promise<void> {
  // Authorize the request
  const auth = authorizeStreamRequest(
    req.headers.authorization,
    options.jwtSecret,
    serviceName,
    streamKey
  )

  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message)
    return
  }

  // Build the durable streams URL
  const incomingUrl = new URL(req.url ?? ``, `http://${req.headers.host}`)
  const dsUrl = new URL(auth.streamPath, options.durableStreamsUrl)

  // Forward query parameters
  const offset = incomingUrl.searchParams.get(`offset`)
  const live = incomingUrl.searchParams.get(`live`)
  const cursor = incomingUrl.searchParams.get(`cursor`)

  if (offset) {
    dsUrl.searchParams.set(`offset`, offset)
  }
  if (live) {
    dsUrl.searchParams.set(`live`, live)
  }
  if (cursor) {
    dsUrl.searchParams.set(`cursor`, cursor)
  }

  try {
    // Proxy the request to the durable streams server
    const dsResponse = await fetch(dsUrl.toString(), {
      method: `GET`,
      headers: {
        Accept: req.headers.accept ?? `text/event-stream`,
      },
    })

    // Forward response status and headers
    const responseHeaders: Record<string, string> = {}

    // Copy relevant headers from durable streams response
    const headersToCopy = [
      `content-type`,
      `stream-next-offset`,
      `stream-cursor`,
      `stream-up-to-date`,
      `cache-control`,
      `etag`,
    ]

    for (const header of headersToCopy) {
      const value = dsResponse.headers.get(header)
      if (value) {
        responseHeaders[header] = value
      }
    }

    // Set CORS headers
    responseHeaders[`access-control-allow-origin`] = `*`
    responseHeaders[`access-control-expose-headers`] =
      `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date`

    res.writeHead(dsResponse.status, responseHeaders)

    // Stream the response body
    if (dsResponse.body) {
      const reader = dsResponse.body.getReader()

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break

          // Write chunk to response
          const writeResult = res.write(value)
          if (!writeResult) {
            // Wait for drain if buffer is full
            await new Promise<void>((resolve) => res.once(`drain`, resolve))
          }
        }
      } finally {
        reader.releaseLock()
      }
    }

    res.end()
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : `Unknown error`
      sendError(res, 502, `UPSTREAM_ERROR`, message)
    } else {
      res.end()
    }
  }
}
