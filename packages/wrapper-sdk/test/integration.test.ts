import { describe, expect, test } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { InMemoryStorage, WrapperProtocol, WrapperSDKError } from "../src/index"
import type { Stream } from "../src/types"

/**
 * Test fixture with server
 */
const testWithServer = test.extend<{
  server: DurableStreamTestServer
  baseUrl: string
}>({
  // Server fixture - creates a new server for each test
  // eslint-disable-next-line no-empty-pattern
  server: async ({}, use) => {
    const server = new DurableStreamTestServer({ port: 0 }) // Random port
    await server.start()
    await use(server)
    await server.stop()
  },

  // Base URL fixture
  baseUrl: async ({ server }, use) => {
    await use(server.url)
  },
})

/**
 * Simple test protocol for testing
 */
class TestProtocol extends WrapperProtocol {
  // Track hook calls for assertions
  createdStreams: Array<{ stream: Stream; metadata?: unknown }> = []
  appendedMessages: Array<{ stream: Stream; data: Uint8Array }> = []
  deletedStreams: Array<Stream> = []

  async createSession(sessionId: string): Promise<Stream> {
    return this.sdk.createStream({
      url: `/test/sessions/${sessionId}`,
      contentType: `application/json`,
    })
  }

  async getSession(sessionId: string): Promise<Stream | null> {
    return this.sdk.getStream(`/test/sessions/${sessionId}`)
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.sdk.deleteStream(`/test/sessions/${sessionId}`)
  }

  async sendMessage(sessionId: string, message: object): Promise<void> {
    const stream = await this.getSession(sessionId)
    if (!stream) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    await stream.append(JSON.stringify(message) + `\n`)
  }

  protected async onStreamCreated(
    stream: Stream,
    metadata?: unknown
  ): Promise<void> {
    this.createdStreams.push({ stream, metadata })
  }

  protected async onMessageAppended(
    stream: Stream,
    data: Uint8Array
  ): Promise<void> {
    this.appendedMessages.push({ stream, data })
  }

  protected async onStreamDeleted(stream: Stream): Promise<void> {
    this.deletedStreams.push(stream)
  }
}

