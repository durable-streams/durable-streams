/**
 * Layer 1 consumer lifecycle: acquire, ack, release, lease-based liveness.
 * Mechanism-independent — no references to webhooks or any L2 concept.
 *
 * Lease model (RFC § Liveness): Each consumer has a configurable lease_ttl.
 * The epoch is released when last_ack_time + lease_ttl is exceeded.
 * Both cursor-advancing acks and empty acks reset last_ack_time.
 * Empty acks are the heartbeat shape — they MUST NOT force a durable cursor write.
 */

import { ConsumerStore } from "./consumer-store"
import {
  generateCallbackToken,
  tokenNeedsRefresh,
  validateCallbackToken,
} from "./crypto"
import { serverLog } from "./log"
import type {
  AckRequest,
  AcquireResponse,
  Consumer,
  ConsumerError,
  ConsumerInfo,
  ReleaseResponse,
  WakePreference,
} from "./consumer-types"

export class ConsumerManager {
  readonly store: ConsumerStore
  private getTailOffset: (path: string) => string
  private isShuttingDown = false

  /**
   * Callbacks invoked when a consumer's lease expires.
   * L2 layers register here to react (e.g., webhook re-wake).
   */
  private leaseExpiredCallbacks: Array<(consumer: Consumer) => void> = []

  onLeaseExpired(cb: (consumer: Consumer) => void): void {
    this.leaseExpiredCallbacks.push(cb)
  }

  /**
   * Callbacks invoked when a consumer is deleted.
   * L2 layers register here to clean up associated state
   * (e.g., remove WebhookConsumer records, cancel retry timers).
   */
  private consumerDeletedCallbacks: Array<(consumerId: string) => void> = []

  onConsumerDeleted(cb: (consumerId: string) => void): void {
    this.consumerDeletedCallbacks.push(cb)
  }

  /**
   * Callbacks invoked when a consumer's epoch is acquired.
   * L2 layers register here to track claims (e.g., pull-wake writes "claimed" events).
   *
   * Critical callbacks run first — if any throw, the acquire is rolled back
   * and returned as an error. Non-critical callbacks are swallowed with a log.
   */
  private epochAcquiredCallbacks: Array<
    (consumerId: string, epoch: number, worker?: string) => void
  > = []
  private criticalEpochAcquiredCallbacks: Array<
    (consumerId: string, epoch: number, worker?: string) => void
  > = []

  onEpochAcquired(
    cb: (consumerId: string, epoch: number, worker?: string) => void
  ): void {
    this.epochAcquiredCallbacks.push(cb)
  }

  onEpochAcquiredCritical(
    cb: (consumerId: string, epoch: number, worker?: string) => void
  ): void {
    this.criticalEpochAcquiredCallbacks.push(cb)
  }

  /**
   * Callbacks invoked when a consumer's epoch is released.
   * L2 layers register here to react (e.g., pull-wake re-wake if pending work).
   */
  private epochReleasedCallbacks: Array<(consumerId: string) => void> = []

  onEpochReleased(cb: (consumerId: string) => void): void {
    this.epochReleasedCallbacks.push(cb)
  }

  constructor(opts: { getTailOffset: (path: string) => string }) {
    this.store = new ConsumerStore()
    this.getTailOffset = opts.getTailOffset
  }

  // ============================================================================
  // Registration
  // ============================================================================

  registerConsumer(
    consumerId: string,
    streams: Array<string>,
    opts?: {
      namespace?: string
      lease_ttl_ms?: number
    }
  ): { consumer: Consumer; created: boolean } | { error: `CONFIG_MISMATCH` } {
    return this.store.registerConsumer(
      consumerId,
      streams,
      this.getTailOffset,
      opts
    )
  }

  deleteConsumer(consumerId: string): boolean {
    const removed = this.store.removeConsumer(consumerId)
    if (removed) {
      for (const cb of this.consumerDeletedCallbacks) {
        try {
          cb(consumerId)
        } catch (err) {
          serverLog.error(
            `[consumer-manager] consumerDeleted callback failed:`,
            err
          )
        }
      }
    }
    return removed
  }

