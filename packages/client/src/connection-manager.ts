/**
 * Connection Manager - Internal module for managing HTTP/1.1 connection pooling.
 *
 * HTTP/1.1 browsers limit concurrent connections to ~6 per domain. When many
 * streams are long-polling simultaneously, this can cause connection starvation
 * where some streams get stuck in a queued/pending state.
 *
 * This manager limits the number of concurrent long-polling streams to 4
 * (leaving 2 connections for other requests). Overflow streams use short-polling
 * with a 250ms interval instead, rotating based on activity so the most active
 * streams get long-poll priority.
 *
 * Only applies to http:// URLs (HTTP/1.1). https:// URLs are assumed to use
 * HTTP/2 which handles multiplexing natively.
 *
 * @internal
 */

/** Maximum number of streams that can long-poll simultaneously */
const MAX_LONG_POLL_SLOTS = 4

/** Interval for short-polling when a stream doesn't have a long-poll slot (ms) */
export const SHORT_POLL_INTERVAL_MS = 250

/** How often to re-evaluate slot allocation based on activity (ms) */
const REBALANCE_INTERVAL_MS = 2000

interface StreamState {
  /** Timestamp of last data received */
  lastActivity: number
  /** Whether this stream currently has a long-poll slot */
  hasLongPollSlot: boolean
}

/**
 * Opaque stream identifier - we use the object reference directly
 */
type StreamId = object

/**
 * ConnectionManager tracks active streams and manages long-poll slot allocation.
 *
 * Streams register when they start polling and unregister when closed.
 * The manager decides which streams get long-poll slots vs short-poll fallback.
 */
class ConnectionManager {
  #streams = new Map<StreamId, StreamState>()
  #rebalanceTimer: ReturnType<typeof setInterval> | null = null
  #hasWarnedAboutShortPolling = false
  #isTabVisible = true
  #visibilityListenerAttached = false

  /**
   * Register a stream for connection pool management.
   * Called when a stream starts its polling loop.
   */
  register(streamId: StreamId): void {
    if (this.#streams.has(streamId)) return

    // Attach visibility listener on first registration
    this.#attachVisibilityListener()

    // New streams get a slot if available, otherwise short-poll
    const hasSlot = this.#countLongPollSlots() < MAX_LONG_POLL_SLOTS

    // Warn once when we first need to use short-polling
    if (!hasSlot && !this.#hasWarnedAboutShortPolling) {
      this.#hasWarnedAboutShortPolling = true
      console.warn(
        `[Durable Streams] More than ${MAX_LONG_POLL_SLOTS} streams are active over HTTP/1.1, ` +
          `which limits browsers to ~6 concurrent connections. ` +
          `Some streams will use short-polling (${SHORT_POLL_INTERVAL_MS}ms intervals) instead of long-polling. ` +
          `For better performance, use HTTPS which enables HTTP/2 multiplexing.`
      )
    }

    this.#streams.set(streamId, {
      lastActivity: Date.now(),
      hasLongPollSlot: hasSlot,
    })

