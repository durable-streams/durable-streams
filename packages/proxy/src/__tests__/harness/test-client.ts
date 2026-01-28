/**
 * Test client utilities for proxy tests.
 *
 * Provides convenient wrappers for making requests to the proxy server
 * and asserting on responses.
 */

/**
 * The JWT secret used by the test server.
 */
const TEST_SECRET = `test-secret-key-for-development`

/**
 * Options for creating a stream through the proxy.
 */
export interface CreateStreamOptions {
  /** Proxy server URL */
  proxyUrl: string
  /** Upstream URL to proxy */
  upstreamUrl: string
  /** Upstream HTTP method (default: POST) */
  upstreamMethod?: string
  /** Request body */
  body?: string | object
  /** Request headers (aimed at upstream) */
  headers?: Record<string, string>
  /** Service secret (default: test secret) */
  secret?: string
}

/**
 * Result of creating a stream.
 */
export interface CreateStreamResult {
  /** HTTP status code */
  status: number
  /** Response headers */
  headers: Headers
  /** Response body (parsed as JSON if applicable) */
  body: unknown
  /** The pre-signed stream URL from Location header */
  streamUrl?: string
  /** The stream ID extracted from the Location URL */
  streamId?: string
  /** The upstream content type */
  upstreamContentType?: string
}

/**
 * Create a stream through the proxy.
 */
export async function createStream(
  options: CreateStreamOptions
): Promise<CreateStreamResult> {
  const {
    proxyUrl,
    upstreamUrl,
    upstreamMethod = `POST`,
    body,
    headers = {},
    secret = TEST_SECRET,
  } = options

  const url = new URL(`/v1/proxy`, proxyUrl)
  url.searchParams.set(`secret`, secret)

  const requestHeaders: Record<string, string> = {
    "Upstream-URL": upstreamUrl,
    "Upstream-Method": upstreamMethod,
    ...headers,
  }

  // Remap Authorization to Upstream-Authorization (mimic client behavior)
  if (headers.Authorization) {
    requestHeaders[`Upstream-Authorization`] = headers.Authorization
    delete requestHeaders.Authorization
  }

  const response = await fetch(url.toString(), {
    method: `POST`,
    headers: requestHeaders,
    body: body
      ? typeof body === `string`
        ? body
        : JSON.stringify(body)
      : undefined,
  })

  const contentType = response.headers.get(`content-type`) ?? ``
  let responseBody: unknown = null

  if (contentType.includes(`application/json`)) {
    responseBody = await response.json()
  } else {
    responseBody = await response.text()
  }

  // Extract Location header (pre-signed URL)
  const locationHeader = response.headers.get(`Location`)
  let streamUrl: string | undefined
  let streamId: string | undefined

  if (locationHeader) {
    streamUrl = new URL(locationHeader, proxyUrl).toString()
    // Extract stream ID from URL path: /v1/proxy/{streamId}
    const match = new URL(streamUrl).pathname.match(/\/v1\/proxy\/([^/]+)\/?$/)
    if (match) {
      streamId = decodeURIComponent(match[1]!)
    }
  }

  const upstreamContentType =
    response.headers.get(`Upstream-Content-Type`) ?? undefined

  return {
    status: response.status,
    headers: response.headers,
    body: responseBody,
    streamUrl,
    streamId,
    upstreamContentType,
  }
}

/**
 * Options for reading a stream.
 */
export interface ReadStreamOptions {
  /** The pre-signed stream URL */
  streamUrl: string
  /** Starting offset (default: -1) */
  offset?: string
  /** Live mode (default: none) */
  live?: `long-poll` | `sse`
  /** Cursor for long-poll */
  cursor?: string
}

/**
 * Result of reading a stream.
 */
export interface ReadStreamResult {
  /** HTTP status code */
  status: number
  /** Response headers */
  headers: Headers
  /** Response body as text */
  body: string
  /** Next offset from response header */
  nextOffset?: string
  /** Cursor from response header */
  cursor?: string
  /** Whether the response is up-to-date */
  upToDate: boolean
  /** Upstream content type */
  upstreamContentType?: string
}

/**
 * Read from a stream through the proxy.
 */
export async function readStream(
  options: ReadStreamOptions
): Promise<ReadStreamResult> {
  const { streamUrl, offset = `-1`, live, cursor } = options

  const url = new URL(streamUrl)
  url.searchParams.set(`offset`, offset)
  if (live) {
    url.searchParams.set(`live`, live)
  }
  if (cursor) {
    url.searchParams.set(`cursor`, cursor)
  }

  const response = await fetch(url.toString(), {
    headers: {
      Accept: live === `sse` ? `text/event-stream` : `*/*`,
    },
  })

  const body = await response.text()

  return {
    status: response.status,
    headers: response.headers,
    body,
    nextOffset: response.headers.get(`Stream-Next-Offset`) ?? undefined,
    cursor: response.headers.get(`Stream-Cursor`) ?? undefined,
    upToDate: response.headers.has(`Stream-Up-To-Date`),
    upstreamContentType:
      response.headers.get(`Upstream-Content-Type`) ?? undefined,
  }
}

