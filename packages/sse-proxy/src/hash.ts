/**
 * Request hashing utilities for generating deterministic stream paths.
 */

import type { RequestHasher } from "./types"

/**
 * Headers that should be included in the hash (case-insensitive).
 * These headers typically affect the response content.
 */
const HASH_INCLUDE_HEADERS = new Set([
  `authorization`,
  `x-api-key`,
  `x-user-id`,
  `x-tenant-id`,
  `x-session-id`,
  `cookie`,
  `accept-language`,
])

/**
 * Convert an ArrayBuffer to a URL-safe base64 string.
 */
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ``
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  // Convert to base64 and make URL-safe
  return btoa(binary).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``)
}

/**
 * Hash a string using SHA-256 and return a URL-safe base64 string.
 */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest(`SHA-256`, data)
  return arrayBufferToBase64Url(hashBuffer)
}

/**
 * Extract headers to include in the hash from a Headers object or record.
 */
function extractRelevantHeaders(
  headers: HeadersInit | undefined
): Record<string, string> {
  const result: Record<string, string> = {}

  if (!headers) {
    return result
  }

  const processEntry = (key: string, value: string) => {
    const lowerKey = key.toLowerCase()
    if (HASH_INCLUDE_HEADERS.has(lowerKey)) {
      result[lowerKey] = value
    }
  }

  if (headers instanceof Headers) {
    headers.forEach((value, key) => processEntry(key, value))
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      processEntry(key, value)
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      processEntry(key, value)
    }
  }

  return result
}

/**
 * Create a canonical string representation of the request for hashing.
 * The format is: method|url|sorted_headers|body_hash
 */
async function createCanonicalRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<string> {
  let url: string
  let method: string
  let headers: HeadersInit | undefined
  let body: BodyInit | null | undefined

  if (input instanceof URL) {
    url = input.toString()
    method = init?.method ?? `GET`
    headers = init?.headers
    body = init?.body
  } else if (input instanceof Request) {
    url = input.url
    method = input.method
    headers = input.headers
    // Note: We can't read the body from a Request without consuming it
    // So we rely on init.body if provided
    body = init?.body
  } else {
    // String URL
    url = input
    method = init?.method ?? `GET`
    headers = init?.headers
    body = init?.body
  }

  // Normalize URL - remove trailing slashes, lowercase host
  const normalizedUrl = new URL(url)
  // Keep pathname as-is but normalize the URL format
  const canonicalUrl = `${normalizedUrl.protocol}//${normalizedUrl.host}${normalizedUrl.pathname}${normalizedUrl.search}`

  // Extract and sort relevant headers
  const relevantHeaders = extractRelevantHeaders(headers)
  const sortedHeaderKeys = Object.keys(relevantHeaders).sort()
  const headerString = sortedHeaderKeys
    .map((key) => `${key}:${relevantHeaders[key]}`)
    .join(`|`)

  // Hash the body if present
  let bodyHash = ``
  if (body) {
    const bodyString =
      typeof body === `string`
        ? body
        : body instanceof ArrayBuffer
          ? new TextDecoder().decode(body)
          : body instanceof Uint8Array
            ? new TextDecoder().decode(body)
            : JSON.stringify(body)
    bodyHash = await sha256(bodyString)
  }

  return `${method.toUpperCase()}|${canonicalUrl}|${headerString}|${bodyHash}`
}

/**
 * Default request hasher that creates a deterministic hash from request properties.
 *
 * The hash includes:
 * - HTTP method
 * - Full URL (normalized)
 * - Relevant headers (authorization, cookies, tenant IDs, etc.)
 * - Body content (hashed)
 *
 * @param input - Request URL or Request object
 * @param init - Request init options
 * @returns A URL-safe hash string suitable for use as a stream path
 */
export const defaultHashRequest: RequestHasher = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<string> => {
  const canonicalRequest = await createCanonicalRequest(input, init)
  const hash = await sha256(canonicalRequest)
  // Return a shorter hash (first 16 chars = 96 bits, still very collision-resistant)
  return hash.slice(0, 16)
}

/**
 * Create a custom request hasher that includes additional properties.
 *
 * @param additionalHeaders - Additional header names to include in the hash
 * @returns A RequestHasher function
 */
export function createRequestHasher(
  additionalHeaders: Array<string>
): RequestHasher {
  const customHeaders = new Set([
    ...HASH_INCLUDE_HEADERS,
    ...additionalHeaders.map((h) => h.toLowerCase()),
  ])

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    // Temporarily modify the set for this hash
    const originalHeaders = HASH_INCLUDE_HEADERS
    try {
      // Add custom headers
      for (const header of customHeaders) {
        HASH_INCLUDE_HEADERS.add(header)
      }
      return defaultHashRequest(input, init)
    } finally {
      // Restore original headers
      HASH_INCLUDE_HEADERS.clear()
      for (const header of originalHeaders) {
        HASH_INCLUDE_HEADERS.add(header)
      }
    }
  }
}
