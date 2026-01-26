/**
 * HTTP client layer with retry support for Durable Streams.
 */
import { Context, Effect, Layer, Schedule } from "effect"
import {
  HttpError,
  NetworkError,
  StreamConflictError,
  StreamNotFoundError,
} from "./errors.js"
import { resolveHeaders, resolveParams } from "./internal/headers.js"
import {
  DefaultRetryOptions,
  isRetryableStatus,
  type RetryOptions,
} from "./internal/retry.js"
import { Headers as ProtocolHeaders, type HeadersRecord, type ParamsRecord } from "./types.js"

// =============================================================================
// Service Definition
// =============================================================================

/**
 * Configuration for the Durable Streams HTTP client.
 */
export interface DurableStreamsHttpClientConfig {
  /**
   * Base URL for the streams server.
   */
  readonly baseUrl?: string

  /**
   * Default headers for all requests.
   */
  readonly headers?: HeadersRecord

  /**
   * Default query parameters for all requests.
   */
  readonly params?: ParamsRecord

  /**
   * Retry options for failed requests.
   */
  readonly retry?: RetryOptions
}

/**
 * Request options for HTTP operations.
 */
export interface RequestOptions {
  readonly url: string
  readonly method: `GET` | `POST` | `PUT` | `DELETE` | `HEAD`
  readonly headers?: HeadersRecord
  readonly params?: ParamsRecord
  readonly body?: Uint8Array | string
}

/**
 * Response from HTTP operations.
 */
export interface DurableStreamsResponse {
  readonly status: number
  readonly headers: globalThis.Headers
  readonly contentType: string | undefined
  readonly body: Effect.Effect<Uint8Array>
  readonly text: Effect.Effect<string>
  readonly stream: ReadableStream<Uint8Array>
}

/**
 * The Durable Streams HTTP client service.
 */
export class DurableStreamsHttpClient extends Context.Tag(
  `@durable-streams/client-effect/DurableStreamsHttpClient`
)<
  DurableStreamsHttpClient,
  {
    readonly request: (
      options: RequestOptions
    ) => Effect.Effect<
      DurableStreamsResponse,
      HttpError | NetworkError | StreamNotFoundError | StreamConflictError
    >

    readonly get: (
      url: string,
      options?: {
        headers?: HeadersRecord
        params?: ParamsRecord
      }
    ) => Effect.Effect<
      DurableStreamsResponse,
      HttpError | NetworkError | StreamNotFoundError
    >

    readonly post: (
      url: string,
      body: Uint8Array | string,
      options?: {
        headers?: HeadersRecord
        params?: ParamsRecord
      }
    ) => Effect.Effect<DurableStreamsResponse, HttpError | NetworkError>

    readonly put: (
      url: string,
      options?: {
        headers?: HeadersRecord
        params?: ParamsRecord
        body?: Uint8Array | string
      }
    ) => Effect.Effect<
      DurableStreamsResponse,
      HttpError | NetworkError | StreamConflictError
    >

    readonly delete: (
      url: string,
      options?: {
        headers?: HeadersRecord
        params?: ParamsRecord
      }
    ) => Effect.Effect<
      DurableStreamsResponse,
      HttpError | NetworkError | StreamNotFoundError
    >

    readonly head: (
      url: string,
      options?: {
        headers?: HeadersRecord
        params?: ParamsRecord
      }
    ) => Effect.Effect<
      DurableStreamsResponse,
      HttpError | NetworkError | StreamNotFoundError
    >
  }
>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create the Durable Streams HTTP client implementation.
 */
