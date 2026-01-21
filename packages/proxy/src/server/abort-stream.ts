/**
 * Handler for aborting proxy streams.
 *
 * POST /v1/proxy/{service}/streams/{key}/abort
 *
 * Aborts an in-progress upstream connection and marks the stream as aborted.
 */

import { authorizeStreamRequest } from "./tokens"
import { abortConnection, getConnection } from "./upstream"
import { sendError, sendJson } from "./response"
import type { ProxyServerOptions } from "./types"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Handle an abort stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param serviceName - The service name from the URL path
 * @param streamKey - The stream key from the URL path
 * @param options - Proxy server options
 */
export function handleAbortStream(
  req: IncomingMessage,
  res: ServerResponse,
  serviceName: string,
  streamKey: string,
  options: ProxyServerOptions
): void {
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

  // Check if there's an active connection
  const connection = getConnection(auth.streamPath)

  if (!connection || connection.completed) {
    sendJson(res, 200, { status: `already_completed` })
    return
  }

  if (connection.aborted) {
    sendJson(res, 200, { status: `already_aborted` })
    return
  }

  abortConnection(auth.streamPath)
  sendJson(res, 200, { status: `aborted` })
}
