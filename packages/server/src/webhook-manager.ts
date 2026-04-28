/**
 * Webhook orchestration: wake cycles, retry scheduling, timeout management.
 * Delegates all consumer state (epoch, streams, offsets) to L1 ConsumerManager.
 */

import { SpanStatusCode, context, trace } from "@opentelemetry/api"
import { WebhookStore } from "./webhook-store"
import { serverLog } from "./log"
import {
  generateCallbackToken,
  generateWakeId,
  generateWebhookSecret,
  signWebhookPayload,
  tokenNeedsRefresh,
  validateCallbackToken,
} from "./crypto"
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
import type { ConsumerManager } from "./consumer-manager"
import type { ConsumerError } from "./consumer-types"
import type {
  CallbackErrorCode,
  CallbackRequest,
  CallbackResponse,
  WebhookConsumer,
} from "./webhook-types"

const WEBHOOK_REQUEST_TIMEOUT_MS = 30_000
const MAX_RETRY_DELAY_MS = 30_000
const STEADY_RETRY_DELAY_MS = 60_000
const GC_FAILURE_MS = 3 * 24 * 60 * 60 * 1000 // 3 days

function firstString(...candidates: Array<unknown>): string {
  for (const c of candidates) {
    if (typeof c === `string`) return c
  }
  return ``
}

function firstArray(...candidates: Array<unknown>): Array<string> {
  for (const c of candidates) {
    if (Array.isArray(c)) return c
  }
  return []
}

function addWebhookPayloadAliases(
  payload: Record<string, unknown>,
  defaults: {
    consumerId: string
    epoch: number
    wakeId: string
    streamPath: string
    streams: unknown
    triggeredBy: Array<string>
    callback: string
    token: string
  }
): Record<string, unknown> {
  const consumerId = firstString(
    payload.consumerId,
    payload.consumer_id,
    defaults.consumerId
  )
  const epoch =
    typeof payload.epoch === `number` ? payload.epoch : defaults.epoch
  const wakeId = firstString(payload.wakeId, payload.wake_id, defaults.wakeId)
  const streamPath = firstString(
    payload.streamPath,
    payload.stream_path,
    payload.primaryStream,
    payload.primary_stream,
    defaults.streamPath
  )
  const triggeredBy = firstArray(
    payload.triggeredBy,
    payload.triggered_by,
    defaults.triggeredBy
  )
  const callback = firstString(payload.callback, defaults.callback)
  const token = firstString(payload.claimToken, payload.token, defaults.token)

  return {
    ...payload,
    consumerId,
    consumer_id: consumerId,
    epoch,
    wakeId,
    wake_id: wakeId,
    streamPath,
    stream_path: streamPath,
    primaryStream: streamPath,
    primary_stream: streamPath,
    streams: payload.streams ?? defaults.streams,
    triggeredBy,
    triggered_by: triggeredBy,
    callback,
    claimToken: token,
    token,
  }
}

function mapAckErrorToCallbackError(error: ConsumerError): CallbackErrorCode {
  switch (error.code) {
    case `OFFSET_REGRESSION`:
    case `INVALID_OFFSET`:
      return `INVALID_OFFSET`
    case `STALE_EPOCH`:
      return `STALE_EPOCH`
    case `TOKEN_EXPIRED`:
      return `TOKEN_EXPIRED`
    case `TOKEN_INVALID`:
      return `TOKEN_INVALID`
    case `CONSUMER_NOT_FOUND`:
    case `UNKNOWN_STREAM`:
    case `CONSUMER_ALREADY_EXISTS`:
    case `EPOCH_HELD`:
    case `INTERNAL_ERROR`:
      throw new Error(
        `Unexpected ack error in webhook callback path: ${error.code}`
      )
  }
}

/**
 * Orchestrates webhook delivery, consumer lifecycle, and callbacks.
 * L2 layer: delegates epoch/stream/offset management to L1 ConsumerManager.
 */
