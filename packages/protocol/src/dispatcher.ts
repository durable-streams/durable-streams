/**
 * Protocol dispatcher that creates a Hono app from registered protocols.
 */

import { Hono } from "hono"
import type { Protocol, ProtocolConfig, ProtocolHonoEnv } from "./types"

/**
 * Create a Hono app that routes to multiple protocols.
 *
 * Each protocol is mounted at its namespace prefix. The dispatcher
 * handles routing but protocols must be stateless - they can only
 * rely on information from the request URL.
 *
 * @example
 * ```typescript
 * import { createDispatcher } from '@durable-streams/protocol'
 * import { createYjsProtocol } from '@durable-streams/protocol/yjs'
 *
 * const app = createDispatcher({
 *   baseUrl: 'https://streams.example.com/v1/stream'
 * }, [
 *   createYjsProtocol({ namespace: '/yjs' }),
 *   createStateProtocol({ namespace: '/state' }),
 * ])
 *
 * // Use with any Hono-compatible runtime
 * export default app
 * ```
 */
export function createDispatcher(
  config: ProtocolConfig,
  protocols: Protocol[]
): Hono<ProtocolHonoEnv> {
  const app = new Hono<ProtocolHonoEnv>()

  // Mount each protocol at its namespace
  for (const protocol of protocols) {
    const protocolApp = protocol.createApp(config)
    app.route(protocol.namespace, protocolApp)
  }

  return app
}

/**
 * Mount a protocol onto an existing Hono app.
 */
export function mountProtocol(
  app: Hono<ProtocolHonoEnv>,
  config: ProtocolConfig,
  protocol: Protocol
): void {
  const protocolApp = protocol.createApp(config)
  app.route(protocol.namespace, protocolApp)
}
