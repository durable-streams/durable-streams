import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DurableStream,
  FetchError,
  InvalidSignalError,
  MissingStreamUrlError,
} from "../src/index"
import type { Mock } from "vitest"

describe(`DurableStream`, () => {
  describe(`constructor`, () => {
    it(`should require a URL`, () => {
      expect(() => {
        // @ts-expect-error - testing missing url
        new DurableStream({})
      }).toThrow(MissingStreamUrlError)
    })

    it(`should validate signal is an AbortSignal`, () => {
      expect(() => {
        new DurableStream({
          url: `https://example.com/stream`,
          // @ts-expect-error - testing invalid signal
          signal: `not a signal`,
        })
      }).toThrow(InvalidSignalError)
    })

    it(`should create a stream handle without network IO`, () => {
      const stream = new DurableStream({
        url: `https://example.com/stream`,
      })

      expect(stream.url).toBe(`https://example.com/stream`)
      expect(stream.contentType).toBeUndefined()
    })

    it(`should accept static headers`, () => {
      const stream = new DurableStream({
        url: `https://example.com/stream`,
        headers: { Authorization: `Bearer my-token` },
      })

      expect(stream.url).toBe(`https://example.com/stream`)
    })

    it(`should accept function headers`, () => {
      const stream = new DurableStream({
        url: `https://example.com/stream`,
        headers: { Authorization: () => `Bearer token` },
      })

      expect(stream.url).toBe(`https://example.com/stream`)
    })

    it(`should accept async function headers`, () => {
      const stream = new DurableStream({
        url: `https://example.com/stream`,
        headers: {
          // eslint-disable-next-line @typescript-eslint/require-await
          Authorization: async () => `Bearer token`,
        },
      })

      expect(stream.url).toBe(`https://example.com/stream`)
    })

    it(`should accept custom fetch client`, () => {
      const customFetch = vi.fn()
      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: customFetch,
      })

      expect(stream.url).toBe(`https://example.com/stream`)
    })

    it(`should accept AbortSignal`, () => {
      const controller = new AbortController()
      const stream = new DurableStream({
        url: `https://example.com/stream`,
        signal: controller.signal,
      })

      expect(stream.url).toBe(`https://example.com/stream`)
    })
  })

  describe(`head`, () => {
    let mockFetch: Mock<typeof fetch>

    beforeEach(() => {
      mockFetch = vi.fn()
    })

    it(`should call HEAD on the stream URL`, async () => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: {
            "content-type": `application/json`,
            "Stream-Next-Offset": `1_0`,
            etag: `abc123`,
          },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      const result = await stream.head()

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream`,
        expect.objectContaining({ method: `HEAD` })
      )
      expect(result.exists).toBe(true)
      expect(result.contentType).toBe(`application/json`)
      expect(result.offset).toBe(`1_0`)
      expect(result.etag).toBe(`abc123`)
    })

    it(`should throw FetchError on 404`, async () => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 404,
          statusText: `Not Found`,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      // Note: The backoff wrapper throws FetchError for 4xx errors
      // before DurableStream can convert to DurableStreamError
      await expect(stream.head()).rejects.toThrow(FetchError)
    })

    it(`should update contentType on instance`, async () => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
          },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(stream.contentType).toBeUndefined()
      await stream.head()
      expect(stream.contentType).toBe(`text/plain`)
    })
  })

  describe(`stream`, () => {
    let mockFetch: Mock<typeof fetch>

    beforeEach(() => {
      mockFetch = vi.fn()
    })

    it(`should read data from the stream using stream()`, async () => {
      const responseData = `hello world`
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            "Stream-Next-Offset": `1_11`,
            "Stream-Up-To-Date": `true`,
          },
        })
      )

      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      const response = await handle.stream({ live: false })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`https://example.com/stream`),
        expect.objectContaining({ method: `GET` })
      )

      const text = await response.text()
      expect(text).toBe(responseData)
    })

    it(`should include offset in query params when provided`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            "Stream-Next-Offset": `2_5`,
            "Stream-Up-To-Date": `true`,
          },
        })
      )

      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await handle.stream({ offset: `1_11`, live: false })

      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain(`offset=1_11`)
    })

    it(`should include live mode in query params`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            "Stream-Next-Offset": `1_5`,
            "Stream-Up-To-Date": `true`,
          },
        })
      )

      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await handle.stream({ live: `long-poll` })

      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain(`live=long-poll`)
    })

    it(`should expose upToDate on response`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            "Stream-Next-Offset": `1_5`,
            "Stream-Up-To-Date": `true`,
          },
        })
      )

      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      const response = await handle.stream({ live: false })
      expect(response.upToDate).toBe(true)
    })

    it(`should throw FetchError on 404`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`Not found`, {
          status: 404,
          statusText: `Not Found`,
        })
      )

      const handle = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await expect(handle.stream({ live: false })).rejects.toThrow(FetchError)
    })
  })

  describe(`static methods`, () => {
    it(`DurableStream.connect should validate and return handle`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "content-type": `application/json` },
        })
      )

      const stream = await DurableStream.connect({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(stream.contentType).toBe(`application/json`)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: `HEAD` })
      )
    })

    it(`DurableStream.head should return metadata without handle`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            "Stream-Next-Offset": `5_100`,
          },
        })
      )

      const result = await DurableStream.head({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(result.exists).toBe(true)
      expect(result.contentType).toBe(`text/plain`)
      expect(result.offset).toBe(`5_100`)
    })
  })

  describe(`auth`, () => {
    it(`should include token auth header`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "Stream-Next-Offset": `0` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: { Authorization: `Bearer my-secret-token` },
      })

      await stream.head()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer my-secret-token`,
          }),
        })
      )
    })

    it(`should include custom header names`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "Stream-Next-Offset": `0` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: { "x-api-key": `Bearer my-token` },
      })

      await stream.head()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-api-key": `Bearer my-token`,
          }),
        })
      )
    })

    it(`should include static headers`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "Stream-Next-Offset": `0` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: { Authorization: `Basic abc123` },
      })

      await stream.head()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic abc123`,
          }),
        })
      )
    })

    it(`should resolve async function headers`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "Stream-Next-Offset": `0` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: {
          // eslint-disable-next-line @typescript-eslint/require-await
          Authorization: async () => `Bearer dynamic-token`,
        },
      })

      await stream.head()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer dynamic-token`,
          }),
        })
      )
    })
  })

  describe(`params`, () => {
    it(`should include custom query params`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "Stream-Next-Offset": `0` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        params: {
          tenant: `acme`,
          version: `v1`,
        },
      })

      await stream.head()

      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain(`tenant=acme`)
      expect(calledUrl).toContain(`version=v1`)
    })
  })

  describe(`create`, () => {
    it(`should create a stream with PUT request`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 201,
          headers: { "content-type": `application/json` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await stream.create({ contentType: `application/json` })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          method: `PUT`,
          headers: expect.objectContaining({
            "content-type": `application/json`,
          }),
        })
      )
    })

    it(`should set TTL header when provided`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 201,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await stream.create({ ttlSeconds: 3600 })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Stream-TTL": `3600`,
          }),
        })
      )
    })

    it(`should throw on conflict (409)`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 409,
          statusText: `Conflict`,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await expect(stream.create()).rejects.toThrow()
    })
  })

  describe(`append`, () => {
    it(`should append data with POST request`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        contentType: `text/plain`,
      })

      await stream.append(`hello world`)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: `POST` })
      )
      // Verify body was sent as string
      const callArgs = mockFetch.mock.calls[0]![1] as RequestInit
      expect(callArgs.body).toBe(`hello world`)
    })

    it(`should include seq header when provided`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await stream.append(`data`, { seq: `writer-1-001` })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Stream-Seq": `writer-1-001`,
          }),
        })
      )
    })

    it(`should throw on 404`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 404,
          statusText: `Not Found`,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await expect(stream.append(`data`)).rejects.toThrow(FetchError)
    })

    it(`should throw on seq conflict (409)`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 409,
          statusText: `Conflict`,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await expect(stream.append(`data`, { seq: `old-seq` })).rejects.toThrow()
    })

    it(`should await promise-valued body before sending`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        contentType: `text/plain`,
      })

      // Append a promise that resolves to a string
      await stream.append(Promise.resolve(`promised data`))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callArgs = mockFetch.mock.calls[0]![1] as RequestInit
      // Verify the resolved value was sent as string
      expect(callArgs.body).toBe(`promised data`)
    })

    it(`should await delayed promise before sending`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        contentType: `text/plain`,
      })

      // Append a promise that resolves after a delay
      const delayedPromise = new Promise<string>((resolve) => {
        setTimeout(() => resolve(`delayed data`), 10)
      })
      await stream.append(delayedPromise)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callArgs = mockFetch.mock.calls[0]![1] as RequestInit
      // Verify the resolved value was sent as string
      expect(callArgs.body).toBe(`delayed data`)
    })

    it(`should reject when promise body rejects`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      // Append a promise that rejects
      const failingPromise = Promise.reject(new Error(`Promise failed`))

      await expect(stream.append(failingPromise)).rejects.toThrow(
        `Promise failed`
      )
      // Should not have called fetch since promise rejected
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe(`delete`, () => {
    it(`should delete stream with DELETE request`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await stream.delete()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: `DELETE` })
      )
    })

    it(`should throw on 404`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 404,
          statusText: `Not Found`,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await expect(stream.delete()).rejects.toThrow(FetchError)
    })
  })

  describe(`appendStream`, () => {
    it(`should append streaming data with POST request`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      // Create an async iterable source
      // eslint-disable-next-line @typescript-eslint/require-await
      async function* generateChunks() {
        yield `chunk1`
        yield `chunk2`
        yield `chunk3`
      }

      await stream.appendStream(generateChunks())

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          method: `POST`,
        })
      )
      // Verify body is a ReadableStream
      const callArgs = mockFetch.mock.calls[0]![1] as RequestInit
      expect(callArgs.body).toBeInstanceOf(ReadableStream)
    })

    it(`should include content-type when provided in options`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      // eslint-disable-next-line @typescript-eslint/require-await
      async function* generateChunks() {
        yield `data`
      }

      await stream.appendStream(generateChunks(), { contentType: `text/plain` })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "content-type": `text/plain`,
          }),
        })
      )
    })

    it(`should include seq header when provided`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      // eslint-disable-next-line @typescript-eslint/require-await
      async function* generateChunks() {
        yield `data`
      }

      await stream.appendStream(generateChunks(), { seq: `writer-1-001` })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Stream-Seq": `writer-1-001`,
          }),
        })
      )
    })

    it(`should throw on 404`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 404,
          statusText: `Not Found`,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      // eslint-disable-next-line @typescript-eslint/require-await
      async function* generateChunks() {
        yield `data`
      }

      await expect(stream.appendStream(generateChunks())).rejects.toThrow(
        FetchError
      )
    })

    it(`should throw on seq conflict (409)`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 409,
          statusText: `Conflict`,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      // eslint-disable-next-line @typescript-eslint/require-await
      async function* generateChunks() {
        yield `data`
      }

      await expect(
        stream.appendStream(generateChunks(), { seq: `old-seq` })
      ).rejects.toThrow()
    })

    it(`should accept ReadableStream as source`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(`chunk1`)
          controller.enqueue(`chunk2`)
          controller.close()
        },
      })

      await stream.appendStream(readable)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callArgs = mockFetch.mock.calls[0]![1] as RequestInit
      expect(callArgs.body).toBeInstanceOf(ReadableStream)
    })
  })

  describe(`static delete`, () => {
    it(`should delete stream without creating instance`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      await DurableStream.delete({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: `DELETE` })
      )
    })

    it(`should throw on 404`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 404,
          statusText: `Not Found`,
        })
      )

      await expect(
        DurableStream.delete({
          url: `https://example.com/stream`,
          fetch: mockFetch,
        })
      ).rejects.toThrow(FetchError)
    })

    it(`should include auth headers`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        })
      )

      await DurableStream.delete({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        headers: { Authorization: `Bearer my-token` },
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer my-token`,
          }),
        })
      )
    })
  })
})
