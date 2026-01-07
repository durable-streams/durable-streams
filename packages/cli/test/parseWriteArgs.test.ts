import { describe, expect, it } from "vitest"
import { parseWriteArgs } from "../src/parseWriteArgs"

describe(`parseWriteArgs`, () => {
  it(`returns default content-type and batchJson=false when no flags provided`, () => {
    const result = parseWriteArgs([`hello`, `world`])
    expect(result.contentType).toBe(`application/octet-stream`)
    expect(result.content).toBe(`hello world`)
    expect(result.batchJson).toBe(false)
  })

  it(`parses --json flag`, () => {
    const result = parseWriteArgs([`--json`, `{"key": "value"}`])
    expect(result.contentType).toBe(`application/json`)
    expect(result.content).toBe(`{"key": "value"}`)
  })

  it(`parses --json flag after content`, () => {
    const result = parseWriteArgs([`{"key": "value"}`, `--json`])
    expect(result.contentType).toBe(`application/json`)
    expect(result.content).toBe(`{"key": "value"}`)
  })

  it(`parses --content-type flag`, () => {
    const result = parseWriteArgs([`--content-type`, `text/plain`, `hello`])
    expect(result.contentType).toBe(`text/plain`)
    expect(result.content).toBe(`hello`)
  })

  it(`parses --content-type flag after content`, () => {
    const result = parseWriteArgs([`hello`, `--content-type`, `text/plain`])
    expect(result.contentType).toBe(`text/plain`)
    expect(result.content).toBe(`hello`)
  })

  it(`--content-type overrides --json when specified last`, () => {
    const result = parseWriteArgs([
      `--json`,
      `--content-type`,
      `text/csv`,
      `data`,
    ])
    expect(result.contentType).toBe(`text/csv`)
  })

  it(`--json overrides --content-type when specified last`, () => {
    const result = parseWriteArgs([
      `--content-type`,
      `text/csv`,
      `--json`,
      `data`,
    ])
    expect(result.contentType).toBe(`application/json`)
  })

  it(`throws when --content-type has no value`, () => {
    expect(() => parseWriteArgs([`--content-type`])).toThrow(
      `--content-type requires a value`
    )
  })

  it(`throws when --content-type is followed by another flag`, () => {
    expect(() => parseWriteArgs([`--content-type`, `--json`])).toThrow(
      `--content-type requires a value`
    )
  })

  it(`returns empty content when only flags provided`, () => {
    const result = parseWriteArgs([`--json`])
    expect(result.contentType).toBe(`application/json`)
    expect(result.content).toBe(``)
  })

  it(`handles content with spaces`, () => {
    const result = parseWriteArgs([`hello`, `world`, `foo`, `bar`])
    expect(result.content).toBe(`hello world foo bar`)
  })

  it(`throws on unknown flags`, () => {
    expect(() => parseWriteArgs([`--unknown`, `hello`])).toThrow(
      `unknown flag: --unknown`
    )
  })

  it(`parses --batch-json flag`, () => {
    const result = parseWriteArgs([`--batch-json`, `--json`, `[1, 2, 3]`])
    expect(result.batchJson).toBe(true)
    expect(result.contentType).toBe(`application/json`)
    expect(result.content).toBe(`[1, 2, 3]`)
  })

  it(`parses --batch-json flag after content`, () => {
    const result = parseWriteArgs([`--json`, `[1, 2, 3]`, `--batch-json`])
    expect(result.batchJson).toBe(true)
    expect(result.contentType).toBe(`application/json`)
    expect(result.content).toBe(`[1, 2, 3]`)
  })

  it(`batchJson defaults to false with --json`, () => {
    const result = parseWriteArgs([`--json`, `{"key": "value"}`])
    expect(result.batchJson).toBe(false)
  })

  it(`--batch-json alone sets content-type to application/json`, () => {
    const result = parseWriteArgs([`--batch-json`, `[1, 2, 3]`])
    expect(result.batchJson).toBe(true)
    expect(result.contentType).toBe(`application/json`)
    expect(result.content).toBe(`[1, 2, 3]`)
  })
})
