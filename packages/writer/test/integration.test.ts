/**
 * Integration tests for DurableStream client.
 * Following the Electric client pattern.
 */

import { describe, expect, vi } from "vitest"
import { DurableStream, FetchError } from "../src/index"
import {
  testWithServer,
  testWithStream,
  testWithTextStream,
} from "./support/test-context"
import { collectChunks, decode, encode } from "./support/test-helpers"

// ============================================================================
// Basic Stream Operations
// ============================================================================

describe(`Basic Stream Operations`, () => {
  testWithServer(
    `should create a stream via static method`,
    async ({ baseUrl, aborter }) => {
      const streamPath = `/create-test-${Date.now()}`
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
        signal: aborter.signal,
      })

      expect(stream.url).toBe(`${baseUrl}${streamPath}`)
    }
  )

  testWithServer(
    `should allow idempotent create with same config`,
    async ({ baseUrl, store, aborter }) => {
      const streamPath = `/duplicate-test`
      store.create(streamPath, { contentType: `text/plain` })

      // Should succeed - idempotent create with matching config
      const stream = await DurableStream.create({
        url: `${baseUrl}${streamPath}`,
        contentType: `text/plain`,
        signal: aborter.signal,
      })

      expect(stream.url).toBe(`${baseUrl}${streamPath}`)
    }
  )

  testWithServer(
    `should reject create with different config`,
    async ({ baseUrl, store, aborter }) => {
      const streamPath = `/config-mismatch-test`
      store.create(streamPath, { contentType: `text/plain` })

      // Should fail - different content type
      await expect(
        DurableStream.create({
          url: `${baseUrl}${streamPath}`,
          contentType: `application/json`,
          signal: aborter.signal,
        })
      ).rejects.toThrow(FetchError) // Backoff wrapper throws FetchError for 4xx
    }
  )

  testWithStream(
    `should get stream metadata via head()`,
    async ({ streamUrl, aborter }) => {
      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })
      const result = await stream.head()

      expect(result.exists).toBe(true)
      expect(result.offset).toBeDefined()
    }
  )

  testWithStream(
    `should throw NOT_FOUND for non-existent stream`,
    async ({ baseUrl, aborter }) => {
      const stream = new DurableStream({
        url: `${baseUrl}/does-not-exist`,
        signal: aborter.signal,
      })

      await expect(stream.head()).rejects.toThrow(FetchError)
    }
  )

  testWithStream(
    `should delete a stream`,
    async ({ baseUrl, store, aborter }) => {
      const streamPath = `/delete-test`
      store.create(streamPath, { contentType: `text/plain` })

      const stream = new DurableStream({
        url: `${baseUrl}${streamPath}`,
        signal: aborter.signal,
      })
      await stream.delete()

      expect(store.has(streamPath)).toBe(false)
    }
  )
})

// ============================================================================
// Append Operations
// ============================================================================

describe(`Append Operations`, () => {
  testWithStream(
    `should append string data`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })
      await stream.append(`hello world`)

      const { messages } = store.read(streamPath)
      expect(messages).toHaveLength(1)
      expect(decode(messages[0]!.data)).toBe(`hello world`)
    }
  )

  testWithStream(
    `should append binary data`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })
      const binaryData = new Uint8Array([0x00, 0xff, 0x42, 0x13, 0x37])
      await stream.append(binaryData)

      const { messages } = store.read(streamPath)
      expect(messages).toHaveLength(1)
      expect(messages[0]!.data).toEqual(binaryData)
    }
  )

  testWithStream(
    `should append multiple chunks`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      await stream.append(`chunk1`)
      await stream.append(`chunk2`)
      await stream.append(`chunk3`)

      const { messages } = store.read(streamPath)
      expect(messages).toHaveLength(3)
      expect(decode(messages[0]!.data)).toBe(`chunk1`)
      expect(decode(messages[1]!.data)).toBe(`chunk2`)
      expect(decode(messages[2]!.data)).toBe(`chunk3`)
    }
  )

  testWithStream(
    `should enforce sequence ordering with seq`,
    async ({ streamUrl, aborter }) => {
      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      await stream.append(`first`, { seq: `001` })
      await stream.append(`second`, { seq: `002` })

      // Trying to append with lower seq should fail
      await expect(stream.append(`invalid`, { seq: `001` })).rejects.toThrow(
        FetchError // Backoff wrapper throws FetchError for 409
      )
    }
  )
})

// ============================================================================
// Read Operations
// ============================================================================

