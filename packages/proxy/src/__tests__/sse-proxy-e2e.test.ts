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
  waitFor,
} from "./harness"

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

/**
 * Wait for a stream to be closed (upstream finished writing).
 */
async function waitForStreamClosed(streamUrl: string): Promise<void> {
  await waitFor(async () => {
    const result = await readStream({ streamUrl, offset: `-1` })
    return result.headers.get(`Stream-Closed`) === `true`
  })
}

interface RoundTripOptions {
  body: string | Array<string>
  contentType?: string
  chunkDelayMs?: number
}

/**
 * Helper that performs a complete round-trip test:
 * sets up upstream, creates stream, waits for closure, reads, and returns the result.
 */
async function roundTrip(options: RoundTripOptions): Promise<{
  createResult: Awaited<ReturnType<typeof createStream>>
  readResult: Awaited<ReturnType<typeof readStream>>
}> {
  const { body, contentType = `text/event-stream`, chunkDelayMs = 10 } = options

  ctx.upstream.setResponse({
    headers: { "Content-Type": contentType },
    body,
    chunkDelayMs,
  })

  const createResult = await createStream({
    proxyUrl: ctx.urls.proxy,
    upstreamUrl: ctx.urls.upstream + `/v1/test`,
    body: {},
  })

  await waitForStreamClosed(createResult.streamUrl!)

  const readResult = await readStream({
    streamUrl: createResult.streamUrl!,
    offset: `-1`,
  })

  return { createResult, readResult }
}

/**
 * Helper that verifies body is preserved exactly through the proxy.
 */
async function verifyPreservesBody(
  body: string | Array<string>,
  options: Partial<RoundTripOptions> = {}
): Promise<void> {
  const { readResult } = await roundTrip({ body, ...options })
  const expected = Array.isArray(body) ? body.join(``) : body
  expect(readResult.body).toBe(expected)
}

describe(`SSE proxy e2e: data integrity`, () => {
  it(`exact bytes written match bytes read - simple case`, async () => {
    const chunks = createSSEChunks([
      { data: `{"message": "hello"}` },
      { data: `{"message": "world"}` },
    ])

    const { createResult, readResult } = await roundTrip({ body: chunks })

    expect(createResult.status).toBe(201)
    expect(readResult.status).toBe(200)
    expect(readResult.body).toBe(chunks.join(``))
  })

  it(`preserves data exactly when read multiple times`, async () => {
    const chunks = createSSEChunks([
      { data: `{"id": 1, "value": "first"}` },
      { data: `{"id": 2, "value": "second"}` },
      { data: `{"id": 3, "value": "third"}` },
    ])

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: chunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForStreamClosed(createResult.streamUrl!)

    const [read1, read2, read3] = await Promise.all([
      readStream({ streamUrl: createResult.streamUrl!, offset: `-1` }),
      readStream({ streamUrl: createResult.streamUrl!, offset: `-1` }),
      readStream({ streamUrl: createResult.streamUrl!, offset: `-1` }),
    ])

    expect(read1.body).toBe(read2.body)
    expect(read2.body).toBe(read3.body)
    expect(read1.body).toBe(chunks.join(``))
  })
})

describe(`SSE proxy e2e: SSE event format`, () => {
  it(`preserves custom event types`, async () => {
    const chunks = [
      `event: message\ndata: {"type": "message"}\n\n`,
      `event: delta\ndata: {"type": "delta"}\n\n`,
      `event: done\ndata: {"type": "done"}\n\n`,
    ]

    const { readResult } = await roundTrip({ body: chunks })

    expect(readResult.status).toBe(200)
    expect(readResult.body).toBe(chunks.join(``))

    const events = parseSSEEvents(readResult.body)
    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({ event: `message`, data: `{"type": "message"}` })
    expect(events[1]).toEqual({ event: `delta`, data: `{"type": "delta"}` })
    expect(events[2]).toEqual({ event: `done`, data: `{"type": "done"}` })
  })

  it(`handles data-only events (no event field)`, async () => {
    const chunks = createSSEChunks([
      { data: `line1` },
      { data: `line2` },
      { data: `line3` },
    ])

    const { readResult } = await roundTrip({ body: chunks })

    const events = parseSSEEvents(readResult.body)
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.event === undefined)).toBe(true)
    expect(events.map((e) => e.data)).toEqual([`line1`, `line2`, `line3`])
  })

  it(`preserves multi-line data fields`, async () => {
    await verifyPreservesBody([
      `data: line 1 of message\ndata: line 2 of message\ndata: line 3 of message\n\n`,
    ])
  })

  it(`handles empty data fields`, async () => {
    await verifyPreservesBody([
      `data: \n\n`,
      `data: non-empty\n\n`,
      `data: \n\n`,
    ])
  })

  it(`preserves SSE comments (lines starting with :)`, async () => {
    await verifyPreservesBody([
      `: this is a comment\n`,
      `data: actual data\n\n`,
      `: another comment\n`,
      `data: more data\n\n`,
    ])
  })

  it(`handles mixed event types and comments`, async () => {
    await verifyPreservesBody([
      `: keep-alive\n`,
      `event: start\ndata: {"status": "started"}\n\n`,
      `: processing\n`,
      `event: progress\ndata: {"percent": 50}\n\n`,
      `event: complete\ndata: {"status": "done"}\n\n`,
    ])
  })
})