export class WebhookManager {
  readonly store: WebhookStore
  readonly consumerManager: ConsumerManager
  private callbackBaseUrl: string
  private getTailOffset: (path: string) => string
  private isShuttingDown = false
  private directWebhookConfigs = new Map<
    string,
    { webhook: string; webhook_secret: string }
  >()

  /**
   * Optional callback to enrich webhook payloads with additional context.
   * Used by DARIX to inject entity metadata into webhook notifications.
   */
  enrichPayload?: (
    payload: Record<string, unknown>,
    consumer: WebhookConsumer
  ) => Record<string, unknown> | Promise<Record<string, unknown>>

  /**
   * Optional callback to retrieve the entity write_token for a given primary stream.
   * Used to include write_token in claim responses so entities can authenticate writes.
   */
  getEntityWriteToken:
    | ((primaryStream: string) => Promise<string | undefined>)
    | null = null

  constructor(opts: {
    callbackBaseUrl: string
    getTailOffset: (path: string) => string
    consumerManager: ConsumerManager
  }) {
    this.store = new WebhookStore()
    this.callbackBaseUrl = opts.callbackBaseUrl
    this.getTailOffset = opts.getTailOffset
    this.consumerManager = opts.consumerManager

    // Register L1 lifecycle hooks
    this.consumerManager.onLeaseExpired((consumer) => {
      const wc = this.store.getWebhookConsumer(consumer.consumer_id)
      if (wc && this.consumerManager.hasPendingWork(consumer.consumer_id)) {
        this.wakeConsumer(wc, [wc.primary_stream])
      }
    })

    this.consumerManager.onConsumerDeleted((consumerId) => {
      this.directWebhookConfigs.delete(consumerId)
      const wc = this.store.getWebhookConsumer(consumerId)
      if (wc) {
        if (wc.retry_timer) clearTimeout(wc.retry_timer)
        this.store.removeWebhookConsumer(consumerId)
      }
    })
  }

  // ============================================================================
  // Stream event hooks (called from server.ts)
  // ============================================================================

  /**
   * Called when events are appended to a stream.
   * Lazily creates consumers for matching subscriptions on first append,
   * then checks if any consumers need to be woken.
   */
  onStreamAppend(streamPath: string): void {
    if (this.isShuttingDown) return

    // Lazily create consumers for matching subscriptions that don't have one yet.
    // Always check all subscriptions — a new subscription may have been added
    // after existing consumers were created for earlier subscriptions.
    const matchingSubs = this.store.findMatchingSubscriptions(streamPath)
    for (const sub of matchingSubs) {
      this.getOrCreateWebhookConsumer(sub.subscription_id, streamPath)
    }
    const consumerIds = this.store.getConsumersForStream(streamPath)

    for (const cid of consumerIds) {
      if (this.directWebhookConfigs.has(cid)) continue

      const wc = this.store.getWebhookConsumer(cid)
      if (!wc) continue

      // Check L1 state: REGISTERED means idle (no active epoch)
      const l1Consumer = this.consumerManager.store.getConsumer(cid)
      if (!l1Consumer) continue

      if (l1Consumer.state === `REGISTERED` && wc.wake_id === null) {
        // Consumer is idle — check if there's actually pending work
        if (this.consumerManager.hasPendingWork(cid)) {
          this.wakeConsumer(wc, [streamPath])
        }
      }
      // If READING (WAKING or LIVE in L2 terms), do nothing — no re-wake while active
    }

    // Direct webhook preferences use the L1 consumer stream index directly.
    for (const cid of this.consumerManager.store.getConsumersForStream(
      streamPath
    )) {
      if (!this.directWebhookConfigs.has(cid)) continue

      const wc = this.store.getWebhookConsumer(cid)
      const l1Consumer = this.consumerManager.store.getConsumer(cid)
      if (!wc || !l1Consumer) continue
      if (l1Consumer.wake_preference.type !== `webhook`) continue

      if (l1Consumer.state === `REGISTERED` && wc.wake_id === null) {
        if (this.consumerManager.hasPendingWork(cid)) {
          this.wakeConsumer(wc, [streamPath])
        }
      }
    }
  }

