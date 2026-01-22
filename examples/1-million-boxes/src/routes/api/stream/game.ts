/* eslint-disable @typescript-eslint/no-unused-vars */
// The createFileRoute import is added by TanStack Router's code generation
// but is not used in API routes - we use createAPIFileRoute instead
import { createFileRoute } from "@tanstack/react-router"
/* eslint-enable @typescript-eslint/no-unused-vars */
import { createAPIFileRoute } from "@tanstack/react-start/api"
import { env } from "cloudflare:workers"
import { GAME_STREAM_PATH } from "../../../lib/config"

/**
 * Build headers for upstream Durable Streams requests.
 * Adds authentication when DURABLE_STREAMS_AUTH is configured.
 */
function buildUpstreamHeaders(
  additionalHeaders?: Record<string, string>
): HeadersInit {
  const headers: Record<string, string> = {
    ...additionalHeaders,
  }

  // Add auth header if configured (for Electric Cloud)
  if (env.DURABLE_STREAMS_AUTH) {
    headers[`Authorization`] = `Bearer ${env.DURABLE_STREAMS_AUTH}`
  }

  return headers
}

/**
 * API route that proxies requests to the Durable Streams server.
 *
 * This allows:
 * - Adding authentication headers for Electric Cloud
 * - Restricting operations (users can only GET/HEAD, not POST/PUT)
 * - SSE connections through the worker
 *
 * Supported operations:
 * - GET: Read stream data or connect to SSE (with ?live=sse)
 * - HEAD: Check stream status
 * - OPTIONS: CORS preflight
 */
export const Route = createAPIFileRoute(`/api/stream/game`)({
  OPTIONS: () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": `*`,
        "Access-Control-Allow-Methods": `GET, HEAD, OPTIONS`,
        "Access-Control-Allow-Headers": `Content-Type, Accept`,
        "Access-Control-Max-Age": `86400`,
      },
    })
  },

  HEAD: async () => {
    const upstreamUrl = `${env.DURABLE_STREAMS_URL}${GAME_STREAM_PATH}`

    const response = await fetch(upstreamUrl, {
      method: `HEAD`,
      headers: buildUpstreamHeaders(),
    })

    // Forward status with CORS headers
    return new Response(null, {
      status: response.status,
      headers: {
        "Access-Control-Allow-Origin": `*`,
      },
    })
  },

  GET: async ({ request }) => {
    const url = new URL(request.url)
    const queryString = url.search

    // Build upstream URL
    const upstreamUrl = `${env.DURABLE_STREAMS_URL}${GAME_STREAM_PATH}${queryString}`

    // Determine if this is an SSE request
    const isSSE = url.searchParams.get(`live`) === `sse`

    if (isSSE) {
      // Proxy SSE connection
      const upstreamResponse = await fetch(upstreamUrl, {
        method: `GET`,
        headers: buildUpstreamHeaders({
          Accept: `text/event-stream`,
          "Cache-Control": `no-cache`,
        }),
      })

      // Create response headers
      const headers = new Headers()
      headers.set(`Content-Type`, `text/event-stream`)
      headers.set(`Cache-Control`, `no-cache`)
      headers.set(`Connection`, `keep-alive`)
      headers.set(`Access-Control-Allow-Origin`, `*`)

      // Copy any relevant headers from upstream
      const upstreamCursor = upstreamResponse.headers.get(`Stream-Cursor`)
      if (upstreamCursor) {
        headers.set(`Stream-Cursor`, upstreamCursor)
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers,
      })
    }

    // Regular GET request - fetch stream data
    const response = await fetch(upstreamUrl, {
      method: `GET`,
      headers: buildUpstreamHeaders({
        Accept: `application/octet-stream`,
      }),
    })

    // Create response with CORS headers
    const headers = new Headers()
    headers.set(`Access-Control-Allow-Origin`, `*`)

    // Copy content-type and other relevant headers
    const contentType = response.headers.get(`Content-Type`)
    if (contentType) {
      headers.set(`Content-Type`, contentType)
    }

    const streamOffset = response.headers.get(`Stream-Next-Offset`)
    if (streamOffset) {
      headers.set(`Stream-Next-Offset`, streamOffset)
    }

    const streamCursor = response.headers.get(`Stream-Cursor`)
    if (streamCursor) {
      headers.set(`Stream-Cursor`, streamCursor)
    }

    return new Response(response.body, {
      status: response.status,
      headers,
    })
  },
})
