/**
 * Tests for onError handler behavior
 * Ported from Electric SQL client patterns
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { stream } from "../src/stream-api"
import { FetchError } from "../src/error"
import { STREAM_OFFSET_HEADER } from "../src/constants"

describe(`onError handler`, () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  it(`should retry on error if error handler returns empty object`, async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          statusText: `Unauthorized`,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

    const onError = vi.fn().mockResolvedValue({})

    const res = await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      headers: { Authorization: `Bearer initial-token` },
      backoffOptions: { maxRetries: 0 }, // Disable backoff retries
      onError,
    })

    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.any(FetchError))
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(res.url).toBe(`https://example.com/stream`)
  })

  it(`should retry with modified headers from error handler`, async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          statusText: `Unauthorized`,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

    const onError = vi.fn().mockResolvedValue({
      headers: { Authorization: `Bearer refreshed-token` },
    })

    await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      headers: { Authorization: `Bearer expired-token` },
      backoffOptions: { maxRetries: 0 },
      onError,
    })

    expect(onError).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Second call should have refreshed token
    const secondCall = mockFetch.mock.calls[1]
    expect(secondCall[1].headers).toMatchObject({
      Authorization: `Bearer refreshed-token`,
    })
  })

  it(`should retry with modified params from error handler`, async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 400,
          statusText: `Bad Request`,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

    const onError = vi.fn().mockResolvedValue({
      params: { tenant: `valid-tenant` },
    })

    await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      params: { tenant: `invalid-tenant` },
      backoffOptions: { maxRetries: 0 },
      onError,
    })

    expect(onError).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Second call should have updated param
    const firstUrl = new URL(mockFetch.mock.calls[0][0])
    const secondUrl = new URL(mockFetch.mock.calls[1][0])
    expect(firstUrl.searchParams.get(`tenant`)).toBe(`invalid-tenant`)
    expect(secondUrl.searchParams.get(`tenant`)).toBe(`valid-tenant`)
  })

  it(`should preserve headers when onError returns only params`, async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 400,
          statusText: `Bad Request`,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

    const onError = vi.fn().mockResolvedValue({
      params: { fix: `applied` },
    })

    await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      headers: { "X-Custom-Header": `should-be-preserved` },
      params: { tenant: `abc` },
      backoffOptions: { maxRetries: 0 },
      onError,
    })

    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Both calls should have the custom header
    expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
      "X-Custom-Header": `should-be-preserved`,
    })
    expect(mockFetch.mock.calls[1][1].headers).toMatchObject({
      "X-Custom-Header": `should-be-preserved`,
    })
  })

  it(`should preserve params when onError returns only headers`, async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          statusText: `Unauthorized`,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

    const onError = vi.fn().mockResolvedValue({
      headers: { Authorization: `Bearer new-token` },
    })

    await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      headers: { Authorization: `Bearer old-token` },
      params: { tenant: `abc`, important: `param` },
      backoffOptions: { maxRetries: 0 },
      onError,
    })

    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Both calls should have the params
    const firstUrl = new URL(mockFetch.mock.calls[0][0])
    const secondUrl = new URL(mockFetch.mock.calls[1][0])
    expect(firstUrl.searchParams.get(`tenant`)).toBe(`abc`)
    expect(firstUrl.searchParams.get(`important`)).toBe(`param`)
    expect(secondUrl.searchParams.get(`tenant`)).toBe(`abc`)
    expect(secondUrl.searchParams.get(`important`)).toBe(`param`)
  })

  it(`should stop retrying if error handler returns void`, async () => {
    mockFetch.mockResolvedValue(
      new Response(null, {
        status: 401,
        statusText: `Unauthorized`,
      })
    )

    const onError = vi.fn().mockResolvedValue(undefined)

    await expect(
      stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        backoffOptions: { maxRetries: 0 },
        onError,
      })
    ).rejects.toThrow(FetchError)

    expect(onError).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it(`should support async error handler`, async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          statusText: `Unauthorized`,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

    const refreshToken = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return `Bearer fresh-token`
    }

    const onError = vi.fn().mockImplementation(async () => {
      const token = await refreshToken()
      return { headers: { Authorization: token } }
    })

    await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      headers: { Authorization: `Bearer stale-token` },
      backoffOptions: { maxRetries: 0 },
      onError,
    })

    expect(onError).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[1][1].headers).toMatchObject({
      Authorization: `Bearer fresh-token`,
    })
  })

  it(`should not call onError if no error occurs`, async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "content-type": `application/json`,
          "Stream-Next-Offset": `1`,
        },
      })
    )

    const onError = vi.fn()

    await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      onError,
    })

    expect(onError).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it(`should propagate error if no onError handler provided`, async () => {
    mockFetch.mockResolvedValue(
      new Response(null, {
        status: 401,
        statusText: `Unauthorized`,
      })
    )

    await expect(
      stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        backoffOptions: { maxRetries: 0 },
      })
    ).rejects.toThrow(FetchError)

    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it(`should call onError for 4xx client errors`, async () => {
    const statuses = [400, 401, 403, 404]

    for (const status of statuses) {
      mockFetch.mockReset()
      const onError = vi.fn().mockResolvedValue(undefined)

      mockFetch.mockResolvedValue(
        new Response(null, {
          status,
          statusText: `Client Error`,
        })
      )

      await expect(
        stream({
          url: `https://example.com/stream`,
          fetch: mockFetch,
          backoffOptions: { maxRetries: 0 },
          onError,
        })
      ).rejects.toThrow()

      expect(onError).toHaveBeenCalledOnce()
    }
  })

  it(`should merge returned params with existing ones`, async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 400,
          statusText: `Bad Request`,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

    const onError = vi.fn().mockResolvedValue({
      params: { override: `new-value` },
    })

    await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      params: { override: `old-value`, keep: `this` },
      backoffOptions: { maxRetries: 0 },
      onError,
    })

    const secondUrl = new URL(mockFetch.mock.calls[1][0])
    expect(secondUrl.searchParams.get(`override`)).toBe(`new-value`)
    expect(secondUrl.searchParams.get(`keep`)).toBe(`this`)
  })

  it(`should merge returned headers with existing ones`, async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          statusText: `Unauthorized`,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )

    const onError = vi.fn().mockResolvedValue({
      headers: { Authorization: `Bearer new` },
    })

    await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      headers: { Authorization: `Bearer old`, "X-Keep": `this` },
      backoffOptions: { maxRetries: 0 },
      onError,
    })

    expect(mockFetch.mock.calls[1][1].headers).toMatchObject({
      Authorization: `Bearer new`,
      "X-Keep": `this`,
    })
  })

  describe(`SSE reconnection`, () => {
    /**
     * Helper to create a SSE response body from event text.
     */
    function createSSEBody(sseText: string): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder()
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseText))
          controller.close()
        },
      })
    }

    it(`should invoke onError during SSE reconnection on 401`, async () => {
      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++

        if (callCount === 1) {
          // Initial SSE connection succeeds with data
          return new Response(
            createSSEBody(
              `event: data\ndata: [{"msg":"hello"}]\n\nevent: control\ndata: {"streamNextOffset":"1_20","streamCursor":"c1"}\n\n`
            ),
            {
              status: 200,
              headers: {
                "content-type": `text/event-stream`,
                [STREAM_OFFSET_HEADER]: `0_0`,
              },
            }
          )
        }

        if (callCount === 2) {
          // SSE reconnection fails with 401 (token expired)
          return new Response(`Unauthorized`, {
            status: 401,
            statusText: `Unauthorized`,
          })
        }

        // After onError refreshes token, SSE reconnection succeeds
        // Use streamClosed to stop further reconnections
        return new Response(
          createSSEBody(
            `event: control\ndata: {"streamNextOffset":"1_20","streamCursor":"c1","upToDate":true,"streamClosed":true}\n\n`
          ),
          {
            status: 200,
            headers: {
              "content-type": `text/event-stream`,
              [STREAM_OFFSET_HEADER]: `1_20`,
            },
          }
        )
      })

      const onError = vi.fn().mockResolvedValue({
        headers: { Authorization: `Bearer refreshed-token` },
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `sse`,
        json: true,
        headers: { Authorization: `Bearer expired-token` },
        backoffOptions: { maxRetries: 0 },
        onError,
        sseResilience: { minConnectionDuration: 0 },
      })

      // Consume via subscribeJson to trigger SSE processing and reconnection
      const unsub = res.subscribeJson(() => {})

      // Wait for stream to close (streamClosed in final response)
      await res.closed

      // onError should have been called once during SSE reconnection
      expect(onError).toHaveBeenCalledOnce()
      expect(onError).toHaveBeenCalledWith(expect.any(FetchError))

      // The refreshed token should have been used in the third request
      expect(mockFetch.mock.calls[2][1].headers).toMatchObject({
        Authorization: `Bearer refreshed-token`,
      })

      unsub()
    })

    it(`should propagate error during SSE reconnection when onError returns void`, async () => {
      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++

        if (callCount === 1) {
          return new Response(
            createSSEBody(
              `event: data\ndata: [{"msg":"hello"}]\n\nevent: control\ndata: {"streamNextOffset":"1_20","streamCursor":"c1"}\n\n`
            ),
            {
              status: 200,
              headers: {
                "content-type": `text/event-stream`,
                [STREAM_OFFSET_HEADER]: `0_0`,
              },
            }
          )
        }

        // SSE reconnection fails with 401
        return new Response(`Unauthorized`, {
          status: 401,
          statusText: `Unauthorized`,
        })
      })

      // onError returns undefined (stop retrying)
      const onError = vi.fn().mockResolvedValue(undefined)

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `sse`,
        json: true,
        backoffOptions: { maxRetries: 0 },
        onError,
        sseResilience: { minConnectionDuration: 0 },
      })

      // Start consuming so SSE reconnection is triggered
      res.subscribeJson(() => {})

      // The stream should error out via the closed promise
      await expect(res.closed).rejects.toThrow()
      expect(onError).toHaveBeenCalledOnce()
    })

    it(`should propagate error during SSE reconnection when no onError handler`, async () => {
      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++

        if (callCount === 1) {
          return new Response(
            createSSEBody(
              `event: data\ndata: [{"msg":"hello"}]\n\nevent: control\ndata: {"streamNextOffset":"1_20","streamCursor":"c1"}\n\n`
            ),
            {
              status: 200,
              headers: {
                "content-type": `text/event-stream`,
                [STREAM_OFFSET_HEADER]: `0_0`,
              },
            }
          )
        }

        return new Response(`Unauthorized`, {
          status: 401,
          statusText: `Unauthorized`,
        })
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `sse`,
        json: true,
        backoffOptions: { maxRetries: 0 },
        sseResilience: { minConnectionDuration: 0 },
      })

      // Start consuming so SSE reconnection is triggered
      res.subscribeJson(() => {})

      // Without onError, error should propagate and close the stream
      await expect(res.closed).rejects.toThrow()
    })
  })
})