/**
 * Options for aborting a stream.
 */
export interface AbortStreamOptions {
  /** The pre-signed stream URL */
  streamUrl: string
}

/**
 * Result of aborting a stream.
 */
export interface AbortStreamResult {
  /** HTTP status code */
  status: number
  /** Response headers */
  headers: Headers
  /** Response body */
  body: unknown
}

/**
 * Abort a stream through the proxy.
 */
export async function abortStream(
  options: AbortStreamOptions
): Promise<AbortStreamResult> {
  const { streamUrl } = options

  const url = new URL(streamUrl)
  url.searchParams.set(`action`, `abort`)

  const response = await fetch(url.toString(), {
    method: `PATCH`,
  })

  let body: unknown = null
  if (response.status !== 204) {
    const contentType = response.headers.get(`content-type`) ?? ``
    if (contentType.includes(`application/json`)) {
      body = await response.json()
    } else {
      body = await response.text()
    }
  }

  return {
    status: response.status,
    headers: response.headers,
    body,
  }
}

/**
 * Options for a HEAD stream request.
 */
export interface HeadStreamOptions {
  /** Proxy server URL */
  proxyUrl: string
  /** The stream ID */
  streamId: string
  /** Service secret (default: test secret) */
  secret?: string
}

/**
 * Result of a HEAD stream request.
 */
export interface HeadStreamResult {
  /** HTTP status code */
  status: number
  /** Response headers */
  headers: Headers
}

/**
 * Get stream metadata via HEAD.
 */
export async function headStream(
  options: HeadStreamOptions
): Promise<HeadStreamResult> {
  const { proxyUrl, streamId, secret = TEST_SECRET } = options

  const url = new URL(`/v1/proxy/${streamId}`, proxyUrl)
  url.searchParams.set(`secret`, secret)

  const response = await fetch(url.toString(), {
    method: `HEAD`,
  })

  return {
    status: response.status,
    headers: response.headers,
  }
}

/**
 * Options for a DELETE stream request.
 */
export interface DeleteStreamOptions {
  /** Proxy server URL */
  proxyUrl: string
  /** The stream ID */
  streamId: string
  /** Service secret (default: test secret) */
  secret?: string
}

/**
 * Result of a DELETE stream request.
 */
export interface DeleteStreamResult {
  /** HTTP status code */
  status: number
  /** Response headers */
  headers: Headers
  /** Response body */
  body: unknown
}

/**
 * Delete a stream via the proxy.
 */
export async function deleteStream(
  options: DeleteStreamOptions
): Promise<DeleteStreamResult> {
  const { proxyUrl, streamId, secret = TEST_SECRET } = options

  const url = new URL(`/v1/proxy/${streamId}`, proxyUrl)
  url.searchParams.set(`secret`, secret)

  const response = await fetch(url.toString(), {
    method: `DELETE`,
  })

  let body: unknown = null
  if (response.status !== 204) {
    const contentType = response.headers.get(`content-type`) ?? ``
    if (contentType.includes(`application/json`)) {
      body = await response.json()
    } else {
      body = await response.text()
    }
  }

  return {
    status: response.status,
    headers: response.headers,
    body,
  }
}

/**
 * Collect all chunks from a streaming response.
 */
export async function collectStreamChunks(
  body: ReadableStream<Uint8Array>
): Promise<Array<string>> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  const chunks: Array<string> = []

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value))
  }

  return chunks
}

/**
 * Parse SSE events from a string.
 */
export function parseSSEEvents(
  text: string
): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = []
  const lines = text.split(`\n`)

  let currentEvent: string | undefined
  let currentData: Array<string> = []

  for (const line of lines) {
    if (line.startsWith(`event:`)) {
      currentEvent = line.slice(6).trim()
    } else if (line.startsWith(`data:`)) {
      currentData.push(line.slice(5))
    } else if (line === ``) {
      // Empty line marks end of event
      if (currentData.length > 0) {
        events.push({
          event: currentEvent,
          data: currentData.join(`\n`).trim(),
        })
        currentEvent = undefined
        currentData = []
      }
    }
  }

  return events
}

/**
 * Wait for a condition to be true.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  {
    timeout = 5000,
    interval = 100,
  }: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const start = Date.now()

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`)
}
