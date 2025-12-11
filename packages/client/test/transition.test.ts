/**
 * Test to verify the automatic transition from catch-up to live polling.
 * This specifically tests the stream() with live: "auto" behavior.
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

      const handle = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
      })

      const receivedData: Array<string> = []

      // Start reading with live: "auto" mode (auto transition to long-poll)
      const readPromise = (async () => {
        const response = await handle.stream({
          signal: aborter.signal,
          live: `auto`,
        })
        for await (const chunk of response.byteChunks()) {
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

      // Verify first request was catch-up (no live param or auto mode)
      // The new API sends live=auto in the query params

      // Append data while client should be in live polling mode
      store.append(streamPath, encode(`live-data-1`))

      // Wait for first live data to be received
      await vi.waitFor(() => expect(receivedData.length).toBe(1))

      // Append more data
      store.append(streamPath, encode(`live-data-2`))

      await readPromise

      // Verify we received the live data
      expect(receivedData).toContain(`live-data-1`)
      expect(receivedData).toContain(`live-data-2`)
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

      const handle = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
      })

      const receivedData: Array<string> = []

      // Start reading with live: "auto" mode
      const readPromise = (async () => {
        const response = await handle.stream({
          signal: aborter.signal,
          live: `auto`,
        })
        for await (const chunk of response.byteChunks()) {
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

      // Append data while client should be in long-poll mode
      store.append(streamPath, encode(`live-data-1`))

      await readPromise

      // Verify we received the live data
      expect(receivedData).toContain(`live-data-1`)

      // Verify we didn't see SSE requests - SSE is only used when explicitly requested
      const sawSSERequest = capturedUrls.some((url) => url.includes(`live=sse`))
      expect(sawSSERequest).toBe(false)
    }
  )
})