    this.#startRebalanceTimerIfNeeded()
  }

  /**
   * Unregister a stream from connection pool management.
   * Called when a stream is closed or cancelled.
   */
  unregister(streamId: StreamId): void {
    const hadSlot = this.#streams.get(streamId)?.hasLongPollSlot ?? false
    this.#streams.delete(streamId)

    // If this stream had a slot, give it to the most active waiting stream
    if (hadSlot) {
      this.#promoteNextStream()
    }

    this.#stopRebalanceTimerIfNotNeeded()
  }

  /**
   * Check if a stream should use long-polling or short-polling.
   * @returns true if the stream has a long-poll slot, false for short-poll
   */
  shouldLongPoll(streamId: StreamId): boolean {
    const state = this.#streams.get(streamId)
    return state?.hasLongPollSlot ?? true // Default to long-poll if not registered
  }

  /**
   * Check if the browser tab is currently visible.
   * When the tab is hidden, streams should pause polling to save resources.
   * @returns true if tab is visible (or if not in a browser environment)
   */
  isTabVisible(): boolean {
    return this.#isTabVisible
  }

  /**
   * Mark that a stream received data. Updates activity timestamp for
   * priority-based slot allocation.
   */
  markActivity(streamId: StreamId): void {
    const state = this.#streams.get(streamId)
    if (state) {
      state.lastActivity = Date.now()
    }
  }

  /**
   * Attach visibility change listener to pause polling when tab is hidden.
   * Only attaches once, and only in browser environments.
   */
  #attachVisibilityListener(): void {
    if (this.#visibilityListenerAttached) return
    if (typeof document === `undefined`) return

    this.#visibilityListenerAttached = true
    this.#isTabVisible = document.visibilityState === `visible`

    document.addEventListener(`visibilitychange`, () => {
      this.#isTabVisible = document.visibilityState === `visible`
    })
  }

  /**
   * Get the number of registered streams (for testing)
   */
  get streamCount(): number {
    return this.#streams.size
  }

  /**
   * Get the number of streams with long-poll slots (for testing)
   */
  get longPollSlotCount(): number {
    return this.#countLongPollSlots()
  }

  #countLongPollSlots(): number {
    let count = 0
    for (const state of this.#streams.values()) {
      if (state.hasLongPollSlot) count++
    }
    return count
  }

  /**
   * Give a long-poll slot to the most recently active stream that doesn't have one.
   */
  #promoteNextStream(): void {
    let bestCandidate: StreamId | null = null
    let bestActivity = 0

    for (const [streamId, state] of this.#streams) {
      if (!state.hasLongPollSlot && state.lastActivity > bestActivity) {
        bestCandidate = streamId
        bestActivity = state.lastActivity
      }
    }

    if (bestCandidate) {
      const state = this.#streams.get(bestCandidate)
      if (state) {
        state.hasLongPollSlot = true
      }
    }
  }

  /**
   * Periodically rebalance slots based on activity.
   * Swap least-active long-poll stream with most-active short-poll stream.
   */
  #rebalance(): void {
    if (this.#streams.size <= MAX_LONG_POLL_SLOTS) return

    // Find least active stream with a slot
    let leastActiveWithSlot: StreamId | null = null
    let leastActivity = Infinity

    // Find most active stream without a slot
    let mostActiveWithoutSlot: StreamId | null = null
    let mostActivity = 0

    for (const [streamId, state] of this.#streams) {
      if (state.hasLongPollSlot) {
        if (state.lastActivity < leastActivity) {
          leastActiveWithSlot = streamId
          leastActivity = state.lastActivity
        }
      } else {
        if (state.lastActivity > mostActivity) {
          mostActiveWithoutSlot = streamId
          mostActivity = state.lastActivity
        }
      }
    }

    // Swap if the waiting stream is more active
    if (
      leastActiveWithSlot &&
      mostActiveWithoutSlot &&
      mostActivity > leastActivity
    ) {
      const demoted = this.#streams.get(leastActiveWithSlot)
      const promoted = this.#streams.get(mostActiveWithoutSlot)
      if (demoted && promoted) {
        demoted.hasLongPollSlot = false
        promoted.hasLongPollSlot = true
      }
    }
  }

  #startRebalanceTimerIfNeeded(): void {
    // Only need rebalancing if we have more streams than slots
    if (this.#streams.size > MAX_LONG_POLL_SLOTS && !this.#rebalanceTimer) {
      this.#rebalanceTimer = setInterval(
        () => this.#rebalance(),
        REBALANCE_INTERVAL_MS
      )
    }
  }

  #stopRebalanceTimerIfNotNeeded(): void {
    if (this.#streams.size <= MAX_LONG_POLL_SLOTS && this.#rebalanceTimer) {
      clearInterval(this.#rebalanceTimer)
      this.#rebalanceTimer = null
    }
  }

  /**
   * Reset the manager state (for testing)
   */
  reset(): void {
    this.#streams.clear()
    this.#hasWarnedAboutShortPolling = false
    if (this.#rebalanceTimer) {
      clearInterval(this.#rebalanceTimer)
      this.#rebalanceTimer = null
    }
  }
}

/**
 * Singleton instance of the connection manager.
 * @internal
 */
export const connectionManager: ConnectionManager = new ConnectionManager()

/**
 * Check if a URL should use connection pooling.
 * Only http:// URLs (HTTP/1.1) need pooling. https:// uses HTTP/2 multiplexing.
 * @internal
 */
export function shouldUseConnectionPool(url: string): boolean {
  return url.startsWith(`http://`)
}
