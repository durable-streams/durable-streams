/**
 * Handler for getting stream metadata.
 *
 * HEAD /v1/proxy/:streamId
 *
 * Returns stream metadata without body. Service JWT authentication only.
 */

import { validateServiceJwt } from "./tokens"
import { sendError } from "./response"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ProxyServerOptions } from "./types"

/**
 * Handle a HEAD stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param streamId - The stream ID from the URL path
 * @param options - Proxy server options
 * @param contentTypeStore - Map of stream IDs to upstream content types
 */
export async function handleHeadStream(
  req: IncomingMessage,
  res: ServerResponse,
  streamId: string,
  options: ProxyServerOptions,
  contentTypeStore: Map<string, string>
): Promise<void> {
  const url = new URL(req.url ?? ``, `http://${req.headers.host}`)

  // Authentication: service JWT only (no pre-signed URL fallback)
  const auth = validateServiceJwt(
    url.searchParams.get(`secret`),
    req.headers.authorization,
    options.jwtSecret
  )

  if (!auth.ok) {
    const { code } = auth
    sendError(
      res,
      401,
      code,
      code === `MISSING_SECRET`
        ? `Service authentication required`
        : `Invalid service credentials`
    )
    return
  }

  // Get metadata from underlying durable stream
  const dsUrl = new URL(`/v1/streams/${streamId}`, options.durableStreamsUrl)

  try {
    // Use HEAD request to underlying server
    const dsResponse = await fetch(dsUrl.toString(), {
      method: `HEAD`,
    })

    if (dsResponse.status === 404) {
      sendError(res, 404, `STREAM_NOT_FOUND`, `Stream does not exist`)
      return
    }
    if (!dsResponse.ok) {
      sendError(
        res,
        502,
        `STORAGE_ERROR`,
        `Failed to fetch stream metadata from durable storage`
      )
      return
    }

    // Build response headers
    const responseHeaders: Record<string, string> = {}

    // Copy Stream-* headers from durable stream
    const streamHeaders = [
      `stream-next-offset`,
      `stream-total-size`,
      `stream-write-units`,
      `stream-expires-at`,
    ]

    for (const header of streamHeaders) {
      const value = dsResponse.headers.get(header)
      if (value) {
        responseHeaders[header] = value
      }
    }

    // Add Upstream-Content-Type from content type store
    const upstreamContentType = contentTypeStore.get(streamId)
    if (upstreamContentType) {
      responseHeaders[`Upstream-Content-Type`] = upstreamContentType
    }

    // CORS headers
    responseHeaders[`Access-Control-Allow-Origin`] = `*`
    responseHeaders[`Access-Control-Expose-Headers`] = [
      `Stream-Next-Offset`,
      `Stream-Total-Size`,
      `Stream-Write-Units`,
      `Stream-Expires-At`,
      `Upstream-Content-Type`,
    ].join(`, `)

    res.writeHead(dsResponse.status, responseHeaders)
    res.end() // No body for HEAD
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : `Unknown error`
      sendError(res, 502, `UPSTREAM_ERROR`, message)
    } else {
      console.error(`Error in HEAD request for ${streamId}:`, error)
      res.end()
    }
  }
}
