/**
 * Tests for aborting streams through the proxy.
 *
 * PATCH /v1/proxy/:streamId?action=abort&expires=...&signature=...
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  abortStream,
  createSSEChunks,
  createStream,
  createTestContext,
  readStream,
} from "./harness"

const ctx = createTestContext()

interface ParsedFrame {
  type: string
  responseId: number
}

function parseFrames(data: Uint8Array): Array<ParsedFrame> {
  const frames: Array<ParsedFrame> = []
  let offset = 0
  while (offset + 9 <= data.length) {
    const type = String.fromCharCode(data[offset]!)
    const view = new DataView(data.buffer, data.byteOffset + offset, 9)
    const responseId = view.getUint32(1, false)
    const payloadLength = view.getUint32(5, false)
    offset += 9
    if (offset + payloadLength > data.length) break
    frames.push({ type, responseId })
    offset += payloadLength
  }
  return frames
}

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`stream abort`, () => {
  it(`returns 401 when no authentication is provided`, async () => {
    // Use a stream ID without pre-signed URL params
    const url = new URL(`/v1/proxy/some-stream-id`, ctx.urls.proxy)
    url.searchParams.set(`action`, `abort`)

    const response = await fetch(url.toString(), {
      method: `PATCH`,
    })

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_SECRET`)
  })

  it(`returns 204 for already completed streams (idempotent)`, async () => {
    // Create a stream that completes quickly
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: `data: done\n\n`,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 100))

    // Abort should succeed idempotently
    const result = await abortStream({
      streamUrl: createResult.streamUrl!,
    })

    expect(result.status).toBe(204)
  })

  it(`returns 204 when aborting an in-progress stream`, async () => {
    // Create a slow stream
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(
        Array(100)
          .fill(0)
          .map((_, i) => ({ data: `chunk ${i}` }))
      ),
      chunkDelayMs: 100, // Very slow - 10 seconds total
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Abort immediately
    const result = await abortStream({
      streamUrl: createResult.streamUrl!,
    })

    expect(result.status).toBe(204)
  })

  it(`is idempotent - multiple aborts return 204`, async () => {
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(
        Array(100)
          .fill(0)
          .map((_, i) => ({ data: `chunk ${i}` }))
      ),
      chunkDelayMs: 100,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // First abort
    const firstAbort = await abortStream({
      streamUrl: createResult.streamUrl!,
    })
    expect(firstAbort.status).toBe(204)

    // Second abort should also succeed
    const secondAbort = await abortStream({
      streamUrl: createResult.streamUrl!,
    })
    expect(secondAbort.status).toBe(204)
  })

  it(`preserves data written before abort`, async () => {
    // Create a stream with some chunks, then we'll abort
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([
        { data: `{"chunk": 1}` },
        { data: `{"chunk": 2}` },
        { data: `{"chunk": 3}` },
        // More chunks would come but we'll abort
        ...Array(50)
          .fill(0)
          .map((_, i) => ({ data: `{"chunk": ${i + 4}}` })),
      ]),
      chunkDelayMs: 50,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for some data to be written
    await new Promise((r) => setTimeout(r, 200))

    // Abort
    await abortStream({
      streamUrl: createResult.streamUrl!,
    })

    // Read what was written - should have some data
    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    // Should have at least the first few chunks
    expect(readResult.body).toContain(`"chunk": 1`)
  })

  it(`aborts only the targeted response when response query is provided`, async () => {
    const streamId = `targeted-abort-${Date.now()}`

    // Create a stream with a long-running first response.
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(
        Array(80)
          .fill(0)
          .map((_, i) => ({ data: `slow-${i}` }))
      ),
      chunkDelayMs: 40,
    })
    const createUrl = new URL(
      `/v1/proxy/${encodeURIComponent(streamId)}`,
      ctx.urls.proxy
    )
    createUrl.searchParams.set(`secret`, `test-secret-key-for-development`)
    const first = await fetch(createUrl.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat`,
        "Upstream-Method": `POST`,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({ request: `slow` }),
    })
    expect(first.status).toBe(201)
    expect(first.headers.get(`Stream-Response-Id`)).toBe(`1`)
    const streamUrl = new URL(first.headers.get(`Location`)!, ctx.urls.proxy)

    // Append a second response that can complete while the first is in flight.
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `fast-1` }, { data: `fast-2` }]),
      chunkDelayMs: 5,
    })
    const second = await fetch(createUrl.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat`,
        "Upstream-Method": `POST`,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({ request: `fast` }),
    })
    expect(second.status).toBe(200)
    expect(second.headers.get(`Stream-Response-Id`)).toBe(`2`)

    // Abort only response 1.
    const targetedAbortUrl = new URL(streamUrl.toString())
    targetedAbortUrl.searchParams.set(`action`, `abort`)
    targetedAbortUrl.searchParams.set(`response`, `1`)
    const abortResponse = await fetch(targetedAbortUrl.toString(), {
      method: `PATCH`,
    })
    expect(abortResponse.status).toBe(204)

    // Wait for terminal frames to flush, then verify response 1 aborted while
    // response 2 completed.
    await new Promise((r) => setTimeout(r, 350))
    const readUrl = new URL(streamUrl.toString())
    readUrl.searchParams.set(`offset`, `-1`)
    const read = await fetch(readUrl.toString())
    expect(read.status).toBe(200)
    const frames = parseFrames(new Uint8Array(await read.arrayBuffer()))

    const response1Terminal = frames.find(
      (f) =>
        f.responseId === 1 &&
        (f.type === `A` || f.type === `C` || f.type === `E`)
    )
    const response2Terminal = frames.find(
      (f) =>
        f.responseId === 2 &&
        (f.type === `A` || f.type === `C` || f.type === `E`)
    )

    expect(response1Terminal?.type).toBe(`A`)
    expect(response2Terminal?.type).toBe(`C`)
  })
})
