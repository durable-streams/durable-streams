/**
 * Tests for HTTP response compression
 */

import { request as httpRequest } from "node:http"
import { gunzipSync, inflateSync } from "node:zlib"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "../src/server"

/**
 * Make an HTTP request without automatic decompression.
 * This allows us to verify the raw compressed response.
 */
function rawRequest(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
  } = {}
): Promise<{
  status: number
  headers: Record<string, string>
  body: Buffer
}> {
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
        const chunks: Array<Buffer> = []
        res.on(`data`, (chunk) => chunks.push(chunk))
        res.on(`end`, () => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === `string`) {
              headers[key] = value
            } else if (Array.isArray(value)) {
              headers[key] = value[0]
            }
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks),
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
    await rawRequest(`${baseUrl}${path}`, {
      method: `PUT`,
      headers: { "content-type": `application/json` },
    })

    // Append data larger than 1KB threshold
    const largeData = JSON.stringify({ data: `x`.repeat(2000) })
    await rawRequest(`${baseUrl}${path}`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: largeData,
    })
  }

  describe(`gzip compression`, () => {
    it(`should compress response with gzip when Accept-Encoding includes gzip`, async () => {
      await createLargeStream(`/test-gzip`)

      const response = await rawRequest(`${baseUrl}/test-gzip`, {
        method: `GET`,
        headers: { "accept-encoding": `gzip` },
      })

      expect(response.status).toBe(200)
      expect(response.headers[`content-encoding`]).toBe(`gzip`)
      expect(response.headers[`vary`]).toBe(`accept-encoding`)

      // Verify the response can be decompressed
      const decompressed = gunzipSync(response.body)
      const json = JSON.parse(decompressed.toString())
      expect(json).toBeInstanceOf(Array)
      expect(json.length).toBe(1)
    })

    it(`should prefer gzip over deflate`, async () => {
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
    it(`should compress response with deflate when Accept-Encoding only includes deflate`, async () => {
      await createLargeStream(`/test-deflate`)

      const response = await rawRequest(`${baseUrl}/test-deflate`, {
        method: `GET`,
        headers: { "accept-encoding": `deflate` },
      })

      expect(response.status).toBe(200)
      expect(response.headers[`content-encoding`]).toBe(`deflate`)
      expect(response.headers[`vary`]).toBe(`accept-encoding`)

      // Verify the response can be decompressed
      const decompressed = inflateSync(response.body)
      const json = JSON.parse(decompressed.toString())
      expect(json).toBeInstanceOf(Array)
      expect(json.length).toBe(1)
    })
  })

  describe(`no compression scenarios`, () => {
    it(`should not compress when Accept-Encoding is not present`, async () => {
      await createLargeStream(`/test-no-header`)

      const response = await rawRequest(`${baseUrl}/test-no-header`, {
        method: `GET`,
        // No accept-encoding header
      })

      expect(response.status).toBe(200)
      expect(response.headers[`content-encoding`]).toBeUndefined()

      // Response should be valid JSON without decompression
      const json = JSON.parse(response.body.toString())
      expect(json).toBeInstanceOf(Array)
    })

    it(`should not compress when Accept-Encoding does not include gzip or deflate`, async () => {
      await createLargeStream(`/test-br-only`)

      const response = await rawRequest(`${baseUrl}/test-br-only`, {
        method: `GET`,
        headers: { "accept-encoding": `br` },
      })

      expect(response.status).toBe(200)
      expect(response.headers[`content-encoding`]).toBeUndefined()
    })

    it(`should not compress small responses below threshold`, async () => {
      // Create stream with small data (below 1KB threshold)
      await rawRequest(`${baseUrl}/test-small`, {
        method: `PUT`,
        headers: { "content-type": `application/json` },
      })

      await rawRequest(`${baseUrl}/test-small`, {
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

      const json = JSON.parse(response.body.toString())
      expect(json).toBeInstanceOf(Array)
    })
  })

  describe(`compression option`, () => {
    it(`should not compress when compression option is disabled`, async () => {
      // Create a server with compression disabled
      const noCompressionServer = new DurableStreamTestServer({
        port: 0,
        compression: false,
      })
      await noCompressionServer.start()
      const noCompressionUrl = noCompressionServer.url

      try {
        // Create stream with large data
        await rawRequest(`${noCompressionUrl}/test-disabled`, {
          method: `PUT`,
          headers: { "content-type": `application/json` },
        })

        const largeData = JSON.stringify({ data: `x`.repeat(2000) })
        await rawRequest(`${noCompressionUrl}/test-disabled`, {
          method: `POST`,
          headers: { "content-type": `application/json` },
          body: largeData,
        })

        const response = await rawRequest(`${noCompressionUrl}/test-disabled`, {
          method: `GET`,
          headers: { "accept-encoding": `gzip` },
        })

        expect(response.status).toBe(200)
        // Compression should be disabled
        expect(response.headers[`content-encoding`]).toBeUndefined()

        const json = JSON.parse(response.body.toString())
        expect(json).toBeInstanceOf(Array)
      } finally {
        await noCompressionServer.stop()
      }
    })
  })

  describe(`Accept-Encoding parsing`, () => {
    it(`should handle Accept-Encoding with quality values`, async () => {
      await createLargeStream(`/test-quality`)

      const response = await rawRequest(`${baseUrl}/test-quality`, {
        method: `GET`,
        headers: { "accept-encoding": `gzip;q=1.0, deflate;q=0.5` },
      })

      expect(response.status).toBe(200)
      expect(response.headers[`content-encoding`]).toBe(`gzip`)
    })

    it(`should handle Accept-Encoding with extra whitespace`, async () => {
      await createLargeStream(`/test-whitespace`)

      const response = await rawRequest(`${baseUrl}/test-whitespace`, {
        method: `GET`,
        headers: { "accept-encoding": `  gzip  ,  deflate  ` },
      })

      expect(response.status).toBe(200)
      expect(response.headers[`content-encoding`]).toBe(`gzip`)
    })
  })
})
