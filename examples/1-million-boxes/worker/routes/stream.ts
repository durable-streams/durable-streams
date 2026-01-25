import { Hono } from "hono"
import { DurableStream } from "@durable-streams/client"
import { GAME_STREAM_PATH } from "../lib/config"
import { encodeHeader } from "../../shared/stream-parser"
import type { Bindings } from "../index"

export const streamRoutes = new Hono<{ Bindings: Bindings }>()

/**
 * Create the game stream directly (fallback for dev when DO is unavailable).
 */
async function createStreamDirectly(
  streamUrl: string,
  auth?: string
): Promise<boolean> {
  try {
    // Build URL with auth if configured
    const url = new URL(`${streamUrl}${GAME_STREAM_PATH}`)
    if (auth) {
      url.searchParams.set(`secret`, auth)
    }
    const stream = new DurableStream({
      url: url.toString(),
      contentType: `application/octet-stream`,
    })
    await stream.create()
    // Write the header with game start timestamp
    const header = encodeHeader(Date.now())
    await stream.append(header)
    return true
  } catch (err) {
    console.error(`Failed to create stream directly:`, err)
    return false
  }
}

/**
 * Ensure the game stream exists, creating it if necessary.
 * Uses GameWriterDO in production, falls back to direct creation in dev.
 */
async function ensureStreamExists(c: { env: Bindings }): Promise<boolean> {
  // Try to use the DO first (works in production)
  try {
    if (c.env.GAME_WRITER) {
      const id = c.env.GAME_WRITER.idFromName(`game`)
      const stub = c.env.GAME_WRITER.get(id)

      const response = await stub.fetch(`http://do/init`, {
        method: `POST`,
      })

      if (response.ok) {
        return true
      }
    }
  } catch (err) {
    console.warn(`DO init failed, trying direct stream creation:`, err)
  }

  // Fallback: create stream directly (development mode)
  return createStreamDirectly(
    c.env.DURABLE_STREAMS_URL,
    c.env.DURABLE_STREAMS_AUTH
  )
}

/**
 * Build upstream URL with auth secret if configured.
 */
function buildUpstreamUrl(
  baseUrl: string,
  path: string,
  search: string,
  auth?: string
): string {
  const url = new URL(`${baseUrl}${path}`)
  // Preserve original query params
  const originalParams = new URLSearchParams(search.replace(/^\?/, ``))
  originalParams.forEach((value, key) => url.searchParams.set(key, value))
  // Add auth secret if configured
  if (auth) {
    url.searchParams.set(`secret`, auth)
  }
  return url.toString()
}

/**
 * Stream proxy - passthrough to Durable Streams server.
 * Handles both regular requests and SSE connections.
 * If the stream doesn't exist (404), creates it via GameWriterDO and retries.
 */
streamRoutes.all(`/game`, async (c) => {
  const upstreamUrl = buildUpstreamUrl(
    c.env.DURABLE_STREAMS_URL,
    GAME_STREAM_PATH,
    new URL(c.req.url).search,
    c.env.DURABLE_STREAMS_AUTH
  )

  // Forward request to upstream
  let upstreamResponse = await fetch(upstreamUrl, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body:
      c.req.method !== `GET` && c.req.method !== `HEAD`
        ? c.req.raw.body
        : undefined,
    // @ts-expect-error - duplex needed for streaming
    duplex: `half`,
  })

  // If stream doesn't exist, create it and retry
  if (upstreamResponse.status === 404) {
    console.log(`[stream-proxy] Stream not found, creating...`)
    const created = await ensureStreamExists(c)
    if (created) {
      console.log(`[stream-proxy] Stream created, retrying request...`)
      // Retry the request (need to rebuild since body was consumed)
      upstreamResponse = await fetch(upstreamUrl, {
        method: c.req.method,
        headers: c.req.raw.headers,
        // Note: can't resend body for non-GET requests, but reads don't have body
      })
    }
  }

  // Return streaming response
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  })
})
