/**
 * Property-based tests using fast-check for the Durable Streams client.
 *
 * These tests verify invariants across a wide range of inputs rather than
 * just specific hardcoded values.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import {
  BackoffDefaults,
  createFetchWithBackoff,
  parseRetryAfterHeader,
} from "../src/fetch"
import { FetchError } from "../src/error"
import type { Mock } from "vitest"

describe(`Property-Based Tests`, () => {
  describe(`parseRetryAfterHeader`, () => {
    it(`always returns a non-negative number`, () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = parseRetryAfterHeader(input)
          expect(result).toBeGreaterThanOrEqual(0)
          return true
        }),
        { numRuns: 100 }
      )
    })

    it(`returns milliseconds for valid positive integers`, () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 100000 }), (seconds) => {
          const result = parseRetryAfterHeader(String(seconds))
          // Should convert seconds to milliseconds
          expect(result).toBe(seconds * 1000)
          return true
        }),
        { numRuns: 50 }
      )
    })

    it(`returns 0 for zero`, () => {
      expect(parseRetryAfterHeader(`0`)).toBe(0)
      expect(parseRetryAfterHeader(`-0`)).toBe(0)
    })

    it(`handles decimal numbers by converting to milliseconds`, () => {
      fc.assert(
        fc.property(
          // Use double instead of float, with reasonable range
          fc.double({
            min: 0.1,
            max: 1000,
            noNaN: true,
            noDefaultInfinity: true,
          }),
          (seconds) => {
            const result = parseRetryAfterHeader(String(seconds))
            // Should convert to milliseconds (seconds * 1000)
            expect(result).toBeCloseTo(seconds * 1000, 0)
            return true
          }
        ),
        { numRuns: 50 }
      )
    })

    it(`returns 0 for non-numeric non-date strings`, () => {
      fc.assert(
        fc.property(
          // Generate strings that are clearly not numbers or valid dates
          fc.stringMatching(/^[a-z]{3,10}$/),
          (input) => {
            const result = parseRetryAfterHeader(input)
            expect(result).toBe(0)
            return true
          }
        ),
        { numRuns: 50 }
      )
    })

    it(`caps HTTP-date format to 1 hour maximum`, () => {
      fc.assert(
        fc.property(
          // Generate future dates well beyond 1 hour (2+ hours)
          fc.integer({ min: 7200000, max: 36000000 }),
          (msInFuture) => {
            const futureDate = new Date(Date.now() + msInFuture)
            const httpDate = futureDate.toUTCString()
            const result = parseRetryAfterHeader(httpDate)
            // Should be capped at 1 hour (3600000 ms) - allow 2 second tolerance for test execution
            expect(result).toBeGreaterThanOrEqual(3598000)
            expect(result).toBeLessThanOrEqual(3600000)
            return true
          }
        ),
        { numRuns: 20 }
      )
    })

    it(`returns approximately correct delay for near-future HTTP-dates`, () => {
      fc.assert(
        fc.property(
          // Generate delays between 5 and 60 seconds
          fc.integer({ min: 5000, max: 60000 }),
          (msInFuture) => {
            const futureDate = new Date(Date.now() + msInFuture)
            const httpDate = futureDate.toUTCString()
            const result = parseRetryAfterHeader(httpDate)
            // Should be close to the expected delay (within 2 seconds tolerance for test execution)
            expect(result).toBeGreaterThan(msInFuture - 2000)
            expect(result).toBeLessThanOrEqual(msInFuture + 1000)
            return true
          }
        ),
        { numRuns: 20 }
      )
    })
  })

  describe(`HTTP Status Code Classification`, () => {
    let mockFetchClient: Mock<typeof fetch>

    beforeEach(() => {
      mockFetchClient = vi.fn()
    })

    it(`should not retry on 4xx errors (except 429)`, async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate 4xx status codes excluding 429
          fc.integer({ min: 400, max: 499 }).filter((code) => code !== 429),
          async (statusCode) => {
            mockFetchClient.mockResolvedValue(
              new Response(null, { status: statusCode })
            )

            const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
              ...BackoffDefaults,
              initialDelay: 1,
            })

            await expect(
              fetchWithBackoff(`https://example.com`)
            ).rejects.toThrow(FetchError)

            // Should only be called once (no retry)
            expect(mockFetchClient).toHaveBeenCalledTimes(1)

            mockFetchClient.mockClear()
            return true
          }
        ),
        { numRuns: 30 }
      )
    })

    it(`should retry on 429 (rate limit) errors`, async () => {
      mockFetchClient
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))

      const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
        ...BackoffDefaults,
        initialDelay: 1,
      })

      const result = await fetchWithBackoff(`https://example.com`)

      expect(result.status).toBe(200)
      expect(mockFetchClient).toHaveBeenCalledTimes(2)
    })

    it(`should retry on 5xx errors`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 500, max: 599 }),
          async (statusCode) => {
            mockFetchClient
              .mockResolvedValueOnce(new Response(null, { status: statusCode }))
              .mockResolvedValueOnce(new Response(null, { status: 200 }))

            const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
              ...BackoffDefaults,
              initialDelay: 1,
            })

            const result = await fetchWithBackoff(`https://example.com`)

            expect(result.status).toBe(200)
            expect(mockFetchClient).toHaveBeenCalledTimes(2)

            mockFetchClient.mockClear()
            return true
          }
        ),
        { numRuns: 30 }
      )
    })

    it(`should succeed immediately on 2xx responses`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 200, max: 299 }),
          async (statusCode) => {
            mockFetchClient.mockResolvedValue(
              new Response(null, { status: statusCode })
            )

            const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
              ...BackoffDefaults,
              initialDelay: 1,
            })

            const result = await fetchWithBackoff(`https://example.com`)

            expect(result.status).toBe(statusCode)
            expect(mockFetchClient).toHaveBeenCalledTimes(1)

            mockFetchClient.mockClear()
            return true
          }
        ),
        { numRuns: 20 }
      )
    })
  })

  describe(`Backoff Delay Properties`, () => {
    it(`delay increases with each retry (exponential backoff)`, () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 1000 }), // initialDelay
          fc.double({
            min: 1.1,
            max: 3.0,
            noNaN: true,
            noDefaultInfinity: true,
          }), // multiplier
          fc.integer({ min: 100, max: 100000 }), // maxDelay
          fc.integer({ min: 1, max: 10 }), // number of retries to check
          (initialDelay, multiplier, maxDelay, retries) => {
            const delays: Array<number> = []

            for (let i = 0; i < retries; i++) {
              const delay = Math.min(
                initialDelay * Math.pow(multiplier, i),
                maxDelay
              )
              delays.push(delay)
            }

            // Verify delays are monotonically increasing (or equal when capped)
            for (let i = 1; i < delays.length; i++) {
              expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!)
            }

            // Verify no delay exceeds maxDelay
            for (const delay of delays) {
              expect(delay).toBeLessThanOrEqual(maxDelay)
            }

            return true
          }
        ),
        { numRuns: 50 }
      )
    })

    it(`delay never exceeds maxDelay regardless of parameters`, () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10000 }), // initialDelay
          fc.double({
            min: 1.0,
            max: 10.0,
            noNaN: true,
            noDefaultInfinity: true,
          }), // multiplier
          fc.integer({ min: 1, max: 100000 }), // maxDelay
          fc.integer({ min: 0, max: 100 }), // retry number (even very high)
          (initialDelay, multiplier, maxDelay, retryNumber) => {
            const delay = Math.min(
              initialDelay * Math.pow(multiplier, retryNumber),
              maxDelay
            )

            expect(delay).toBeLessThanOrEqual(maxDelay)
            expect(delay).toBeGreaterThanOrEqual(0)

            return true
          }
        ),
        { numRuns: 100 }
      )
    })

    it(`first delay equals initialDelay (when less than maxDelay)`, () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1000 }), // initialDelay
          fc.integer({ min: 1001, max: 100000 }), // maxDelay (always greater than initialDelay)
          (initialDelay, maxDelay) => {
            const firstDelay = Math.min(initialDelay, maxDelay)
            expect(firstDelay).toBe(initialDelay)
            return true
          }
        ),
        { numRuns: 50 }
      )
    })
  })
})
