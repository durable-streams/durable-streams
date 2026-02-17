/**
 * Handler for aborting proxy streams.
 *
 * PATCH /v1/proxy/:streamId?action=abort
 *
 * Aborts an in-progress upstream connection. Pre-signed URL authentication only.
 */

import { validatePreSignedUrl } from "./tokens"
import { abortConnections } from "./upstream"
import { sendError } from "./response"
import type { ProxyServerOptions } from "./types"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Handle an abort stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param streamId - The stream ID from the URL path
 * @param options - Proxy server options
 */
export function handleAbortStream(
  req: IncomingMessage,
  res: ServerResponse,
  streamId: string,
  options: ProxyServerOptions
): void {
  const url = new URL(req.url ?? ``, `http://${req.headers.host}`)

  // Authentication: pre-signed URL ONLY (no JWT fallback)
  const expires = url.searchParams.get(`expires`)
  const signature = url.searchParams.get(`signature`)

  if (!expires || !signature) {
    sendError(
      res,
      401,
      `MISSING_SIGNATURE`,
      `Pre-signed URL with expires and signature required`
    )
    return
  }

  const result = validatePreSignedUrl(
    streamId,
    expires,
    signature,
    options.jwtSecret
  )

  if (!result.ok) {
    const code = result.code
    sendError(
      res,
      401,
      code,
      code === `SIGNATURE_EXPIRED`
        ? `Pre-signed URL has expired`
        : `Invalid signature`
    )
    return
  }

  // Validate action parameter
  const action = url.searchParams.get(`action`)
  if (action !== `abort`) {
    sendError(
      res,
      400,
      `INVALID_ACTION`,
      `Query parameter action must be "abort"`
    )
    return
  }

  // Abort all active connections for this stream (idempotent).
  abortConnections(streamId)

  // 204 No Content
  res.writeHead(204)
  res.end()
}
