/**
 * Test client utilities for proxy tests.
 *
 * Provides convenient wrappers for making requests to the proxy server
 * and asserting on responses.
 */

/**
 * Options for creating a stream through the proxy.
 */
export interface CreateStreamOptions {
  /** Proxy server URL */
  proxyUrl: string
  /** Service name for the proxy route */
  serviceName: string
  /** Upstream URL to proxy */
  upstreamUrl: string
  /** Upstream HTTP method (default: POST) */
  upstreamMethod?: string
  /** Authorization to forward to upstream */
  upstreamAuth?: string
  /** Request body */
  body?: string | object
  /** Request headers */
  headers?: Record<string, string>
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
  /** The Location header (pre-signed URL path) */
  location?: string
  /** Upstream content type from response headers */
  upstreamContentType?: string
  /** Parsed stream ID from Location header */
  streamId?: string
  /** Parsed expires from Location header */
  expires?: string
  /** Parsed signature from Location header */
  signature?: string
}

/**
 * Create a stream through the proxy.
 */
export async function createStream(
  options: CreateStreamOptions
): Promise<CreateStreamResult> {
  const {
    proxyUrl,
    serviceName,
    upstreamUrl,
    upstreamMethod = `POST`,
    upstreamAuth,
    body,
    headers = {},
  } = options

  const url = new URL(`/v1/proxy/${serviceName}`, proxyUrl)

  const requestHeaders: Record<string, string> = {
    "Content-Type": `application/json`,
    "Upstream-URL": upstreamUrl,
    "Upstream-Method": upstreamMethod,
    ...headers,
  }

  if (upstreamAuth) {
    requestHeaders[`Upstream-Authorization`] = upstreamAuth
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

  const location = response.headers.get(`Location`) ?? undefined
  const upstreamContentType =
    response.headers.get(`Upstream-Content-Type`) ?? undefined

  // Parse Location header to extract streamId, expires, signature
  let streamId: string | undefined
  let expires: string | undefined
  let signature: string | undefined

  if (location) {
    // Location format: /v1/proxy/{service}/{stream_id}?expires=...&signature=...
    const locationUrl = new URL(location, proxyUrl)
    const pathMatch = locationUrl.pathname.match(
      /^\/v1\/proxy\/[^/]+\/([^/?]+)$/
    )
    if (pathMatch) {
      streamId = pathMatch[1]
    }
    expires = locationUrl.searchParams.get(`expires`) ?? undefined
    signature = locationUrl.searchParams.get(`signature`) ?? undefined
  }

  return {
    status: response.status,
    headers: response.headers,
    body: responseBody,
    location,
    upstreamContentType,
    streamId,
    expires,
    signature,
  }
}

/**
 * Options for reading a stream.
 */
export interface ReadStreamOptions {
  /** Proxy server URL */
  proxyUrl: string
  /** Service name */
  serviceName: string
  /** Stream ID */
  streamId: string
  /** Pre-signed URL expires timestamp */
  expires: string
  /** Pre-signed URL signature */
  signature: string
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
}

/**
 * Read from a stream through the proxy.
 */
export async function readStream(
  options: ReadStreamOptions
): Promise<ReadStreamResult> {
  const {
    proxyUrl,
    serviceName,
    streamId,
    expires,
    signature,
    offset = `-1`,
    live,
    cursor,
  } = options

  const url = new URL(`/v1/proxy/${serviceName}/${streamId}`, proxyUrl)
  url.searchParams.set(`expires`, expires)
  url.searchParams.set(`signature`, signature)
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
  }
}

/**
 * Options for aborting a stream.
 */
export interface AbortStreamOptions {
  /** Proxy server URL */
  proxyUrl: string
  /** Service name */
  serviceName: string
  /** Stream ID */
  streamId: string
  /** Pre-signed URL expires timestamp */
  expires: string
  /** Pre-signed URL signature */
  signature: string
}

/**
 * Result of aborting a stream.
 */
export interface AbortStreamResult {
  /** HTTP status code */
  status: number
  /** Response headers */
  headers: Headers
}

/**
 * Abort a stream through the proxy.
 */
export async function abortStream(
  options: AbortStreamOptions
): Promise<AbortStreamResult> {
  const { proxyUrl, serviceName, streamId, expires, signature } = options

  const url = new URL(`/v1/proxy/${serviceName}/${streamId}`, proxyUrl)
  url.searchParams.set(`action`, `abort`)
  url.searchParams.set(`expires`, expires)
  url.searchParams.set(`signature`, signature)

  const response = await fetch(url.toString(), {
    method: `PATCH`,
  })

  return {
    status: response.status,
    headers: response.headers,
  }
}

/**
 * Options for deleting a stream.
 */
export interface DeleteStreamOptions {
  /** Proxy server URL */
  proxyUrl: string
  /** Service name */
  serviceName: string
  /** Stream ID */
  streamId: string
  /** Service token for authentication */
  serviceToken: string
}

/**
 * Result of deleting a stream.
 */
export interface DeleteStreamResult {
  /** HTTP status code */
  status: number
  /** Response headers */
  headers: Headers
}

/**
 * Delete a stream through the proxy.
 */
export async function deleteStream(
  options: DeleteStreamOptions
): Promise<DeleteStreamResult> {
  const { proxyUrl, serviceName, streamId, serviceToken } = options

  const url = new URL(`/v1/proxy/${serviceName}/${streamId}`, proxyUrl)

  const response = await fetch(url.toString(), {
    method: `DELETE`,
    headers: {
      Authorization: `Bearer ${serviceToken}`,
    },
  })

  return {
    status: response.status,
    headers: response.headers,
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
