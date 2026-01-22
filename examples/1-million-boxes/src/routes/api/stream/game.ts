import { createFileRoute } from "@tanstack/react-router"
import { env } from "cloudflare:workers"
import { GAME_STREAM_PATH } from "../../../lib/config"

/**
 * Default Durable Streams URL for development.
 */
const DEFAULT_DURABLE_STREAMS_URL = `http://localhost:4437/v1/stream`

/**
 * Get the Durable Streams URL from environment or use default.
 */
function getDurableStreamsUrl(): string {
  try {
    return env.DURABLE_STREAMS_URL || DEFAULT_DURABLE_STREAMS_URL
  } catch {
    // env might throw if not in Cloudflare Workers context
    return DEFAULT_DURABLE_STREAMS_URL
  }
}

/**
 * Get auth token from environment if available.
 */
function getAuthToken(): string | undefined {
  try {
    return env.DURABLE_STREAMS_AUTH
  } catch {
    return undefined
  }
}

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
  const authToken = getAuthToken()
  if (authToken) {
    headers[`Authorization`] = `Bearer ${authToken}`
  }

  return headers
}

/**
 * Server route that proxies requests to the Durable Streams server.
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
export const Route = createFileRoute(`/api/stream/game`)({
  server: {
    async handler({ request }) {
      const method = request.method
      const url = new URL(request.url)
      const queryString = url.search
      const baseUrl = getDurableStreamsUrl()

      // CORS preflight
      if (method === `OPTIONS`) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": `*`,
            "Access-Control-Allow-Methods": `GET, HEAD, OPTIONS`,
            "Access-Control-Allow-Headers": `Content-Type, Accept`,
            "Access-Control-Max-Age": `86400`,
          },
        })
      }

      // HEAD request
      if (method === `HEAD`) {
        const upstreamUrl = `${baseUrl}${GAME_STREAM_PATH}`
        const response = await fetch(upstreamUrl, {
          method: `HEAD`,
          headers: buildUpstreamHeaders(),
        })
        return new Response(null, {
          status: response.status,
          headers: { "Access-Control-Allow-Origin": `*` },
        })
      }

      // GET request
      if (method === `GET`) {
        const upstreamUrl = `${baseUrl}${GAME_STREAM_PATH}${queryString}`
        const isSSE = url.searchParams.get(`live`) === `sse`

        if (isSSE) {
          // Proxy SSE connection
          let upstreamResponse = await fetch(upstreamUrl, {
            method: `GET`,
            headers: buildUpstreamHeaders({
              Accept: `text/event-stream`,
              "Cache-Control": `no-cache`,
            }),
          })

          // If stream doesn't exist, create it first
          if (upstreamResponse.status === 404) {
            const createUrl = `${baseUrl}${GAME_STREAM_PATH}`
            const createResponse = await fetch(createUrl, {
              method: `PUT`,
              headers: buildUpstreamHeaders({
                "Content-Type": `application/octet-stream`,
              }),
            })

            if (createResponse.ok) {
              upstreamResponse = await fetch(upstreamUrl, {
                method: `GET`,
                headers: buildUpstreamHeaders({
                  Accept: `text/event-stream`,
                  "Cache-Control": `no-cache`,
                }),
              })
            }
          }

          const headers = new Headers()
          headers.set(`Content-Type`, `text/event-stream`)
          headers.set(`Cache-Control`, `no-cache`)
          headers.set(`Connection`, `keep-alive`)
          headers.set(`Access-Control-Allow-Origin`, `*`)

          // Forward protocol headers
          for (const h of [
            `Stream-Offset`,
            `Stream-Cursor`,
            `Stream-Up-To-Date`,
          ]) {
            const value = upstreamResponse.headers.get(h)
            if (value) headers.set(h, value)
          }

          return new Response(upstreamResponse.body, {
            status: upstreamResponse.status,
            headers,
          })
        }

        // Regular GET - fetch stream data
        let response = await fetch(upstreamUrl, {
          method: `GET`,
          headers: buildUpstreamHeaders({
            Accept: `application/octet-stream`,
          }),
        })

        // Create stream if it doesn't exist
        if (response.status === 404) {
          const createUrl = `${baseUrl}${GAME_STREAM_PATH}`
          const createResponse = await fetch(createUrl, {
            method: `PUT`,
            headers: buildUpstreamHeaders({
              "Content-Type": `application/octet-stream`,
            }),
          })

          if (createResponse.ok) {
            response = await fetch(upstreamUrl, {
              method: `GET`,
              headers: buildUpstreamHeaders({
                Accept: `application/octet-stream`,
              }),
            })
          }
        }

        const headers = new Headers()
        headers.set(`Access-Control-Allow-Origin`, `*`)

        // Forward headers
        for (const h of [
          `Content-Type`,
          `Stream-Offset`,
          `Stream-Cursor`,
          `Stream-Up-To-Date`,
        ]) {
          const value = response.headers.get(h)
          if (value) headers.set(h, value)
        }

        return new Response(response.body, {
          status: response.status,
          headers,
        })
      }

      // Method not allowed
      return new Response(`Method not allowed`, { status: 405 })
    },
  },
})
