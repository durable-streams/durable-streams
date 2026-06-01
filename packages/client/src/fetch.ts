/**
 * Fetch utilities with retry and backoff support.
 * Based on @electric-sql/client patterns.
 */

import {
  CURSOR_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  OFFSET_QUERY_PARAM,
  STREAM_CLOSED_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "./constants"
import {
  FetchBackoffAbortError,
  FetchError,
  MissingHeadersError,
} from "./error"

/**
 * HTTP status codes that should be retried.
 */
const HTTP_RETRY_STATUS_CODES = [429, 503]

/**
 * Options for configuring exponential backoff retry behavior.
 */
export interface BackoffOptions {
  /**
   * Initial delay before retrying in milliseconds.
   */
  initialDelay: number

  /**
   * Maximum retry delay in milliseconds.
   * After reaching this, delay stays constant.
   */
  maxDelay: number

  /**
   * Multiplier for exponential backoff.
   */
  multiplier: number

  /**
   * Callback invoked on each failed attempt.
   */
  onFailedAttempt?: () => void

  /**
   * Enable debug logging.
   */
  debug?: boolean

  /**
   * Maximum number of retry attempts before giving up.
   * Set to Infinity for indefinite retries (useful for offline scenarios).
   */
  maxRetries?: number
}

/**
 * Default backoff options.
 */
export const BackoffDefaults: BackoffOptions = {
  initialDelay: 1_000,
  maxDelay: 32_000,
  multiplier: 2,
  maxRetries: Infinity,
}

export const ON_ERROR_MAX_RETRIES = 50

export function getFullJitterBackoffMs(
  attempt: number,
  options: BackoffOptions = BackoffDefaults
): number {
  return (
    Math.random() *
    Math.min(
      options.maxDelay,
      options.initialDelay * Math.pow(options.multiplier, attempt - 1)
    )
  )
}

export async function sleepWithAbort(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw new FetchBackoffAbortError()

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener(`abort`, onAbort)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new FetchBackoffAbortError())
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    signal.addEventListener(`abort`, onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/**
 * Parse Retry-After header value and return delay in milliseconds.
 * Supports both delta-seconds format and HTTP-date format.
 * Returns 0 if header is not present or invalid.
 */
export function parseRetryAfterHeader(retryAfter: string | undefined): number {
  if (!retryAfter) return 0

  // Try parsing as seconds (delta-seconds format)
  const retryAfterSec = Number(retryAfter)
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return retryAfterSec * 1000
  }

  // Try parsing as HTTP-date
  const retryDate = Date.parse(retryAfter)
  if (!isNaN(retryDate)) {
    // Handle clock skew: clamp to non-negative, cap at reasonable max
    const deltaMs = retryDate - Date.now()
    return Math.max(0, Math.min(deltaMs, 3600_000)) // Cap at 1 hour
  }

  return 0
}

/**
 * Validate backoff options for correctness.
 * Throws on invalid input with descriptive error messages.
 */
export function validateBackoffOptions(options: BackoffOptions): void {
  if (options.maxRetries !== undefined && options.maxRetries < 0) {
    throw new Error(`Invalid backoffOptions: maxRetries must be non-negative`)
  }
  if (options.initialDelay <= 0) {
    throw new Error(`Invalid backoffOptions: initialDelayMs must be positive`)
  }
  if (options.maxDelay < options.initialDelay) {
    throw new Error(
      `Invalid backoffOptions: maxDelayMs must be >= initialDelayMs`
    )
  }
  if (options.multiplier < 1.0) {
    throw new Error(`Invalid backoffOptions: multiplier must be >= 1.0`)
  }
}

/**
 * Creates a fetch client that retries failed requests with exponential backoff.
 *
 * @param fetchClient - The base fetch client to wrap
 * @param backoffOptions - Options for retry behavior
 * @returns A fetch function with automatic retry
 */
export function createFetchWithBackoff(
  fetchClient: typeof fetch,
  backoffOptions: BackoffOptions = BackoffDefaults
): typeof fetch {
  validateBackoffOptions(backoffOptions)

  const {
    initialDelay,
    maxDelay,
    multiplier,
    debug = false,
    onFailedAttempt,
    maxRetries = Infinity,
  } = backoffOptions

  return async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const url = args[0]
    const options = args[1]

    let delay = initialDelay
    let attempt = 0

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      try {
        const result = await fetchClient(...args)
        if (result.ok) {
          return result
        }

        const err = await FetchError.fromResponse(result, url.toString())
        throw err
      } catch (e) {
        onFailedAttempt?.()

        if (options?.signal?.aborted) {
          throw new FetchBackoffAbortError()
        } else if (
          e instanceof FetchError &&
          !HTTP_RETRY_STATUS_CODES.includes(e.status) &&
          e.status >= 400 &&
          e.status < 500
        ) {
          // Client errors (except 429) cannot be backed off on
          throw e
        } else {
          // Check max retries
          attempt++
          if (attempt > maxRetries) {
            if (debug) {
              console.log(
                `Max retries reached (${attempt}/${maxRetries}), giving up`
              )
            }
            throw e
          }

          // Calculate wait time honoring server-driven backoff as a floor
          // Parse server-provided Retry-After (if present)
          const serverMinimumMs =
            e instanceof FetchError
              ? parseRetryAfterHeader(e.headers[`retry-after`])
              : 0

          // Calculate client backoff with full jitter strategy
          // Full jitter: random_between(0, min(cap, exponential_backoff))
          const jitter = Math.random() * delay
          const clientBackoffMs = Math.min(jitter, maxDelay)

          // Server minimum is the floor, client cap is the ceiling
          const waitMs = Math.max(serverMinimumMs, clientBackoffMs)

          if (debug) {
            const source = serverMinimumMs > 0 ? `server+client` : `client`
            console.log(
              `Retry attempt #${attempt} after ${waitMs}ms (${source}, serverMin=${serverMinimumMs}ms, clientBackoff=${clientBackoffMs}ms)`
            )
          }

          // Wait for the calculated duration (cancellable via abort signal)
          if (options?.signal) {
            await sleepWithAbort(waitMs, options.signal)
          } else {
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
          }

          // Increase the delay for the next attempt (capped at maxDelay)
          delay = Math.min(delay * multiplier, maxDelay)
        }
      }
    }
  }
}

