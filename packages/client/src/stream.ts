/**
 * DurableStream - A handle to a remote durable stream.
 *
 * Following the Electric Durable Stream Protocol specification.
 */

import { fetchEventSource } from "@microsoft/fetch-event-source"
import {
  DurableStreamError,
  FetchBackoffAbortError,
  InvalidSignalError,
  MissingStreamUrlError,
} from "./error"
import {
  CURSOR_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  OFFSET_QUERY_PARAM,
  SSE_COMPATIBLE_CONTENT_TYPES,
  STREAM_CURSOR_HEADER,
  STREAM_EXPIRES_AT_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_TTL_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "./constants"
import {
  BackoffDefaults,
  chainAborter,
  createFetchWithBackoff,
  createFetchWithConsumedBody,
} from "./fetch"
import type { EventSourceMessage } from "@microsoft/fetch-event-source"
import type {
  AppendOptions,
  CreateOptions,
  HeadResult,
  MaybePromise,
  Offset,
  ReadOptions,
  ReadResult,
  StreamChunk,
  StreamErrorHandler,
  StreamOptions,
} from "./types"

import type { BackoffOptions } from "./fetch"

/**
 * Options for DurableStream constructor.
 */
export interface DurableStreamOptions extends StreamOptions {
  /**
   * Backoff options for retry behavior.
   */
  backoffOptions?: BackoffOptions

  /**
   * Error handler for recoverable errors.
   *
   * **Automatic retries**: The client automatically retries 5xx server errors, network
   * errors, and 429 rate limits with exponential backoff. The `onError` callback is
   * only invoked after these automatic retries are exhausted, or for non-retryable errors.
   *
   * **Return value behavior** (following Electric client pattern):
   * - Return `{}` to retry with the same params/headers
   * - Return `{ params }` to retry with merged params
   * - Return `{ headers }` to retry with merged headers
   * - Return `void`/`undefined` to stop the stream and propagate the error
   *
   * @example
   * ```typescript
   * // Refresh auth token on 401
   * onError: async (error) => {
   *   if (error instanceof FetchError && error.status === 401) {
   *     const newToken = await refreshAuthToken()
   *     return { headers: { Authorization: `Bearer ${newToken}` } }
   *   }
   * }
   * ```
   */
  onError?: StreamErrorHandler
}

/**
 * A handle to a remote durable stream.
 *
 * This is a lightweight, reusable handle - not a persistent connection.
 * It does not automatically start reading or listening.
 * Create sessions as needed via read(), follow(), or toReadableStream().
 *
 * @example
 * ```typescript
 * // Create a handle without any network IO
 * const stream = new DurableStream({
 *   url: "https://streams.example.com/my-stream",
 *   auth: { token: "my-token" }
 * });
 *
 * // One-shot read
 * const result = await stream.read({ offset: savedOffset });
 *
 * // Follow for live updates
 * for await (const chunk of stream.follow()) {
 *   console.log(new TextDecoder().decode(chunk.data));
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
  readonly #sseFetchClient: typeof fetch
  #onError?: StreamErrorHandler

  /**
   * Create a cold handle to a stream.
   * No network IO is performed by the constructor.
   */
  constructor(opts: DurableStreamOptions) {
    validateOptions(opts)
    this.url = opts.url
    this.#options = opts
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

    this.#sseFetchClient = fetchWithBackoffClient
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
  static async connect(opts: StreamOptions): Promise<DurableStream> {
    const stream = new DurableStream(opts)
    await stream.head()
    return stream
  }

  /**
   * HEAD metadata for a stream without creating a handle.
   */
  static async head(opts: StreamOptions): Promise<HeadResult> {
    const stream = new DurableStream(opts)
    return stream.head()
  }

  /**
   * Delete a stream without creating a handle.
   */
  static async delete(opts: StreamOptions): Promise<void> {
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

  /**
   * One-shot read.
   *
   * Performs a single GET from the specified offset/mode and returns a chunk.
   * Caller is responsible for persisting the returned offset if they want to resume.
   */
  async read(opts?: ReadOptions): Promise<ReadResult> {
    const { requestHeaders, fetchUrl } = await this.#buildRequest(opts)

    const response = await this.#fetchClient(fetchUrl.toString(), {
      method: `GET`,
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
      if (response.status === 204) {
        // Long-poll timeout - no new data
        const offset =
          response.headers.get(STREAM_OFFSET_HEADER) ?? opts?.offset ?? ``
        return {
          data: new Uint8Array(0),
          offset,
          upToDate: true,
          contentType: this.contentType,
        }
      }
      throw await DurableStreamError.fromResponse(response, this.url)
    }

    return this.#parseReadResponse(response)
  }

  /**
   * Follow the stream as an AsyncIterable of chunks.
   *
   * Default behaviour:
   * - From `offset` (or start if omitted), repeatedly perform catch-up reads
   *   until a chunk with upToDate=true.
   * - Then switch to live mode:
   *   - SSE if content-type is text/* or application/json;
   *   - otherwise long-poll.
   *
   * Explicit live override:
   * - live="catchup": only catch-up, stop at upToDate.
   * - live="long-poll": start long-polling immediately from offset.
   * - live="sse": start SSE immediately (throws if SSE not supported).
   */
  follow(opts?: ReadOptions): AsyncIterable<StreamChunk> {
    const stream = this
    const liveMode = opts?.live
    // Default to -1 (start from beginning) if no offset provided
    let currentOffset = opts?.offset ?? `-1`
    let currentCursor = opts?.cursor
    let isUpToDate = false

    // Create a linked abort controller
    const aborter = new AbortController()
    const { signal, cleanup } = chainAborter(
      aborter,
      opts?.signal ?? stream.#options.signal
    )

    // SSE iterator - created once when we enter SSE mode
    let sseIterator: AsyncIterator<StreamChunk> | null = null

    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        return {
          async next(): Promise<IteratorResult<StreamChunk>> {
            try {
              // If we've been aborted, stop
              if (signal.aborted) {
                cleanup()
                return { done: true, value: undefined }
              }

              // If we have an SSE iterator, delegate to it
              if (sseIterator) {
                const result = await sseIterator.next()
                if (result.done) {
                  // SSE connection closed - cleanup
                  cleanup()
                }
                return result
              }

              // Determine which mode to use
              if (liveMode === `catchup`) {
                // Only do catch-up reads
                if (isUpToDate) {
                  cleanup()
                  return { done: true, value: undefined }
                }

                const chunk = await stream.read({
                  offset: currentOffset,
                  cursor: currentCursor,
                  signal,
                })

                currentOffset = chunk.offset
                currentCursor = chunk.cursor
                isUpToDate = chunk.upToDate

                return { done: false, value: chunk }
              }

              if (liveMode === `sse`) {
                // SSE mode - create SSE iterator and delegate
                sseIterator = stream.#createSSEIterator(
                  currentOffset,
                  currentCursor,
                  signal
                )
                return sseIterator.next()
              }

              if (liveMode === `long-poll`) {
                // Long-poll mode - skip catch-up
                const chunk = await stream.read({
                  offset: currentOffset,
                  cursor: currentCursor,
                  live: `long-poll`,
                  signal,
                })

                currentOffset = chunk.offset
                currentCursor = chunk.cursor

                return { done: false, value: chunk }
              }

              // Default mode: catch-up then auto-select live mode
              if (!isUpToDate) {
                // Catch-up phase
                const chunk = await stream.read({
                  offset: currentOffset,
                  cursor: currentCursor,
                  signal,
                })

                currentOffset = chunk.offset
                currentCursor = chunk.cursor
                isUpToDate = chunk.upToDate

                // Update content type if not set
                if (chunk.contentType && !stream.contentType) {
                  stream.contentType = chunk.contentType
                }

                return { done: false, value: chunk }
              }

              // Live phase - auto-select SSE or long-poll
              if (stream.#isSSECompatible()) {
                // Create SSE iterator and delegate
                sseIterator = stream.#createSSEIterator(
                  currentOffset,
                  currentCursor,
                  signal
                )
                return sseIterator.next()
              } else {
                // Long-poll
                const chunk = await stream.read({
                  offset: currentOffset,
                  cursor: currentCursor,
                  live: `long-poll`,
                  signal,
                })

                currentOffset = chunk.offset
                currentCursor = chunk.cursor

                return { done: false, value: chunk }
              }
            } catch (e) {
              if (e instanceof FetchBackoffAbortError) {
                cleanup()
                return { done: true, value: undefined }
              }

              // Handle error with onError callback (following Electric's pattern)
              if (stream.#onError && e instanceof Error) {
                const retryOpts = await stream.#onError(e)
                // Guard against null (typeof null === "object" in JavaScript)
                if (retryOpts && typeof retryOpts === `object`) {
                  // Update params/headers but don't reset offset
                  // We want to continue from where we left off, not refetch everything
                  if (retryOpts.params) {
                    // Merge new params with existing params to preserve other parameters
                    stream.#options.params = {
                      ...(stream.#options.params ?? {}),
                      ...retryOpts.params,
                    }
                  }

                  if (retryOpts.headers) {
                    // Merge new headers with existing headers to preserve other headers
                    stream.#options.headers = {
                      ...(stream.#options.headers ?? {}),
                      ...retryOpts.headers,
                    }
                  }

                  // Retry without cleanup - keep abort listener chain intact
                  return this.next()
                }
              }

              // Only cleanup when we're actually terminating
              cleanup()
              throw e
            }
          },

          async return(): Promise<IteratorResult<StreamChunk>> {
            // Clean up SSE iterator if it exists
            if (sseIterator?.return) {
              await sseIterator.return()
            }
            cleanup()
            aborter.abort()
            return { done: true, value: undefined }
          },
        }
      },
    }
  }

  /**
   * Wrap follow() in a Web ReadableStream for piping.
   *
   * Backpressure:
   * - One chunk is pulled from follow() per pull() call, so standard
   *   Web Streams backpressure semantics apply.
   *
   * Cancellation:
   * - rs.cancel() will stop follow() and abort any in-flight request.
   */
  toReadableStream(
    opts?: ReadOptions & { signal?: AbortSignal }
  ): ReadableStream<StreamChunk> {
    const iterator = this.follow(opts)[Symbol.asyncIterator]()

    return new ReadableStream<StreamChunk>({
      async pull(controller) {
        try {
          const { done, value } = await iterator.next()
          if (done) {
            controller.close()
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
   * Wrap follow() in a Web ReadableStream<Uint8Array> for piping raw bytes.
   *
   * This is the native format for many web stream APIs.
   */
  toByteStream(
    opts?: ReadOptions & { signal?: AbortSignal }
  ): ReadableStream<Uint8Array> {
    const iterator = this.follow(opts)[Symbol.asyncIterator]()

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await iterator.next()
          if (done) {
            controller.close()
          } else {
            controller.enqueue(value.data)
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
   * Convenience: interpret data as JSON messages.
   * Parses each chunk's data as JSON and yields the parsed values.
   */
  async *json<T = unknown>(opts?: ReadOptions): AsyncIterable<T> {
    const decoder = new TextDecoder()

    for await (const chunk of this.follow(opts)) {
      if (chunk.data.length > 0) {
        const text = decoder.decode(chunk.data)
        // Handle potential newline-delimited JSON
        const lines = text.split(`\n`).filter((l) => l.trim())
        for (const line of lines) {
          yield JSON.parse(line) as T
        }
      }
    }
  }

  /**
   * Convenience: interpret data as text (UTF-8).
   */
  async *text(
    opts?: ReadOptions & { decoder?: TextDecoder }
  ): AsyncIterable<string> {
    const decoder = opts?.decoder ?? new TextDecoder()

    for await (const chunk of this.follow(opts)) {
      if (chunk.data.length > 0) {
        yield decoder.decode(chunk.data, { stream: true })
      }
    }
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  /**
   * Build request headers and URL.
   */
  async #buildRequest(
    readOpts?: ReadOptions
  ): Promise<{ requestHeaders: Record<string, string>; fetchUrl: URL }> {
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

    // Add read options to URL
    if (readOpts) {
      // Always include offset, default to -1 (start from beginning)
      const offset = readOpts.offset ?? `-1`
      fetchUrl.searchParams.set(OFFSET_QUERY_PARAM, offset)

      if (readOpts.live) {
        fetchUrl.searchParams.set(LIVE_QUERY_PARAM, readOpts.live)
      }
      if (readOpts.cursor) {
        fetchUrl.searchParams.set(CURSOR_QUERY_PARAM, readOpts.cursor)
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

  /**
   * Parse a read response into a ReadResult.
   */
  async #parseReadResponse(response: Response): Promise<ReadResult> {
    const data = new Uint8Array(await response.arrayBuffer())
    const offset = response.headers.get(STREAM_OFFSET_HEADER) ?? ``
    const cursor = response.headers.get(STREAM_CURSOR_HEADER) ?? undefined
    const upToDate = response.headers.has(STREAM_UP_TO_DATE_HEADER)
    const etag = response.headers.get(`etag`) ?? undefined
    const contentType = response.headers.get(`content-type`) ?? undefined

    // Update instance contentType
    if (contentType && !this.contentType) {
      this.contentType = contentType
    }

    return {
      data,
      offset,
      cursor,
      upToDate,
      etag,
      contentType,
    }
  }

  /**
   * Check if the stream's content type is compatible with SSE.
   */
  #isSSECompatible(): boolean {
    if (!this.contentType) return false

    return SSE_COMPATIBLE_CONTENT_TYPES.some((prefix) =>
      this.contentType!.startsWith(prefix)
    )
  }

  /**
   * Create an SSE connection that maintains a persistent connection with an internal queue.
   * Returns an AsyncIterator that yields chunks as they arrive.
   *
   * Follows the Electric client pattern:
   * - Buffer data events until control event (up-to-date)
   * - Flush buffer on control event
   * - Use promise chain for sequential processing
   */
  #createSSEIterator(
    initialOffset: Offset | undefined,
    initialCursor: string | undefined,
    signal: AbortSignal
  ): AsyncIterator<StreamChunk> {
    // Check SSE compatibility
    if (!this.#isSSECompatible()) {
      throw new DurableStreamError(
        `SSE is not supported for content-type: ${this.contentType}`,
        `SSE_NOT_SUPPORTED`,
        400
      )
    }

    // Queue of complete chunks waiting to be consumed
    const chunkQueue: Array<StreamChunk> = []

    // Pending resolve for when next() is waiting for data
    let pendingResolve: ((result: IteratorResult<StreamChunk>) => void) | null =
      null

    // Track current offset/cursor
    let currentOffset = initialOffset
    let currentCursor = initialCursor

    // Connection state
    let connectionClosed = false
    let connectionError: Error | null = null

    // Abort controller to close the connection
    const connectionAbort = new AbortController()

    // Buffer for accumulating data events before control event
    let dataBuffer: Array<Uint8Array> = []

    const stream = this

    // Start the SSE connection (following Electric's pattern)
    const startConnection = async (): Promise<void> => {
      const { requestHeaders, fetchUrl } = await stream.#buildRequest({
        offset: currentOffset,
        cursor: currentCursor,
        live: `sse`,
      })

      try {
        await fetchEventSource(fetchUrl.toString(), {
          headers: requestHeaders,
          fetch: stream.#sseFetchClient,
          signal: signal.aborted ? signal : connectionAbort.signal,

          onopen: async (response: Response) => {
            if (!response.ok) {
              throw await DurableStreamError.fromResponse(response, stream.url)
            }

            // Update content type
            const contentType = response.headers.get(`content-type`)
            if (contentType && !stream.contentType) {
              stream.contentType = contentType
            }
          },

          onmessage: (event: EventSourceMessage) => {
            if (event.event === `data` && event.data) {
              // Data event - buffer the data (following Electric's buffer pattern)
              const data = stream.#parseSSEData(event.data)
              dataBuffer.push(data)
            } else if (event.event === `control` && event.data) {
              // Control event - flush the buffer (like Electric's up-to-date message)
              try {
                const control = JSON.parse(event.data) as {
                  [STREAM_OFFSET_HEADER]?: string
                  [STREAM_CURSOR_HEADER]?: string
                }

                const newOffset = control[STREAM_OFFSET_HEADER]
                const newCursor = control[STREAM_CURSOR_HEADER]

                // Concatenate buffered data
                const totalSize = dataBuffer.reduce(
                  (sum, buf) => sum + buf.length,
                  0
                )
                const combinedData = new Uint8Array(totalSize)
                let offset = 0
                for (const buf of dataBuffer) {
                  combinedData.set(buf, offset)
                  offset += buf.length
                }

                // Create complete chunk
                const chunk: StreamChunk = {
                  data: combinedData,
                  offset: newOffset ?? currentOffset ?? ``,
                  cursor: newCursor,
                  upToDate: true,
                  contentType: stream.contentType,
                }

                // Update state
                currentOffset = chunk.offset
                currentCursor = chunk.cursor

                // Clear buffer
                dataBuffer = []

                // If someone is waiting for data, resolve immediately
                if (pendingResolve) {
                  const resolve = pendingResolve
                  pendingResolve = null
                  resolve({ done: false, value: chunk })
                } else {
                  // Otherwise queue it
                  chunkQueue.push(chunk)
                }
              } catch {
                // Ignore malformed control messages
              }
            }
          },

          onerror: (error: Error) => {
            // Rethrow to close SSE connection (following Electric's pattern)
            throw error
          },
        })
      } catch (error) {
        // Handle abort during SSE parsing (following Electric's pattern)
        if (connectionAbort.signal.aborted || signal.aborted) {
          throw new FetchBackoffAbortError()
        }
        throw error
      }
    }

    // Start the connection (don't await - runs in background)
    const connectionPromise = startConnection().catch((e) => {
      if (e instanceof FetchBackoffAbortError) {
        connectionClosed = true
      } else {
        connectionError = e
        connectionClosed = true
      }

      // If someone is waiting, signal done or error
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ done: true, value: undefined })
      }
    })

    // Also close on external abort
    const abortHandler = (): void => {
      connectionAbort.abort()
      connectionClosed = true
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ done: true, value: undefined })
      }
    }
    signal.addEventListener(`abort`, abortHandler, { once: true })

    return {
      async next(): Promise<IteratorResult<StreamChunk>> {
        // If there's queued data, return it immediately
        if (chunkQueue.length > 0) {
          return { done: false, value: chunkQueue.shift()! }
        }

        // If connection errored, throw the error
        if (connectionError) {
          throw connectionError
        }

        // If connection closed (e.g., aborted), we're done
        if (connectionClosed || signal.aborted) {
          return { done: true, value: undefined }
        }

        // Wait for the next chunk
        return new Promise((resolve) => {
          pendingResolve = resolve
        })
      },

      async return(): Promise<IteratorResult<StreamChunk>> {
        signal.removeEventListener(`abort`, abortHandler)
        connectionAbort.abort()
        connectionClosed = true

        // Wait for connection cleanup
        await connectionPromise.catch(() => {
          // Ignore errors during cleanup
        })

        return { done: true, value: undefined }
      },
    }
  }

  /**
   * Parse SSE data payload.
   * For application/json, data is wrapped in [ and ], so we unwrap it.
   */
  #parseSSEData(data: string): Uint8Array {
    // SSE data lines are prefixed with "data: " and may be wrapped in [ ]
    // for application/json content
    const lines = data.split(`\n`)
    const content = lines
      .map((line) => {
        // Remove "data: " prefix if present
        if (line.startsWith(`data: `)) {
          return line.slice(6)
        }
        return line
      })
      .join(`\n`)

    // For JSON content, unwrap the array wrapper
    let text = content.trim()
    if (
      this.contentType?.includes(`application/json`) &&
      text.startsWith(`[`) &&
      text.endsWith(`]`)
    ) {
      // Remove the wrapper brackets and trailing comma if present
      text = text.slice(1, -1).trim()
      if (text.endsWith(`,`)) {
        text = text.slice(0, -1)
      }
    }

    return new TextEncoder().encode(text)
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
