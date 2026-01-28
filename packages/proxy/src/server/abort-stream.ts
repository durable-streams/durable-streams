/**
 * Handler for aborting proxy streams.
 *
 * PATCH /v1/proxy/{service}/{stream_id}?action=abort&expires=...&signature=...
 *
 * Aborts an in-progress upstream connection and marks the stream as aborted.
 * Uses pre-signed URL for authentication.
 */

import { validatePresignedUrl } from "./presigned-urls"
import { abortConnection, getConnection } from "./upstream"
import { sendError } from "./response"
import type { ProxyServerOptions } from "./types"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Handle an abort stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param serviceName - The service name from the URL path
 * @param streamId - The stream ID from the URL path
 * @param options - Proxy server options
 */
export function handleAbortStream(
  req: IncomingMessage,
  res: ServerResponse,
  serviceName: string,
  streamId: string,
  options: ProxyServerOptions
): void {
  const incomingUrl = new URL(req.url ?? ``, `http://${req.headers.host}`)

  // Check action parameter
  const action = incomingUrl.searchParams.get(`action`)
  if (action !== `abort`) {
    sendError(res, 400, `INVALID_ACTION`, `Unknown action: ${action}`)
    return
  }

  // Validate pre-signed URL
  const auth = validatePresignedUrl(
    incomingUrl,
    serviceName,
    streamId,
    options.jwtSecret
  )

  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message)
    return
  }

  // Build stream path for connection lookup
  const streamPath = `/v1/streams/${serviceName}/${streamId}`

  // Check if there's an active connection
  const connection = getConnection(streamPath)

  // Abort is idempotent - always return 204
  if (connection && !connection.completed && !connection.aborted) {
    abortConnection(streamPath)
  }

  // Return 204 No Content (idempotent)
  res.writeHead(204)
  res.end()
}
