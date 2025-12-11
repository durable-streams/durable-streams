/**
 * Standalone stream() function - the fetch-like read API.
 *
 * This is the primary API for consumers who only need to read from streams.
 */

import {
  LIVE_QUERY_PARAM,
  OFFSET_QUERY_PARAM,
  STREAM_CURSOR_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "./constants"
import { DurableStreamError, FetchBackoffAbortError } from "./error"
import { BackoffDefaults, createFetchWithBackoff } from "./fetch"
import { StreamResponseImpl } from "./response"
import type {
  Auth,
  ByteChunk,
  LiveMode,
  Offset,
  StreamOptions,
  StreamResponse,
} from "./types"

/**
 * Create a streaming session to read from a durable stream.
 *
 * This is a fetch-like API:
 * - The promise resolves after the first network request succeeds
 * - It rejects for auth/404/other protocol errors
 * - Returns a StreamResponse for consuming the data
 *
 * @example
 * ```typescript
 * // Catch-up JSON:
 * const res = await stream<{ message: string }>({
 *   url,
 *   auth,
 *   offset: "0",
 *   live: false,
 * })
 * const items = await res.json()
 *
 * // Live JSON:
 * const live = await stream<{ message: string }>({
 *   url,
 *   auth,
 *   offset: savedOffset,
 *   live: "auto",
 * })
 * for await (const item of live.jsonItems()) {
 *   handle(item)
 * }
 * ```
 */
export async function stream<TJson = unknown>(
  options: StreamOptions
): Promise<StreamResponse<TJson>> {
  // Validate options
  if (!options.url) {
    throw new DurableStreamError(
      `Invalid stream options: missing required url parameter`,
      `BAD_REQUEST`
    )
  }

  // Normalize URL
  const url = options.url instanceof URL ? options.url.toString() : options.url

  // Build the first request
  const fetchUrl = new URL(url)

  // Set offset query param
  const startOffset = options.offset ?? `-1`
  fetchUrl.searchParams.set(OFFSET_QUERY_PARAM, startOffset)

  // Set live query param for explicit modes
  const live: LiveMode = options.live ?? `auto`
  if (live === `long-poll` || live === `sse`) {
    fetchUrl.searchParams.set(LIVE_QUERY_PARAM, live)
  }

  // Build headers
  const headers = await resolveHeaders(options.auth, options.headers)

  // Create abort controller
  const abortController = new AbortController()
  if (options.signal) {
    options.signal.addEventListener(
      `abort`,
      () => abortController.abort(options.signal?.reason),
      { once: true }
    )
  }

  // Get fetch client
  const baseFetchClient =
    options.fetchClient ??
    ((...args: Parameters<typeof fetch>) => fetch(...args))
  const fetchClient = createFetchWithBackoff(baseFetchClient, BackoffDefaults)

  // Make the first request
  let firstResponse: Response
  try {
    firstResponse = await fetchClient(fetchUrl.toString(), {
      method: `GET`,
      headers,
      signal: abortController.signal,
    })
  } catch (err) {
    if (err instanceof FetchBackoffAbortError) {
      throw new DurableStreamError(`Stream request was aborted`, `UNKNOWN`)
    }
    throw err
  }

  // Validate the response (headers only, don't consume body yet)
  if (!firstResponse.ok) {
    // Close the body to avoid leaking resources
    await firstResponse.arrayBuffer().catch(() => {})

    if (firstResponse.status === 404) {
      throw new DurableStreamError(`Stream not found: ${url}`, `NOT_FOUND`, 404)
    }
    throw await DurableStreamError.fromResponse(firstResponse, url)
  }

  // Extract metadata from headers
  const contentType = firstResponse.headers.get(`content-type`) ?? undefined
  const initialOffset =
    firstResponse.headers.get(STREAM_OFFSET_HEADER) ?? startOffset
  const initialCursor =
    firstResponse.headers.get(STREAM_CURSOR_HEADER) ?? undefined
  const initialUpToDate = firstResponse.headers.has(STREAM_UP_TO_DATE_HEADER)

  // Determine if JSON mode
  const isJsonMode =
    options.json === true ||
    (contentType?.includes(`application/json`) ?? false)

  // Create the fetch function for subsequent requests
  const fetchNext = async (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal
  ): Promise<Response> => {
    const nextUrl = new URL(url)
    nextUrl.searchParams.set(OFFSET_QUERY_PARAM, offset)

    // For subsequent requests in auto mode, use long-poll
    if (live === `auto` || live === `long-poll`) {
      nextUrl.searchParams.set(LIVE_QUERY_PARAM, `long-poll`)
    } else if (live === `sse`) {
      nextUrl.searchParams.set(LIVE_QUERY_PARAM, `sse`)
    }

    if (cursor) {
      nextUrl.searchParams.set(`cursor`, cursor)
    }

    const nextHeaders = await resolveHeaders(options.auth, options.headers)

    const response = await fetchClient(nextUrl.toString(), {
      method: `GET`,
      headers: nextHeaders,
      signal,
    })

    if (!response.ok) {
      if (response.status === 404) {
        throw new DurableStreamError(
          `Stream not found: ${url}`,
          `NOT_FOUND`,
          404
        )
      }
      throw await DurableStreamError.fromResponse(response, url)
    }

    return response
  }

  // Create SSE iterator function (if SSE mode is used)
  const startSSE =
    live === `sse`
      ? (
          _offset: Offset,
          _cursor: string | undefined,
          _signal: AbortSignal
        ): AsyncIterator<ByteChunk> => {
          // SSE implementation would go here
          // For now, throw an error since we need more infrastructure
          throw new DurableStreamError(
            `SSE mode is not yet implemented in the new API`,
            `SSE_NOT_SUPPORTED`
          )
        }
      : undefined

  // Create and return the StreamResponse
  return new StreamResponseImpl<TJson>({
    url,
    contentType,
    live,
    startOffset,
    isJsonMode,
    initialOffset,
    initialCursor,
    initialUpToDate,
    firstResponse,
    abortController,
    fetchNext,
    startSSE,
  })
}

/**
 * Resolve headers from auth and additional headers.
 */
async function resolveHeaders(
  auth: Auth | undefined,
  additionalHeaders: HeadersInit | undefined
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {}

  // Resolve auth
  if (auth) {
    if (`token` in auth) {
      const headerName = auth.headerName ?? `authorization`
      headers[headerName] = `Bearer ${auth.token}`
    } else if (`headers` in auth) {
      Object.assign(headers, auth.headers)
    } else if (`getHeaders` in auth) {
      const authHeaders = await auth.getHeaders()
      Object.assign(headers, authHeaders)
    }
  }

  // Resolve additional headers
  if (additionalHeaders) {
    if (additionalHeaders instanceof Headers) {
      additionalHeaders.forEach((value, key) => {
        headers[key] = value
      })
    } else if (Array.isArray(additionalHeaders)) {
      for (const [key, value] of additionalHeaders) {
        headers[key] = value
      }
    } else {
      Object.assign(headers, additionalHeaders)
    }
  }

  return headers
}
