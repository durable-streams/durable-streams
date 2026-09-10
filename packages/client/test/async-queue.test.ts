import { describe, expect, it, vi } from "vitest"
import { AsyncQueue } from "../src/async-queue"

// Queue scheduling and runtime globals are internal concerns that the JSON
// conformance adapter cannot control.
describe(`AsyncQueue`, () => {
  it(`starts tasks in order and counts waiting and running tasks separately`, async () => {
    const started: Array<number> = []
    const complete = new Map<number, (value: number) => void>()
    const queue = new AsyncQueue<number, number>(
      (task) =>
        new Promise((resolve) => {
          started.push(task)
          complete.set(task, resolve)
        }),
      2
    )
    const results = [queue.push(0), queue.push(1), queue.push(2), queue.push(3)]

    expect(started).toEqual([0, 1])
    expect(queue.running()).toBe(2)
    expect(queue.length()).toBe(2)
    expect(queue.idle()).toBe(false)

    complete.get(1)!(10)
    await results[1]
    expect(started).toEqual([0, 1, 2])
    expect(queue.running()).toBe(2)
    expect(queue.length()).toBe(1)

    complete.get(0)!(0)
    await results[0]
    expect(started).toEqual([0, 1, 2, 3])
    expect(queue.running()).toBe(2)
    expect(queue.length()).toBe(0)

    complete.get(2)!(20)
    complete.get(3)!(30)
    expect(await Promise.all(results)).toEqual([0, 10, 20, 30])
    await queue.drained()
    expect(queue.running()).toBe(0)
    expect(queue.idle()).toBe(true)
  })

  it(`keeps processing after rejection and drains only after the last task`, async () => {
    const failure = new Error(`worker failed`)
    let finishLast!: () => void
    const queue = new AsyncQueue<number>(async (task) => {
      if (task === 0) throw failure
      await new Promise<void>((resolve) => {
        finishLast = resolve
      })
    }, 1)
    const rejected = queue.push(0).catch((error: unknown) => error)
    const last = queue.push(1)
    let drainCount = 0
    const drains = [queue.drained(), queue.drained()].map((drain) =>
      drain.then(() => {
        drainCount++
      })
    )

    expect(await rejected).toBe(failure)
    expect(drainCount).toBe(0)
    expect(queue.running()).toBe(1)
    expect(queue.idle()).toBe(false)

    finishLast()
    await Promise.all([last, ...drains])
    expect(drainCount).toBe(2)
    expect(queue.idle()).toBe(true)
    await queue.drained()
  })

  it(`preserves every task across a large backlog and subsequent reuse`, async () => {
    const started: Array<number> = []
    const queue = new AsyncQueue<number, number>((task) => {
      started.push(task)
      return Promise.resolve(task * 2)
    }, 3)
    const tasks = Array.from({ length: 2500 }, (_, index) => index)

    expect(await Promise.all(tasks.map((task) => queue.push(task)))).toEqual(
      tasks.map((task) => task * 2)
    )
    await queue.drained()
    expect(started).toEqual(tasks)
    expect(await queue.push(2500)).toBe(5000)
    await queue.drained()
    expect(queue.length()).toBe(0)
    expect(queue.running()).toBe(0)
    expect(queue.idle()).toBe(true)
  })

  it(`pushes and drains without a process global`, async () => {
    const queue = new AsyncQueue<number, number>(
      (task) => Promise.resolve(task * 2),
      1
    )
    let results: Array<number>
    vi.stubGlobal(`process`, undefined)
    try {
      await queue.drained()
      const pending = [queue.push(1), queue.push(2)]
      await queue.drained()
      results = await Promise.all(pending)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(results).toEqual([2, 4])
    expect(queue.idle()).toBe(true)
  })
})
