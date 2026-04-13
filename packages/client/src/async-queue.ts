/**
 * Concurrency-limited async task queue.
 *
 * Replacement for fastq that works in all JS runtimes (browsers, Deno, Bun,
 * Workers, etc.) without depending on process.nextTick. Promise .then()
 * microtask scheduling provides equivalent "don't call back synchronously"
 * guarantees.
 *
 * Uses a head-pointer instead of Array.shift() for O(1) dequeue amortised.
 */

interface QueueEntry<T, R> {
  task: T
  resolve: (r: R) => void
  reject: (e: unknown) => void
}

export class AsyncQueue<T, R = void> {
  #worker: (task: T) => Promise<R>
  #concurrency: number
  #running = 0
  #queue: Array<QueueEntry<T, R>> = []
  #head = 0
  #drainResolvers: Array<() => void> = []

  constructor(worker: (task: T) => Promise<R>, concurrency: number) {
    this.#worker = worker
    this.#concurrency = concurrency
  }

  push(task: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.#queue.push({ task, resolve, reject })
      this.#processNext()
    })
  }

  /**
   * Number of tasks queued plus currently running.
   */
  length(): number {
    return this.#queue.length - this.#head + this.#running
  }

  /**
   * True when nothing is queued or running.
   */
  idle(): boolean {
    return this.#head >= this.#queue.length && this.#running === 0
  }

  /**
   * Resolves when every queued and in-flight task has completed.
   * Resolves immediately if the queue is already idle.
   */
  async drained(): Promise<void> {
    if (this.idle()) return
    return new Promise<void>((resolve) => {
      this.#drainResolvers.push(resolve)
    })
  }

  #processNext(): void {
    while (
      this.#running < this.#concurrency &&
      this.#head < this.#queue.length
    ) {
      const item = this.#queue[this.#head]!
      this.#queue[this.#head] = undefined as unknown as QueueEntry<T, R>
      this.#head++

      // Compact when the consumed portion exceeds both 1024 slots and half
      // the array, to avoid unbounded memory growth on long-lived queues.
      if (this.#head > 1024 && this.#head > this.#queue.length >>> 1) {
        this.#queue = this.#queue.slice(this.#head)
        this.#head = 0
      }

      this.#running++
      this.#worker(item.task).then(
        (result) => {
          this.#running--
          item.resolve(result)
          this.#checkDrained()
          this.#processNext()
        },
        (error) => {
          this.#running--
          item.reject(error)
          this.#checkDrained()
          this.#processNext()
        }
      )
    }
  }

  #checkDrained(): void {
    if (this.idle()) {
      const resolvers = this.#drainResolvers
      this.#drainResolvers = []
      for (const r of resolvers) r()
    }
  }
}
