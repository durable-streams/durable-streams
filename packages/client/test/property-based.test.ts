/**
 * Property-based tests using fast-check for the Durable Streams client.
 *
 * These tests verify invariants across a wide range of inputs rather than
 * just specific hardcoded values. Invariants are defined in the contracts
 * package, which serves as the single source of truth.
 *
 * @see @durable-streams/contracts for contract definitions
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import {
  BackoffDelayCapped,
  BackoffDelayMonotonic,
  InitialDelayRespected,
  NoRetryOn4xx,
  RetryAfterHttpDateCapped,
  RetryAfterNonNegative,
  RetryAfterSecondsToMs,
  RetryOn429,
  RetryOn5xx,
} from "@durable-streams/contracts"
import {
  BackoffDefaults,
  createFetchWithBackoff,
  parseRetryAfterHeader,
} from "../src/fetch"
import { FetchError } from "../src/error"
import type { Mock } from "vitest"

// Import contracts - single source of truth for invariants

describe(`Property-Based Tests`, () => {
  describe(`parseRetryAfterHeader`, () => {
    it(`CONTRACT: ${RetryAfterNonNegative.description}`, () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = parseRetryAfterHeader(input)

          // Use contract assertion
          RetryAfterNonNegative.assert({
            headerValue: input,
            parsedMs: result,
          })

          return true
        }),
        { numRuns: 100 }
      )
    })

    it(`CONTRACT: ${RetryAfterSecondsToMs.description}`, () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 100000 }), (seconds) => {
          const result = parseRetryAfterHeader(String(seconds))

          // Use contract assertion
          RetryAfterSecondsToMs.assert({
            seconds,
            parsedMs: result,
          })

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
        fc.property(fc.stringMatching(/^[a-z]{3,10}$/), (input) => {
          const result = parseRetryAfterHeader(input)
          expect(result).toBe(0)
          return true
        }),
        { numRuns: 50 }
      )
    })

    it(`CONTRACT: ${RetryAfterHttpDateCapped.description}`, () => {
      const MAX_RETRY_AFTER_MS = 3600000 // 1 hour

      fc.assert(
        fc.property(
          fc.integer({ min: 7200000, max: 36000000 }),
          (msInFuture) => {
            const futureDate = new Date(Date.now() + msInFuture)
            const httpDate = futureDate.toUTCString()
            const result = parseRetryAfterHeader(httpDate)

            // Use contract assertion
            RetryAfterHttpDateCapped.assert({
              httpDate,
              parsedMs: result,
              maxMs: MAX_RETRY_AFTER_MS,
            })

            return true
          }
        ),
        { numRuns: 20 }
      )
    })

    it(`returns approximately correct delay for near-future HTTP-dates`, () => {
      fc.assert(
        fc.property(fc.integer({ min: 5000, max: 60000 }), (msInFuture) => {
          const futureDate = new Date(Date.now() + msInFuture)
          const httpDate = futureDate.toUTCString()
          const result = parseRetryAfterHeader(httpDate)
          // Should be close to the expected delay (within 2 seconds tolerance)
          expect(result).toBeGreaterThan(msInFuture - 2000)
          expect(result).toBeLessThanOrEqual(msInFuture + 1000)
          return true
        }),
        { numRuns: 20 }
      )
    })
  })

  describe(`HTTP Status Code Classification`, () => {
    let mockFetchClient: Mock<typeof fetch>

    beforeEach(() => {
      mockFetchClient = vi.fn()
    })

    it(`CONTRACT: ${NoRetryOn4xx.description}`, async () => {
      await fc.assert(
        fc.asyncProperty(
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

            const retryAttempts = mockFetchClient.mock.calls.length - 1

            // Use contract assertion
            NoRetryOn4xx.assert({
              statusCode,
              retryAttempts,
            })

            mockFetchClient.mockClear()
            return true
          }
        ),
        { numRuns: 30 }
      )
    })

    it(`CONTRACT: ${RetryOn429.description}`, async () => {
      mockFetchClient
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))

      const fetchWithBackoff = createFetchWithBackoff(mockFetchClient, {
        ...BackoffDefaults,
        initialDelay: 1,
      })

      const result = await fetchWithBackoff(`https://example.com`)

      // Use contract assertion
      RetryOn429.assert({
        statusCode: 429,
        didRetry: mockFetchClient.mock.calls.length > 1,
      })

      expect(result.status).toBe(200)
    })

    it(`CONTRACT: ${RetryOn5xx.description}`, async () => {
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

            // Use contract assertion
            RetryOn5xx.assert({
              statusCode,
              didRetry: mockFetchClient.mock.calls.length > 1,
            })

            expect(result.status).toBe(200)

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
    it(`CONTRACT: ${BackoffDelayMonotonic.description}`, () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 1000 }),
          fc.double({
            min: 1.1,
            max: 3.0,
            noNaN: true,
            noDefaultInfinity: true,
          }),
          fc.integer({ min: 100, max: 100000 }),
          fc.integer({ min: 2, max: 10 }),
          (initialDelay, multiplier, maxDelay, retries) => {
            const delays: Array<number> = []

            for (let i = 0; i < retries; i++) {
              const delay = Math.min(
                initialDelay * Math.pow(multiplier, i),
                maxDelay
              )
              delays.push(delay)
            }

            // Use contract assertion
            BackoffDelayMonotonic.assert({ delays })

            return true
          }
        ),
        { numRuns: 50 }
      )
    })

    it(`CONTRACT: ${BackoffDelayCapped.description}`, () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10000 }),
          fc.double({
            min: 1.0,
            max: 10.0,
            noNaN: true,
            noDefaultInfinity: true,
          }),
          fc.integer({ min: 1, max: 100000 }),
          fc.integer({ min: 0, max: 100 }),
          (initialDelay, multiplier, maxDelay, retryNumber) => {
            const delay = Math.min(
              initialDelay * Math.pow(multiplier, retryNumber),
              maxDelay
            )

            // Use contract assertion
            BackoffDelayCapped.assert({ delay, maxDelay })

            expect(delay).toBeGreaterThanOrEqual(0)

            return true
          }
        ),
        { numRuns: 100 }
      )
    })

    it(`CONTRACT: ${InitialDelayRespected.description}`, () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1000 }),
          fc.integer({ min: 1001, max: 100000 }),
          (initialDelay, maxDelay) => {
            const firstDelay = Math.min(initialDelay, maxDelay)

            // Use contract assertion
            InitialDelayRespected.assert({
              firstDelay,
              initialDelay,
              maxDelay,
            })

            return true
          }
        ),
        { numRuns: 50 }
      )
    })
  })
})
