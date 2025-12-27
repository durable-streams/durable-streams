/**
 * Tests for HTTP response compression
 *
 * These tests verify that the server correctly implements HTTP compression.
 * They use web-standard fetch() API for maximum compatibility.
 *
 * Note: Some raw byte verification tests are only run in Node.js environments
 * because browsers automatically decompress responses and strip Content-Encoding headers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "../src/server"

// Detect if we're in Node.js (for raw byte verification tests)
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
const isNode = typeof process !== `undefined` && !!process.versions?.node

/**
 * Make an HTTP request using fetch (web-compatible).
 * For Node.js, we also provide raw request capability for compression verification.
 */
async function webRequest(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
  } = {}
): Promise<{
  status: number
  headers: Headers
  text: () => Promise<string>
  json: () => Promise<unknown>
}> {
  const response = await fetch(url, {
    method: options.method ?? `GET`,
    headers: options.headers,
    body: options.body,
  })

  return {
    status: response.status,
    headers: response.headers,
    text: () => response.text(),
    json: () => response.json(),
  }
}

/**
 * Make a raw HTTP request without automatic decompression (Node.js only).
 * This allows us to verify the raw compressed response bytes.
 */
async function rawRequest(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
  } = {}
): Promise<{
  status: number
  headers: Record<string, string>
  body: Uint8Array
}> {
  if (!isNode) {
    throw new Error(`rawRequest is only available in Node.js`)
  }

  // Dynamic import for Node.js http module
  const { request: httpRequest } = await import(`node:http`)

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const req = httpRequest(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method ?? `GET`,
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Array<Uint8Array> = []
        res.on(`data`, (chunk: Buffer) => chunks.push(new Uint8Array(chunk)))
        res.on(`end`, () => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === `string`) {
              headers[key] = value
            } else if (Array.isArray(value)) {
              headers[key] = value[0]!
            }
          }

          // Concatenate chunks
          const totalLength = chunks.reduce((acc, c) => acc + c.length, 0)
          const body = new Uint8Array(totalLength)
          let offset = 0
          for (const chunk of chunks) {
            body.set(chunk, offset)
            offset += chunk.length
          }

          resolve({
            status: res.statusCode ?? 0,
            headers,
            body,
          })
        })
        res.on(`error`, reject)
      }
    )

    req.on(`error`, reject)

    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

/**
 * Decompress gzip data (Node.js only)
 */
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  if (!isNode) {
    throw new Error(`gunzip is only available in Node.js`)
  }
  const { gunzipSync } = await import(`node:zlib`)
  return new Uint8Array(gunzipSync(Buffer.from(data)))
}

/**
 * Decompress deflate data (Node.js only)
 */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (!isNode) {
    throw new Error(`inflate is only available in Node.js`)
  }
  const { inflateSync } = await import(`node:zlib`)
  return new Uint8Array(inflateSync(Buffer.from(data)))
}

