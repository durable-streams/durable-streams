import { describe, expect, it } from "vitest"
import { parseSSEStream } from "../src/sse.js"

describe(`SSE parsing error handling`, () => {
  it(`should throw PARSE_ERROR on malformed control event JSON`, async () => {
    const encoder = new TextEncoder()
    const malformedSSE = `event: control
data: {invalid json here

`

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(malformedSSE))
        controller.close()
      },
    })

    const events: Array<unknown> = []
    let thrownError: Error | null = null

    try {
      for await (const event of parseSSEStream(stream)) {
        events.push(event)
      }
    } catch (err) {
      thrownError = err as Error
    }

    expect(thrownError).not.toBeNull()
    expect(thrownError?.message).toContain(`Failed to parse SSE control event`)
    expect((thrownError as any)?.code).toBe(`PARSE_ERROR`)
  })

  it(`should throw PARSE_ERROR on empty control event data`, async () => {
    const encoder = new TextEncoder()
    const emptyControlSSE = `event: control
data: 

`

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(emptyControlSSE))
        controller.close()
      },
    })

    const events: Array<unknown> = []
    let thrownError: Error | null = null

    try {
      for await (const event of parseSSEStream(stream)) {
        events.push(event)
      }
    } catch (err) {
      thrownError = err as Error
    }

    expect(thrownError).not.toBeNull()
    expect(thrownError?.message).toContain(`Failed to parse SSE control event`)
    expect((thrownError as any)?.code).toBe(`PARSE_ERROR`)
  })
})
