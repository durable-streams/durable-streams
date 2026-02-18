/**
 * Handler for creating proxy streams.
 *
 * POST /v1/proxy
 *
 * Creates a new durable stream and begins proxying the upstream response.
 */

import { randomUUID } from "node:crypto"
import {
  generatePreSignedUrl,
  parsePreSignedUrl,
  validateHmac,
  validateServiceJwt,
} from "./tokens"
import { filterHeadersForUpstream, validateUpstreamUrl } from "./allowlist"
import {
  createConnection,
  nextResponseId,
  pipeUpstreamBody,
  registerConnection,
  unregisterConnection,
} from "./upstream"
import { sendError } from "./response"
import type { ProxyServerOptions } from "./types"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Allowed upstream methods per spec.
 */
const ALLOWED_METHODS = new Set([`GET`, `POST`, `PUT`, `PATCH`, `DELETE`])

/**
 * Maximum error body size to read from upstream.
 */
const MAX_ERROR_BODY_SIZE = 64 * 1024 // 64KB

/**
 * Upstream request timeout in milliseconds.
 */
const UPSTREAM_TIMEOUT_MS = 60000 // 60 seconds

/**
 * Default URL expiration in seconds (7 days).
 */
const DEFAULT_URL_EXPIRATION_SECONDS = 604800

/**
 * Collect request body as a Buffer.
 */
async function collectRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Array<Buffer> = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Read response body up to a maximum size.
 */
async function readResponseBody(
  response: Response,
  maxSize: number
): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) {
    return Buffer.alloc(0)
  }

  const chunks: Array<Uint8Array> = []
  let totalSize = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      chunks.push(value)
      totalSize += value.length

      if (totalSize >= maxSize) {
        break
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Concatenate and truncate if needed
  const result = Buffer.concat(chunks)
  return result.subarray(0, Math.min(result.length, maxSize))
}

/**
 * Result of verifying stream existence and status.
 */
type VerifyStreamResult =
  | { ok: true }
  | { ok: false; code: `NOT_FOUND` | `STREAM_CLOSED` | `STORAGE_ERROR` }

/**
 * Verify a stream exists and is not closed.
 *
 * @param durableStreamsUrl - URL of the durable streams server
 * @param streamId - The stream ID to verify
 * @returns Verification result
 */
async function verifyStreamExists(
  durableStreamsUrl: string,
  streamId: string
): Promise<VerifyStreamResult> {
  const streamPath = `/v1/streams/${streamId}`
  const fullStreamUrl = new URL(streamPath, durableStreamsUrl)

  try {
    const headResponse = await fetch(fullStreamUrl.toString(), {
      method: `HEAD`,
    })

    if (headResponse.status === 404) {
      return { ok: false, code: `NOT_FOUND` }
    }

    if (!headResponse.ok) {
      return { ok: false, code: `STORAGE_ERROR` }
    }

    // Check if stream is closed
    const streamClosed = headResponse.headers.get(`Stream-Closed`)
    if (streamClosed === `true`) {
      return { ok: false, code: `STREAM_CLOSED` }
    }

    return { ok: true }
  } catch {
    return { ok: false, code: `STORAGE_ERROR` }
  }
}

/**
 * Handle a create stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param options - Proxy server options
 * @param isAllowed - Function to validate upstream URLs
 * @param contentTypeStore - Map to store upstream content types
 */
