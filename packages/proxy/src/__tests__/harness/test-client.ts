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
  /** Unique stream key */
  streamKey: string
  /** Upstream URL to proxy */
  upstreamUrl: string
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
  /** The stream path if successful */
  streamPath?: string
  /** The read token if successful */
  readToken?: string
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
    streamKey,
    upstreamUrl,
    body,
    headers = {},
  } = options

  const url = new URL(`/v1/proxy/${serviceName}`, proxyUrl)
  url.searchParams.set(`stream_key`, streamKey)
  url.searchParams.set(`upstream`, upstreamUrl)

  const response = await fetch(url.toString(), {
    method: `POST`,
    headers: {
      "Content-Type": `application/json`,
      ...headers,
    },
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

  return {
    status: response.status,
    headers: response.headers,
    body: responseBody,
    streamPath: response.headers.get(`Durable-Streams-Path`) ?? undefined,
    readToken: response.headers.get(`Durable-Streams-Read-Token`) ?? undefined,
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
  /** Stream key */
  streamKey: string
  /** Read token */
  readToken: string
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
    streamKey,
    readToken,
    offset = `-1`,
    live,
    cursor,
  } = options

  const url = new URL(`/v1/proxy/${serviceName}/streams/${streamKey}`, proxyUrl)
  url.searchParams.set(`offset`, offset)
  if (live) {
    url.searchParams.set(`live`, live)
  }
  if (cursor) {
    url.searchParams.set(`cursor`, cursor)
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${readToken}`,
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
  /** Stream key */
  streamKey: string
  /** Read token */
  readToken: string
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
  const { proxyUrl, serviceName, streamKey, readToken } = options

  const url = new URL(
    `/v1/proxy/${serviceName}/streams/${streamKey}/abort`,
    proxyUrl
  )

  const response = await fetch(url.toString(), {
    method: `POST`,
    headers: {
      Authorization: `Bearer ${readToken}`,
    },
  })

  const body = await response.json()

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
