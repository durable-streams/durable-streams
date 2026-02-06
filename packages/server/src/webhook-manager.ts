/**
 * Webhook orchestration: wake cycles, retry scheduling, timeout management.
 */

import { WebhookStore } from "./webhook-store"
import {
  generateCallbackToken,
  signWebhookPayload,
  validateCallbackToken,
} from "./webhook-crypto"
import type {
  CallbackRequest,
  CallbackResponse,
  ConsumerInstance,
} from "./webhook-types"

const LIVENESS_TIMEOUT_MS = 45_000
const WEBHOOK_REQUEST_TIMEOUT_MS = 30_000
const MAX_RETRY_DELAY_MS = 30_000
const STEADY_RETRY_DELAY_MS = 60_000
const GC_FAILURE_DAYS = 3

/**
 * Orchestrates webhook delivery, consumer lifecycle, and callbacks.
 */
export class WebhookManager {
  readonly store: WebhookStore
  private callbackBaseUrl: string
  private getTailOffset: (path: string) => string
  private isShuttingDown = false

  constructor(opts: {
    callbackBaseUrl: string
    getTailOffset: (path: string) => string
  }) {
    this.store = new WebhookStore()
    this.callbackBaseUrl = opts.callbackBaseUrl
    this.getTailOffset = opts.getTailOffset
  }

  // ============================================================================
  // Stream event hooks (called from server.ts)
  // ============================================================================

  /**
   * Called when events are appended to a stream.
   * Checks if any consumers need to be woken.
   */
  onStreamAppend(streamPath: string): void {
    if (this.isShuttingDown) return

    // Find consumers subscribed to this stream
    const consumerIds = this.store.getConsumersForStream(streamPath)
    for (const cid of consumerIds) {
      const consumer = this.store.getConsumer(cid)
      if (!consumer) continue

      if (consumer.state === `IDLE`) {
        // Check if there's actually pending work
        if (this.store.hasPendingWork(consumer, this.getTailOffset)) {
          this.wakeConsumer(consumer, [streamPath])
        }
      }
      // If WAKING or LIVE, do nothing — no re-wake while active
    }
  }

  /**
   * Called when a new stream is created.
   * Spawns consumer instances for matching subscriptions.
   */
  onStreamCreated(streamPath: string): void {
    if (this.isShuttingDown) return

    const matchingSubs = this.store.findMatchingSubscriptions(streamPath)
    for (const sub of matchingSubs) {
      // Create consumer in IDLE state — will wake when events arrive
      this.store.getOrCreateConsumer(sub.subscription_id, streamPath)
    }
  }

  /**
   * Called when a stream is deleted.
   * Removes the stream from all consumers; GCs consumers with no streams.
   */
  onStreamDeleted(streamPath: string): void {
    this.store.removeStreamFromConsumers(streamPath)
  }

  // ============================================================================
  // Wake cycle
  // ============================================================================

  private wakeConsumer(
    consumer: ConsumerInstance,
    triggeredBy: Array<string>
  ): void {
    const { epoch, wake_id } = this.store.transitionToWaking(
      consumer,
      triggeredBy
    )

    const sub = this.store.getSubscription(consumer.subscription_id)
    if (!sub) return

    const callbackUrl = this.buildCallbackUrl(consumer.consumer_id)
    const token = generateCallbackToken(consumer.consumer_id, epoch)

    const payload = {
      consumer_id: consumer.consumer_id,
      epoch,
      wake_id,
      primary_stream: consumer.primary_stream,
      streams: this.store.getStreamsData(consumer),
      triggered_by: triggeredBy,
      callback: callbackUrl,
      token,
    }

    this.deliverWebhook(consumer, sub, payload)
  }

  private async deliverWebhook(
    consumer: ConsumerInstance,
    sub: { webhook: string; webhook_secret: string },
    payload: Record<string, unknown>
  ): Promise<void> {
    const body = JSON.stringify(payload)
    const signature = signWebhookPayload(body, sub.webhook_secret)

    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(),
      WEBHOOK_REQUEST_TIMEOUT_MS
    )

