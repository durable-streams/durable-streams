/**
 * In-memory state management for webhook subscriptions and L2 webhook consumers.
 * L1 consumer state (epoch, streams, offsets) is owned by ConsumerStore/ConsumerManager.
 */

import { globMatch } from "./glob"
import { generateWebhookSecret } from "./crypto"
import { EVENT, endWakeCycleSpan } from "./webhook-telemetry"
import type { Subscription, WebhookConsumer } from "./webhook-types"

/**
 * In-memory store for webhook subscriptions and L2 webhook consumer instances.
 */
export class WebhookStore {
  private subscriptions = new Map<string, Subscription>()
  private webhookConsumers = new Map<string, WebhookConsumer>()

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

  getConsumersForSubscription(subscriptionId: string): Array<string> {
    const set = this.subscriptionConsumers.get(subscriptionId)
    return set ? Array.from(set) : []
  }

  deleteSubscription(subscriptionId: string): boolean {
    const sub = this.subscriptions.get(subscriptionId)
    if (!sub) return false

    // Get all webhook consumers for this subscription
    const consumerIds = this.subscriptionConsumers.get(subscriptionId)
    if (consumerIds) {
      for (const cid of consumerIds) {
        this.removeWebhookConsumer(cid)
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
  // Webhook Consumers (L2)
  // ============================================================================

  getWebhookConsumer(consumerId: string): WebhookConsumer | undefined {
    return this.webhookConsumers.get(consumerId)
  }

  /**
   * Build the consumer ID from subscription_id and stream path.
   */
  static readonly CONSUMER_ID_PREFIX = `__wh__:`

  static buildConsumerId(subscriptionId: string, streamPath: string): string {
    return `${WebhookStore.CONSUMER_ID_PREFIX}${subscriptionId}:${encodeURIComponent(streamPath)}`
  }

  /**
   * Create an L2 webhook consumer record. Does not create L1 consumer state.
   */
  createWebhookConsumer(
    consumerId: string,
    subscriptionId: string,
    streamPath: string
  ): WebhookConsumer {
    const existing = this.webhookConsumers.get(consumerId)
    if (existing) return existing

    const wc: WebhookConsumer = {
      consumer_id: consumerId,
      subscription_id: subscriptionId,
      primary_stream: streamPath,
      wake_id: null,
      wake_id_claimed: false,
      last_webhook_failure_at: null,
      first_webhook_failure_at: null,
      retry_count: 0,
      retry_timer: null,
      wake_cycle_span: null,
      wake_cycle_ctx: null,
    }

    this.webhookConsumers.set(consumerId, wc)

    // Update indexes
    const subConsumers = this.subscriptionConsumers.get(subscriptionId)
    if (subConsumers) {
      subConsumers.add(consumerId)
    }
    this.addStreamIndex(streamPath, consumerId)

    return wc
  }

  /**
   * Claim a wake_id. Returns true if claim succeeds or was already claimed
   * for this wake (idempotent). Returns false if the wake_id doesn't match.
   */
  claimWakeId(wc: WebhookConsumer, wakeId: string): boolean {
    if (wc.wake_id !== wakeId) return false
    if (wc.wake_id_claimed) return true
    wc.wake_id_claimed = true
    return true
  }

  /**
   * Remove a webhook consumer and clean up L2 indexes.
   * Does NOT remove L1 consumer — caller must handle that separately.
   */
  removeWebhookConsumer(consumerId: string): void {
    const wc = this.webhookConsumers.get(consumerId)
    if (!wc) return

    // Clear timers
    if (wc.retry_timer) {
      clearTimeout(wc.retry_timer)
    }

    if (wc.wake_cycle_span) {
      endWakeCycleSpan(wc.wake_cycle_span, EVENT.CONSUMER_GC, true)
      wc.wake_cycle_span = null
      wc.wake_cycle_ctx = null
    }

    // Clean up stream index
    this.removeStreamIndex(wc.primary_stream, consumerId)

    // Clean up subscription index
    const subConsumers = this.subscriptionConsumers.get(wc.subscription_id)
    if (subConsumers) {
      subConsumers.delete(consumerId)
    }

    this.webhookConsumers.delete(consumerId)
  }

  /**
   * Get all consumer IDs subscribed to a given stream path.
   */
  getConsumersForStream(streamPath: string): Array<string> {
    const set = this.streamConsumers.get(streamPath)
    return set ? Array.from(set) : []
  }

  /**
   * Get all webhook consumer instances (for shutdown span cleanup).
   */
  getAllWebhookConsumers(): IterableIterator<WebhookConsumer> {
    return this.webhookConsumers.values()
  }

  /**
   * Remove a stream from the L2 stream index.
   */
  removeStreamFromIndex(streamPath: string): void {
    this.streamConsumers.delete(streamPath)
  }

  /**
   * Shut down: clear all timers.
   */
  shutdown(): void {
    for (const wc of this.webhookConsumers.values()) {
      if (wc.retry_timer) clearTimeout(wc.retry_timer)
    }
    this.webhookConsumers.clear()
    this.subscriptions.clear()
    this.subscriptionConsumers.clear()
    this.streamConsumers.clear()
  }

  // ============================================================================
  // Stream index management
  // ============================================================================

  addStreamIndex(streamPath: string, consumerId: string): void {
    let set = this.streamConsumers.get(streamPath)
    if (!set) {
      set = new Set()
      this.streamConsumers.set(streamPath, set)
    }
    set.add(consumerId)
  }

  removeStreamIndex(streamPath: string, consumerId: string): void {
    const set = this.streamConsumers.get(streamPath)
    if (set) {
      set.delete(consumerId)
      if (set.size === 0) {
        this.streamConsumers.delete(streamPath)
      }
    }
  }
}
