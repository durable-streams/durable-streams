import { describe, expect, it, vi } from "vitest"
import {
  PRODUCER_EPOCH_HEADER,
  PRODUCER_EXPECTED_SEQ_HEADER,
  PRODUCER_ID_HEADER,
  PRODUCER_RECEIVED_SEQ_HEADER,
  PRODUCER_SEQ_HEADER,
  STREAM_CLOSED_HEADER,
  STREAM_EXPECTED_OFFSET_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_SEQ_HEADER,
} from "../src"
import { DurableStream } from "../src/stream"

const streamUrl = `https://example.com/v1/stream/test`

function makeStream(mockFetch: typeof fetch): DurableStream {
  return new DurableStream({
    url: streamUrl,
    contentType: `text/plain`,
    fetch: mockFetch,
  })
}

describe(`DurableStream.appendWithResult`, () => {
  it(`returns ok with nextOffset on a plain 204 append`, async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 204,
        headers: { [STREAM_OFFSET_HEADER]: `1_5` },
      })
    )
    const stream = makeStream(mockFetch)

    const result = await stream.appendWithResult(`hello`)
    expect(result).toEqual({
      kind: `ok`,
      nextOffset: `1_5`,
      deduped: false,
      closed: false,
    })
  })

  it(`sends Stream-Seq, Stream-Expected-Offset, producer and close headers on one POST`, async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: {
          [STREAM_OFFSET_HEADER]: `1_10`,
          [STREAM_CLOSED_HEADER]: `true`,
        },
      })
    )
    const stream = makeStream(mockFetch)

    const result = await stream.appendWithResult(`payload`, {
      seq: `seq-001`,
      expectedOffset: `1_5`,
      producerId: `p1`,
      producerEpoch: 2,
      producerSeq: 7,
      close: true,
    })

    expect(result).toEqual({
      kind: `ok`,
      nextOffset: `1_10`,
      deduped: false,
      closed: true,
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]!
    expect(String(url)).toBe(streamUrl)
    expect(init.method).toBe(`POST`)
    expect(init.headers[STREAM_SEQ_HEADER]).toBe(`seq-001`)
    expect(init.headers[STREAM_EXPECTED_OFFSET_HEADER]).toBe(`1_5`)
    expect(init.headers[PRODUCER_ID_HEADER]).toBe(`p1`)
    expect(init.headers[PRODUCER_EPOCH_HEADER]).toBe(`2`)
    expect(init.headers[PRODUCER_SEQ_HEADER]).toBe(`7`)
    expect(init.headers[STREAM_CLOSED_HEADER]).toBe(`true`)
  })

  it(`marks producer 204 responses as deduped and recovers the tail via HEAD`, async () => {
    const mockFetch = vi
      .fn()
      // Dedup 204 with no Stream-Next-Offset (as the reference server sends)
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204,
          headers: {
            [PRODUCER_EPOCH_HEADER]: `0`,
            [PRODUCER_SEQ_HEADER]: `3`,
          },
        })
      )
      // HEAD fallback
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { [STREAM_OFFSET_HEADER]: `1_42` },
        })
      )
    const stream = makeStream(mockFetch)

    const result = await stream.appendWithResult(`retry`, {
      producerId: `p1`,
      producerEpoch: 0,
      producerSeq: 3,
      expectedOffset: `stale-offset`,
    })

    expect(result).toEqual({
      kind: `ok`,
      nextOffset: `1_42`,
      deduped: true,
      closed: false,
    })
    expect(mockFetch.mock.calls[1]![1].method).toBe(`HEAD`)
  })

  it(`returns seq-conflict with conflict "seq" and the echoed tail on a Stream-Seq 409`, async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(`Sequence conflict`, {
        status: 409,
        headers: { [STREAM_OFFSET_HEADER]: `1_20` },
      })
    )
    const stream = makeStream(mockFetch)

    const result = await stream.appendWithResult(`late`, { seq: `seq-001` })
    expect(result).toEqual({
      kind: `seq-conflict`,
      nextOffset: `1_20`,
      conflict: `seq`,
    })
  })

  it(`returns seq-conflict with conflict "expected-offset" on a Stream-Expected-Offset 409`, async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(`Expected offset conflict`, {
        status: 409,
        headers: { [STREAM_OFFSET_HEADER]: `1_30` },
      })
    )
    const stream = makeStream(mockFetch)

    const result = await stream.appendWithResult(`late`, {
      expectedOffset: `1_10`,
    })
    expect(result).toEqual({
      kind: `seq-conflict`,
      nextOffset: `1_30`,
      conflict: `expected-offset`,
    })
  })

  it(`returns seq-conflict without nextOffset when the 409 carries no header`, async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(`Sequence conflict`, { status: 409 }))
    const stream = makeStream(mockFetch)

    const result = await stream.appendWithResult(`late`, { seq: `seq-001` })
    expect(result).toEqual({
      kind: `seq-conflict`,
      nextOffset: undefined,
      conflict: `seq`,
    })
  })

  it(`returns closed when the stream was already closed`, async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(`Stream is closed`, {
        status: 409,
        headers: {
          [STREAM_CLOSED_HEADER]: `true`,
          [STREAM_OFFSET_HEADER]: `1_99`,
        },
      })
    )
    const stream = makeStream(mockFetch)

    const result = await stream.appendWithResult(`too late`)
    expect(result).toEqual({ kind: `closed`, nextOffset: `1_99` })
  })

  it(`returns stale-epoch on a producer fencing 403`, async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(`Stale producer epoch`, {
        status: 403,
        headers: { [PRODUCER_EPOCH_HEADER]: `5` },
      })
    )
    const stream = makeStream(mockFetch)

    const result = await stream.appendWithResult(`zombie`, {
      producerId: `p1`,
      producerEpoch: 4,
      producerSeq: 0,
    })
    expect(result).toEqual({ kind: `stale-epoch`, currentEpoch: 5 })
  })

  it(`returns producer-gap on a sequence gap 409`, async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(`Producer sequence gap`, {
        status: 409,
        headers: {
          [PRODUCER_EXPECTED_SEQ_HEADER]: `4`,
          [PRODUCER_RECEIVED_SEQ_HEADER]: `7`,
        },
      })
    )
    const stream = makeStream(mockFetch)

    const result = await stream.appendWithResult(`gap`, {
      producerId: `p1`,
      producerEpoch: 0,
      producerSeq: 7,
    })
    expect(result).toEqual({
      kind: `producer-gap`,
      expectedSeq: 4,
      receivedSeq: 7,
    })
  })

  it(`still throws on unrecognized HTTP errors`, async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(`Stream not found`, { status: 404 }))
    const stream = makeStream(mockFetch)

    await expect(stream.appendWithResult(`data`)).rejects.toThrow()
  })

  it(`wraps JSON bodies in an array like append()`, async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 204,
        headers: { [STREAM_OFFSET_HEADER]: `1_5` },
      })
    )
    const stream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
      fetch: mockFetch,
    })

    await stream.appendWithResult(JSON.stringify({ a: 1 }))
    expect(mockFetch.mock.calls[0]![1].body).toBe(`[{"a":1}]`)
  })
})
