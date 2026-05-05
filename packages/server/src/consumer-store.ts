/**
 * In-memory state management for Layer 1: Named Consumers.
 * Manages consumer registration, epoch tracking, and offset storage.
 * No references to webhooks or any L2 concept.
 */

import { globMatch } from "./glob"
import type { Consumer, ConsumerState } from "./consumer-types"

const DEFAULT_LEASE_TTL_MS = 60_000 // 1 minute
const INITIAL_CONSUMER_OFFSET = `-1`

/**
 * Compare two offsets. Offsets are fixed-width, zero-padded strings
 * (e.g., "0000000000000001_0000000000000001") that are lexicographically
 * orderable. This is guaranteed by the server's offset generation
 * (see PROTOCOL.md § Offsets). Returns negative if a < b, 0 if equal,
 * positive if a > b.
 */
function compareOffsets(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

export class ConsumerStore {
  private consumers = new Map<string, Consumer>()
  // Index: stream_path -> set of consumer_ids subscribed to that stream
  private streamConsumers = new Map<string, Set<string>>()

  // ============================================================================
  // Consumer CRUD
  // ============================================================================

  /**
   * Register a new consumer. Idempotent if config matches.
   */
  registerConsumer(
    consumerId: string,
    streams: Array<string>,
    getTailOffset: (path: string) => string,
    opts?: {
      namespace?: string
      lease_ttl_ms?: number
    }
  ): { consumer: Consumer; created: boolean } | { error: `CONFIG_MISMATCH` } {
    const existing = this.consumers.get(consumerId)
    if (existing) {
      // Idempotent if config matches; reject on mismatch (same pattern as createSubscription)
      const existingPaths = Array.from(existing.streams.keys()).sort()
      const newPaths = [...streams].sort()
      const configMatch =
        existingPaths.length === newPaths.length &&
        existingPaths.every((p, i) => p === newPaths[i]) &&
        existing.namespace === (opts?.namespace ?? null) &&
        existing.lease_ttl_ms === (opts?.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS)
      if (!configMatch) {
        return { error: `CONFIG_MISMATCH` }
      }
      return { consumer: existing, created: false }
    }

    const streamMap = new Map<string, string>()
    for (const path of streams) {
      // L1 registration starts "before any events", per PROTOCOL.md §6.1.
      // Higher-level behaviors that need tail-based initialization (for example,
      // dynamic secondary subscriptions) use addStreams().
      streamMap.set(path, INITIAL_CONSUMER_OFFSET)
    }

    const consumer: Consumer = {
      consumer_id: consumerId,
      state: `REGISTERED`,
      epoch: 0,
      token: null,
      streams: streamMap,
      namespace: opts?.namespace ?? null,
      lease_ttl_ms: opts?.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS,
      last_ack_at: 0,
      lease_timer: null,
      created_at: Date.now(),
      wake_preference: { type: `none` },
      holder_id: null,
    }

    this.consumers.set(consumerId, consumer)

    // Update stream indexes
    for (const path of streams) {
      this.addStreamIndex(path, consumerId)
    }

    return { consumer, created: true }
  }

  getConsumer(consumerId: string): Consumer | undefined {
    return this.consumers.get(consumerId)
  }

  removeConsumer(consumerId: string): boolean {
    const consumer = this.consumers.get(consumerId)
    if (!consumer) return false

    if (consumer.lease_timer) {
      clearTimeout(consumer.lease_timer)
    }

    for (const path of consumer.streams.keys()) {
      this.removeStreamIndex(path, consumerId)
    }

    this.consumers.delete(consumerId)
    return true
  }

  // ============================================================================
  // Epoch Management
  // ============================================================================

  /**
   * Acquire epoch for a consumer. Increments epoch and transitions to READING.
   * If already READING, this is a self-supersede (crash recovery) — epoch
   * increments and old token is invalidated.
   * Returns null if consumer doesn't exist.
   * NOTE: Single-process reference server has no contention check (EPOCH_HELD). Self-supersede always
   * succeeds. Multi-server contention is a future concern.
   */
  acquireEpoch(consumerId: string): {
    epoch: number
    prevState: ConsumerState
  } | null {
    const consumer = this.consumers.get(consumerId)
    if (!consumer) return null

    // If already READING, this is a self-supersede (crash recovery).
    // Epoch increments, old token is invalidated.
    consumer.epoch++
    const prevState = consumer.state
    consumer.state = `READING`
    consumer.last_ack_at = Date.now()

    return { epoch: consumer.epoch, prevState }
  }

  /**
   * Release epoch. Transitions consumer from READING to REGISTERED.
   */
  releaseEpoch(consumerId: string): boolean {
    const consumer = this.consumers.get(consumerId)
    if (!consumer || consumer.state !== `READING`) return false

    consumer.state = `REGISTERED`
    consumer.token = null
    consumer.holder_id = null

    if (consumer.lease_timer) {
      clearTimeout(consumer.lease_timer)
      consumer.lease_timer = null
    }

    return true
  }

  // ============================================================================
  // Offset Management
  // ============================================================================

  /**
   * Update acked offsets. Returns error info if offset regresses or is invalid.
   */
  updateOffsets(
    consumer: Consumer,
    offsets: Array<{ path: string; offset: string }>,
    getTailOffset: (path: string) => string
  ): {
    path: string
    code: `OFFSET_REGRESSION` | `INVALID_OFFSET` | `UNKNOWN_STREAM`
  } | null {
    // Validate all offsets before applying any (atomic)
    for (const { path, offset } of offsets) {
      const current = consumer.streams.get(path)
      if (current === undefined) {
        return { path, code: `UNKNOWN_STREAM` }
      }

      // -1 is only valid as a read starting point. Persisting it as an acked
      // cursor would permanently mean "nothing has been consumed".
      if (offset === `-1`) {
        return { path, code: `INVALID_OFFSET` }
      }

      // Check regression
      if (compareOffsets(offset, current) < 0) {
        return { path, code: `OFFSET_REGRESSION` }
      }

      // Check beyond tail
      const tail = getTailOffset(path)
      if (compareOffsets(offset, tail) > 0) {
        return { path, code: `INVALID_OFFSET` }
      }
    }

    // Apply all offsets
    for (const { path, offset } of offsets) {
      if (consumer.streams.has(path)) {
        consumer.streams.set(path, offset)
      }
    }

    consumer.last_ack_at = Date.now()
    return null
  }

  // ============================================================================
  // Stream Management
  // ============================================================================

  /**
   * Add streams to a consumer's subscription.
   */
  addStreams(
    consumer: Consumer,
    paths: Array<string>,
    getTailOffset: (path: string) => string
  ): void {
    for (const path of paths) {
      if (!consumer.streams.has(path)) {
        consumer.streams.set(path, getTailOffset(path))
        this.addStreamIndex(path, consumer.consumer_id)
      }
    }
  }

  /**
   * Remove streams from a consumer. Returns true if consumer has no streams left.
   */
  removeStreams(consumer: Consumer, paths: Array<string>): boolean {
    for (const path of paths) {
      consumer.streams.delete(path)
      this.removeStreamIndex(path, consumer.consumer_id)
    }
    return consumer.streams.size === 0
  }

  /**
   * Get consumer IDs subscribed to a stream.
   */
  getConsumersForStream(streamPath: string): Array<string> {
    const set = this.streamConsumers.get(streamPath)
    return set ? Array.from(set) : []
  }

  /**
   * Find consumers matching a stream path via namespace globs.
   */
  findConsumersMatchingStream(streamPath: string): Array<Consumer> {
    return Array.from(this.consumers.values()).filter(
      (c) => c.namespace && globMatch(c.namespace, streamPath)
    )
  }

  /**
   * Get streams data for API responses.
   */
  getStreamsData(consumer: Consumer): Array<{ path: string; offset: string }> {
    return Array.from(consumer.streams, ([path, offset]) => ({ path, offset }))
  }

  /**
   * Check if consumer has pending work.
   */
  hasPendingWork(
    consumer: Consumer,
    getTailOffset: (path: string) => string
  ): boolean {
    for (const [path, ackedOffset] of consumer.streams) {
      const tail = getTailOffset(path)
      if (compareOffsets(tail, ackedOffset) > 0) return true
    }
    return false
  }

  /**
   * Remove a stream from all consumers. Returns IDs of consumers with no streams left.
   */
  removeStreamFromAllConsumers(streamPath: string): Array<string> {
    const consumerIds = this.getConsumersForStream(streamPath)
    const empty: Array<string> = []

    for (const cid of consumerIds) {
      const consumer = this.consumers.get(cid)
      if (!consumer) continue
      consumer.streams.delete(streamPath)
      if (consumer.streams.size === 0) {
        empty.push(cid)
      }
    }

    this.streamConsumers.delete(streamPath)
    return empty
  }

  /**
   * Get all consumers (for shutdown).
   */
  getAllConsumers(): IterableIterator<Consumer> {
    return this.consumers.values()
  }

  /**
   * Shut down: clear all timers and state.
   */
  shutdown(): void {
    for (const consumer of this.consumers.values()) {
      if (consumer.lease_timer) clearTimeout(consumer.lease_timer)
    }
    this.consumers.clear()
    this.streamConsumers.clear()
  }

  // ============================================================================
  // Private
  // ============================================================================

  private addStreamIndex(streamPath: string, consumerId: string): void {
    let set = this.streamConsumers.get(streamPath)
    if (!set) {
      set = new Set()
      this.streamConsumers.set(streamPath, set)
    }
    set.add(consumerId)
  }

  private removeStreamIndex(streamPath: string, consumerId: string): void {
    const set = this.streamConsumers.get(streamPath)
    if (set) {
      set.delete(consumerId)
      if (set.size === 0) {
        this.streamConsumers.delete(streamPath)
      }
    }
  }
}
