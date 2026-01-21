import { describe, expect, it } from "vitest"
import { parseGlobalOptions } from "../src/index"

describe(`parseGlobalOptions`, () => {
  it(`returns empty options when no flags provided`, () => {
    const result = parseGlobalOptions([`create`, `my-stream`])
    expect(result.options.auth).toBeUndefined()
    expect(result.remainingArgs).toEqual([`create`, `my-stream`])
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
})
