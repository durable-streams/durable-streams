import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import { GAME_STREAM_PATH } from "../lib/config"

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
 * Get the full upstream URL for the game stream.
 */
function getUpstreamUrl(queryString?: string): string {
  const baseUrl = `${env.DURABLE_STREAMS_URL}${GAME_STREAM_PATH}`
  return queryString ? `${baseUrl}?${queryString}` : baseUrl
}

/**
 * Proxy GET request to the game stream.
 * This allows clients to read the stream without needing direct access.
 * Returns the stream data as base64 encoded for JSON transport.
 */
export const getGameStream = createServerFn({ method: `GET` }).handler(
  async () => {
    const response = await fetch(getUpstreamUrl(), {
      method: `GET`,
      headers: buildUpstreamHeaders({
        Accept: `application/octet-stream`,
      }),
    })

    if (!response.ok) {
      if (response.status === 404) {
        // Stream doesn't exist yet - return empty
        return {
          ok: true,
          data: ``,
          length: 0,
        }
      }
      return {
        ok: false,
        status: response.status,
        error: `Failed to fetch stream`,
      }
    }

    const arrayBuffer = await response.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)

    // Encode as base64 for JSON transport
    const base64 = btoa(String.fromCharCode(...bytes))

    return {
      ok: true,
      data: base64,
      length: bytes.length,
    }
  }
)

/**
 * Get the SSE URL for clients to connect to.
 * In development, clients connect directly to the stream server.
 * In production, we could proxy through a worker endpoint if needed.
 *
 * Note: For SSE, we return the direct URL since SSE connections
 * need to be established directly by the browser. The auth is
 * handled via a separate mechanism (signed URLs or session tokens).
 */
export const getStreamConfig = createServerFn({ method: `GET` }).handler(() => {
  // For now, return config for direct SSE connection
  // In production with auth, this would return a signed URL or include a session token
  const streamUrl = `${env.DURABLE_STREAMS_URL}${GAME_STREAM_PATH}`

  return {
    streamUrl,
    // If we have auth configured, include it for the client to use
    // Note: In a real production setup, you'd use short-lived tokens
    // or signed URLs rather than exposing the auth token directly
    authRequired: !!env.DURABLE_STREAMS_AUTH,
  }
})

/**
 * Proxy a read request to check stream status (HEAD equivalent).
 */
export const getStreamStatus = createServerFn({ method: `GET` }).handler(
  async () => {
    const response = await fetch(getUpstreamUrl(), {
      method: `HEAD`,
      headers: buildUpstreamHeaders(),
    })

    return {
      ok: response.ok,
      status: response.status,
      exists: response.status !== 404,
    }
  }
)

/**
 * Internal function to proxy SSE connections.
 * This is used by the worker fetch handler for SSE requests.
 */
export async function proxySSERequest(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // Build upstream URL with query params
  const upstreamUrl = getUpstreamUrl(url.search.slice(1))

  // Proxy the SSE request with auth headers
  const upstreamResponse = await fetch(upstreamUrl, {
    method: `GET`,
    headers: buildUpstreamHeaders({
      Accept: `text/event-stream`,
      "Cache-Control": `no-cache`,
    }),
  })

  // Return the SSE response with CORS headers
  const headers = new Headers(upstreamResponse.headers)
  headers.set(`Access-Control-Allow-Origin`, `*`)
  headers.set(`Access-Control-Allow-Methods`, `GET, OPTIONS`)
  headers.set(`Access-Control-Allow-Headers`, `Content-Type, Authorization`)

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  })
}

/**
 * Handle OPTIONS preflight for CORS.
 */
export function handleCORSPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": `*`,
      "Access-Control-Allow-Methods": `GET, HEAD, OPTIONS`,
      "Access-Control-Allow-Headers": `Content-Type, Authorization`,
      "Access-Control-Max-Age": `86400`,
    },
  })
}
