/**
 * Durable fetch wrapper.
 *
 * Provides a fetch-like API that automatically persists stream credentials
 * and can resume interrupted streams.
 *
 * RFC v1.1: Uses pre-signed URLs instead of Bearer tokens for authentication.
 */

import {
  createScopeFromUrl,
  getDefaultStorage,
  isExpired,
  loadCredentials,
  removeCredentials,
  saveCredentials,
  updateOffset,
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
 * Extract the service name from a proxy URL.
 * Expected format: .../v1/proxy/{service}
 */
function getServiceName(proxyUrlObj: URL): string {
  const match = proxyUrlObj.pathname.match(/\/v1\/proxy\/([^/]+)\/?$/)
  if (!match) {
    throw new Error(
      `Invalid proxy URL: expected format /v1/proxy/{service}, got ${proxyUrlObj.pathname}`
    )
  }
  return match[1]!
}

/**
 * Get the prefix before /v1/proxy (for deployments mounted under a subpath).
 * e.g., /api/durable/v1/proxy/chat -> /api/durable
 */
function getProxyPrefix(proxyUrlObj: URL): string {
  return proxyUrlObj.pathname.replace(/\/v1\/proxy\/[^/]+\/?$/, ``)
}

/**
 * Parse the Location header to extract stream credentials.
 *
 * Location format: /v1/proxy/{service}/{stream_id}?expires=...&signature=...
 */
function parseLocationHeader(
  location: string,
  baseUrl: URL
): { streamId: string; expires: string; signature: string } | null {
  try {
    const locationUrl = new URL(location, baseUrl.origin)
    const pathMatch = locationUrl.pathname.match(
      /\/v1\/proxy\/[^/]+\/([^/?]+)$/
    )
    if (!pathMatch) {
      return null
    }
    const streamId = pathMatch[1]!
    const expires = locationUrl.searchParams.get(`expires`)
    const signature = locationUrl.searchParams.get(`signature`)
    if (!expires || !signature) {
      return null
    }
    return { streamId, expires, signature }
  } catch {
    return null
  }
}

/**
 * Create a durable fetch wrapper.
 *
 * This wrapper:
 * 1. Routes requests through the proxy server
 * 2. Persists stream credentials for resumability
 * 3. Automatically resumes streams after disconnection
 *
 * RFC v1.1: Uses pre-signed URLs for authentication instead of Bearer tokens.
 *
 * @param options - Configuration options
 * @returns A fetch-like function with durable stream support
 *
 * @example
 * ```typescript
 * const durableFetch = createDurableFetch({
 *   proxyUrl: 'https://proxy.example.com/v1/proxy/chat',
 *   storage: localStorage,
 * })
 *
 * const response = await durableFetch('https://api.openai.com/v1/chat/completions', {
 *   method: 'POST',
 *   body: JSON.stringify({ messages, stream: true }),
 *   stream_key: 'conversation-123',
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
    storage = getDefaultStorage(),
    fetch: fetchFn = fetch,
    storagePrefix = DEFAULT_PREFIX,
    autoResume = true,
  } = options

  // Parse and validate the proxy URL
  const proxyUrlObj = new URL(proxyUrl)
  const serviceName = getServiceName(proxyUrlObj)
  const proxyPrefix = getProxyPrefix(proxyUrlObj)
  const storageScope = createScopeFromUrl(proxyUrl)

  return async (
    input: RequestInfo | URL,
    init?: DurableFetchRequestOptions
  ): Promise<DurableResponse> => {
    if (!init?.stream_key) {
      throw new Error(`stream_key is required for durable fetch requests`)
    }

    const { stream_key, _isResume, ...fetchInit } = init
    const upstreamUrl = typeof input === `string` ? input : input.toString()

    // Check for existing credentials (for resume)
    const existingCredentials = loadCredentials(
      storage,
      storagePrefix,
      storageScope,
      stream_key
    )

    if (
      existingCredentials &&
      !isExpired(existingCredentials) &&
      autoResume &&
      !_isResume
    ) {
      // Check if pre-signed URL has expired
      const expiresAt = parseInt(existingCredentials.expires, 10)
      if (Date.now() / 1000 < expiresAt) {
        // Try to resume from existing stream
        try {
          return await readFromStream(
            fetchFn,
            proxyUrlObj,
            proxyPrefix,
            serviceName,
            existingCredentials,
            stream_key,
            storage,
            storagePrefix,
            storageScope,
            true
          )
        } catch {
          // Resume failed, fall through to create new stream
          removeCredentials(storage, storagePrefix, storageScope, stream_key)
        }
      } else {
        // Pre-signed URL expired, remove credentials
        removeCredentials(storage, storagePrefix, storageScope, stream_key)
      }
    }

    // Create a new stream through the proxy
    // RFC v1.1: Use headers instead of query params
    const createUrl = new URL(proxyUrl)

    // Build headers for the create request
    const createHeaders: Record<string, string> = {
      "Upstream-URL": upstreamUrl,
    }

    // Forward Content-Type if present
    if (fetchInit.headers) {
      const headers = new Headers(fetchInit.headers)
      const contentType = headers.get(`Content-Type`)
      if (contentType) {
        createHeaders[`Content-Type`] = contentType
      }
      // Forward Authorization as Upstream-Authorization
      const authorization = headers.get(`Authorization`)
      if (authorization) {
        createHeaders[`Upstream-Authorization`] = authorization
      }
    }

    const createResponse = await fetchFn(createUrl.toString(), {
      ...fetchInit,
      method: `POST`,
      headers: {
        ...createHeaders,
        ...fetchInit.headers,
      },
    })

    if (!createResponse.ok) {
      const errorBody = await createResponse.text().catch(() => ``)
      throw new Error(
        `Failed to create stream: ${createResponse.status} ${errorBody}`
      )
    }

    // RFC v1.1: Extract credentials from Location header
    const location = createResponse.headers.get(`Location`)
    if (!location) {
      throw new Error(`Missing Location header in response`)
    }

    const parsed = parseLocationHeader(location, proxyUrlObj)
    if (!parsed) {
      throw new Error(`Invalid Location header format: ${location}`)
    }

    // Save credentials for future resume
    const credentials: StreamCredentials = {
      streamId: parsed.streamId,
      expires: parsed.expires,
      signature: parsed.signature,
      offset: `-1`,
      createdAt: Date.now(),
    }
    saveCredentials(
      storage,
      storagePrefix,
      storageScope,
      stream_key,
      credentials
    )

    // Now read from the stream
    return readFromStream(
      fetchFn,
      proxyUrlObj,
      proxyPrefix,
      serviceName,
      credentials,
      stream_key,
      storage,
      storagePrefix,
      storageScope,
      false
    )
  }
}

/**
 * Read from a durable stream.
 */
async function readFromStream(
  fetchFn: typeof fetch,
  proxyUrlObj: URL,
  proxyPrefix: string,
  serviceName: string,
  credentials: StreamCredentials,
  streamKey: string,
  storage: ReturnType<typeof getDefaultStorage>,
  storagePrefix: string,
  storageScope: string,
  wasResumed: boolean
): Promise<DurableResponse> {
  // Build the read URL: {prefix}/v1/proxy/{service}/{stream_id}?offset=...&expires=...&signature=...
  const readUrl = new URL(
    `${proxyPrefix}/v1/proxy/${serviceName}/${credentials.streamId}`,
    proxyUrlObj.origin
  )
  readUrl.searchParams.set(`offset`, credentials.offset)
  readUrl.searchParams.set(`expires`, credentials.expires)
  readUrl.searchParams.set(`signature`, credentials.signature)
  readUrl.searchParams.set(`live`, `sse`)

  const response = await fetchFn(readUrl.toString(), {
    headers: {
      Accept: `text/event-stream`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to read stream: ${response.status}`)
  }

  // Create a wrapped response that tracks offset updates
  const originalBody = response.body
  let transformedBody: ReadableStream<Uint8Array> | null = null

  if (originalBody) {
    transformedBody = trackOffsetUpdates(
      originalBody,
      storage,
      storagePrefix,
      storageScope,
      streamKey
    )
  }

  // Create a response-like object with our properties
  const durableResponse: DurableResponse = new Response(transformedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }) as DurableResponse

  // Add durable stream properties
  durableResponse.durableStreamId = credentials.streamId
  durableResponse.durableStreamOffset = credentials.offset
  durableResponse.wasResumed = wasResumed

  return durableResponse
}

/**
 * Create a transform stream that tracks offset updates from SSE events.
 *
 * SSE format includes an optional `id:` field that contains the offset.
 * We parse this to track our position for resume capability.
 */
function trackOffsetUpdates(
  body: ReadableStream<Uint8Array>,
  storage: ReturnType<typeof getDefaultStorage>,
  storagePrefix: string,
  storageScope: string,
  streamKey: string
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ``

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader()

      try {
        for (;;) {
          const { done, value } = await reader.read()

          if (done) {
            controller.close()
            break
          }

          // Pass through the data
          controller.enqueue(value)

          // Parse SSE events to track offset from id: field
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(`\n`)

          // Keep the last incomplete line in the buffer
          buffer = lines.pop() ?? ``

          for (const line of lines) {
            // SSE id: field contains the offset
            if (line.startsWith(`id:`)) {
              const offset = line.slice(3).trim()
              if (offset) {
                updateOffset(
                  storage,
                  storagePrefix,
                  storageScope,
                  streamKey,
                  offset
                )
              }
            }
          }
        }
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

/**
 * Create an abort function for a stream.
 *
 * RFC v1.1: Uses PATCH with pre-signed URL instead of POST with Bearer token.
 *
 * @param proxyUrl - The proxy URL (e.g., https://api.example.com/v1/proxy/chat)
 * @param streamId - The server-generated stream ID
 * @param expires - The pre-signed URL expiration timestamp
 * @param signature - The pre-signed URL signature
 * @param fetchFn - Optional fetch implementation
 */
export function createAbortFn(
  proxyUrl: string,
  streamId: string,
  expires: string,
  signature: string,
  fetchFn: typeof fetch = fetch
): () => Promise<void> {
  return async () => {
    const proxyUrlObj = new URL(proxyUrl)
    const serviceName = getServiceName(proxyUrlObj)
    const proxyPrefix = getProxyPrefix(proxyUrlObj)

    // Build abort URL: {prefix}/v1/proxy/{service}/{stream_id}?action=abort&expires=...&signature=...
    const abortUrl = new URL(
      `${proxyPrefix}/v1/proxy/${serviceName}/${streamId}`,
      proxyUrlObj.origin
    )
    abortUrl.searchParams.set(`action`, `abort`)
    abortUrl.searchParams.set(`expires`, expires)
    abortUrl.searchParams.set(`signature`, signature)

    const response = await fetchFn(abortUrl.toString(), {
      method: `PATCH`,
    })

    // RFC v1.1: 204 No Content on success (idempotent)
    if (!response.ok && response.status !== 204) {
      const body = await response.text().catch(() => ``)
      throw new Error(`Abort request failed: ${response.status} ${body}`)
    }
  }
}
