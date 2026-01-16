/**
 * Durable fetch wrapper.
 *
 * Provides a fetch-like API that automatically persists stream credentials
 * and can resume interrupted streams.
 */

import {
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
  } = options

  // Parse the proxy URL to extract service name
  const proxyUrlObj = new URL(proxyUrl)
  const serviceMatch = proxyUrlObj.pathname.match(/\/v1\/proxy\/([^/]+)/)
  if (!serviceMatch) {
    throw new Error(
      `Invalid proxy URL: expected format /v1/proxy/{service}, got ${proxyUrlObj.pathname}`
    )
  }

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
          proxyUrl,
          existingCredentials,
          stream_key,
          storage,
          storagePrefix,
          true
        )
      } catch {
        // Resume failed, fall through to create new stream
        removeCredentials(storage, storagePrefix, stream_key)
      }
    }

    // Create a new stream through the proxy
    const createUrl = new URL(proxyUrl)
    createUrl.searchParams.set(`stream_key`, stream_key)
    createUrl.searchParams.set(`upstream`, upstreamUrl)

    const createResponse = await fetchFn(createUrl.toString(), {
      ...fetchInit,
      method: `POST`,
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
    saveCredentials(storage, storagePrefix, stream_key, credentials)

    // Now read from the stream
    return readFromStream(
      fetchFn,
      proxyUrl,
      credentials,
      stream_key,
      storage,
      storagePrefix,
      false
    )
  }
}

/**
 * Read from a durable stream.
 */
async function readFromStream(
  fetchFn: typeof fetch,
  proxyUrl: string,
  credentials: StreamCredentials,
  streamKey: string,
  storage: ReturnType<typeof getDefaultStorage>,
  storagePrefix: string,
  wasResumed: boolean
): Promise<DurableResponse> {
  // Build the read URL
  const proxyUrlObj = new URL(proxyUrl)
  const basePath = proxyUrlObj.pathname.replace(/\/[^/]+$/, ``) // Remove service name
  const readPath = `${basePath}${credentials.path.replace(`/v1/streams`, `/v1/proxy`)}`
  const readUrl = new URL(readPath, proxyUrlObj.origin)
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
 * Create a transform stream that tracks offset updates from SSE events.
 */
function trackOffsetUpdates(
  body: ReadableStream<Uint8Array>,
  storage: ReturnType<typeof getDefaultStorage>,
  storagePrefix: string,
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

          // Parse SSE events to track offset
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(`\n`)

          // Keep the last incomplete line in the buffer
          buffer = lines.pop() ?? ``

          for (const line of lines) {
            // Look for control events with offset
            if (line.startsWith(`data:`)) {
              const data = line.slice(5).trim()
              try {
                const parsed = JSON.parse(data)
                if (parsed.streamNextOffset) {
                  updateOffset(
                    storage,
                    storagePrefix,
                    streamKey,
                    parsed.streamNextOffset
                  )
                }
              } catch {
                // Not JSON, ignore
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
 */
export function createAbortFn(
  proxyUrl: string,
  streamPath: string,
  readToken: string,
  fetchFn: typeof fetch = fetch
): () => Promise<void> {
  return async () => {
    const proxyUrlObj = new URL(proxyUrl)
    const basePath = proxyUrlObj.pathname.replace(/\/[^/]+$/, ``)
    const abortPath = `${basePath}${streamPath.replace(`/v1/streams`, `/v1/proxy`)}/abort`
    const abortUrl = new URL(abortPath, proxyUrlObj.origin)

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
