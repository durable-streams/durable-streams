/**
 * Handler for deleting proxy streams.
 *
 * DELETE /v1/proxy/:streamId
 *
 * Deletes a stream and aborts any in-flight requests. Service JWT authentication.
 */

import { validateServiceJwt } from "./tokens"
import { abortConnection } from "./upstream"
import { sendError } from "./response"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ProxyServerOptions } from "./types"

/**
 * Handle a delete stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param streamId - The stream ID from the URL path
 * @param options - Proxy server options
 * @param contentTypeStore - Map of stream IDs to upstream content types
 */
export async function handleDeleteStream(
  req: IncomingMessage,
  res: ServerResponse,
  streamId: string,
  options: ProxyServerOptions,
  contentTypeStore: Map<string, string>
): Promise<void> {
  const url = new URL(req.url ?? ``, `http://${req.headers.host}`)

  // Authentication: service JWT required
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

  // 1. Abort any in-flight upstream request
  abortConnection(streamId)

  // 2. Clean up content type store
  contentTypeStore.delete(streamId)

  // 3. Delete from underlying durable streams server
  const dsUrl = new URL(`/v1/streams/${streamId}`, options.durableStreamsUrl)

  try {
    await fetch(dsUrl.toString(), { method: `DELETE` })
    // Ignore errors - idempotent (stream may not exist)
  } catch {
    // Ignore errors - idempotent
  }

  // 204 No Content
  res.writeHead(204)
  res.end()
}
