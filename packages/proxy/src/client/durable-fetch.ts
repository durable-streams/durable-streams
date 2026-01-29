/**
 * Durable fetch wrapper.
 *
 * Provides a fetch-like API that automatically persists stream credentials
 * and can resume interrupted streams.
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
import { unwrapProxySSE } from "./sse-utils"
import type {
  DurableFetch,
  DurableFetchOptions,
  DurableFetchRequestOptions,
  DurableResponse,
  HeadersConfig,
  StreamCredentials,
} from "./types"

// Re-export for convenience
export { unwrapProxySSE } from "./sse-utils"

/**
 * Default storage prefix for credentials.
 */
const DEFAULT_PREFIX = `durable-streams:`

/**
 * Resolve headers configuration to a plain object.
 */
async function resolveHeaders(
  config: HeadersConfig | undefined
): Promise<Record<string, string>> {
  if (!config) return {}
  if (typeof config === `function`) {
    return await config()
  }
  return config
}

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
    headers: headersConfig,
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
    }

    // Create a new stream through the proxy
    const createUrl = new URL(proxyUrl)
    createUrl.searchParams.set(`stream_key`, stream_key)
    createUrl.searchParams.set(`upstream`, upstreamUrl)

    // Resolve and merge headers
    const configHeaders = await resolveHeaders(headersConfig)
    const requestHeaders = fetchInit.headers as
      | Record<string, string>
      | undefined
    const mergedHeaders = {
      ...configHeaders,
      ...requestHeaders,
    }

    const createResponse = await fetchFn(createUrl.toString(), {
      ...fetchInit,
      method: `POST`,
      headers: mergedHeaders,
    })

    if (!createResponse.ok) {
      const errorBody = await createResponse.text().catch(() => ``)
      throw new Error(
        `Failed to create stream: ${createResponse.status} ${errorBody}`
      )
    }

    // Extract the stream path and read token from headers
    const streamPath = createResponse.headers.get(`Durable-Streams-Path`)
    const readToken = createResponse.headers.get(`Durable-Streams-Read-Token`)

    if (!streamPath || !readToken) {
      throw new Error(`Missing stream path or read token in response headers`)
    }

    // Save credentials for future resume
    const credentials: StreamCredentials = {
      path: streamPath,
      readToken,
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
  // Build the read URL: {prefix}/v1/proxy/{service}/streams/{key}
  const readUrl = new URL(
    `${proxyPrefix}/v1/proxy/${serviceName}/streams/${streamKey}`,
    proxyUrlObj.origin
  )
  readUrl.searchParams.set(`offset`, credentials.offset)
  readUrl.searchParams.set(`live`, `sse`)

  const response = await fetchFn(readUrl.toString(), {
    headers: {
      Authorization: `Bearer ${credentials.readToken}`,
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
  durableResponse.durableStreamPath = credentials.path
  durableResponse.durableStreamOffset = credentials.offset
  durableResponse.wasResumed = wasResumed

  return durableResponse
}

/**
 * Create a transform stream that unwraps the proxy's SSE layer and tracks offset updates.
 */
function trackOffsetUpdates(
  body: ReadableStream<Uint8Array>,
  storage: ReturnType<typeof getDefaultStorage>,
  storagePrefix: string,
  storageScope: string,
  streamKey: string
): ReadableStream<Uint8Array> {
  return unwrapProxySSE(body, (controlData) => {
    if (controlData.streamNextOffset) {
      updateOffset(
        storage,
        storagePrefix,
        storageScope,
        streamKey,
        controlData.streamNextOffset
      )
    }
  })
}

/**
 * Options for resuming a durable stream.
 */
export interface ResumeOptions {
  /** The proxy URL (e.g., https://api.example.com/v1/proxy/chat) */
  proxyUrl: string
  /** The stream key */
  streamKey: string
  /** The read token for authorization */
  readToken: string
  /** The offset to resume from (default: "-1" for beginning) */
  offset?: string
  /** Custom fetch implementation */
  fetch?: typeof fetch
}

/**
 * Resume a durable stream by fetching from the proxy's stream endpoint.
 *
 * This function:
 * 1. Fetches from the proxy's stream endpoint with the given offset
 * 2. Unwraps the proxy's SSE layer
 * 3. Returns a Response with the unwrapped upstream content
 *
 * @param options - Resume options
 * @returns A Response with the unwrapped stream body
 *
 * @example
 * ```typescript
 * const response = await resume({
 *   proxyUrl: 'https://proxy.example.com/v1/proxy/chat',
 *   streamKey: 'conversation-123',
 *   readToken: 'token-from-credentials',
 *   offset: '5',
 * })
 *
 * // Read the unwrapped stream
 * const reader = response.body?.getReader()
 * // ... process chunks
 * ```
 */
export async function resume(options: ResumeOptions): Promise<Response> {
  const {
    proxyUrl,
    streamKey,
    readToken,
    offset = `-1`,
    fetch: fetchFn = fetch,
  } = options

  const proxyUrlObj = new URL(proxyUrl)
  const serviceName = getServiceName(proxyUrlObj)
  const proxyPrefix = getProxyPrefix(proxyUrlObj)

  // Build the stream URL
  const streamUrl = new URL(
    `${proxyPrefix}/v1/proxy/${serviceName}/streams/${streamKey}`,
    proxyUrlObj.origin
  )
  streamUrl.searchParams.set(`offset`, offset)
  streamUrl.searchParams.set(`live`, `sse`)

  const response = await fetchFn(streamUrl.toString(), {
    headers: {
      Authorization: `Bearer ${readToken}`,
      Accept: `text/event-stream`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to resume stream: ${response.status}`)
  }

  if (!response.body) {
    throw new Error(`No response body`)
  }

  // Unwrap the proxy's SSE layer
  const unwrappedBody = unwrapProxySSE(response.body)

  return new Response(unwrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * Create an abort function for a stream.
 *
 * @param proxyUrl - The proxy URL (e.g., https://api.example.com/v1/proxy/chat)
 * @param streamKey - The stream key
 * @param readToken - The read token for authorization
 * @param fetchFn - Optional fetch implementation
 */
export function createAbortFn(
  proxyUrl: string,
  streamKey: string,
  readToken: string,
  fetchFn: typeof fetch = fetch
): () => Promise<void> {
  return async () => {
    const proxyUrlObj = new URL(proxyUrl)
    const serviceName = getServiceName(proxyUrlObj)
    const proxyPrefix = getProxyPrefix(proxyUrlObj)

    // Build abort URL: {prefix}/v1/proxy/{service}/streams/{key}/abort
    const abortUrl = new URL(
      `${proxyPrefix}/v1/proxy/${serviceName}/streams/${streamKey}/abort`,
      proxyUrlObj.origin
    )

    const response = await fetchFn(abortUrl.toString(), {
      method: `POST`,
      headers: {
        Authorization: `Bearer ${readToken}`,
      },
    })

    if (!response.ok) {
      const body = await response.text().catch(() => ``)
      throw new Error(`Abort request failed: ${response.status} ${body}`)
    }
  }
}