describe(`Read Operations`, () => {
  testWithStream(`should read empty stream`, async ({ streamUrl, aborter }) => {
    const stream = new DurableStream({ url: streamUrl, signal: aborter.signal })
    const result = await stream.read()

    expect(result.data).toHaveLength(0)
    expect(result.upToDate).toBe(true)
  })

  testWithStream(
    `should read stream with data`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      store.append(streamPath, encode(`hello`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })
      const result = await stream.read()

      expect(decode(result.data)).toBe(`hello`)
      expect(result.upToDate).toBe(true)
    }
  )

  testWithStream(
    `should read from offset`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      store.append(streamPath, encode(`first`))
      const { messages } = store.read(streamPath)
      const firstOffset = messages[0]!.offset

      store.append(streamPath, encode(`second`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })
      const result = await stream.read({ offset: firstOffset })

      expect(decode(result.data)).toBe(`second`)
    }
  )
})

// ============================================================================
// Follow (Streaming) Operations
// ============================================================================

describe(`Follow Operations`, () => {
  testWithStream(
    `should follow an empty stream and get up-to-date`,
    async ({ streamUrl, aborter }) => {
      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      const chunks = await collectChunks(stream, {
        signal: aborter.signal,
        timeout: 1000,
        stopOnUpToDate: true,
      })

      expect(chunks).toHaveLength(1)
      expect(chunks[0]!.upToDate).toBe(true)
      expect(chunks[0]!.data).toHaveLength(0)
    }
  )

  testWithStream(
    `should follow and receive existing data`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      store.append(streamPath, encode(`existing data`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      const chunks = await collectChunks(stream, {
        signal: aborter.signal,
        timeout: 1000,
        stopOnUpToDate: true,
      })

      expect(chunks).toHaveLength(1)
      expect(decode(chunks[0]!.data)).toBe(`existing data`)
      expect(chunks[0]!.upToDate).toBe(true)
    }
  )

  testWithStream(
    `should follow and receive new data via long-poll`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      let requestCount = 0
      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        requestCount++
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
      })

      const receivedData: Array<string> = []

      // Start following - will make initial request then wait in long-poll
      const followPromise = (async () => {
        for await (const chunk of stream.follow({
          live: `long-poll`,
          signal: aborter.signal,
        })) {
          if (chunk.data.length > 0) {
            receivedData.push(decode(chunk.data))
            aborter.abort()
            break
          }
        }
      })()

      // Wait for at least one request to be in flight
      await vi.waitFor(() => expect(requestCount).toBeGreaterThanOrEqual(1))

      // Append data while client is waiting in long-poll
      store.append(streamPath, encode(`new data`))

      await followPromise

      // Should have received the data
      expect(receivedData).toContain(`new data`)
    }
  )

  testWithStream(
    `should catchup mode stop after up-to-date`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      // Start with some existing data
      store.append(streamPath, encode(`data1`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      const receivedData: Array<string> = []
      let sawUpToDate = false
      let receivedFirstData = false

      // Start catchup - should get existing data and stop
      const catchupPromise = (async () => {
        for await (const chunk of stream.follow({
          live: `catchup`,
          signal: aborter.signal,
        })) {
          if (chunk.data.length > 0) {
            receivedData.push(decode(chunk.data))
            receivedFirstData = true
          }
          if (chunk.upToDate) {
            sawUpToDate = true
            break
          }
        }
      })()

      // Wait until we've received the first data chunk
      await vi.waitFor(() => expect(receivedFirstData).toBe(true))

      // Add more data while catchup is running
      store.append(streamPath, encode(`data2`))

      await catchupPromise

      // Should have caught up to all data and stopped
      expect(sawUpToDate).toBe(true)
      expect(receivedData).toContain(`data1`)
      // May or may not contain data2 depending on timing, but should have stopped
    }
  )

  testWithStream(
    `should resume from saved offset`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      const stream1 = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      // Start following the empty stream
      const firstSessionData: Array<string> = []
      let savedOffset = ``
      let upToDateReceived = false
      const aborter1 = new AbortController()

      const firstSessionPromise = (async () => {
        for await (const chunk of stream1.follow({ signal: aborter1.signal })) {
          if (chunk.upToDate) {
            upToDateReceived = true
          }
          if (chunk.data.length > 0) {
            firstSessionData.push(decode(chunk.data))
          }
          savedOffset = chunk.offset
          // Stop after receiving 2 chunks of data
          if (firstSessionData.length >= 2) {
            aborter1.abort()
            break
          }
        }
      })()

      // Wait until stream is up-to-date before appending first chunk
      await vi.waitFor(() => expect(upToDateReceived).toBe(true))
      store.append(streamPath, encode(`chunk1`))

      // Wait until first chunk is received before appending second
      await vi.waitFor(() => expect(firstSessionData.length).toBe(1))
      store.append(streamPath, encode(`chunk2`))

      await firstSessionPromise

      expect(firstSessionData).toEqual([`chunk1`, `chunk2`])
      expect(savedOffset).not.toBe(``)

      // Append more data after first session ended
      store.append(streamPath, encode(`chunk3`))

      // Resume from saved offset - should only get new data
      const stream2 = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      const secondSessionData: Array<string> = []
      for await (const chunk of stream2.follow({
        offset: savedOffset,
        live: `catchup`,
        signal: aborter.signal,
      })) {
        if (chunk.data.length > 0) {
          secondSessionData.push(decode(chunk.data))
        }
        if (chunk.upToDate) break
      }

      // Second session should only have chunk3 (not chunk1 or chunk2)
      expect(secondSessionData).toEqual([`chunk3`])
    }
  )
})

