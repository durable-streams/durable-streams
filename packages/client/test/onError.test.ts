/**
 * Tests for onError handler behavior
 * Ported from Electric SQL client patterns
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { stream } from "../src/stream-api"
import { FetchError, MissingHeadersError } from "../src/error"

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

  it(`should apply headers returned by mid-stream onError on retry`, async () => {
    // First request succeeds (establishes the stream)
    // Second request fails with 401 (mid-stream error)
    // onError returns new headers
    // Third request succeeds with the new headers
    let callCount = 0
    mockFetch.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // First response — stream established, not yet up-to-date
        return new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
            "Stream-Cursor": `cursor1`,
          },
        })
      } else if (callCount === 2) {
        // Second request fails with 401
        return new Response(null, {
          status: 401,
          statusText: `Unauthorized`,
        })
      } else {
        // Third request succeeds with upToDate
        return new Response(JSON.stringify([{ id: 2 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `2`,
            "Stream-Cursor": `cursor2`,
            "Stream-Up-To-Date": `true`,
          },
        })
      }
    })

    const onError = vi.fn().mockResolvedValue({
      headers: { Authorization: `Bearer valid-token` },
    })

    const res = await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      headers: { Authorization: `Bearer expired-token` },
      live: `long-poll`,
      backoffOptions: { maxRetries: 0 },
      onError,
    })

    const items = await res.json()

    // onError was called for the mid-stream 401
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.any(FetchError))

    // Three requests: initial success, 401 failure, retry success
    expect(mockFetch).toHaveBeenCalledTimes(3)

    // Third request should include the new Authorization header
    const thirdCall = mockFetch.mock.calls[2]
    expect(thirdCall[1].headers).toMatchObject({
      Authorization: `Bearer valid-token`,
    })

    // Stream continued successfully after retry
    expect(items).toEqual([{ id: 1 }, { id: 2 }])
  })

  it(`should apply params returned by mid-stream onError on retry`, async () => {
    let callCount = 0
    mockFetch.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
            "Stream-Cursor": `cursor1`,
          },
        })
      } else if (callCount === 2) {
        return new Response(null, {
          status: 400,
          statusText: `Bad Request`,
        })
      } else {
        return new Response(JSON.stringify([{ id: 2 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `2`,
            "Stream-Cursor": `cursor2`,
            "Stream-Up-To-Date": `true`,
          },
        })
      }
    })

    const onError = vi.fn().mockResolvedValue({
      params: { tenant: `correct-tenant` },
    })

    const res = await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      params: { tenant: `wrong-tenant` },
      live: `long-poll`,
      backoffOptions: { maxRetries: 0 },
      onError,
    })

    const items = await res.json()

    expect(onError).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledTimes(3)

    // Third request should include the corrected param
    const thirdUrl = new URL(mockFetch.mock.calls[2][0])
    expect(thirdUrl.searchParams.get(`tenant`)).toBe(`correct-tenant`)

    expect(items).toEqual([{ id: 1 }, { id: 2 }])
  })

  it(`should not retry MissingHeadersError even if onError returns {}`, async () => {
    let callCount = 0
    mockFetch.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // First response succeeds — stream established, not yet up-to-date
        return new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
            "Stream-Cursor": `cursor1`,
          },
        })
      } else {
        // Second response is missing required headers (simulates proxy stripping)
        return new Response(JSON.stringify([{ id: 2 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
          },
        })
      }
    })

    const onError = vi.fn().mockResolvedValue({})

    const res = await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      live: `long-poll`,
      backoffOptions: { maxRetries: 0 },
      onError,
    })

    // Prevent unhandled rejection from res.closed
    res.closed.catch(() => {})

    // Reading the stream should fail with MissingHeadersError
    await expect(res.json()).rejects.toThrow(MissingHeadersError)

    // onError WAS called (for notification), but return value was ignored
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.any(MissingHeadersError))

    // Only 2 requests — no retry after MissingHeadersError
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
