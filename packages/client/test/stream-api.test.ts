import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  FetchError,
  STREAM_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
  StreamHandle,
  stream,
} from "../src/index"
import type { Mock } from "vitest"

describe(`stream() function`, () => {
  let mockFetch: Mock<typeof fetch>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  describe(`basic functionality`, () => {
    it(`should make the first request and return a StreamResponse`, async () => {
      const responseData = JSON.stringify([{ message: `hello` }])
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_20`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(res.url).toBe(`https://example.com/stream`)
      expect(res.contentType).toBe(`application/json`)
      expect(res.live).toBe(`auto`)
      expect(res.startOffset).toBe(`-1`)
    })

    it(`should throw on 404`, async () => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 404,
          statusText: `Not Found`,
        })
      )

      // Note: The backoff wrapper throws FetchError for 4xx errors
      // before we can convert to DurableStreamError
      await expect(
        stream({
          url: `https://example.com/stream`,
          fetchClient: mockFetch,
        })
      ).rejects.toThrow(FetchError)
    })

    it(`should respect offset option`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `2_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        offset: `1_5`,
      })

      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream?offset=1_5`,
        expect.anything()
      )
    })

    it(`should set live query param for explicit modes`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`data`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_5`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: `long-poll`,
      })

      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream?offset=-1&live=long-poll`,
        expect.anything()
      )
    })
  })

  describe(`StreamResponse consumption`, () => {
    it(`should accumulate text with text()`, async () => {
      const responseData = `hello world`
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            [STREAM_OFFSET_HEADER]: `1_11`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      const text = await res.text()
      expect(text).toBe(`hello world`)
    })

    it(`should accumulate JSON with json()`, async () => {
      const items = [{ id: 1 }, { id: 2 }]
      const responseData = JSON.stringify(items)
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_30`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream<{ id: number }>({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      const result = await res.json()
      expect(result).toEqual(items)
    })

    it(`should throw when json() is called on non-JSON content`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`plain text`, {
          status: 200,
          headers: {
            "content-type": `text/plain`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
      })

      await expect(res.json()).rejects.toThrow()
    })

    it(`should iterate byte chunks with for await`, async () => {
      const responseData = `chunk data`
      mockFetch.mockResolvedValue(
        new Response(responseData, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      const chunks = []
      for await (const chunk of res) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBe(1)
      expect(chunks[0]!.offset).toBe(`1_10`)
      expect(chunks[0]!.upToDate).toBe(true)
    })

    it(`should iterate JSON items with jsonItems()`, async () => {
      const items = [{ msg: `a` }, { msg: `b` }]
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(items), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_30`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const res = await stream<{ msg: string }>({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        live: false,
      })

      const collected = []
      for await (const item of res.jsonItems()) {
        collected.push(item)
      }

      expect(collected).toEqual(items)
    })
  })

  describe(`auth`, () => {
    it(`should include token auth header`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`ok`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_2`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        auth: { token: `my-token` },
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: `Bearer my-token`,
          }),
        })
      )
    })

    it(`should include custom headers`, async () => {
      mockFetch.mockResolvedValue(
        new Response(`ok`, {
          status: 200,
          headers: {
            [STREAM_OFFSET_HEADER]: `1_2`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      await stream({
        url: `https://example.com/stream`,
        fetchClient: mockFetch,
        headers: { "x-custom": `value` },
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-custom": `value`,
          }),
        })
      )
    })
  })
})

describe(`StreamHandle`, () => {
  let mockFetch: Mock<typeof fetch>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  describe(`stream() method`, () => {
    it(`should start a stream session using handle URL and auth`, async () => {
      // First call for connect HEAD
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "content-type": `application/json` },
        })
      )

      // Second call for stream GET
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "content-type": `application/json`,
            [STREAM_OFFSET_HEADER]: `1_10`,
            [STREAM_UP_TO_DATE_HEADER]: `true`,
          },
        })
      )

      const handle = await StreamHandle.connect({
        url: `https://example.com/stream`,
        fetch: mockFetch,
        auth: { token: `handle-token` },
      })

      const res = await handle.stream<{ id: number }>()

      expect(res.url).toBe(`https://example.com/stream`)
      expect(res.contentType).toBe(`application/json`)
    })
  })

  describe(`backward compatibility`, () => {
    it(`should export DurableStream as alias for StreamHandle`, async () => {
      const { DurableStream } = await import(`../src/index`)
      expect(DurableStream).toBe(StreamHandle)
    })
  })
})