describe(`SSE proxy e2e: encoding`, () => {
  it(`preserves UTF-8 characters`, async () => {
    const chunks = createSSEChunks([
      { data: `{"emoji": "🚀🌟💫"}` },
      { data: `{"chinese": "你好世界"}` },
      { data: `{"arabic": "مرحبا بالعالم"}` },
      { data: `{"japanese": "こんにちは世界"}` },
    ])

    const { readResult } = await roundTrip({
      body: chunks,
      contentType: `text/event-stream; charset=utf-8`,
    })

    expect(readResult.body).toContain(`🚀🌟💫`)
    expect(readResult.body).toContain(`你好世界`)
    expect(readResult.body).toContain(`مرحبا بالعالم`)
    expect(readResult.body).toContain(`こんにちは世界`)
    expect(readResult.body).toBe(chunks.join(``))
  })

  it(`handles special characters and escapes`, async () => {
    const chunks = createSSEChunks([
      { data: `{"special": "\\n\\t\\r\\"\\\\"}` },
      { data: `{"newlines": "line1\\nline2\\nline3"}` },
      { data: `{"unicode": "\\u0000\\u001f"}` },
    ])

    await verifyPreservesBody(chunks)
  })

  it(`handles long lines without truncation`, async () => {
    const longString = `x`.repeat(10000)
    const chunks = createSSEChunks([{ data: `{"long": "${longString}"}` }])

    const { readResult } = await roundTrip({ body: chunks })

    expect(readResult.body).toContain(longString)
    expect(readResult.body).toBe(chunks.join(``))
  })
})

describe(`SSE proxy e2e: batching and chunking`, () => {
  it(`handles rapid small chunks (time-based batching)`, async () => {
    const testData = Array.from({ length: 50 }, (_, i) => ({
      data: `{"n": ${i}}`,
    }))
    const chunks = createSSEChunks(testData)

    const { readResult } = await roundTrip({
      body: chunks,
      chunkDelayMs: 5,
    })

    const events = parseSSEEvents(readResult.body)
    expect(events).toHaveLength(50)

    for (let i = 0; i < 50; i++) {
      expect(JSON.parse(events[i]!.data)).toEqual({ n: i })
    }
  })

  it(`handles large chunks (size-based batching)`, async () => {
    const largeData = `y`.repeat(5000)
    const chunks = createSSEChunks([
      { data: `{"chunk": 1, "data": "${largeData}"}` },
      { data: `{"chunk": 2, "data": "${largeData}"}` },
      { data: `{"chunk": 3, "data": "${largeData}"}` },
    ])

    await verifyPreservesBody(chunks)
  })

  it(`handles data split across network chunks`, async () => {
    const chunks = [
      `data: {"part`,
      `": "one"}\n\n`,
      `data: {"complete": "two"}\n\ndata: {"al`,
      `so": "split"}\n\n`,
    ]

    const { readResult } = await roundTrip({
      body: chunks,
      chunkDelayMs: 20,
    })

    expect(readResult.body).toBe(chunks.join(``))

    const events = parseSSEEvents(readResult.body)
    expect(events).toHaveLength(3)
    expect(JSON.parse(events[0]!.data)).toEqual({ part: `one` })
    expect(JSON.parse(events[1]!.data)).toEqual({ complete: `two` })
    expect(JSON.parse(events[2]!.data)).toEqual({ also: `split` })
  })

  it(`handles very slow chunks (inactivity timeout boundary)`, async () => {
    const chunks = createSSEChunks([
      { data: `{"seq": 1}` },
      { data: `{"seq": 2}` },
      { data: `{"seq": 3}` },
    ])

    await verifyPreservesBody(chunks, { chunkDelayMs: 500 })
  })
})

