/**
 * Durable fetch wrapper.
 *
 * Provides a fetch-like API that automatically persists stream credentials
 * and can resume interrupted streams.
 *
 * Design principle: everything the caller passes is "aimed at upstream".
 * The client transparently converts `Authorization` -> `Upstream-Authorization`
 * and `method` -> `Upstream-Method` when sending to the proxy.
 */

import { stream } from "@durable-streams/client"
import {
  extractExpiresFromUrl,
  extractStreamIdFromUrl,
  getDefaultStorage,
  isUrlExpired,
  loadCredentials,
  removeCredentials,
  saveCredentials,
} from "./storage"
import type {
  DurableFetch,
  DurableFetchOptions,
  DurableFetchRequestOptions,
  DurableResponse,
  StreamCredentials,
} from "./types"

/**
 * Default storage prefix for credentials.
 */
const DEFAULT_PREFIX = `durable-streams:`

/**
 * Create a durable fetch wrapper.
 *
 * This wrapper:
 * 1. Routes requests through the proxy server
 * 2. Persists stream credentials for resumability
 * 3. Automatically resumes streams after disconnection
 *
 * @param options - Configuration options
 * @returns A fetch-like function with durable stream support
 *
 * @example
 * ```typescript
 * const durableFetch = createDurableFetch({
 *   proxyUrl: 'https://proxy.example.com/v1/proxy',
 *   proxyAuthorization: 'service-secret',
 * })
 *
 * const response = await durableFetch('https://api.openai.com/v1/chat/completions', {
 *   method: 'POST',
 *   headers: { Authorization: `Bearer ${openaiKey}` },
 *   body: JSON.stringify({ messages, stream: true }),
 *   requestId: 'conversation-123', // optional, for resumability
 * })
 *
 * // Read the streaming response
 * const reader = response.body?.getReader()
 * for (;;) {
 *   const { done, value } = await reader.read()
 *   if (done) break
 *   // Process chunk...
 * }
 * ```
 */
export function createDurableFetch(options: DurableFetchOptions): DurableFetch {
  const {
    proxyUrl,
    proxyAuthorization,
    autoResume = true,
    storage = getDefaultStorage(),
    fetch: fetchFn = fetch,
    storagePrefix = DEFAULT_PREFIX,
  } = options

  // Normalize trailing slash
  const normalizedProxyUrl = proxyUrl.replace(/\/+$/, ``)

  return async (
    upstreamUrl: string | URL,
    init?: DurableFetchRequestOptions
  ): Promise<DurableResponse> => {
    const {
      method = `POST`,
      requestId,
      headers: userHeaders,
      body,
      signal,
    } = init ?? {}

    const upstream =
      typeof upstreamUrl === `string` ? upstreamUrl : upstreamUrl.toString()

    // --- Resume path ---
    if (requestId && autoResume) {
      const existing = loadCredentials(
        storage,
        storagePrefix,
        normalizedProxyUrl,
        requestId
      )

      if (existing && !isUrlExpired(existing)) {
        try {
          return await readFromStream(fetchFn, existing, true)
        } catch (error) {
          removeCredentials(
            storage,
            storagePrefix,
            normalizedProxyUrl,
            requestId
          )
          // Only fall through to create for expected resume failures
          // (network errors, 404 stale stream). Rethrow unexpected errors.
          const isExpected =
            error instanceof TypeError || // network/fetch errors
            (error instanceof Error &&
              (error.message.includes(`404`) ||
                error.message.includes(`not found`) ||
                error.name === `AbortError`))
          if (!isExpected) {
            throw error
          }
        }
      }
    }

    // --- Create path: POST {proxyUrl} ---
    const createUrl = new URL(normalizedProxyUrl)
    createUrl.searchParams.set(`secret`, proxyAuthorization)

    // Normalize user headers into a plain object
    const normalized = normalizeHeaders(userHeaders)

    // Build proxy request headers:
    //  - Upstream-URL, Upstream-Method from our args
    //  - Authorization from user -> Upstream-Authorization
    //  - Everything else forwarded as-is
    const proxyHeaders: Record<string, string> = {
      "Upstream-URL": upstream,
      "Upstream-Method": method,
    }

    for (const [key, value] of Object.entries(normalized)) {
      const lower = key.toLowerCase()
      if (lower === `authorization`) {
        // Relabel: user's Authorization -> Upstream-Authorization
        proxyHeaders[`Upstream-Authorization`] = value
      } else if (lower === `host`) {
        // Skip Host - the proxy sets its own
        continue
      } else {
        proxyHeaders[key] = value
      }
    }

    const createResponse = await fetchFn(createUrl.toString(), {
      method: `POST`,
      headers: proxyHeaders,
      body,
      signal,
    })

    // Handle errors
    if (!createResponse.ok) {
      if (createResponse.status === 502) {
        const upstreamStatus = createResponse.headers.get(`Upstream-Status`)
        const errorBody = await createResponse.text()
        throw new Error(`Upstream error (${upstreamStatus}): ${errorBody}`)
      }
      const errorBody = await createResponse.text().catch(() => ``)
      throw new Error(
        `Failed to create stream: ${createResponse.status} ${errorBody}`
      )
    }

    // Extract Location header (pre-signed URL)
    const locationHeader = createResponse.headers.get(`Location`)
    if (!locationHeader) {
      throw new Error(`Missing Location header in create response`)
    }

    const streamUrl = new URL(locationHeader, normalizedProxyUrl).toString()
    const streamId = extractStreamIdFromUrl(streamUrl)
    const expiresAt = extractExpiresFromUrl(streamUrl)
    const upstreamContentType =
      createResponse.headers.get(`Upstream-Content-Type`) ?? undefined

    const credentials: StreamCredentials = {
      streamUrl,
      streamId,
      offset: `-1`,
      upstreamContentType,
      createdAtMs: Date.now(),
      expiresAtSecs: expiresAt,
    }

    if (requestId) {
      saveCredentials(
        storage,
        storagePrefix,
        normalizedProxyUrl,
        requestId,
        credentials
      )
    }

    // --- Read from stream using @durable-streams/client ---
    return readFromStream(fetchFn, credentials, false)
  }
}

