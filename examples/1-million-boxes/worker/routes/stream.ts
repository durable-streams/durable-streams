import { Hono } from "hono"
import type { Bindings } from "../index"

export const streamRoutes = new Hono<{ Bindings: Bindings }>()

/**
 * Stream proxy - passthrough to Durable Streams server.
 * Handles both regular requests and SSE connections.
 */
streamRoutes.all(`/game`, async (c) => {
  const upstreamUrl = `${c.env.DURABLE_STREAMS_URL}/game${new URL(c.req.url).search}`

  // Forward request to upstream
  const upstreamResponse = await fetch(upstreamUrl, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body:
      c.req.method !== `GET` && c.req.method !== `HEAD`
        ? c.req.raw.body
        : undefined,
    // @ts-expect-error - duplex needed for streaming
    duplex: `half`,
  })

  // Return streaming response
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  })
})
