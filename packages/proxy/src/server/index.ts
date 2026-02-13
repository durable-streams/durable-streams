/**
 * Durable Proxy Server
 *
 * A proxy server that sits between clients and upstream services,
 * persisting response streams to durable storage for resumability.
 *
 * @packageDocumentation
 */

import { createServer } from "node:http"
import { createProxyHandler } from "./proxy-handler"
import type { Server } from "node:http"
import type { Socket } from "node:net"
import type { ProxyServer, ProxyServerOptions } from "./types"

/**
 * Default port for the proxy server.
 */
export const DEFAULT_PORT = 4440

/**
 * Create and start a durable proxy server.
 *
 * @param options - Server configuration options
 * @returns A running server instance
 *
 * @example
 * ```typescript
 * const server = await createProxyServer({
 *   durableStreamsUrl: 'http://localhost:4437',
 *   jwtSecret: 'your-secret-key',
 *   allowlist: [
 *     'https://api.openai.com/*',
 *     'https://api.anthropic.com/*',
 *   ],
 * })
 *
 * console.log(`Proxy server running at ${server.url}`)
 *
 * // Later...
 * await server.stop()
 * ```
 */
export async function createProxyServer(
  options: ProxyServerOptions
): Promise<ProxyServer> {
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? `localhost`

  // Create the request handler
  const handler = createProxyHandler(options)

  // Create the HTTP server
  const server: Server = createServer(handler)

  // Track active connections for graceful shutdown
  const activeSockets = new Set<Socket>()

  server.on(`connection`, (socket: Socket) => {
    activeSockets.add(socket)
    socket.on(`close`, () => {
      activeSockets.delete(socket)
    })
  })

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.on(`error`, reject)
    server.listen(port, host, () => {
      server.removeListener(`error`, reject)
      resolve()
    })
  })

  const url = `http://${host}:${port}`

  return {
    url,
    stop: async () => {
      // Destroy all active connections (needed for SSE streams that stay open)
      for (const socket of Array.from(activeSockets)) {
        socket.destroy()
      }
      activeSockets.clear()

      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    },
  }
}

// Re-export types
export type {
  ProxyServerOptions,
  ProxyServer,
  UpstreamConnection,
} from "./types"

// Re-export utilities
export {
  generatePreSignedUrl,
  validatePreSignedUrl,
  validateServiceJwt,
  extractBearerToken,
} from "./tokens"
export type { PreSignedUrlResult, ServiceJwtResult } from "./tokens"
export {
  createAllowlistValidator,
  validateUpstreamUrl,
  filterHeadersForUpstream,
  HOP_BY_HOP_HEADERS,
} from "./allowlist"
export { deriveStreamId } from "./derive-stream-id"
export { sendError, sendJson } from "./response"
