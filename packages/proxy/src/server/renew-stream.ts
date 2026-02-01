/**
 * Handler for renewing pre-signed stream URLs.
 *
 * POST /v1/proxy/renew
 *
 * Allows clients to obtain a fresh signed URL for an existing stream
 * without producing a write. This is for re-activating read access
 * when the signed URL has expired.
 */

import {
  generatePreSignedUrl,
  parsePreSignedUrl,
  validateHmac,
  validateServiceJwt,
} from "./tokens"
import { filterHeadersForUpstream, validateUpstreamUrl } from "./allowlist"
import { sendError } from "./response"
import type { ProxyServerOptions } from "./types"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Default URL expiration in seconds (7 days).
 */
const DEFAULT_URL_EXPIRATION_SECONDS = 604800

/**
 * Upstream request timeout in milliseconds.
 */
const UPSTREAM_TIMEOUT_MS = 30000 // 30 seconds for renew (shorter than create)

/**
 * Verify a stream exists.
 *
 * @param durableStreamsUrl - URL of the durable streams server
 * @param streamId - The stream ID to verify
 * @returns True if the stream exists, false otherwise
 */
async function streamExists(
  durableStreamsUrl: string,
  streamId: string
): Promise<boolean> {
  const streamPath = `/v1/streams/${streamId}`
  const fullStreamUrl = new URL(streamPath, durableStreamsUrl)

  try {
    const headResponse = await fetch(fullStreamUrl.toString(), {
      method: `HEAD`,
    })

    return headResponse.ok || headResponse.status !== 404
  } catch {
    return false
  }
}

/**
 * Handle a renew stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param options - Proxy server options
 * @param isAllowed - Function to validate upstream URLs
 */
export async function handleRenewStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyServerOptions,
  isAllowed: (url: string) => boolean
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

  // Step 2: Parse and validate Use-Stream-Url header
  const useStreamUrlHeader = req.headers[`use-stream-url`]
  if (!useStreamUrlHeader || Array.isArray(useStreamUrlHeader)) {
    sendError(
      res,
      400,
      `MISSING_USE_STREAM_URL`,
      `Use-Stream-Url header is required`
    )
    return
  }

  const parsedStreamUrl = parsePreSignedUrl(useStreamUrlHeader)
  if (!parsedStreamUrl) {
    sendError(
      res,
      400,
      `INVALID_USE_STREAM_URL`,
      `Use-Stream-Url header is malformed`
    )
    return
  }

  // Validate HMAC (ignoring expiry on renew path)
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

  // Step 3: Verify stream exists
  const exists = await streamExists(
    options.durableStreamsUrl,
    parsedStreamUrl.streamId
  )

  if (!exists) {
    sendError(res, 404, `STREAM_NOT_FOUND`, `Stream does not exist`)
    return
  }

  // Step 4: Parse and validate Upstream-URL header (the renewUrl)
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

  const parsedUpstreamUrl = validateUpstreamUrl(upstreamUrl)
  if (!parsedUpstreamUrl) {
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

  // Step 5: Forward request to renewUrl with client's auth headers
  const upstreamHeaders = filterHeadersForUpstream(
    req.headers as Record<string, string | Array<string> | undefined>,
    parsedUpstreamUrl.hostname
  )

  const abortController = new AbortController()
  const timeoutId = setTimeout(
    () => abortController.abort(),
    UPSTREAM_TIMEOUT_MS
  )

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: `POST`,
      headers: upstreamHeaders,
      signal: abortController.signal,
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

    const message = error instanceof Error ? error.message : `Unknown error`
    sendError(res, 502, `UPSTREAM_ERROR`, message)
    return
  }

  // Step 6: Handle upstream response
  // Consume and discard the response body
  try {
    await upstreamResponse.text()
  } catch {
    // Ignore body read errors
  }

  // If upstream returns 4xx or 5xx, return 401 Unauthorized
  if (!upstreamResponse.ok) {
    sendError(
      res,
      401,
      `RENEWAL_REJECTED`,
      `Upstream rejected the renewal request`
    )
    return
  }

  // Step 7: Generate fresh signed URL and return 200 OK
  // Parse X-Stream-TTL header for URL expiration
  const streamTtlHeader = req.headers[`x-stream-ttl`]
  let urlExpirationSeconds =
    options.urlExpirationSeconds ?? DEFAULT_URL_EXPIRATION_SECONDS

  if (streamTtlHeader && !Array.isArray(streamTtlHeader)) {
    const parsedTtl = parseInt(streamTtlHeader, 10)
    if (!isNaN(parsedTtl) && parsedTtl >= 0) {
      urlExpirationSeconds = parsedTtl
    }
  }

  const expiresAt = Math.floor(Date.now() / 1000) + urlExpirationSeconds
  const proto = req.headers[`x-forwarded-proto`] ?? `http`
  const origin = `${proto}://${req.headers.host}`
  const location = generatePreSignedUrl(
    origin,
    parsedStreamUrl.streamId,
    options.jwtSecret,
    expiresAt
  )

  res.writeHead(200, {
    Location: location,
    "Access-Control-Allow-Origin": `*`,
    "Access-Control-Expose-Headers": `Location`,
  })
  res.end()
}
