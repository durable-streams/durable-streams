/**
 * SSE Proxy Fetch Client
 *
 * Creates a fetch wrapper that transparently proxies SSE requests through
 * durable streams for resilient, resumable connections.
 */

import { stream } from "@durable-streams/client"
import { defaultHashRequest } from "./hash"
import type {
  ProxyInitiateRequest,
  ProxyInitiateResponse,
  SSEProxyFetchOptions,
} from "./types"

/**
 * Check if a request is for SSE based on Accept header.
 */
function isSSERequest(headers?: HeadersInit): boolean {
  if (!headers) return false

  let acceptHeader: string | null = null

  if (headers instanceof Headers) {
    acceptHeader = headers.get(`accept`)
  } else if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => key.toLowerCase() === `accept`)
    acceptHeader = entry ? entry[1] : null
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === `accept`) {
        acceptHeader = value
        break
      }
    }
  }

  return acceptHeader?.includes(`text/event-stream`) ?? false
}

/**
 * Convert headers to a plain object.
 */
function headersToObject(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {}

  if (!headers) return result

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value
    })
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      result[key] = value
    }
  }

  return result
}

/**
 * Create an SSE-style ReadableStream from a durable stream.
 * Transforms the durable stream's JSON items back into SSE format.
 */
function createSSEReadableStream(
  textStream: ReadableStream<string>,
  abortController: AbortController
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      const reader = textStream.getReader()

      try {
        let result = await reader.read()
        while (!result.done) {
          // The value is already SSE-formatted text from the proxy
          controller.enqueue(encoder.encode(result.value))
          result = await reader.read()
        }
        controller.close()
      } catch (err) {
        if (!abortController.signal.aborted) {
          controller.error(err)
        }
      } finally {
        reader.releaseLock()
      }
    },

    cancel(reason) {
      abortController.abort(reason)
    },
  })
}

/**
 * Create an SSE proxy fetch client.
 *
 * Returns a fetch function that works identically to normal fetch,
 * except SSE requests are transparently proxied through durable streams.
 *
 * @example
 * ```typescript
 * const fetchWithProxy = createSSEProxyFetch({
 *   proxyUrl: "https://proxy.example.com",
 * })
 *
 * // SSE requests go through the proxy
 * const response = await fetchWithProxy("/api/events", {
 *   headers: { Accept: "text/event-stream" }
 * })
 *
 * // Non-SSE requests pass through normally
 * const data = await fetchWithProxy("/api/data").then(r => r.json())
 * ```
 */
export function createSSEProxyFetch(
  options: SSEProxyFetchOptions
): typeof fetch {
  const {
    proxyUrl,
    hashRequest = defaultHashRequest,
    fetch: baseFetch = globalThis.fetch,
    proxyHeaders = {},
  } = options

  // Normalize proxy URL
  const normalizedProxyUrl = proxyUrl.replace(/\/$/, ``)

  return async function proxiedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    // Check if this is an SSE request
    if (!isSSERequest(init?.headers)) {
      // Not an SSE request, pass through to normal fetch
      return baseFetch(input, init)
    }

    // Extract URL from input
    let url: string
    if (input instanceof URL) {
      url = input.toString()
    } else if (input instanceof Request) {
      url = input.url
    } else {
      url = input
    }

    // Compute the stream path for this request
    const streamPath = await hashRequest(input, init)

    // Create an AbortController for this request
    const abortController = new AbortController()

    // Forward the original abort signal if provided
    if (init?.signal) {
      init.signal.addEventListener(
        `abort`,
        () => {
          abortController.abort(init.signal?.reason)
          // Also tell the proxy server to abort
          notifyProxyAbort(
            normalizedProxyUrl,
            streamPath,
            proxyHeaders,
            baseFetch
          ).catch(() => {
            // Ignore errors when notifying abort
          })
        },
        { once: true }
      )
    }

    // Prepare the proxy request
    const proxyRequest: ProxyInitiateRequest = {
      url,
      method: init?.method ?? `GET`,
      headers: headersToObject(init?.headers),
      body: typeof init?.body === `string` ? init.body : undefined,
      streamPath,
    }

    // Initiate the proxy connection
    const proxyResponse = await baseFetch(
      `${normalizedProxyUrl}/sse-proxy/initiate`,
      {
        method: `POST`,
        headers: {
          "Content-Type": `application/json`,
          ...proxyHeaders,
        },
        body: JSON.stringify(proxyRequest),
        signal: abortController.signal,
      }
    )

    if (!proxyResponse.ok) {
      const errorText = await proxyResponse.text()
      throw new Error(
        `SSE proxy initiation failed: ${proxyResponse.status} ${errorText}`
      )
    }

    const initiateResult: ProxyInitiateResponse = await proxyResponse.json()

    // Now read from the durable stream (server returns full URL)
    const streamResponse = await stream({
      url: initiateResult.streamUrl,
      offset: initiateResult.offset,
      live: `sse`,
      signal: abortController.signal,
    })

    // Create an SSE-formatted response
    const sseBody = createSSEReadableStream(
      streamResponse.textStream(),
      abortController
    )

    // Return a Response that looks like a normal SSE response
    return new Response(sseBody, {
      status: 200,
      statusText: `OK`,
      headers: new Headers({
        "Content-Type": `text/event-stream`,
        "Cache-Control": `no-cache`,
        Connection: `keep-alive`,
        "X-SSE-Proxy-Stream": initiateResult.streamPath,
      }),
    })
  }
}

/**
 * Notify the proxy server to abort a connection.
 */
async function notifyProxyAbort(
  proxyUrl: string,
  streamPath: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch
): Promise<void> {
  try {
    await fetchFn(
      `${proxyUrl}/sse-proxy/abort/${encodeURIComponent(streamPath)}`,
      {
        method: `DELETE`,
        headers,
      }
    )
  } catch {
    // Ignore errors - the connection may already be closed
  }
}

// Re-export types for convenience
export type { SSEProxyFetchOptions, RequestHasher } from "./types"
export { defaultHashRequest, createRequestHasher } from "./hash"
