import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  STREAM_CLOSED_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "../src/constants"
import {
  FetchBackoffAbortError,
  FetchError,
  MissingHeadersError,
} from "../src/error"
import {
  BackoffDefaults,
  PrefetchQueue,
  createFetchWithBackoff,
  createFetchWithChunkBuffer,
  createFetchWithConsumedBody,
  createFetchWithResponseHeadersCheck,
  getNextChunkUrl,
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

describe(`createFetchWithResponseHeadersCheck`, () => {
  let mockFetch: Mock<typeof fetch>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it(`should pass through response when all required headers are present`, async () => {
    const mockResponse = new Response(`data`, {
      status: 200,
      headers: {
        [STREAM_OFFSET_HEADER]: `1`,
      },
    })
    mockFetch.mockResolvedValue(mockResponse)

    const checkedFetch = createFetchWithResponseHeadersCheck(mockFetch)
    const result = await checkedFetch(`http://example.com?offset=0`)

    expect(result).toBe(mockResponse)
    expect(result.status).toBe(200)
  })

  it(`should throw MissingHeadersError when Stream-Next-Offset is missing`, async () => {
    const mockResponse = new Response(`data`, {
      status: 200,
      headers: {},
    })
    mockFetch.mockResolvedValue(mockResponse)

    const checkedFetch = createFetchWithResponseHeadersCheck(mockFetch)

    await expect(checkedFetch(`http://example.com?offset=0`)).rejects.toThrow(
      MissingHeadersError
    )

    try {
      await checkedFetch(`http://example.com?offset=0`)
    } catch (err) {
      expect(err).toBeInstanceOf(MissingHeadersError)
      expect((err as MissingHeadersError).missingHeaders).toContain(
        STREAM_OFFSET_HEADER
      )
    }
  })

  it(`should throw when live + missing cursor + not closed`, async () => {
    const mockResponse = new Response(`data`, {
      status: 200,
      headers: {
        [STREAM_OFFSET_HEADER]: `1`,
      },
    })
    mockFetch.mockResolvedValue(mockResponse)

    const checkedFetch = createFetchWithResponseHeadersCheck(mockFetch)

    await expect(
      checkedFetch(`http://example.com?offset=0&live=long-poll`)
    ).rejects.toThrow(MissingHeadersError)

    try {
      await checkedFetch(`http://example.com?offset=0&live=long-poll`)
    } catch (err) {
      expect(err).toBeInstanceOf(MissingHeadersError)
      expect((err as MissingHeadersError).missingHeaders).toContain(
        STREAM_CURSOR_HEADER
      )
    }
  })

  it(`should NOT throw when live + missing cursor + Stream-Closed: true`, async () => {
    const mockResponse = new Response(`data`, {
      status: 200,
      headers: {
        [STREAM_OFFSET_HEADER]: `1`,
        [STREAM_CLOSED_HEADER]: `true`,
      },
    })
    mockFetch.mockResolvedValue(mockResponse)

    const checkedFetch = createFetchWithResponseHeadersCheck(mockFetch)
    const result = await checkedFetch(
      `http://example.com?offset=0&live=long-poll`
    )

    expect(result).toBe(mockResponse)
  })

  it(`should NOT throw on non-2xx responses`, async () => {
    const mockResponse = new Response(null, {
      status: 404,
    })
    mockFetch.mockResolvedValue(mockResponse)

    const checkedFetch = createFetchWithResponseHeadersCheck(mockFetch)
    const result = await checkedFetch(`http://example.com?offset=0`)

    expect(result).toBe(mockResponse)
    expect(result.status).toBe(404)
  })
})

describe(`getNextChunkUrl`, () => {
  it(`should return null when Stream-Closed is true`, () => {
    const requestUrl = new URL(`http://example.com?offset=0`)
    const response = new Response(null, {
      status: 200,
      headers: {
        [STREAM_CLOSED_HEADER]: `true`,
        [STREAM_OFFSET_HEADER]: `5`,
      },
    })
    expect(getNextChunkUrl(requestUrl, response)).toBeNull()
  })

  it(`should return null when Stream-Up-To-Date is present`, () => {
    const requestUrl = new URL(`http://example.com?offset=0`)
    const response = new Response(null, {
      status: 200,
      headers: {
        [STREAM_UP_TO_DATE_HEADER]: `true`,
        [STREAM_OFFSET_HEADER]: `5`,
      },
    })
    expect(getNextChunkUrl(requestUrl, response)).toBeNull()
  })

  it(`should return null on live requests`, () => {
    const requestUrl = new URL(`http://example.com?offset=0&live=long-poll`)
    const response = new Response(null, {
      status: 200,
      headers: {
        [STREAM_OFFSET_HEADER]: `5`,
      },
    })
    expect(getNextChunkUrl(requestUrl, response)).toBeNull()
  })

  it(`should return correct URL with updated offset and cursor`, () => {
    const requestUrl = new URL(`http://example.com?offset=0`)
    const response = new Response(null, {
      status: 200,
      headers: {
        [STREAM_OFFSET_HEADER]: `10`,
        [STREAM_CURSOR_HEADER]: `abc123`,
      },
    })
    const nextUrl = getNextChunkUrl(requestUrl, response)
    expect(nextUrl).not.toBeNull()
    expect(nextUrl!.searchParams.get(`offset`)).toBe(`10`)
    expect(nextUrl!.searchParams.get(`cursor`)).toBe(`abc123`)
  })

  it(`should return URL without cursor when cursor header is absent`, () => {
    const requestUrl = new URL(`http://example.com?offset=0`)
    const response = new Response(null, {
      status: 200,
      headers: {
        [STREAM_OFFSET_HEADER]: `10`,
      },
    })
    const nextUrl = getNextChunkUrl(requestUrl, response)
    expect(nextUrl).not.toBeNull()
    expect(nextUrl!.searchParams.get(`offset`)).toBe(`10`)
    expect(nextUrl!.searchParams.has(`cursor`)).toBe(false)
  })

  it(`should return null when offset header is missing`, () => {
    const requestUrl = new URL(`http://example.com?offset=0`)
    const response = new Response(null, {
      status: 200,
      headers: {},
    })
    expect(getNextChunkUrl(requestUrl, response)).toBeNull()
  })
})

describe(`PrefetchQueue`, () => {
  it(`should return undefined for unknown URL on consume`, () => {
    const mockFetch = vi.fn()
    const queue = new PrefetchQueue(mockFetch)
    expect(queue.consume(`http://example.com?offset=5`)).toBeUndefined()
  })

  it(`should prefetch and then consume the response`, async () => {
    const mockResponse = new Response(`data`, { status: 200 })
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(mockResponse)
    const queue = new PrefetchQueue(mockFetch)

    const url = `http://example.com?offset=5`
    queue.prefetch(url)
    const promise = queue.consume(url)
    expect(promise).toBeDefined()
    const result = await promise!
    expect(result).toBe(mockResponse)
  })

  it(`should enforce in-order consumption — consume(url2) when url1 is head returns undefined`, () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }))
    const queue = new PrefetchQueue(mockFetch, 3)

    const url1 = `http://example.com?offset=5`
    const url2 = `http://example.com?offset=10`
    queue.prefetch(url1)
    queue.prefetch(url2)

    expect(queue.consume(url2)).toBeUndefined()
    expect(queue.consume(url1)).toBeDefined()
    expect(queue.consume(url2)).toBeDefined()
  })

  it(`should abort all in-flight requests on clear`, () => {
    const abortSpy = vi.fn()
    const mockFetch = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      init?.signal?.addEventListener(`abort`, abortSpy)
      return new Promise(() => {})
    })
    const queue = new PrefetchQueue(mockFetch, 3)

    queue.prefetch(`http://example.com?offset=5`)
    queue.prefetch(`http://example.com?offset=10`)
    queue.clear()

    expect(abortSpy).toHaveBeenCalledTimes(2)
    expect(queue.consume(`http://example.com?offset=5`)).toBeUndefined()
  })

  it(`should respect maxChunks limit`, () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }))
    const queue = new PrefetchQueue(mockFetch, 2)

    queue.prefetch(`http://example.com?offset=5`)
    queue.prefetch(`http://example.com?offset=10`)
    queue.prefetch(`http://example.com?offset=15`)

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it(`should not duplicate prefetch for same URL`, () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }))
    const queue = new PrefetchQueue(mockFetch, 3)

    queue.prefetch(`http://example.com?offset=5`)
    queue.prefetch(`http://example.com?offset=5`)

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe(`createFetchWithChunkBuffer`, () => {
  it(`should pass through non-GET requests`, async () => {
    const mockResponse = new Response(`ok`, { status: 200 })
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(mockResponse)
    const bufferedFetch = createFetchWithChunkBuffer(mockFetch)

    const result = await bufferedFetch(`http://example.com`, {
      method: `POST`,
    })
    expect(result).toBe(mockResponse)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it(`should prefetch next chunk URL on successful GET`, async () => {
    const firstResponse = new Response(`data`, {
      status: 200,
      headers: {
        [STREAM_OFFSET_HEADER]: `10`,
        [STREAM_CURSOR_HEADER]: `cur1`,
      },
    })
    const secondResponse = new Response(`more`, {
      status: 200,
      headers: {
        [STREAM_OFFSET_HEADER]: `20`,
        [STREAM_UP_TO_DATE_HEADER]: `true`,
      },
    })
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse)

    const bufferedFetch = createFetchWithChunkBuffer(mockFetch)

    // Use URL with trailing slash to match new URL() normalization
    const result1 = await bufferedFetch(`http://example.com/?offset=0`)
    expect(result1).toBe(firstResponse)

    // The prefetch should have been triggered for offset=10
    // getNextChunkUrl builds the next URL from new URL(requestUrl), which
    // normalizes to include trailing slash. The prefetched URL is:
    // http://example.com/?offset=10&cursor=cur1
    const result2 = await bufferedFetch(
      `http://example.com/?offset=10&cursor=cur1`
    )
    expect(result2).toBe(secondResponse)

    // Only 2 fetch calls total (first + prefetch consumed as second)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it(`should not prefetch when stream is closed`, async () => {
    const closedResponse = new Response(`data`, {
      status: 200,
      headers: {
        [STREAM_OFFSET_HEADER]: `10`,
        [STREAM_CLOSED_HEADER]: `true`,
      },
    })
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(closedResponse)
    const bufferedFetch = createFetchWithChunkBuffer(mockFetch)

    await bufferedFetch(`http://example.com/?offset=0`)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// Group 2: Prefetch bug tests (should FAIL — exposing bugs)
// ============================================================================

describe(`PrefetchQueue error handling bugs`, () => {
  // EXPECTED TO FAIL — exposes bug #5
  // When a prefetched request fails (network error), the consumer receives a
  // synthetic 599 response that gets fed into header validation, causing
  // MissingHeadersError instead of falling back to a fresh fetch.
  it(`prefetch network error should not produce synthetic 599 response`, async () => {
    const mockFetch = vi.fn<typeof fetch>()

    const queue = new PrefetchQueue(mockFetch)

    // Prefetch will fail with network error
    mockFetch.mockRejectedValueOnce(new Error(`network error`))
    const targetUrl = `http://example.com/?offset=10&cursor=cur1`
    queue.prefetch(targetUrl)

    // Consume the prefetched response
    const promise = queue.consume(targetUrl)
    expect(promise).toBeDefined()
    const result = await promise!

    // BUG: PrefetchQueue.prefetch() has `.catch(() => new Response(null, { status: 599 }))`
    // This means a network error gets turned into a synthetic 599 response.
    // When this response is fed into createFetchWithResponseHeadersCheck,
    // it triggers MissingHeadersError because 599 >= 200 && < 300 is false
    // (so actually 599 bypasses the header check), but the caller sees
    // a non-ok response with status 599 which is unexpected.
    //
    // Expected: The queue should not mask errors as synthetic responses.
    expect(result.status).not.toBe(599)
  })

  // EXPECTED TO FAIL — exposes bug #6
  // When consume() is called with a URL that doesn't match the head of the queue,
  // the stale prefetched responses should be cleared/aborted.
  it(`consume with mismatched URL should clear stale prefetches`, () => {
    const abortSpy = vi.fn()
    const mockFetch = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      init?.signal?.addEventListener(`abort`, abortSpy)
      return new Promise(() => {})
    })

    const queue = new PrefetchQueue(mockFetch, 3)

    queue.prefetch(`http://example.com/?offset=5`)
    queue.prefetch(`http://example.com/?offset=10`)

    // Consume a completely different URL
    const result = queue.consume(`http://example.com/?offset=99`)

    // BUG: consume() returns undefined without clearing the queue.
    // The in-flight prefetches for offset=5 and offset=10 remain active,
    // wasting bandwidth and potentially returning stale data later.
    expect(result).toBeUndefined()
    // The stale prefetches should have been aborted
    expect(abortSpy).toHaveBeenCalledTimes(2)
  })
})
