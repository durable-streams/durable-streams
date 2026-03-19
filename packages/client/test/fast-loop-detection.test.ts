import { describe, expect, it, vi } from "vitest"
import { FastLoopDetector } from "../src/fast-loop-detection"

describe(`FastLoopDetector`, () => {
  it(`returns ok for requests at different offsets`, () => {
    const detector = new FastLoopDetector()
    expect(detector.check(`0_0`).action).toBe(`ok`)
    expect(detector.check(`1_0`).action).toBe(`ok`)
    expect(detector.check(`2_0`).action).toBe(`ok`)
  })

  it(`returns ok when same offset but under threshold`, () => {
    const detector = new FastLoopDetector({ threshold: 5 })
    for (let i = 0; i < 4; i++) {
      expect(detector.check(`0_0`).action).toBe(`ok`)
    }
  })

  it(`returns clear-and-reset on first detection`, () => {
    const detector = new FastLoopDetector({ threshold: 5, windowMs: 10000 })
    for (let i = 0; i < 4; i++) {
      detector.check(`0_0`)
    }
    const result = detector.check(`0_0`)
    expect(result.action).toBe(`clear-and-reset`)
  })

  it(`returns backoff on detections 2-4`, () => {
    const detector = new FastLoopDetector({ threshold: 5, windowMs: 10000 })
    // First detection
    for (let i = 0; i < 5; i++) detector.check(`0_0`)
    // Second detection
    for (let i = 0; i < 5; i++) detector.check(`0_0`)
    const result = detector.check(`0_0`)
    // Should be backoff (consecutiveCount === 2, not yet fatal)
    // Actually, after clear-and-reset clears entries, need 5 more
    // The exact flow: 5 checks → clear-and-reset (entries cleared, count=1)
    // Then 5 more checks → count=2 → backoff
    expect(result.action).toBe(`backoff`)
  })

  it(`returns fatal after maxCount detections`, () => {
    const detector = new FastLoopDetector({
      threshold: 5,
      windowMs: 10000,
      maxCount: 5,
    })
    // Drive enough checks to exhaust maxCount detections
    let fatalReturned = false
    for (let i = 0; i < 30; i++) {
      const result = detector.check(`0_0`)
      if (result.action === `fatal`) {
        fatalReturned = true
        break
      }
    }
    expect(fatalReturned).toBe(true)
  })

  it(`reset clears all state`, () => {
    const detector = new FastLoopDetector({ threshold: 5, windowMs: 10000 })
    for (let i = 0; i < 4; i++) detector.check(`0_0`)
    detector.reset()
    // After reset, should be back to ok
    expect(detector.check(`0_0`).action).toBe(`ok`)
  })

  it(`prunes entries older than window`, () => {
    vi.useFakeTimers()
    const detector = new FastLoopDetector({ threshold: 5, windowMs: 500 })
    for (let i = 0; i < 4; i++) detector.check(`0_0`)
    // Advance past window
    vi.advanceTimersByTime(600)
    // Old entries pruned, starts fresh
    expect(detector.check(`0_0`).action).toBe(`ok`)
    vi.useRealTimers()
  })
})
