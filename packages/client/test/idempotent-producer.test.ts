import { describe, expect, it, vi } from "vitest"
import { DurableStream } from "../src/stream"
import { IdempotentProducer } from "../src/idempotent-producer"

describe(`IdempotentProducer`, () => {
  it(`should merge stream and producer headers on batch requests`, async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "Stream-Next-Offset": `1`,
        },
      })
    )
    const producerHeader = vi.fn().mockResolvedValue(`Bearer producer-token`)
    const stream = new DurableStream({
      url: `https://example.com/stream`,
      contentType: `application/json`,
      fetch: mockFetch,
      headers: {
        Authorization: `Bearer stream-token`,
        "X-Stream": `stream`,
      },
    })
    const producer = new IdempotentProducer(stream, `test-producer`, {
      fetch: mockFetch,
      headers: {
        Authorization: producerHeader,
        "X-Producer": `producer`,
      },
    })

    producer.append(JSON.stringify({ message: `hello` }))
    await producer.flush()

    expect(producerHeader).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockFetch.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: `Bearer producer-token`,
      "X-Stream": `stream`,
      "X-Producer": `producer`,
      "content-type": `application/json`,
      "Producer-Id": `test-producer`,
      "Producer-Seq": `0`,
    })

    await producer.close()
  })

  it(`should merge stream and producer headers on close requests`, async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "Stream-Next-Offset": `1`,
        },
      })
    )
    const stream = new DurableStream({
      url: `https://example.com/stream`,
      contentType: `text/plain`,
      fetch: mockFetch,
      headers: {
        "X-Stream": `stream`,
      },
    })
    const producer = new IdempotentProducer(stream, `test-producer`, {
      fetch: mockFetch,
      headers: {
        "X-Producer": `producer`,
      },
    })

    await producer.close()

    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockFetch.mock.calls[0]![1]?.headers).toMatchObject({
      "X-Stream": `stream`,
      "X-Producer": `producer`,
      "content-type": `text/plain`,
      "Producer-Id": `test-producer`,
      "Producer-Seq": `0`,
      "Stream-Closed": `true`,
    })
  })

  it(`should not allow custom headers to override producer protocol headers`, async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "Stream-Next-Offset": `1`,
        },
      })
    )
    const stream = new DurableStream({
      url: `https://example.com/stream`,
      contentType: `application/json`,
    })
    const producer = new IdempotentProducer(stream, `test-producer`, {
      fetch: mockFetch,
      headers: {
        "content-type": `text/plain`,
        "Producer-Id": `wrong-producer`,
        "Producer-Epoch": `999`,
        "Producer-Seq": `999`,
        "Stream-Closed": `false`,
      },
    })

    producer.append(JSON.stringify({ message: `hello` }))
    await producer.flush()
    await producer.close()

    expect(mockFetch.mock.calls[0]![1]?.headers).toMatchObject({
      "content-type": `application/json`,
      "Producer-Id": `test-producer`,
      "Producer-Epoch": `0`,
      "Producer-Seq": `0`,
    })
    expect(mockFetch.mock.calls[1]![1]?.headers).toMatchObject({
      "content-type": `application/json`,
      "Producer-Id": `test-producer`,
      "Producer-Epoch": `0`,
      "Producer-Seq": `1`,
      "Stream-Closed": `true`,
    })
  })
})
