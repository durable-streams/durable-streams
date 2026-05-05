/**
 * Pull-Wake Manager (L2 Mechanism B).
 *
 * Uses a Durable Stream as a wake notification channel. Workers poll the
 * wake stream for events, then race to claim via POST /consumers/{id}/acquire.
 *
 * PullWakeManager never touches epochs, offsets, or tokens — that's all L1.
 * It only writes wake/claimed events to the consumer's configured wake_stream.
 */

import type { ConsumerManager } from "./consumer-manager"
import type { Consumer } from "./consumer-types"

interface WakeStreamStore {
  has: (path: string) => boolean
  append: (path: string, data: Uint8Array) => unknown
}

export interface WakeEvent {
  type: `wake`
  stream: string
  consumer: string
  ts: number
}

export interface ClaimedEvent {
  type: `claimed`
  stream: string
  worker: string
  epoch: number
  ts: number
}

export type PullWakeEvent = WakeEvent | ClaimedEvent

export class PullWakeManager {
  private consumerManager: ConsumerManager
  private streamStore: WakeStreamStore
  private pendingWakes = new Set<string>()
  private isShuttingDown = false

  constructor(opts: {
    consumerManager: ConsumerManager
    streamStore: WakeStreamStore
  }) {
    this.consumerManager = opts.consumerManager
    this.streamStore = opts.streamStore

    // Register L1 lifecycle hooks
    this.consumerManager.onLeaseExpired(this.handleLeaseExpired.bind(this))
    this.consumerManager.onEpochAcquiredCritical(
      this.handleEpochAcquired.bind(this)
    )
    this.consumerManager.onEpochReleased(this.handleEpochReleased.bind(this))
    this.consumerManager.onConsumerDeleted((consumerId) => {
      this.pendingWakes.delete(consumerId)
    })
  }

  /**
   * Called from server.ts when events are appended to a stream.
   * Checks if any pull-wake consumers subscribed to this stream need waking.
   */
  onStreamAppend(streamPath: string): void {
    if (this.isShuttingDown) return

    const consumerIds =
      this.consumerManager.store.getConsumersForStream(streamPath)

    for (const consumerId of consumerIds) {
      const consumer = this.consumerManager.store.getConsumer(consumerId)
      if (!consumer) continue
      if (consumer.wake_preference.type !== `pull-wake`) continue

      // Only wake if consumer is REGISTERED (not currently being read)
      if (consumer.state !== `REGISTERED`) continue

      // Deduplicate: don't send multiple wakes for the same consumer
      if (this.pendingWakes.has(consumerId)) continue

      this.writeWakeEvent(consumer, streamPath)
    }
  }

  /**
   * Handle lease expiry: if consumer has pending work, re-wake.
   */
  private handleLeaseExpired(consumer: Consumer): void {
    if (this.isShuttingDown) return
    if (consumer.wake_preference.type !== `pull-wake`) return

    // Consumer just transitioned to REGISTERED via lease expiry.
    // If there's still pending work, send a re-wake.
    if (this.consumerManager.hasPendingWork(consumer.consumer_id)) {
      this.writeWakeEvent(consumer, this.getPrimaryStream(consumer))
    }
  }

  /**
   * Handle epoch acquired: write a "claimed" event to the wake stream.
   */
  private handleEpochAcquired(
    consumerId: string,
    epoch: number,
    worker?: string
  ): void {
    if (this.isShuttingDown) return

    const consumer = this.consumerManager.store.getConsumer(consumerId)
    if (!consumer) return
    if (consumer.wake_preference.type !== `pull-wake`) return

    // Clear pending wake since someone claimed it
    this.pendingWakes.delete(consumerId)

    const streamPath = this.getPrimaryStream(consumer)
    const event: ClaimedEvent = {
      type: `claimed`,
      stream: streamPath,
      worker: worker ?? `unknown`,
      epoch,
      ts: Date.now(),
    }

    this.appendToWakeStream(consumer.wake_preference.wake_stream, event)
  }

  /**
   * Handle epoch released: if consumer has pending work, re-wake.
   */
  private handleEpochReleased(consumerId: string): void {
    if (this.isShuttingDown) return

    const consumer = this.consumerManager.store.getConsumer(consumerId)
    if (!consumer) return
    if (consumer.wake_preference.type !== `pull-wake`) return

    // If there's still pending work after release, send a re-wake
    if (this.consumerManager.hasPendingWork(consumerId)) {
      this.writeWakeEvent(consumer, this.getPrimaryStream(consumer))
    }
  }

  /**
   * Write a wake event to the consumer's wake stream.
   */
  private writeWakeEvent(consumer: Consumer, streamPath: string): void {
    if (consumer.wake_preference.type !== `pull-wake`) return

    const event: WakeEvent = {
      type: `wake`,
      stream: streamPath,
      consumer: consumer.consumer_id,
      ts: Date.now(),
    }

    this.appendToWakeStream(consumer.wake_preference.wake_stream, event)
    this.pendingWakes.add(consumer.consumer_id)
  }

  /**
   * Append an event to a wake stream.
   * Wake streams are ordinary L0 streams and must be created explicitly.
   */
  private appendToWakeStream(
    wakeStreamPath: string,
    event: PullWakeEvent
  ): void {
    const data = new TextEncoder().encode(JSON.stringify(event))

    if (!this.streamStore.has(wakeStreamPath)) {
      throw new Error(
        `[pull-wake] Wake stream '${wakeStreamPath}' does not exist. ` +
          `Create the stream before setting pull-wake preference.`
      )
    }

    this.streamStore.append(wakeStreamPath, data)
  }

  /**
   * Get the primary (first) stream path for a consumer.
   */
  private getPrimaryStream(consumer: Consumer): string {
    const firstEntry = consumer.streams.entries().next()
    if (firstEntry.done) {
      throw new Error(
        `[pull-wake] Consumer '${consumer.consumer_id}' has no streams`
      )
    }
    return firstEntry.value[0]
  }

  shutdown(): void {
    this.isShuttingDown = true
    this.pendingWakes.clear()
  }

  clearPendingWake(consumerId: string): void {
    this.pendingWakes.delete(consumerId)
  }
}