    try {
      const response = await fetch(sub.webhook, {
        method: `POST`,
        headers: {
          "content-type": `application/json`,
          "webhook-signature": signature,
        },
        body,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      // Reset failure tracking on successful delivery
      consumer.last_webhook_failure_at = null
      consumer.first_webhook_failure_at = null
      consumer.retry_count = 0

      if (response.ok) {
        // Check if response contains {done: true}
        try {
          const resBody = (await response.json()) as { done?: boolean }
          if (resBody.done) {
            // Synchronous done — auto-ack all streams to current tail
            // and transition to IDLE. The next onStreamAppend will
            // re-wake if new events arrive.
            consumer.wake_id_claimed = true
            for (const [path] of consumer.streams) {
              const tail = this.getTailOffset(path)
              consumer.streams.set(path, tail)
            }
            this.store.transitionToIdle(consumer)
            return
          }
        } catch {
          // Empty or non-JSON response body — that's fine
        }
      }

      // If wake hasn't been claimed yet (no callback arrived, no done:true),
      // schedule retry
      if (!consumer.wake_id_claimed && consumer.state === `WAKING`) {
        this.scheduleRetry(consumer, sub, payload)
      }
    } catch {
      clearTimeout(timeoutId)

      // Track failures for GC
      const now = Date.now()
      consumer.last_webhook_failure_at = now
      if (!consumer.first_webhook_failure_at) {
        consumer.first_webhook_failure_at = now
      }

      // Check GC threshold (3 days of continuous failures)
      if (
        consumer.first_webhook_failure_at &&
        now - consumer.first_webhook_failure_at >
          GC_FAILURE_DAYS * 24 * 60 * 60 * 1000
      ) {
        this.store.removeConsumer(consumer.consumer_id)
        return
      }

      // Schedule retry
      if (consumer.state === `WAKING`) {
        this.scheduleRetry(consumer, sub, payload)
      }
    }
  }

  private scheduleRetry(
    consumer: ConsumerInstance,
    sub: { webhook: string; webhook_secret: string },
    payload: Record<string, unknown>
  ): void {
    if (this.isShuttingDown) return

    consumer.retry_count++
    const delay = this.calculateRetryDelay(consumer.retry_count)

    consumer.retry_timer = setTimeout(() => {
      consumer.retry_timer = null
      // Only retry if still in WAKING and wake hasn't been claimed
      if (
        consumer.state === `WAKING` &&
        !consumer.wake_id_claimed &&
        !this.isShuttingDown
      ) {
        this.deliverWebhook(consumer, sub, payload)
      }
    }, delay)
  }

  /**
   * Exponential backoff with jitter, capping at MAX_RETRY_DELAY_MS,
   * then settling to STEADY_RETRY_DELAY_MS.
   */
  private calculateRetryDelay(retryCount: number): number {
    if (retryCount > 10) {
      // After 10 retries, settle to steady interval with jitter
      return STEADY_RETRY_DELAY_MS + Math.random() * 5000
    }
    // Exponential backoff: min(2^n * 100, 30000) + jitter
    const base = Math.min(Math.pow(2, retryCount) * 100, MAX_RETRY_DELAY_MS)
    return base + Math.random() * 1000
  }

  // ============================================================================
  // Callback handling
  // ============================================================================

  /**
   * Process a callback request. Returns the response to send.
   */
  handleCallback(
    consumerId: string,
    token: string,
    request: CallbackRequest
  ): CallbackResponse {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) {
      return {
        ok: false,
        error: {
          code: `CONSUMER_GONE`,
          message: `Consumer instance not found`,
        },
      }
    }

    // Validate token
    const tokenResult = validateCallbackToken(token, consumerId, consumer.epoch)
    if (!tokenResult.valid) {
      const newToken = generateCallbackToken(consumerId, consumer.epoch)
      if (tokenResult.code === `TOKEN_EXPIRED`) {
        return {
          ok: false,
          error: {
            code: `TOKEN_EXPIRED`,
            message: `Callback token has expired`,
          },
          token: newToken,
        }
      }
      return {
        ok: false,
        error: {
          code: `TOKEN_INVALID`,
          message: `Callback token is invalid`,
        },
      }
    }

    // Validate epoch
    if (request.epoch < consumer.epoch) {
      const newToken = generateCallbackToken(consumerId, consumer.epoch)
      return {
        ok: false,
        error: {
          code: `STALE_EPOCH`,
          message: `Consumer epoch ${request.epoch} is stale; current epoch is ${consumer.epoch}`,
        },
        token: newToken,
      }
    }

    // Handle wake_id claim
    if (request.wake_id) {
      if (consumer.wake_id_claimed) {
        const newToken = generateCallbackToken(consumerId, consumer.epoch)
        return {
          ok: false,
          error: {
            code: `ALREADY_CLAIMED`,
            message: `Wake ID ${request.wake_id} was already claimed`,
          },
          token: newToken,
        }
      }

      if (!this.store.claimWakeId(consumer, request.wake_id)) {
        const newToken = generateCallbackToken(consumerId, consumer.epoch)
        return {
          ok: false,
          error: {
            code: `ALREADY_CLAIMED`,
            message: `Wake ID ${request.wake_id} is invalid or already claimed`,
          },
          token: newToken,
        }
      }
    }

    // Reset liveness timeout
    consumer.last_callback_at = Date.now()
    this.resetLivenessTimeout(consumer)

    // Process acks
    if (request.acks) {
      this.store.updateAcks(consumer, request.acks)
    }

    // Process subscribes
    if (request.subscribe) {
      this.store.subscribeStreams(
        consumer,
        request.subscribe,
        this.getTailOffset
      )
    }

    // Process unsubscribes
    if (request.unsubscribe) {
      const shouldRemove = this.store.unsubscribeStreams(
        consumer,
        request.unsubscribe
      )
      if (shouldRemove) {
        this.store.removeConsumer(consumerId)
        return {
          ok: false,
          error: {
            code: `CONSUMER_GONE`,
            message: `Consumer removed after unsubscribing from all streams`,
          },
        }
      }
    }

    // Process done
    if (request.done) {
      if (this.store.hasPendingWork(consumer, this.getTailOffset)) {
        // Re-wake immediately
        this.store.transitionToIdle(consumer)
        this.wakeConsumer(consumer, [consumer.primary_stream])
      } else {
        this.store.transitionToIdle(consumer)
      }
    }

    // Generate new token
    const newToken = generateCallbackToken(consumerId, consumer.epoch)

    return {
      ok: true,
      token: newToken,
      streams: this.store.getStreamsData(consumer),
    }
  }

  // ============================================================================
  // Liveness timeout
  // ============================================================================

  private resetLivenessTimeout(consumer: ConsumerInstance): void {
    if (consumer.liveness_timer) {
      clearTimeout(consumer.liveness_timer)
    }

    consumer.liveness_timer = setTimeout(() => {
      consumer.liveness_timer = null
      if (consumer.state === `LIVE` && !this.isShuttingDown) {
        // Timeout — transition to IDLE
        this.store.transitionToIdle(consumer)
        // Check if there's pending work and re-wake
        if (this.store.hasPendingWork(consumer, this.getTailOffset)) {
          this.wakeConsumer(consumer, [consumer.primary_stream])
        }
      }
    }, LIVENESS_TIMEOUT_MS)
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private buildCallbackUrl(consumerId: string): string {
    return `${this.callbackBaseUrl}/callback/${consumerId}`
  }

  /**
   * Shut down the manager: cancel all timers.
   */
  shutdown(): void {
    this.isShuttingDown = true
    this.store.shutdown()
  }
}
