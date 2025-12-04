import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FetchBackoffAbortError, FetchError } from "../src/error"
import {
  BackoffDefaults,
  createFetchWithBackoff,
  createFetchWithConsumedBody,
  parseRetryAfterHeader,
} from "../src/fetch"
import type { Mock } from "vitest"

describe(`createFetchWithBackoff`, () => {
  const initialDelay = 10
  const maxDelay = 100
  let mockFetchClient: Mock<typeof fetch>

  beforeEach(() => {
    mockFetchClient = vi.fn()
  })

  it(`should return a successful response on the first attempt`, async () => {
    const mockResponse = new Response(null, { status: 200, statusText: `OK` })
    mockFetchClient.mockResolvedValue(mockResponse)

    const fetchWithBackoff = createFetchWithBackoff(mockFetchClient)

    const result = await fetchWithBackoff(`https://example.com`)

    expect(mockFetchClient).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result).toEqual(mockResponse)
  })

  it(`should retry the request on a 500 response and succeed after a retry`, async () => {
    const mockErrorResponse = new Response(null, { status: 500 })
    const mockSuccessResponse = new Response(null, {
      status: 200,
      statusText: `OK`,
    })
    mockFetchClient
      .mockResolvedValueOnce(mockErrorResponse)
      .mockResolvedValueOnce(mockSuccessResponse)

    const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
      ...BackoffDefaults,
      initialDelay,
    })

    const result = await fetchWithBackoff(`https://example.com`)

    expect(mockFetchClient).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
  })

  it(`should retry the request on a 429 response and succeed after a retry`, async () => {
    const mockErrorResponse = new Response(null, { status: 429 })
    const mockSuccessResponse = new Response(null, {
      status: 200,
      statusText: `OK`,
    })
    mockFetchClient
      .mockResolvedValueOnce(mockErrorResponse)
      .mockResolvedValueOnce(mockSuccessResponse)

    const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
      ...BackoffDefaults,
      initialDelay,
    })

    const result = await fetchWithBackoff(`https://example.com`)

    expect(mockFetchClient).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
  })

  it(`should apply exponential backoff and retry until maxDelay is reached`, async () => {
    const mockErrorResponse = new Response(null, { status: 500 })
    const mockSuccessResponse = new Response(null, {
      status: 200,
      statusText: `OK`,
    })
    mockFetchClient
      .mockResolvedValueOnce(mockErrorResponse)
      .mockResolvedValueOnce(mockErrorResponse)
      .mockResolvedValueOnce(mockErrorResponse)
      .mockResolvedValueOnce(mockSuccessResponse)

    const multiplier = 2

    const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
      initialDelay,
      maxDelay,
      multiplier,
    })

    const result = await fetchWithBackoff(`https://example.com`)

    expect(mockFetchClient).toHaveBeenCalledTimes(4)
    expect(result.ok).toBe(true)
  })

  it(`should stop retrying and throw an error on a 400 response`, async () => {
    const mockErrorResponse = new Response(null, {
      status: 400,
      statusText: `Bad Request`,
    })
    mockFetchClient.mockResolvedValue(mockErrorResponse)

    const fetchWithBackoff = createFetchWithBackoff(mockFetchClient)

    await expect(fetchWithBackoff(`https://example.com`)).rejects.toThrow(
      FetchError
    )
    expect(mockFetchClient).toHaveBeenCalledTimes(1)
  })

  it(`should throw FetchBackoffAbortError if the abort signal is triggered`, async () => {
    const mockAbortController = new AbortController()
    const signal = mockAbortController.signal
    const mockErrorResponse = new Response(null, { status: 500 })
    mockFetchClient.mockImplementation(
      () => new Promise((res) => setTimeout(() => res(mockErrorResponse), 10))
    )

    const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
      ...BackoffDefaults,
      initialDelay: 1000,
    })

    setTimeout(() => mockAbortController.abort(), 5)

    await expect(
      fetchWithBackoff(`https://example.com`, { signal })
    ).rejects.toThrow(FetchBackoffAbortError)

    expect(mockFetchClient).toHaveBeenCalledTimes(1)
  })

  it(`should not retry when a client error (4xx) occurs`, async () => {
    const mockErrorResponse = new Response(null, {
      status: 403,
      statusText: `Forbidden`,
    })
    mockFetchClient.mockResolvedValue(mockErrorResponse)

    const fetchWithBackoff = createFetchWithBackoff(
      mockFetchClient,
      BackoffDefaults
    )

    await expect(fetchWithBackoff(`https://example.com`)).rejects.toThrow(
      FetchError
    )
    expect(mockFetchClient).toHaveBeenCalledTimes(1)
  })

  it(`should honor retry-after header from 503 response`, async () => {
    const retryAfterSeconds = 1
    const mockErrorResponse = new Response(null, {
      status: 503,
      statusText: `Service Unavailable`,
      headers: new Headers({ "retry-after": `${retryAfterSeconds}` }),
    })
    const mockSuccessResponse = new Response(null, {
      status: 200,
      statusText: `OK`,
    })
    mockFetchClient
      .mockResolvedValueOnce(mockErrorResponse)
      .mockResolvedValueOnce(mockSuccessResponse)

    const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
      ...BackoffDefaults,
      initialDelay: 1, // Very short client delay
    })

    const startTime = Date.now()
    const result = await fetchWithBackoff(`https://example.com`)
    const elapsed = Date.now() - startTime

    // Should have waited at least retryAfterSeconds (minus small tolerance for test execution)
    expect(elapsed).toBeGreaterThanOrEqual(retryAfterSeconds * 1000 - 100)
    expect(mockFetchClient).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
  })

  it(`should stop retrying after maxRetries is reached`, async () => {
    const mockErrorResponse = new Response(null, { status: 500 })
    mockFetchClient.mockResolvedValue(mockErrorResponse)

    const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
      ...BackoffDefaults,
      initialDelay: 1,
      maxRetries: 3,
    })

    await expect(fetchWithBackoff(`https://example.com`)).rejects.toThrow(
      FetchError
    )
    // Initial attempt + 3 retries = 4 calls
    expect(mockFetchClient).toHaveBeenCalledTimes(4)
  })

  it(`should retry on network errors`, async () => {
    const networkError = new Error(`Network error`)
    const mockSuccessResponse = new Response(null, {
      status: 200,
      statusText: `OK`,
    })
    mockFetchClient
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(mockSuccessResponse)

    const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
      ...BackoffDefaults,
      initialDelay,
    })

    const result = await fetchWithBackoff(`https://example.com`)

    expect(mockFetchClient).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
  })
})

