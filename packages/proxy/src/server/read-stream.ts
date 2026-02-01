/**
 * Handler for reading proxy streams.
 *
 * GET /v1/proxy/:streamId
 *
 * Proxies read requests to the underlying durable streams server.
 * Supports pre-signed URL authentication or service JWT.
 */

import { validatePreSignedUrl, validateServiceJwt } from "./tokens"
import { sendError, sendExpiredUrlError } from "./response"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ProxyServerOptions } from "./types"

/**
 * Handle a read stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param streamId - The stream ID from the URL path
 * @param options - Proxy server options
 * @param contentTypeStore - Map of stream IDs to upstream content types
 */
export async function handleReadStream(
  req: IncomingMessage,
  res: ServerResponse,
  streamId: string,
  options: ProxyServerOptions,
  contentTypeStore: Map<string, string>
): Promise<void> {
  const url = new URL(req.url ?? ``, `http://${req.headers.host}`)

  // Authentication: try pre-signed URL first, then fall back to service JWT
  const expires = url.searchParams.get(`expires`)
  const signature = url.searchParams.get(`signature`)

  if (expires && signature) {
    // Validate pre-signed URL
    const result = validatePreSignedUrl(
      streamId,
      expires,
      signature,
      options.jwtSecret
    )

    if (!result.ok) {
      const { code } = result
      if (code === `SIGNATURE_EXPIRED`) {
        // Return structured error with renewable flag for expired URLs
        sendExpiredUrlError(
          res,
          code,
          `Pre-signed URL has expired`,
          result.hmacValid,
          streamId
        )
      } else {
        sendError(res, 401, code, `Invalid signature`)
      }
      return
    }
  } else {
    // Fall back to service JWT
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
          ? `Authentication required`
          : `Invalid credentials`
      )
      return
    }
  }

  // Build the durable streams URL
  const dsUrl = new URL(`/v1/streams/${streamId}`, options.durableStreamsUrl)

  // Forward query parameters
  const offset = url.searchParams.get(`offset`)
  const live = url.searchParams.get(`live`)

  if (offset) {
    dsUrl.searchParams.set(`offset`, offset)
  }
  if (live) {
    dsUrl.searchParams.set(`live`, live)
  }

  try {
    // Proxy the request to the durable streams server
    const dsResponse = await fetch(dsUrl.toString(), {
      method: `GET`,
      headers: {
        Accept: req.headers.accept ?? `*/*`,
      },
    })

    // Build response headers
    const responseHeaders: Record<string, string> = {}

    // Copy Stream-* headers from durable stream
    const streamHeaders = [
      `stream-next-offset`,
      `stream-up-to-date`,
      `stream-total-size`,
      `stream-write-units`,
      `stream-closed`,
      `stream-expires-at`,
    ]

    for (const header of streamHeaders) {
      const value = dsResponse.headers.get(header)
      if (value) {
        responseHeaders[header] = value
      }
    }

    // Copy content-type from durable stream
    const contentType = dsResponse.headers.get(`content-type`)
    if (contentType) {
      responseHeaders[`content-type`] = contentType
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
      `Stream-Up-To-Date`,
      `Stream-Total-Size`,
      `Stream-Write-Units`,
      `Stream-Closed`,
      `Stream-Expires-At`,
      `Upstream-Content-Type`,
    ].join(`, `)

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
      console.error(`Error streaming response for ${streamId}:`, error)
      res.end()
    }
  }
}