describe(`Response Compression`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(() => {
    server.clear()
  })

  // Create a stream with enough data to trigger compression (> 1KB threshold)
  async function createLargeStream(path: string): Promise<void> {
    // Create stream
    await webRequest(`${baseUrl}${path}`, {
      method: `PUT`,
      headers: { "content-type": `application/json` },
    })

    // Append data larger than 1KB threshold
    const largeData = JSON.stringify({ data: `x`.repeat(2000) })
    await webRequest(`${baseUrl}${path}`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: largeData,
    })
  }

  describe(`gzip compression`, () => {
    it.runIf(isNode)(
      `should compress response with gzip when Accept-Encoding includes gzip`,
      async () => {
        await createLargeStream(`/test-gzip`)

        const response = await rawRequest(`${baseUrl}/test-gzip`, {
          method: `GET`,
          headers: { "accept-encoding": `gzip` },
        })

        expect(response.status).toBe(200)
        expect(response.headers[`content-encoding`]).toBe(`gzip`)
        expect(response.headers[`vary`]).toBe(`accept-encoding`)

        // Verify the response can be decompressed
        const decompressed = await gunzip(response.body)
        const json = JSON.parse(new TextDecoder().decode(decompressed))
        expect(json).toBeInstanceOf(Array)
        expect(json.length).toBe(1)
      }
    )

    it(`should return correct content when gzip compression is used (web-compatible)`, async () => {
      await createLargeStream(`/test-gzip-web`)

      // Use standard fetch - browser will auto-decompress
      const response = await webRequest(`${baseUrl}/test-gzip-web`, {
        method: `GET`,
        headers: { "accept-encoding": `gzip, deflate` },
      })

      expect(response.status).toBe(200)
      // Verify content is correctly decompressed
      const json = await response.json()
      expect(json).toBeInstanceOf(Array)
      expect((json as Array<unknown>).length).toBe(1)
    })

    it.runIf(isNode)(`should prefer gzip over deflate`, async () => {
      await createLargeStream(`/test-prefer-gzip`)

      const response = await rawRequest(`${baseUrl}/test-prefer-gzip`, {
        method: `GET`,
        headers: { "accept-encoding": `deflate, gzip` },
      })

      expect(response.status).toBe(200)
      expect(response.headers[`content-encoding`]).toBe(`gzip`)
    })
  })

  describe(`deflate compression`, () => {
    it.runIf(isNode)(
      `should compress response with deflate when Accept-Encoding only includes deflate`,
      async () => {
        await createLargeStream(`/test-deflate`)

        const response = await rawRequest(`${baseUrl}/test-deflate`, {
          method: `GET`,
          headers: { "accept-encoding": `deflate` },
        })

        expect(response.status).toBe(200)
        expect(response.headers[`content-encoding`]).toBe(`deflate`)
        expect(response.headers[`vary`]).toBe(`accept-encoding`)

        // Verify the response can be decompressed
        const decompressed = await inflate(response.body)
        const json = JSON.parse(new TextDecoder().decode(decompressed))
        expect(json).toBeInstanceOf(Array)
        expect(json.length).toBe(1)
      }
    )
  })

  describe(`no compression scenarios`, () => {
    it.runIf(isNode)(
      `should not compress when Accept-Encoding is not present`,
      async () => {
        await createLargeStream(`/test-no-header`)

        const response = await rawRequest(`${baseUrl}/test-no-header`, {
          method: `GET`,
          // No accept-encoding header
        })

        expect(response.status).toBe(200)
        expect(response.headers[`content-encoding`]).toBeUndefined()

        // Response should be valid JSON without decompression
        const json = JSON.parse(new TextDecoder().decode(response.body))
        expect(json).toBeInstanceOf(Array)
      }
    )

    it.runIf(isNode)(
      `should not compress when Accept-Encoding does not include gzip or deflate`,
      async () => {
        await createLargeStream(`/test-br-only`)

        const response = await rawRequest(`${baseUrl}/test-br-only`, {
          method: `GET`,
          headers: { "accept-encoding": `br` },
        })

        expect(response.status).toBe(200)
        expect(response.headers[`content-encoding`]).toBeUndefined()
      }
    )

    it.runIf(isNode)(
      `should not compress small responses below threshold`,
      async () => {
        // Create stream with small data (below 1KB threshold)
        await webRequest(`${baseUrl}/test-small`, {
          method: `PUT`,
          headers: { "content-type": `application/json` },
        })

        await webRequest(`${baseUrl}/test-small`, {
          method: `POST`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify({ small: `data` }),
        })

        const response = await rawRequest(`${baseUrl}/test-small`, {
          method: `GET`,
          headers: { "accept-encoding": `gzip` },
        })

        expect(response.status).toBe(200)
        // Small responses should not be compressed
        expect(response.headers[`content-encoding`]).toBeUndefined()

        const json = JSON.parse(new TextDecoder().decode(response.body))
        expect(json).toBeInstanceOf(Array)
      }
    )
  })

  describe(`compression option`, () => {
    it.runIf(isNode)(
      `should not compress when compression option is disabled`,
      async () => {
        // Create a server with compression disabled
        const noCompressionServer = new DurableStreamTestServer({
          port: 0,
          compression: false,
        })
        await noCompressionServer.start()
        const noCompressionUrl = noCompressionServer.url

        try {
          // Create stream with large data
          await webRequest(`${noCompressionUrl}/test-disabled`, {
            method: `PUT`,
            headers: { "content-type": `application/json` },
          })

          const largeData = JSON.stringify({ data: `x`.repeat(2000) })
          await webRequest(`${noCompressionUrl}/test-disabled`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: largeData,
          })

          const response = await rawRequest(
            `${noCompressionUrl}/test-disabled`,
            {
              method: `GET`,
              headers: { "accept-encoding": `gzip` },
            }
          )

          expect(response.status).toBe(200)
          // Compression should be disabled
          expect(response.headers[`content-encoding`]).toBeUndefined()

          const json = JSON.parse(new TextDecoder().decode(response.body))
          expect(json).toBeInstanceOf(Array)
        } finally {
          await noCompressionServer.stop()
        }
      }
    )
  })

  describe(`Accept-Encoding parsing`, () => {
    it.runIf(isNode)(
      `should handle Accept-Encoding with quality values`,
      async () => {
        await createLargeStream(`/test-quality`)

        const response = await rawRequest(`${baseUrl}/test-quality`, {
          method: `GET`,
          headers: { "accept-encoding": `gzip;q=1.0, deflate;q=0.5` },
        })

        expect(response.status).toBe(200)
        expect(response.headers[`content-encoding`]).toBe(`gzip`)
      }
    )

    it.runIf(isNode)(
      `should handle Accept-Encoding with extra whitespace`,
      async () => {
        await createLargeStream(`/test-whitespace`)

        const response = await rawRequest(`${baseUrl}/test-whitespace`, {
          method: `GET`,
          headers: { "accept-encoding": `  gzip  ,  deflate  ` },
        })

        expect(response.status).toBe(200)
        expect(response.headers[`content-encoding`]).toBe(`gzip`)
      }
    )
  })
})
