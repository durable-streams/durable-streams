import { describe, expect, it } from "vitest"
import { GameState } from "../../shared/game-state"
import {
  StreamParser,
  encodeEvent,
  parseStreamRecords,
} from "../../shared/stream-parser"
import { EDGE_COUNT, getBoxEdges } from "../../shared/edge-math"
import type { GameEvent } from "../../shared/game-state"

describe(`Stream Replay Integration`, () => {
  describe(`replaying empty stream`, () => {
    it(`creates fresh game state from empty stream`, () => {
      const bytes = new Uint8Array(0)
      const events = parseStreamRecords(bytes)
      const state = new GameState()

      for (const event of events) {
        state.applyEvent(event)
      }

      expect(state.getEdgesPlacedCount()).toBe(0)
      expect(state.getScores()).toEqual([0, 0, 0, 0])
      expect(state.isComplete()).toBe(false)
    })
  })

  describe(`replaying single record`, () => {
    it(`applies single edge placement correctly`, () => {
      const event: GameEvent = { edgeId: 100, teamId: 2 }
      const bytes = encodeEvent(event)
      const events = parseStreamRecords(bytes)
      const state = new GameState()

      for (const evt of events) {
        state.applyEvent(evt)
      }

      expect(state.getEdgesPlacedCount()).toBe(1)
      expect(state.isEdgeTaken(100)).toBe(true)
      expect(state.isEdgeTaken(99)).toBe(false)
      expect(state.isEdgeTaken(101)).toBe(false)
    })

    it(`does not complete any box with single edge`, () => {
      const event: GameEvent = { edgeId: 0, teamId: 0 }
      const bytes = encodeEvent(event)
      const events = parseStreamRecords(bytes)
      const state = new GameState()

      for (const evt of events) {
        state.applyEvent(evt)
      }

      expect(state.getScores()).toEqual([0, 0, 0, 0])
    })
  })

  describe(`replaying multiple records`, () => {
    it(`applies multiple events in sequence`, () => {
      const events: Array<GameEvent> = [
        { edgeId: 0, teamId: 0 },
        { edgeId: 100, teamId: 1 },
        { edgeId: 200, teamId: 2 },
        { edgeId: 300, teamId: 3 },
      ]

      // Encode all events
      const bytes = new Uint8Array(events.length * 3)
      events.forEach((event, i) => {
        bytes.set(encodeEvent(event), i * 3)
      })

      const parsedEvents = parseStreamRecords(bytes)
      const state = new GameState()

      for (const evt of parsedEvents) {
        state.applyEvent(evt)
      }

      expect(state.getEdgesPlacedCount()).toBe(4)
      expect(state.isEdgeTaken(0)).toBe(true)
      expect(state.isEdgeTaken(100)).toBe(true)
      expect(state.isEdgeTaken(200)).toBe(true)
      expect(state.isEdgeTaken(300)).toBe(true)
    })

    it(`completes a box when all four edges are placed`, () => {
      // Get the four edges of box (0, 0)
      const [top, bottom, left, right] = getBoxEdges(0, 0)

      const events: Array<GameEvent> = [
        { edgeId: top, teamId: 0 },
        { edgeId: left, teamId: 1 },
        { edgeId: right, teamId: 2 },
        { edgeId: bottom, teamId: 3 }, // Team 3 completes the box
      ]

      const bytes = new Uint8Array(events.length * 3)
      events.forEach((event, i) => {
        bytes.set(encodeEvent(event), i * 3)
      })

      const parsedEvents = parseStreamRecords(bytes)
      const state = new GameState()

      for (const evt of parsedEvents) {
        state.applyEvent(evt)
      }

      expect(state.getBoxOwner(0)).toBe(4) // Team 3 + 1 = 4
      expect(state.getScore(3)).toBe(1)
    })

    it(`tracks scores for all teams correctly`, () => {
      // Complete 4 boxes, one for each team
      const events: Array<GameEvent> = []

      // Box (0, 0) - completed by team 0
      const box0Edges = getBoxEdges(0, 0)
      events.push(
        { edgeId: box0Edges[0], teamId: 1 },
        { edgeId: box0Edges[1], teamId: 2 },
        { edgeId: box0Edges[2], teamId: 3 },
        { edgeId: box0Edges[3], teamId: 0 } // Team 0 completes
      )

      // Box (2, 0) - completed by team 1
      const box2Edges = getBoxEdges(2, 0)
      events.push(
        { edgeId: box2Edges[0], teamId: 0 },
        { edgeId: box2Edges[1], teamId: 2 },
        { edgeId: box2Edges[2], teamId: 3 },
        { edgeId: box2Edges[3], teamId: 1 } // Team 1 completes
      )

      const bytes = new Uint8Array(events.length * 3)
      events.forEach((event, i) => {
        bytes.set(encodeEvent(event), i * 3)
      })

      const parsedEvents = parseStreamRecords(bytes)
      const state = new GameState()

      for (const evt of parsedEvents) {
        state.applyEvent(evt)
      }

      expect(state.getScore(0)).toBe(1)
      expect(state.getScore(1)).toBe(1)
    })
  })

  describe(`handling partial records`, () => {
    it(`ignores partial record at end of stream`, () => {
      const event: GameEvent = { edgeId: 100, teamId: 2 }
      const fullBytes = encodeEvent(event)

      // Add partial record (only 2 bytes)
      const bytes = new Uint8Array([...fullBytes, 0xff, 0xff])

      const events = parseStreamRecords(bytes)
      const state = new GameState()

      for (const evt of events) {
        state.applyEvent(evt)
      }

      expect(events).toHaveLength(1)
      expect(state.getEdgesPlacedCount()).toBe(1)
    })

    it(`handles streaming parser with partial records correctly`, () => {
      const parser = new StreamParser()
      const state = new GameState()

      // Create 3 events
      const events: Array<GameEvent> = [
        { edgeId: 0, teamId: 0 },
        { edgeId: 1, teamId: 1 },
        { edgeId: 2, teamId: 2 },
      ]

      const fullBytes = new Uint8Array(9)
      events.forEach((event, i) => {
        fullBytes.set(encodeEvent(event), i * 3)
      })

      // Feed in chunks that split records
      const chunk1 = fullBytes.slice(0, 4) // 1 complete + 1 byte
      const chunk2 = fullBytes.slice(4, 7) // completes 2nd, starts 3rd
      const chunk3 = fullBytes.slice(7, 9) // completes 3rd

      for (const evt of parser.feed(chunk1)) {
        state.applyEvent(evt)
      }
      expect(state.getEdgesPlacedCount()).toBe(1)

      for (const evt of parser.feed(chunk2)) {
        state.applyEvent(evt)
      }
      expect(state.getEdgesPlacedCount()).toBe(2)

      for (const evt of parser.feed(chunk3)) {
        state.applyEvent(evt)
      }
      expect(state.getEdgesPlacedCount()).toBe(3)
    })

    it(`buffers partial records correctly`, () => {
      const parser = new StreamParser()

      // Send 1 byte at a time
      const event: GameEvent = { edgeId: 12345, teamId: 2 }
      const bytes = encodeEvent(event)

      expect(parser.feed(new Uint8Array([bytes[0]]))).toHaveLength(0)
      expect(parser.getBufferedBytes()).toBe(1)

      expect(parser.feed(new Uint8Array([bytes[1]]))).toHaveLength(0)
      expect(parser.getBufferedBytes()).toBe(2)

      const events = parser.feed(new Uint8Array([bytes[2]]))
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual(event)
      expect(parser.getBufferedBytes()).toBe(0)
    })
  })

  describe(`replay consistency`, () => {
    it(`produces same state from same event sequence`, () => {
      const events: Array<GameEvent> = Array.from({ length: 100 }, (_, i) => ({
        edgeId: i * 10,
        teamId: i % 4,
      }))

      const bytes = new Uint8Array(events.length * 3)
      events.forEach((event, i) => {
        bytes.set(encodeEvent(event), i * 3)
      })

      // Replay twice
      const state1 = new GameState()
      const state2 = new GameState()

      const parsedEvents = parseStreamRecords(bytes)
      for (const evt of parsedEvents) {
        state1.applyEvent(evt)
        state2.applyEvent(evt)
      }

      expect(state1.getScores()).toEqual(state2.getScores())
      expect(state1.getEdgesPlacedCount()).toEqual(state2.getEdgesPlacedCount())
    })

    it(`streaming and batch parsing produce same result`, () => {
      const events: Array<GameEvent> = Array.from({ length: 50 }, (_, i) => ({
        edgeId: i * 20,
        teamId: i % 4,
      }))

      const bytes = new Uint8Array(events.length * 3)
      events.forEach((event, i) => {
        bytes.set(encodeEvent(event), i * 3)
      })

      // Batch parsing
      const batchState = new GameState()
      for (const evt of parseStreamRecords(bytes)) {
        batchState.applyEvent(evt)
      }

      // Streaming parsing with random chunk sizes
      const streamState = new GameState()
      const parser = new StreamParser()
      let offset = 0
      while (offset < bytes.length) {
        const chunkSize = Math.min(
          Math.floor(Math.random() * 10) + 1,
          bytes.length - offset
        )
        const chunk = bytes.slice(offset, offset + chunkSize)
        for (const evt of parser.feed(chunk)) {
          streamState.applyEvent(evt)
        }
        offset += chunkSize
      }

      expect(batchState.getScores()).toEqual(streamState.getScores())
      expect(batchState.getEdgesPlacedCount()).toEqual(
        streamState.getEdgesPlacedCount()
      )
    })
  })

  describe(`edge cases`, () => {
    it(`handles maximum edge ID`, () => {
      const event: GameEvent = { edgeId: EDGE_COUNT - 1, teamId: 3 }
      const bytes = encodeEvent(event)
      const events = parseStreamRecords(bytes)
      const state = new GameState()

      for (const evt of events) {
        state.applyEvent(evt)
      }

      expect(state.isEdgeTaken(EDGE_COUNT - 1)).toBe(true)
    })

    it(`ignores duplicate edge placements`, () => {
      const events: Array<GameEvent> = [
        { edgeId: 100, teamId: 0 },
        { edgeId: 100, teamId: 1 }, // Duplicate
        { edgeId: 100, teamId: 2 }, // Duplicate
      ]

      const bytes = new Uint8Array(events.length * 3)
      events.forEach((event, i) => {
        bytes.set(encodeEvent(event), i * 3)
      })

      const parsedEvents = parseStreamRecords(bytes)
      const state = new GameState()

      for (const evt of parsedEvents) {
        state.applyEvent(evt)
      }

      // Only first placement should count
      expect(state.getEdgesPlacedCount()).toBe(1)
    })
  })
})
