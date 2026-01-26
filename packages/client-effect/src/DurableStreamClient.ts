/**
 * Main client service for Durable Streams.
 */
import { Context, Effect, Layer } from "effect"
import type { ClientError } from "./errors.js"
import {
  HttpError,
  NetworkError,
  StreamConflictError,
  StreamNotFoundError,
} from "./errors.js"
import {
  buildStreamUrl,
  DurableStreamsHttpClient,
  DurableStreamsHttpClientLive,
  extractOffset,
  type DurableStreamsHttpClientConfig,
  type DurableStreamsResponse,
} from "./HttpClient.js"
import { IdempotentProducer, makeIdempotentProducer } from "./IdempotentProducer.js"
import { resolveHeaders } from "./internal/headers.js"
import { makeStreamSession } from "./StreamSession.js"
import {
  Headers,
  type AppendOptions,
  type AppendResult,
  type CreateOptions,
  type CreateResult,
  type HeadResult,
  type HeadersRecord,
  type LiveMode,
  type Offset,
  type ParamsRecord,
  type ProducerOptions,
  type StreamOptions,
  type StreamSession,
} from "./types.js"

// =============================================================================
// Service Definition
// =============================================================================

/**
 * Configuration for the Durable Streams client.
 */
export interface DurableStreamClientConfig extends DurableStreamsHttpClientConfig {
  /**
   * Default content type for new streams.
   */
  readonly defaultContentType?: string
}

/**
 * The main Durable Streams client service.
 */
export class DurableStreamClient extends Context.Tag(
  `@durable-streams/client-effect/DurableStreamClient`
)<
  DurableStreamClient,
  {
    /**
     * Create a new stream.
     */
    readonly create: (
      url: string,
      options?: CreateOptions
    ) => Effect.Effect<CreateResult, StreamConflictError | HttpError | NetworkError>

    /**
     * Get stream metadata via HEAD request.
     */
    readonly head: (
      url: string,
      options?: { headers?: HeadersRecord; params?: ParamsRecord }
    ) => Effect.Effect<HeadResult, StreamNotFoundError | HttpError | NetworkError>

    /**
     * Delete a stream.
     */
    readonly delete: (
      url: string,
      options?: { headers?: HeadersRecord; params?: ParamsRecord }
    ) => Effect.Effect<void, StreamNotFoundError | HttpError | NetworkError>

    /**
     * Append data to a stream.
     */
    readonly append: (
      url: string,
      data: Uint8Array | string,
      options?: AppendOptions
    ) => Effect.Effect<AppendResult, ClientError>

    /**
     * Start a read session for streaming data.
     */
    readonly stream: <T = unknown>(
      url: string,
      options?: StreamOptions
    ) => Effect.Effect<StreamSession<T>, ClientError>

    /**
     * Create an idempotent producer for exactly-once writes.
     */
    readonly producer: (
      url: string,
      producerId: string,
      options?: ProducerOptions
    ) => Effect.Effect<IdempotentProducer, Error>
  }
>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create the Durable Streams client implementation.
 */
