/**
 * Handler for the connect operation.
 *
 * POST /v1/proxy/:streamId?action=connect
 *
 * Initializes or reconnects a session by:
 * 1. Using the stream ID from the URL path
 * 2. Ensuring the stream exists (HEAD/PUT)
 * 3. Optionally forwarding to an auth endpoint (Upstream-URL) with Stream-Id header
 * 4. Returning a fresh signed URL in Location header (no response body)
 */

import { generatePreSignedUrl, validateServiceJwt } from "./tokens"
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
const UPSTREAM_TIMEOUT_MS = 30000

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
 * Handle a connect stream request.
 *
 * @param req - The incoming HTTP request
 * @param res - The server response
 * @param options - Proxy server options
 * @param isAllowed - Function to validate upstream URLs
 */
export async function handleConnectStream(
  req: IncomingMessage,
  res: ServerResponse,
  streamId: string,
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

  // Step 2: Validate action query for connect route.
  const action = url.searchParams.get(`action`)
  if (action !== `connect`) {
    sendError(
      res,
      400,
      `INVALID_ACTION`,
      `Query parameter action must be "connect"`
    )
    return
  }

  // Step 3: Optional Upstream-URL header (auth endpoint).
  const upstreamUrl = req.headers[`upstream-url`]

  // Step 5: If Upstream-URL is provided, authorize via auth endpoint.
  if (upstreamUrl && !Array.isArray(upstreamUrl)) {
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

    const upstreamHeaders = filterHeadersForUpstream(
      req.headers as Record<string, string | Array<string> | undefined>,
      parsedUpstreamUrl.hostname
    )
    upstreamHeaders[`Stream-Id`] = streamId
    const body = await collectRequestBody(req)

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
      const message = error instanceof Error ? error.message : `Unknown error`
      sendError(res, 502, `UPSTREAM_ERROR`, message)
      return
    }

    if (!upstreamResponse.ok) {
      sendError(
        res,
        401,
        `CONNECT_REJECTED`,
        `Auth endpoint rejected session access`
      )
      return
    }
  } else if (Array.isArray(upstreamUrl)) {
    sendError(
      res,
      400,
      `MALFORMED_UPSTREAM_URL`,
      `Upstream-URL header must be a single value`
    )
    return
  }

  // Step 6: Ensure stream exists (HEAD, then PUT if needed).
  const streamPath = `/v1/streams/${streamId}`
  const fullStreamUrl = new URL(streamPath, options.durableStreamsUrl)
  let isNewSession = false

  try {
    const headResponse = await fetch(fullStreamUrl.toString(), {
      method: `HEAD`,
    })

    if (headResponse.status === 404) {
      // Stream doesn't exist - create it
      const createResponse = await fetch(fullStreamUrl.toString(), {
        method: `PUT`,
        headers: {
          "Content-Type": `application/octet-stream`,
          "Stream-TTL": String(options.streamTtlSeconds ?? 86400),
        },
      })

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

      isNewSession = true
    } else if (!headResponse.ok) {
      sendError(res, 502, `STORAGE_ERROR`, `Failed to check stream existence`)
      return
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : `Unknown error`
    sendError(res, 502, `STORAGE_ERROR`, `Failed to check stream: ${message}`)
    return
  }

  // Step 7: Generate pre-signed URL.
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
  const signedLocation = generatePreSignedUrl(
    origin,
    streamId,
    options.jwtSecret,
    expiresAt
  )
  const locationUrl = new URL(signedLocation)
  // Preserve additional query params from connect request.
  for (const [key, value] of url.searchParams.entries()) {
    if (key === `action` || key === `secret`) continue
    locationUrl.searchParams.set(key, value)
  }

  // Step 8: Return no body, only Location header.
  const statusCode = isNewSession ? 201 : 200
  const responseHeaders = {
    Location: locationUrl.toString(),
  }
  res.writeHead(statusCode, responseHeaders)
  res.end()
}
