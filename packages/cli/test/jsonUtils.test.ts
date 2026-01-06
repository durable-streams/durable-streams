import { describe, expect, it } from "vitest"
import { flattenJsonForAppend, isJsonContentType } from "../src/jsonUtils"

describe(`isJsonContentType`, () => {
  it(`returns true for application/json`, () => {
    expect(isJsonContentType(`application/json`)).toBe(true)
  })

  it(`returns true for application/json with charset`, () => {
    expect(isJsonContentType(`application/json; charset=utf-8`)).toBe(true)
  })

  it(`returns true for Application/JSON (case insensitive)`, () => {
    expect(isJsonContentType(`Application/JSON`)).toBe(true)
  })

  it(`returns true with leading/trailing whitespace`, () => {
    expect(isJsonContentType(` application/json `)).toBe(true)
  })

  it(`returns false for text/plain`, () => {
    expect(isJsonContentType(`text/plain`)).toBe(false)
  })

  it(`returns false for application/octet-stream`, () => {
    expect(isJsonContentType(`application/octet-stream`)).toBe(false)
  })

  it(`returns false for application/json-patch+json`, () => {
    expect(isJsonContentType(`application/json-patch+json`)).toBe(false)
  })
})

describe(`flattenJsonForAppend`, () => {
  it(`yields single object as-is`, () => {
    const input = { foo: 1 }
    const result = [...flattenJsonForAppend(input)]
    expect(result).toEqual([{ foo: 1 }])
  })

  it(`yields array elements individually (flattening)`, () => {
    const input = [{ a: 1 }, { b: 2 }]
    const result = [...flattenJsonForAppend(input)]
    expect(result).toEqual([{ a: 1 }, { b: 2 }])
  })

  it(`preserves nested arrays (only flattens one level)`, () => {
    const input = [[{ a: 1 }, { b: 2 }]]
    const result = [...flattenJsonForAppend(input)]
    expect(result).toEqual([[{ a: 1 }, { b: 2 }]])
  })

  it(`handles empty array`, () => {
    const result = [...flattenJsonForAppend([])]
    expect(result).toEqual([])
  })

  it(`handles empty object`, () => {
    const result = [...flattenJsonForAppend({})]
    expect(result).toEqual([{}])
  })

  it(`handles null`, () => {
    const result = [...flattenJsonForAppend(null)]
    expect(result).toEqual([null])
  })

  it(`handles primitive values`, () => {
    expect([...flattenJsonForAppend(`string`)]).toEqual([`string`])
    expect([...flattenJsonForAppend(123)]).toEqual([123])
    expect([...flattenJsonForAppend(true)]).toEqual([true])
  })

  it(`handles array of primitives`, () => {
    const result = [...flattenJsonForAppend([1, 2, 3])]
    expect(result).toEqual([1, 2, 3])
  })

  it(`handles deeply nested structures`, () => {
    const input = { nested: { deep: { value: [1, 2, 3] } } }
    const result = [...flattenJsonForAppend(input)]
    expect(result).toEqual([input])
  })

  it(`handles mixed array`, () => {
    const input = [{ obj: true }, `string`, 42, null, [1, 2]]
    const result = [...flattenJsonForAppend(input)]
    expect(result).toEqual([{ obj: true }, `string`, 42, null, [1, 2]])
  })
})
