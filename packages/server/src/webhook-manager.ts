/**
 * Webhook orchestration: wake cycles, retry scheduling, timeout management.
 */

import { SpanStatusCode, context, trace } from "@opentelemetry/api"
import { WebhookStore } from "./webhook-store"
import {
  generateCallbackToken,
  signWebhookPayload,
  tokenNeedsRefresh,
  validateCallbackToken,
} from "./webhook-crypto"
import {
  ATTR,
  EVENT,
  SPAN_CONSUMER_CALLBACK,
  SPAN_WAKE_CYCLE,
  SPAN_WEBHOOK_DELIVER,
  endWakeCycleSpan,
  injectTraceHeaders,
  recordStateTransition,
  tracer,
} from "./webhook-telemetry"
import type {
  CallbackRequest,
  CallbackResponse,
  ConsumerInstance,
} from "./webhook-types"

const LIVENESS_TIMEOUT_MS = 45_000
const WEBHOOK_REQUEST_TIMEOUT_MS = 30_000
const MAX_RETRY_DELAY_MS = 30_000
const STEADY_RETRY_DELAY_MS = 60_000
const GC_FAILURE_MS = 3 * 24 * 60 * 60 * 1000 // 3 days

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
    const sub = this.store.getSubscription(consumer.subscription_id)
    if (!sub) {
      this.store.removeConsumer(consumer.consumer_id)
      return
    }

    const { epoch, wake_id } = this.store.transitionToWaking(consumer)

    // Create root wake cycle span
    const wakeCycleSpan = tracer.startSpan(SPAN_WAKE_CYCLE, {
      attributes: {
        [ATTR.CONSUMER_ID]: consumer.consumer_id,
        [ATTR.SUBSCRIPTION_ID]: consumer.subscription_id,
        [ATTR.PRIMARY_STREAM]: consumer.primary_stream,
        [ATTR.EPOCH]: epoch,
        [ATTR.WAKE_ID]: wake_id,
        [ATTR.TRIGGERED_BY]: triggeredBy,
      },
    })
    const wakeCycleCtx = trace.setSpan(context.active(), wakeCycleSpan)
    consumer.wake_cycle_span = wakeCycleSpan
    consumer.wake_cycle_ctx = wakeCycleCtx
    recordStateTransition(wakeCycleSpan, `IDLE`, `WAKING`)

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

    // Fire-and-forget — deliverWebhook handles its own errors internally
    this.deliverWebhook(consumer, sub, payload).catch(() => {})
  }

  private async deliverWebhook(
    consumer: ConsumerInstance,
    sub: { webhook: string; webhook_secret: string },
    payload: Record<string, unknown>
  ): Promise<void> {
    const parentCtx = consumer.wake_cycle_ctx ?? context.active()
    const deliverSpan = tracer.startSpan(
      SPAN_WEBHOOK_DELIVER,
      {
        attributes: {
          "http.method": `POST`,
          "http.url": sub.webhook,
          [ATTR.RETRY_COUNT]: consumer.retry_count,
        },
      },
      parentCtx
    )

    const body = JSON.stringify(payload)
    const signature = signWebhookPayload(body, sub.webhook_secret)

    const headers: Record<string, string> = {
      "content-type": `application/json`,
      "webhook-signature": signature,
    }
    injectTraceHeaders(trace.setSpan(parentCtx, deliverSpan), headers)

    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(),
      WEBHOOK_REQUEST_TIMEOUT_MS
    )

    try {
      const response = await fetch(sub.webhook, {
        method: `POST`,
        headers,
        body,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)
      deliverSpan.setAttribute(`http.status_code`, response.status)

      if (response.ok) {
        consumer.last_webhook_failure_at = null
        consumer.first_webhook_failure_at = null
        consumer.retry_count = 0

        // Check if response contains {done: true}
        let resBody: { done?: boolean } | null = null
        try {
          resBody = (await response.json()) as { done?: boolean }
        } catch {
          // Empty or non-JSON response body — that's fine
        }

        if (resBody?.done) {
          consumer.wake_id_claimed = true
          for (const [path] of consumer.streams) {
            const tail = this.getTailOffset(path)
            consumer.streams.set(path, tail)
          }
          deliverSpan.end()
          this.store.transitionToIdle(consumer)
          return
        }

        // 2xx response without {done:true} — the consumer has received
        // the notification and is processing. Transition to LIVE and let
        // the liveness timeout (45s) handle crash recovery from here.
        if (consumer.state === `WAKING`) {
          consumer.wake_id_claimed = true
          consumer.state = `LIVE`
          consumer.last_callback_at = Date.now()
          this.resetLivenessTimeout(consumer)
        }
        deliverSpan.end()
        return
      }

      // Non-2xx response — retry with backoff
      deliverSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: `HTTP ${response.status}`,
      })
      deliverSpan.end()
      if (!consumer.wake_id_claimed && consumer.state === `WAKING`) {
        this.scheduleRetry(consumer, sub, payload)
      }
    } catch (err) {
      clearTimeout(timeoutId)

      deliverSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : `Unknown error`,
      })
      deliverSpan.end()

      // Track failures for GC
      const now = Date.now()
      consumer.last_webhook_failure_at = now
      if (!consumer.first_webhook_failure_at) {
        consumer.first_webhook_failure_at = now
      }

      if (
        consumer.first_webhook_failure_at &&
        now - consumer.first_webhook_failure_at > GC_FAILURE_MS
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

    if (consumer.wake_cycle_span) {
      consumer.wake_cycle_span.addEvent(EVENT.RETRY_SCHEDULED, {
        [ATTR.RETRY_COUNT]: consumer.retry_count,
        delay_ms: delay,
      })
    }

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

    // Create child callback span under wake cycle context
    const parentCtx = consumer.wake_cycle_ctx ?? context.active()
    const callbackAction = request.done
      ? `done`
      : request.wake_id
        ? `claim`
        : request.acks
          ? `ack`
          : `other`
    const callbackSpan = tracer.startSpan(
      SPAN_CONSUMER_CALLBACK,
      {
        attributes: {
          [ATTR.CONSUMER_ID]: consumerId,
          [ATTR.EPOCH]: consumer.epoch,
          [ATTR.CALLBACK_ACTION]: callbackAction,
        },
      },
      parentCtx
    )

    // Validate token
    const tokenResult = validateCallbackToken(token, consumerId)
    if (!tokenResult.valid) {
      const newToken = generateCallbackToken(consumerId, consumer.epoch)
      callbackSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: tokenResult.code,
      })
      callbackSpan.end()
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

    // Validate epoch — must match current epoch exactly
    if (request.epoch !== consumer.epoch) {
      const newToken = generateCallbackToken(consumerId, consumer.epoch)
      callbackSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: `STALE_EPOCH`,
      })
      callbackSpan.end()
      return {
        ok: false,
        error: {
          code: `STALE_EPOCH`,
          message: `Consumer epoch ${request.epoch} does not match current epoch ${consumer.epoch}`,
        },
        token: newToken,
      }
    }

    // Handle wake_id claim (idempotent — claiming an already-claimed wake
    // for the same consumer is a success, since the 2xx webhook response
    // may have already transitioned the consumer to LIVE).
    if (request.wake_id) {
      if (!this.store.claimWakeId(consumer, request.wake_id)) {
        const newToken = generateCallbackToken(consumerId, consumer.epoch)
        callbackSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: `ALREADY_CLAIMED`,
        })
        callbackSpan.end()
        return {
          ok: false,
          error: {
            code: `ALREADY_CLAIMED`,
            message: `Wake ID ${request.wake_id} is invalid or already claimed`,
          },
          token: newToken,
        }
      }
      callbackSpan.addEvent(EVENT.WAKE_CLAIMED)
    }

    // Reset liveness timeout
    consumer.last_callback_at = Date.now()
    this.resetLivenessTimeout(consumer)

    // Process acks
    if (request.acks) {
      this.store.updateAcks(consumer, request.acks)
      callbackSpan.addEvent(EVENT.ACKS_PROCESSED, {
        count: request.acks.length,
      })
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
        callbackSpan.end()
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
        callbackSpan.addEvent(EVENT.DONE_WITH_REWAKE)
        callbackSpan.end()
        // Re-wake immediately — end callback span before transitionToIdle
        // so child span ends before parent
        this.store.transitionToIdle(consumer)
        this.wakeConsumer(consumer, [consumer.primary_stream])
      } else {
        callbackSpan.addEvent(EVENT.DONE_RECEIVED)
        callbackSpan.end()
        this.store.transitionToIdle(consumer)
      }
    } else {
      callbackSpan.end()
    }

    // Only generate a new token if the current one is nearing expiry;
    // otherwise pass it back as-is to avoid unnecessary crypto work.
    const responseToken = tokenNeedsRefresh(tokenResult.exp)
      ? generateCallbackToken(consumerId, consumer.epoch)
      : token

    if (responseToken !== token && consumer.wake_cycle_span) {
      consumer.wake_cycle_span.addEvent(EVENT.TOKEN_REFRESHED)
    }

    return {
      ok: true,
      token: responseToken,
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
        if (consumer.wake_cycle_span) {
          consumer.wake_cycle_span.addEvent(EVENT.LIVENESS_TIMEOUT)
        }
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
    for (const consumer of this.store.getAllConsumers()) {
      if (consumer.wake_cycle_span) {
        endWakeCycleSpan(consumer.wake_cycle_span, EVENT.SERVER_SHUTDOWN)
        consumer.wake_cycle_span = null
        consumer.wake_cycle_ctx = null
      }
    }
    this.store.shutdown()
  }
}
