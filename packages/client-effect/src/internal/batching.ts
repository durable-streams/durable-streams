/**
 * Queue-based batching utilities for the idempotent producer.
 */
import { Deferred, Effect, Fiber, Queue, Ref, Stream } from "effect"
import { ProducerClosedError } from "../errors.js"

/**
 * A pending message in the batch queue.
 */
export interface PendingMessage {
  readonly data: Uint8Array
  readonly deferred: Deferred.Deferred<void, Error>
}

/**
 * A batch ready to be sent.
 */
export interface Batch {
  readonly messages: ReadonlyArray<PendingMessage>
  readonly seq: number
  readonly totalBytes: number
  readonly completion: Deferred.Deferred<void, never>
}

/**
 * Configuration for the batch queue.
 */
export interface BatchQueueConfig {
  /**
   * Maximum bytes per batch before sending.
   */
  readonly maxBatchBytes: number

  /**
   * Milliseconds to wait before sending a partial batch.
   */
  readonly lingerMs: number

  /**
   * Maximum concurrent batches in flight.
   */
  readonly maxInFlight: number

  /**
   * Function to send a batch.
   */
  readonly sendBatch: (batch: Batch) => Effect.Effect<void, Error>
}

/**
 * Internal state for the batch queue.
 */
interface BatchQueueState {
  pendingMessages: Array<PendingMessage>
  pendingBytes: number
  nextSeq: number
  lingerFiber: Fiber.Fiber<void, never> | null
  closed: boolean
}

/**
 * A batch queue for accumulating and sending messages.
 */
export interface BatchQueue {
  /**
   * Enqueue a message for batching.
   * Returns when the message has been successfully sent.
   * Fails with ProducerClosedError if the queue is closed.
   */
  readonly enqueue: (
    data: Uint8Array
  ) => Effect.Effect<void, Error | ProducerClosedError>

  /**
   * Force send any pending batch immediately.
   */
  readonly flush: () => Effect.Effect<void, Error>

  /**
   * Close the queue and flush remaining messages.
   */
  readonly close: () => Effect.Effect<void, Error>
}

/**
 * Create a batch queue.
 */
export const makeBatchQueue = (
  config: BatchQueueConfig
): Effect.Effect<BatchQueue> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<BatchQueueState>({
      pendingMessages: [],
      pendingBytes: 0,
      nextSeq: 0,
      lingerFiber: null,
      closed: false,
    })

    const sendQueue = yield* Queue.unbounded<Batch>()

    // Track pending batches for zero-polling flush
    const pendingBatches = yield* Ref.make<Set<Deferred.Deferred<void, never>>>(
      new Set()
    )

    // Process a single batch
    const processBatch = (batch: Batch): Effect.Effect<void> =>
      Effect.gen(function* () {
        const result = yield* Effect.either(config.sendBatch(batch))

        // Resolve or reject all message deferreds
        for (const msg of batch.messages) {
          if (result._tag === `Right`) {
            yield* Deferred.succeed(msg.deferred, undefined)
          } else {
            yield* Deferred.fail(msg.deferred, result.left)
          }
        }

        // Signal batch completion and remove from pending set
        yield* Deferred.succeed(batch.completion, undefined)
        yield* Ref.update(pendingBatches, (s) => {
          const newSet = new Set(s)
          newSet.delete(batch.completion)
          return newSet
        })
      })

    // Process batches with Stream-based concurrency control
    yield* Stream.fromQueue(sendQueue).pipe(
      Stream.mapEffect(processBatch, { concurrency: config.maxInFlight }),
      Stream.runDrain,
      Effect.forkDaemon
    )

    const enqueueBatch = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      if (state.pendingMessages.length === 0) {
        return
      }

      // Create completion Deferred at enqueue time (before any race conditions)
      const completion = yield* Deferred.make<void, never>()
      yield* Ref.update(pendingBatches, (s) => new Set(s).add(completion))

      const batch: Batch = {
        messages: [...state.pendingMessages],
        seq: state.nextSeq,
        totalBytes: state.pendingBytes,
        completion,
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

    const startLingerTimer = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      if (state.lingerFiber !== null) {
        return
      }

      const fiber = yield* Effect.fork(
        Effect.gen(function* () {
          yield* Effect.sleep(config.lingerMs)
          yield* enqueueBatch
        })
      )

      yield* Ref.update(stateRef, (s) => ({
        ...s,
        lingerFiber: fiber,
      }))
    })

    const cancelLingerTimer = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      if (state.lingerFiber !== null) {
        yield* Fiber.interrupt(state.lingerFiber)
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          lingerFiber: null,
        }))
      }
    })

    // Wait for all in-flight batches to complete (zero-polling)
    const waitForInFlight: Effect.Effect<void> = Effect.gen(function* () {
      const pending = yield* Ref.get(pendingBatches)
      yield* Effect.all([...pending].map(Deferred.await), {
        concurrency: `unbounded`,
      })
    })

    const enqueue = (
      data: Uint8Array
    ): Effect.Effect<void, Error | ProducerClosedError> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        if (state.closed) {
          return yield* Effect.fail(new ProducerClosedError({}))
        }

        const deferred = yield* Deferred.make<void, Error>()
        const message: PendingMessage = { data, deferred }

        yield* Ref.update(stateRef, (s) => ({
          ...s,
          pendingMessages: [...s.pendingMessages, message],
          pendingBytes: s.pendingBytes + data.length,
        }))

        const newState = yield* Ref.get(stateRef)

        // Check if batch should be sent immediately
        if (newState.pendingBytes >= config.maxBatchBytes) {
          yield* cancelLingerTimer
          yield* enqueueBatch
        } else if (config.lingerMs > 0) {
          yield* startLingerTimer
        }

        // Wait for the message to be sent
        yield* Deferred.await(deferred)
      })

    const flush = (): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        yield* cancelLingerTimer
        yield* enqueueBatch
        yield* waitForInFlight
      })

    const close = (): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        yield* Ref.update(stateRef, (s) => ({ ...s, closed: true }))
        yield* flush()
        yield* Queue.shutdown(sendQueue)
      })

    return { enqueue, flush, close }
  })

/**
 * Normalize content-type by extracting the media type (before any semicolon).
 */
export const normalizeContentType = (
  contentType: string | undefined
): string => {
  if (!contentType) return ``
  const mediaType = contentType.split(`;`)[0]
  return mediaType ? mediaType.trim().toLowerCase() : ``
}

/**
 * Check if content type is JSON.
 */
export const isJsonContentType = (contentType: string | undefined): boolean =>
  normalizeContentType(contentType) === `application/json`

/**
 * Encode batch data based on content type.
 * For JSON: wrap in array and join with commas.
 * For bytes: concatenate.
 */
export const encodeBatchData = (
  messages: ReadonlyArray<PendingMessage>,
  contentType: string | undefined
): Uint8Array => {
  const isJson = isJsonContentType(contentType)

  if (isJson) {
    // For JSON mode: always send as array (server flattens one level)
    const jsonStrings = messages.map((m) => new TextDecoder().decode(m.data))
    const batchedBody = `[${jsonStrings.join(`,`)}]`
    return new TextEncoder().encode(batchedBody)
  } else {
    // For byte mode: concatenate all chunks
    const totalSize = messages.reduce((sum, m) => sum + m.data.length, 0)
    const concatenated = new Uint8Array(totalSize)
    let offset = 0
    for (const msg of messages) {
      concatenated.set(msg.data, offset)
      offset += msg.data.length
    }
    return concatenated
  }
}
