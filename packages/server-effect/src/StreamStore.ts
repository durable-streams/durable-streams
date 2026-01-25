/**
 * In-memory stream store service using Effect.
 */
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
} from "effect"
import { INITIAL_OFFSET } from "./types"
import {
  ContentTypeMismatchError,
  EmptyArrayError,
  InvalidJsonError,
  SequenceConflictError,
  StreamConflictError,
  StreamNotFoundError,
} from "./errors"
import type {
  AppendOptions,
  AppendResult,
  CreateStreamOptions,
  ProducerValidationResult,
  Stream,
  StreamMessage,
} from "./types"
import type { ServerConfigShape } from "./Config"

/**
 * Default TTL for in-memory producer state cleanup (7 days).
 */
const DEFAULT_PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Normalize content-type by extracting the media type.
 */
export function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return ``
  return contentType.split(`;`)[0]!.trim().toLowerCase()
}

/**
 * Process JSON data for append in JSON mode.
 */
function processJsonAppend(
  data: Uint8Array,
  isInitialCreate = false
): { data: Uint8Array } | { error: InvalidJsonError | EmptyArrayError } {
  const text = new TextDecoder().decode(data)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: new InvalidJsonError({ message: `Invalid JSON` }) }
  }

  let result: string
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      if (isInitialCreate) {
        return { data: new Uint8Array(0) }
      }
      return { error: new EmptyArrayError() }
    }
    const elements = parsed.map((item) => JSON.stringify(item))
    result = elements.join(`,`) + `,`
  } else {
    result = JSON.stringify(parsed) + `,`
  }

  return { data: new TextEncoder().encode(result) }
}

/**
 * Format JSON mode response by wrapping in array brackets.
 */
export function formatJsonResponse(data: Uint8Array): Uint8Array {
  if (data.length === 0) {
    return new TextEncoder().encode(`[]`)
  }

  let text = new TextDecoder().decode(data)
  text = text.trimEnd()
  if (text.endsWith(`,`)) {
    text = text.slice(0, -1)
  }

  const wrapped = `[${text}]`
  return new TextEncoder().encode(wrapped)
}

/**
 * StreamStore service interface.
 */
export interface StreamStore {
  readonly create: (
    path: string,
    options?: CreateStreamOptions
  ) => Effect.Effect<Stream, StreamConflictError>

  readonly get: (path: string) => Effect.Effect<Stream, StreamNotFoundError>

  readonly has: (path: string) => Effect.Effect<boolean>

  readonly delete: (path: string) => Effect.Effect<boolean>

  readonly append: (
    path: string,
    data: Uint8Array,
    options?: AppendOptions
  ) => Effect.Effect<
    AppendResult,
    | StreamNotFoundError
    | ContentTypeMismatchError
    | SequenceConflictError
    | InvalidJsonError
    | EmptyArrayError
  >

  readonly read: (
    path: string,
    offset?: string
  ) => Effect.Effect<
    { messages: Array<StreamMessage>; upToDate: boolean },
    StreamNotFoundError
  >

  readonly waitForMessages: (
    path: string,
    offset: string,
    timeoutMs: number
  ) => Effect.Effect<
    { messages: Array<StreamMessage>; timedOut: boolean },
    StreamNotFoundError
  >

  readonly formatResponse: (
    path: string,
    messages: Array<StreamMessage>
  ) => Effect.Effect<Uint8Array, StreamNotFoundError>

  readonly getCurrentOffset: (
    path: string
  ) => Effect.Effect<Option.Option<string>>

  readonly getProducerEpoch: (
    path: string,
    producerId: string
  ) => Effect.Effect<Option.Option<number>>

  readonly clear: () => Effect.Effect<void>

  readonly cancelAllWaits: () => Effect.Effect<void>
}

/**
 * StreamStore service tag.
 */
export const StreamStoreService: Context.Tag<StreamStoreService, StreamStore> =
  Context.GenericTag<StreamStoreService, StreamStore>(`StreamStore`)

