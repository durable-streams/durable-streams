/**
 * DurableStream - A handle to a remote durable stream for read/write operations.
 *
 * Following the Electric Durable Stream Protocol specification.
 */

import { InvalidSignalError, MissingStreamUrlError } from "./error"
import {
  STREAM_EXPIRES_AT_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_TTL_HEADER,
} from "./constants"
import {
  BackoffDefaults,
  createFetchWithBackoff,
  createFetchWithConsumedBody,
} from "./fetch"
import { stream as streamFn } from "./stream-api"
import { handleErrorResponse, resolveHeaders, resolveParams } from "./utils"
import type {
  AppendOptions,
  CreateOptions,
  HeadResult,
  HeadersRecord,
  MaybePromise,
  ParamsRecord,
  StreamErrorHandler,
  StreamHandleOptions,
  StreamOptions,
  StreamResponse,
} from "./types"

import type { BackoffOptions } from "./fetch"

/**
 * Options for DurableStream constructor.
 */
export interface DurableStreamOptions extends StreamHandleOptions {
  /**
   * Additional query parameters to include in requests.
   */
  params?: {
    [key: string]: string | (() => MaybePromise<string>) | undefined
  }

  /**
   * Backoff options for retry behavior.
   */
  backoffOptions?: BackoffOptions
}

/**
 * A handle to a remote durable stream for read/write operations.
 *
 * This is a lightweight, reusable handle - not a persistent connection.
 * It does not automatically start reading or listening.
 * Create sessions as needed via stream().
 *
 * @example
 * ```typescript
 * // Create a new stream
 * const stream = await DurableStream.create({
 *   url: "https://streams.example.com/my-stream",
 *   headers: { Authorization: "Bearer my-token" },
 *   contentType: "application/json"
 * });
 *
 * // Write data
 * await stream.append({ message: "hello" });
 *
 * // Read with the new API
 * const res = await stream.stream<{ message: string }>();
 * res.subscribeJson(async (batch) => {
 *   for (const item of batch.items) {
 *     console.log(item.message);
 *   }
 * });
 * ```
 */
export class DurableStream {
  /**
   * The URL of the durable stream.
   */
  readonly url: string

  /**
   * The content type of the stream (populated after connect/head/read).
   */
  contentType?: string

  #options: DurableStreamOptions
  readonly #fetchClient: typeof fetch
  #onError?: StreamErrorHandler

  /**
   * Create a cold handle to a stream.
   * No network IO is performed by the constructor.
   */
  constructor(opts: DurableStreamOptions) {
    validateOptions(opts)
    const urlStr = opts.url instanceof URL ? opts.url.toString() : opts.url
    this.url = urlStr
    this.#options = { ...opts, url: urlStr }
    this.#onError = opts.onError

    const baseFetchClient =
      opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

    const backOffOpts = {
      ...(opts.backoffOptions ?? BackoffDefaults),
    }

    const fetchWithBackoffClient = createFetchWithBackoff(
      baseFetchClient,
      backOffOpts
    )

    this.#fetchClient = createFetchWithConsumedBody(fetchWithBackoffClient)
  }

  // ============================================================================
  // Static convenience methods
  // ============================================================================

  /**
   * Create a new stream (create-only PUT) and return a handle.
   * Fails with DurableStreamError(code="CONFLICT_EXISTS") if it already exists.
   */
  static async create(opts: CreateOptions): Promise<DurableStream> {
    const stream = new DurableStream(opts)
    await stream.create({
      contentType: opts.contentType,
      ttlSeconds: opts.ttlSeconds,
      expiresAt: opts.expiresAt,
      body: opts.body,
    })
    return stream
  }

  /**
   * Validate that a stream exists and fetch metadata via HEAD.
   * Returns a handle with contentType populated (if sent by server).
   *
   * **Important**: This only performs a HEAD request for validation - it does
   * NOT open a session or start reading data. To read from the stream, call
   * `stream()` on the returned handle.
   *
   * @example
   * ```typescript
   * // Validate stream exists before reading
   * const handle = await DurableStream.connect({ url })
   * const res = await handle.stream() // Now actually read
   * ```
   */
  static async connect(opts: DurableStreamOptions): Promise<DurableStream> {
    const stream = new DurableStream(opts)
    await stream.head()
    return stream
  }

  /**
   * HEAD metadata for a stream without creating a handle.
   */
  static async head(opts: DurableStreamOptions): Promise<HeadResult> {
    const stream = new DurableStream(opts)
    return stream.head()
  }

  /**
   * Delete a stream without creating a handle.
   */
  static async delete(opts: DurableStreamOptions): Promise<void> {
    const stream = new DurableStream(opts)
    return stream.delete()
  }