export async function handleCreateStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyServerOptions,
  isAllowed: (url: string) => boolean,
  contentTypeStore: Map<string, string>
): Promise<void> {
  const url = new URL(req.url ?? ``, `http://${req.headers.host}`)

  // Step 1: Authentication - validate service JWT
  const auth = validateServiceJwt(
    url.searchParams.get(`secret`),
    req.headers.authorization,
    options.jwtSecret
  )

  if (!auth.ok) {
    const { code } = auth
    sendError(
      res,
      401,
      code,
      code === `MISSING_SECRET`
        ? `Service authentication required`
        : `Invalid service credentials`
    )
    return
  }

  // Step 2: Check for stream reuse via Use-Stream-URL header
  const useStreamUrlHeader = req.headers[`use-stream-url`]
  let reuseStreamId: string | null = null

  if (useStreamUrlHeader && !Array.isArray(useStreamUrlHeader)) {
    // Parse and validate the pre-signed URL
    const parsedStreamUrl = parsePreSignedUrl(useStreamUrlHeader)
    if (!parsedStreamUrl) {
      sendError(
        res,
        400,
        `MALFORMED_STREAM_URL`,
        `Use-Stream-URL header is malformed`
      )
      return
    }

    // Validate HMAC (ignoring expiry on write path)
    const hmacResult = validateHmac(
      parsedStreamUrl.streamId,
      parsedStreamUrl.expires,
      parsedStreamUrl.signature,
      options.jwtSecret
    )

    if (!hmacResult.ok) {
      sendError(res, 401, `SIGNATURE_INVALID`, `Invalid stream URL signature`)
      return
    }

    // Verify stream exists and is not closed
    const verifyResult = await verifyStreamExists(
      options.durableStreamsUrl,
      parsedStreamUrl.streamId
    )

    if (!verifyResult.ok) {
      if (verifyResult.code === `NOT_FOUND`) {
        sendError(res, 404, `STREAM_NOT_FOUND`, `Stream does not exist`)
        return
      }
      if (verifyResult.code === `STREAM_CLOSED`) {
        sendError(res, 409, `STREAM_CLOSED`, `Stream is closed`)
        return
      }
      sendError(res, 502, `STORAGE_ERROR`, `Failed to verify stream`)
      return
    }

    reuseStreamId = parsedStreamUrl.streamId
  }

  // Step 3: Validate required headers
  const upstreamUrl = req.headers[`upstream-url`]
  if (!upstreamUrl || Array.isArray(upstreamUrl)) {
    sendError(
      res,
      400,
      `MISSING_UPSTREAM_URL`,
      `Upstream-URL header is required`
    )
    return
  }

  const upstreamMethod = req.headers[`upstream-method`]
  if (!upstreamMethod || Array.isArray(upstreamMethod)) {
    sendError(
      res,
      400,
      `MISSING_UPSTREAM_METHOD`,
      `Upstream-Method header is required`
    )
    return
  }

  // Step 4: Validate method
  const method = upstreamMethod.toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    sendError(
      res,
      400,
      `INVALID_UPSTREAM_METHOD`,
      `Upstream-Method must be one of: GET, POST, PUT, PATCH, DELETE`
    )
    return
  }

  // Step 5: Validate upstream URL and check allowlist
  const parsedUrl = validateUpstreamUrl(upstreamUrl)
  if (!parsedUrl) {
    sendError(res, 403, `UPSTREAM_NOT_ALLOWED`, `Invalid upstream URL`)
    return
  }

  if (!isAllowed(upstreamUrl)) {
    sendError(
      res,
      403,
      `UPSTREAM_NOT_ALLOWED`,
      `Upstream URL is not in allowlist`
    )
    return
  }

  // Step 6: Determine stream ID (reuse or generate new)
  const streamId = reuseStreamId ?? randomUUID()
  const isStreamReuse = reuseStreamId !== null

  // Step 7: Prepare upstream request
  const upstreamHeaders = filterHeadersForUpstream(
    req.headers as Record<string, string | Array<string> | undefined>,
    parsedUrl.hostname
  )

  // Collect request body
  const body = await collectRequestBody(req)

  // Step 7: Fetch upstream with timeout
  const abortController = new AbortController()
  const timeoutId = setTimeout(
    () => abortController.abort(),
    UPSTREAM_TIMEOUT_MS
  )

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      body: body.length > 0 ? (body as unknown as BodyInit) : undefined,
      signal: abortController.signal,
      redirect: `manual`,
    })
    clearTimeout(timeoutId)
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error && error.name === `AbortError`) {
      sendError(
        res,
        504,
        `UPSTREAM_TIMEOUT`,
        `Upstream server did not respond in time`
      )
      return
    }

    // Other fetch errors
    const message = error instanceof Error ? error.message : `Unknown error`
    sendError(res, 502, `UPSTREAM_ERROR`, message)
    return
  }

  // Step 8: Handle upstream response status

  // 3xx Redirect - not allowed
  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    sendError(res, 400, `REDIRECT_NOT_ALLOWED`, `Proxy cannot follow redirects`)
    return
  }

  // 4xx/5xx Error - pass through with Upstream-Status header
  if (!upstreamResponse.ok) {
    const errorBody = await readResponseBody(
      upstreamResponse,
      MAX_ERROR_BODY_SIZE
    )

    res.writeHead(502, {
      "Content-Type":
        upstreamResponse.headers.get(`content-type`) ?? `text/plain`,
      "Upstream-Status": String(upstreamResponse.status),
    })
    res.end(errorBody)
    return
  }

  // Step 9: Create or reuse durable stream (2xx success path)
  const upstreamContentType =
    upstreamResponse.headers.get(`content-type`) ?? `application/octet-stream`
  const responseId = await nextResponseId(options.durableStreamsUrl, streamId)

  // Store upstream content type for GET/HEAD responses
  contentTypeStore.set(streamId, upstreamContentType)

  // Only create stream if not reusing
  if (!isStreamReuse) {
    const streamPath = `/v1/streams/${streamId}`
    const fullStreamUrl = new URL(streamPath, options.durableStreamsUrl)

    try {
      const createResponse = await fetch(fullStreamUrl.toString(), {
        method: `PUT`,
        headers: {
          "Content-Type": `application/octet-stream`,
          "Stream-TTL": String(options.streamTtlSeconds ?? 86400),
        },
      })

      if (!createResponse.ok) {
        const errorText = await createResponse.text().catch(() => ``)
        contentTypeStore.delete(streamId)
        sendError(
          res,
          502,
          `STORAGE_ERROR`,
          `Failed to create stream: ${errorText}`
        )
        return
      }
    } catch (error) {
      contentTypeStore.delete(streamId)
      const message = error instanceof Error ? error.message : `Unknown error`
      sendError(
        res,
        502,
        `STORAGE_ERROR`,
        `Failed to create stream: ${message}`
      )
      return
    }
  }

  // Step 10: Generate pre-signed URL and respond
  // Parse Stream-Signed-URL-TTL header for URL expiration
  const signedUrlTtlHeader = req.headers[`stream-signed-url-ttl`]
  let urlExpirationSeconds =
    options.urlExpirationSeconds ?? DEFAULT_URL_EXPIRATION_SECONDS

  if (signedUrlTtlHeader && !Array.isArray(signedUrlTtlHeader)) {
    const parsedTtl = parseInt(signedUrlTtlHeader, 10)
    if (!isNaN(parsedTtl) && parsedTtl >= 0) {
      urlExpirationSeconds = parsedTtl
    }
  }

  const expiresAt = Math.floor(Date.now() / 1000) + urlExpirationSeconds
  const proto = req.headers[`x-forwarded-proto`] ?? `http`
  const origin = `${proto}://${req.headers.host}`
  const location = generatePreSignedUrl(
    origin,
    streamId,
    options.jwtSecret,
    expiresAt
  )

  // Return 200 OK for stream reuse, 201 Created for new stream
  const statusCode = isStreamReuse ? 200 : 201
  res.writeHead(statusCode, {
    Location: location,
    "Stream-Id": streamId,
    "Upstream-Content-Type": upstreamContentType,
    "Stream-Response-Id": String(responseId),
  })
  res.end() // No body

  // Step 11: Start background piping
  const connection = createConnection(streamId, responseId, abortController)
  registerConnection(connection)

  // Pipe in background (don't await)
  pipeUpstreamBody(upstreamResponse.body, {
    durableStreamsUrl: options.durableStreamsUrl,
    streamId,
    responseId,
    signal: abortController.signal,
    upstreamStatus: upstreamResponse.status,
    upstreamHeaders: upstreamResponse.headers,
  })
    .catch((error) => {
      if (
        abortController.signal.aborted ||
        (error instanceof Error &&
          (error.name === `AbortError` ||
            (error.name === `TypeError` && error.message === `fetch failed`)))
      ) {
        return
      }
      console.error(`Error piping upstream body for stream ${streamId}:`, error)
    })
    .finally(() => {
      unregisterConnection(streamId, connection.connectionId)
    })
}
