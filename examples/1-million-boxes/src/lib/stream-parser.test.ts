import { beforeEach, describe, expect, it } from "vitest"
import { StreamParser, encodeEvent, parseStreamRecords } from "./stream-parser"
import type { GameEvent } from "./game-state"

describe(`parseStreamRecords`, () => {
  it(`parses empty array`, () => {
    const events = parseStreamRecords(new Uint8Array(0))
    expect(events).toEqual([])
  })

  it(`parses single record`, () => {
    // edgeId=100, teamId=2 => (100 << 2) | 2 = 402 = 0x000192
    const bytes = new Uint8Array([0x00, 0x01, 0x92])
    const events = parseStreamRecords(bytes)

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ edgeId: 100, teamId: 2 })
  })

  it(`parses multiple records`, () => {
    // Record 1: edgeId=0, teamId=0 => 0x000000
    // Record 2: edgeId=1, teamId=1 => (1 << 2) | 1 = 5 = 0x000005
    // Record 3: edgeId=2, teamId=2 => (2 << 2) | 2 = 10 = 0x00000A
    const bytes = new Uint8Array([
      0x00,
      0x00,
      0x00, // Record 1
      0x00,
      0x00,
      0x05, // Record 2
      0x00,
      0x00,
      0x0a, // Record 3
    ])

    const events = parseStreamRecords(bytes)

    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({ edgeId: 0, teamId: 0 })
    expect(events[1]).toEqual({ edgeId: 1, teamId: 1 })
    expect(events[2]).toEqual({ edgeId: 2, teamId: 2 })
  })

  it(`ignores partial record at end`, () => {
    // 4 bytes = 1 complete record + 1 partial byte
    const bytes = new Uint8Array([0x00, 0x01, 0x92, 0xff])
    const events = parseStreamRecords(bytes)

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ edgeId: 100, teamId: 2 })
  })

  it(`ignores 2-byte partial record at end`, () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x92, 0xff, 0xff])
    const events = parseStreamRecords(bytes)

    expect(events).toHaveLength(1)
  })

  it(`parses maximum edge ID correctly`, () => {
    // Max edge ID is 2,001,999 (EDGE_COUNT - 1)
    // (2001999 << 2) | 3 = 8007999 = 0x7A31BF
    const edgeId = 2001999
    const teamId = 3
    const packed = (edgeId << 2) | teamId

    const bytes = new Uint8Array([
      (packed >> 16) & 0xff,
      (packed >> 8) & 0xff,
      packed & 0xff,
    ])

    const events = parseStreamRecords(bytes)
    expect(events[0]).toEqual({ edgeId: 2001999, teamId: 3 })
  })

  it(`parses all team IDs correctly`, () => {
    const bytes = new Uint8Array([
      0x00,
      0x00,
      0x00, // teamId=0
      0x00,
      0x00,
      0x05, // edgeId=1, teamId=1
      0x00,
      0x00,
      0x0a, // edgeId=2, teamId=2
      0x00,
      0x00,
      0x0f, // edgeId=3, teamId=3
    ])

    const events = parseStreamRecords(bytes)

    expect(events[0].teamId).toBe(0)
    expect(events[1].teamId).toBe(1)
    expect(events[2].teamId).toBe(2)
    expect(events[3].teamId).toBe(3)
  })
})

describe(`encodeEvent`, () => {
  it(`encodes edgeId=0, teamId=0`, () => {
    const bytes = encodeEvent({ edgeId: 0, teamId: 0 })
    expect(bytes).toEqual(new Uint8Array([0x00, 0x00, 0x00]))
  })

  it(`encodes edgeId=100, teamId=2`, () => {
    const bytes = encodeEvent({ edgeId: 100, teamId: 2 })
    // (100 << 2) | 2 = 402 = 0x000192
    expect(bytes).toEqual(new Uint8Array([0x00, 0x01, 0x92]))
  })

  it(`encodes maximum edge ID`, () => {
    const bytes = encodeEvent({ edgeId: 2001999, teamId: 3 })
    // (2001999 << 2) | 3 = 8007999
    const packed = (2001999 << 2) | 3
    expect(bytes).toEqual(
      new Uint8Array([
        (packed >> 16) & 0xff,
        (packed >> 8) & 0xff,
        packed & 0xff,
      ])
    )
  })

  it(`round-trips with parseStreamRecords`, () => {
    const events: Array<GameEvent> = [
      { edgeId: 0, teamId: 0 },
      { edgeId: 12345, teamId: 1 },
      { edgeId: 1000000, teamId: 2 },
      { edgeId: 2001999, teamId: 3 },
    ]

    for (const event of events) {
      const encoded = encodeEvent(event)
      const parsed = parseStreamRecords(encoded)
      expect(parsed).toHaveLength(1)
      expect(parsed[0]).toEqual(event)
    }
  })
})

