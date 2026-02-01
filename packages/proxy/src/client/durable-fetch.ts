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
  loadSessionCredentials,
  removeCredentials,
  removeSessionCredentials,
  saveCredentials,
  saveSessionCredentials,
} from "./storage"
import type {
  DurableFetch,
  DurableFetchOptions,
  DurableFetchRequestOptions,
  DurableResponse,
  DurableStorage,
  SessionCredentials,
  StreamCredentials,
} from "./types"

/**
 * Default storage prefix for credentials.
 */
const DEFAULT_PREFIX = `durable-streams:`

/**
 * Check whether an error from a resume attempt is expected and
 * should fall through to creating a new stream.
 *
 * Expected failures: network errors (TypeError), stale/deleted streams
 * (404 / not found), and abort signals. Anything else is unexpected
 * and should propagate to the caller.
 */
function isExpectedResumeError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true
  }
  if (error instanceof Error) {
    return (
      error.message.includes(`404`) ||
      error.message.includes(`not found`) ||
      error.name === `AbortError`
    )
  }
  return false
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
    sessionId: clientSessionId,
    getSessionId: clientGetSessionId,
    ttl,
    renewUrl,
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
      sessionId: requestSessionId,
    } = init ?? {}

    const upstream =
      typeof upstreamUrl === `string` ? upstreamUrl : upstreamUrl.toString()

    // Normalize user headers early so they're available for renewal
    const normalized = normalizeHeaders(userHeaders)

    // Resolve effective sessionId (priority: request > getSessionId > client options)
    let effectiveSessionId: string | undefined
    if (requestSessionId !== undefined) {
      // Explicit per-request sessionId (even if undefined, it means "no session")
      effectiveSessionId = requestSessionId
    } else if (clientGetSessionId) {
      effectiveSessionId = clientGetSessionId(upstream, init)
    } else {
      effectiveSessionId = clientSessionId
    }

    // --- Resume path (requestId credentials first) ---
    if (requestId && autoResume) {
      const existing = loadCredentials(
        storage,
        storagePrefix,
        normalizedProxyUrl,
        requestId
      )

      if (existing && !isUrlExpired(existing)) {
        try {
          return await readFromStream(
            fetchFn,
            existing,
            true,
            renewUrl,
            normalizedProxyUrl,
            proxyAuthorization,
            normalized,
            {
              storage,
              storagePrefix,
              scope: normalizedProxyUrl,
              requestId,
              sessionId: effectiveSessionId,
            }
          )
        } catch (error) {
          removeCredentials(
            storage,
            storagePrefix,
            normalizedProxyUrl,
            requestId
          )
          if (!isExpectedResumeError(error)) {
            throw error
          }
        }
      }
    }

    // --- Session reuse path (check session credentials if no requestId match) ---
    let sessionCredentials: SessionCredentials | null = null
    if (effectiveSessionId) {
      sessionCredentials = loadSessionCredentials(
        storage,
        storagePrefix,
        normalizedProxyUrl,
        effectiveSessionId
      )
    }

    // --- Create path: POST {proxyUrl} ---
    const createUrl = new URL(normalizedProxyUrl)
    createUrl.searchParams.set(`secret`, proxyAuthorization)

    // Build proxy request headers:
    //  - Upstream-URL, Upstream-Method from our args
    //  - Authorization from user -> Upstream-Authorization
    //  - Everything else forwarded as-is
    const proxyHeaders: Record<string, string> = {
      "Upstream-URL": upstream,
      "Upstream-Method": method,
    }

    // Add session reuse header if we have session credentials
    if (sessionCredentials) {
      proxyHeaders[`Use-Stream-URL`] = sessionCredentials.streamUrl
    }

    // Add TTL header if configured
    if (ttl !== undefined) {
      proxyHeaders[`X-Stream-TTL`] = String(ttl)
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
      // Handle 409 Conflict (stream closed) - clear session and retry without reuse
      if (
        createResponse.status === 409 &&
        sessionCredentials &&
        effectiveSessionId
      ) {
        removeSessionCredentials(
          storage,
          storagePrefix,
          normalizedProxyUrl,
          effectiveSessionId
        )
        // Retry without session reuse by making a recursive call
        // We need to remove the Use-Stream-URL header and retry
        delete proxyHeaders[`Use-Stream-URL`]
        const retryResponse = await fetchFn(createUrl.toString(), {
          method: `POST`,
          headers: proxyHeaders,
          body,
          signal,
        })
        if (!retryResponse.ok) {
          if (retryResponse.status === 502) {
            const upstreamStatus = parseInt(
              retryResponse.headers.get(`Upstream-Status`)!,
              10
            )
            const upstreamContentType = retryResponse.headers.get(
              `Upstream-Content-Type`
            )
            return new Response(retryResponse.body, {
              status: upstreamStatus,
              headers: {
                ...retryResponse.headers,
                "Content-Type":
                  upstreamContentType ?? `application/octet-stream`,
                "Upstream-Error": `true`,
              },
            }) as DurableResponse
          }
          return retryResponse as DurableResponse
        }
        // Process the retry response as a new stream
        const retryLocationHeader = retryResponse.headers.get(`Location`)
        if (!retryLocationHeader) {
          throw new Error(`Missing Location header in retry response`)
        }
        const retryStreamUrl = new URL(
          retryLocationHeader,
          normalizedProxyUrl
        ).toString()
        const retryStreamId = extractStreamIdFromUrl(retryStreamUrl)
        const retryExpiresAt = extractExpiresFromUrl(retryStreamUrl)
        const retryUpstreamContentType =
          retryResponse.headers.get(`Upstream-Content-Type`) ?? undefined

        const retryCredentials: StreamCredentials = {
          streamUrl: retryStreamUrl,
          streamId: retryStreamId,
          offset: `-1`,
          upstreamContentType: retryUpstreamContentType,
          createdAtMs: Date.now(),
          expiresAtSecs: retryExpiresAt,
        }

        // Save session credentials for the new stream
        if (effectiveSessionId) {
          saveSessionCredentials(
            storage,
            storagePrefix,
            normalizedProxyUrl,
            effectiveSessionId,
            { streamUrl: retryStreamUrl, streamId: retryStreamId }
          )
        }

        if (requestId) {
          saveCredentials(
            storage,
            storagePrefix,
            normalizedProxyUrl,
            requestId,
            retryCredentials
          )
        }

        return readFromStream(
          fetchFn,
          retryCredentials,
          false,
          renewUrl,
          normalizedProxyUrl,
          proxyAuthorization,
          normalized,
          {
            storage,
            storagePrefix,
            scope: normalizedProxyUrl,
            requestId,
            sessionId: effectiveSessionId,
          }
        )
      }

      if (createResponse.status === 502) {
        const upstreamStatus = parseInt(
          createResponse.headers.get(`Upstream-Status`)!,
          10
        )
        const upstreamContentType = createResponse.headers.get(
          `Upstream-Content-Type`
        )
        return new Response(createResponse.body, {
          status: upstreamStatus,
          headers: {
            ...createResponse.headers,
            "Content-Type": upstreamContentType ?? `application/octet-stream`,
            "Upstream-Error": `true`,
          },
        }) as DurableResponse
      } else {
        return createResponse as DurableResponse
      }
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

    // Store/update session credentials for stream reuse
    if (effectiveSessionId) {
      saveSessionCredentials(
        storage,
        storagePrefix,
        normalizedProxyUrl,
        effectiveSessionId,
        { streamUrl, streamId }
      )
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
    return readFromStream(
      fetchFn,
      credentials,
      false,
      renewUrl,
      normalizedProxyUrl,
      proxyAuthorization,
      normalized,
      {
        storage,
        storagePrefix,
        scope: normalizedProxyUrl,
        requestId,
        sessionId: effectiveSessionId,
      }
    )
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
 * Structured error response for renewable URLs.
 */
interface RenewableErrorResponse {
  error?: string
  message?: string
  renewable?: boolean
  streamId?: string
}

/**
 * Check if an error is a renewable 401 error.
 */
function isRenewableError(error: unknown): error is Error & {
  status: number
  details?: RenewableErrorResponse
} {
  if (!(error instanceof Error)) return false
  const err = error as Error & { status?: number; details?: unknown }
  if (err.status !== 401) return false
  const details = err.details as RenewableErrorResponse | undefined
  return details?.renewable === true
}

/**
 * Storage context for saving renewed credentials.
 */
interface StorageContext {
  storage: DurableStorage
  storagePrefix: string
  scope: string
  requestId?: string
  sessionId?: string
}

/**
 * Maximum number of renewal retry attempts to prevent infinite loops.
 */
const MAX_RENEWAL_RETRIES = 1

/**
 * Read from a stream using @durable-streams/client stream().
 *
 * The pre-signed URL already contains expires/signature for auth.
 * We delegate to the DS client which handles reconnection, SSE parsing, etc.
 *
 * @param fetchFn - Fetch function to use
 * @param credentials - Stream credentials including URL and offset
 * @param wasResumed - Whether this is a resumed stream
 * @param renewUrl - URL for renewing expired URLs
 * @param proxyUrl - Base proxy URL (needed for renewal endpoint)
 * @param proxyAuthorization - Proxy authorization secret
 * @param userHeaders - Original user headers for renewal (used to re-authorize with renewUrl)
 * @param storageContext - Storage context for persisting renewed credentials
 * @param retryCount - Current renewal retry count (defaults to 0)
 */
async function readFromStream(
  fetchFn: typeof fetch,
  credentials: StreamCredentials,
  wasResumed: boolean,
  renewUrl?: string,
  proxyUrl?: string,
  proxyAuthorization?: string,
  userHeaders?: Record<string, string>,
  storageContext?: StorageContext,
  retryCount = 0
): Promise<DurableResponse> {
  // Use @durable-streams/client stream() function
  let streamResponse
  try {
    streamResponse = await stream({
      url: credentials.streamUrl,
      offset: credentials.offset === `-1` ? undefined : credentials.offset,
      fetch: fetchFn,
      live: `sse`, // Follow until stream closes
    })
  } catch (error) {
    // Check if this is a renewable 401 error and we haven't exceeded retry limit
    if (
      isRenewableError(error) &&
      renewUrl &&
      proxyUrl &&
      proxyAuthorization &&
      retryCount < MAX_RENEWAL_RETRIES
    ) {
      // Attempt to renew the URL
      const renewedUrl = await renewStreamUrl(
        fetchFn,
        proxyUrl,
        proxyAuthorization,
        credentials.streamUrl,
        renewUrl,
        userHeaders
      )

      if (renewedUrl) {
        // Update credentials with the fresh URL
        const renewedCredentials: StreamCredentials = {
          ...credentials,
          streamUrl: renewedUrl,
          expiresAtSecs: extractExpiresFromUrl(renewedUrl),
        }

        // Save renewed credentials to storage for future reads
        if (storageContext) {
          const { storage, storagePrefix, scope, requestId, sessionId } =
            storageContext

          // Update request credentials if we have a requestId
          if (requestId) {
            saveCredentials(
              storage,
              storagePrefix,
              scope,
              requestId,
              renewedCredentials
            )
          }

          // Update session credentials if we have a sessionId
          if (sessionId) {
            saveSessionCredentials(storage, storagePrefix, scope, sessionId, {
              streamUrl: renewedUrl,
              streamId: credentials.streamId,
            })
          }
        }

        // Retry the read with the renewed URL (increment retry count)
        return readFromStream(
          fetchFn,
          renewedCredentials,
          wasResumed,
          renewUrl,
          proxyUrl,
          proxyAuthorization,
          userHeaders,
          storageContext,
          retryCount + 1
        )
      }
    }

    // Rethrow if not renewable or renewal failed
    throw error
  }

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
 * Attempt to renew an expired stream URL.
 *
 * POSTs to /v1/proxy/renew with the expired URL and renewUrl.
 * Returns the fresh URL on success, or null on failure.
 *
 * @param fetchFn - Fetch function to use
 * @param proxyUrl - Base proxy URL
 * @param proxyAuthorization - Proxy authorization secret
 * @param expiredStreamUrl - The expired stream URL
 * @param renewUrl - The upstream renewal URL for authorization check
 * @param userHeaders - Original user headers for renewal
 */
async function renewStreamUrl(
  fetchFn: typeof fetch,
  proxyUrl: string,
  proxyAuthorization: string,
  expiredStreamUrl: string,
  renewUrl: string,
  userHeaders?: Record<string, string>
): Promise<string | null> {
  const renewEndpoint = new URL(`${proxyUrl}/renew`)
  renewEndpoint.searchParams.set(`secret`, proxyAuthorization)

  const headers: Record<string, string> = {
    "Use-Stream-URL": expiredStreamUrl,
    "Upstream-URL": renewUrl,
  }

  // Forward user's authorization header for the renewal check
  if (userHeaders) {
    for (const [key, value] of Object.entries(userHeaders)) {
      const lower = key.toLowerCase()
      if (lower === `authorization`) {
        headers[`Upstream-Authorization`] = value
      }
    }
  }

  try {
    const response = await fetchFn(renewEndpoint.toString(), {
      method: `POST`,
      headers,
    })

    if (!response.ok) {
      return null
    }

    const location = response.headers.get(`Location`)
    return location ? new URL(location, proxyUrl).toString() : null
  } catch {
    return null
  }
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
