/**
 * Shared utility functions for the Durable Streams client.
 */

import { STREAM_CLOSED_HEADER, STREAM_OFFSET_HEADER } from "./constants"
import { DurableStreamError, StreamClosedError } from "./error"
import type { HeadersRecord, MaybePromise } from "./types"

/**
 * Resolve headers from HeadersRecord (supports async functions).
 * Unified implementation used by both stream() and DurableStream.
 */
export async function resolveHeaders(
  headers?: HeadersRecord
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {}

  if (!headers) {
    return resolved
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === `function`) {
      resolved[key] = await value()
    } else {
      resolved[key] = value
    }
  }

  return resolved
}

/**
 * Handle error responses from the server.
 * Throws appropriate DurableStreamError based on status code.
 */
export async function handleErrorResponse(
  response: Response,
  url: string,
  context?: { operation?: string }
): Promise<never> {
  const status = response.status

  if (status === 404) {
    throw new DurableStreamError(`Stream not found: ${url}`, `NOT_FOUND`, 404)
  }

  if (status === 409) {
    // Check if this is a stream closed error
    const streamClosedHeader = response.headers.get(STREAM_CLOSED_HEADER)
    if (streamClosedHeader?.toLowerCase() === `true`) {
      const finalOffset =
        response.headers.get(STREAM_OFFSET_HEADER) ?? undefined
      throw new StreamClosedError(url, finalOffset)
    }

    // Context-specific 409 messages
    const message =
      context?.operation === `create`
        ? `Stream already exists: ${url}`
        : `Sequence conflict: seq is lower than last appended`
    const code =
      context?.operation === `create` ? `CONFLICT_EXISTS` : `CONFLICT_SEQ`
    throw new DurableStreamError(message, code, 409)
  }

  if (status === 400) {
    throw new DurableStreamError(
      `Bad request (possibly content-type mismatch)`,
      `BAD_REQUEST`,
      400
    )
  }

  throw await DurableStreamError.fromResponse(response, url)
}

/**
 * Resolve params from ParamsRecord (supports async functions).
 */
export async function resolveParams(
  params?: Record<string, string | (() => MaybePromise<string>) | undefined>
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {}

  if (!params) {
    return resolved
  }

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      if (typeof value === `function`) {
        resolved[key] = await value()
      } else {
        resolved[key] = value
      }
    }
  }

  return resolved
}

/**
 * Resolve a value that may be a function returning a promise.
 */
export async function resolveValue<T>(
  value: T | (() => MaybePromise<T>)
): Promise<T> {
  if (typeof value === `function`) {
    return (value as () => MaybePromise<T>)()
  }
  return value
}

// Module-level Set to track origins we've already warned about (prevents log spam)
const warnedOrigins = new Set<string>()

/**
 * Safely read NODE_ENV without triggering "process is not defined" errors.
 * Works in both browser and Node.js environments.
 */
function getNodeEnvSafely(): string | undefined {
  if (typeof process === `undefined`) return undefined
  // Use optional chaining for process.env in case it's undefined (e.g., in some bundler environments)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return process.env?.NODE_ENV
}

/**
 * Check if we're in a browser environment.
 */
function isBrowserEnvironment(): boolean {
  return typeof globalThis.window !== `undefined`
}

/**
 * Get window.location.href safely, returning undefined if not available.
 */
function getWindowLocationHref(): string | undefined {
  if (
    typeof globalThis.window !== `undefined` &&
    typeof globalThis.window.location !== `undefined`
  ) {
    return globalThis.window.location.href
  }
  return undefined
}

/**
 * Resolve a URL string, handling relative URLs in browser environments.
 * Returns undefined if the URL cannot be parsed.
 */
function resolveUrlMaybe(urlString: string): URL | undefined {
  try {
    // First try parsing as an absolute URL
    return new URL(urlString)
  } catch {
    // If that fails and we're in a browser, try resolving as relative URL
    const base = getWindowLocationHref()
    if (base) {
      try {
        return new URL(urlString, base)
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

/**
 * Warn if using HTTP (not HTTPS) URL in a browser environment.
 * HTTP typically limits browsers to ~6 concurrent connections per origin under HTTP/1.1,
 * which can cause slow streams and app freezes with multiple active streams.
 *
 * Features:
 * - Warns only once per origin to prevent log spam
 * - Handles relative URLs by resolving against window.location.href
 * - Safe to call in Node.js environments (no-op)
 * - Skips warning during tests (NODE_ENV=test)
 */
export function warnIfUsingHttpInBrowser(
  url: string | URL,
  warnOnHttp?: boolean
): void {
  // Skip warning if explicitly disabled
  if (warnOnHttp === false) return

  // Skip warning during tests
  const nodeEnv = getNodeEnvSafely()
  if (nodeEnv === `test`) {
    return
  }

  // Only warn in browser environments
  if (
    !isBrowserEnvironment() ||
    typeof console === `undefined` ||
    typeof console.warn !== `function`
  ) {
    return
  }

  // Parse the URL (handles both absolute and relative URLs)
  const urlStr = url instanceof URL ? url.toString() : url
  const parsedUrl = resolveUrlMaybe(urlStr)

  if (!parsedUrl) {
    // Could not parse URL - silently skip
    return
  }

  // Check if URL uses HTTP protocol
  if (parsedUrl.protocol === `http:`) {
    // Only warn once per origin
    if (!warnedOrigins.has(parsedUrl.origin)) {
      warnedOrigins.add(parsedUrl.origin)
      console.warn(
        `[DurableStream] Using HTTP (not HTTPS) typically limits browsers to ~6 concurrent connections per origin under HTTP/1.1. ` +
          `This can cause slow streams and app freezes with multiple active streams. ` +
          `Use HTTPS for HTTP/2 support. See https://electric-sql.com/r/electric-http2 for more information.`
      )
    }
  }
}

/**
 * Reset the HTTP warning state. Only exported for testing purposes.
 * @internal
 */
export function _resetHttpWarningForTesting(): void {
  warnedOrigins.clear()
}