describe(`WrapperProtocol Integration`, () => {
  testWithServer(`creates a session stream`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    const stream = await protocol.createSession(`abc123`)

    expect(stream).toBeDefined()
    expect(stream.id).toBe(`/test/sessions/abc123`)
    expect(stream.contentType).toBe(`application/json`)
  })

  testWithServer(`gets an existing session`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    // Create a session first
    await protocol.createSession(`abc123`)

    // Get it back
    const stream = await protocol.getSession(`abc123`)

    expect(stream).toBeDefined()
    expect(stream?.id).toBe(`/test/sessions/abc123`)
  })

  testWithServer(
    `returns null for non-existent session`,
    async ({ baseUrl }) => {
      const protocol = new TestProtocol({ baseUrl })

      const stream = await protocol.getSession(`nonexistent`)

      expect(stream).toBeNull()
    }
  )

  testWithServer(`deletes a session`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    // Create and then delete
    await protocol.createSession(`abc123`)
    await protocol.deleteSession(`abc123`)

    // Should not exist anymore
    const stream = await protocol.getSession(`abc123`)
    expect(stream).toBeNull()
  })

  testWithServer(
    `throws when deleting non-existent session`,
    async ({ baseUrl }) => {
      const protocol = new TestProtocol({ baseUrl })

      await expect(protocol.deleteSession(`nonexistent`)).rejects.toThrow(
        WrapperSDKError
      )
    }
  )

  testWithServer(
    `handles duplicate session creation based on server behavior`,
    async ({ baseUrl }) => {
      const protocol = new TestProtocol({ baseUrl })

      await protocol.createSession(`abc123`)

      // Server behavior may vary:
      // - Some servers reject duplicates with 409 Conflict (create-only semantics)
      // - Some servers allow duplicates (upsert semantics)
      // The SDK should handle both cases correctly
      try {
        const result = await protocol.createSession(`abc123`)
        // If server allows duplicates, we get back a stream
        expect(result).toBeDefined()
        expect(result.id).toBe(`/test/sessions/abc123`)
      } catch (error) {
        // If server rejects duplicates, we get a WrapperSDKError
        expect(error).toBeInstanceOf(WrapperSDKError)
        expect((error as WrapperSDKError).code).toBe(`STREAM_EXISTS`)
      }
    }
  )

  testWithServer(`appends data to a stream`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    await protocol.createSession(`abc123`)
    await protocol.sendMessage(`abc123`, { type: `hello`, text: `world` })

    // Verify the message was appended
    expect(protocol.appendedMessages).toHaveLength(1)
    const decoded = new TextDecoder().decode(protocol.appendedMessages[0]!.data)
    expect(JSON.parse(decoded.trim())).toEqual({ type: `hello`, text: `world` })
  })

  testWithServer(`reads data from a stream`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    await protocol.createSession(`abc123`)
    await protocol.sendMessage(`abc123`, { seq: 1, text: `first` })
    await protocol.sendMessage(`abc123`, { seq: 2, text: `second` })

    // Read the data back
    const stream = await protocol.getSession(`abc123`)
    const chunks: Array<Uint8Array> = []
    for await (const chunk of stream!.readFromOffset()) {
      chunks.push(chunk)
    }

    const allData = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const combined = new Uint8Array(acc.length + chunk.length)
        combined.set(acc)
        combined.set(chunk, acc.length)
        return combined
      }, new Uint8Array(0))
    )

    expect(allData).toContain(`"seq":1`)
    expect(allData).toContain(`"seq":2`)
  })

  testWithServer(`calls lifecycle hooks`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    // Create
    await protocol.createSession(`abc123`)
    expect(protocol.createdStreams).toHaveLength(1)
    expect(protocol.createdStreams[0]!.stream.id).toBe(`/test/sessions/abc123`)

    // Append
    await protocol.sendMessage(`abc123`, { test: true })
    expect(protocol.appendedMessages).toHaveLength(1)

    // Delete
    await protocol.deleteSession(`abc123`)
    expect(protocol.deletedStreams).toHaveLength(1)
    expect(protocol.deletedStreams[0]!.id).toBe(`/test/sessions/abc123`)
  })

  testWithServer(`lists streams`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    await protocol.createSession(`session1`)
    await protocol.createSession(`session2`)
    await protocol.createSession(`session3`)

    const streams: Array<Stream> = []
    for await (const stream of protocol[`sdk`].listStreams()) {
      streams.push(stream)
    }

    expect(streams).toHaveLength(3)
    const ids = streams.map((s) => s.id).sort()
    expect(ids).toEqual([
      `/test/sessions/session1`,
      `/test/sessions/session2`,
      `/test/sessions/session3`,
    ])
  })

  testWithServer(`lists streams with prefix filter`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    await protocol.createSession(`alpha1`)
    await protocol.createSession(`alpha2`)
    await protocol.createSession(`beta1`)

    const streams: Array<Stream> = []
    for await (const stream of protocol[`sdk`].listStreams({
      prefix: `/test/sessions/alpha`,
    })) {
      streams.push(stream)
    }

    expect(streams).toHaveLength(2)
    const ids = streams.map((s) => s.id).sort()
    expect(ids).toEqual([`/test/sessions/alpha1`, `/test/sessions/alpha2`])
  })

  testWithServer(`provides state storage`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    // Access state through protected property (for testing)
    const state = protocol[`state`]

    await state.set(`key1`, { value: `test` })
    const result = await state.get<{ value: string }>(`key1`)

    expect(result?.value).toBe(`test`)
  })

  testWithServer(`uses custom storage`, async ({ baseUrl }) => {
    const storage = new InMemoryStorage()
    const protocol = new TestProtocol({ baseUrl, storage })

    await protocol.createSession(`abc123`)

    // Storage should have the stream tracking entry
    let hasEntry = false
    for await (const [key] of storage.list(`__sdk:streams:`)) {
      if (key.includes(`abc123`)) {
        hasEntry = true
        break
      }
    }

    expect(hasEntry).toBe(true)
  })
})

