/**
 * Response utilities for the proxy server.
 */

import type { ServerResponse } from "node:http"

/**
 * Send a JSON error response.
 */
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  res.writeHead(status, { "Content-Type": `application/json` })
  res.end(JSON.stringify({ error: { code, message } }))
}

/**
 * Send a JSON success response.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  headers?: Record<string, string>
): void {
  res.writeHead(status, {
    "Content-Type": `application/json`,
    ...headers,
  })
  res.end(JSON.stringify(data))
}

/**
 * Send a structured error response for expired URLs.
 *
 * This response includes `renewable` to indicate whether the URL
 * can be renewed (HMAC was valid but expired) and `streamId` for
 * the client to use in renewal requests.
 */
export function sendExpiredUrlError(
  res: ServerResponse,
  code: string,
  message: string,
  renewable: boolean,
  streamId: string
): void {
  res.writeHead(401, { "Content-Type": `application/json` })
  res.end(JSON.stringify({ error: code, message, renewable, streamId }))
}
