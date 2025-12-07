/**
 * Test to verify the automatic transition from catch-up to live polling.
 * This specifically tests the default read() behavior.
 *
 * Default mode always uses long-poll after catch-up (SSE is only used when
 * explicitly requested with live: "sse") because SSE is harder to scale
 * with HTTP proxies.
 */

import { describe, expect, vi } from "vitest"
import { DurableStream } from "../src"
import { testWithStream, testWithTextStream } from "./support/test-context"
import { decode, encode } from "./support/test-helpers"

describe(`Catchup to Live Polling Transition`, () => {
  testWithStream(
    `should automatically transition from catchup to long-poll for binary streams`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      const capturedUrls: Array<string> = []

      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        const url =
          args[0] instanceof Request ? args[0].url : args[0].toString()
        capturedUrls.push(url)
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
      })

      const receivedData: Array<string> = []

      // Start reading with DEFAULT mode (no live option)
      const readPromise = (async () => {
        for await (const chunk of stream.read({ signal: aborter.signal })) {
          if (chunk.data.length > 0) {
            receivedData.push(decode(chunk.data))
          }

          // After receiving 2 data chunks, stop
          if (receivedData.length >= 2) {
            aborter.abort()
            break
          }
        }
      })()

      // Wait for initial catch-up request to complete
      await vi.waitFor(() =>
        expect(capturedUrls.length).toBeGreaterThanOrEqual(1)
      )

      // Verify first request was catch-up (no live param)
      expect(capturedUrls[0]).not.toContain(`live=`)

      // Append data while client should be in live polling mode
      store.append(streamPath, encode(`live-data-1`))

      // Wait for first live data to be received
      await vi.waitFor(() => expect(receivedData.length).toBe(1))

      // Check if transition happened to long-poll
      const sawLongPollRequest = capturedUrls.some((url) =>
        url.includes(`live=long-poll`)
      )

      // Append more data
      store.append(streamPath, encode(`live-data-2`))

      await readPromise

      // Verify we received the live data
      expect(receivedData).toContain(`live-data-1`)
      expect(receivedData).toContain(`live-data-2`)

      // Verify we saw long-poll request (transition happened)
      expect(sawLongPollRequest).toBe(true)
    }
  )

  testWithTextStream(
    `should automatically transition from catchup to long-poll for text streams (not SSE)`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      const capturedUrls: Array<string> = []

      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        const url =
          args[0] instanceof Request ? args[0].url : args[0].toString()
        capturedUrls.push(url)
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
      })

      const receivedData: Array<string> = []

      // Start reading with DEFAULT mode (no live option)
      const readPromise = (async () => {
        for await (const chunk of stream.read({ signal: aborter.signal })) {
          if (chunk.data.length > 0) {
            receivedData.push(decode(chunk.data))
          }

          // After receiving 1 data chunk, stop
          if (receivedData.length >= 1) {
            aborter.abort()
            break
          }
        }
      })()

      // Wait for initial catch-up request to complete
      await vi.waitFor(() =>
        expect(capturedUrls.length).toBeGreaterThanOrEqual(1)
      )

      // Verify first request was catch-up (no live param)
      expect(capturedUrls[0]).not.toContain(`live=`)

      // Append data while client should be in long-poll mode
      store.append(streamPath, encode(`live-data-1`))

      await readPromise

      // Verify we received the live data
      expect(receivedData).toContain(`live-data-1`)

      // Verify we saw long-poll request (NOT SSE) - SSE is only used when explicitly requested
      const sawLongPollRequest = capturedUrls.some((url) =>
        url.includes(`live=long-poll`)
      )
      const sawSSERequest = capturedUrls.some((url) => url.includes(`live=sse`))

      expect(sawLongPollRequest).toBe(true)
      expect(sawSSERequest).toBe(false)
    }
  )
})
