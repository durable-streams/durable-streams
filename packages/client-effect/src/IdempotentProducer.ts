/**
 * Idempotent producer for exactly-once writes to a durable stream.
 */
import { Deferred, Effect, Fiber, Queue, Ref } from "effect"
import {
  HttpError,
  InvalidProducerOptionsError,
  ProducerClosedError,
  StaleEpochError,
} from "./errors.js"
import { encodeBatchData } from "./internal/batching.js"
import { Headers } from "./types.js"
import type { Context } from "effect"
import type { DurableStreamsHttpClient } from "./HttpClient.js"
import type { PendingMessage } from "./internal/batching.js"
import type { ProducerOptions } from "./types.js"

// =============================================================================
// Types
// =============================================================================

/**
 * State for sequence completion tracking using Deferred for proper Effect coordination.
 */
interface SeqState {
  readonly deferred: Deferred.Deferred<void, Error>
  resolved: boolean
}

/**
 * Internal state for the producer.
 */
interface ProducerState {
  epoch: number
  nextSeq: number
  pendingMessages: Array<PendingMessage>
  pendingBytes: number
  lingerFiber: Fiber.Fiber<void, never> | null
  closed: boolean
  epochClaimed: boolean
  seqState: Map<number, Map<number, SeqState>>
  inFlightCount: number
}

/**
 * A batch to be sent.
 */
interface BatchTask {
  messages: ReadonlyArray<PendingMessage>
  seq: number
  epoch: number
  totalBytes: number
}

/**
 * An idempotent producer for exactly-once writes.
 */
export interface IdempotentProducer {
  /**
   * Append data to the stream.
   * Fire-and-forget: returns immediately after adding to the batch.
   */
  readonly append: (data: Uint8Array | string) => Effect.Effect<void, Error>

  /**
   * Send any pending batch immediately and wait for all in-flight batches.
   */
  readonly flush: Effect.Effect<void, Error>

  /**
   * Flush pending messages and close the producer.
   */
  readonly close: Effect.Effect<void, Error>

  /**
   * Increment epoch and reset sequence.
   */
  readonly restart: Effect.Effect<void, Error>

  /**
   * Current epoch.
   */
  readonly epoch: Effect.Effect<number>

  /**
   * Next sequence number.
   */
  readonly nextSeq: Effect.Effect<number>

