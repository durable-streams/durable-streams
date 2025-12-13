/**
 * SSE Proxy Server
 *
 * A Hono-based server that proxies SSE requests through durable streams.
 */

import { Hono } from "hono"
import { DurableStream } from "@durable-streams/client"
import type {
  ActiveProxyConnection,
  ProxyInitiateRequest,
  ProxyInitiateResponse,
  SSEProxyServerOptions,
} from "./types"

/**
 * Create an SSE proxy server as a Hono app.
 *
 * The server exposes two endpoints:
 * - POST /sse-proxy/initiate - Start proxying an SSE request
 * - DELETE /sse-proxy/abort/:streamPath - Abort a proxied connection
 *
 * @example
 * ```typescript
 * import { serve } from "@hono/node-server"
 * import { createSSEProxyServer } from "@durable-streams/sse-proxy/server"
 *
 * const app = createSSEProxyServer({
 *   streamsUrl: "http://localhost:3001",
 *   streamTTLSeconds: 3600,
 * })
 *
 * serve(app, { port: 3000 })
 * ```
 */
export function createSSEProxyServer(options: SSEProxyServerOptions): Hono {
  const {
    streamsUrl,
    publicStreamsUrl = streamsUrl,
    streamsHeaders = {},
    fetch: baseFetch = globalThis.fetch,
    streamTTLSeconds = 3600,
    onProxyStart,
    onProxyEnd,
  } = options

  // Normalize streams URLs
  const normalizedStreamsUrl = streamsUrl.replace(/\/$/, ``)
  const normalizedPublicStreamsUrl = publicStreamsUrl.replace(/\/$/, ``)

  // Track active proxy connections for abort handling
  const activeConnections = new Map<string, ActiveProxyConnection>()

  const app = new Hono()

  /**
   * Initiate an SSE proxy connection.
   *
   * This endpoint:
   * 1. Creates or reuses a durable stream for the request
   * 2. Starts proxying SSE data from the backend to the stream
   * 3. Returns the stream URL for the client to read from
   */
  app.post(`/sse-proxy/initiate`, async (c) => {
    let body: ProxyInitiateRequest
    try {
      body = await c.req.json<ProxyInitiateRequest>()
    } catch {
      return c.json({ error: `Invalid JSON body` }, 400)
    }

    const { url, method, headers, body: requestBody, streamPath } = body

    if (!url || !streamPath) {
      return c.json({ error: `Missing required fields: url, streamPath` }, 400)
    }

    // Build the stream URLs
    const streamPath_ = `/v1/stream/${streamPath}`
    const fullStreamUrl = `${normalizedStreamsUrl}${streamPath_}`
    const publicStreamUrl = `${normalizedPublicStreamsUrl}${streamPath_}`

    // Call onProxyStart hook if provided
    if (onProxyStart) {
      try {
        await onProxyStart(body)
      } catch (err) {
        return c.json(
          { error: `Proxy start hook failed: ${(err as Error).message}` },
          403
        )
      }
    }

    // Check if there's already an active connection for this stream
    const existing = activeConnections.get(streamPath)
    if (existing) {
      // Stream already exists and is being proxied, just return the URL
      const response: ProxyInitiateResponse = {
        streamUrl: publicStreamUrl,
        streamPath,
        created: false,
        offset: `-1`,
      }
      return c.json(response)
    }

    // Create an AbortController for this connection
    const abortController = new AbortController()

    // Track the connection
    const connection: ActiveProxyConnection = {
      abortController,
      streamPath,
      startedAt: Date.now(),
    }
    activeConnections.set(streamPath, connection)

    // Try to create the stream (it may already exist from a previous session)
    let created = false
    let offset = `-1`

    try {
      // First try to HEAD the stream to check if it exists
      const headResponse = await baseFetch(fullStreamUrl, {
        method: `HEAD`,
        headers: streamsHeaders,
      })

      if (headResponse.status === 404) {
        // Stream doesn't exist, create it
        const durableStream = await DurableStream.create({
          url: fullStreamUrl,
          headers: streamsHeaders,
          contentType: `text/plain`,
          ttlSeconds: streamTTLSeconds,
          fetch: baseFetch,
        })
        created = true

        // Start proxying in the background
        startProxying(
          durableStream,
          url,
          method,
          headers,
          requestBody,
          abortController,
          streamPath,
          activeConnections,
          baseFetch,
          onProxyEnd
        )
      } else if (headResponse.ok) {
        // Stream exists, get the current offset from the response
        const nextOffset = headResponse.headers.get(`stream-next-offset`)
        if (nextOffset) {
          offset = nextOffset
        }

        // Check if there's an active backend connection
        // If not, we may need to restart proxying
        const durableStream = new DurableStream({
          url: fullStreamUrl,
          headers: streamsHeaders,
          contentType: `text/plain`,
          fetch: baseFetch,
        })

        // Start proxying in the background (will resume if the backend supports it)
        startProxying(
          durableStream,
          url,
          method,
          headers,
          requestBody,
          abortController,
          streamPath,
          activeConnections,
          baseFetch,
          onProxyEnd
        )
      } else {
        // Unexpected error
        activeConnections.delete(streamPath)
        return c.json(
          { error: `Failed to check stream: ${headResponse.status}` },
          500
        )
      }
    } catch (err) {
      activeConnections.delete(streamPath)
      return c.json(
        { error: `Failed to initialize stream: ${(err as Error).message}` },
        500
      )
    }

    const response: ProxyInitiateResponse = {
      streamUrl: publicStreamUrl,
      streamPath,
      created,
      offset,
    }

    return c.json(response)
  })

  /**
   * Abort an SSE proxy connection.
   *
   * This aborts the backend SSE connection, which will stop
   * writing to the durable stream.
   */
  app.delete(`/sse-proxy/abort/:streamPath`, async (c) => {
    const streamPath = c.req.param(`streamPath`)

    const connection = activeConnections.get(streamPath)
    if (!connection) {
      return c.json({ error: `No active connection found` }, 404)
    }

    // Abort the backend connection
    connection.abortController.abort()
    activeConnections.delete(streamPath)

    // Call onProxyEnd hook if provided
    if (onProxyEnd) {
      try {
        await onProxyEnd(streamPath)
      } catch {
        // Ignore errors in hook
      }
    }

    return c.json({ success: true })
  })

  /**
   * List active proxy connections (for debugging/monitoring).
   */
  app.get(`/sse-proxy/connections`, (c) => {
    const connections = Array.from(activeConnections.entries()).map(
      ([path, conn]) => ({
        streamPath: path,
        startedAt: conn.startedAt,
        durationMs: Date.now() - conn.startedAt,
      })
    )
    return c.json({ connections })
  })

  return app
}

