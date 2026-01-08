import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { STREAM_OFFSET_HEADER, STREAM_UP_TO_DATE_HEADER, stream } from "../src"
import type { Mock } from "vitest"

/**
 * Tests for page visibility handling (pause/resume syncing).
 */
describe(`visibility handling`, () => {
  let mockFetch: Mock<typeof fetch>
  let mockHidden: boolean
  let addEventListenerSpy: Mock
  let removeEventListenerSpy: Mock
  let visibilityHandler: (() => void) | null

  beforeEach(() => {
    mockFetch = vi.fn()
    mockHidden = false
    visibilityHandler = null

    addEventListenerSpy = vi.fn((event: string, handler: () => void) => {
      if (event === `visibilitychange`) {
        visibilityHandler = handler
      }
    })

    removeEventListenerSpy = vi.fn((event: string) => {
      if (event === `visibilitychange`) {
        visibilityHandler = null
      }
    })

    // Mock document globally
    vi.stubGlobal(`document`, {
      get hidden() {
        return mockHidden
      },
      addEventListener: addEventListenerSpy,
      removeEventListener: removeEventListenerSpy,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /**
   * Helper to simulate visibility change
   */
  function simulateVisibilityChange(hidden: boolean): void {
    mockHidden = hidden
    visibilityHandler?.()
  }

  describe(`pause abort classification`, () => {
    it(`should not close stream when paused via visibility change`, async () => {
      // First response - successful
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      // Second request - will be aborted by pause
      let secondFetchAborted = false
      mockFetch.mockImplementationOnce((_url, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(`abort`, () => {
            secondFetchAborted = true
            reject(new DOMException(`Aborted`, `AbortError`))
          })
        })
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
      })

      // Start consuming the stream
      const received: Array<{ id: number }> = []

      res.subscribeJson<{ id: number }>((batch) => {
        received.push(...batch.items)
        return Promise.resolve()
      })

      // Wait for first batch and second fetch to start
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Simulate page becoming hidden (pause)
      simulateVisibilityChange(true)

      // Wait for abort to process
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Verify request was aborted
      expect(secondFetchAborted).toBe(true)

      // First batch should have been received
      expect(received).toEqual([{ id: 1 }])

      // Clean up
      res.cancel()
    })
  })

  describe(`resume behavior`, () => {
    it(`should resume fetching after pause and show`, async () => {
      // First response
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      // Second request - will be aborted by pause
      mockFetch.mockImplementationOnce((_url, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(`abort`, () => {
            reject(new DOMException(`Aborted`, `AbortError`))
          })
        })
      })

      // Third request - after resume
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 2 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `2_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      // Fourth request - keep stream alive
      mockFetch.mockImplementationOnce((_url, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(`abort`, () => {
            reject(new DOMException(`Aborted`, `AbortError`))
          })
        })
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
      })

      const received: Array<{ id: number }> = []
      res.subscribeJson<{ id: number }>((batch) => {
        received.push(...batch.items)
        return Promise.resolve()
      })

      // Wait for first data and second fetch to start
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Pause
      simulateVisibilityChange(true)
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Resume
      simulateVisibilityChange(false)

      // Poll for second item to arrive (more robust than fixed timeout)
      const pollForSecondItem = async (): Promise<void> => {
        for (let i = 0; i < 20; i++) {
          if (received.some((item) => item.id === 2)) return
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      await pollForSecondItem()

      // Should have received data from both successful requests
      expect(received).toContainEqual({ id: 1 })
      expect(received).toContainEqual({ id: 2 })

      res.cancel()
    })

    it(`should only skip live param on first request after resume (single-shot)`, async () => {
      const capturedUrls: Array<string> = []

      // Track all fetch calls
      mockFetch.mockImplementation(
        (url: string | URL | Request, init?: RequestInit) => {
          const urlString = typeof url === `string` ? url : url.toString()
          capturedUrls.push(urlString)

          // First request (initial) - return data
          if (capturedUrls.length === 1) {
            return Promise.resolve(
              new Response(JSON.stringify([{ id: 1 }]), {
                status: 200,
                headers: {
                  "content-type": `application/json`,
                  [STREAM_OFFSET_HEADER]: `1_10`,
                  [STREAM_UP_TO_DATE_HEADER]: `true`,
                },
              })
            )
          }

          // Second request (long-poll) - will be aborted by pause
          if (capturedUrls.length === 2) {
            return new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener(`abort`, () => {
                reject(new DOMException(`Aborted`, `AbortError`))
              })
            })
          }

          // Third request (resume, no live param) - return data
          if (capturedUrls.length === 3) {
            return Promise.resolve(
              new Response(JSON.stringify([{ id: 2 }]), {
                status: 200,
                headers: {
                  "content-type": `application/json`,
                  [STREAM_OFFSET_HEADER]: `2_10`,
                  [STREAM_UP_TO_DATE_HEADER]: `true`,
                },
              })
            )
          }

          // Fourth+ request - hang (will be cancelled)
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener(`abort`, () => {
              reject(new DOMException(`Aborted`, `AbortError`))
            })
          })
        }
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
      })

      res.subscribeJson<{ id: number }>(() => Promise.resolve())

      // Wait for first data and second fetch (long-poll) to start
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Pause
      simulateVisibilityChange(true)
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Resume
      simulateVisibilityChange(false)

      // Wait for resume request and subsequent long-poll to start
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Verify we have at least 4 requests
      expect(capturedUrls.length).toBeGreaterThanOrEqual(4)

      // First request (initial) has live=long-poll
      expect(capturedUrls[0]).toContain(`live=long-poll`)

      // Second request (subsequent long-poll) has live=long-poll
      expect(capturedUrls[1]).toContain(`live=long-poll`)

      // Third request (resume) should NOT have live param (single-shot skip)
      expect(capturedUrls[2]).not.toContain(`live=`)

      // Fourth request should have live=long-poll again
      expect(capturedUrls[3]).toContain(`live=long-poll`)

      res.cancel()
    })
  })

  describe(`cancel while paused`, () => {
    it(`should complete cancel quickly when paused`, async () => {
      // First response
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      // Second request - will be aborted by pause
      mockFetch.mockImplementationOnce((_url, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(`abort`, () => {
            reject(new DOMException(`Aborted`, `AbortError`))
          })
        })
      })

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
      })

      res.subscribeJson<{ id: number }>(() => Promise.resolve())

      // Wait for first data and second fetch to start
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Pause
      simulateVisibilityChange(true)
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Verify we're in paused state (only 1-2 fetch calls, not continuing)
      const fetchCountBefore = mockFetch.mock.calls.length

      // Cancel while paused - should complete quickly
      res.cancel()

      // Wait briefly for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Listener should have been removed
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        `visibilitychange`,
        expect.any(Function)
      )

      // No new fetches should have been made
      expect(mockFetch.mock.calls.length).toBe(fetchCountBefore)
    })
  })

  describe(`listener cleanup`, () => {
    it(`should add visibility listener on stream creation`, async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            // Not upToDate so stream stays open
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
      })

      // Listener should have been added
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        `visibilitychange`,
        expect.any(Function)
      )
      expect(visibilityHandler).not.toBeNull()

      res.cancel()
    })

    it(`should remove visibility listener on cancel`, async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            // Not upToDate so stream stays open
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `long-poll`,
      })

      expect(visibilityHandler).not.toBeNull()

      // Cancel the stream
      res.cancel()

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Listener should have been removed
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        `visibilitychange`,
        expect.any(Function)
      )
    })

    it(`should remove visibility listener on natural stream completion`, async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: false, // Will complete after upToDate
      })

      // Consume the stream to completion
      const items = await res.json()

      expect(items).toEqual([{ id: 1 }])

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Listener should have been removed
      expect(removeEventListenerSpy).toHaveBeenCalled()
    })
  })

  describe(`SSE mode visibility handling`, () => {
    /**
     * Helper to create a mock SSE response that completes after emitting events.
     * This simulates SSE streams that naturally end (e.g., server closes connection).
     */
    function createSSEResponse(
      events: Array<{ type: `data` | `control`; content: string }>
    ): Response {
      const encoder = new TextEncoder()
      let eventIndex = 0

      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (eventIndex < events.length) {
            const event = events[eventIndex]!
            eventIndex++
            if (event.type === `data`) {
              controller.enqueue(
                encoder.encode(`event: data\ndata: ${event.content}\n\n`)
              )
            } else {
              controller.enqueue(
                encoder.encode(`event: control\ndata: ${event.content}\n\n`)
              )
            }
          } else {
            // SSE stream completes - triggers reconnection logic
            controller.close()
          }
        },
      })

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": `text/event-stream`,
          [STREAM_OFFSET_HEADER]: `1_10`,
        },
      })
    }

    it(`should add visibility listener for SSE mode`, async () => {
      // SSE response with data
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          { type: `data`, content: JSON.stringify([{ id: 1 }]) },
          {
            type: `control`,
            content: JSON.stringify({
              streamNextOffset: `1_10`,
              upToDate: true,
            }),
          },
        ])
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `sse`,
        json: true,
      })

      // Visibility listener should have been added
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        `visibilitychange`,
        expect.any(Function)
      )
      expect(visibilityHandler).not.toBeNull()

      res.cancel()
    })

    it(`should remove visibility listener when SSE stream is cancelled`, async () => {
      // SSE response with data
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          { type: `data`, content: JSON.stringify([{ id: 1 }]) },
          {
            type: `control`,
            content: JSON.stringify({
              streamNextOffset: `1_10`,
              upToDate: true,
            }),
          },
        ])
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `sse`,
        json: true,
      })

      expect(visibilityHandler).not.toBeNull()

      // Cancel the stream
      res.cancel()

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Listener should have been removed
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        `visibilitychange`,
        expect.any(Function)
      )
    })

    it(`should receive data from SSE stream`, async () => {
      // SSE response with data
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          { type: `data`, content: JSON.stringify([{ id: 1 }]) },
          {
            type: `control`,
            content: JSON.stringify({
              streamNextOffset: `1_10`,
              upToDate: true,
            }),
          },
        ])
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        live: `sse`,
        json: true,
      })

      const received: Array<{ id: number }> = []
      res.subscribeJson<{ id: number }>((batch) => {
        received.push(...batch.items)
        return Promise.resolve()
      })

      // Wait for data to be received
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(received).toEqual([{ id: 1 }])

      res.cancel()
    })
  })

  describe(`initial hidden state`, () => {
    it(`should pause immediately if page is hidden when stream starts`, async () => {
      // Set document as hidden BEFORE creating stream
      mockHidden = true

      let fetchCount = 0

      // Create a fresh mock function for this test to avoid any state leakage
      const freshMockFetch = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) => {
          fetchCount++

          // First request - initial fetch
          if (fetchCount === 1) {
            return Promise.resolve(
              new Response(JSON.stringify([{ id: 1 }]), {
                status: 200,
                headers: {
                  "content-type": `application/json`,
                  [STREAM_OFFSET_HEADER]: `1_10`,
                  [STREAM_UP_TO_DATE_HEADER]: `true`,
                },
              })
            )
          }

          // Second request - after resume
          if (fetchCount === 2) {
            return Promise.resolve(
              new Response(JSON.stringify([{ id: 2 }]), {
                status: 200,
                headers: {
                  "content-type": `application/json`,
                  [STREAM_OFFSET_HEADER]: `2_10`,
                  [STREAM_UP_TO_DATE_HEADER]: `true`,
                },
              })
            )
          }

          // Third+ request - hang (will be cancelled)
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener(`abort`, () => {
              reject(new DOMException(`Aborted`, `AbortError`))
            })
          })
        }
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetch: freshMockFetch,
        live: `long-poll`,
      })

      res.subscribeJson<{ id: number }>(() => Promise.resolve())

      // Wait a bit - second fetch should NOT start because we're paused
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Only one fetch should have been made (the initial one before visibility check)
      // The stream should be paused waiting for resume
      expect(fetchCount).toBe(1)

      // Now show the page - should resume
      simulateVisibilityChange(false)

      // Poll for the second fetch to complete (more robust than fixed timeout)
      const pollForSecondFetch = async (): Promise<void> => {
        for (let i = 0; i < 20; i++) {
          if (fetchCount >= 2) return
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      await pollForSecondFetch()

      // Now second fetch should have been made
      expect(fetchCount).toBeGreaterThanOrEqual(2)

      res.cancel()
    })
  })
})
