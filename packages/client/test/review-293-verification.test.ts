import { describe, expect, it, vi } from "vitest"
import { stream } from "../src/stream-api"
import {
  STREAM_CLOSED_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "../src/index"
import {
  createFetchWithChunkBuffer,
  createFetchWithConsumedBody,
} from "../src/fetch"
import {
  InMemoryUpToDateStorage,
  UpToDateTracker,
  canonicalStreamKey,
} from "../src/up-to-date-tracker"

function sseResponse(events: string): Response {
  return new Response(new TextEncoder().encode(events), {
    status: 200,
    headers: {
      "content-type": `text/event-stream`,
      "Stream-Next-Offset": `0`,
      "Stream-Cursor": `initial`,
    },
  })
}

describe(`PR 293 external review verification`, () => {
  it(`emits a control-only SSE streamClosed event as up-to-date`, async () => {
    const mockFetch = vi.fn<typeof fetch>()
    mockFetch
      .mockResolvedValueOnce(
        new Response(``, {
          status: 200,
          headers: {
            "Stream-Next-Offset": `0`,
            "Stream-Cursor": `initial`,
            "Stream-Up-To-Date": `true`,
          },
        })
      )
      .mockResolvedValueOnce(
        sseResponse(
          `event: control\ndata: {"streamNextOffset":"0","streamCursor":"closed-cursor","streamClosed":true}\n\n`
        )
      )

    const res = await stream({
      url: `https://example.com/s`,
      fetch: mockFetch,
      live: `sse`,
    })
    const reader = res.bodyStream().getReader()
    await expect(
      Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`timed out waiting for closed control`)),
            50
          )
        ),
      ])
    ).resolves.toMatchObject({ done: true })

    expect(res.upToDate).toBe(true)
    expect(res.streamClosed).toBe(true)

    reader.releaseLock()
    res.cancel()
  })

  it(`marks data-bearing SSE streamClosed controls as up-to-date`, async () => {
    const mockFetch = vi.fn<typeof fetch>()
    mockFetch
      .mockResolvedValueOnce(
        new Response(``, {
          status: 200,
          headers: {
            "Stream-Next-Offset": `0`,
            "Stream-Cursor": `initial`,
            "Stream-Up-To-Date": `true`,
          },
        })
      )
      .mockResolvedValueOnce(
        sseResponse(
          `event: data\ndata: hello\n\nevent: control\ndata: {"streamNextOffset":"5","streamCursor":"closed-cursor","streamClosed":true}\n\n`
        )
      )

    const res = await stream({
      url: `https://example.com/s`,
      fetch: mockFetch,
      live: `sse`,
    })
    const reader = res.bodyStream().getReader()
    await expect(
      Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`timed out waiting for closed control`)),
            50
          )
        ),
      ])
    ).resolves.toMatchObject({ done: false })

    expect(res.upToDate).toBe(true)
    expect(res.streamClosed).toBe(true)

    reader.releaseLock()
    res.cancel()
  })

  it(`records SSE up-to-date cursors in replay storage`, async () => {
    const storage = new InMemoryUpToDateStorage()
    const mockFetch = vi.fn<typeof fetch>()
    mockFetch
      .mockResolvedValueOnce(
        new Response(``, {
          status: 200,
          headers: {
            "Stream-Next-Offset": `0`,
            "Stream-Cursor": `initial`,
            "Stream-Up-To-Date": `true`,
          },
        })
      )
      .mockResolvedValueOnce(
        sseResponse(
          `event: data\ndata: hello\n\nevent: control\ndata: {"streamNextOffset":"5","streamCursor":"sse-up-to-date","upToDate":true}\n\n`
        )
      )

    const res = await stream({
      url: `https://example.com/s`,
      fetch: mockFetch,
      live: `sse`,
      upToDateStorage: storage,
    })
    const reader = res.bodyStream().getReader()
    await reader.read()

    expect(
      new UpToDateTracker(storage).shouldEnterReplayMode(
        canonicalStreamKey(`https://example.com/s?offset=-1`)
      )
    ).toBe(`sse-up-to-date`)

    reader.releaseLock()
    res.cancel()
  })

  it(`falls back to long-poll after empty short SSE closes without re-entering SSE`, async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(``, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1`,
            [STREAM_CURSOR_HEADER]: `c`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(``, {
          status: 200,
          headers: {
            "content-type": `text/event-stream`,
            [STREAM_OFFSET_HEADER]: `1`,
            [STREAM_CURSOR_HEADER]: `c`,
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(`lp`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `2`,
            [STREAM_CURSOR_HEADER]: `c2`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
            [STREAM_CLOSED_HEADER]: `true`,
          },
        })
      )

    const res = await stream({
      url: `https://example.com/s`,
      fetch,
      live: `sse`,
      sseResilience: {
        minConnectionDuration: 10_000,
        maxShortConnections: 1,
        backoffBaseDelay: 0,
        backoffMaxDelay: 0,
        logWarnings: false,
      },
    })

    const reader = res.textStream().getReader()
    await expect(reader.read()).resolves.toMatchObject({ value: `lp` })
    await expect(res.closed).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(String(fetch.mock.calls[2]![0])).not.toContain(`live=sse`)
  })

  it(`aborts a consumed prefetched response while its body is being consumed`, async () => {
    let prefetchBodyCanceled = false
    let resolveBody!: () => void
    const baseFetch = vi.fn<typeof fetch>((input, init) => {
      const url = String(input)
      if (url.includes(`offset=0`)) {
        return Promise.resolve(
          new Response(`first`, { headers: { "Stream-Next-Offset": `1` } })
        )
      }
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(`abort`, () => {
                prefetchBodyCanceled = true
                controller.error(init.signal?.reason ?? new Error(`aborted`))
              })
              resolveBody = () => {
                try {
                  controller.enqueue(new TextEncoder().encode(`second`))
                  controller.close()
                } catch {
                  // The abort path may already have errored the controller.
                }
              }
            },
          }),
          { headers: { "Stream-Next-Offset": `2` } }
        )
      )
    })

    const fetchClient = createFetchWithConsumedBody(
      createFetchWithChunkBuffer(baseFetch)
    )
    await fetchClient(`https://example.com/s?offset=0`)
    // Let the prefetched fetch promise settle and its finally(cleanup) run before consumption.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const abort = new AbortController()
    const consumePromise = fetchClient(`https://example.com/s?offset=1`, {
      signal: abort.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    abort.abort(`consumer-canceled`)
    resolveBody()

    await expect(consumePromise).rejects.toThrow()
    expect(prefetchBodyCanceled).toBe(true)
  })
})
