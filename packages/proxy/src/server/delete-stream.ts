/**
 * Handler for deleting proxy streams.
 *
 * DELETE /v1/proxy/{service}/{stream_id}
 * Authorization: Bearer {serviceToken}
 *
 * Deletes a stream from durable storage. Requires service token authentication.
 */

import { extractBearerToken } from "./tokens"
import { sendError } from "./response"
import type { ProxyServerOptions } from "./types"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Handle a delete stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param serviceName - The service name from the URL path
 * @param streamId - The stream ID from the URL path
 * @param options - Proxy server options
 */
export async function handleDeleteStream(
  req: IncomingMessage,
  res: ServerResponse,
  serviceName: string,
  streamId: string,
  options: ProxyServerOptions
): Promise<void> {
  // Validate service token
  const token = extractBearerToken(req.headers.authorization)

  if (!token) {
    sendError(
      res,
      401,
      `MISSING_TOKEN`,
      `Authorization header with Bearer token required`
    )
    return
  }

  // Check if service token is configured
  if (!options.serviceToken) {
    sendError(
      res,
      500,
      `SERVICE_TOKEN_NOT_CONFIGURED`,
      `Service token is not configured for this proxy`
    )
    return
  }

  // Validate the token
  if (token !== options.serviceToken) {
    sendError(res, 401, `INVALID_TOKEN`, `Invalid service token`)
    return
  }

  // Build the durable streams URL
  const streamPath = `/v1/streams/${serviceName}/${streamId}`
  const dsUrl = new URL(streamPath, options.durableStreamsUrl)

  try {
    // Delete the stream from durable storage
    const dsResponse = await fetch(dsUrl.toString(), {
      method: `DELETE`,
    })

    if (dsResponse.status === 404) {
      sendError(res, 404, `STREAM_NOT_FOUND`, `Stream not found`)
      return
    }

    if (!dsResponse.ok) {
      const errorText = await dsResponse.text().catch(() => ``)
      sendError(
        res,
        502,
        `STORAGE_ERROR`,
        `Failed to delete stream: ${errorText}`
      )
      return
    }

    // Return 204 No Content
    res.writeHead(204)
    res.end()
  } catch (error) {
    const message = error instanceof Error ? error.message : `Unknown error`
    sendError(res, 500, `INTERNAL_ERROR`, message)
  }
}
