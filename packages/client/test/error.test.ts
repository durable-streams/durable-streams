import { describe, expect, it, vi } from "vitest"
import {
  DurableStreamError,
  FetchBackoffAbortError,
  FetchError,
  InvalidSignalError,
  MissingStreamUrlError,
} from "../src/error"

describe(`FetchError`, () => {
  it(`should create a FetchError with the correct properties`, () => {
    const status = 404
    const text = `Not Found`
    const json = undefined
    const headers = { "content-type": `text/plain` }
    const url = `https://example.com/notfound`

    const error = new FetchError(status, text, json, headers, url)

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe(`FetchError`)
    expect(error.status).toBe(status)
    expect(error.text).toBe(text)
    expect(error.json).toBe(json)
    expect(error.headers).toEqual(headers)
    expect(error.url).toBe(url)
    expect(error.message).toBe(
      `HTTP Error 404 at https://example.com/notfound: Not Found`
    )
  })

  it(`should create a FetchError with a JSON response and use the JSON in the message`, () => {
    const status = 500
    const text = undefined
    const json = { error: `Internal Server Error` }
    const headers = { "content-type": `application/json` }
    const url = `https://example.com/servererror`

    const error = new FetchError(status, text, json, headers, url)

    expect(error.status).toBe(status)
    expect(error.text).toBeUndefined()
    expect(error.json).toEqual(json)
    expect(error.headers).toEqual(headers)
    expect(error.message).toBe(
      `HTTP Error 500 at https://example.com/servererror: {"error":"Internal Server Error"}`
    )
  })

  it(`should create a FetchError with a custom message if provided`, () => {
    const status = 403
    const text = `Forbidden`
    const json = undefined
    const headers = { "content-type": `text/plain` }
    const url = `https://example.com/forbidden`
    const customMessage = `Custom Error Message`

    const error = new FetchError(
      status,
      text,
      json,
      headers,
      url,
      customMessage
    )

    expect(error.message).toBe(customMessage)
  })

  describe(`fromResponse`, () => {
    it(`should create a FetchError from a text-based response`, async () => {
      const mockResponse = {
        status: 404,
        headers: new Headers({ "content-type": `text/plain` }),
        text: vi.fn().mockResolvedValue(`Not Found`),
        bodyUsed: false,
      } as unknown as Response

      const url = `https://example.com/notfound`
      const error = await FetchError.fromResponse(mockResponse, url)

      expect(mockResponse.text).toHaveBeenCalled()
      expect(error).toBeInstanceOf(FetchError)
      expect(error.status).toBe(404)
      expect(error.text).toBe(`Not Found`)
      expect(error.json).toBeUndefined()
      expect(error.headers).toEqual({ "content-type": `text/plain` })
      expect(error.message).toBe(
        `HTTP Error 404 at https://example.com/notfound: Not Found`
      )
    })

    it(`should create a FetchError from a JSON-based response`, async () => {
      const mockResponse = {
        status: 500,
        headers: new Headers({ "content-type": `application/json` }),
        json: vi.fn().mockResolvedValue({ error: `Internal Server Error` }),
        bodyUsed: false,
      } as unknown as Response

      const url = `https://example.com/servererror`
      const error = await FetchError.fromResponse(mockResponse, url)

      expect(mockResponse.json).toHaveBeenCalled()
      expect(error).toBeInstanceOf(FetchError)
      expect(error.status).toBe(500)
      expect(error.text).toBeUndefined()
      expect(error.json).toEqual({ error: `Internal Server Error` })
      expect(error.headers).toEqual({ "content-type": `application/json` })
      expect(error.message).toBe(
        `HTTP Error 500 at https://example.com/servererror: {"error":"Internal Server Error"}`
      )
    })

    it(`should handle content-type not set in response headers`, async () => {
      const mockResponse = {
        status: 500,
        headers: new Headers(),
        text: vi.fn().mockResolvedValue(`Server error with no content-type`),
        bodyUsed: false,
      } as unknown as Response

      const url = `https://example.com/no-content-type`
      const error = await FetchError.fromResponse(mockResponse, url)

      expect(mockResponse.text).toHaveBeenCalled()
      expect(error).toBeInstanceOf(FetchError)
      expect(error.status).toBe(500)
      expect(error.text).toBe(`Server error with no content-type`)
      expect(error.json).toBeUndefined()
    })

    it(`should not read body if already consumed`, async () => {
      const mockResponse = {
        status: 500,
        headers: new Headers({ "content-type": `text/plain` }),
        text: vi.fn(),
        bodyUsed: true,
      } as unknown as Response

      const url = `https://example.com/already-consumed`
      const error = await FetchError.fromResponse(mockResponse, url)

      expect(mockResponse.text).not.toHaveBeenCalled()
      expect(error).toBeInstanceOf(FetchError)
      expect(error.status).toBe(500)
      expect(error.text).toBeUndefined()
    })

    it(`should fall back to text if JSON parsing fails`, async () => {
      const mockResponse = {
        status: 400,
        headers: new Headers({ "content-type": `application/json` }),
        json: vi.fn().mockRejectedValue(new Error(`Invalid JSON`)),
        text: vi.fn().mockResolvedValue(`not valid json`),
        bodyUsed: false,
      } as unknown as Response

      const url = `https://example.com/bad-json`
      const error = await FetchError.fromResponse(mockResponse, url)

      expect(mockResponse.json).toHaveBeenCalled()
      expect(mockResponse.text).toHaveBeenCalled()
      expect(error.text).toBe(`not valid json`)
      expect(error.json).toBeUndefined()
    })
  })
})

