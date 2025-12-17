/**
 * SSE Proxy Protocol - Proxy external SSE sources through durable streams.
 *
 * This protocol provides HTTP endpoints for managing SSE proxy connections.
 * External SSE feeds are consumed and written to durable streams, allowing
 * clients to replay from any offset.
 *
 * Stream structure (per source):
 * - `/sse/:sourceId/events` - JSON events from the proxied SSE source
 *
 * The protocol is stateless - proxy configuration must be provided in the
 * request. Active proxy connections are managed externally (e.g., in a
 * Cloudflare Durable Object or background worker).
 *
 * @example
 * ```typescript
 * import { createDispatcher } from '@durable-streams/protocol'
 * import { createSSEProxyProtocol } from '@durable-streams/protocol/sse-proxy'
 *
 * const app = createDispatcher(config, [
 *   createSSEProxyProtocol()
 * ])
 * ```
 */

import { Hono } from "hono"
import type { Protocol, ProtocolConfig, ProtocolHonoEnv } from "../types"
import { createStreamMiddleware } from "../context"
import { errorHandler, badRequest, notFound } from "../helpers"

/**
 * Options for the SSE proxy protocol.
 */
export interface SSEProxyProtocolOptions {
  /** Namespace prefix (default: "/sse") */
  namespace?: string
}

/**
 * SSE event to write to the stream.
 */
export interface ProxiedSSEEvent {
  /** Event type from SSE */
  event?: string
  /** Event data */
  data: string
  /** Event ID from SSE */
  id?: string
  /** When the event was received */
  timestamp: number
  /** Source URL */
  source: string
}

/**
 * Create an SSE proxy protocol.
 *
 * This protocol provides endpoints for:
 * - Creating/managing proxy source streams
 * - Writing proxied events (called by your proxy worker)
 * - Reading proxied events (with replay support)
 *
 * Note: The actual SSE consumption must be done by an external worker
 * that calls POST /:sourceId/events to write events to the stream.
 *
 * Endpoints:
 * - PUT  /:sourceId        - Create source stream
 * - HEAD /:sourceId/events - Get stream metadata
 * - GET  /:sourceId/events - Read events (supports live modes)
 * - POST /:sourceId/events - Write proxied event (called by proxy worker)
 * - DELETE /:sourceId      - Delete source stream
 */
export function createSSEProxyProtocol(
  options: SSEProxyProtocolOptions = {}
): Protocol {
  const { namespace = `/sse` } = options

  return {
    name: `sse-proxy`,
    namespace,
    createApp(config: ProtocolConfig) {
      const app = new Hono<ProtocolHonoEnv>()

      // Add middleware
      app.use(`*`, createStreamMiddleware(namespace, config))
      app.use(`*`, errorHandler())

      // Create source stream
      app.put(`/:sourceId`, async (c) => {
        const sourceId = c.req.param(`sourceId`)
        const stream = c.var.stream(`${sourceId}/events`)

        const body = await c.req.json<{
          sourceUrl?: string
          description?: string
        }>().catch(() => ({}))

        try {
          await stream.create({
            contentType: `application/json`,
          })

          // Write initial metadata event
          if (body.sourceUrl || body.description) {
            await stream.append({
              _meta: true,
              sourceUrl: body.sourceUrl,
              description: body.description,
              createdAt: Date.now(),
            })
          }

          return c.json({ sourceId, created: true }, 201)
        } catch (error) {
          if (error instanceof Error && error.message.includes(`CONFLICT`)) {
            return c.json({ sourceId, created: false }, 200)
          }
          throw error
        }
      })

      // Delete source stream
      app.delete(`/:sourceId`, async (c) => {
        const sourceId = c.req.param(`sourceId`)
        const stream = c.var.stream(`${sourceId}/events`)

        try {
          await stream.delete()
        } catch {
          // Ignore if not found
        }

        return c.body(null, 204)
      })

      // HEAD - Get stream metadata
      app.head(`/:sourceId/events`, async (c) => {
        const sourceId = c.req.param(`sourceId`)
        const stream = c.var.stream(`${sourceId}/events`)

        try {
          const result = await stream.head()
          c.header(`Stream-Next-Offset`, result.offset ?? ``)
          c.header(`Content-Type`, result.contentType ?? `application/json`)
          if (result.etag) c.header(`ETag`, result.etag)
          return c.body(null, 200)
        } catch (error) {
          if (error instanceof Error && error.message.includes(`NOT_FOUND`)) {
            notFound(`Source not found`)
          }
          throw error
        }
      })

      // POST - Write proxied event (called by proxy worker)
      app.post(`/:sourceId/events`, async (c) => {
        const sourceId = c.req.param(`sourceId`)
        const stream = c.var.stream(`${sourceId}/events`)

        const event = await c.req.json<ProxiedSSEEvent>()

        if (!event.data) {
          badRequest(`Event data required`)
        }

        // Auto-create stream if needed
        try {
          await stream.head()
        } catch (error) {
          if (error instanceof Error && error.message.includes(`NOT_FOUND`)) {
            await stream.create({ contentType: `application/json` })
          } else {
            throw error
          }
        }

        // Add timestamp if not present
        event.timestamp = event.timestamp ?? Date.now()

        await stream.append(event)

        return c.json({ ok: true })
      })

      // GET - Info about reading events
      app.get(`/:sourceId/events`, async (c) => {
        const sourceId = c.req.param(`sourceId`)
        return c.json({
          message: `Use the durable stream client to read events`,
          streamPath: `${namespace}/${sourceId}/events`,
          hint: `GET with ?live=sse for real-time events`,
        })
      })

      return app
    },
  }
}

// Types are exported above at their definitions
