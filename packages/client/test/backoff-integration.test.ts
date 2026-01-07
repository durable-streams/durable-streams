/**
 * Tests for backoff integration
 * Verifies backoffOptions are respected and integrate with onError
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { stream } from "../src/stream-api"
import { DurableStream } from "../src/stream"
import { FetchError } from "../src/error"

describe(`backoff integration`, () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  it(`should respect custom backoffOptions`, async () => {
    let attempts = 0
    mockFetch.mockImplementation(() => {
      attempts++
      return Promise.resolve(
        new Response(null, {
          status: 500,
          statusText: `Internal Server Error`,
        })
      )
    })

    const maxRetries = 3

    await expect(
      stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        backoffOptions: {
          maxRetries,
          initialDelay: 1,
          maxDelay: 10,
          multiplier: 1.1,
        },
      })
    ).rejects.toThrow(FetchError)

    // Should try initial + maxRetries times
    expect(attempts).toBe(maxRetries + 1)
  })

  it(`should call onError after backoff exhausts for 5xx errors`, async () => {
    mockFetch.mockResolvedValue(
      new Response(null, {
        status: 500,
        statusText: `Internal Server Error`,
      })
    )

    const onError = vi.fn().mockResolvedValue(undefined)

    await expect(
      stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        backoffOptions: {
          maxRetries: 2,
          initialDelay: 1,
          maxDelay: 10,
          multiplier: 1.1,
        },
        onError,
      })
    ).rejects.toThrow()

    // onError should be called after backoff exhausts
    expect(onError).toHaveBeenCalledOnce()
    // Should have tried initial + maxRetries times before calling onError
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it(`should NOT retry 4xx errors with backoff (calls onError immediately)`, async () => {
    mockFetch.mockResolvedValue(
      new Response(null, {
        status: 400,
        statusText: `Bad Request`,
      })
    )

    const onError = vi.fn().mockResolvedValue(undefined)

    await expect(
      stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        backoffOptions: {
          maxRetries: 5, // Should not retry 4xx
          initialDelay: 1,
          maxDelay: 10,
          multiplier: 1.1,
        },
        onError,
      })
    ).rejects.toThrow()

    // onError called immediately, no backoff retries for 4xx
    expect(onError).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it(`should retry 429 rate limit errors with backoff`, async () => {
    let attempts = 0
    mockFetch.mockImplementation(() => {
      attempts++
      return Promise.resolve(
        new Response(null, {
          status: 429,
          statusText: `Too Many Requests`,
        })
      )
    })

    await expect(
      stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        backoffOptions: {
          maxRetries: 2,
          initialDelay: 1,
          maxDelay: 10,
          multiplier: 1.1,
        },
      })
    ).rejects.toThrow()

    // Should retry 429 errors
    expect(attempts).toBe(3) // initial + 2 retries
  })

  it(`should use handle-level backoffOptions for stream() reads`, async () => {
    let attempts = 0
    mockFetch.mockImplementation(() => {
      attempts++
      return Promise.resolve(
        new Response(null, {
          status: 500,
          statusText: `Internal Server Error`,
        })
      )
    })

    const handle = new DurableStream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      backoffOptions: {
        maxRetries: 2,
        initialDelay: 1,
        maxDelay: 10,
        multiplier: 1.1,
      },
    })

    await expect(handle.stream()).rejects.toThrow()

    // Should use handle's backoffOptions
    expect(attempts).toBe(3) // initial + 2 retries
  })

  it(`should disable retries when maxRetries is 0`, async () => {
    mockFetch.mockResolvedValue(
      new Response(null, {
        status: 500,
        statusText: `Internal Server Error`,
      })
    )

    await expect(
      stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        backoffOptions: {
          maxRetries: 0,
          initialDelay: 0,
          maxDelay: 0,
          multiplier: 1,
        },
      })
    ).rejects.toThrow()

    // Should only try once
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it(`should respect Retry-After header`, async () => {
    const startTime = Date.now()
    let attempts = 0

    mockFetch.mockImplementation(() => {
      attempts++
      if (attempts === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 429,
            statusText: `Too Many Requests`,
            headers: {
              "Retry-After": `1`, // 1 second
            },
          })
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )
    })

    await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      backoffOptions: {
        maxRetries: 5,
        initialDelay: 1,
        maxDelay: 1000,
        multiplier: 1.1,
      },
    })

    const elapsed = Date.now() - startTime

    // Should have waited at least 1 second (Retry-After header)
    expect(elapsed).toBeGreaterThanOrEqual(1000)
    expect(attempts).toBe(2)
  })

  it(`should allow onError to recover after backoff exhausts`, async () => {
    let attempts = 0
    mockFetch.mockImplementation(() => {
      attempts++
      // Fail twice, then succeed
      if (attempts <= 2) {
        return Promise.resolve(
          new Response(null, {
            status: 500,
            statusText: `Internal Server Error`,
          })
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1`,
          },
        })
      )
    })

    const onError = vi.fn().mockResolvedValue({})

    const res = await stream({
      url: `https://example.com/stream`,
      fetch: mockFetch,
      backoffOptions: {
        maxRetries: 1, // Only 1 retry via backoff
        initialDelay: 1,
        maxDelay: 10,
        multiplier: 1.1,
      },
      onError,
    })

    // Backoff should try twice (initial + 1 retry)
    // Then onError retries once more, succeeds
    expect(attempts).toBe(3)
    expect(onError).toHaveBeenCalledOnce()
    expect(res.url).toBe(`https://example.com/stream`)
  })

  it(`should handle network errors with backoff`, async () => {
    let attempts = 0
    mockFetch.mockImplementation(() => {
      attempts++
      return Promise.reject(new Error(`Network error`))
    })

    const onError = vi.fn().mockResolvedValue(undefined)

    await expect(
      stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        backoffOptions: {
          maxRetries: 2,
          initialDelay: 1,
          maxDelay: 10,
          multiplier: 1.1,
        },
        onError,
      })
    ).rejects.toThrow(`Network error`)

    // Should retry network errors
    expect(attempts).toBe(3) // initial + 2 retries
    expect(onError).toHaveBeenCalledOnce()
  })
})