// ============================================================================
// Long-Poll Behavior
// ============================================================================

describe(`Long-Poll Behavior`, () => {
  testWithStream(
    `should make multiple requests and receive data arriving during long-poll`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      let requestCount = 0

      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        requestCount++
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
      })

      const receivedData: Array<string> = []

      // Start following - will make initial request, then wait in long-poll
      const followPromise = (async () => {
        for await (const chunk of stream.follow({
          live: `long-poll`,
          signal: aborter.signal,
        })) {
          if (chunk.data.length > 0) {
            receivedData.push(decode(chunk.data))
          }
          // Stop after receiving 2 data chunks
          if (receivedData.length >= 2) {
            aborter.abort()
            break
          }
        }
      })()

      // Wait for initial request to be made
      await vi.waitFor(() => expect(requestCount).toBeGreaterThanOrEqual(1))

      // Append data while client is waiting in long-poll
      store.append(streamPath, encode(`long-poll-data-1`))

      // Wait for client to receive first data chunk
      await vi.waitFor(() => expect(receivedData.length).toBe(1))

      // Append more data
      store.append(streamPath, encode(`long-poll-data-2`))

      await followPromise

      // Should have made multiple requests
      expect(requestCount).toBeGreaterThanOrEqual(2)
      // Should have received both pieces of data
      expect(receivedData).toContain(`long-poll-data-1`)
      expect(receivedData).toContain(`long-poll-data-2`)
    }
  )
})

// ============================================================================
// Error Handling
// ============================================================================

describe(`Error Handling`, () => {
  testWithServer(
    `should throw on 404 for non-existent stream`,
    async ({ baseUrl, aborter }) => {
      const stream = new DurableStream({
        url: `${baseUrl}/not-found`,
        signal: aborter.signal,
      })

      await expect(stream.read()).rejects.toThrow(FetchError)
    }
  )

  testWithStream(
    `should invoke onError callback on error`,
    async ({ baseUrl, aborter }) => {
      const errorSpy = vi.fn()

      const stream = new DurableStream({
        url: `${baseUrl}/not-found`,
        signal: aborter.signal,
        onError: (error) => {
          errorSpy(error)
          // Don't retry
          return undefined
        },
      })

      try {
        for await (const _chunk of stream.follow({ signal: aborter.signal })) {
          // Should error
        }
      } catch {
        // Expected
      }

      expect(errorSpy).toHaveBeenCalled()
    }
  )

  testWithStream(
    `should retry on error when onError returns {}`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      let requestCount = 0
      let errorCount = 0

      // Create a fetch wrapper that fails first 2 times with 400 (not 5xx)
      // 5xx errors are handled by the backoff mechanism internally
      // 4xx errors escape to onError callback
      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        requestCount++
        if (requestCount <= 2) {
          return new Response(`Bad Request`, { status: 400 })
        }
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
        onError: () => {
          errorCount++
          return {} // Retry
        },
      })

      const receivedData: Array<string> = []

      // Start following - will fail twice with 400, onError returns {} to retry
      const followPromise = (async () => {
        for await (const chunk of stream.follow({ signal: aborter.signal })) {
          if (chunk.data.length > 0) {
            receivedData.push(decode(chunk.data))
          }
          if (receivedData.length >= 1) {
            aborter.abort()
            break
          }
        }
      })()

      // Wait for both errors to occur (retries after 400s)
      await vi.waitFor(() => expect(errorCount).toBeGreaterThanOrEqual(2))

      // Append data while client is following after successful retry
      store.append(streamPath, encode(`retry-data`))

      await followPromise

      // Should have called onError at least twice (for the 400 errors)
      expect(errorCount).toBeGreaterThanOrEqual(2)
      // Should have eventually received the data
      expect(receivedData).toContain(`retry-data`)
    }
  )
})