  // ============================================================================
  // Instance methods
  // ============================================================================

  /**
   * HEAD metadata for this stream.
   */
  async head(opts?: { signal?: AbortSignal }): Promise<HeadResult> {
    const { requestHeaders, fetchUrl } = await this.#buildRequest()

    const response = await this.#fetchClient(fetchUrl.toString(), {
      method: `HEAD`,
      headers: requestHeaders,
      signal: opts?.signal ?? this.#options.signal,
    })

    if (!response.ok) {
      await handleErrorResponse(response, this.url)
    }

    const contentType = response.headers.get(`content-type`) ?? undefined
    const offset = response.headers.get(STREAM_OFFSET_HEADER) ?? undefined
    const etag = response.headers.get(`etag`) ?? undefined
    const cacheControl = response.headers.get(`cache-control`) ?? undefined

    // Update instance contentType
    if (contentType) {
      this.contentType = contentType
    }

    return {
      exists: true,
      contentType,
      offset,
      etag,
      cacheControl,
    }
  }

  /**
   * Create this stream (create-only PUT) using the URL/auth from the handle.
   */
  async create(opts?: Omit<CreateOptions, keyof StreamOptions>): Promise<this> {
    const { requestHeaders, fetchUrl } = await this.#buildRequest()

    if (opts?.contentType) {
      requestHeaders[`content-type`] = opts.contentType
    }
    if (opts?.ttlSeconds !== undefined) {
      requestHeaders[STREAM_TTL_HEADER] = String(opts.ttlSeconds)
    }
    if (opts?.expiresAt) {
      requestHeaders[STREAM_EXPIRES_AT_HEADER] = opts.expiresAt
    }

    const body = encodeBody(opts?.body)

    const response = await this.#fetchClient(fetchUrl.toString(), {
      method: `PUT`,
      headers: requestHeaders,
      body,
      signal: this.#options.signal,
    })

    if (!response.ok) {
      await handleErrorResponse(response, this.url, { operation: `create` })
    }

    // Update content type from response or options
    const responseContentType = response.headers.get(`content-type`)
    if (responseContentType) {
      this.contentType = responseContentType
    } else if (opts?.contentType) {
      this.contentType = opts.contentType
    }

    return this
  }

  /**
   * Delete this stream.
   */
  async delete(opts?: { signal?: AbortSignal }): Promise<void> {
    const { requestHeaders, fetchUrl } = await this.#buildRequest()

    const response = await this.#fetchClient(fetchUrl.toString(), {
      method: `DELETE`,
      headers: requestHeaders,
      signal: opts?.signal ?? this.#options.signal,
    })

    if (!response.ok) {
      await handleErrorResponse(response, this.url)
    }
  }

  /**
   * Append a single payload to the stream.
   *
   * - `body` may be Uint8Array, string, or any Fetch BodyInit.
   * - Strings are encoded as UTF-8.
   * - `seq` (if provided) is sent as stream-seq (writer coordination).
   */
  async append(
    body: BodyInit | Uint8Array | string,
    opts?: AppendOptions
  ): Promise<void> {
    const { requestHeaders, fetchUrl } = await this.#buildRequest()

    if (opts?.contentType) {
      requestHeaders[`content-type`] = opts.contentType
    } else if (this.contentType) {
      requestHeaders[`content-type`] = this.contentType
    }

    if (opts?.seq) {
      requestHeaders[STREAM_SEQ_HEADER] = opts.seq
    }

    const encodedBody = encodeBody(body)

    const response = await this.#fetchClient(fetchUrl.toString(), {
      method: `POST`,
      headers: requestHeaders,
      body: encodedBody,
      signal: opts?.signal ?? this.#options.signal,
    })

    if (!response.ok) {
      await handleErrorResponse(response, this.url)
    }
  }

  /**
   * Append a streaming body to the stream.
   *
   * - `source` yields Uint8Array or string chunks.
   * - Strings are encoded as UTF-8; no delimiters are added.
   * - Internally uses chunked transfer or HTTP/2 streaming.
   */
  async appendStream(
    source:
      | ReadableStream<Uint8Array | string>
      | AsyncIterable<Uint8Array | string>,
    opts?: AppendOptions
  ): Promise<void> {
    const { requestHeaders, fetchUrl } = await this.#buildRequest()

    if (opts?.contentType) {
      requestHeaders[`content-type`] = opts.contentType
    } else if (this.contentType) {
      requestHeaders[`content-type`] = this.contentType
    }

    if (opts?.seq) {
      requestHeaders[STREAM_SEQ_HEADER] = opts.seq
    }

    // Convert to ReadableStream if needed
    const body = toReadableStream(source)

    const response = await this.#fetchClient(fetchUrl.toString(), {
      method: `POST`,
      headers: requestHeaders,
      body,
      // @ts-expect-error - duplex is needed for streaming but not in types
      duplex: `half`,
      signal: opts?.signal ?? this.#options.signal,
    })

    if (!response.ok) {
      await handleErrorResponse(response, this.url)
    }
  }

  // ============================================================================
  // Read session factory (new API)
  // ============================================================================

  /**
   * Start a fetch-like streaming session against this handle's URL/headers/params.
   * The first request is made inside this method; it resolves when we have
   * a valid first response, or rejects on errors.
   *
   * Call-specific headers and params are merged with handle-level ones,
   * with call-specific values taking precedence.
   *
   * @example
   * ```typescript
   * const handle = await DurableStream.connect({
   *   url,
   *   headers: { Authorization: `Bearer ${token}` }
   * });
   * const res = await handle.stream<{ message: string }>();
   *
   * // Accumulate all JSON items
   * const items = await res.json();
   *
   * // Or stream live with ReadableStream
   * const reader = res.jsonStream().getReader();
   * let result = await reader.read();
   * while (!result.done) {
   *   console.log(result.value);
   *   result = await reader.read();
   * }
   *
   * // Or use subscriber for backpressure-aware consumption
   * res.subscribeJson(async (batch) => {
   *   for (const item of batch.items) {
   *     console.log(item);
   *   }
   * });
   * ```
   */
  async stream<TJson = unknown>(
    options?: Omit<StreamOptions, `url`>
  ): Promise<StreamResponse<TJson>> {
    // Merge handle-level and call-specific headers
    const mergedHeaders: HeadersRecord = {
      ...this.#options.headers,
      ...options?.headers,
    }

    // Merge handle-level and call-specific params
    const mergedParams: ParamsRecord = {
      ...this.#options.params,
      ...options?.params,
    }

    return streamFn<TJson>({
      url: this.url,
      headers: mergedHeaders,
      params: mergedParams,
      signal: options?.signal ?? this.#options.signal,
      fetchClient: this.#options.fetch,
      backoffOptions: this.#options.backoffOptions,
      offset: options?.offset,
      live: options?.live,
      json: options?.json,
      onError: options?.onError ?? this.#onError,
    })
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  /**
   * Build request headers and URL.
   */
  async #buildRequest(): Promise<{
    requestHeaders: Record<string, string>
    fetchUrl: URL
  }> {
    const requestHeaders = await resolveHeaders(this.#options.headers)
    const fetchUrl = new URL(this.url)

    // Add params
    const params = await resolveParams(this.#options.params)
    for (const [key, value] of Object.entries(params)) {
      fetchUrl.searchParams.set(key, value)
    }

    return { requestHeaders, fetchUrl }
  }
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Encode a body value to the appropriate format.
 * Strings are encoded as UTF-8.
 */
function encodeBody(
  body: BodyInit | Uint8Array | string | undefined
): BodyInit | undefined {
  if (body === undefined) {
    return undefined
  }
  if (typeof body === `string`) {
    return new TextEncoder().encode(body)
  }
  if (body instanceof Uint8Array) {
    // Cast to ensure compatible BodyInit type
    return body as unknown as BodyInit
  }
  return body
}

/**
 * Convert an async iterable to a ReadableStream.
 */
function toReadableStream(
  source:
    | ReadableStream<Uint8Array | string>
    | AsyncIterable<Uint8Array | string>
): ReadableStream<Uint8Array> {
  // If it's already a ReadableStream, transform it
  if (source instanceof ReadableStream) {
    return source.pipeThrough(
      new TransformStream<Uint8Array | string, Uint8Array>({
        transform(chunk, controller) {
          if (typeof chunk === `string`) {
            controller.enqueue(new TextEncoder().encode(chunk))
          } else {
            controller.enqueue(chunk)
          }
        },
      })
    )
  }

  // Convert async iterable to ReadableStream
  const encoder = new TextEncoder()
  const iterator = source[Symbol.asyncIterator]()

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next()
        if (done) {
          controller.close()
        } else if (typeof value === `string`) {
          controller.enqueue(encoder.encode(value))
        } else {
          controller.enqueue(value)
        }
      } catch (e) {
        controller.error(e)
      }
    },

    cancel() {
      iterator.return?.()
    },
  })
}

/**
 * Validate stream options.
 */
function validateOptions(options: Partial<DurableStreamOptions>): void {
  if (!options.url) {
    throw new MissingStreamUrlError()
  }
  if (options.signal && !(options.signal instanceof AbortSignal)) {
    throw new InvalidSignalError()
  }
}
