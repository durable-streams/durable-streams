import { describe, expect, it, vi } from "vitest"
import { DurableStream, IdempotentProducer } from "../src"
import { PRODUCER_EPOCH_HEADER, PRODUCER_SEQ_HEADER } from "../src/constants"
import type { Mock } from "vitest"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe(`IdempotentProducer`, () => {
  it(`waits for seq 0 before pipelining a fresh epoch`, async () => {
    const firstResponse = deferred<Response>()
    const requests: Array<string> = []
    const mockFetch: Mock<typeof fetch> = vi.fn((_input, init) => {
      const headers = new Headers(init?.headers)
      requests.push(
        `${headers.get(PRODUCER_EPOCH_HEADER)}:${headers.get(PRODUCER_SEQ_HEADER)}`
      )

      if (requests.length === 1) {
        return firstResponse.promise
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    })

    const stream = new DurableStream({
      url: `https://example.com/stream`,
      contentType: `application/json`,
    })
    const producer = new IdempotentProducer(stream, `entity-test`, {
      epoch: 2,
      fetch: mockFetch,
      lingerMs: 0,
      maxBatchBytes: 1,
      maxInFlight: 5,
    })

    producer.append(`"a"`)
    producer.append(`"b"`)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toEqual([`2:0`])

    firstResponse.resolve(new Response(null, { status: 200 }))

    await producer.flush()

    expect(requests).toEqual([`2:0`, `2:1`])
  })
})
