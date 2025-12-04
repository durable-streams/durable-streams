/**
 * Fetch utilities with retry and backoff support.
 * Based on @electric-sql/client patterns.
 */

import { FetchBackoffAbortError, FetchError } from "./error"

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
  initialDelay: 100,
  maxDelay: 60_000, // Cap at 60s
  multiplier: 1.3,
  maxRetries: Infinity, // Retry forever by default
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

          // Wait for the calculated duration
          await new Promise((resolve) => setTimeout(resolve, waitMs))

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
