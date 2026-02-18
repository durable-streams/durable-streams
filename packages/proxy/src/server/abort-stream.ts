/**
 * Handler for aborting proxy streams.
 *
 * PATCH /v1/proxy/:streamId?action=abort
 *
 * Aborts one or more in-progress upstream connections.
 */

import { validatePreSignedUrl, validateServiceJwt } from "./tokens"
import { abortConnectionByResponseId, abortConnections } from "./upstream"
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

  // Authentication: pre-signed URL or service JWT fallback.
  const expires = url.searchParams.get(`expires`)
  const signature = url.searchParams.get(`signature`)

  if (expires && signature) {
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
  } else {
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

  const response = url.searchParams.get(`response`)
  if (response) {
    const responseId = parseInt(response, 10)
    if (Number.isNaN(responseId) || responseId < 1) {
      sendError(
        res,
        400,
        `INVALID_ACTION`,
        `response query parameter must be a positive integer`
      )
      return
    }
    abortConnectionByResponseId(streamId, responseId)
  } else {
    // Abort all active connections for this stream (idempotent).
    abortConnections(streamId)
  }

  // 204 No Content
  res.writeHead(204)
  res.end()
}
