/**
 * End-to-end tests for the SSE proxy.
 *
 * These tests verify that data written to the proxy matches the data
 * read back, testing various edge cases in encoding, chunking, and
 * SSE event format handling.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createSSEChunks,
  createStream,
  createTestContext,
  parseSSEEvents,
  readStream,
} from "./harness"

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

/**
 * Helper to wait for the upstream piping to complete.
 * Adjust delay based on the expected data volume.
 */
async function waitForPiping(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe(`SSE proxy e2e: data integrity`, () => {
  it(`exact bytes written match bytes read - simple case`, async () => {
    const testData = [
      { data: `{"message": "hello"}` },
      { data: `{"message": "world"}` },
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })
    expect(createResult.status).toBe(201)

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)

    // Verify the exact SSE format is preserved
    const expectedBody = createSSEChunks(testData).join(``)
    expect(readResult.body).toBe(expectedBody)
  })

  it(`preserves data exactly when read multiple times`, async () => {
    const testData = [
      { data: `{"id": 1, "value": "first"}` },
      { data: `{"id": 2, "value": "second"}` },
      { data: `{"id": 3, "value": "third"}` },
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    // Read multiple times and verify consistency
    const read1 = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })
    const read2 = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })
    const read3 = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(read1.body).toBe(read2.body)
    expect(read2.body).toBe(read3.body)

    // Verify content
    const expectedBody = createSSEChunks(testData).join(``)
    expect(read1.body).toBe(expectedBody)
  })
})

