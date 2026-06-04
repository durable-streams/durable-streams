import { afterEach, describe, expect, it, vi } from "vitest"
import { subscribeToWakeDetection } from "../src/wake-detection"

describe(`subscribeToWakeDetection`, () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it(`does not fire onWake under normal conditions`, () => {
    vi.useFakeTimers()
    const onWake = vi.fn()
    const unsubscribe = subscribeToWakeDetection({ onWake })
    // 5 normal ticks at 2s intervals
    vi.advanceTimersByTime(10_000)
    expect(onWake).not.toHaveBeenCalled()
    unsubscribe()
  })

  it(`fires onWake when time jump detected`, () => {
    // Fake only the timer functions, NOT Date — so we can control Date.now independently
    vi.useFakeTimers({ toFake: [`setInterval`, `clearInterval`] })
    let now = 1000
    vi.spyOn(Date, `now`).mockImplementation(() => now)
    const onWake = vi.fn()
    const unsubscribe = subscribeToWakeDetection({
      onWake,
      intervalMs: 2000,
      thresholdMs: 4000,
    })
    // Normal tick: advance 2s in both fake timers and our mock
    now += 2000
    vi.advanceTimersByTime(2000)
    expect(onWake).not.toHaveBeenCalled()
    // Simulate sleep: jump 10s in Date.now but only fire one timer tick
    now += 10_000
    vi.advanceTimersByTime(2000)
    expect(onWake).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it(`returns unsubscribe function that clears timer`, () => {
    vi.useFakeTimers()
    const onWake = vi.fn()
    const unsubscribe = subscribeToWakeDetection({ onWake })
    unsubscribe()
    vi.advanceTimersByTime(100_000)
    expect(onWake).not.toHaveBeenCalled()
  })

  it(`skips in browser environments`, () => {
    const originalDocument = globalThis.document
    // @ts-expect-error - mock browser environment
    globalThis.document = { hidden: false, addEventListener: vi.fn() }
    try {
      vi.useFakeTimers()
      const onWake = vi.fn()
      const unsubscribe = subscribeToWakeDetection({ onWake })
      unsubscribe()
      // Should be a no-op — no timer created
    } finally {
      globalThis.document = originalDocument
    }
  })
})
