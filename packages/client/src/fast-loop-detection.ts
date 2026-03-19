import type { Offset } from "./types"

export interface FastLoopDetectorOptions {
  windowMs?: number
  threshold?: number
  maxCount?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
}

export type FastLoopResult =
  | { action: `ok` }
  | { action: `clear-and-reset` }
  | { action: `backoff`; delayMs: number }
  | { action: `fatal`; message: string }

export class FastLoopDetector {
  readonly #windowMs: number
  readonly #threshold: number
  readonly #maxCount: number
  readonly #backoffBaseMs: number
  readonly #backoffMaxMs: number
  #entries: Array<{ timestamp: number; offset: Offset }> = []
  #consecutiveCount = 0

  constructor(options: FastLoopDetectorOptions = {}) {
    this.#windowMs = options.windowMs ?? 500
    this.#threshold = options.threshold ?? 5
    this.#maxCount = options.maxCount ?? 5
    this.#backoffBaseMs = options.backoffBaseMs ?? 100
    this.#backoffMaxMs = options.backoffMaxMs ?? 5000
  }

  check(offset: Offset): FastLoopResult {
    const now = Date.now()
    this.#entries = this.#entries.filter(
      (e) => now - e.timestamp < this.#windowMs
    )
    this.#entries.push({ timestamp: now, offset })

    const sameOffsetCount = this.#entries.filter(
      (e) => e.offset === offset
    ).length
    if (sameOffsetCount < this.#threshold) {
      return { action: `ok` }
    }

    this.#consecutiveCount++

    if (this.#consecutiveCount >= this.#maxCount) {
      return {
        action: `fatal`,
        message: `Client is stuck in a fast retry loop at offset ${offset}. This usually indicates a misconfigured proxy or CDN.`,
      }
    }

    if (this.#consecutiveCount === 1) {
      this.#entries = []
      return { action: `clear-and-reset` }
    }

    const maxDelay = Math.min(
      this.#backoffMaxMs,
      this.#backoffBaseMs * Math.pow(2, this.#consecutiveCount)
    )
    const delayMs = Math.max(
      this.#backoffBaseMs,
      Math.floor(Math.random() * maxDelay)
    )
    return { action: `backoff`, delayMs }
  }

  reset(): void {
    this.#entries = []
    this.#consecutiveCount = 0
  }
}
