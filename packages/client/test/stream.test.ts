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

    it(`should accept auth token`, () => {
      const stream = new DurableStream({
        url: `https://example.com/stream`,
        auth: { token: `my-token` },
      })

      expect(stream.url).toBe(`https://example.com/stream`)
    })

    it(`should accept auth headers`, () => {
      const stream = new DurableStream({
        url: `https://example.com/stream`,
        auth: { headers: { Authorization: `Bearer token` } },
      })

      expect(stream.url).toBe(`https://example.com/stream`)
    })

    it(`should accept async auth headers`, () => {
      const stream = new DurableStream({
        url: `https://example.com/stream`,
        auth: {
          getHeaders: async () => ({ Authorization: `Bearer token` }),
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

  describe(`read`, () => {
    let mockFetch: Mock<typeof fetch>

    beforeEach(() => {
      mockFetch = vi.fn()
    })

    it(`should read data from the stream`, async () => {
      const responseData = `hello world`
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            "Stream-Next-Offset": `1_11`,
          },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      const result = await stream.read()

      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream`,
        expect.objectContaining({ method: `GET` })
      )
      expect(new TextDecoder().decode(result.data)).toBe(responseData)
      expect(result.offset).toBe(`1_11`)
    })

    it(`should include offset in query params when provided`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: { "Stream-Next-Offset": `2_5` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await stream.read({ offset: `1_11` })

      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream?offset=1_11`,
        expect.anything()
      )
    })

    it(`should include live mode in query params`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: { "Stream-Next-Offset": `1_5` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await stream.read({ live: `long-poll` })

      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream?offset=-1&live=long-poll`,
        expect.anything()
      )
    })

    it(`should return upToDate when header is present`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            "Stream-Next-Offset": `1_5`,
            "Stream-Up-To-Date": `true`,
          },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      const result = await stream.read()

      expect(result.upToDate).toBe(true)
    })

    it(`should throw FetchError on 404`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`Not found`, {
          status: 404,
          statusText: `Not Found`,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await expect(stream.read()).rejects.toThrow(FetchError)
    })
  })

  describe(`create`, () => {
    let mockFetch: Mock<typeof fetch>

    beforeEach(() => {
      mockFetch = vi.fn()
    })

    it(`should create stream with PUT`, async () => {
      mockFetch.mockResolvedValue(
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
        `https://example.com/stream`,
        expect.objectContaining({
          method: `PUT`,
          headers: expect.objectContaining({
            "content-type": `application/json`,
          }),
        })
      )
    })

    it(`should throw FetchError on 409`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`Already exists`, {
          status: 409,
          statusText: `Conflict`,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await expect(stream.create()).rejects.toThrow(FetchError)
    })
  })

  describe(`delete`, () => {
    let mockFetch: Mock<typeof fetch>

    beforeEach(() => {
      mockFetch = vi.fn()
    })

    it(`should delete stream with DELETE`, async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 204 }))

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await stream.delete()

      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream`,
        expect.objectContaining({ method: `DELETE` })
      )
    })

    it(`should throw FetchError on 404`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`Not found`, {
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

  describe(`append`, () => {
    let mockFetch: Mock<typeof fetch>

    beforeEach(() => {
      mockFetch = vi.fn()
    })

    it(`should append string data as UTF-8`, async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }))

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await stream.append(`hello world`)

      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream`,
        expect.objectContaining({
          method: `POST`,
          body: expect.any(Uint8Array),
        })
      )

      const call = mockFetch.mock.calls[0]!
      const body = call[1]?.body as Uint8Array
      expect(new TextDecoder().decode(body)).toBe(`hello world`)
    })

    it(`should append Uint8Array directly`, async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }))

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      const data = new Uint8Array([1, 2, 3, 4])
      await stream.append(data)

      const call = mockFetch.mock.calls[0]!
      const body = call[1]?.body as Uint8Array
      expect(body).toEqual(data)
    })

    it(`should include seq header when provided`, async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }))

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await stream.append(`data`, { seq: `123` })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Stream-Seq": `123`,
          }),
        })
      )
    })

    it(`should throw FetchError on 409`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`Sequence conflict`, {
          status: 409,
          statusText: `Conflict`,
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      await expect(stream.append(`data`, { seq: `1` })).rejects.toThrow(
        FetchError
      )
    })
  })

  describe(`static methods`, () => {
    it(`DurableStream.create should create and return handle`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 201,
          headers: { "content-type": `text/plain` },
        })
      )

      const stream = await DurableStream.create({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        contentType: `text/plain`,
      })

      expect(stream).toBeInstanceOf(DurableStream)
      expect(stream.url).toBe(`https://example.com/stream`)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: `PUT` })
      )
    })

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

      expect(stream).toBeInstanceOf(DurableStream)
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

    it(`DurableStream.delete should delete without returning handle`, async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }))

      await DurableStream.delete({
        url: `https://example.com/stream`,
        fetch: mockFetch,
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: `DELETE` })
      )
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
        auth: { token: `my-secret-token` },
      })

      await stream.head()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: `Bearer my-secret-token`,
          }),
        })
      )
    })

    it(`should include custom auth header name`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "Stream-Next-Offset": `0` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        auth: { token: `my-token`, headerName: `x-api-key` },
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

    it(`should include static auth headers`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "Stream-Next-Offset": `0` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        auth: { headers: { Authorization: `Basic abc123` } },
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

    it(`should resolve async auth headers`, async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "Stream-Next-Offset": `0` },
        })
      )

      const stream = new DurableStream({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        auth: {
          getHeaders: async () => ({
            Authorization: `Bearer dynamic-token`,
          }),
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
})
