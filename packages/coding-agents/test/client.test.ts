import { beforeEach, describe, expect, it, vi } from "vitest"

import { createClient } from "../src/client.js"

const mockAppend = vi.fn()
const mockFlush = vi.fn().mockResolvedValue(undefined)
const mockDetach = vi.fn().mockResolvedValue(undefined)
const mockStreamItems: Array<unknown> = []

vi.mock(`@durable-streams/client`, () => ({
  DurableStream: vi.fn().mockImplementation(function DurableStream() {
    return {
      stream: vi.fn().mockResolvedValue({
        jsonStream: vi.fn().mockImplementation(() => ({
          [Symbol.asyncIterator]() {
            let index = 0
            return {
              next() {
                if (index >= mockStreamItems.length) {
                  return Promise.resolve({
                    done: true as const,
                    value: undefined,
                  })
                }

                const value = mockStreamItems[index++]
                return Promise.resolve({
                  done: false as const,
                  value,
                })
              },
            }
          },
        })),
      }),
    }
  }),
  IdempotentProducer: vi.fn().mockImplementation(function IdempotentProducer() {
    return {
      append: mockAppend,
      flush: mockFlush,
      detach: mockDetach,
    }
  }),
}))

describe(`createClient`, () => {
  const user = { name: `Kyle`, email: `kyle@example.com` }

  beforeEach(() => {
    mockAppend.mockClear()
    mockFlush.mockClear()
    mockDetach.mockClear()
    mockStreamItems.length = 0
  })

  it(`should append a user prompt envelope to the stream`, () => {
    const client = createClient({
      agent: `claude`,
      streamUrl: `https://example.com/v1/stream/test`,
      user,
    })

    client.prompt(`Hello agent`)

    expect(mockAppend).toHaveBeenCalledOnce()
    const written = JSON.parse(mockAppend.mock.calls[0]![0] as string)
    expect(written.direction).toBe(`user`)
    expect(written.user).toEqual(user)
    expect(written.raw.type).toBe(`user_message`)
    expect(written.raw.text).toBe(`Hello agent`)
    expect(written.timestamp).toBeTypeOf(`number`)
  })

  it(`should append a response envelope to the stream`, () => {
    const client = createClient({
      agent: `claude`,
      streamUrl: `https://example.com/v1/stream/test`,
      user,
    })

    client.respond(`req-42`, {
      outcome: { outcome: `selected`, optionId: `allow` },
    })

    expect(mockAppend).toHaveBeenCalledOnce()
    const written = JSON.parse(mockAppend.mock.calls[0]![0] as string)
    expect(written.direction).toBe(`user`)
    expect(written.raw.type).toBe(`control_response`)
    expect(written.raw.response.request_id).toBe(`req-42`)
  })

  it(`should append a cancel envelope to the stream`, () => {
    const client = createClient({
      agent: `claude`,
      streamUrl: `https://example.com/v1/stream/test`,
      user,
    })

    client.cancel()

    expect(mockAppend).toHaveBeenCalledOnce()
    const written = JSON.parse(mockAppend.mock.calls[0]![0] as string)
    expect(written.direction).toBe(`user`)
    expect(written.raw.type).toBe(`interrupt`)
  })

  it(`should normalize streamed agent envelopes`, async () => {
    mockStreamItems.push({
      agent: `claude`,
      direction: `agent`,
      timestamp: Date.now(),
      raw: {
        type: `assistant`,
        message: {
          content: [{ type: `text`, text: `Hello world` }],
        },
      },
    })

    const client = createClient({
      agent: `claude`,
      streamUrl: `https://example.com/v1/stream/test`,
      user,
    })

    const events: Array<unknown> = []
    for await (const event of client.events()) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        direction: `agent`,
        envelope: expect.objectContaining({
          direction: `agent`,
          agent: `claude`,
        }),
        event: {
          type: `assistant_message`,
          content: [{ type: `text`, text: `Hello world` }],
        },
      },
    ])
  })

  it(`should flush and detach the producer on close`, async () => {
    const client = createClient({
      agent: `claude`,
      streamUrl: `https://example.com/v1/stream/test`,
      user,
    })

    await client.close()

    expect(mockFlush).toHaveBeenCalledOnce()
    expect(mockDetach).toHaveBeenCalledOnce()
  })
})