/**
 * Status codes where we shouldn't try to read the body.
 */
const NO_BODY_STATUS_CODES = [201, 204, 205]

/**
 * Creates a fetch client that ensures the response body is fully consumed.
 * This prevents issues with connection pooling when bodies aren't read.
 *
 * Uses arrayBuffer() instead of text() to preserve binary data integrity.
 *
 * @param fetchClient - The base fetch client to wrap
 * @returns A fetch function that consumes response bodies
 */
export function createFetchWithConsumedBody(
  fetchClient: typeof fetch
): typeof fetch {
  return async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const url = args[0]
    const res = await fetchClient(...args)

    try {
      if (res.status < 200 || NO_BODY_STATUS_CODES.includes(res.status)) {
        return res
      }

      // Read body as arrayBuffer to preserve binary data integrity
      const buf = await res.arrayBuffer()
      return new Response(buf, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    } catch (err) {
      if (args[1]?.signal?.aborted) {
        throw new FetchBackoffAbortError()
      }

      throw new FetchError(
        res.status,
        undefined,
        undefined,
        Object.fromEntries([...res.headers.entries()]),
        url.toString(),
        err instanceof Error
          ? err.message
          : typeof err === `string`
            ? err
            : `failed to read body`
      )
    }
  }
}

/**
 * Creates a fetch client that validates required protocol headers are present.
 * Throws MissingHeadersError if a 2xx response is missing required headers.
 * This catches proxies/CDNs that strip custom headers.
 *
 * @param fetchClient - The base fetch client to wrap
 * @returns A fetch function that validates response headers
 */
