/**
 * Handler for creating proxy streams.
 *
 * POST /v1/proxy/{service}
 *
 * Headers:
 *   Upstream-URL: https://api.openai.com/v1/chat/completions
 *   Upstream-Authorization: Bearer sk-... (optional, forwarded as Authorization to upstream)
 *   Upstream-Method: POST (optional, defaults to POST)
 *
 * Creates a new durable stream, forwards request to upstream, and returns
 * a pre-signed URL for reading the stream.
 */

import { generatePresignedPath } from "./presigned-urls"
import { generateStreamId } from "./stream-id"
import {
  filterHeadersForUpstream,
  isValidPathSegment,
  validateUpstreamUrl,
} from "./allowlist"
import { registerConnection, unregisterConnection } from "./upstream"
import { sendError } from "./response"
import type { ProxyServerOptions } from "./types"
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
  // Validate service name (from URL path)
  if (!isValidPathSegment(serviceName)) {
    sendError(
      res,
      400,
      `INVALID_SERVICE_NAME`,
      `service name contains invalid characters`
    )
    return
  }

  // Extract upstream configuration from headers
  const upstreamUrl = req.headers[`upstream-url`]
  const upstreamMethod = req.headers[`upstream-method`] ?? `POST`
  const upstreamAuth = req.headers[`upstream-authorization`]

  // Validate required headers
  if (!upstreamUrl || typeof upstreamUrl !== `string`) {
    sendError(
      res,
      400,
      `MISSING_UPSTREAM_URL`,
      `Upstream-URL header is required`
    )
    return
  }

  if (typeof upstreamMethod !== `string`) {
    sendError(
      res,
      400,
      `INVALID_UPSTREAM_METHOD`,
      `Upstream-Method header must be a string`
    )
    return
  }

  // Validate upstream URL format
  const validatedUpstreamUrl = validateUpstreamUrl(upstreamUrl)
  if (!validatedUpstreamUrl) {
    sendError(res, 400, `INVALID_UPSTREAM`, `Upstream-URL is not a valid URL`)
    return
  }

  // Check allowlist
  if (!isAllowed(upstreamUrl)) {
    sendError(
      res,
      403,
      `UPSTREAM_NOT_ALLOWED`,
      `Upstream URL is not in the allowlist`
    )
    return
  }

  // Generate stream ID (UUIDv7)
  const streamId = generateStreamId()

  // Build the durable stream path
  const streamPath = `/v1/streams/${serviceName}/${streamId}`
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

  // Add upstream authorization if provided
  if (upstreamAuth && typeof upstreamAuth === `string`) {
    headers[`Authorization`] = upstreamAuth
  }

  try {
    // Make upstream request first to get response headers
    // This blocks until we receive headers from upstream
    let requestBody: BodyInit | undefined
    if (body.length > 0) {
      requestBody = new Uint8Array(body) as unknown as BodyInit
    }

    const abortController = new AbortController()

    const upstreamResponse = await fetch(upstreamUrl, {
      method: upstreamMethod.toUpperCase(),
      headers,
      body: requestBody,
      signal: abortController.signal,
      redirect: `manual`,
    })

    // Block redirects to prevent SSRF bypass
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      sendError(
        res,
        400,
        `REDIRECT_NOT_ALLOWED`,
        `Upstream redirects are not allowed`
      )
      return
    }

    // Check for upstream errors
    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text().catch(() => ``)
      res.writeHead(502, {
        "Content-Type": `application/json`,
        "Upstream-Status": String(upstreamResponse.status),
      })
      res.end(
        JSON.stringify({
          error: {
            code: `UPSTREAM_ERROR`,
            message: errorBody.slice(0, 500),
          },
        })
      )
      return
    }

    // Get upstream content type
    const upstreamContentType =
      upstreamResponse.headers.get(`content-type`) ?? `text/event-stream`

    // Create the durable stream
    const createResponse = await fetch(fullStreamUrl.toString(), {
      method: `PUT`,
      headers: {
        "Content-Type": upstreamContentType,
        "Stream-TTL": String(options.streamTtlSeconds ?? 86400),
      },
    })

    if (!createResponse.ok && createResponse.status !== 200) {
      const errorText = await createResponse.text().catch(() => ``)
      sendError(
        res,
        502,
        `STORAGE_ERROR`,
        `Failed to create stream: ${errorText}`
      )
      // Abort the upstream connection since we couldn't create the stream
      abortController.abort()
      return
    }

    // Generate pre-signed URL for the Location header
    const proxyPath = `/v1/proxy/${serviceName}/${streamId}`
    const locationPath = generatePresignedPath(
      proxyPath,
      serviceName,
      streamId,
      options.jwtSecret,
      options.streamTtlSeconds ?? 86400
    )

    // Register the upstream connection for abort tracking
    registerConnection(streamPath, {
      abortController,
      streamId,
      startedAt: Date.now(),
      currentOffset: ``,
      completed: false,
      aborted: false,
    })

    // Start streaming upstream body to storage (non-blocking)
    // We already have the response, now we just need to pipe the body
    const reader = upstreamResponse.body?.getReader()
    if (reader) {
      ;(async () => {
        try {
          await pipeReaderToStorage({
            reader,
            durableStreamsUrl: options.durableStreamsUrl,
            streamPath,
            contentType: upstreamContentType,
            idleTimeoutMs: options.idleTimeoutMs,
            maxResponseBytes: options.maxResponseBytes,
            signal: abortController.signal,
          })
        } finally {
          unregisterConnection(streamPath)
        }
      })()
    } else {
      // No body to stream, complete immediately
      unregisterConnection(streamPath)
    }

    // Return 201 with Location header containing pre-signed URL
    res.writeHead(201, {
      Location: locationPath,
      "Upstream-Content-Type": upstreamContentType,
      "Access-Control-Expose-Headers": `Location, Upstream-Content-Type`,
    })
    res.end()
  } catch (error) {
    const message = error instanceof Error ? error.message : `Unknown error`
    sendError(res, 500, `INTERNAL_ERROR`, message)
  }
}