  /**
   * Called when a new stream is created.
   * No-op: consumers are created lazily on first append via onStreamAppend().
   */
  onStreamCreated(_streamPath: string): void {}

  /**
   * Called when a new stream is created and should be bound to a specific
   * subscription only. Used by DARIX spawn to ensure the entity's streams
   * are only associated with the subscription that was selected during spawn,
   * preventing stale subscriptions from creating spurious consumers.
   */
  onStreamCreatedForSubscription(
    streamPath: string,
    subscriptionId: string
  ): void {
    if (this.isShuttingDown) return

    const sub = this.store.getSubscription(subscriptionId)
    if (sub) {
      this.getOrCreateWebhookConsumer(sub.subscription_id, streamPath)
    }
  }

  /**
   * Called when a stream is deleted.
   * Removes the stream from L2 indexes and adjusts primary_stream references.
   */
  onStreamDeleted(streamPath: string): void {
    this.store.removeStreamFromIndex(streamPath)
    for (const wc of this.store.getAllWebhookConsumers()) {
      if (wc.primary_stream === streamPath) {
        const l1Consumer = this.consumerManager.store.getConsumer(
          wc.consumer_id
        )
        if (!l1Consumer || l1Consumer.streams.size === 0) continue
        wc.primary_stream = l1Consumer.streams.keys().next().value!
      }
    }
  }

  // ============================================================================
  // Wake cycle
  // ============================================================================

  private async wakeConsumer(
    wc: WebhookConsumer,
    triggeredBy: Array<string>
  ): Promise<void> {
    const target = this.getDeliveryTarget(wc)
    if (!target) {
      this.consumerManager.deleteConsumer(wc.consumer_id)
      this.store.removeWebhookConsumer(wc.consumer_id)
      return
    }

    // L1: acquire epoch (REGISTERED -> READING)
    const acqResult = this.consumerManager.acquire(wc.consumer_id)
    if (`error` in acqResult) {
      // Consumer may have been deleted or is otherwise not available
      return
    }

    const { epoch, token } = acqResult

    // L2: set wake state
    const wake_id = generateWakeId()
    wc.wake_id = wake_id
    wc.wake_id_claimed = false

    // Create root wake cycle span
    const wakeCycleSpan = tracer.startSpan(SPAN_WAKE_CYCLE, {
      attributes: {
        [ATTR.CONSUMER_ID]: wc.consumer_id,
        [ATTR.SUBSCRIPTION_ID]: wc.subscription_id,
        [ATTR.PRIMARY_STREAM]: wc.primary_stream,
        [ATTR.EPOCH]: epoch,
        [ATTR.WAKE_ID]: wake_id,
        [ATTR.TRIGGERED_BY]: triggeredBy,
      },
    })
    const wakeCycleCtx = trace.setSpan(context.active(), wakeCycleSpan)
    wc.wake_cycle_span = wakeCycleSpan
    wc.wake_cycle_ctx = wakeCycleCtx
    recordStateTransition(wakeCycleSpan, `IDLE`, `WAKING`)

    const callbackUrl = this.buildCallbackUrl(wc.consumer_id)

    // Get streams data from L1
    const l1Consumer = this.consumerManager.store.getConsumer(wc.consumer_id)
    const streamsData = l1Consumer
      ? this.consumerManager.store.getStreamsData(l1Consumer)
      : []

    let payload: Record<string, unknown> = addWebhookPayloadAliases(
      {},
      {
        consumerId: wc.consumer_id,
        epoch,
        wakeId: wake_id,
        streamPath: wc.primary_stream,
        streams: streamsData,
        triggeredBy,
        callback: callbackUrl,
        token,
      }
    )

    if (this.enrichPayload) {
      try {
        payload = addWebhookPayloadAliases(
          await this.enrichPayload(payload, wc),
          {
            consumerId: wc.consumer_id,
            epoch,
            wakeId: wake_id,
            streamPath: wc.primary_stream,
            streams: streamsData,
            triggeredBy,
            callback: callbackUrl,
            token,
          }
        )
      } catch (err) {
        serverLog.error(
          `[webhook-manager] enrichPayload failed for ${wc.consumer_id}, releasing epoch:`,
          err
        )
        this.consumerManager.release(wc.consumer_id, token)
        this.transitionToIdle(wc)
        // Schedule a delayed re-wake with backoff so we don't spin
        if (this.consumerManager.hasPendingWork(wc.consumer_id)) {
          wc.retry_count++
          const delay = this.calculateRetryDelay(wc.retry_count)
          wc.retry_timer = setTimeout(() => {
            wc.retry_timer = null
            if (
              !this.isShuttingDown &&
              this.consumerManager.hasPendingWork(wc.consumer_id)
            ) {
              this.wakeConsumer(wc, [wc.primary_stream]).catch((err) => {
                serverLog.error(
                  `[webhook-manager] retry wake failed for ${wc.consumer_id}:`,
                  err
                )
              })
            }
          }, delay)
        }
        return
      }
    }

    // Fire-and-forget — deliverWebhook handles its own errors internally
    this.deliverWebhook(wc, target, payload, token).catch(() => {})
  }