export function createFetchWithResponseHeadersCheck(
  fetchClient: typeof fetch
): typeof fetch {
  return async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const res = await fetchClient(...args)
    if (res.status < 200 || res.status >= 300) return res

    const url = getRequestUrl(args[0])
    const missing: Array<string> = []

    if (!res.headers.has(STREAM_OFFSET_HEADER)) {
      missing.push(STREAM_OFFSET_HEADER)
    }

    const requestUrl = new URL(url)
    const liveParam = requestUrl.searchParams.get(LIVE_QUERY_PARAM)
    const streamClosed =
      res.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`
    // Cursor required for live requests unless stream is closed
    if (liveParam && !streamClosed && !res.headers.has(STREAM_CURSOR_HEADER)) {
      missing.push(STREAM_CURSOR_HEADER)
    }

    if (missing.length > 0) {
      throw new MissingHeadersError(missing, url)
    }

    return res
  }
}

/**
 * Chains an AbortController to an optional source signal.
 * If the source signal is aborted, the provided controller will also abort.
 */
export function chainAborter(
  aborter: AbortController,
  sourceSignal?: AbortSignal | null
): {
  signal: AbortSignal
  cleanup: () => void
} {
  let cleanup = noop
  if (!sourceSignal) {
    // no-op, nothing to chain to
  } else if (sourceSignal.aborted) {
    // source signal is already aborted, abort immediately
    aborter.abort(sourceSignal.reason)
  } else {
    // chain to source signal abort event
    const abortParent = () => aborter.abort(sourceSignal.reason)
    sourceSignal.addEventListener(`abort`, abortParent, {
      once: true,
      signal: aborter.signal,
    })
    cleanup = () => sourceSignal.removeEventListener(`abort`, abortParent)
  }

  return {
    signal: aborter.signal,
    cleanup,
  }
}

function noop() {}

/**
 * Compute the URL for the next chunk to prefetch based on response headers.
 * Returns null if prefetching is not appropriate (closed, up-to-date, or live).
 */
export function getNextChunkUrl(
  requestUrl: URL,
  response: Response
): URL | null {
  if (response.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`)
    return null
  if (response.headers.has(STREAM_UP_TO_DATE_HEADER)) return null
  if (requestUrl.searchParams.has(LIVE_QUERY_PARAM)) return null

  const nextOffset = response.headers.get(STREAM_OFFSET_HEADER)
  if (!nextOffset) return null

  const nextUrl = new URL(requestUrl.toString())
  nextUrl.searchParams.set(OFFSET_QUERY_PARAM, nextOffset)

  const cursor = response.headers.get(STREAM_CURSOR_HEADER)
  if (cursor) {
    nextUrl.searchParams.set(CURSOR_QUERY_PARAM, cursor)
  }

  return nextUrl
}

function getRequestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof Request !== `undefined` && input instanceof Request) {
    return input.url
  }
  return input.toString()
}

function getRequestMethod(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): string {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== `undefined` && input instanceof Request) {
    return input.method.toUpperCase()
  }
  return `GET`
}

function getRequestHeaders(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Headers {
  if (init?.headers) return new Headers(init.headers)
  if (typeof Request !== `undefined` && input instanceof Request) {
    return new Headers(input.headers)
  }
  return new Headers()
}

const COMPATIBLE_REQUEST_OPTIONS = [
  `cache`,
  `credentials`,
  `integrity`,
  `keepalive`,
  `mode`,
  `redirect`,
  `referrer`,
  `referrerPolicy`,
] as const

type CompatibleRequestOption = (typeof COMPATIBLE_REQUEST_OPTIONS)[number]

function getCompatibleRequestOptions(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Partial<Pick<RequestInit, CompatibleRequestOption>> {
  const options: Partial<Pick<RequestInit, CompatibleRequestOption>> = {}
  for (const option of COMPATIBLE_REQUEST_OPTIONS) {
    const initValue = init?.[option]
    if (initValue !== undefined) {
      options[option] = initValue as never
      continue
    }
    if (typeof Request !== `undefined` && input instanceof Request) {
      options[option] = input[option] as never
    }
  }
  return options
}

function requestHasBody(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): boolean {
  if (init?.body !== undefined && init.body !== null) return true
  return (
    typeof Request !== `undefined` &&
    input instanceof Request &&
    input.body !== null
  )
}

function isPrefetchSafeRequest(...args: Parameters<typeof fetch>): boolean {
  return (
    getRequestMethod(args[0], args[1]) === `GET` &&
    !requestHasBody(args[0], args[1])
  )
}

function getPrefetchKey(...args: Parameters<typeof fetch>): string {
  const headers = [...getRequestHeaders(args[0], args[1]).entries()]
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b))

  return JSON.stringify({
    url: getRequestUrl(args[0]),
    method: getRequestMethod(args[0], args[1]),
    headers,
    options: getCompatibleRequestOptions(args[0], args[1]),
  })
}

