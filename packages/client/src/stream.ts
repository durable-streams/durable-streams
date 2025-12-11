/**
 * DurableStream - A handle to a remote durable stream for read/write operations.
 *
 * Following the Electric Durable Stream Protocol specification.
 */

import {
  DurableStreamError,
  InvalidSignalError,
  MissingStreamUrlError,
} from "./error"
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
import type {
  AppendOptions,
  CreateOptions,
  HeadResult,
  MaybePromise,
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
 * Create sessions as needed via stream() or the legacy read() method.
 *
 * @example
 * ```typescript
 * // Create a new stream
 * const stream = await DurableStream.create({
 *   url: "https://streams.example.com/my-stream",
 *   auth: { token: "my-token" },
 *   contentType: "application/json"
 * });
 *
 * // Write data
 * await stream.append({ message: "hello" });
 *
 * // Read with the new API
 * const res = await stream.stream<{ message: string }>();
 * for await (const item of res.jsonItems()) {
 *   console.log(item.message);
 * }
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
      if (response.status === 404) {
        throw new DurableStreamError(
          `Stream not found: ${this.url}`,
          `NOT_FOUND`,
          404
        )
      }
      throw await DurableStreamError.fromResponse(response, this.url)
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
      if (response.status === 409) {
        throw new DurableStreamError(
          `Stream already exists: ${this.url}`,
          `CONFLICT_EXISTS`,
          409
        )
      }
      throw await DurableStreamError.fromResponse(response, this.url)
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
      if (response.status === 404) {
        throw new DurableStreamError(
          `Stream not found: ${this.url}`,
          `NOT_FOUND`,
          404
        )
      }
      throw await DurableStreamError.fromResponse(response, this.url)
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
      if (response.status === 404) {
        throw new DurableStreamError(
          `Stream not found: ${this.url}`,
          `NOT_FOUND`,
          404
        )
      }
      if (response.status === 409) {
        throw new DurableStreamError(
          `Sequence conflict: seq is lower than last appended`,
          `CONFLICT_SEQ`,
          409
        )
      }
      if (response.status === 400) {
        throw new DurableStreamError(
          `Bad request (possibly content-type mismatch)`,
          `BAD_REQUEST`,
          400
        )
      }
      throw await DurableStreamError.fromResponse(response, this.url)
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
      if (response.status === 404) {
        throw new DurableStreamError(
          `Stream not found: ${this.url}`,
          `NOT_FOUND`,
          404
        )
      }
      if (response.status === 409) {
        throw new DurableStreamError(
          `Sequence conflict: seq is lower than last appended`,
          `CONFLICT_SEQ`,
          409
        )
      }
      throw await DurableStreamError.fromResponse(response, this.url)
    }
  }

  // ============================================================================
  // Read session factory (new API)
  // ============================================================================

  /**
   * Start a fetch-like streaming session against this handle's URL/auth.
   * The first request is made inside this method; it resolves when we have
   * a valid first response, or rejects on errors.
   *
   * @example
   * ```typescript
   * const handle = await StreamHandle.connect({ url, auth });
   * const res = await handle.stream<{ message: string }>();
   *
   * // Accumulate all JSON items
   * const items = await res.json();
   *
   * // Or iterate live
   * for await (const item of res.jsonItems()) {
   *   console.log(item);
   * }
   * ```
   */
  async stream<TJson = unknown>(
    options?: Omit<StreamOptions, `url` | `auth`>
  ): Promise<StreamResponse<TJson>> {
    return streamFn<TJson>({
      url: this.url,
      auth: this.#options.auth,
      headers: options?.headers,
      signal: options?.signal ?? this.#options.signal,
      fetchClient: this.#options.fetch,
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
    const requestHeaders = await this.#resolveHeaders()
    const fetchUrl = new URL(this.url)

    // Add params
    const params = this.#options.params
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          const resolved = await resolveValue(value)
          fetchUrl.searchParams.set(key, resolved)
        }
      }
    }

    return { requestHeaders, fetchUrl }
  }

  /**
   * Resolve headers from auth and headers options.
   */
  async #resolveHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {}

    // Resolve auth
    const auth = this.#options.auth
    if (auth) {
      if (`token` in auth) {
        const headerName = auth.headerName ?? `authorization`
        headers[headerName] = `Bearer ${auth.token}`
      } else if (`headers` in auth) {
        Object.assign(headers, auth.headers)
      } else if (`getHeaders` in auth) {
        const authHeaders = await auth.getHeaders()
        Object.assign(headers, authHeaders)
      }
    }

    // Resolve additional headers
    const headersOpt = this.#options.headers
    if (headersOpt) {
      for (const [key, value] of Object.entries(headersOpt)) {
        headers[key] = await resolveValue(value)
      }
    }

    return headers
  }
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Resolve a value that may be a function.
 */
async function resolveValue<T>(value: T | (() => MaybePromise<T>)): Promise<T> {
  if (typeof value === `function`) {
    return (value as () => MaybePromise<T>)()
  }
  return value
}

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