describe(`StreamParser`, () => {
  let parser: StreamParser

  beforeEach(() => {
    parser = new StreamParser()
  })

  it(`parses complete record from single chunk`, () => {
    const chunk = new Uint8Array([0x00, 0x01, 0x92])
    const events = parser.feed(chunk)

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ edgeId: 100, teamId: 2 })
  })

  it(`handles record split across two chunks`, () => {
    // First chunk: 2 bytes of first record
    const chunk1 = new Uint8Array([0x00, 0x01])
    const events1 = parser.feed(chunk1)
    expect(events1).toHaveLength(0)
    expect(parser.getBufferedBytes()).toBe(2)

    // Second chunk: remaining 1 byte of first record
    const chunk2 = new Uint8Array([0x92])
    const events2 = parser.feed(chunk2)
    expect(events2).toHaveLength(1)
    expect(events2[0]).toEqual({ edgeId: 100, teamId: 2 })
    expect(parser.getBufferedBytes()).toBe(0)
  })

  it(`handles record split across three chunks`, () => {
    const chunk1 = new Uint8Array([0x00])
    const chunk2 = new Uint8Array([0x01])
    const chunk3 = new Uint8Array([0x92])

    expect(parser.feed(chunk1)).toHaveLength(0)
    expect(parser.feed(chunk2)).toHaveLength(0)
    expect(parser.feed(chunk3)).toHaveLength(1)
  })

  it(`handles chunk with partial record at end`, () => {
    // 5 bytes = 1 complete record + 2 bytes of next record
    const chunk = new Uint8Array([0x00, 0x01, 0x92, 0x00, 0x00])
    const events = parser.feed(chunk)

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ edgeId: 100, teamId: 2 })
    expect(parser.getBufferedBytes()).toBe(2)
  })

  it(`completes partial record from previous chunk`, () => {
    // First: 1 complete + 2 partial
    const chunk1 = new Uint8Array([0x00, 0x01, 0x92, 0x00, 0x00])
    const events1 = parser.feed(chunk1)
    expect(events1).toHaveLength(1)

    // Second: complete the partial
    const chunk2 = new Uint8Array([0x05])
    const events2 = parser.feed(chunk2)
    expect(events2).toHaveLength(1)
    expect(events2[0]).toEqual({ edgeId: 1, teamId: 1 })
  })

  it(`handles multiple records in single chunk`, () => {
    const chunk = new Uint8Array([
      0x00,
      0x00,
      0x00, // edgeId=0, teamId=0
      0x00,
      0x00,
      0x05, // edgeId=1, teamId=1
      0x00,
      0x00,
      0x0a, // edgeId=2, teamId=2
    ])

    const events = parser.feed(chunk)

    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({ edgeId: 0, teamId: 0 })
    expect(events[1]).toEqual({ edgeId: 1, teamId: 1 })
    expect(events[2]).toEqual({ edgeId: 2, teamId: 2 })
  })

  it(`handles empty chunk`, () => {
    const events = parser.feed(new Uint8Array(0))
    expect(events).toHaveLength(0)
  })

  it(`reset clears buffer`, () => {
    parser.feed(new Uint8Array([0x00, 0x01]))
    expect(parser.getBufferedBytes()).toBe(2)

    parser.reset()
    expect(parser.getBufferedBytes()).toBe(0)
  })

  it(`processes many records correctly`, () => {
    // Generate 1000 sequential events
    const count = 1000
    const bytes = new Uint8Array(count * 3)

    for (let i = 0; i < count; i++) {
      const edgeId = i
      const teamId = i % 4
      const packed = (edgeId << 2) | teamId
      bytes[i * 3] = (packed >> 16) & 0xff
      bytes[i * 3 + 1] = (packed >> 8) & 0xff
      bytes[i * 3 + 2] = packed & 0xff
    }

    const events = parser.feed(bytes)

    expect(events).toHaveLength(count)
    for (let i = 0; i < count; i++) {
      expect(events[i].edgeId).toBe(i)
      expect(events[i].teamId).toBe(i % 4)
    }
  })

  it(`handles random chunk sizes`, () => {
    // Create stream of 10 events
    const expectedEvents: Array<GameEvent> = []
    const fullBytes = new Uint8Array(30)

    for (let i = 0; i < 10; i++) {
      const event = { edgeId: i * 100, teamId: i % 4 }
      expectedEvents.push(event)
      const encoded = encodeEvent(event)
      fullBytes.set(encoded, i * 3)
    }

    // Split into random-sized chunks
    const chunks: Array<Uint8Array> = []
    let offset = 0
    while (offset < fullBytes.length) {
      const size = Math.min(
        Math.floor(Math.random() * 5) + 1,
        fullBytes.length - offset
      )
      chunks.push(fullBytes.slice(offset, offset + size))
      offset += size
    }

    // Parse through streaming parser
    const allEvents: Array<GameEvent> = []
    for (const chunk of chunks) {
      allEvents.push(...parser.feed(chunk))
    }

    expect(allEvents).toHaveLength(10)
    expect(allEvents).toEqual(expectedEvents)
  })
})