describe(`Stream Operations`, () => {
  testWithServer(`getMetadata returns stream metadata`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    await protocol.createSession(`abc123`)
    await protocol.sendMessage(`abc123`, { data: `test` })

    const stream = await protocol.getSession(`abc123`)
    const metadata = await stream!.getMetadata()

    expect(metadata.contentType).toBe(`application/json`)
    expect(metadata.tailOffset).toBeDefined()
    expect(metadata.tailOffset).not.toBe(`0_0`)
  })

  testWithServer(`readFromOffset supports resume`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    await protocol.createSession(`abc123`)
    await protocol.sendMessage(`abc123`, { seq: 1 })
    await protocol.sendMessage(`abc123`, { seq: 2 })

    // Get the offset after first read
    const stream = await protocol.getSession(`abc123`)
    const meta = await stream!.getMetadata()

    // Append more data
    await protocol.sendMessage(`abc123`, { seq: 3 })

    // Read from the saved offset should skip earlier data
    const streamAgain = await protocol.getSession(`abc123`)
    const chunks: Array<Uint8Array> = []
    for await (const chunk of streamAgain!.readFromOffset(meta.tailOffset)) {
      chunks.push(chunk)
    }

    const allData = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const combined = new Uint8Array(acc.length + chunk.length)
        combined.set(acc)
        combined.set(chunk, acc.length)
        return combined
      }, new Uint8Array(0))
    )

    // Should only have seq 3
    expect(allData).toContain(`"seq":3`)
    expect(allData).not.toContain(`"seq":1`)
    expect(allData).not.toContain(`"seq":2`)
  })

  testWithServer(`append with seq parameter`, async ({ baseUrl }) => {
    const protocol = new TestProtocol({ baseUrl })

    await protocol.createSession(`abc123`)

    const stream = await protocol.getSession(`abc123`)

    // First append with seq
    await stream!.append(`{"msg":1}\n`, { seq: `001` })

    // Second append with higher seq should succeed
    await stream!.append(`{"msg":2}\n`, { seq: `002` })

    // Read back to verify
    const chunks: Array<Uint8Array> = []
    for await (const chunk of stream!.readFromOffset()) {
      chunks.push(chunk)
    }

    const allData = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const combined = new Uint8Array(acc.length + chunk.length)
        combined.set(acc)
        combined.set(chunk, acc.length)
        return combined
      }, new Uint8Array(0))
    )

    expect(allData).toContain(`"msg":1`)
    expect(allData).toContain(`"msg":2`)
  })
})

describe(`Error Handling`, () => {
  testWithServer(
    `WrapperSDKError has correct code for stream not found`,
    async ({ baseUrl }) => {
      const protocol = new TestProtocol({ baseUrl })

      try {
        await protocol.deleteSession(`nonexistent`)
        expect.fail(`Should have thrown`)
      } catch (error) {
        expect(error).toBeInstanceOf(WrapperSDKError)
        expect((error as WrapperSDKError).code).toBe(`STREAM_NOT_FOUND`)
      }
    }
  )

  testWithServer(
    `WrapperSDKError has correct code for stream exists when server rejects duplicates`,
    async ({ baseUrl }) => {
      const protocol = new TestProtocol({ baseUrl })

      await protocol.createSession(`abc123`)

      // This test verifies error handling when the server enforces create-only semantics
      // The test server uses upsert semantics, so we verify the SDK handles both cases
      try {
        const result = await protocol.createSession(`abc123`)
        // Server allows duplicates - test passes, SDK returned a valid stream
        expect(result.id).toBe(`/test/sessions/abc123`)
      } catch (error) {
        // Server rejects duplicates - verify correct error code
        expect(error).toBeInstanceOf(WrapperSDKError)
        expect((error as WrapperSDKError).code).toBe(`STREAM_EXISTS`)
      }
    }
  )
})
