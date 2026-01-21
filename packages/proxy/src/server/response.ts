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