  private async deliverWebhook(
    wc: WebhookConsumer,
    sub: { webhook: string; webhook_secret: string },
    payload: Record<string, unknown>,
    token: string
  ): Promise<void> {
    const parentCtx = wc.wake_cycle_ctx ?? context.active()
    const deliverSpan = tracer.startSpan(
      SPAN_WEBHOOK_DELIVER,
      {
        attributes: {
          "http.method": `POST`,
          "http.url": sub.webhook,
          [ATTR.RETRY_COUNT]: wc.retry_count,
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
        wc.last_webhook_failure_at = null
        wc.first_webhook_failure_at = null
        wc.retry_count = 0

        // Check if response contains {done: true}
        let resBody: { done?: boolean } | null = null
        try {
          resBody = (await response.json()) as { done?: boolean }
        } catch {
          // Empty or non-JSON response body — that's fine
        }

        if (resBody?.done) {
          wc.wake_id_claimed = true
          // Auto-ack all streams to tail via L1
          const l1Consumer = this.consumerManager.store.getConsumer(
            wc.consumer_id
          )
          if (l1Consumer) {
            const tailOffsets = Array.from(l1Consumer.streams.keys()).map(
              (path) => ({
                path,
                offset: this.getTailOffset(path),
              })
            )
            if (tailOffsets.length > 0) {
              this.consumerManager.ack(wc.consumer_id, token, {
                offsets: tailOffsets,
              })
            }
          }
          // Release epoch via L1
          this.consumerManager.release(wc.consumer_id, token)
          deliverSpan.end()
          this.transitionToIdle(wc)
          // Re-wake if pending work
          if (this.consumerManager.hasPendingWork(wc.consumer_id)) {
            this.wakeConsumer(wc, [wc.primary_stream])
          }
          return
        }

        // 2xx response without {done:true} — the consumer has received
        // the notification and is processing. Transition to LIVE and let
        // the L1 lease timeout handle crash recovery from here.
        if (!wc.wake_id_claimed) {
          wc.wake_id_claimed = true
          if (wc.wake_cycle_span) {
            recordStateTransition(wc.wake_cycle_span, `WAKING`, `LIVE`)
          }
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
      if (!wc.wake_id_claimed) {
        this.scheduleRetry(wc, sub, payload, token)
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
      wc.last_webhook_failure_at = now
      if (!wc.first_webhook_failure_at) {
        wc.first_webhook_failure_at = now
      }

      if (
        wc.first_webhook_failure_at &&
        now - wc.first_webhook_failure_at > GC_FAILURE_MS
      ) {
        this.consumerManager.deleteConsumer(wc.consumer_id)
        this.store.removeWebhookConsumer(wc.consumer_id)
        return
      }

      // Schedule retry — L1 is in READING state, wake_id not yet claimed
      const l1Consumer = this.consumerManager.store.getConsumer(wc.consumer_id)
      if (l1Consumer && l1Consumer.state === `READING` && !wc.wake_id_claimed) {
        this.scheduleRetry(wc, sub, payload, token)
      }
    }
  }

  private scheduleRetry(
    wc: WebhookConsumer,
    sub: { webhook: string; webhook_secret: string },
    payload: Record<string, unknown>,
    token: string
  ): void {
    if (this.isShuttingDown) return

    wc.retry_count++
    const delay = this.calculateRetryDelay(wc.retry_count)

    if (wc.wake_cycle_span) {
      wc.wake_cycle_span.addEvent(EVENT.RETRY_SCHEDULED, {
        [ATTR.RETRY_COUNT]: wc.retry_count,
        delay_ms: delay,
      })
    }

    wc.retry_timer = setTimeout(() => {
      wc.retry_timer = null
      // Only retry if L1 is still READING and wake hasn't been claimed
      const l1Consumer = this.consumerManager.store.getConsumer(wc.consumer_id)
      if (
        l1Consumer &&
        l1Consumer.state === `READING` &&
        !wc.wake_id_claimed &&
        !this.isShuttingDown
      ) {
        this.deliverWebhook(wc, sub, payload, token)
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
  async handleCallback(
    consumerId: string,
    token: string,
    request: CallbackRequest
  ): Promise<CallbackResponse> {
    const wc = this.store.getWebhookConsumer(consumerId)
    if (!wc) {
      return {
        ok: false,
        error: {
          code: `CONSUMER_GONE`,
          message: `Consumer instance not found`,
        },
      }
    }

    const l1Consumer = this.consumerManager.store.getConsumer(consumerId)
    if (!l1Consumer) {
      return {
        ok: false,
        error: {
          code: `CONSUMER_GONE`,
          message: `Consumer instance not found`,
        },
      }
    }

    // Create child callback span under wake cycle context
    const parentCtx = wc.wake_cycle_ctx ?? context.active()
    let callbackAction: string
    if (request.done) {
      callbackAction = `done`
    } else if (request.wakeId) {
      callbackAction = `claim`
    } else if (request.acks) {
      callbackAction = `ack`
    } else {
      callbackAction = `other`
    }
    const callbackSpan = tracer.startSpan(
      SPAN_CONSUMER_CALLBACK,
      {
        attributes: {
          [ATTR.CONSUMER_ID]: consumerId,
          [ATTR.EPOCH]: l1Consumer.epoch,
          [ATTR.CALLBACK_ACTION]: callbackAction,
        },
      },
      parentCtx
    )

    // Validate token
    const tokenResult = validateCallbackToken(token, consumerId)
    if (!tokenResult.valid) {
      const newToken = generateCallbackToken(consumerId, l1Consumer.epoch)
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
          claimToken: newToken,
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
    if (request.epoch !== l1Consumer.epoch) {
      const newToken = generateCallbackToken(consumerId, l1Consumer.epoch)
      callbackSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: `STALE_EPOCH`,
      })
      callbackSpan.end()
      return {
        ok: false,
        error: {
          code: `STALE_EPOCH`,
          message: `Consumer epoch ${request.epoch} does not match current epoch ${l1Consumer.epoch}`,
        },
        claimToken: newToken,
        token: newToken,
      }
    }

    // Handle wakeId claim (idempotent — claiming an already-claimed wake
    // for the same consumer is a success, since the 2xx webhook response
    // may have already transitioned the consumer to LIVE).
    if (request.wakeId) {
      if (!this.store.claimWakeId(wc, request.wakeId)) {
        const newToken = generateCallbackToken(consumerId, l1Consumer.epoch)
        callbackSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: `ALREADY_CLAIMED`,
        })
        callbackSpan.end()
        return {
          ok: false,
          error: {
            code: `ALREADY_CLAIMED`,
            message: `Wake ID ${request.wakeId} is invalid or already claimed`,
          },
          claimToken: newToken,
          token: newToken,
        }
      }
      callbackSpan.addEvent(EVENT.WAKE_CLAIMED)
      if (wc.wake_cycle_span) {
        recordStateTransition(wc.wake_cycle_span, `WAKING`, `LIVE`)
      }
    }

    // Extend L1 lease via heartbeat ack
    this.consumerManager.ack(consumerId, token, { offsets: [] })

    // Process acks via L1 — filter to streams the consumer is subscribed to,
    // silently ignoring unknown streams (matching old webhook behavior)
    if (request.acks) {
      const validAcks = request.acks.filter((a) =>
        l1Consumer.streams.has(a.path)
      )
      if (validAcks.length > 0) {
        const ackResult = this.consumerManager.ack(consumerId, token, {
          offsets: validAcks,
        })
        if (`error` in ackResult) {
          callbackSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: ackResult.error.code,
          })
          callbackSpan.end()
          return {
            ok: false,
            error: {
              code: mapAckErrorToCallbackError(ackResult.error),
              message: ackResult.error.message,
            },
          }
        }
      }
      callbackSpan.addEvent(EVENT.ACKS_PROCESSED, {
        count: request.acks.length,
      })
    }

    // Process subscribes via L1 + sync L2 stream index
    if (request.subscribe) {
      this.consumerManager.store.addStreams(
        l1Consumer,
        request.subscribe,
        this.getTailOffset
      )
      for (const path of request.subscribe) {
        this.store.addStreamIndex(path, consumerId)
      }
    }

    // Process unsubscribes via L1 + sync L2 stream index
    if (request.unsubscribe) {
      const shouldRemove = this.consumerManager.store.removeStreams(
        l1Consumer,
        request.unsubscribe
      )
      for (const path of request.unsubscribe) {
        this.store.removeStreamIndex(path, consumerId)
      }
      if (shouldRemove) {
        callbackSpan.end()
        this.consumerManager.deleteConsumer(consumerId)
        this.store.removeWebhookConsumer(consumerId)
        return {
          ok: false,
          error: {
            code: `CONSUMER_GONE`,
            message: `Consumer removed after unsubscribing from all streams`,
          },
        }
      }
      // Update primary_stream if it was unsubscribed
      if (request.unsubscribe.includes(wc.primary_stream)) {
        const nextStream = l1Consumer.streams.keys().next().value
        if (nextStream) {
          wc.primary_stream = nextStream
        }
      }
    }

    // Process done — release epoch via L1
    if (request.done) {
      if (this.consumerManager.hasPendingWork(consumerId)) {
        callbackSpan.addEvent(EVENT.DONE_WITH_REWAKE)
        callbackSpan.end()
        // Release epoch and transition L2 to idle
        this.consumerManager.release(consumerId, token)
        this.transitionToIdle(wc)
        this.wakeConsumer(wc, [wc.primary_stream])
      } else {
        callbackSpan.addEvent(EVENT.DONE_RECEIVED)
        callbackSpan.end()
        this.consumerManager.release(consumerId, token)
        this.transitionToIdle(wc)
      }
    } else {
      callbackSpan.end()
    }

    // Only generate a new token if the current one is nearing expiry;
    // otherwise pass it back as-is to avoid unnecessary crypto work.
    const responseToken = tokenNeedsRefresh(tokenResult.exp)
      ? generateCallbackToken(consumerId, l1Consumer.epoch)
      : token

    if (responseToken !== token && wc.wake_cycle_span) {
      wc.wake_cycle_span.addEvent(EVENT.TOKEN_REFRESHED)
    }

    let entityWriteToken: string | undefined
    if (request.wakeId && this.getEntityWriteToken) {
      entityWriteToken = await this.getEntityWriteToken(wc.primary_stream)
    }

    return {
      ok: true,
      claimToken: responseToken,
      token: responseToken,
      streams: this.consumerManager.store.getStreamsData(l1Consumer),
      ...(entityWriteToken && { writeToken: entityWriteToken }),
    }
  }

  // ============================================================================
  // L2 state helpers
  // ============================================================================

  /**
   * Transition L2 webhook consumer to idle: clear wake state and end span.
   */
  private transitionToIdle(wc: WebhookConsumer): void {
    wc.wake_id = null
    wc.wake_id_claimed = false
    if (wc.wake_cycle_span) {
      recordStateTransition(wc.wake_cycle_span, `LIVE`, `IDLE`)
      wc.wake_cycle_span.end()
      wc.wake_cycle_span = null
      wc.wake_cycle_ctx = null
    }
  }

  // ============================================================================
  // Subscription management
  // ============================================================================

  /**
   * Delete a subscription and cascade to both L2 and L1 state.
   * Must be used instead of store.deleteSubscription() directly.
   */
  deleteSubscription(subscriptionId: string): boolean {
    const consumerIds = this.store.getConsumersForSubscription(subscriptionId)
    for (const cid of consumerIds) {
      this.consumerManager.deleteConsumer(cid)
    }
    return this.store.deleteSubscription(subscriptionId)
  }

  // ============================================================================
  // Consumer creation helper
  // ============================================================================

  /**
   * Get or create both L1 consumer and L2 webhook consumer.
   */
  private getOrCreateWebhookConsumer(
    subscriptionId: string,
    streamPath: string
  ): WebhookConsumer {
    const consumerId = WebhookStore.buildConsumerId(subscriptionId, streamPath)

    // Ensure L1 consumer exists (called for side effect)
    this.consumerManager.registerConsumer(consumerId, [streamPath])
    // Create L2 webhook consumer record
    return this.store.createWebhookConsumer(
      consumerId,
      subscriptionId,
      streamPath
    )
  }

  setDirectWebhookPreference(consumerId: string, webhookUrl: string): boolean {
    const consumer = this.consumerManager.store.getConsumer(consumerId)
    if (!consumer) return false

    const existing = this.directWebhookConfigs.get(consumerId)
    this.directWebhookConfigs.set(consumerId, {
      webhook: webhookUrl,
      webhook_secret: existing?.webhook_secret ?? generateWebhookSecret(),
    })

    const directSubscriptionId = this.getDirectSubscriptionId(consumerId)
    const primaryStream = consumer.streams.keys().next().value
    if (!primaryStream) return false

    const wc = this.store.createWebhookConsumer(
      consumerId,
      directSubscriptionId,
      primaryStream
    )
    wc.primary_stream = primaryStream

    if (
      consumer.state === `REGISTERED` &&
      this.consumerManager.hasPendingWork(consumerId)
    ) {
      this.wakeConsumer(wc, [primaryStream]).catch(() => {})
    }

    return true
  }

  clearDirectWebhookPreference(consumerId: string): void {
    this.directWebhookConfigs.delete(consumerId)
    const wc = this.store.getWebhookConsumer(consumerId)
    if (wc && wc.subscription_id === this.getDirectSubscriptionId(consumerId)) {
      this.store.removeWebhookConsumer(consumerId)
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private buildCallbackUrl(consumerId: string): string {
    return `${this.callbackBaseUrl}/callback/${consumerId}`
  }

  private getDirectSubscriptionId(consumerId: string): string {
    return `__direct__:${consumerId}`
  }

  private getDeliveryTarget(
    wc: WebhookConsumer
  ): { webhook: string; webhook_secret: string } | null {
    const direct = this.directWebhookConfigs.get(wc.consumer_id)
    if (direct) return direct

    const sub = this.store.getSubscription(wc.subscription_id)
    if (!sub) return null
    return {
      webhook: sub.webhook,
      webhook_secret: sub.webhook_secret,
    }
  }

  /**
   * Shut down the manager: cancel all timers.
   */
  shutdown(): void {
    this.isShuttingDown = true
    for (const wc of this.store.getAllWebhookConsumers()) {
      if (wc.wake_cycle_span) {
        endWakeCycleSpan(wc.wake_cycle_span, EVENT.SERVER_SHUTDOWN)
        wc.wake_cycle_span = null
        wc.wake_cycle_ctx = null
      }
    }
    this.store.shutdown()
  }
}