describe(`FetchBackoffAbortError`, () => {
  it(`should create error with correct name and message`, () => {
    const error = new FetchBackoffAbortError()

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe(`FetchBackoffAbortError`)
    expect(error.message).toBe(`Fetch with backoff aborted`)
  })
})

describe(`DurableStreamError`, () => {
  it(`should create error with code and status`, () => {
    const error = new DurableStreamError(`Not found`, `NOT_FOUND`, 404)

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe(`DurableStreamError`)
    expect(error.code).toBe(`NOT_FOUND`)
    expect(error.status).toBe(404)
    expect(error.message).toBe(`Not found`)
  })

  it(`should create error with details`, () => {
    const details = { field: `id`, reason: `invalid format` }
    const error = new DurableStreamError(
      `Bad request`,
      `BAD_REQUEST`,
      400,
      details
    )

    expect(error.code).toBe(`BAD_REQUEST`)
    expect(error.status).toBe(400)
    expect(error.details).toEqual(details)
  })

  describe(`fromResponse`, () => {
    it(`should create error from text response`, async () => {
      const mockResponse = {
        status: 404,
        statusText: `Not Found`,
        headers: new Headers({ "content-type": `text/plain` }),
        text: vi.fn().mockResolvedValue(`Resource not found`),
        bodyUsed: false,
      } as unknown as Response

      const error = await DurableStreamError.fromResponse(
        mockResponse,
        `https://example.com/stream`
      )

      expect(error.code).toBe(`NOT_FOUND`)
      expect(error.status).toBe(404)
      expect(error.details).toBe(`Resource not found`)
    })

    it(`should create error from JSON response`, async () => {
      const mockResponse = {
        status: 400,
        statusText: `Bad Request`,
        headers: new Headers({ "content-type": `application/json` }),
        json: vi.fn().mockResolvedValue({ error: `Invalid offset format` }),
        bodyUsed: false,
      } as unknown as Response

      const error = await DurableStreamError.fromResponse(
        mockResponse,
        `https://example.com/stream`
      )

      expect(error.code).toBe(`BAD_REQUEST`)
      expect(error.status).toBe(400)
      expect(error.details).toEqual({ error: `Invalid offset format` })
    })

    it(`should map status codes to correct error codes`, async () => {
      const testCases = [
        { status: 400, expectedCode: `BAD_REQUEST` },
        { status: 401, expectedCode: `UNAUTHORIZED` },
        { status: 403, expectedCode: `FORBIDDEN` },
        { status: 404, expectedCode: `NOT_FOUND` },
        { status: 409, expectedCode: `CONFLICT_SEQ` },
        { status: 429, expectedCode: `RATE_LIMITED` },
        { status: 503, expectedCode: `BUSY` },
        { status: 500, expectedCode: `UNKNOWN` },
      ]

      for (const { status, expectedCode } of testCases) {
        const mockResponse = {
          status,
          statusText: `Test`,
          headers: new Headers(),
          text: vi.fn().mockResolvedValue(``),
          bodyUsed: false,
        } as unknown as Response

        const error = await DurableStreamError.fromResponse(
          mockResponse,
          `https://example.com`
        )

        expect(error.code).toBe(expectedCode)
      }
    })
  })

  describe(`fromFetchError`, () => {
    it(`should create DurableStreamError from FetchError`, () => {
      const fetchError = new FetchError(
        404,
        `Not Found`,
        undefined,
        {},
        `https://example.com`
      )

      const error = DurableStreamError.fromFetchError(fetchError)

      expect(error.code).toBe(`NOT_FOUND`)
      expect(error.status).toBe(404)
      expect(error.details).toBe(`Not Found`)
    })

    it(`should use JSON details when available`, () => {
      const fetchError = new FetchError(
        400,
        undefined,
        { error: `Bad format` },
        {},
        `https://example.com`
      )

      const error = DurableStreamError.fromFetchError(fetchError)

      expect(error.details).toEqual({ error: `Bad format` })
    })
  })
})

describe(`MissingStreamUrlError`, () => {
  it(`should create error with correct name and message`, () => {
    const error = new MissingStreamUrlError()

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe(`MissingStreamUrlError`)
    expect(error.message).toBe(
      `Invalid stream options: missing required url parameter`
    )
  })
})

describe(`InvalidSignalError`, () => {
  it(`should create error with correct name and message`, () => {
    const error = new InvalidSignalError()

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe(`InvalidSignalError`)
    expect(error.message).toBe(
      `Invalid signal option. It must be an instance of AbortSignal.`
    )
  })
})
