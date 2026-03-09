/**
 * In-memory state management for webhook subscriptions and consumers.
 */

import { globMatch } from "./webhook-glob"
import { generateWakeId, generateWebhookSecret } from "./webhook-crypto"
import {
  EVENT,
  endWakeCycleSpan,
  recordStateTransition,
} from "./webhook-telemetry"
import type { ConsumerInstance, Subscription } from "./webhook-types"

/**
 * In-memory store for webhook subscriptions and consumer instances.
 */
export class WebhookStore {
  private subscriptions = new Map<string, Subscription>()
  private consumers = new Map<string, ConsumerInstance>()

  // Index: subscription_id -> set of consumer_ids
  private subscriptionConsumers = new Map<string, Set<string>>()
  // Index: stream_path -> set of consumer_ids subscribed to that stream
  private streamConsumers = new Map<string, Set<string>>()

  // ============================================================================
  // Subscriptions
  // ============================================================================

  createSubscription(
    subscriptionId: string,
    pattern: string,
    webhook: string,
    description?: string
  ): { subscription: Subscription; created: boolean } {
    const existing = this.subscriptions.get(subscriptionId)
    if (existing) {
      // Check if config matches for idempotent create
      if (existing.pattern === pattern && existing.webhook === webhook) {
        return { subscription: existing, created: false }
      }
      throw new Error(
        `Subscription already exists with different configuration`
      )
    }

    const subscription: Subscription = {
      subscription_id: subscriptionId,
      pattern,
      webhook,
      webhook_secret: generateWebhookSecret(),
      description,
    }

    this.subscriptions.set(subscriptionId, subscription)
    this.subscriptionConsumers.set(subscriptionId, new Set())
    return { subscription, created: true }
  }

  getSubscription(subscriptionId: string): Subscription | undefined {
    return this.subscriptions.get(subscriptionId)
  }

  listSubscriptions(pattern?: string): Array<Subscription> {
    if (!pattern || pattern === `/**`) {
      return Array.from(this.subscriptions.values())
    }
    return Array.from(this.subscriptions.values()).filter(
      (s) => s.pattern === pattern
    )
  }

  deleteSubscription(subscriptionId: string): boolean {
    const sub = this.subscriptions.get(subscriptionId)
    if (!sub) return false

    // Get all consumers for this subscription
    const consumerIds = this.subscriptionConsumers.get(subscriptionId)
    if (consumerIds) {
      for (const cid of consumerIds) {
        this.removeConsumer(cid)
      }
    }

    this.subscriptionConsumers.delete(subscriptionId)
    this.subscriptions.delete(subscriptionId)
    return true
  }

  /**
   * Find all subscriptions whose pattern matches a given stream path.
   */
  findMatchingSubscriptions(streamPath: string): Array<Subscription> {
    return Array.from(this.subscriptions.values()).filter((sub) =>
      globMatch(sub.pattern, streamPath)
    )
  }

  // ============================================================================
  // Consumers
  // ============================================================================

  getConsumer(consumerId: string): ConsumerInstance | undefined {
    return this.consumers.get(consumerId)
  }

  /**
   * Build the consumer ID from subscription_id and stream path.
   */
  static buildConsumerId(subscriptionId: string, streamPath: string): string {
    return `${subscriptionId}:${encodeURIComponent(streamPath)}`
  }

  /**
   * Get or create a consumer instance for a subscription + stream path.
   */
  getOrCreateConsumer(
    subscriptionId: string,
    streamPath: string
  ): ConsumerInstance {
    const consumerId = WebhookStore.buildConsumerId(subscriptionId, streamPath)
    let consumer = this.consumers.get(consumerId)
    if (consumer) return consumer

    consumer = {
      consumer_id: consumerId,
      subscription_id: subscriptionId,
      primary_stream: streamPath,
      state: `IDLE`,
      epoch: 0,
      wake_id: null,
      wake_id_claimed: false,
      streams: new Map([[streamPath, `-1`]]),
      last_callback_at: 0,
      last_webhook_failure_at: null,
      first_webhook_failure_at: null,
      retry_count: 0,
      retry_timer: null,
      liveness_timer: null,
      wake_cycle_span: null,
      wake_cycle_ctx: null,
    }

    this.consumers.set(consumerId, consumer)

    // Update indexes
    const subConsumers = this.subscriptionConsumers.get(subscriptionId)
    if (subConsumers) {
      subConsumers.add(consumerId)
    }
    this.addStreamIndex(streamPath, consumerId)

    return consumer
  }

  /**
   * Transition consumer to WAKING state.
   * Increments epoch and generates a new wake_id.
   */
  transitionToWaking(consumer: ConsumerInstance): {
    epoch: number
    wake_id: string
  } {
    consumer.epoch++
    consumer.wake_id = generateWakeId()
    consumer.wake_id_claimed = false
    consumer.state = `WAKING`
    return { epoch: consumer.epoch, wake_id: consumer.wake_id }
  }

  /**
   * Claim a wake_id. Returns true if claim succeeds or was already claimed
   * for this wake (idempotent). Returns false if the wake_id doesn't match.
   */
  claimWakeId(consumer: ConsumerInstance, wakeId: string): boolean {
    if (consumer.wake_id !== wakeId) return false
    if (consumer.wake_id_claimed) return true
    consumer.wake_id_claimed = true
    const prevState = consumer.state
    consumer.state = `LIVE`
    consumer.last_callback_at = Date.now()
    if (consumer.wake_cycle_span) {
      recordStateTransition(consumer.wake_cycle_span, prevState, `LIVE`)
    }
    return true
  }