const makeDurableStreamClient = (config: DurableStreamClientConfig = {}) =>
  Effect.gen(function* () {
    const httpClient = yield* DurableStreamsHttpClient

    const create = Effect.fn(`DurableStreamClient.create`)(
      (
        url: string,
        options: CreateOptions = {}
      ): Effect.Effect<
        CreateResult,
        StreamConflictError | HttpError | NetworkError
      > =>
        Effect.gen(function* () {
          const headers: Record<string, string> = {}

          const contentType =
            options.contentType ?? config.defaultContentType
          if (contentType) {
            headers[`content-type`] = contentType
          }
          if (options.ttlSeconds !== undefined) {
            headers[Headers.StreamTtl] = String(options.ttlSeconds)
          }
          if (options.expiresAt) {
            headers[Headers.StreamExpiresAt] = options.expiresAt
          }

          // Merge with dynamic headers
          const resolvedHeaders = yield* resolveHeaders(options.headers)
          const allHeaders = { ...resolvedHeaders, ...headers }

          const body = options.body
            ? typeof options.body === `string`
              ? new TextEncoder().encode(options.body)
              : options.body
            : undefined

          const response = yield* httpClient.put(url, {
            headers: allHeaders,
            params: options.params,
            body,
          })

          const offset = extractOffset(response.headers) ?? `-1`
          const responseContentType =
            response.headers.get(`content-type`) ?? contentType

          return {
            offset,
            contentType: responseContentType,
          }
        })
    )

    const head = Effect.fn(`DurableStreamClient.head`)(
      (
        url: string,
        options: { headers?: HeadersRecord; params?: ParamsRecord } = {}
      ): Effect.Effect<
        HeadResult,
        StreamNotFoundError | HttpError | NetworkError
      > =>
        Effect.gen(function* () {
          const response = yield* httpClient.head(url, {
            headers: options.headers,
            params: options.params,
          })

          return {
            exists: true as const,
            offset: extractOffset(response.headers),
            contentType: response.headers.get(`content-type`) ?? undefined,
            etag: response.headers.get(`etag`) ?? undefined,
            cacheControl: response.headers.get(`cache-control`) ?? undefined,
          }
        })
    )

    const deleteStream = Effect.fn(`DurableStreamClient.delete`)(
      (
        url: string,
        options: { headers?: HeadersRecord; params?: ParamsRecord } = {}
      ): Effect.Effect<void, StreamNotFoundError | HttpError | NetworkError> =>
        Effect.gen(function* () {
          yield* httpClient.delete(url, {
            headers: options.headers,
            params: options.params,
          })
        })
    )

    const append = Effect.fn(`DurableStreamClient.append`)(
      (
        url: string,
        data: Uint8Array | string,
        options: AppendOptions = {}
      ): Effect.Effect<AppendResult, ClientError> =>
        Effect.gen(function* () {
          const headers: Record<string, string> = {}

          if (options.contentType) {
            headers[`content-type`] = options.contentType
          }
          if (options.seq) {
            headers[Headers.StreamSeq] = options.seq
          }

          const resolvedHeaders = yield* resolveHeaders(options.headers)
          const allHeaders = { ...resolvedHeaders, ...headers }

          const body =
            typeof data === `string` ? new TextEncoder().encode(data) : data

          const response = yield* httpClient.post(url, body, {
            headers: allHeaders,
            params: options.params,
          })

          const offset = extractOffset(response.headers) ?? ``

          return { offset }
        })
    )

    const stream = Effect.fn(`DurableStreamClient.stream`)(
      <T = unknown>(
        url: string,
        options: StreamOptions = {}
      ): Effect.Effect<StreamSession<T>, ClientError> =>
        Effect.gen(function* () {
          const startOffset = options.offset ?? `-1`
          const live: LiveMode = options.live ?? true

          // Build initial URL
          const initialUrl = buildStreamUrl(
            url,
            startOffset,
            live === true ? undefined : live
          )

          // Make initial request
          const initialResponse = yield* httpClient.get(initialUrl, {
            headers: options.headers,
            params: options.params,
          })

          // Determine if JSON mode
          const contentType =
            initialResponse.headers.get(`content-type`) ?? undefined
          const isJsonMode =
            options.json === true ||
            (contentType?.includes(`application/json`) ?? false)

          // Create fetch function for subsequent requests
          // Note: Errors are converted to defects since this is for internal streaming use
          const fetchNext = (
            offset: Offset,
            cursor: string | undefined
          ): Effect.Effect<DurableStreamsResponse> =>
            Effect.gen(function* () {
              const nextUrl = buildStreamUrl(
                url,
                offset,
                live === true ? `long-poll` : live
              )

              const nextParams: ParamsRecord = { ...options.params }
              if (cursor) {
                nextParams.cursor = cursor
              }

              return yield* httpClient.get(nextUrl, {
                headers: options.headers,
                params: nextParams,
              })
            }).pipe(Effect.orDie)

          // Create session
          return yield* makeStreamSession<T>(initialResponse, fetchNext, {
            live,
            isJsonMode,
            startOffset,
          })
        })
    )

    const producer = Effect.fn(`DurableStreamClient.producer`)(
      (
        url: string,
        producerId: string,
        options: ProducerOptions = {}
      ): Effect.Effect<IdempotentProducer, Error> =>
        makeIdempotentProducer(httpClient, url, producerId, options)
    )

    return {
      create,
      head,
      delete: deleteStream,
      append,
      stream,
      producer,
    }
  })

/**
 * Layer that provides the Durable Streams client.
 * Requires DurableStreamsHttpClient.
 */
export const DurableStreamClientLive = (
  config: DurableStreamClientConfig = {}
): Layer.Layer<
  DurableStreamClient,
  never,
  DurableStreamsHttpClient
> => Layer.effect(DurableStreamClient, makeDurableStreamClient(config))

/**
 * Complete layer that provides the Durable Streams client with HTTP client.
 */
export const DurableStreamClientLiveNode = (
  config: DurableStreamClientConfig = {}
): Layer.Layer<DurableStreamClient> =>
  DurableStreamClientLive(config).pipe(
    Layer.provide(DurableStreamsHttpClientLive(config))
  )
