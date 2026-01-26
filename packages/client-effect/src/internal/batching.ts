/**
 * Queue-based batching utilities for the idempotent producer.
 */
import { Deferred, Effect, Fiber, Queue, Ref } from "effect"
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
  inFlightCount: number
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
  readonly enqueue: (data: Uint8Array) => Effect.Effect<void, Error | ProducerClosedError>

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
      inFlightCount: 0,
    })

    const sendQueue = yield* Queue.unbounded<Batch>()

    // Process a single batch
    const processBatch = (batch: Batch): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          inFlightCount: s.inFlightCount + 1,
        }))

        const result = yield* Effect.either(config.sendBatch(batch))

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

    // Start the send worker
    const sendWorker = Effect.gen(function* () {
      while (true) {
        const batch = yield* Queue.take(sendQueue)

        // Check if we're at max concurrency
        const state = yield* Ref.get(stateRef)
        if (state.inFlightCount >= config.maxInFlight) {
          yield* Effect.yieldNow()
        }

        // Process batch in background
        yield* Effect.fork(processBatch(batch))
      }
    })

    // Fork the send worker
    yield* Effect.forkDaemon(sendWorker)

    const enqueueBatch = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      if (state.pendingMessages.length === 0) {
        return
      }

      const batch: Batch = {
        messages: [...state.pendingMessages],
        seq: state.nextSeq,
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

    // Wait for all in-flight batches to complete
    const waitForInFlight = Effect.gen(function* () {
      while (true) {
        const state = yield* Ref.get(stateRef)
        if (state.inFlightCount === 0) break
        yield* Effect.sleep(10)
      }
    })

    const enqueue = (data: Uint8Array): Effect.Effect<void, Error | ProducerClosedError> =>
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