/**
 * Start proxying SSE data from the backend to the durable stream.
 * This runs in the background and writes each SSE event to the stream.
 */
function startProxying(
  durableStream: DurableStream,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  abortController: AbortController,
  streamPath: string,
  activeConnections: Map<string, ActiveProxyConnection>,
  fetchFn: typeof fetch,
  onProxyEnd?: (streamPath: string, error?: Error) => void | Promise<void>
): void {
  // Run in background - don't await
  void (async () => {
    let error: Error | undefined

    try {
      // Make the SSE request to the backend
      const response = await fetchFn(url, {
        method,
        headers: {
          ...headers,
          Accept: `text/event-stream`,
        },
        body: body || undefined,
        signal: abortController.signal,
      })

      if (!response.ok) {
        throw new Error(
          `Backend returned ${response.status}: ${response.statusText}`
        )
      }

      if (!response.body) {
        throw new Error(`No response body from backend`)
      }

      // Read the SSE stream and write to durable stream
      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      try {
        let result = await reader.read()
        while (!result.done) {
          // Write the raw SSE chunk to the durable stream
          const text = decoder.decode(result.value, { stream: true })
          await durableStream.append(text)
          result = await reader.read()
        }
      } finally {
        reader.releaseLock()
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        // Expected abort, not an error
      } else {
        error = err as Error
        console.error(`SSE proxy error for ${streamPath}:`, err)
      }
    } finally {
      // Clean up
      activeConnections.delete(streamPath)

      // Call onProxyEnd hook
      if (onProxyEnd) {
        try {
          await onProxyEnd(streamPath, error)
        } catch {
          // Ignore errors in hook
        }
      }
    }
  })()
}

// Re-export types
export type { SSEProxyServerOptions, ActiveProxyConnection } from "./types"
