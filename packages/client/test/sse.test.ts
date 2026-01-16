import { describe, expect, it, vi } from "vitest"
import { parseSSEStream } from "../src/sse"
import { DurableStreamError } from "../src/error"

describe(`SSE parsing`, () => {
  /**
   * Helper to create a ReadableStream from SSE text.
   */
  function createSSEStream(sseText: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })
  }

  /**
   * Helper to create a chunked SSE stream (simulates network chunking).
   */
  function createChunkedSSEStream(
    chunks: Array<string>
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let index = 0
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]))
          index++
        } else {
          controller.close()
        }
      },
    })
  }

  describe(`parseSSEStream`, () => {
    it(`should parse a simple data event`, async () => {
      const sseText = `event: data
data: {"message":"hello"}

`
      const stream = createSSEStream(sseText)
      const events = []

      for await (const event of parseSSEStream(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: `data`,
        data: `{"message":"hello"}`,
      })
    })

    it(`should parse a control event with offset and cursor`, async () => {
      const sseText = `event: control
data: {"streamNextOffset":"123456","streamCursor":"abc"}

`
      const stream = createSSEStream(sseText)
      const events = []

      for await (const event of parseSSEStream(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: `control`,
        streamNextOffset: `123456`,
        streamCursor: `abc`,
      })
    })

    it(`should parse a control event with upToDate flag`, async () => {
      const sseText = `event: control
data: {"streamNextOffset":"123456","streamCursor":"abc","upToDate":true}

`
      const stream = createSSEStream(sseText)
      const events = []

      for await (const event of parseSSEStream(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: `control`,
        streamNextOffset: `123456`,
        streamCursor: `abc`,
        upToDate: true,
      })
    })

    it(`should parse multiple events`, async () => {
      const sseText = `event: data
data: {"id":1}

event: control
data: {"streamNextOffset":"100"}

event: data
data: {"id":2}

event: control
data: {"streamNextOffset":"200","streamCursor":"xyz"}

`
      const stream = createSSEStream(sseText)
      const events = []

      for await (const event of parseSSEStream(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(4)
      expect(events[0]).toEqual({ type: `data`, data: `{"id":1}` })
      expect(events[1]).toEqual({
        type: `control`,
        streamNextOffset: `100`,
      })
      expect(events[2]).toEqual({ type: `data`, data: `{"id":2}` })
      expect(events[3]).toEqual({
        type: `control`,
        streamNextOffset: `200`,
        streamCursor: `xyz`,
      })
    })

    it(`should handle multi-line data (JSON array spanning lines)`, async () => {
      const sseText = `event: data
data: [
data: {"k":"v"},
data: {"k":"w"}
data: ]

event: control
data: {"streamNextOffset":"300"}

`
      const stream = createSSEStream(sseText)
      const events = []

      for await (const event of parseSSEStream(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({
        type: `data`,
        data: `[\n{"k":"v"},\n{"k":"w"}\n]`,
      })
      expect(events[1]).toEqual({
        type: `control`,
        streamNextOffset: `300`,
      })
    })

    it(`should handle chunked delivery`, async () => {
      // SSE data split across network chunks
      const chunks = [
        `event: da`,
        `ta\ndata: {"mess`,
        `age":"hello"}\n\nevent: control\ndata: {"streamNextOffset":"100"}`,
        `\n\n`,
      ]
      const stream = createChunkedSSEStream(chunks)
      const events = []

      for await (const event of parseSSEStream(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({
        type: `data`,
        data: `{"message":"hello"}`,
      })
      expect(events[1]).toEqual({
        type: `control`,
        streamNextOffset: `100`,
      })
    })

    it(`should respect abort signal`, async () => {
      // Create a stream that delivers events in separate chunks with delay
      const abortController = new AbortController()
      let chunkIndex = 0
      const chunks = [
        `event: data\ndata: {"id":1}\n\n`,
        `event: data\ndata: {"id":2}\n\n`,
      ]
      const encoder = new TextEncoder()

      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (abortController.signal.aborted) {
            controller.close()
            return
          }
          if (chunkIndex < chunks.length) {
            controller.enqueue(encoder.encode(chunks[chunkIndex]))
            chunkIndex++
          } else {
            controller.close()
          }
        },
      })

      const events = []

      // Abort after first event
      for await (const event of parseSSEStream(
        stream,
        abortController.signal
      )) {
        events.push(event)
        abortController.abort()
      }

      // Should only have gotten the first event (second chunk not read due to abort)
      expect(events).toHaveLength(1)
    })

    it(`should throw on invalid control event JSON`, async () => {
      const sseText = `event: control
data: not-valid-json

event: data
data: {"valid":"data"}

`
      const stream = createSSEStream(sseText)

      // Invalid control event should throw PARSE_ERROR
      await expect(async () => {
        for await (const _event of parseSSEStream(stream)) {
          // Should not reach here
        }
      }).rejects.toThrow(DurableStreamError)

      // Verify it's specifically a PARSE_ERROR
      try {
        const retryStream = createSSEStream(sseText)
        for await (const _event of parseSSEStream(retryStream)) {
          // Should not reach here
        }
      } catch (err) {
        expect(err).toBeInstanceOf(DurableStreamError)
        expect((err as DurableStreamError).code).toBe(`PARSE_ERROR`)
      }
    })

    it(`should ignore unknown event types`, async () => {
      const sseText = `event: unknown
data: some-data

event: data
data: {"real":"data"}

`
      const stream = createSSEStream(sseText)
      const events = []

      for await (const event of parseSSEStream(stream)) {
        events.push(event)
      }

      // Unknown event type should be ignored
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: `data`,
        data: `{"real":"data"}`,
      })
    })

    it(`should handle empty stream`, async () => {
      const stream = createSSEStream(``)
      const events = []

      for await (const event of parseSSEStream(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(0)
    })
  })
})

describe(`SSE mode integration`, () => {
  // Import the implementation directly for testing (not exported publicly)
  const getStreamResponseImpl = async () => {
    const module = await import(`../src/response`)
    return module.StreamResponseImpl
  }

  it(`should create synthetic Response objects from SSE data events`, async () => {
    // This tests that the StreamResponse correctly handles SSE mode
    // by creating a mock SSE response and verifying the consumption methods work

    const StreamResponseImpl = await getStreamResponseImpl()

    // Create a mock SSE response body
    const sseText = `event: data
data: {"message":"hello"}

event: control
data: {"streamNextOffset":"100"}

event: data
data: {"message":"world"}

event: control
data: {"streamNextOffset":"200"}

`
    const encoder = new TextEncoder()
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })

    // Create a mock first response that looks like an SSE response
    const firstResponse = new Response(sseBody, {
      status: 200,
      headers: {
        "content-type": `text/event-stream`,
      },
    })

    const abortController = new AbortController()
    const fetchNext = vi.fn()

    const streamResponse = new StreamResponseImpl({
      url: `http://test.com/stream`,
      contentType: `application/json`,
      live: `sse`,
      startOffset: `0`,
      isJsonMode: true,
      initialOffset: `0`,
      initialCursor: undefined,
      initialUpToDate: false,
      firstResponse,
      abortController,
      fetchNext,
      startSSE: undefined,
    })

    // Consume as JSON
    const items = await streamResponse.json()

    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ message: `hello` })
    expect(items[1]).toEqual({ message: `world` })

    // Verify offset was updated from control events
    expect(streamResponse.offset).toBe(`200`)
  })

  it(`should support jsonStream with SSE`, async () => {
    const StreamResponseImpl = await getStreamResponseImpl()

    const sseText = `event: data
data: [{"id":1},{"id":2}]

event: control
data: {"streamNextOffset":"100"}

`
    const encoder = new TextEncoder()
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })

    const firstResponse = new Response(sseBody, {
      status: 200,
      headers: { "content-type": `text/event-stream` },
    })

    const streamResponse = new StreamResponseImpl<{ id: number }>({
      url: `http://test.com/stream`,
      contentType: `application/json`,
      live: `sse`,
      startOffset: `0`,
      isJsonMode: true,
      initialOffset: `0`,
      initialCursor: undefined,
      initialUpToDate: false,
      firstResponse,
      abortController: new AbortController(),
      fetchNext: vi.fn(),
    })

    // Consume via jsonStream
    const items: Array<{ id: number }> = []
    const reader = streamResponse.jsonStream().getReader()
    let result = await reader.read()
    while (!result.done) {
      items.push(result.value)
      result = await reader.read()
    }

    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ id: 1 })
    expect(items[1]).toEqual({ id: 2 })
  })

  it(`should support bodyStream with SSE`, async () => {
    const StreamResponseImpl = await getStreamResponseImpl()

    const sseText = `event: data
data: Hello, World!

event: control
data: {"streamNextOffset":"100"}

`
    const encoder = new TextEncoder()
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })

    const firstResponse = new Response(sseBody, {
      status: 200,
      headers: { "content-type": `text/event-stream` },
    })

    const streamResponse = new StreamResponseImpl({
      url: `http://test.com/stream`,
      contentType: `text/plain`,
      live: `sse`,
      startOffset: `0`,
      isJsonMode: false,
      initialOffset: `0`,
      initialCursor: undefined,
      initialUpToDate: false,
      firstResponse,
      abortController: new AbortController(),
      fetchNext: vi.fn(),
    })

    // Consume via text()
    const text = await streamResponse.text()
    expect(text).toBe(`Hello, World!`)
  })

  it(`should update upToDate flag from SSE control events`, async () => {
    const StreamResponseImpl = await getStreamResponseImpl()

    const sseText = `event: data
data: {"id":1}

event: control
data: {"streamNextOffset":"100","upToDate":true}

`
    const encoder = new TextEncoder()
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })

    const firstResponse = new Response(sseBody, {
      status: 200,
      headers: { "content-type": `text/event-stream` },
    })

    const streamResponse = new StreamResponseImpl<{ id: number }>({
      url: `http://test.com/stream`,
      contentType: `application/json`,
      live: `sse`,
      startOffset: `0`,
      isJsonMode: true,
      initialOffset: `0`,
      initialCursor: undefined,
      initialUpToDate: false,
      firstResponse,
      abortController: new AbortController(),
      fetchNext: vi.fn(),
    })

    // Initially not up to date
    expect(streamResponse.upToDate).toBe(false)

    // Consume the stream
    await streamResponse.json()

    // After consuming, upToDate should be true from control event
    expect(streamResponse.upToDate).toBe(true)
    expect(streamResponse.offset).toBe(`100`)
  })

  it(`should provide correct offset values to subscribers (not stale)`, async () => {
    // This test verifies the fix for the bug where SSE mode provided stale offset values.
    // In SSE, control events with offset come AFTER data events. The implementation must
    // wait for the control event before yielding data, so subscribers get the correct offset.
    const StreamResponseImpl = await getStreamResponseImpl()

    // Create an SSE stream with multiple data+control pairs
    const sseText = `event: data
data: {"id":1}

event: control
data: {"streamNextOffset":"100","streamCursor":"cursor-1"}

event: data
data: {"id":2}

event: control
data: {"streamNextOffset":"200","streamCursor":"cursor-2"}

event: data
data: {"id":3}

event: control
data: {"streamNextOffset":"300","streamCursor":"cursor-3","upToDate":true}

`
    const encoder = new TextEncoder()
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })

    const firstResponse = new Response(sseBody, {
      status: 200,
      headers: { "content-type": `text/event-stream` },
    })

    const streamResponse = new StreamResponseImpl<{ id: number }>({
      url: `http://test.com/stream`,
      contentType: `application/json`,
      live: `sse`,
      startOffset: `0`,
      isJsonMode: true,
      initialOffset: `0`,
      initialCursor: undefined,
      initialUpToDate: false,
      firstResponse,
      abortController: new AbortController(),
      fetchNext: vi.fn(),
    })

    // Collect all batches with their offsets
    const batches: Array<{
      items: Array<{ id: number }>
      offset: string
      cursor: string | undefined
      upToDate: boolean
    }> = []

    await new Promise<void>((resolve) => {
      streamResponse.subscribeJson<{ id: number }>((batch) => {
        batches.push({
          items: [...batch.items],
          offset: batch.offset,
          cursor: batch.cursor,
          upToDate: batch.upToDate,
        })
        // Stop after upToDate
        if (batch.upToDate) {
          resolve()
        }
        return Promise.resolve()
      })
    })

    // Verify each batch received the CORRECT offset for its data, not stale values
    expect(batches).toHaveLength(3)

    // First batch: id=1 should have offset=100, cursor=cursor-1
    expect(batches[0]!.items).toEqual([{ id: 1 }])
    expect(batches[0]!.offset).toBe(`100`)
    expect(batches[0]!.cursor).toBe(`cursor-1`)
    expect(batches[0]!.upToDate).toBe(false)

    // Second batch: id=2 should have offset=200, cursor=cursor-2
    expect(batches[1]!.items).toEqual([{ id: 2 }])
    expect(batches[1]!.offset).toBe(`200`)
    expect(batches[1]!.cursor).toBe(`cursor-2`)
    expect(batches[1]!.upToDate).toBe(false)

    // Third batch: id=3 should have offset=300, cursor=cursor-3, upToDate=true
    expect(batches[2]!.items).toEqual([{ id: 3 }])
    expect(batches[2]!.offset).toBe(`300`)
    expect(batches[2]!.cursor).toBe(`cursor-3`)
    expect(batches[2]!.upToDate).toBe(true)
  })

  it(`should surface SSE reconnection errors`, async () => {
    const StreamResponseImpl = await getStreamResponseImpl()

    // Create an SSE stream that ends immediately (triggering reconnect)
    const sseText = `event: data
data: {"id":1}

`
    const encoder = new TextEncoder()
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close() // Close immediately to trigger reconnect
      },
    })

    const firstResponse = new Response(sseBody, {
      status: 200,
      headers: { "content-type": `text/event-stream` },
    })

    const startSSE = vi.fn().mockRejectedValue(new Error(`Network error`))

    const streamResponse = new StreamResponseImpl<{ id: number }>({
      url: `http://test.com/stream`,
      contentType: `application/json`,
      live: `sse`,
      startOffset: `0`,
      isJsonMode: true,
      initialOffset: `0`,
      initialCursor: undefined,
      initialUpToDate: false,
      firstResponse,
      abortController: new AbortController(),
      fetchNext: vi.fn(),
      startSSE,
    })

    // Start consuming with subscriber (triggers live mode)
    const items: Array<{ id: number }> = []
    streamResponse.subscribeJson((batch) => {
      items.push(...batch.items)
      return Promise.resolve()
    })

    // The closed promise should reject with the reconnection error
    await expect(streamResponse.closed).rejects.toThrow(`Network error`)

    // startSSE should have been called for reconnection
    expect(startSSE).toHaveBeenCalled()
  })
})