describe(`parseRetryAfterHeader`, () => {
  it(`should return 0 for undefined header`, () => {
    expect(parseRetryAfterHeader(undefined)).toBe(0)
  })

  it(`should return 0 for empty string`, () => {
    expect(parseRetryAfterHeader(``)).toBe(0)
  })

  it(`should parse delta-seconds format correctly`, () => {
    expect(parseRetryAfterHeader(`120`)).toBe(120_000) // 120 seconds = 120,000 ms
    expect(parseRetryAfterHeader(`1`)).toBe(1_000)
    expect(parseRetryAfterHeader(`60`)).toBe(60_000)
  })

  it(`should return 0 for invalid delta-seconds values`, () => {
    expect(parseRetryAfterHeader(`-10`)).toBe(0) // Negative values
    expect(parseRetryAfterHeader(`0`)).toBe(0) // Zero
    expect(parseRetryAfterHeader(`abc`)).toBe(0) // Non-numeric
  })

  it(`should parse HTTP-date format correctly`, () => {
    const futureDate = new Date(Date.now() + 30_000) // 30 seconds in the future
    const httpDate = futureDate.toUTCString()
    const result = parseRetryAfterHeader(httpDate)

    // Should be approximately 30 seconds, allow some tolerance for test execution time
    expect(result).toBeGreaterThan(29_000)
    expect(result).toBeLessThan(31_000)
  })

  it(`should handle clock skew for past dates`, () => {
    const pastDate = new Date(Date.now() - 10_000) // 10 seconds in the past
    const httpDate = pastDate.toUTCString()

    // Should clamp to 0 for past dates
    expect(parseRetryAfterHeader(httpDate)).toBe(0)
  })

  it(`should cap very large HTTP-date values at 1 hour`, () => {
    const farFutureDate = new Date(Date.now() + 7200_000) // 2 hours in the future
    const httpDate = farFutureDate.toUTCString()

    // Should be capped at 1 hour (3600000 ms)
    expect(parseRetryAfterHeader(httpDate)).toBe(3600_000)
  })

  it(`should return 0 for invalid HTTP-date format`, () => {
    expect(parseRetryAfterHeader(`not a date`)).toBe(0)
    expect(parseRetryAfterHeader(`2024-13-45`)).toBe(0) // Invalid date
  })

  it(`should handle edge case of very large delta-seconds`, () => {
    // Very large number (more than 1 hour worth of seconds)
    expect(parseRetryAfterHeader(`7200`)).toBe(7200_000) // 2 hours in ms (not capped in delta-seconds format)
  })

  it(`should handle decimal numbers in delta-seconds format`, () => {
    // HTTP spec requires delta-seconds to be integers, but parsing as Number allows decimals
    expect(parseRetryAfterHeader(`30.5`)).toBe(30_500)
  })
})

