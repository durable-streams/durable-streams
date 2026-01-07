/**
 * Tests for Response metadata properties (headers, status, ok, isLoading)
 * Verifies they align with fetch() Response behavior and update correctly
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { stream } from "../src/stream-api"

describe(`StreamResponse metadata`, () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  describe(`headers`, () => {
    it(`should expose response headers from first response`, async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
            etag: `abc123`,
            "cache-control": `max-age=60`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(res.headers.get(`etag`)).toBe(`abc123`)
      expect(res.headers.get(`cache-control`)).toBe(`max-age=60`)
      expect(res.headers.get(`content-type`)).toBe(`application/json`)
    })

    it(`should update headers on subsequent responses (long-poll)`, async () => {
      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(
            new Response(JSON.stringify([{ id: 1 }]), {
              status: 200,
              headers: {
                "content-type": `application/json`,
                "Stream-Next-Offset": `1`,
                etag: `first-etag`,
                "x-custom": `first-value`,
              },
            })
          )
        }
        return Promise.resolve(
          new Response(JSON.stringify([{ id: 2 }]), {
            status: 200,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": `2`,
              "Stream-Up-To-Date": `true`,
              etag: `second-etag`,
              "x-custom": `second-value`,
            },
          })
        )
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
      })

      // Initial headers
      expect(res.headers.get(`etag`)).toBe(`first-etag`)
      expect(res.headers.get(`x-custom`)).toBe(`first-value`)

      // Consume to trigger next request
      const reader = res.jsonStream().getReader()
      await reader.read() // First item

      // Headers should now reflect second response
      expect(res.headers.get(`etag`)).toBe(`second-etag`)
      expect(res.headers.get(`x-custom`)).toBe(`second-value`)

      reader.releaseLock()
      res.cancel()
    })

    it(`should be a Headers object (like fetch Response)`, async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(res.headers).toBeInstanceOf(Headers)
      expect(res.headers.has(`content-type`)).toBe(true)
    })
  })

  describe(`status and statusText`, () => {
    it(`should expose HTTP status from first response`, async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          statusText: `OK`,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(res.status).toBe(200)
      expect(res.statusText).toBe(`OK`)
    })

    it(`should update status on subsequent responses`, async () => {
      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(
            new Response(JSON.stringify([{ id: 1 }]), {
              status: 200,
              statusText: `OK`,
              headers: {
                "content-type": `application/json`,
                "Stream-Next-Offset": `1`,
              },
            })
          )
        }
        // Second response with different status (still 2xx range)
        return Promise.resolve(
          new Response(JSON.stringify([{ id: 2 }]), {
            status: 206,
            statusText: `Partial Content`,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": `2`,
              "Stream-Up-To-Date": `true`,
            },
          })
        )
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
      })

      expect(res.status).toBe(200)
      expect(res.statusText).toBe(`OK`)

      // Consume to trigger next request
      const reader = res.jsonStream().getReader()
      await reader.read()

      expect(res.status).toBe(206)
      expect(res.statusText).toBe(`Partial Content`)

      reader.releaseLock()
      res.cancel()
    })
  })

  describe(`ok`, () => {
    it(`should be true for successful responses`, async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(res.ok).toBe(true)
    })

    it(`should always be true for active streams (errors are thrown)`, async () => {
      // stream() throws on non-OK responses, so we never get a StreamResponse with ok=false
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 201,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(res.ok).toBe(true)
      expect(res.status).toBe(201)
    })

    it(`should update ok flag on subsequent responses`, async () => {
      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        const status = callCount === 1 ? 200 : 201
        return Promise.resolve(
          new Response(JSON.stringify([{ id: callCount }]), {
            status,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": String(callCount),
              ...(callCount === 2 && { "Stream-Up-To-Date": `true` }),
            },
          })
        )
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
      })

      expect(res.ok).toBe(true)
      expect(res.status).toBe(200)

      const reader = res.jsonStream().getReader()
      await reader.read()

      expect(res.ok).toBe(true)
      expect(res.status).toBe(201)

      reader.releaseLock()
      res.cancel()
    })
  })

  describe(`isLoading`, () => {
    it(`should be false after stream() resolves`, async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      // stream() is async and awaits first response, so isLoading is false
      expect(res.isLoading).toBe(false)
    })

    it(`should remain false during streaming`, async () => {
      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        return Promise.resolve(
          new Response(JSON.stringify([{ id: callCount }]), {
            status: 200,
            headers: {
              "content-type": `application/json`,
              "Stream-Next-Offset": String(callCount),
              ...(callCount === 2 && { "Stream-Up-To-Date": `true` }),
            },
          })
        )
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
      })

      expect(res.isLoading).toBe(false)

      const reader = res.jsonStream().getReader()
      await reader.read()

      // Still false after consuming data
      expect(res.isLoading).toBe(false)

      reader.releaseLock()
      res.cancel()
    })
  })

  describe(`integration with consumption methods`, () => {
    it(`should expose headers during json() accumulation`, async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
            "Stream-Up-To-Date": `true`,
            etag: `test-etag`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(res.headers.get(`etag`)).toBe(`test-etag`)
      expect(res.status).toBe(200)

      const items = await res.json()
      expect(items).toHaveLength(2)

      // Metadata still accessible after consumption
      expect(res.headers.get(`etag`)).toBe(`test-etag`)
    })

    it(`should expose headers for bodyStream consumption`, async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
            "Stream-Up-To-Date": `true`,
            "x-request-id": `abc-123`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(res.headers.get(`x-request-id`)).toBe(`abc-123`)
      expect(res.status).toBe(200)

      // Consume via bodyStream
      const reader = res.bodyStream().getReader()
      const { value } = await reader.read()
      expect(value).toBeInstanceOf(Uint8Array)

      // Headers still accessible
      expect(res.headers.get(`x-request-id`)).toBe(`abc-123`)

      reader.releaseLock()
      res.cancel()
    })
  })
})
