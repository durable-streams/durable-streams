/**
 * Durable Proxy Server
 *
 * A proxy server that sits between clients and upstream AI services,
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
 *     'https://api.openai.com/**',
 *     'https://api.anthropic.com/**',
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
      for (const socket of activeSockets) {
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
  ControlMessage,
  ControlError,
  UpstreamConnection,
  RequestContext,
  CreateStreamOptions,
  CreateStreamResult,
  ReadTokenPayload,
} from "./types"

// Re-export pre-signed URL utilities (RFC v1.1)
export {
  generatePresignedPath,
  generateSignature,
  validatePresignedUrl,
} from "./presigned-urls"
export type { PresignedUrlResult } from "./presigned-urls"

// Re-export stream ID generation (RFC v1.1)
export { generateStreamId, isValidStreamId } from "./stream-id"

// Re-export JWT utilities (deprecated, kept for backward compatibility)
export {
  generateReadToken,
  validateReadToken,
  extractBearerToken,
  authorizeStreamRequest,
} from "./tokens"
export type { AuthResult } from "./tokens"

// Re-export allowlist utilities
export {
  createAllowlistValidator,
  validateUpstreamUrl,
  filterHeadersForUpstream,
  HOP_BY_HOP_HEADERS,
} from "./allowlist"

// Re-export response utilities
export { sendError, sendJson } from "./response"
