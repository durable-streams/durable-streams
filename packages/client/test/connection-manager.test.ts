import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SHORT_POLL_INTERVAL_MS,
  connectionManager,
  shouldUseConnectionPool,
} from "../src/connection-manager"

describe(`ConnectionManager`, () => {
  beforeEach(() => {
    connectionManager.reset()
  })

  afterEach(() => {
    connectionManager.reset()
  })

  describe(`shouldUseConnectionPool`, () => {
    it(`should return true for http:// URLs`, () => {
      expect(shouldUseConnectionPool(`http://localhost:3000/stream`)).toBe(true)
      expect(shouldUseConnectionPool(`http://example.com/api/stream`)).toBe(
        true
      )
    })

    it(`should return false for https:// URLs`, () => {
      expect(shouldUseConnectionPool(`https://example.com/stream`)).toBe(false)
      expect(shouldUseConnectionPool(`https://api.example.com/v1/stream`)).toBe(
        false
      )
    })
  })

  describe(`registration and slot allocation`, () => {
    it(`should give first 4 streams long-poll slots`, () => {
      const streams = [{}, {}, {}, {}]

      for (const stream of streams) {
        connectionManager.register(stream)
      }

      expect(connectionManager.streamCount).toBe(4)
      expect(connectionManager.longPollSlotCount).toBe(4)

      for (const stream of streams) {
        expect(connectionManager.shouldLongPoll(stream)).toBe(true)
      }
    })

    it(`should give 5th+ streams short-poll`, () => {
      const streams = [{}, {}, {}, {}, {}, {}]

      for (const stream of streams) {
        connectionManager.register(stream)
      }

      expect(connectionManager.streamCount).toBe(6)
      expect(connectionManager.longPollSlotCount).toBe(4)

      // First 4 have slots
      expect(connectionManager.shouldLongPoll(streams[0]!)).toBe(true)
      expect(connectionManager.shouldLongPoll(streams[1]!)).toBe(true)
      expect(connectionManager.shouldLongPoll(streams[2]!)).toBe(true)
      expect(connectionManager.shouldLongPoll(streams[3]!)).toBe(true)

      // 5th and 6th don't have slots
      expect(connectionManager.shouldLongPoll(streams[4]!)).toBe(false)
      expect(connectionManager.shouldLongPoll(streams[5]!)).toBe(false)
    })

    it(`should not register the same stream twice`, () => {
      const stream = {}

      connectionManager.register(stream)
      connectionManager.register(stream)

      expect(connectionManager.streamCount).toBe(1)
    })
  })

  describe(`unregistration and slot promotion`, () => {
    it(`should promote next stream when a slot is freed`, () => {
      const streams = [{}, {}, {}, {}, {}]

      for (const stream of streams) {
        connectionManager.register(stream)
      }

      // Stream 5 doesn't have a slot
      expect(connectionManager.shouldLongPoll(streams[4]!)).toBe(false)

      // Unregister stream 1 (has a slot)
      connectionManager.unregister(streams[0]!)

      expect(connectionManager.streamCount).toBe(4)
      expect(connectionManager.longPollSlotCount).toBe(4)

      // Stream 5 should now have the slot
      expect(connectionManager.shouldLongPoll(streams[4]!)).toBe(true)
    })

    it(`should handle unregistering a stream without a slot`, () => {
      const streams = [{}, {}, {}, {}, {}, {}]

      for (const stream of streams) {
        connectionManager.register(stream)
      }

      // Stream 6 doesn't have a slot
      connectionManager.unregister(streams[5]!)

      expect(connectionManager.streamCount).toBe(5)
      expect(connectionManager.longPollSlotCount).toBe(4)
    })
  })

  describe(`activity tracking`, () => {
    it(`should track activity when markActivity is called`, () => {
      const stream = {}
      connectionManager.register(stream)

      // Just verify it doesn't throw
      connectionManager.markActivity(stream)
    })

    it(`should promote most active stream on rebalance`, async () => {
      vi.useFakeTimers()

      const streams = [{}, {}, {}, {}, {}, {}]

      // Register all streams
      for (const stream of streams) {
        connectionManager.register(stream)
      }

      // Stream 5 and 6 don't have slots
      expect(connectionManager.shouldLongPoll(streams[4]!)).toBe(false)
      expect(connectionManager.shouldLongPoll(streams[5]!)).toBe(false)

      // Wait a bit, then mark stream 5 as very active
      await vi.advanceTimersByTimeAsync(100)
      connectionManager.markActivity(streams[4]!)

      // Wait for rebalance interval (2000ms)
      await vi.advanceTimersByTimeAsync(2000)

      // Stream 5 should now have a slot (swapped with least active)
      expect(connectionManager.shouldLongPoll(streams[4]!)).toBe(true)

      // One of the original first 4 should have lost their slot
      const slotsHeld = [
        connectionManager.shouldLongPoll(streams[0]!),
        connectionManager.shouldLongPoll(streams[1]!),
        connectionManager.shouldLongPoll(streams[2]!),
        connectionManager.shouldLongPoll(streams[3]!),
      ].filter(Boolean).length

      expect(slotsHeld).toBe(3) // One should have been demoted

      vi.useRealTimers()
    })
  })

  describe(`shouldLongPoll for unregistered streams`, () => {
    it(`should return true for unregistered streams (safe default)`, () => {
      const stream = {}
      expect(connectionManager.shouldLongPoll(stream)).toBe(true)
    })
  })

  describe(`SHORT_POLL_INTERVAL_MS`, () => {
    it(`should be 250ms`, () => {
      expect(SHORT_POLL_INTERVAL_MS).toBe(250)
    })
  })
})
