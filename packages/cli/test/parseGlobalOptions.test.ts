import { describe, expect, it } from "vitest"
import { buildHeaders, parseGlobalOptions } from "../src/index"

describe(`parseGlobalOptions`, () => {
  it(`returns default url when no flags provided`, () => {
    const result = parseGlobalOptions([`create`, `my-stream`])
    expect(result.options.url).toBe(`http://localhost:4437/v1/stream`)
    expect(result.options.auth).toBeUndefined()
    expect(result.remainingArgs).toEqual([`create`, `my-stream`])
  })

  it(`parses --url flag`, () => {
    const result = parseGlobalOptions([
      `--url`,
      `http://example.com:8080`,
      `read`,
      `my-stream`,
    ])
    expect(result.options.url).toBe(`http://example.com:8080`)
    expect(result.remainingArgs).toEqual([`read`, `my-stream`])
  })

  it(`parses --url flag after command`, () => {
    const result = parseGlobalOptions([
      `read`,
      `my-stream`,
      `--url`,
      `https://api.example.com`,
    ])
    expect(result.options.url).toBe(`https://api.example.com`)
    expect(result.remainingArgs).toEqual([`read`, `my-stream`])
  })

  it(`throws when --url has no value`, () => {
    expect(() => parseGlobalOptions([`--url`])).toThrow(
      `--url requires a value`
    )
  })

  it(`throws when --url is followed by another flag`, () => {
    expect(() => parseGlobalOptions([`--url`, `--auth`])).toThrow(
      `--url requires a value`
    )
  })

  it(`throws when --url value is whitespace only`, () => {
    expect(() => parseGlobalOptions([`--url`, `   `])).toThrow(
      `URL cannot be empty`
    )
  })

  it(`parses both --url and --auth together`, () => {
    const result = parseGlobalOptions([
      `--url`,
      `http://example.com`,
      `--auth`,
      `Bearer token`,
      `read`,
      `my-stream`,
    ])
    expect(result.options.url).toBe(`http://example.com`)
    expect(result.options.auth).toBe(`Bearer token`)
    expect(result.remainingArgs).toEqual([`read`, `my-stream`])
  })

  it(`parses --auth flag before command`, () => {
    const result = parseGlobalOptions([
      `--auth`,
      `Bearer token`,
      `read`,
      `my-stream`,
    ])
    expect(result.options.auth).toBe(`Bearer token`)
    expect(result.remainingArgs).toEqual([`read`, `my-stream`])
  })

  it(`parses --auth flag after command`, () => {
    const result = parseGlobalOptions([
      `read`,
      `my-stream`,
      `--auth`,
      `Bearer token`,
    ])
    expect(result.options.auth).toBe(`Bearer token`)
    expect(result.remainingArgs).toEqual([`read`, `my-stream`])
  })

  it(`parses --auth flag between command and stream_id`, () => {
    const result = parseGlobalOptions([
      `read`,
      `--auth`,
      `Bearer token`,
      `my-stream`,
    ])
    expect(result.options.auth).toBe(`Bearer token`)
    expect(result.remainingArgs).toEqual([`read`, `my-stream`])
  })

  it(`throws when --auth has no value`, () => {
    expect(() => parseGlobalOptions([`--auth`])).toThrow(
      `--auth requires a value`
    )
  })

  it(`throws when --auth is followed by another flag`, () => {
    expect(() => parseGlobalOptions([`--auth`, `--json`])).toThrow(
      `--auth requires a value`
    )
  })

  it(`handles Basic auth scheme`, () => {
    const result = parseGlobalOptions([
      `--auth`,
      `Basic dXNlcjpwYXNz`,
      `read`,
      `my-stream`,
    ])
    expect(result.options.auth).toBe(`Basic dXNlcjpwYXNz`)
  })

  it(`handles ApiKey auth scheme`, () => {
    const result = parseGlobalOptions([
      `--auth`,
      `ApiKey abc123`,
      `read`,
      `my-stream`,
    ])
    expect(result.options.auth).toBe(`ApiKey abc123`)
  })

  it(`preserves other flags in remainingArgs`, () => {
    const result = parseGlobalOptions([
      `--auth`,
      `Bearer token`,
      `write`,
      `my-stream`,
      `--json`,
      `{"key": "value"}`,
    ])
    expect(result.options.auth).toBe(`Bearer token`)
    expect(result.remainingArgs).toEqual([
      `write`,
      `my-stream`,
      `--json`,
      `{"key": "value"}`,
    ])
  })

  it(`handles empty args`, () => {
    const result = parseGlobalOptions([])
    expect(result.options.auth).toBeUndefined()
    expect(result.remainingArgs).toEqual([])
  })

  it(`last --auth wins when specified multiple times`, () => {
    const result = parseGlobalOptions([
      `--auth`,
      `Bearer first`,
      `--auth`,
      `Bearer second`,
      `read`,
      `my-stream`,
    ])
    expect(result.options.auth).toBe(`Bearer second`)
  })

  it(`throws when --auth value is whitespace only`, () => {
    expect(() => parseGlobalOptions([`--auth`, `   `])).toThrow(
      `Authorization value cannot be empty`
    )
  })

  it(`throws when --auth value is empty string`, () => {
    expect(() => parseGlobalOptions([`--auth`, ``])).toThrow(
      `--auth requires a value`
    )
  })
})

describe(`buildHeaders`, () => {
  it(`returns Authorization header when auth is provided`, () => {
    const headers = buildHeaders({ auth: `Bearer my-token` })
    expect(headers).toEqual({ Authorization: `Bearer my-token` })
  })

  it(`returns empty object when auth is undefined`, () => {
    const headers = buildHeaders({})
    expect(headers).toEqual({})
  })

  it(`returns empty object when auth is empty string`, () => {
    const headers = buildHeaders({ auth: `` })
    expect(headers).toEqual({})
  })
})