  /**
   * Transition consumer to IDLE state.
   */
  transitionToIdle(consumer: ConsumerInstance): void {
    const prevState = consumer.state
    consumer.state = `IDLE`
    consumer.wake_id = null
    consumer.wake_id_claimed = false
    if (consumer.liveness_timer) {
      clearTimeout(consumer.liveness_timer)
      consumer.liveness_timer = null
    }
    if (consumer.wake_cycle_span) {
      recordStateTransition(consumer.wake_cycle_span, prevState, `IDLE`)
      consumer.wake_cycle_span.end()
      consumer.wake_cycle_span = null
      consumer.wake_cycle_ctx = null
    }
  }

  /**
   * Update acked offsets for a consumer.
   */
  updateAcks(
    consumer: ConsumerInstance,
    acks: Array<{ path: string; offset: string }>
  ): void {
    for (const ack of acks) {
      if (consumer.streams.has(ack.path)) {
        consumer.streams.set(ack.path, ack.offset)
      }
    }
  }

  /**
   * Subscribe consumer to additional streams.
   * New subscriptions start at the given tail offset (or -1 if unknown).
   */
  subscribeStreams(
    consumer: ConsumerInstance,
    paths: Array<string>,
    getTailOffset: (path: string) => string
  ): void {
    for (const path of paths) {
      if (!consumer.streams.has(path)) {
        const tail = getTailOffset(path)
        consumer.streams.set(path, tail)
        this.addStreamIndex(path, consumer.consumer_id)
      }
    }
  }

  /**
   * Unsubscribe consumer from streams.
   * Returns true if consumer should be removed (unsubscribed from all).
   */
  unsubscribeStreams(
    consumer: ConsumerInstance,
    paths: Array<string>
  ): boolean {
    for (const path of paths) {
      consumer.streams.delete(path)
      this.removeStreamIndex(path, consumer.consumer_id)
    }
    return consumer.streams.size === 0
  }

  /**
   * Remove a consumer instance and clean up indexes.
   */
  removeConsumer(consumerId: string): void {
    const consumer = this.consumers.get(consumerId)
    if (!consumer) return

    // Clear timers
    if (consumer.retry_timer) {
      clearTimeout(consumer.retry_timer)
    }
    if (consumer.liveness_timer) {
      clearTimeout(consumer.liveness_timer)
    }

    if (consumer.wake_cycle_span) {
      endWakeCycleSpan(consumer.wake_cycle_span, EVENT.CONSUMER_GC, true)
      consumer.wake_cycle_span = null
      consumer.wake_cycle_ctx = null
    }

    // Clean up stream indexes
    for (const path of consumer.streams.keys()) {
      this.removeStreamIndex(path, consumerId)
    }

    // Clean up subscription index
    const subConsumers = this.subscriptionConsumers.get(
      consumer.subscription_id
    )
    if (subConsumers) {
      subConsumers.delete(consumerId)
    }

    this.consumers.delete(consumerId)
  }

  /**
   * Get all consumer IDs subscribed to a given stream path.
   */
  getConsumersForStream(streamPath: string): Array<string> {
    const set = this.streamConsumers.get(streamPath)
    return set ? Array.from(set) : []
  }

  /**
   * Get all consumer instances (for shutdown span cleanup).
   */
  getAllConsumers(): IterableIterator<ConsumerInstance> {
    return this.consumers.values()
  }

  /**
   * Check if a consumer has pending work.
   */
  hasPendingWork(
    consumer: ConsumerInstance,
    getTailOffset: (path: string) => string
  ): boolean {
    for (const [path, ackedOffset] of consumer.streams) {
      const tail = getTailOffset(path)
      if (tail > ackedOffset) return true
    }
    return false
  }

  /**
   * Get streams data for webhook payload or callback response.
   */
  getStreamsData(
    consumer: ConsumerInstance
  ): Array<{ path: string; offset: string }> {
    return Array.from(consumer.streams, ([path, offset]) => ({ path, offset }))
  }

  /**
   * Remove a stream from all consumers that are subscribed to it.
   * Returns consumer IDs that lost their only stream (should be removed).
   */
  removeStreamFromConsumers(streamPath: string): Array<string> {
    const consumerIds = this.getConsumersForStream(streamPath)
    const toRemove: Array<string> = []

    for (const cid of consumerIds) {
      const consumer = this.consumers.get(cid)
      if (!consumer) continue

      consumer.streams.delete(streamPath)
      if (consumer.streams.size === 0) {
        toRemove.push(cid)
      }
    }

    this.streamConsumers.delete(streamPath)

    // Remove consumers with no streams
    for (const cid of toRemove) {
      this.removeConsumer(cid)
    }

    return toRemove
  }

  /**
   * Shut down: clear all timers.
   */
  shutdown(): void {
    for (const consumer of this.consumers.values()) {
      if (consumer.retry_timer) clearTimeout(consumer.retry_timer)
      if (consumer.liveness_timer) clearTimeout(consumer.liveness_timer)
    }
    this.consumers.clear()
    this.subscriptions.clear()
    this.subscriptionConsumers.clear()
    this.streamConsumers.clear()
  }

  // ============================================================================
  // Private helpers
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
