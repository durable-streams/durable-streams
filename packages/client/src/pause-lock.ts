export interface PauseLockOptions {
  onAcquired: () => void
  onReleased: () => void
}

export class PauseLock {
  readonly #holders = new Set<string>()
  readonly #onAcquired: () => void
  readonly #onReleased: () => void

  constructor(options: PauseLockOptions) {
    this.#onAcquired = options.onAcquired
    this.#onReleased = options.onReleased
  }

  acquire(reason: string): void {
    if (this.#holders.has(reason)) {
      console.warn(
        `PauseLock: "${reason}" already held — ignoring duplicate acquire`
      )
      return
    }
    const wasUnlocked = this.#holders.size === 0
    this.#holders.add(reason)
    if (wasUnlocked) {
      this.#onAcquired()
    }
  }

  release(reason: string): void {
    if (!this.#holders.delete(reason)) {
      console.warn(`PauseLock: "${reason}" not held — ignoring orphan release`)
      return
    }
    if (this.#holders.size === 0) {
      this.#onReleased()
    }
  }

  releaseAllMatching(prefix: string): void {
    const sizeBefore = this.#holders.size
    for (const reason of this.#holders) {
      if (reason.startsWith(prefix)) {
        this.#holders.delete(reason)
      }
    }
    if (sizeBefore > 0 && this.#holders.size === 0) {
      this.#onReleased()
    }
  }

  get isPaused(): boolean {
    return this.#holders.size > 0
  }

  isHeldBy(reason: string): boolean {
    return this.#holders.has(reason)
  }
}