  /**
   * Number of messages in the current pending batch.
   */
  readonly pendingCount: Effect.Effect<number>
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create an idempotent producer.
 */
export const makeIdempotentProducer = (
  httpClient: Context.Tag.Service<typeof DurableStreamsHttpClient>,
  url: string,
  producerId: string,
  options: ProducerOptions = {}
): Effect.Effect<IdempotentProducer, Error> =>
  Effect.gen(function* () {
    const startEpoch = options.epoch ?? 0
    const autoClaim = options.autoClaim ?? false
    const maxBatchBytes = options.maxBatchBytes ?? 1024 * 1024 // 1MB
    const maxInFlight = options.maxInFlight ?? 5
    const lingerMs = options.lingerMs ?? 5

    // Validate inputs
    if (startEpoch < 0) {
      return yield* Effect.fail(
        new InvalidProducerOptionsError({ message: `epoch must be >= 0` })
      )
    }
    if (maxBatchBytes <= 0) {
      return yield* Effect.fail(
        new InvalidProducerOptionsError({
          message: `maxBatchBytes must be > 0`,
        })
      )
    }
    if (maxInFlight <= 0) {
      return yield* Effect.fail(
        new InvalidProducerOptionsError({ message: `maxInFlight must be > 0` })
      )
    }
    if (lingerMs < 0) {
      return yield* Effect.fail(
        new InvalidProducerOptionsError({ message: `lingerMs must be >= 0` })
      )
    }

    const stateRef = yield* Ref.make<ProducerState>({
      epoch: startEpoch,
      nextSeq: 0,
      pendingMessages: [],
      pendingBytes: 0,
      lingerFiber: null,
      closed: false,
      epochClaimed: !autoClaim,
      seqState: new Map(),
      inFlightCount: 0,
    })

    const sendQueue = yield* Queue.unbounded<BatchTask>()

    // Get content type from a HEAD request (cached)
    const contentTypeRef = yield* Ref.make<string>(`application/octet-stream`)

    const getContentType = Effect.gen(function* () {
      const cached = yield* Ref.get(contentTypeRef)
      if (cached !== `application/octet-stream`) return cached

      const headResult = yield* Effect.catchAll(
        httpClient
          .head(url)
          .pipe(
            Effect.map(
              (result) => result.contentType ?? `application/octet-stream`
            )
          ),
        () => Effect.succeed(`application/octet-stream`)
      )

      yield* Ref.set(contentTypeRef, headResult)
      return headResult
    })

    // Signal sequence completion
    const signalSeqComplete = (
      epochVal: number,
      seq: number,
      error: Error | undefined
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const epochMap = state.seqState.get(epochVal)
        const seqEntry = epochMap?.get(seq)

        if (seqEntry && !seqEntry.resolved) {
          // Complete the deferred
          if (error) {
            yield* Deferred.fail(seqEntry.deferred, error)
          } else {
            yield* Deferred.succeed(seqEntry.deferred, undefined)
          }
        }

        // Update state to mark as resolved and cleanup old entries
        yield* Ref.update(stateRef, (s) => {
          const newSeqState = new Map(s.seqState)
          let em = newSeqState.get(epochVal)
          if (!em) {
            em = new Map()
            newSeqState.set(epochVal, em)
          }

          const entry = em.get(seq)
          if (entry) {
            entry.resolved = true
          }

          // Cleanup old entries
          const cleanupThreshold = seq - maxInFlight * 3
          if (cleanupThreshold > 0) {
            for (const oldSeq of em.keys()) {
              if (oldSeq < cleanupThreshold) {
                em.delete(oldSeq)
              }
            }
          }

          return { ...s, seqState: newSeqState }
        })
      })

    // Get or create a Deferred for a sequence
    const getOrCreateSeqDeferred = (
      epochVal: number,
      seq: number
    ): Effect.Effect<Deferred.Deferred<void, Error>> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const epochMap = state.seqState.get(epochVal)
        const existing = epochMap?.get(seq)

        if (existing) {
          return existing.deferred
        }

        // Create new deferred
        const deferred = yield* Deferred.make<void, Error>()

        yield* Ref.update(stateRef, (s) => {
          const newSeqState = new Map(s.seqState)
          let em = newSeqState.get(epochVal)
          if (!em) {
            em = new Map()
            newSeqState.set(epochVal, em)
          }
          // Check again in case another fiber created it
          if (!em.has(seq)) {
            em.set(seq, { deferred, resolved: false })
          }
          return { ...s, seqState: newSeqState }
        })

        // Return the deferred (might be the one we created or an existing one)
        const updatedState = yield* Ref.get(stateRef)
        return updatedState.seqState.get(epochVal)!.get(seq)!.deferred
      })

    // Wait for sequence to complete using Deferred coordination
    const waitForSeq = (
      epochVal: number,
      seq: number
    ): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const epochMap = state.seqState.get(epochVal)
        const seqEntry = epochMap?.get(seq)

        // Already resolved
        if (seqEntry?.resolved) {
          // Check if there was an error by awaiting the deferred
          // (it will immediately return if already completed)
          yield* Deferred.await(seqEntry.deferred)
          return
        }

        // Get or create deferred and wait
        const deferred = yield* getOrCreateSeqDeferred(epochVal, seq)
        yield* Deferred.await(deferred)
      })

    // Send a batch to the server
    const doSendBatch = (
      batch: BatchTask,
      contentType: string
    ): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const batchedBody = encodeBatchData(batch.messages, contentType)

        const headers: Record<string, string> = {
          "content-type": contentType,
          [Headers.ProducerId]: producerId,
          [Headers.ProducerEpoch]: batch.epoch.toString(),
          [Headers.ProducerSeq]: batch.seq.toString(),
        }

        yield* Effect.catchAll(
          httpClient.post(url, batchedBody, { headers }),
          (error) => {
            if (error instanceof HttpError) {
              // Handle specific status codes
              if (error.status === 204) {
                // Duplicate - idempotent success
                return Effect.void
              }
              if (error.status === 403) {
                // Stale epoch
                const currentEpoch = batch.epoch
                if (autoClaim) {
                  // Auto-claim: retry with epoch+1
                  return Ref.update(stateRef, (s) => ({
                    ...s,
                    epoch: currentEpoch + 1,
                    nextSeq: 0,
                    epochClaimed: false,
                  })).pipe(
                    Effect.flatMap(() =>
                      doSendBatch(
                        { ...batch, epoch: currentEpoch + 1, seq: 0 },
                        contentType
                      )
                    )
                  )
                }
                return Effect.fail(new StaleEpochError({ currentEpoch }))
              }
              if (error.status === 409) {
                // Sequence gap - wait and retry
                const expectedSeq = batch.seq > 0 ? batch.seq - 1 : 0

                return Effect.gen(function* () {
                  // Wait for earlier sequences
                  for (let s = expectedSeq; s < batch.seq; s++) {
                    yield* waitForSeq(batch.epoch, s)
                  }
                  // Retry
                  yield* doSendBatch(batch, contentType)
                })
              }
            }
            return Effect.fail(error)
          }
        )

        // Mark epoch as claimed
        if (!batch.seq) {
          yield* Ref.update(stateRef, (s) => ({ ...s, epochClaimed: true }))
        }
      })

    // Process a single batch
    const processBatch = (batch: BatchTask): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          inFlightCount: s.inFlightCount + 1,
        }))

        const contentType = yield* getContentType
        const result = yield* Effect.either(doSendBatch(batch, contentType))

        // Signal completion
        if (result._tag === `Right`) {
          yield* signalSeqComplete(batch.epoch, batch.seq, undefined)
        } else {
          yield* signalSeqComplete(batch.epoch, batch.seq, result.left)
        }

        // Resolve or reject all message deferreds
        for (const msg of batch.messages) {
          if (result._tag === `Right`) {
            yield* Deferred.succeed(msg.deferred, undefined)
          } else {
            yield* Deferred.fail(msg.deferred, result.left)
          }
        }

        yield* Ref.update(stateRef, (s) => ({
          ...s,
          inFlightCount: s.inFlightCount - 1,
        }))
      })

    // Batch worker - processes batches with concurrency limit
    const batchWorker = Effect.gen(function* () {
      for (;;) {
        const batch = yield* Queue.take(sendQueue)

        // Check if we're at max concurrency
        const state = yield* Ref.get(stateRef)
        if (state.inFlightCount >= maxInFlight) {
          // Wait until a slot is available
          yield* Effect.yieldNow()
        }

        // Process batch in background (don't block queue)
        yield* Effect.fork(processBatch(batch))
      }
    })

    // Fork the batch worker
    yield* Effect.forkDaemon(batchWorker)

    // Enqueue the current pending batch
    const enqueuePendingBatch = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      if (state.pendingMessages.length === 0) return

      const batch: BatchTask = {
        messages: [...state.pendingMessages],
        seq: state.nextSeq,
        epoch: state.epoch,
        totalBytes: state.pendingBytes,
      }

      yield* Ref.update(stateRef, (s) => ({
        ...s,
        pendingMessages: [],
        pendingBytes: 0,
        nextSeq: s.nextSeq + 1,
        lingerFiber: null,
      }))

      yield* Queue.offer(sendQueue, batch)
    })

    // Start linger timer
    const startLingerTimer = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      if (state.lingerFiber !== null || lingerMs === 0) return

      const fiber = yield* Effect.fork(
        Effect.gen(function* () {
          yield* Effect.sleep(lingerMs)
          yield* enqueuePendingBatch
        })
      )

      yield* Ref.update(stateRef, (s) => ({ ...s, lingerFiber: fiber }))
    })

    // Cancel linger timer
    const cancelLingerTimer = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      if (state.lingerFiber !== null) {
        yield* Fiber.interrupt(state.lingerFiber)
        yield* Ref.update(stateRef, (s) => ({ ...s, lingerFiber: null }))
      }
    })

    // Wait for all in-flight batches to complete
    const waitForInFlight = Effect.gen(function* () {
      for (;;) {
        const state = yield* Ref.get(stateRef)
        if (state.inFlightCount === 0) break
        yield* Effect.sleep(10)
      }
    })

    const append = (data: Uint8Array | string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        if (state.closed) {
          return yield* Effect.fail(new ProducerClosedError({}))
        }

        const bytes =
          typeof data === `string` ? new TextEncoder().encode(data) : data

        const deferred = yield* Deferred.make<void, Error>()
        const message: PendingMessage = { data: bytes, deferred }

        yield* Ref.update(stateRef, (s) => ({
          ...s,
          pendingMessages: [...s.pendingMessages, message],
          pendingBytes: s.pendingBytes + bytes.length,
        }))

        const newState = yield* Ref.get(stateRef)

        // Check if batch should be sent immediately
        if (newState.pendingBytes >= maxBatchBytes) {
          yield* cancelLingerTimer
          yield* enqueuePendingBatch
        } else if (lingerMs > 0) {
          yield* startLingerTimer
        }

        // Wait for the message to be sent
        yield* Deferred.await(deferred)
      })

    const flush: Effect.Effect<void, Error> = Effect.gen(function* () {
      yield* cancelLingerTimer
      yield* enqueuePendingBatch
      yield* waitForInFlight
    })

    const close: Effect.Effect<void, Error> = Effect.gen(function* () {
      yield* Ref.update(stateRef, (s) => ({ ...s, closed: true }))
      yield* Effect.catchAll(flush, () => Effect.void)
      yield* Queue.shutdown(sendQueue)
    })

    const restart: Effect.Effect<void, Error> = Effect.gen(function* () {
      yield* flush
      yield* Ref.update(stateRef, (s) => ({
        ...s,
        epoch: s.epoch + 1,
        nextSeq: 0,
      }))
    })

    return {
      append,
      flush,
      close,
      restart,
      epoch: Ref.get(stateRef).pipe(Effect.map((s) => s.epoch)),
      nextSeq: Ref.get(stateRef).pipe(Effect.map((s) => s.nextSeq)),
      pendingCount: Ref.get(stateRef).pipe(
        Effect.map((s) => s.pendingMessages.length)
      ),
    }
  })