describe(`SSE proxy e2e: SSE event format`, () => {
  it(`preserves custom event types`, async () => {
    const rawChunks = [
      `event: message\ndata: {"type": "message"}\n\n`,
      `event: delta\ndata: {"type": "delta"}\n\n`,
      `event: done\ndata: {"type": "done"}\n\n`,
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)

    // Verify the raw format is preserved
    expect(readResult.body).toBe(rawChunks.join(``))

    // Also parse and verify structure
    const events = parseSSEEvents(readResult.body)
    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({ event: `message`, data: `{"type": "message"}` })
    expect(events[1]).toEqual({ event: `delta`, data: `{"type": "delta"}` })
    expect(events[2]).toEqual({ event: `done`, data: `{"type": "done"}` })
  })

  it(`handles data-only events (no event field)`, async () => {
    const testData = [{ data: `line1` }, { data: `line2` }, { data: `line3` }]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    const events = parseSSEEvents(readResult.body)
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.event === undefined)).toBe(true)
    expect(events.map((e) => e.data)).toEqual([`line1`, `line2`, `line3`])
  })

  it(`preserves multi-line data fields`, async () => {
    // Multi-line data in SSE uses multiple data: lines
    const rawChunks = [
      `data: line 1 of message\ndata: line 2 of message\ndata: line 3 of message\n\n`,
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(rawChunks.join(``))
  })

  it(`handles empty data fields`, async () => {
    const rawChunks = [`data: \n\n`, `data: non-empty\n\n`, `data: \n\n`]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(rawChunks.join(``))
  })

  it(`preserves SSE comments (lines starting with :)`, async () => {
    const rawChunks = [
      `: this is a comment\n`,
      `data: actual data\n\n`,
      `: another comment\n`,
      `data: more data\n\n`,
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(rawChunks.join(``))
  })

  it(`handles mixed event types and comments`, async () => {
    const rawChunks = [
      `: keep-alive\n`,
      `event: start\ndata: {"status": "started"}\n\n`,
      `: processing\n`,
      `event: progress\ndata: {"percent": 50}\n\n`,
      `event: complete\ndata: {"status": "done"}\n\n`,
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(rawChunks.join(``))
  })
})

describe(`SSE proxy e2e: encoding`, () => {
  it(`preserves UTF-8 characters`, async () => {
    const testData = [
      { data: `{"emoji": "🚀🌟💫"}` },
      { data: `{"chinese": "你好世界"}` },
      { data: `{"arabic": "مرحبا بالعالم"}` },
      { data: `{"japanese": "こんにちは世界"}` },
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream; charset=utf-8` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toContain(`🚀🌟💫`)
    expect(readResult.body).toContain(`你好世界`)
    expect(readResult.body).toContain(`مرحبا بالعالم`)
    expect(readResult.body).toContain(`こんにちは世界`)

    // Verify exact byte-for-byte match
    const expectedBody = createSSEChunks(testData).join(``)
    expect(readResult.body).toBe(expectedBody)
  })

  it(`handles special characters and escapes`, async () => {
    const testData = [
      { data: `{"special": "\\n\\t\\r\\"\\\\"}` },
      { data: `{"newlines": "line1\\nline2\\nline3"}` },
      { data: `{"unicode": "\\u0000\\u001f"}` },
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    const expectedBody = createSSEChunks(testData).join(``)
    expect(readResult.body).toBe(expectedBody)
  })

  it(`handles long lines without truncation`, async () => {
    // Create a line that's longer than typical buffer sizes
    const longString = `x`.repeat(10000)
    const testData = [{ data: `{"long": "${longString}"}` }]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping(300) // Longer wait for large data

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toContain(longString)
    const expectedBody = createSSEChunks(testData).join(``)
    expect(readResult.body).toBe(expectedBody)
  })
})

describe(`SSE proxy e2e: batching and chunking`, () => {
  it(`handles rapid small chunks (time-based batching)`, async () => {
    // Many small chunks sent quickly - should be batched by time threshold
    const testData = Array(50)
      .fill(0)
      .map((_, i) => ({ data: `{"n": ${i}}` }))

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 5, // Very fast
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping(500)

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    // Verify all data arrived
    const events = parseSSEEvents(readResult.body)
    expect(events).toHaveLength(50)

    // Verify order and content
    for (let i = 0; i < 50; i++) {
      expect(JSON.parse(events[i]!.data)).toEqual({ n: i })
    }
  })

  it(`handles large chunks (size-based batching)`, async () => {
    // Create chunks larger than 4KB threshold
    const largeData = `y`.repeat(5000)
    const testData = [
      { data: `{"chunk": 1, "data": "${largeData}"}` },
      { data: `{"chunk": 2, "data": "${largeData}"}` },
      { data: `{"chunk": 3, "data": "${largeData}"}` },
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping(500)

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    const expectedBody = createSSEChunks(testData).join(``)
    expect(readResult.body).toBe(expectedBody)
  })

  it(`handles data split across network chunks`, async () => {
    // Simulate data being split mid-event across network chunks
    // This tests that the proxy correctly reassembles data
    const rawChunks = [
      `data: {"part`,
      `": "one"}\n\n`,
      `data: {"complete": "two"}\n\ndata: {"al`,
      `so": "split"}\n\n`,
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 20,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping(200)

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    // The full reassembled content should match
    const expectedBody = rawChunks.join(``)
    expect(readResult.body).toBe(expectedBody)

    // Verify all events are parseable
    const events = parseSSEEvents(readResult.body)
    expect(events).toHaveLength(3)
    expect(JSON.parse(events[0]!.data)).toEqual({ part: `one` })
    expect(JSON.parse(events[1]!.data)).toEqual({ complete: `two` })
    expect(JSON.parse(events[2]!.data)).toEqual({ also: `split` })
  })

  it(`handles very slow chunks (inactivity timeout boundary)`, async () => {
    // Slow stream but not slow enough to trigger timeout
    const testData = [
      { data: `{"seq": 1}` },
      { data: `{"seq": 2}` },
      { data: `{"seq": 3}` },
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 500, // 500ms between chunks
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    // Wait for all chunks to arrive (3 * 500ms + buffer)
    await waitForPiping(2000)

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    const expectedBody = createSSEChunks(testData).join(``)
    expect(readResult.body).toBe(expectedBody)
  })
})

describe(`SSE proxy e2e: offset-based resumption`, () => {
  it(`reads from beginning with offset=-1`, async () => {
    const testData = [
      { data: `{"seq": 1}` },
      { data: `{"seq": 2}` },
      { data: `{"seq": 3}` },
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    const expectedBody = createSSEChunks(testData).join(``)
    expect(readResult.body).toBe(expectedBody)
  })

  it(`rejects invalid offset values with 400`, async () => {
    // Per protocol, offsets are opaque tokens. Only -1 and "now" are valid
    // sentinel values. Arbitrary values like "0" should be rejected.
    const testData = [{ data: `{"seq": 1}` }]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    // offset=0 is not a valid offset value per protocol
    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `0`,
    })

    expect(readResult.status).toBe(400)
  })

  it(`reads partial data using intermediate offset`, async () => {
    const testData = [
      { data: `{"seq": 1}` },
      { data: `{"seq": 2}` },
      { data: `{"seq": 3}` },
      { data: `{"seq": 4}` },
      { data: `{"seq": 5}` },
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    // First read to get an intermediate offset
    const firstRead = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(firstRead.nextOffset).toBeDefined()
    const nextOffset = firstRead.nextOffset!

    // Reading from the end offset should return empty or minimal data
    const secondRead = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: nextOffset,
    })

    expect(secondRead.status).toBe(200)
    // At the end, no new data should be returned
    expect(secondRead.body.length).toBeLessThanOrEqual(firstRead.body.length)
  })

  it(`returns consistent next-offset header`, async () => {
    const testData = [{ data: `{"n": 1}` }, { data: `{"n": 2}` }]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    // Multiple reads should return consistent offset
    const read1 = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })
    const read2 = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(read1.nextOffset).toBe(read2.nextOffset)
  })
})

describe(`SSE proxy e2e: content-type handling`, () => {
  it(`preserves upstream content-type header`, async () => {
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream; charset=utf-8` },
      body: createSSEChunks([{ data: `test` }]),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    expect(createResult.upstreamContentType).toBe(
      `text/event-stream; charset=utf-8`
    )

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.upstreamContentType).toBe(
      `text/event-stream; charset=utf-8`
    )
  })

  it(`handles text/plain upstream content-type`, async () => {
    const plainText = `Line 1\nLine 2\nLine 3`

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/plain` },
      body: plainText,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    expect(createResult.upstreamContentType).toBe(`text/plain`)

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(plainText)
  })

  it(`handles application/json upstream content-type`, async () => {
    const jsonBody = JSON.stringify({ message: `Hello, World!`, count: 42 })

    ctx.upstream.setResponse({
      headers: { "Content-Type": `application/json` },
      body: jsonBody,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    expect(createResult.upstreamContentType).toBe(`application/json`)

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(jsonBody)
  })
})

describe(`SSE proxy e2e: stream lifecycle`, () => {
  it(`stream is marked closed after upstream completes`, async () => {
    const testData = [{ data: `{"done": true}` }]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(testData),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    // Wait for upstream to complete
    await waitForPiping(200)

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    // Stream should contain the data
    expect(readResult.body).toContain(`"done": true`)
  })

  it(`handles empty upstream response`, async () => {
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: ``,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    expect(readResult.body).toBe(``)
  })

  it(`handles upstream that sends only comments`, async () => {
    const commentsOnly = [`: heartbeat\n`, `: keep-alive\n`, `: ping\n`]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: commentsOnly,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    expect(readResult.body).toBe(commentsOnly.join(``))
  })
})

describe(`SSE proxy e2e: edge cases`, () => {
  it(`handles trailing newlines correctly`, async () => {
    const rawChunks = [`data: test\n\n\n\n`]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(rawChunks.join(``))
  })

  it(`handles CRLF line endings`, async () => {
    const crlfChunks = [`data: line1\r\n\r\ndata: line2\r\n\r\n`]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: crlfChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(crlfChunks.join(``))
  })

  it(`handles CR-only line endings`, async () => {
    const crChunks = [`data: line1\r\rdata: line2\r\r`]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: crChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(crChunks.join(``))
  })

  it(`handles field names with no value`, async () => {
    // Per SSE spec, "data" with no colon uses empty string
    const rawChunks = [`data\n\n`]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(rawChunks.join(``))
  })

  it(`handles id and retry fields`, async () => {
    const rawChunks = [
      `id: 1\nretry: 3000\ndata: first event\n\n`,
      `id: 2\ndata: second event\n\n`,
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(rawChunks.join(``))
  })

  it(`handles unknown field names (should be ignored by clients but preserved)`, async () => {
    const rawChunks = [
      `custom: ignored\ndata: with custom field\n\n`,
      `foo: bar\nevent: test\ndata: another\n\n`,
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(rawChunks.join(``))
  })

  it(`handles very long event names`, async () => {
    const longEventName = `a`.repeat(1000)
    const rawChunks = [`event: ${longEventName}\ndata: test\n\n`]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(rawChunks.join(``))
  })

  it(`handles space after colon in field value`, async () => {
    // Per SSE spec, a single space after colon should be stripped
    // But the proxy should preserve raw bytes
    const rawChunks = [
      `data: with space\n\n`,
      `data:without space\n\n`,
      `data:  two spaces\n\n`,
    ]

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: rawChunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForPiping()

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.body).toBe(rawChunks.join(``))
  })
})