describe(`SSE proxy e2e: offset-based resumption`, () => {
  it(`reads from beginning with offset=-1`, async () => {
    const chunks = createSSEChunks([
      { data: `{"seq": 1}` },
      { data: `{"seq": 2}` },
      { data: `{"seq": 3}` },
    ])

    const { readResult } = await roundTrip({ body: chunks })

    expect(readResult.status).toBe(200)
    expect(readResult.body).toBe(chunks.join(``))
  })

  it(`rejects invalid offset values with 400`, async () => {
    const chunks = createSSEChunks([{ data: `{"seq": 1}` }])

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: chunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForStreamClosed(createResult.streamUrl!)

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `0`,
    })

    expect(readResult.status).toBe(400)
  })

  it(`reads partial data using intermediate offset`, async () => {
    const chunks = createSSEChunks([
      { data: `{"seq": 1}` },
      { data: `{"seq": 2}` },
      { data: `{"seq": 3}` },
      { data: `{"seq": 4}` },
      { data: `{"seq": 5}` },
    ])

    const { createResult, readResult: firstRead } = await roundTrip({
      body: chunks,
    })

    expect(firstRead.nextOffset).toBeDefined()

    const secondRead = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: firstRead.nextOffset!,
    })

    expect(secondRead.status).toBe(200)
    expect(secondRead.body.length).toBeLessThanOrEqual(firstRead.body.length)
  })

  it(`returns consistent next-offset header`, async () => {
    const chunks = createSSEChunks([{ data: `{"n": 1}` }, { data: `{"n": 2}` }])

    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: chunks,
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    await waitForStreamClosed(createResult.streamUrl!)

    const [read1, read2] = await Promise.all([
      readStream({ streamUrl: createResult.streamUrl!, offset: `-1` }),
      readStream({ streamUrl: createResult.streamUrl!, offset: `-1` }),
    ])

    expect(read1.nextOffset).toBe(read2.nextOffset)
  })
})

describe(`SSE proxy e2e: content-type handling`, () => {
  it(`preserves upstream content-type header`, async () => {
    const { createResult, readResult } = await roundTrip({
      body: createSSEChunks([{ data: `test` }]),
      contentType: `text/event-stream; charset=utf-8`,
    })

    expect(createResult.upstreamContentType).toBe(
      `text/event-stream; charset=utf-8`
    )
    expect(readResult.upstreamContentType).toBe(
      `text/event-stream; charset=utf-8`
    )
  })

  it(`handles text/plain upstream content-type`, async () => {
    const plainText = `Line 1\nLine 2\nLine 3`

    const { createResult, readResult } = await roundTrip({
      body: plainText,
      contentType: `text/plain`,
    })

    expect(createResult.upstreamContentType).toBe(`text/plain`)
    expect(readResult.body).toBe(plainText)
  })

  it(`handles application/json upstream content-type`, async () => {
    const jsonBody = JSON.stringify({ message: `Hello, World!`, count: 42 })

    const { createResult, readResult } = await roundTrip({
      body: jsonBody,
      contentType: `application/json`,
    })

    expect(createResult.upstreamContentType).toBe(`application/json`)
    expect(readResult.body).toBe(jsonBody)
  })
})

describe(`SSE proxy e2e: stream lifecycle`, () => {
  it(`stream is marked closed after upstream completes`, async () => {
    const { readResult } = await roundTrip({
      body: createSSEChunks([{ data: `{"done": true}` }]),
    })

    expect(readResult.status).toBe(200)
    expect(readResult.body).toContain(`"done": true`)
  })

  it(`handles empty upstream response`, async () => {
    const { readResult } = await roundTrip({ body: `` })

    expect(readResult.status).toBe(200)
    expect(readResult.body).toBe(``)
  })

  it(`handles upstream that sends only comments`, async () => {
    await verifyPreservesBody([`: heartbeat\n`, `: keep-alive\n`, `: ping\n`])
  })
})

describe(`SSE proxy e2e: edge cases`, () => {
  it(`handles trailing newlines correctly`, async () => {
    await verifyPreservesBody([`data: test\n\n\n\n`])
  })

  it(`handles CRLF line endings`, async () => {
    await verifyPreservesBody([`data: line1\r\n\r\ndata: line2\r\n\r\n`])
  })

  it(`handles CR-only line endings`, async () => {
    await verifyPreservesBody([`data: line1\r\rdata: line2\r\r`])
  })

  it(`handles field names with no value`, async () => {
    await verifyPreservesBody([`data\n\n`])
  })

  it(`handles id and retry fields`, async () => {
    await verifyPreservesBody([
      `id: 1\nretry: 3000\ndata: first event\n\n`,
      `id: 2\ndata: second event\n\n`,
    ])
  })

  it(`handles unknown field names (should be ignored by clients but preserved)`, async () => {
    await verifyPreservesBody([
      `custom: ignored\ndata: with custom field\n\n`,
      `foo: bar\nevent: test\ndata: another\n\n`,
    ])
  })

  it(`handles very long event names`, async () => {
    const longEventName = `a`.repeat(1000)
    await verifyPreservesBody([`event: ${longEventName}\ndata: test\n\n`])
  })

  it(`handles space after colon in field value`, async () => {
    await verifyPreservesBody([
      `data: with space\n\n`,
      `data:without space\n\n`,
      `data:  two spaces\n\n`,
    ])
  })
})
