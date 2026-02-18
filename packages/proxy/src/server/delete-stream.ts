/**
 * Handler for deleting proxy streams.
 *
 * DELETE /v1/proxy/:streamId
 *
 * Deletes a stream and aborts any in-flight requests. Service JWT authentication.
 */

import { validateServiceJwt } from "./tokens"
import { abortConnection } from "./upstream"
import { buildBackendUrl, resolveBackendHeaders } from "./backend"
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
  const dsUrl = buildBackendUrl(options, streamId)

  try {
    const extra = await resolveBackendHeaders(options, {
      streamId,
      method: `DELETE`,
    })
    const dsResponse = await fetch(dsUrl, { method: `DELETE`, headers: extra })
    if (!dsResponse.ok && dsResponse.status !== 404) {
      console.error(
        `Failed to delete stream ${streamId} from storage: ${dsResponse.status}`
      )
    }
  } catch (error) {
    console.error(`Error deleting stream ${streamId} from storage:`, error)
  }

  // 204 No Content
  res.writeHead(204)
  res.end()
}