/**
 * StreamStoreService type for Layer.
 */
export type StreamStoreService = StreamStore

/**
 * Pending wait entry using Deferred.
 */
interface PendingWait {
  path: string
  offset: string
  deferred: Deferred.Deferred<Array<StreamMessage>>
}

/**
 * Internal state for the store.
 */
interface StoreState {
  streams: Map<string, Stream>
  pendingWaits: Array<PendingWait>
  producerSemaphores: Map<string, Effect.Semaphore>
}

/**
 * Check if a stream is expired.
 */
function isExpired(stream: Stream): boolean {
  const now = Date.now()

  if (stream.expiresAt) {
    const expiryTime = new Date(stream.expiresAt).getTime()
    if (!Number.isFinite(expiryTime) || now >= expiryTime) {
      return true
    }
  }

  if (stream.ttlSeconds !== undefined) {
    const expiryTime = stream.createdAt + stream.ttlSeconds * 1000
    if (now >= expiryTime) {
      return true
    }
  }

  return false
}

/**
 * Validate producer state without mutating.
 */
function validateProducer(
  stream: Stream,
  producerId: string,
  epoch: number,
  seq: number,
  producerStateTtlMs: number = DEFAULT_PRODUCER_STATE_TTL_MS
): ProducerValidationResult {
  const now = Date.now()

  // Clean up expired producer states
  for (const [id, state] of stream.producers) {
    if (now - state.lastUpdated > producerStateTtlMs) {
      stream.producers.delete(id)
    }
  }

  const state = stream.producers.get(producerId)

  // New producer
  if (!state) {
    if (seq !== 0) {
      return { status: `sequence_gap`, expectedSeq: 0, receivedSeq: seq }
    }
    return {
      status: `accepted`,
      isNew: true,
      producerId,
      proposedState: { epoch, lastSeq: 0, lastUpdated: now },
    }
  }

  // Epoch validation
  if (epoch < state.epoch) {
    return { status: `stale_epoch`, currentEpoch: state.epoch }
  }

  if (epoch > state.epoch) {
    if (seq !== 0) {
      return { status: `invalid_epoch_seq` }
    }
    return {
      status: `accepted`,
      isNew: true,
      producerId,
      proposedState: { epoch, lastSeq: 0, lastUpdated: now },
    }
  }

  // Same epoch: sequence validation
  if (seq <= state.lastSeq) {
    return { status: `duplicate`, lastSeq: state.lastSeq }
  }

  if (seq === state.lastSeq + 1) {
    return {
      status: `accepted`,
      isNew: false,
      producerId,
      proposedState: { epoch, lastSeq: seq, lastUpdated: now },
    }
  }

  return {
    status: `sequence_gap`,
    expectedSeq: state.lastSeq + 1,
    receivedSeq: seq,
  }
}

/**
 * Append data to a stream (internal, mutates stream).
 */
function appendToStream(
  stream: Stream,
  data: Uint8Array,
  isInitialCreate = false
):
  | { message: StreamMessage | null }
  | { error: InvalidJsonError | EmptyArrayError } {
  let processedData = data

  if (normalizeContentType(stream.contentType) === `application/json`) {
    const result = processJsonAppend(data, isInitialCreate)
    if (`error` in result) {
      return result
    }
    processedData = result.data
    if (processedData.length === 0) {
      return { message: null }
    }
  }

  const parts = stream.currentOffset.split(`_`).map(Number)
  const readSeq = parts[0]!
  const byteOffset = parts[1]!

  const newByteOffset = byteOffset + processedData.length
  const newOffset = `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`

  const message: StreamMessage = {
    data: processedData,
    offset: newOffset,
    timestamp: Date.now(),
  }

  stream.messages.push(message)
  stream.currentOffset = newOffset

  return { message }
}

/**
 * Find messages after the given offset.
 */
