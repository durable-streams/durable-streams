/**
 * Handler for creating proxy streams.
 *
 * POST /v1/proxy/{service}?stream_key=...&upstream=...
 *
 * Creates a new durable stream and begins proxying the upstream response.
 */

import { generateReadToken } from "./tokens"
import { filterHeadersForUpstream, validateUpstreamUrl } from "./allowlist"
import {
  registerConnection,
  streamUpstreamToStorage,
  unregisterConnection,
} from "./upstream"
import { sendError } from "./response"
import type { CreateStreamResponse, ProxyServerOptions } from "./types"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Handle a create stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param serviceName - The service name from the URL path
 * @param options - Proxy server options
 * @param isAllowed - Function to validate upstream URLs
 */
export async function handleCreateStream(
  req: IncomingMessage,
  res: ServerResponse,
  serviceName: string,
  options: ProxyServerOptions,
  isAllowed: (url: string) => boolean
): Promise<void> {
  const url = new URL(req.url ?? ``, `http://${req.headers.host}`)

  // Extract query parameters
  const streamKey = url.searchParams.get(`stream_key`)
  const upstream = url.searchParams.get(`upstream`)

  // Validate required parameters
  if (!streamKey) {
    sendError(
      res,
      400,
      `MISSING_STREAM_KEY`,
      `stream_key query parameter is required`
    )
    return
  }

  if (!upstream) {
    sendError(
      res,
      400,
      `MISSING_UPSTREAM`,
      `upstream query parameter is required`
    )
    return
  }

  // Validate upstream URL
  const upstreamUrl = validateUpstreamUrl(upstream)
  if (!upstreamUrl) {
    sendError(res, 400, `INVALID_UPSTREAM`, `upstream is not a valid URL`)
    return
  }

  // Check allowlist
  if (!isAllowed(upstream)) {
    sendError(
      res,
      403,
      `UPSTREAM_NOT_ALLOWED`,
      `upstream URL is not in the allowlist`
    )
    return
  }

  // Build the durable stream path
  const streamPath = `/v1/streams/${serviceName}/${streamKey}`
  const fullStreamUrl = new URL(streamPath, options.durableStreamsUrl)

  // Collect request body
  const bodyChunks: Array<Buffer> = []
  for await (const chunk of req) {
    bodyChunks.push(chunk as Buffer)
  }
  const body = Buffer.concat(bodyChunks)

  // Filter headers for upstream
  const headers = filterHeadersForUpstream(
    req.headers as Record<string, string | Array<string> | undefined>
  )

  // Determine content type for the stream (from upstream response, default to text/event-stream for AI)
  const contentType = `text/event-stream`

  try {
    // Create the durable stream first
    const createResponse = await fetch(fullStreamUrl.toString(), {
      method: `PUT`,
      headers: {
        "Content-Type": contentType,
        "Stream-TTL": String(options.streamTtlSeconds ?? 86400),
      },
    })

    // Check response status:
    // - 201: New stream created
    // - 200: Stream already exists (idempotent PUT)
    // - 409: Stream exists with different config
    if (createResponse.status === 200) {
      // Stream already exists - treat as conflict for the proxy
      sendError(
        res,
        409,
        `STREAM_EXISTS`,
        `A stream with this key already exists`
      )
      return
    }

    if (createResponse.status === 409) {
      sendError(
        res,
        409,
        `STREAM_EXISTS`,
        `A stream with this key already exists with different configuration`
      )
      return
    }

    if (!createResponse.ok) {
      const errorText = await createResponse.text().catch(() => ``)
      sendError(
        res,
        502,
        `STORAGE_ERROR`,
        `Failed to create stream: ${errorText}`
      )
      return
    }

    // Generate read token
    const readToken = generateReadToken(
      streamPath,
      options.jwtSecret,
      options.streamTtlSeconds ?? 86400
    )

    // Set up the upstream connection
    const abortController = new AbortController()
    registerConnection(streamPath, {
      abortController,
      streamKey,
      startedAt: Date.now(),
      currentOffset: ``,
      completed: false,
      aborted: false,
    })

    // Start streaming upstream to storage (non-blocking)
    streamUpstreamToStorage({
      upstreamUrl: upstream,
      method: req.method ?? `POST`,
      headers,
      body: body.length > 0 ? body : undefined,
      durableStreamsUrl: options.durableStreamsUrl,
      streamPath,
      contentType,
      idleTimeoutMs: options.idleTimeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      signal: abortController.signal,
      onComplete: () => {
        unregisterConnection(streamPath)
      },
      onError: () => {
        unregisterConnection(streamPath)
      },
    }).catch(() => {
      unregisterConnection(streamPath)
    })

    // Return the stream path and read token immediately
    const response: CreateStreamResponse = {
      path: streamPath,
      readToken,
    }

    res.writeHead(201, {
      "Content-Type": `application/json`,
      "Durable-Streams-Path": streamPath,
      "Durable-Streams-Read-Token": readToken,
    })
    res.end(JSON.stringify(response))
  } catch (error) {
    const message = error instanceof Error ? error.message : `Unknown error`
    sendError(res, 500, `INTERNAL_ERROR`, message)
  }
}