  getConsumer(consumerId: string): ConsumerInfo | null {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) return null
    return {
      consumer_id: consumer.consumer_id,
      state: consumer.state,
      epoch: consumer.epoch,
      streams: this.store.getStreamsData(consumer),
      namespace: consumer.namespace,
      lease_ttl_ms: consumer.lease_ttl_ms,
      wake_preference: consumer.wake_preference,
    }
  }

  /**
   * Set the wake preference for a consumer.
   * Used by L2 layers to configure how the consumer is notified of new work.
   */
  setWakePreference(
    consumerId: string,
    preference: WakePreference
  ): Consumer | null {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) return null
    consumer.wake_preference = preference
    return consumer
  }

  // ============================================================================
  // Epoch Acquisition
  // ============================================================================

  /**
   * Acquire epoch for a consumer. Returns token + stream offsets.
   * If already READING, this is a self-supersede (crash recovery).
   * Optional `worker` parameter enables contention tracking for pull-wake.
   */
  acquire(
    consumerId: string,
    worker?: string
  ): AcquireResponse | { error: ConsumerError } {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) {
      return {
        error: {
          code: `CONSUMER_NOT_FOUND`,
          message: `Consumer '${consumerId}' does not exist`,
        },
      }
    }

    // Contention check: if consumer is READING and a DIFFERENT worker holds it, reject
    if (
      consumer.state === `READING` &&
      worker &&
      consumer.holder_id &&
      consumer.holder_id !== worker
    ) {
      return {
        error: {
          code: `EPOCH_HELD`,
          message: `Consumer is currently held by another worker`,
          holder: `active`,
        },
      }
    }

    const result = this.store.acquireEpoch(consumerId)
    if (!result) {
      return {
        error: {
          code: `CONSUMER_NOT_FOUND`,
          message: `Consumer '${consumerId}' does not exist`,
        },
      }
    }

    const token = generateCallbackToken(consumerId, result.epoch)
    consumer.token = token
    consumer.holder_id = worker ?? null

    // Start lease timer
    this.resetLeaseTimer(consumer)

    // Run critical callbacks first — failures roll back the acquire
    for (const cb of this.criticalEpochAcquiredCallbacks) {
      try {
        cb(consumerId, result.epoch, worker)
      } catch (err) {
        serverLog.error(
          `[consumer-manager] Critical epochAcquired callback failed, rolling back acquire:`,
          err
        )
        this.store.releaseEpoch(consumerId)
        return {
          error: {
            code: `INTERNAL_ERROR` as const,
            message: `L2 callback failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        }
      }
    }

    // Fire non-critical epoch acquired callbacks
    for (const cb of this.epochAcquiredCallbacks) {
      try {
        cb(consumerId, result.epoch, worker)
      } catch (err) {
        serverLog.error(
          `[consumer-manager] epochAcquired callback failed:`,
          err
        )
      }
    }

    return {
      consumer_id: consumerId,
      epoch: result.epoch,
      token,
      streams: this.store.getStreamsData(consumer),
      worker,
    }
  }

  // ============================================================================
  // Acknowledgment
  // ============================================================================

  /**
   * Process an ack request. Validates token, epoch, and offsets.
   * Empty offsets = heartbeat: resets lease timer, no durable cursor write.
   * Both empty and cursor-advancing acks reset last_ack_time (RFC § Liveness).
   */
  ack(
    consumerId: string,
    token: string,
    request: AckRequest
  ): { ok: true; token: string } | { error: ConsumerError } {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) {
      return {
        error: {
          code: `CONSUMER_NOT_FOUND`,
          message: `Consumer '${consumerId}' does not exist`,
        },
      }
    }

    // Validate token
    const tokenResult = validateCallbackToken(token, consumerId)
    if (!tokenResult.valid) {
      if (tokenResult.code === `TOKEN_EXPIRED`) {
        // Only issue a new token if the expired token was for the CURRENT epoch.
        // We can't know the expired token's epoch here (it failed validation),
        // so we don't auto-refresh. The consumer must re-acquire.
        return {
          error: {
            code: `TOKEN_EXPIRED`,
            message: `Bearer token has expired. Re-acquire the epoch to get a new token.`,
          },
        }
      }
      return {
        error: {
          code: `TOKEN_INVALID`,
          message: `Bearer token is malformed or signature invalid`,
        },
      }
    }

    // Validate token epoch matches consumer's current epoch.
    // This is the core epoch fencing check — prevents a superseded session
    // (with a still-valid token from an old epoch) from acking.
    if (tokenResult.epoch !== consumer.epoch) {
      return {
        error: {
          code: `STALE_EPOCH`,
          message: `Token epoch ${tokenResult.epoch} does not match current epoch ${consumer.epoch}`,
        },
      }
    }

    // Consumer must be in READING state
    if (consumer.state !== `READING`) {
      return {
        error: {
          code: `STALE_EPOCH`,
          message: `Consumer is not in READING state`,
        },
      }
    }

    // Empty offsets = heartbeat (extend lease, no durable cursor write)
    if (request.offsets.length === 0) {
      consumer.last_ack_at = Date.now()
      this.resetLeaseTimer(consumer)

      const responseToken = tokenNeedsRefresh(tokenResult.exp)
        ? generateCallbackToken(consumerId, consumer.epoch)
        : token

      return { ok: true, token: responseToken }
    }

    // Validate and apply offsets
    const offsetError = this.store.updateOffsets(
      consumer,
      request.offsets,
      this.getTailOffset
    )
    if (offsetError) {
      let message: string
      switch (offsetError.code) {
        case `OFFSET_REGRESSION`:
          message = `Ack offset is less than current cursor`
          break
        case `UNKNOWN_STREAM`:
          message = `Stream path is not registered for this consumer`
          break
        case `INVALID_OFFSET`:
          message = `Ack offset is invalid: it must not be -1 and cannot be beyond stream tail`
          break
      }
      return {
        error: {
          code: offsetError.code,
          message,
          path: offsetError.path,
        },
      }
    }

    // Reset lease timer (both empty and cursor-advancing acks extend the lease)
    this.resetLeaseTimer(consumer)

    const responseToken = tokenNeedsRefresh(tokenResult.exp)
      ? generateCallbackToken(consumerId, consumer.epoch)
      : token

    return { ok: true, token: responseToken }
  }

  // ============================================================================
  // Release
  // ============================================================================

  release(
    consumerId: string,
    token: string
  ): ReleaseResponse | { error: ConsumerError } {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) {
      return {
        error: {
          code: `CONSUMER_NOT_FOUND`,
          message: `Consumer '${consumerId}' does not exist`,
        },
      }
    }

    // Validate token
    const tokenResult = validateCallbackToken(token, consumerId)
    if (!tokenResult.valid) {
      return {
        error: {
          code: tokenResult.code,
          message:
            tokenResult.code === `TOKEN_EXPIRED`
              ? `Bearer token has expired`
              : `Bearer token is malformed or signature invalid`,
        },
      }
    }

    // Validate token epoch matches consumer's current epoch
    if (tokenResult.epoch !== consumer.epoch) {
      return {
        error: {
          code: `STALE_EPOCH`,
          message: `Token epoch ${tokenResult.epoch} does not match current epoch ${consumer.epoch}`,
        },
      }
    }

    if (consumer.state !== `READING`) {
      return {
        error: {
          code: `STALE_EPOCH`,
          message: `Consumer is not in READING state`,
        },
      }
    }

    this.store.releaseEpoch(consumerId)

    // Fire epoch released callbacks
    for (const cb of this.epochReleasedCallbacks) {
      try {
        cb(consumerId)
      } catch (err) {
        serverLog.error(
          `[consumer-manager] epochReleased callback failed:`,
          err
        )
      }
    }

    return { ok: true, state: `REGISTERED` }
  }

  // ============================================================================
  // Lease-Based Liveness
  // ============================================================================

  private resetLeaseTimer(consumer: Consumer): void {
    if (consumer.lease_timer) {
      clearTimeout(consumer.lease_timer)
    }

    consumer.lease_timer = setTimeout(() => {
      consumer.lease_timer = null
      if (consumer.state === `READING` && !this.isShuttingDown) {
        this.store.releaseEpoch(consumer.consumer_id)
        for (const cb of this.leaseExpiredCallbacks) {
          try {
            cb(consumer)
          } catch (err) {
            serverLog.error(
              `[consumer-manager] leaseExpired callback failed:`,
              err
            )
          }
        }
      }
    }, consumer.lease_ttl_ms)
  }

  /**
   * Expire a consumer's epoch. Public API for L2 to force-expire
   * (e.g., webhook delivery failures beyond threshold).
   */
  expireConsumer(consumerId: string): boolean {
    return this.store.releaseEpoch(consumerId)
  }

  // ============================================================================
  // Stream Hooks (called from server.ts)
  // ============================================================================

  /**
   * Called when a stream is deleted. Removes stream from all consumers.
   */
  onStreamDeleted(streamPath: string): void {
    const emptyConsumerIds = this.store.removeStreamFromAllConsumers(streamPath)
    for (const cid of emptyConsumerIds) {
      this.deleteConsumer(cid)
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  hasPendingWork(consumerId: string): boolean {
    const consumer = this.store.getConsumer(consumerId)
    if (!consumer) return false
    return this.store.hasPendingWork(consumer, this.getTailOffset)
  }

  shutdown(): void {
    this.isShuttingDown = true
    this.store.shutdown()
  }
}