describe(`createFetchWithConsumedBody`, () => {
  let mockFetch: Mock<typeof fetch>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  // Note: Response constructor doesn't accept status < 200, so we can't test that edge case
  // The implementation handles it, but we can't create a valid mock Response with status 199

  it(`should return the original response for status codes with no body (201, 204, 205)`, async () => {
    const mockResponse = new Response(null, { status: 204 })
    mockFetch.mockResolvedValue(mockResponse)

    const enhancedFetch = createFetchWithConsumedBody(mockFetch)
    const result = await enhancedFetch(`http://example.com`)

    expect(result).toBe(mockResponse)
  })

  it(`should consume the body and return a new Response for successful status codes`, async () => {
    const mockBody = `response body`
    const mockResponse = new Response(mockBody, {
      status: 200,
      headers: { "content-type": `text/plain` },
    })
    mockFetch.mockResolvedValue(mockResponse)

    const enhancedFetch = createFetchWithConsumedBody(mockFetch)
    const result = await enhancedFetch(`http://example.com`)

    // Should be a different response object
    expect(result).not.toBe(mockResponse)
    expect(result.status).toBe(200)
    expect(await result.text()).toBe(mockBody)
  })

  it(`should preserve binary data integrity`, async () => {
    // Create binary data with non-UTF8 bytes
    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80])
    const mockResponse = new Response(binaryData, {
      status: 200,
      headers: { "content-type": `application/octet-stream` },
    })
    mockFetch.mockResolvedValue(mockResponse)

    const enhancedFetch = createFetchWithConsumedBody(mockFetch)
    const result = await enhancedFetch(`http://example.com`)

    const resultBuffer = await result.arrayBuffer()
    const resultBytes = new Uint8Array(resultBuffer)

    expect(resultBytes).toEqual(binaryData)
  })

  it(`should throw FetchBackoffAbortError when signal is already aborted and body read fails`, async () => {
    const abortController = new AbortController()
    abortController.abort() // Abort before the request

    // Mock a response where arrayBuffer throws (simulating abort during read)
    const mockResponse = {
      status: 200,
      arrayBuffer: vi.fn().mockRejectedValue(new Error(`aborted`)),
      headers: new Headers(),
    } as unknown as Response

    mockFetch.mockResolvedValue(mockResponse)

    const enhancedFetch = createFetchWithConsumedBody(mockFetch)

    await expect(
      enhancedFetch(`http://example.com`, { signal: abortController.signal })
    ).rejects.toThrow(FetchBackoffAbortError)
  })

  it(`should throw FetchError when reading body fails`, async () => {
    const mockResponse = {
      status: 200,
      arrayBuffer: vi.fn().mockRejectedValue(new Error(`Failed to read body`)),
      headers: new Headers({ "content-type": `text/plain` }),
    } as unknown as Response

    mockFetch.mockResolvedValue(mockResponse)

    const enhancedFetch = createFetchWithConsumedBody(mockFetch)

    await expect(enhancedFetch(`http://example.com`)).rejects.toThrow(
      FetchError
    )
  })
})