const makeDurableStreamsHttpClient = (
  config: DurableStreamsHttpClientConfig = {}
) =>
  Effect.gen(function* () {
    const retryOpts = { ...DefaultRetryOptions, ...config.retry }

    const buildUrl = (
      url: string,
      params: Record<string, string>
    ): string => {
      const parsed = new URL(url, config.baseUrl)
      for (const [key, value] of Object.entries(params)) {
        parsed.searchParams.set(key, value)
      }
      return parsed.toString()
    }

    const executeRequest = Effect.fn(`DurableStreamsHttpClient.request`)(
      (
        options: RequestOptions
      ): Effect.Effect<
        DurableStreamsResponse,
        HttpError | NetworkError | StreamNotFoundError | StreamConflictError
      > =>
        Effect.gen(function* () {
        // Resolve dynamic headers and params
        const resolvedHeaders = yield* resolveHeaders({
          ...config.headers,
          ...options.headers,
        })
        const resolvedParams = yield* resolveParams({
          ...config.params,
          ...options.params,
        })

        // Build URL with params
        const finalUrl = buildUrl(options.url, resolvedParams)

        // Build request init
        const init: RequestInit = {
          method: options.method,
          headers: resolvedHeaders,
        }

        // Add body if present
        if (options.body !== undefined) {
          if (typeof options.body === `string`) {
            init.body = options.body
          } else {
            // Uint8Array is BodyInit-compatible in modern runtimes
            // but TypeScript's lib.dom.d.ts may not reflect this
            init.body = options.body as BodyInit
          }
        }

        // Define retryable error type
        type RetryableError = {
          readonly _tag: `RetryableError`
          readonly status: number
          readonly response: Response
        }

        // Execute with retry for retryable statuses
        const response = yield* Effect.retry(
          Effect.tryPromise({
            try: async () => {
              const resp = await fetch(finalUrl, init)
              return resp
            },
            catch: (error) =>
              new NetworkError({
                message: `Network error: ${error instanceof Error ? error.message : String(error)}`,
                cause: error,
              }),
          }).pipe(
            Effect.flatMap((resp) => {
              if (isRetryableStatus(resp.status)) {
                return Effect.fail<RetryableError>({
                  _tag: `RetryableError`,
                  status: resp.status,
                  response: resp,
                })
              }
              return Effect.succeed(resp)
            })
          ),
          {
            schedule: Schedule.recurs(retryOpts.maxRetries),
            while: (e): e is RetryableError =>
              typeof e === `object` &&
              e !== null &&
              `_tag` in e &&
              e._tag === `RetryableError`,
          }
        ).pipe(
          // Convert exhausted RetryableError to NetworkError
          Effect.mapError((e) => {
            if (typeof e === `object` && e !== null && `_tag` in e && e._tag === `RetryableError`) {
              return new NetworkError({
                message: `Request failed after retries with status ${(e as RetryableError).status}`,
              })
            }
            return e as NetworkError
          })
        )

        // Handle error responses
        if (response.status === 404) {
          return yield* new StreamNotFoundError({ url: options.url })
        }

        if (response.status === 409) {
          const bodyText = yield* Effect.promise(() =>
            response.text().catch(() => `Conflict`)
          )
          return yield* new StreamConflictError({
            url: options.url,
            message: bodyText,
          })
        }

        if (response.status >= 400) {
          const bodyText = yield* Effect.promise(() =>
            response.text().catch(() => ``)
          )
          return yield* new HttpError({
            status: response.status,
            statusText: response.statusText,
            url: options.url,
            body: bodyText || undefined,
          })
        }

        const contentType = response.headers.get(`content-type`) ?? undefined

        // Capture body for later use
        const clonedResponse = response.clone()
        // Handle null body (e.g., 204 No Content) with empty stream
        const bodyStream =
          response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })

        return {
          status: response.status,
          headers: response.headers,
          contentType,
          body: Effect.promise(async () =>
            new Uint8Array(await clonedResponse.clone().arrayBuffer())
          ),
          text: Effect.promise(async () =>
            await clonedResponse.clone().text()
          ),
          stream: bodyStream,
        }
      })
    )

    return {
      request: executeRequest,

      get: (
        url: string,
        options: { headers?: HeadersRecord; params?: ParamsRecord } = {}
      ) =>
        executeRequest({
          url,
          method: `GET`,
          headers: options.headers,
          params: options.params,
        }) as Effect.Effect<
          DurableStreamsResponse,
          HttpError | NetworkError | StreamNotFoundError
        >,

      post: (
        url: string,
        body: Uint8Array | string,
        options: { headers?: HeadersRecord; params?: ParamsRecord } = {}
      ) =>
        executeRequest({
          url,
          method: `POST`,
          headers: options.headers,
          params: options.params,
          body,
        }) as Effect.Effect<DurableStreamsResponse, HttpError | NetworkError>,

      put: (
        url: string,
        options: {
          headers?: HeadersRecord
          params?: ParamsRecord
          body?: Uint8Array | string
        } = {}
      ) =>
        executeRequest({
          url,
          method: `PUT`,
          headers: options.headers,
          params: options.params,
          body: options.body,
        }) as Effect.Effect<
          DurableStreamsResponse,
          HttpError | NetworkError | StreamConflictError
        >,

      delete: (
        url: string,
        options: { headers?: HeadersRecord; params?: ParamsRecord } = {}
      ) =>
        executeRequest({
          url,
          method: `DELETE`,
          headers: options.headers,
          params: options.params,
        }) as Effect.Effect<
          DurableStreamsResponse,
          HttpError | NetworkError | StreamNotFoundError
        >,

      head: (
        url: string,
        options: { headers?: HeadersRecord; params?: ParamsRecord } = {}
      ) =>
        executeRequest({
          url,
          method: `HEAD`,
          headers: options.headers,
          params: options.params,
        }) as Effect.Effect<
          DurableStreamsResponse,
          HttpError | NetworkError | StreamNotFoundError
        >,
    }
  })

/**
 * Create a layer that provides the Durable Streams HTTP client.
 */
export const DurableStreamsHttpClientLive = (
  config: DurableStreamsHttpClientConfig = {}
): Layer.Layer<DurableStreamsHttpClient> =>
  Layer.effect(DurableStreamsHttpClient, makeDurableStreamsHttpClient(config))

/**
 * Extract offset from response headers.
 */
export const extractOffset = (
  headers: globalThis.Headers
): string | undefined => headers.get(ProtocolHeaders.StreamOffset) ?? undefined

/**
 * Extract cursor from response headers.
 */
export const extractCursor = (
  headers: globalThis.Headers
): string | undefined => headers.get(ProtocolHeaders.StreamCursor) ?? undefined

/**
 * Check if response is up-to-date.
 */
export const isUpToDate = (headers: globalThis.Headers): boolean =>
  headers.has(ProtocolHeaders.StreamUpToDate)

/**
 * Build URL with offset and live mode query params.
 */
export const buildStreamUrl = (
  baseUrl: string,
  offset: string,
  live?: `long-poll` | `sse` | false
): string => {
  const url = new URL(baseUrl)
  url.searchParams.set(`offset`, offset)
  if (live === `long-poll` || live === `sse`) {
    url.searchParams.set(`live`, live)
  }
  return url.toString()
}
