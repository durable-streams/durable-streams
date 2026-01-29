/**
 * Standalone stream() function - the fetch-like read API.
 *
 * This is the primary API for consumers who only need to read from streams.
 */

import {
  LIVE_QUERY_PARAM,
  OFFSET_QUERY_PARAM,
  STREAM_CLOSED_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_SSE_DATA_ENCODING_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "./constants"
import { DurableStreamError, FetchBackoffAbortError } from "./error"
import { BackoffDefaults, createFetchWithBackoff } from "./fetch"
import { StreamResponseImpl } from "./response"
import {
  handleErrorResponse,
  resolveHeaders,
  resolveParams,
  warnIfUsingHttpInBrowser,
} from "./utils"
import type { LiveMode, Offset, StreamOptions, StreamResponse } from "./types"

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
 *   live: true,
 * })
 * live.subscribeJson(async (batch) => {
 *   for (const item of batch.items) {
 *     handle(item)
 *   }
 * })
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

  // Mutable options that can be updated by onError handler
  let currentHeaders = options.headers
  let currentParams = options.params

  // Retry loop for onError handling
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    try {
      return await streamInternal<TJson>({
        ...options,
        headers: currentHeaders,
        params: currentParams,
      })
    } catch (err) {
      // If there's an onError handler, give it a chance to recover
      if (options.onError) {
        const retryOpts = await options.onError(
          err instanceof Error ? err : new Error(String(err))
        )

        // If handler returns void/undefined, stop retrying
        if (retryOpts === undefined) {
          throw err
        }

        // Merge returned params/headers for retry
        if (retryOpts.params) {
          currentParams = {
            ...currentParams,
            ...retryOpts.params,
          }
        }
        if (retryOpts.headers) {
          currentHeaders = {
            ...currentHeaders,
            ...retryOpts.headers,
          }
        }

        // Continue to retry with updated options
        continue
      }

      // No onError handler, just throw
      throw err
    }
  }
}

/**
 * Internal implementation of stream that doesn't handle onError retries.
 */
async function streamInternal<TJson = unknown>(
  options: StreamOptions
): Promise<StreamResponse<TJson>> {
  // Normalize URL
  const url = options.url instanceof URL ? options.url.toString() : options.url

  // Warn if using HTTP in browser (can cause connection limit issues)
  warnIfUsingHttpInBrowser(url, options.warnOnHttp)

  // Build the first request
  const fetchUrl = new URL(url)

  // Set offset query param
  const startOffset = options.offset ?? `-1`
  fetchUrl.searchParams.set(OFFSET_QUERY_PARAM, startOffset)

  // Set live query param for explicit modes
  // true means auto-select (no query param, handled by consumption method)
  const live: LiveMode = options.live ?? true
  if (live === `long-poll` || live === `sse`) {
    fetchUrl.searchParams.set(LIVE_QUERY_PARAM, live)
  }

  // Add custom params
  const params = await resolveParams(options.params)
  for (const [key, value] of Object.entries(params)) {
    fetchUrl.searchParams.set(key, value)
  }

  // Build headers
  const headers = await resolveHeaders(options.headers)

  // Create abort controller
  const abortController = new AbortController()
  if (options.signal) {
    options.signal.addEventListener(
      `abort`,
      () => abortController.abort(options.signal?.reason),
      { once: true }
    )
  }

  // Get fetch client with backoff
  const baseFetchClient =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const backoffOptions = options.backoffOptions ?? BackoffDefaults
  const fetchClient = createFetchWithBackoff(baseFetchClient, backoffOptions)

  // Make the first request
  // Backoff client will throw FetchError for non-OK responses
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
    // Let other errors (including FetchError) propagate to onError handler
    throw err
  }

  // Extract metadata from headers
  const contentType = firstResponse.headers.get(`content-type`) ?? undefined
  const initialOffset =
    firstResponse.headers.get(STREAM_OFFSET_HEADER) ?? startOffset
  const initialCursor =
    firstResponse.headers.get(STREAM_CURSOR_HEADER) ?? undefined
  const initialUpToDate = firstResponse.headers.has(STREAM_UP_TO_DATE_HEADER)
  const initialStreamClosed =
    firstResponse.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`

  // Determine if JSON mode
  const isJsonMode =
    options.json === true ||
    (contentType?.includes(`application/json`) ?? false)

  // Detect SSE data encoding from response header (server auto-sets for binary streams)
  const sseDataEncoding = firstResponse.headers.get(
    STREAM_SSE_DATA_ENCODING_HEADER
  )
  const encoding =
    sseDataEncoding === `base64` ? (`base64` as const) : undefined

  // Create the fetch function for subsequent requests
  const fetchNext = async (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal,
    resumingFromPause?: boolean
  ): Promise<Response> => {
    const nextUrl = new URL(url)
    nextUrl.searchParams.set(OFFSET_QUERY_PARAM, offset)

    // For subsequent requests, set live mode unless resuming from pause
    // (resuming from pause needs immediate response for UI status)
    if (!resumingFromPause) {
      if (live === `sse`) {
        nextUrl.searchParams.set(LIVE_QUERY_PARAM, `sse`)
      } else if (live === true || live === `long-poll`) {
        nextUrl.searchParams.set(LIVE_QUERY_PARAM, `long-poll`)
      }
    }

    if (cursor) {
      nextUrl.searchParams.set(`cursor`, cursor)
    }

    // Resolve params per-request (for dynamic values)
    const nextParams = await resolveParams(options.params)
    for (const [key, value] of Object.entries(nextParams)) {
      nextUrl.searchParams.set(key, value)
    }

    const nextHeaders = await resolveHeaders(options.headers)

    const response = await fetchClient(nextUrl.toString(), {
      method: `GET`,
      headers: nextHeaders,
      signal,
    })

    if (!response.ok) {
      await handleErrorResponse(response, url)
    }

    return response
  }

  // Create SSE start function (for SSE mode reconnection)
  const startSSE =
    live === `sse`
      ? async (
          offset: Offset,
          cursor: string | undefined,
          signal: AbortSignal
        ): Promise<Response> => {
          const sseUrl = new URL(url)
          sseUrl.searchParams.set(OFFSET_QUERY_PARAM, offset)
          sseUrl.searchParams.set(LIVE_QUERY_PARAM, `sse`)
          if (cursor) {
            sseUrl.searchParams.set(`cursor`, cursor)
          }

          // Resolve params per-request (for dynamic values)
          const sseParams = await resolveParams(options.params)
          for (const [key, value] of Object.entries(sseParams)) {
            sseUrl.searchParams.set(key, value)
          }

          const sseHeaders = await resolveHeaders(options.headers)

          const response = await fetchClient(sseUrl.toString(), {
            method: `GET`,
            headers: sseHeaders,
            signal,
          })

          if (!response.ok) {
            await handleErrorResponse(response, url)
          }

          return response
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
    initialStreamClosed,
    firstResponse,
    abortController,
    fetchNext,
    startSSE,
    sseResilience: options.sseResilience,
    encoding,
  })
}