// ============================================================================
// Headers and Authentication
// ============================================================================

describe(`Headers and Authentication`, () => {
  testWithStream(
    `should attach custom headers`,
    async ({ streamUrl, aborter }) => {
      const capturedHeaders: Array<Record<string, string>> = []

      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        const init = args[1]
        if (init?.headers) {
          capturedHeaders.push(init.headers as Record<string, string>)
        }
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
        headers: {
          "X-Custom-Header": `custom-value`,
          Authorization: `Bearer test-token`,
        },
      })

      await stream.read()

      expect(capturedHeaders.length).toBeGreaterThan(0)
      expect(capturedHeaders[0]).toMatchObject({
        "X-Custom-Header": `custom-value`,
        Authorization: `Bearer test-token`,
      })
    }
  )

  testWithStream(`should use auth token`, async ({ streamUrl, aborter }) => {
    const capturedHeaders: Array<Record<string, string>> = []

    const fetchWrapper = async (
      ...args: Parameters<typeof fetch>
    ): Promise<Response> => {
      const init = args[1]
      if (init?.headers) {
        capturedHeaders.push(init.headers as Record<string, string>)
      }
      return fetch(...args)
    }

    const stream = new DurableStream({
      url: streamUrl,
      signal: aborter.signal,
      fetch: fetchWrapper,
      auth: { token: `my-secret-token` },
    })

    await stream.read()

    expect(capturedHeaders[0]).toMatchObject({
      authorization: `Bearer my-secret-token`,
    })
  })

  testWithStream(
    `should update headers on retry via onError in follow()`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      const capturedHeaders: Array<Record<string, string>> = []
      let requestCount = 0

      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        const init = args[1]
        if (init?.headers) {
          capturedHeaders.push({ ...(init.headers as Record<string, string>) })
        }
        requestCount++
        if (requestCount === 1) {
          // First request returns 401
          return new Response(`Unauthorized`, { status: 401 })
        }
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
        headers: { Authorization: `Bearer old-token` },
        backoffOptions: {
          initialDelay: 10,
          maxDelay: 50,
          multiplier: 1.5,
        },
        onError: (error) => {
          if (error instanceof FetchError && error.status === 401) {
            return { headers: { Authorization: `Bearer new-token` } }
          }
          return undefined
        },
      })

      const receivedData: Array<string> = []

      // Start following - first request will fail with 401, retry with new token
      const followPromise = (async () => {
        for await (const chunk of stream.follow({ signal: aborter.signal })) {
          if (chunk.data.length > 0) {
            receivedData.push(decode(chunk.data))
          }
          if (receivedData.length >= 1) {
            aborter.abort()
            break
          }
        }
      })()

      // Wait for retry with new token (request count increases after 401)
      await vi.waitFor(() => expect(requestCount).toBeGreaterThanOrEqual(2))

      // Append data while client is following with new token
      store.append(streamPath, encode(`auth-data`))

      await followPromise

      // Should have received the data after auth refresh
      expect(receivedData).toContain(`auth-data`)

      // First request should have old token
      expect(capturedHeaders[0]).toMatchObject({
        Authorization: `Bearer old-token`,
      })

      // Later request should have new token (after onError returned new headers)
      expect(capturedHeaders.length).toBeGreaterThan(1)
      const lastHeaders = capturedHeaders[capturedHeaders.length - 1]
      expect(lastHeaders).toMatchObject({
        Authorization: `Bearer new-token`,
      })
    }
  )
})

// ============================================================================
// Query Parameters
// ============================================================================

describe(`Query Parameters`, () => {
  testWithStream(
    `should attach custom params`,
    async ({ streamUrl, aborter }) => {
      const capturedUrls: Array<string> = []

      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        const url =
          args[0] instanceof Request ? args[0].url : args[0].toString()
        capturedUrls.push(url)
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
        params: {
          custom_param: `custom_value`,
          another: `param`,
        },
      })

      await stream.read()

      const url = new URL(capturedUrls[0]!)
      expect(url.searchParams.get(`custom_param`)).toBe(`custom_value`)
      expect(url.searchParams.get(`another`)).toBe(`param`)
    }
  )
})

// ============================================================================
// Abort Signal Handling
// ============================================================================

