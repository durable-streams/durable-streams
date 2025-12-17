/**
 * @durable-streams/protocol
 *
 * SDK for building protocols and APIs on top of Durable Streams using Hono.
 *
 * @example
 * ```typescript
 * import { createDispatcher, defineProtocol, stream } from '@durable-streams/protocol'
 * import { createYjsProtocol } from '@durable-streams/protocol'
 *
 * // Define a custom protocol
 * const myProtocol = defineProtocol({
 *   name: 'my-protocol',
 *   namespace: '/my',
 *   setup: (app, config) => {
 *     app.post('/docs/:docId', async (c) => {
 *       const docId = c.req.param('docId')
 *       const docStream = stream(c, `docs/${docId}`)
 *       await docStream.append(await c.req.arrayBuffer())
 *       return c.json({ ok: true })
 *     })
 *   }
 * })
 *
 * // Create dispatcher with protocols
 * const app = createDispatcher({
 *   baseUrl: 'https://streams.example.com/v1/stream'
 * }, [
 *   createYjsProtocol(),
 *   myProtocol
 * ])
 *
 * // Use with any Hono-compatible runtime
 * export default app
 * ```
 */

// Re-export Hono types for convenience
export type { Hono, Context, MiddlewareHandler } from "hono"

// Types
export type {
  Protocol,
  ProtocolConfig,
  ProtocolHonoEnv,
  ProtocolEnv,
  CreateStreamOptions,
} from "./types"

// Context utilities
export {
  createStreamMiddleware,
  createProtocolApp,
  getStream,
  getNamespace,
} from "./context"

// Dispatcher
export { createDispatcher, mountProtocol } from "./dispatcher"

// Protocol helpers
export {
  defineProtocol,
  stream,
  HTTPError,
  badRequest,
  notFound,
  conflict,
  serverError,
  errorHandler,
} from "./helpers"

// Example protocols
export {
  createYjsProtocol,
  createSSEProxyProtocol,
  type YjsProtocolOptions,
  type SSEProxyProtocolOptions,
  type ProxiedSSEEvent,
} from "./examples/index"