/**
 * Options for piping a reader to storage.
 */
interface PipeReaderOptions {
  reader: ReadableStreamDefaultReader<Uint8Array>
  durableStreamsUrl: string
  streamPath: string
  contentType: string
  idleTimeoutMs?: number
  maxResponseBytes?: number
  signal: AbortSignal
}

/**
 * Pipe a reader to durable storage.
 */
async function pipeReaderToStorage(options: PipeReaderOptions): Promise<void> {
  const {
    reader,
    durableStreamsUrl,
    streamPath,
    contentType,
    idleTimeoutMs = 300000,
    maxResponseBytes = 100 * 1024 * 1024,
    signal,
  } = options

  let totalBytes = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  // Using object wrapper to avoid ESLint no-unnecessary-condition with closure mutation
  const state = { idleTimedOut: false }

  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
    }
    idleTimer = setTimeout(() => {
      state.idleTimedOut = true
      reader.cancel(`Idle timeout exceeded`).catch(() => {})
    }, idleTimeoutMs)
  }

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  try {
    resetIdleTimer()

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      if (signal.aborted) {
        reader.cancel()
        break
      }

      totalBytes += value.length
      if (totalBytes > maxResponseBytes) {
        reader.cancel()
        await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
          type: `close`,
          reason: `error`,
          error: {
            code: `RESPONSE_TOO_LARGE`,
            message: `Response exceeded ${maxResponseBytes} bytes`,
          },
        })
        return
      }

      resetIdleTimer()

      await appendToStream(durableStreamsUrl, streamPath, contentType, value)
    }

    clearIdleTimer()

    if (signal.aborted) {
      await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
        type: `close`,
        reason: `aborted`,
      })
    } else if (state.idleTimedOut) {
      await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
        type: `close`,
        reason: `error`,
        error: { code: `IDLE_TIMEOUT`, message: `Idle timeout exceeded` },
      })
    } else {
      await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
        type: `close`,
        reason: `complete`,
      })
    }
  } catch (error) {
    clearIdleTimer()

    if (signal.aborted) {
      await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
        type: `close`,
        reason: `aborted`,
      }).catch(() => {})
    } else {
      const message =
        error instanceof Error ? error.message : `Unknown upstream error`
      await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
        type: `close`,
        reason: `error`,
        error: { code: `UPSTREAM_ERROR`, message },
      }).catch(() => {})
    }
  }
}

/**
 * Append data to a durable stream.
 */
async function appendToStream(
  baseUrl: string,
  path: string,
  contentType: string,
  data: Uint8Array
): Promise<string> {
  const url = new URL(path, baseUrl)

  const response = await fetch(url, {
    method: `POST`,
    headers: {
      "Content-Type": contentType,
    },
    body: data as unknown as BodyInit,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => ``)
    throw new Error(
      `Failed to append to stream: ${response.status} ${errorText}`
    )
  }

  return response.headers.get(`Stream-Next-Offset`) ?? ``
}

/**
 * Append a control message to a durable stream.
 */
async function appendControlMessage(
  baseUrl: string,
  path: string,
  contentType: string,
  message: {
    type: string
    reason: string
    error?: { code: string; message?: string }
  }
): Promise<void> {
  const url = new URL(path, baseUrl)

  let body: string
  let actualContentType: string

  if (contentType.includes(`text/event-stream`)) {
    body = `event: control\ndata: ${JSON.stringify(message)}\n\n`
    actualContentType = `text/event-stream`
  } else if (contentType.includes(`application/json`)) {
    body = JSON.stringify([message])
    actualContentType = `application/json`
  } else {
    body = JSON.stringify(message)
    actualContentType = contentType
  }

  const response = await fetch(url, {
    method: `POST`,
    headers: {
      "Content-Type": actualContentType,
    },
    body,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => ``)
    throw new Error(
      `Failed to append control message: ${response.status} ${errorText}`
    )
  }
}