/**
 * Normalize headers from various formats into a plain object.
 */
function normalizeHeaders(
  headers: HeadersInit | undefined
): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const obj: Record<string, string> = {}
    headers.forEach((value, key) => {
      obj[key] = value
    })
    return obj
  }
  if (Array.isArray(headers)) {
    const obj: Record<string, string> = {}
    for (const [key, value] of headers) {
      obj[key] = value
    }
    return obj
  }
  return { ...headers }
}

/**
 * Read from a stream using @durable-streams/client stream().
 *
 * The pre-signed URL already contains expires/signature for auth.
 * We delegate to the DS client which handles reconnection, SSE parsing, etc.
 */
async function readFromStream(
  fetchFn: typeof fetch,
  credentials: StreamCredentials,
  wasResumed: boolean
): Promise<DurableResponse> {
  // Use @durable-streams/client stream() function
  const streamResponse = await stream({
    url: credentials.streamUrl,
    offset: credentials.offset === `-1` ? undefined : credentials.offset,
    fetch: fetchFn,
    live: true, // Follow until stream closes
  })

  // Bridge: wrap DS client's bodyStream() into a Response
  const bodyStream = streamResponse.bodyStream()

  const readableBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of bodyStream) {
          controller.enqueue(chunk)
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })

  // Build response headers:
  //  - Set Content-Type from Upstream-Content-Type (relabel)
  //  - Forward non-internal headers from the underlying response
  const responseHeaders = new Headers()
  responseHeaders.set(
    `Content-Type`,
    credentials.upstreamContentType ?? `application/octet-stream`
  )

  streamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower.startsWith(`stream-`) || lower === `content-type`) {
      return // Skip DS-internal and content-type (we use the relabeled one)
    }
    responseHeaders.set(key, value)
  })

  const response = new Response(readableBody, {
    status: 200,
    headers: responseHeaders,
  }) as DurableResponse

  response.streamId = credentials.streamId
  response.streamUrl = credentials.streamUrl
  response.offset = streamResponse.offset
  response.upstreamContentType = credentials.upstreamContentType
  response.wasResumed = wasResumed

  return response
}

/**
 * Create an abort function for a proxy stream.
 * Uses the pre-signed URL with ?action=abort via PATCH.
 */
export function createAbortFn(
  streamUrl: string,
  fetchFn: typeof fetch = fetch
): () => Promise<void> {
  return async () => {
    const abortUrl = new URL(streamUrl)
    abortUrl.searchParams.set(`action`, `abort`)

    const response = await fetchFn(abortUrl.toString(), { method: `PATCH` })

    if (!response.ok) {
      const body = await response.text().catch(() => ``)
      throw new Error(`Abort request failed: ${response.status} ${body}`)
    }
  }
}
