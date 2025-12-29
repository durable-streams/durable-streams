/**
 * Compression middleware for response compression (gzip, deflate).
 */

import { deflateSync, gzipSync } from "node:zlib"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Options for configuring compression middleware.
 */
export interface CompressionOptions {
  /**
   * Minimum response size (in bytes) to compress.
   * Responses smaller than this won't be compressed.
   * Default: 1024 (1KB)
   */
  threshold?: number
}

/**
 * Determine the best compression encoding from Accept-Encoding header.
 * Returns 'gzip', 'deflate', or null if no compression should be used.
 */
function getCompressionEncoding(
  acceptEncoding: string | undefined
): `gzip` | `deflate` | null {
  if (!acceptEncoding) return null

  // Parse Accept-Encoding header (e.g., "gzip, deflate, br" or "gzip;q=1.0, deflate;q=0.5")
  const encodings = acceptEncoding
    .toLowerCase()
    .split(`,`)
    .map((e) => e.trim())

  // Prefer gzip over deflate (better compression, wider support)
  for (const encoding of encodings) {
    const name = encoding.split(`;`)[0]?.trim()
    if (name === `gzip`) return `gzip`
  }
  for (const encoding of encodings) {
    const name = encoding.split(`;`)[0]?.trim()
    if (name === `deflate`) return `deflate`
  }

  return null
}

/**
 * Compress data using the specified encoding.
 */
function compressData(
  data: Uint8Array,
  encoding: `gzip` | `deflate`
): Uint8Array {
  if (encoding === `gzip`) {
    return gzipSync(data)
  } else {
    return deflateSync(data)
  }
}

/**
 * Middleware for compressing HTTP responses.
 * Supports gzip and deflate compression based on Accept-Encoding header.
 * Only compresses responses above the configured threshold size.
 */
export class CompressionMiddleware {
  private options: Required<CompressionOptions>

  constructor(options: CompressionOptions = {}) {
    this.options = {
      threshold: options.threshold ?? 1024,
    }
  }

  /**
   * Middleware handler.
   * Intercepts response writes to apply compression if appropriate.
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => Promise<void>
  ): Promise<void> {
    const acceptEncoding = req.headers[`accept-encoding`]
    const encoding = getCompressionEncoding(acceptEncoding)

    // If no compression support, pass through
    if (!encoding) {
      await next()
      return
    }

    // Store original end method
    const originalEnd = res.end.bind(res)
    let endCalled = false

    // Override res.end to intercept final data
    res.end = function (
      this: ServerResponse,
      chunk?: any,
      encodingOrCallback?: BufferEncoding | (() => void),
      callback?: () => void
    ): ServerResponse {
      if (endCalled) {
        return this
      }
      endCalled = true

      // Handle different overload signatures
      let data: Buffer | null = null
      let cb: (() => void) | undefined = undefined

      if (typeof chunk === `function`) {
        cb = chunk
      } else if (chunk !== undefined) {
        data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      }

      if (typeof encodingOrCallback === `function`) {
        cb = encodingOrCallback
      }

      if (typeof callback === `function`) {
        cb = callback
      }

      // Apply compression if data is large enough
      if (data && data.length >= options.threshold) {
        const compressed = compressData(new Uint8Array(data), encoding)

        // Set compression headers
        res.setHeader(`content-encoding`, encoding)
        res.setHeader(`content-length`, compressed.length)

        // Add Vary header if not already set
        const existingVary = res.getHeader(`vary`)
        if (!existingVary) {
          res.setHeader(`vary`, `accept-encoding`)
        } else if (
          typeof existingVary === `string` &&
          !existingVary.includes(`accept-encoding`)
        ) {
          res.setHeader(`vary`, `${existingVary}, accept-encoding`)
        }

        return originalEnd.call(this, compressed, cb)
      } else {
        // Data too small for compression or no data
        return originalEnd.call(this, data ?? undefined, cb)
      }
    }.bind(res)

    const options = this.options

    // Call next handler
    await next()
  }
}
