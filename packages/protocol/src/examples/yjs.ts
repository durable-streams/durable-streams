/**
 * Yjs Protocol - Collaborative document synchronization via durable streams.
 *
 * This protocol provides HTTP endpoints for Yjs document synchronization.
 * Documents are stored as streams of binary Yjs updates.
 *
 * Stream structure (per document):
 * - `/yjs/docs/:docId/updates` - Binary Yjs updates stream
 * - `/yjs/docs/:docId/awareness` - JSON awareness/presence updates
 *
 * The protocol is stateless - all document state is derived from the stream URL.
 *
 * @example
 * ```typescript
 * import { createDispatcher } from '@durable-streams/protocol'
 * import { createYjsProtocol } from '@durable-streams/protocol/yjs'
 *
 * const app = createDispatcher(config, [
 *   createYjsProtocol()
 * ])
 * ```
 */

import { Hono } from "hono"
import type { Protocol, ProtocolConfig, ProtocolHonoEnv } from "../types"
import { createStreamMiddleware } from "../context"
import { errorHandler, notFound, badRequest } from "../helpers"

/**
 * Options for the Yjs protocol.
 */
export interface YjsProtocolOptions {
  /** Namespace prefix (default: "/yjs") */
  namespace?: string

  /** TTL for awareness streams in seconds (default: 300 = 5 minutes) */
  awarenessTTL?: number
}

/**
 * Create a Yjs protocol for document synchronization.
 *
 * Endpoints:
 * - PUT  /docs/:docId         - Create/ensure document exists
 * - HEAD /docs/:docId/updates - Get document metadata
 * - GET  /docs/:docId/updates - Read updates (supports live modes)
 * - POST /docs/:docId/updates - Append Yjs update
 * - DELETE /docs/:docId       - Delete document
 *
 * - GET  /docs/:docId/awareness - Read awareness updates
 * - POST /docs/:docId/awareness - Publish awareness update
 */
export function createYjsProtocol(options: YjsProtocolOptions = {}): Protocol {
  const { namespace = `/yjs`, awarenessTTL = 300 } = options

  return {
    name: `yjs`,
    namespace,
    createApp(config: ProtocolConfig) {
      const app = new Hono<ProtocolHonoEnv>()

      // Add middleware
      app.use(`*`, createStreamMiddleware(namespace, config))
      app.use(`*`, errorHandler())

      // ========================================
      // Document operations
      // ========================================

      // Create document (idempotent)
      app.put(`/docs/:docId`, async (c) => {
        const docId = c.req.param(`docId`)
        const stream = c.var.stream(`docs/${docId}/updates`)

        try {
          await stream.create({
            contentType: `application/octet-stream`,
          })
          return c.json({ docId, created: true }, 201)
        } catch (error) {
          // If stream already exists, that's fine (idempotent)
          if (error instanceof Error && error.message.includes(`CONFLICT`)) {
            return c.json({ docId, created: false }, 200)
          }
          throw error
        }
      })

      // Delete document
      app.delete(`/docs/:docId`, async (c) => {
        const docId = c.req.param(`docId`)

        // Delete updates stream
        const updatesStream = c.var.stream(`docs/${docId}/updates`)
        try {
          await updatesStream.delete()
        } catch {
          // Ignore if not found
        }

        // Delete awareness stream
        const awarenessStream = c.var.stream(`docs/${docId}/awareness`)
        try {
          await awarenessStream.delete()
        } catch {
          // Ignore if not found
        }

        return c.body(null, 204)
      })

      // ========================================
      // Updates stream - passthrough to underlying stream
      // These just proxy to the underlying durable stream
      // ========================================

      // HEAD /docs/:docId/updates - Get metadata
      app.head(`/docs/:docId/updates`, async (c) => {
        const docId = c.req.param(`docId`)
        const stream = c.var.stream(`docs/${docId}/updates`)

        try {
          const result = await stream.head()
          c.header(`Stream-Next-Offset`, result.offset ?? ``)
          c.header(`Content-Type`, result.contentType ?? `application/octet-stream`)
          if (result.etag) c.header(`ETag`, result.etag)
          return c.body(null, 200)
        } catch (error) {
          if (error instanceof Error && error.message.includes(`NOT_FOUND`)) {
            notFound(`Document not found`)
          }
          throw error
        }
      })

      // POST /docs/:docId/updates - Append update
      app.post(`/docs/:docId/updates`, async (c) => {
        const docId = c.req.param(`docId`)
        const stream = c.var.stream(`docs/${docId}/updates`)

        const body = await c.req.arrayBuffer()
        if (!body || body.byteLength === 0) {
          badRequest(`Update body required`)
        }

        // Auto-create document if needed
        try {
          await stream.head()
        } catch (error) {
          if (error instanceof Error && error.message.includes(`NOT_FOUND`)) {
            await stream.create({ contentType: `application/octet-stream` })
          } else {
            throw error
          }
        }

        await stream.append(new Uint8Array(body))

        return c.json({ ok: true })
      })

      // GET /docs/:docId/updates - Read updates (passthrough)
      // This route exists to document the endpoint, but actual
      // reads should go directly to the underlying stream for
      // proper SSE/long-poll support
      app.get(`/docs/:docId/updates`, async (c) => {
        // Return info about how to read
        const docId = c.req.param(`docId`)
        return c.json({
          message: `Use the durable stream client to read updates`,
          streamPath: `${namespace}/docs/${docId}/updates`,
          hint: `GET with ?live=sse or ?live=long-poll for real-time updates`,
        })
      })

      // ========================================
      // Awareness stream - presence/cursors
      // ========================================

      // POST /docs/:docId/awareness - Publish awareness state
      app.post(`/docs/:docId/awareness`, async (c) => {
        const docId = c.req.param(`docId`)
        const stream = c.var.stream(`docs/${docId}/awareness`)

        const body = await c.req.json<{
          clientId: string | number
          state: Record<string, unknown> | null
        }>()

        if (!body.clientId) {
          badRequest(`clientId required`)
        }

        // Auto-create awareness stream with TTL
        try {
          await stream.head()
        } catch (error) {
          if (error instanceof Error && error.message.includes(`NOT_FOUND`)) {
            await stream.create({
              contentType: `application/json`,
              ttlSeconds: awarenessTTL,
            })
          } else {
            throw error
          }
        }

        await stream.append({
          clientId: body.clientId,
          state: body.state,
          timestamp: Date.now(),
        })

        return c.json({ ok: true })
      })

      // GET /docs/:docId/awareness - Read awareness (passthrough info)
      app.get(`/docs/:docId/awareness`, async (c) => {
        const docId = c.req.param(`docId`)
        return c.json({
          message: `Use the durable stream client to read awareness`,
          streamPath: `${namespace}/docs/${docId}/awareness`,
          hint: `GET with ?live=sse for real-time presence updates`,
        })
      })

      return app
    },
  }
}

// Types are exported above at their definitions