describe(`Abort Signal Handling`, () => {
  testWithStream(
    `should abort follow on signal abort`,
    async ({ streamUrl }) => {
      const aborter = new AbortController()
      let upToDateReceived = false

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      const followPromise = (async () => {
        const chunks: Array<unknown> = []
        for await (const chunk of stream.follow({ signal: aborter.signal })) {
          chunks.push(chunk)
          if (chunk.upToDate) {
            upToDateReceived = true
          }
        }
        return chunks
      })()

      // Wait until stream is up-to-date before aborting
      await vi.waitFor(() => expect(upToDateReceived).toBe(true))
      aborter.abort()

      // Should complete without throwing
      const chunks = await followPromise
      expect(Array.isArray(chunks)).toBe(true)
    }
  )

  testWithStream(`should abort read on signal abort`, async ({ streamUrl }) => {
    const aborter = new AbortController()
    const stream = new DurableStream({ url: streamUrl })

    // Abort immediately
    aborter.abort()

    // Read with aborted signal should throw
    await expect(stream.read({ signal: aborter.signal })).rejects.toThrow()
  })
})

// ============================================================================
// ReadableStream Conversion
// ============================================================================

describe(`ReadableStream Conversion`, () => {
  testWithStream(
    `should convert follow to ReadableStream and receive async data`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      let requestCount = 0
      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        requestCount++
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
      })
      const readableStream = stream.toReadableStream({ signal: aborter.signal })

      const reader = readableStream.getReader()
      let sawUpToDate = false

      // Read chunks until we get one with actual data
      // (first chunk may be empty up-to-date marker)
      const readWithDataPromise = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        while (true) {
          const { value, done } = await reader.read()
          if (done) return { value: undefined, done: true }
          if (value.upToDate) {
            sawUpToDate = true
          }
          if (value.data.length > 0) {
            return { value, done: false }
          }
        }
      })()

      // Wait until stream is up-to-date (first request completed)
      await vi.waitFor(() => expect(sawUpToDate).toBe(true))

      // Append data while reader is waiting in long-poll
      store.append(streamPath, encode(`stream data`))

      const { value, done } = await readWithDataPromise

      expect(done).toBe(false)
      expect(value).toBeDefined()
      expect(decode(value!.data)).toBe(`stream data`)
      expect(requestCount).toBeGreaterThanOrEqual(1)

      reader.releaseLock()
      await readableStream.cancel()
    }
  )

  testWithStream(
    `should convert follow to byte stream and receive async data`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      let requestCount = 0
      let sawEmptyChunk = false

      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        requestCount++
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
      })
      const byteStream = stream.toByteStream({ signal: aborter.signal })

      const reader = byteStream.getReader()

      // Read chunks until we get one with actual data
      // (first chunk may be empty up-to-date marker)
      const readWithDataPromise = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        while (true) {
          const { value, done } = await reader.read()
          if (done) return { value: undefined, done: true }
          if (value.length === 0) {
            sawEmptyChunk = true
          }
          if (value.length > 0) {
            return { value, done: false }
          }
        }
      })()

      // Wait until we've seen the empty chunk (up-to-date)
      await vi.waitFor(() => expect(sawEmptyChunk).toBe(true))

      // Append data while reader is waiting in long-poll
      store.append(streamPath, encode(`byte data`))

      const { value, done } = await readWithDataPromise

      expect(done).toBe(false)
      expect(value).toBeDefined()
      expect(decode(value)).toBe(`byte data`)
      expect(requestCount).toBeGreaterThanOrEqual(1)

      reader.releaseLock()
      await byteStream.cancel()
    }
  )
})

// ============================================================================
// Convenience Methods
// ============================================================================

describe(`Convenience Methods`, () => {
  testWithTextStream(
    `should iterate as text and receive async data`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      let requestCount = 0
      const fetchWrapper = async (
        ...args: Parameters<typeof fetch>
      ): Promise<Response> => {
        requestCount++
        return fetch(...args)
      }

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
        fetch: fetchWrapper,
      })

      const texts: Array<string> = []

      // Start iterating as text - will wait for data
      const textPromise = (async () => {
        for await (const text of stream.text({
          live: `long-poll`,
          signal: aborter.signal,
        })) {
          texts.push(text)
          if (texts.length >= 2) {
            aborter.abort()
            break
          }
        }
      })()

      // Wait for first request to complete (stream is now waiting)
      await vi.waitFor(() => expect(requestCount).toBeGreaterThanOrEqual(1))

      // Append text data while iterator is waiting
      store.append(streamPath, encode(`line1\n`))

      // Wait for first text to be received
      await vi.waitFor(() => expect(texts.length).toBe(1))

      // Append more text data
      store.append(streamPath, encode(`line2\n`))

      await textPromise

      expect(texts.join(``)).toContain(`line1`)
      expect(texts.join(``)).toContain(`line2`)
    }
  )
})