function getPrefetchInit(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  signal: AbortSignal
): RequestInit {
  return {
    ...getCompatibleRequestOptions(input, init),
    headers: getRequestHeaders(input, init),
    method: `GET`,
    signal,
  }
}

/**
 * In-order prefetch queue for chunk responses.
 * Maintains a bounded queue of speculative fetches and enforces FIFO consumption.
 */
export class PrefetchQueue {
  readonly #maxChunks: number
  readonly #fetchClient: typeof fetch
  readonly #queue = new Map<
    string,
    { promise: Promise<Response>; abort: AbortController }
  >()
  #headKey: string | null = null

  constructor(fetchClient: typeof fetch, maxChunks = 2) {
    this.#fetchClient = fetchClient
    this.#maxChunks = maxChunks
  }

  consume(...args: Parameters<typeof fetch>): Promise<Response> | undefined {
    const key = getPrefetchKey(...args)
    if (this.#headKey !== key) {
      // If the compatible request is in the queue but not at head, preserve ordering.
      if (!this.#queue.has(key)) {
        // Request not in queue at all — clear stale/incompatible prefetches.
        this.clear()
      }
      return undefined
    }
    const entry = this.#queue.get(key)
    if (!entry) return undefined
    this.#queue.delete(key)
    this.#headKey = null
    for (const queuedKey of this.#queue.keys()) {
      this.#headKey = queuedKey
      break
    }
    return entry.promise
  }

  prefetch(url: string, init?: RequestInit): void {
    const key = getPrefetchKey(url, init)
    if (this.#queue.has(key)) return
    if (this.#queue.size >= this.#maxChunks) return

    const abort = new AbortController()

    const promise = this.#fetchClient(
      url,
      getPrefetchInit(url, init, abort.signal)
    ).catch(() => new Response(null, { status: 502 }))

    this.#queue.set(key, { promise, abort })
    if (!this.#headKey) this.#headKey = key
  }

  clear(): void {
    for (const entry of this.#queue.values()) {
      entry.abort.abort(`prefetch-cleared`)
    }
    this.#queue.clear()
    this.#headKey = null
  }
}

/**
 * Creates a fetch client that speculatively prefetches the next chunk URL.
 * Only buffers GET requests. Non-GET requests pass through directly.
 */
export function createFetchWithChunkBuffer(
  fetchClient: typeof fetch,
  options?: { maxChunksToPrefetch?: number }
): typeof fetch {
  const queue = new PrefetchQueue(
    fetchClient,
    options?.maxChunksToPrefetch ?? 2
  )

  return async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const url = getRequestUrl(args[0])

    if (!isPrefetchSafeRequest(...args)) {
      queue.clear()
      return fetchClient(...args)
    }

    const prefetched = queue.consume(...args)
    const prefetchedResponse = prefetched ? await prefetched : undefined
    // Use prefetched response if available and successful, otherwise fetch fresh
    const response = prefetchedResponse?.ok
      ? prefetchedResponse
      : await fetchClient(...args)

    const requestUrl = new URL(url)
    const nextUrl = getNextChunkUrl(requestUrl, response)
    if (nextUrl) {
      queue.prefetch(nextUrl.toString(), {
        ...getCompatibleRequestOptions(args[0], args[1]),
        headers: getRequestHeaders(args[0], args[1]),
      })
    }

    return response
  }
}