function findMessagesAfterOffset(
  stream: Stream,
  offset: string
): Array<StreamMessage> {
  const result: Array<StreamMessage> = []
  for (const msg of stream.messages) {
    if (msg.offset > offset) {
      result.push(msg)
    }
  }
  return result
}

/**
 * Get or create a semaphore for producer locking.
 */
const getOrCreateSemaphore = (
  stateRef: Ref.Ref<StoreState>,
  lockKey: string
): Effect.Effect<Effect.Semaphore> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef)
    const existing = state.producerSemaphores.get(lockKey)
    if (existing) {
      return existing
    }

    const semaphore = yield* Effect.makeSemaphore(1)
    yield* Ref.update(stateRef, (s) => ({
      ...s,
      producerSemaphores: new Map(s.producerSemaphores).set(lockKey, semaphore),
    }))
    return semaphore
  })

/**
 * Create the in-memory StreamStore implementation.
 */
export const makeStreamStore = (
  config?: Partial<ServerConfigShape>
): Effect.Effect<StreamStore> =>
  Effect.gen(function* () {
    const producerStateTtlMs = config?.producerStateTtl
      ? Duration.toMillis(config.producerStateTtl)
      : DEFAULT_PRODUCER_STATE_TTL_MS

    const stateRef = yield* Ref.make<StoreState>({
      streams: new Map(),
      pendingWaits: [],
      producerSemaphores: new Map(),
    })

    const notificationPubSub = yield* PubSub.unbounded<string>()

    /**
     * Get stream if not expired, deleting if expired.
     */
    const getStream = (path: string): Effect.Effect<Stream | undefined> =>
      Ref.modify(stateRef, (state) => {
        const stream = state.streams.get(path)
        if (!stream) return [undefined, state]
        if (isExpired(stream)) {
          const newStreams = new Map(state.streams)
          newStreams.delete(path)
          return [undefined, { ...state, streams: newStreams }]
        }
        return [stream, state]
      })

    /**
     * Notify pending waits for a path.
     */
    const notifyWaiters = (path: string, stream: Stream): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const toNotify = state.pendingWaits.filter((w) => w.path === path)

        for (const wait of toNotify) {
          const messages = findMessagesAfterOffset(stream, wait.offset)
          if (messages.length > 0) {
            yield* Deferred.succeed(wait.deferred, messages)
          }
        }

        yield* Ref.update(stateRef, (s) => ({
          ...s,
          pendingWaits: s.pendingWaits.filter(
            (w) =>
              w.path !== path ||
              !toNotify.some((n) => n.deferred === w.deferred)
          ),
        }))
      })

    const store: StreamStore = {
      create: (path, options = {}) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          const existing = state.streams.get(path)

          if (existing && !isExpired(existing)) {
            const contentTypeMatches =
              (normalizeContentType(options.contentType) ||
                `application/octet-stream`) ===
              (normalizeContentType(existing.contentType) ||
                `application/octet-stream`)
            const ttlMatches = options.ttlSeconds === existing.ttlSeconds
            const expiresMatches = options.expiresAt === existing.expiresAt

            if (contentTypeMatches && ttlMatches && expiresMatches) {
              return existing
            }
            return yield* new StreamConflictError({
              path,
              message: `Stream already exists with different configuration`,
            })
          }

          const newStream: Stream = {
            path,
            contentType: options.contentType,
            messages: [],
            currentOffset: INITIAL_OFFSET,
            ttlSeconds: options.ttlSeconds,
            expiresAt: options.expiresAt,
            createdAt: Date.now(),
            producers: new Map(),
          }

          // Handle initial data
          if (options.initialData && options.initialData.length > 0) {
            appendToStream(newStream, options.initialData, true)
            // Ignore errors for initial create (empty arrays are fine)
          }

          yield* Ref.update(stateRef, (s) => ({
            ...s,
            streams: new Map(s.streams).set(path, newStream),
          }))

          yield* Effect.log(`Stream created: ${path}`)
          return newStream
        }).pipe(
          Effect.withSpan(`StreamStore.create`, { attributes: { path } })
        ),

      get: (path) =>
        Effect.gen(function* () {
          const stream = yield* getStream(path)
          if (!stream) {
            return yield* new StreamNotFoundError({ path })
          }
          return stream
        }),

      has: (path) =>
        Effect.gen(function* () {
          const stream = yield* getStream(path)
          return stream !== undefined
        }),

      delete: (path) =>
        Effect.gen(function* () {
          // Cancel pending waits
          const state = yield* Ref.get(stateRef)
          const toCancel = state.pendingWaits.filter((w) => w.path === path)
          for (const wait of toCancel) {
            yield* Deferred.succeed(wait.deferred, [])
          }

          yield* Ref.update(stateRef, (s) => ({
            ...s,
            pendingWaits: s.pendingWaits.filter((w) => w.path !== path),
          }))

          const deleted = yield* Ref.modify(stateRef, (s) => {
            const existed = s.streams.has(path)
            if (existed) {
              const newStreams = new Map(s.streams)
              newStreams.delete(path)
              return [true, { ...s, streams: newStreams }]
            }
            return [false, s]
          })

          if (deleted) {
            yield* Effect.log(`Stream deleted: ${path}`)
          }
          return deleted
        }).pipe(
          Effect.withSpan(`StreamStore.delete`, { attributes: { path } })
        ),

      append: (path, data, options = {}) =>
        Effect.gen(function* () {
          const hasProducer =
            options.producerId !== undefined &&
            options.producerEpoch !== undefined &&
            options.producerSeq !== undefined

          const appendLogic = Effect.gen(function* () {
            const stream = yield* getStream(path)
            if (!stream) {
              return yield* new StreamNotFoundError({ path })
            }

            // Check content type match
            if (options.contentType && stream.contentType) {
              const providedType = normalizeContentType(options.contentType)
              const streamType = normalizeContentType(stream.contentType)
              if (providedType !== streamType) {
                return yield* new ContentTypeMismatchError({
                  expected: stream.contentType,
                  received: options.contentType,
                })
              }
            }

            // Validate producer first
            let producerResult: ProducerValidationResult | undefined
            if (hasProducer) {
              producerResult = validateProducer(
                stream,
                options.producerId!,
                options.producerEpoch!,
                options.producerSeq!,
                producerStateTtlMs
              )

              if (producerResult.status !== `accepted`) {
                return { message: null, producerResult }
              }
            }

            // Check Stream-Seq (lexicographic comparison per protocol)
            if (options.seq !== undefined) {
              if (
                stream.lastSeq !== undefined &&
                options.seq <= stream.lastSeq
              ) {
                return yield* new SequenceConflictError({
                  currentSeq: stream.lastSeq,
                  receivedSeq: options.seq,
                })
              }
            }

            // Append data
            const appendResult = appendToStream(stream, data)
            if (`error` in appendResult) {
              return yield* appendResult.error
            }

            // Commit producer state
            if (producerResult && producerResult.status === `accepted`) {
              stream.producers.set(
                producerResult.producerId,
                producerResult.proposedState
              )
            }

            // Update Stream-Seq
            if (options.seq !== undefined) {
              stream.lastSeq = options.seq
            }

            // Notify waiters
            if (appendResult.message) {
              yield* PubSub.publish(notificationPubSub, path)
              yield* notifyWaiters(path, stream)
            }

            return { message: appendResult.message, producerResult }
          })

          // Use semaphore for producer serialization
          if (hasProducer) {
            const lockKey = `${path}:${options.producerId}`
            const semaphore = yield* getOrCreateSemaphore(stateRef, lockKey)
            return yield* semaphore.withPermits(1)(appendLogic)
          }

          return yield* appendLogic
        }).pipe(
          Effect.withSpan(`StreamStore.append`, { attributes: { path } })
        ),

      read: (path, offset) =>
        Effect.gen(function* () {
          const stream = yield* getStream(path)
          if (!stream) {
            return yield* new StreamNotFoundError({ path })
          }

          if (!offset || offset === `-1`) {
            return { messages: [...stream.messages], upToDate: true }
          }

          const messages = findMessagesAfterOffset(stream, offset)
          return { messages, upToDate: true }
        }),

      waitForMessages: (path, offset, timeoutMs) =>
        Effect.gen(function* () {
          const stream = yield* getStream(path)
          if (!stream) {
            return yield* new StreamNotFoundError({ path })
          }

          // Check for existing messages first
          const existingMessages = findMessagesAfterOffset(stream, offset)
          if (existingMessages.length > 0) {
            return { messages: existingMessages, timedOut: false }
          }

          // Create deferred for waiting
          const deferred = yield* Deferred.make<Array<StreamMessage>>()

          const wait: PendingWait = { path, offset, deferred }

          // Add to pending waits
          yield* Ref.update(stateRef, (s) => ({
            ...s,
            pendingWaits: [...s.pendingWaits, wait],
          }))

          // Race between deferred completion and timeout
          const result = yield* Effect.race(
            Deferred.await(deferred).pipe(
              Effect.map((messages) => ({ messages, timedOut: false }))
            ),
            Effect.sleep(Duration.millis(timeoutMs)).pipe(
              Effect.as({
                messages: [] as Array<StreamMessage>,
                timedOut: true,
              })
            )
          )

          // Cleanup: remove from pending waits
          yield* Ref.update(stateRef, (s) => ({
            ...s,
            pendingWaits: s.pendingWaits.filter((w) => w.deferred !== deferred),
          }))

          return result
        }).pipe(
          Effect.withSpan(`StreamStore.waitForMessages`, {
            attributes: { path, offset },
          })
        ),

      formatResponse: (path, messages) =>
        Effect.gen(function* () {
          const stream = yield* getStream(path)
          if (!stream) {
            return yield* new StreamNotFoundError({ path })
          }

          // Concatenate all message data
          const totalSize = messages.reduce((sum, m) => sum + m.data.length, 0)
          const concatenated = new Uint8Array(totalSize)
          let offset = 0
          for (const msg of messages) {
            concatenated.set(msg.data, offset)
            offset += msg.data.length
          }

          // For JSON mode, wrap in array brackets
          if (normalizeContentType(stream.contentType) === `application/json`) {
            return formatJsonResponse(concatenated)
          }

          return concatenated
        }),

      getCurrentOffset: (path) =>
        Effect.gen(function* () {
          const stream = yield* getStream(path)
          return stream ? Option.some(stream.currentOffset) : Option.none()
        }),

      getProducerEpoch: (path, producerId) =>
        Effect.gen(function* () {
          const stream = yield* getStream(path)
          if (!stream) return Option.none()
          const state = stream.producers.get(producerId)
          return state ? Option.some(state.epoch) : Option.none()
        }),

      clear: () =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          for (const wait of state.pendingWaits) {
            yield* Deferred.succeed(wait.deferred, [])
          }
          yield* Ref.set(stateRef, {
            streams: new Map(),
            pendingWaits: [],
            producerSemaphores: new Map(),
          })
          yield* Effect.log(`Store cleared`)
        }).pipe(Effect.withSpan(`StreamStore.clear`)),

      cancelAllWaits: () =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          for (const wait of state.pendingWaits) {
            yield* Deferred.succeed(wait.deferred, [])
          }
          yield* Ref.update(stateRef, (s) => ({ ...s, pendingWaits: [] }))
        }),
    }

    return store
  })

/**
 * StreamStore live layer (with default config).
 */
export const StreamStoreLive: Layer.Layer<StreamStoreService> = Layer.effect(
  StreamStoreService,
  makeStreamStore()
)

/**
 * Create a StreamStore layer with custom configuration.
 */
export const makeStreamStoreLive = (
  config?: Partial<ServerConfigShape>
): Layer.Layer<StreamStoreService> =>
  Layer.effect(StreamStoreService, makeStreamStore(config))
