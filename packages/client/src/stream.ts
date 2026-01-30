/**
 * DurableStream - A handle to a remote durable stream for read/write operations.
 *
 * Following the Electric Durable Stream Protocol specification.
 */

import fastq from "fastq"

import {
  InvalidSignalError,
  MissingStreamUrlError,
  StreamClosedError,
} from "./error"
import { IdempotentProducer } from "./idempotent-producer"
import {
  STREAM_CLOSED_HEADER,
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
import {
  handleErrorResponse,
  resolveHeaders,
  resolveParams,
  warnIfUsingHttpInBrowser,
} from "./utils"
import type { BackoffOptions } from "./fetch"
import type { queueAsPromised } from "fastq"
import type {
  AppendOptions,
  CloseOptions,
  CloseResult,
  CreateOptions,
  HeadResult,
  HeadersRecord,
  IdempotentProducerOptions,
  MaybePromise,
  ParamsRecord,
  StreamErrorHandler,
  StreamHandleOptions,
  StreamOptions,
  StreamResponse,
} from "./types"

/**
 * Queued message for batching.
 */
interface QueuedMessage {
  data: Uint8Array | string
  seq?: string
  contentType?: string
  signal?: AbortSignal
  resolve: () => void
  reject: (error: Error) => void
}

/**
 * Normalize content-type by extracting the media type (before any semicolon).
 * Handles cases like "application/json; charset=utf-8".
 */
function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return ``
  return contentType.split(`;`)[0]!.trim().toLowerCase()
}

/**
 * Check if a value is a Promise or Promise-like (thenable).
 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null && typeof (value as PromiseLike<unknown>).then === `function`
  )
}

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

  /**
   * Enable automatic batching for append() calls.
   * When true, multiple append() calls made while a POST is in-flight
   * will be batched together into a single request.
   *
   * @default true
   */
  batching?: boolean
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
 * await stream.append(JSON.stringify({ message: "hello" }));
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

  // Batching infrastructure
  #batchingEnabled: boolean
  #queue?: queueAsPromised<Array<QueuedMessage>>
  #buffer: Array<QueuedMessage> = []

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

    // Set contentType from options if provided (for IdempotentProducer and other use cases)
    if (opts.contentType) {
      this.contentType = opts.contentType
    }

    // Batching is enabled by default
    this.#batchingEnabled = opts.batching !== false

    if (this.#batchingEnabled) {
      this.#queue = fastq.promise(this.#batchWorker.bind(this), 1)
    }

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
      closed: opts.closed,
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
    const streamClosed =
      response.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`

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
      streamClosed,
    }
  }

  /**
   * Create this stream (create-only PUT) using the URL/auth from the handle.
   */
  async create(opts?: Omit<CreateOptions, keyof StreamOptions>): Promise<this> {
    const { requestHeaders, fetchUrl } = await this.#buildRequest()

    const contentType = opts?.contentType ?? this.#options.contentType
    if (contentType) {
      requestHeaders[`content-type`] = contentType
    }
    if (opts?.ttlSeconds !== undefined) {
      requestHeaders[STREAM_TTL_HEADER] = String(opts.ttlSeconds)
    }
    if (opts?.expiresAt) {
      requestHeaders[STREAM_EXPIRES_AT_HEADER] = opts.expiresAt
    }
    if (opts?.closed) {
      requestHeaders[STREAM_CLOSED_HEADER] = `true`
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
    } else if (contentType) {
      this.contentType = contentType
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
   * Close the stream, optionally with a final message.
   *
   * After closing:
   * - No further appends are permitted (server returns 409)
   * - Readers can observe the closed state and treat it as EOF
   * - The stream's data remains fully readable
   *
   * Closing is:
   * - **Durable**: The closed state is persisted
   * - **Monotonic**: Once closed, a stream cannot be reopened
   *
   * **Idempotency:**
   * - `close()` without body: Idempotent — safe to call multiple times
   * - `close({ body })` with body: NOT idempotent — throws `StreamClosedError`
   *   if stream is already closed (use `IdempotentProducer.close()` for
   *   idempotent close-with-body semantics)
   *
   * @returns CloseResult with the final offset
   * @throws StreamClosedError if called with body on an already-closed stream
   */
  async close(opts?: CloseOptions): Promise<CloseResult> {
    const { requestHeaders, fetchUrl } = await this.#buildRequest()

    const contentType =
      opts?.contentType ?? this.#options.contentType ?? this.contentType
    if (contentType) {
      requestHeaders[`content-type`] = contentType
    }

    // Always send Stream-Closed: true header for close operation
    requestHeaders[STREAM_CLOSED_HEADER] = `true`

    // For JSON mode with body, wrap in array
    let body: BodyInit | undefined
    if (opts?.body !== undefined) {
      const isJson = normalizeContentType(contentType) === `application/json`
      if (isJson) {
        const bodyStr =
          typeof opts.body === `string`
            ? opts.body
            : new TextDecoder().decode(opts.body)
        body = `[${bodyStr}]`
      } else {
        body =
          typeof opts.body === `string`
            ? opts.body
            : (opts.body as unknown as BodyInit)
      }
    }

    const response = await this.#fetchClient(fetchUrl.toString(), {
      method: `POST`,
      headers: requestHeaders,
      body,
      signal: opts?.signal ?? this.#options.signal,
    })

    // Check for 409 Conflict with Stream-Closed header
    if (response.status === 409) {
      const isClosed =
        response.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`
      if (isClosed) {
        const finalOffset =
          response.headers.get(STREAM_OFFSET_HEADER) ?? undefined
        throw new StreamClosedError(this.url, finalOffset)
      }
    }

    if (!response.ok) {
      await handleErrorResponse(response, this.url)
    }

    const finalOffset = response.headers.get(STREAM_OFFSET_HEADER) ?? ``

    return { finalOffset }
  }

  /**
   * Append a single payload to the stream.
   *
   * When batching is enabled (default), multiple append() calls made while
   * a POST is in-flight will be batched together into a single request.
   * This significantly improves throughput for high-frequency writes.
   *
   * - `body` must be string or Uint8Array.
   * - For JSON streams, pass pre-serialized JSON strings.
   * - `body` may also be a Promise that resolves to string or Uint8Array.
   * - Strings are encoded as UTF-8.
   * - `seq` (if provided) is sent as stream-seq (writer coordination).
   *
   * @example
   * ```typescript
   * // JSON stream - pass pre-serialized JSON
   * await stream.append(JSON.stringify({ message: "hello" }));
   *
   * // Byte stream
   * await stream.append("raw text data");
   * await stream.append(new Uint8Array([1, 2, 3]));
   *
   * // Promise value - awaited before buffering
   * await stream.append(fetchData());
   * ```
   */
  async append(
    body: Uint8Array | string | Promise<Uint8Array | string>,
    opts?: AppendOptions
  ): Promise<void> {
    // Await promises before buffering
    const resolvedBody = isPromiseLike(body) ? await body : body

    if (this.#batchingEnabled && this.#queue) {
      return this.#appendWithBatching(resolvedBody, opts)
    }
    return this.#appendDirect(resolvedBody, opts)
  }

  /**
   * Direct append without batching (used when batching is disabled).
   */
  async #appendDirect(
    body: Uint8Array | string,
    opts?: AppendOptions
  ): Promise<void> {
    const { requestHeaders, fetchUrl } = await this.#buildRequest()

    const contentType =
      opts?.contentType ?? this.#options.contentType ?? this.contentType
    if (contentType) {
      requestHeaders[`content-type`] = contentType
    }

    if (opts?.seq) {
      requestHeaders[STREAM_SEQ_HEADER] = opts.seq
    }

    // For JSON mode, wrap body in array to match protocol (server flattens one level)
    // Input is pre-serialized JSON string
    const isJson = normalizeContentType(contentType) === `application/json`
    let encodedBody: BodyInit
    if (isJson) {
      // JSON mode: decode as UTF-8 string and wrap in array
      const bodyStr =
        typeof body === `string` ? body : new TextDecoder().decode(body)
      encodedBody = `[${bodyStr}]`
    } else {
      // Binary mode: preserve raw bytes
      // Use ArrayBuffer for cross-platform BodyInit compatibility
      if (typeof body === `string`) {
        encodedBody = body
      } else {
        encodedBody = body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength
        ) as ArrayBuffer
      }
    }

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
   * Append with batching - buffers messages and sends them in batches.
   */
  async #appendWithBatching(
    body: Uint8Array | string,
    opts?: AppendOptions
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#buffer.push({
        data: body,
        seq: opts?.seq,
        contentType: opts?.contentType,
        signal: opts?.signal,
        resolve,
        reject,
      })

      // If no POST in flight, send immediately
      if (this.#queue!.idle()) {
        const batch = this.#buffer.splice(0)
        this.#queue!.push(batch).catch((err) => {
          for (const msg of batch) msg.reject(err)
        })
      }
    })
  }

  /**
   * Batch worker - processes batches of messages.
   */
  async #batchWorker(batch: Array<QueuedMessage>): Promise<void> {
    try {
      await this.#sendBatch(batch)

      // Resolve all messages in the batch
      for (const msg of batch) {
        msg.resolve()
      }

      // Send accumulated batch if any
      if (this.#buffer.length > 0) {
        const nextBatch = this.#buffer.splice(0)
        this.#queue!.push(nextBatch).catch((err) => {
          for (const msg of nextBatch) msg.reject(err)
        })
      }
    } catch (error) {
      // Reject current batch
      for (const msg of batch) {
        msg.reject(error as Error)
      }
      // Also reject buffered messages (don't leave promises hanging)
      for (const msg of this.#buffer) {
        msg.reject(error as Error)
      }
      this.#buffer = []
      throw error
    }
  }

  /**
   * Send a batch of messages as a single POST request.
   */
  async #sendBatch(batch: Array<QueuedMessage>): Promise<void> {
    if (batch.length === 0) return

    const { requestHeaders, fetchUrl } = await this.#buildRequest()

    // Get content type - prefer from options, then from messages, then from stream
    const contentType =
      batch[0]?.contentType ?? this.#options.contentType ?? this.contentType

    if (contentType) {
      requestHeaders[`content-type`] = contentType
    }

    // Get last non-undefined seq (queue preserves append order)
    let highestSeq: string | undefined
    for (let i = batch.length - 1; i >= 0; i--) {
      if (batch[i]!.seq !== undefined) {
        highestSeq = batch[i]!.seq
        break
      }
    }

    if (highestSeq) {
      requestHeaders[STREAM_SEQ_HEADER] = highestSeq
    }

    const isJson = normalizeContentType(contentType) === `application/json`

    // Batch data based on content type
    let batchedBody: BodyInit
    if (isJson) {
      // For JSON mode: always send as array (server flattens one level)
      // Single append: [value] → server stores value
      // Multiple appends: [val1, val2] → server stores val1, val2
      // Input is pre-serialized JSON strings, join them into an array
      const jsonStrings = batch.map((m) =>
        typeof m.data === `string` ? m.data : new TextDecoder().decode(m.data)
      )
      batchedBody = `[${jsonStrings.join(`,`)}]`
    } else {
      // For byte mode: preserve original data types
      // - Strings are concatenated as strings (for text/* content types)
      // - Uint8Arrays are concatenated as binary (for application/octet-stream)
      // - Mixed types: convert all to binary to avoid data corruption
      const hasUint8Array = batch.some((m) => m.data instanceof Uint8Array)
      const hasString = batch.some((m) => typeof m.data === `string`)

      if (hasUint8Array && !hasString) {
        // All binary: concatenate Uint8Arrays
        const chunks = batch.map((m) => m.data as Uint8Array)
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
        const combined = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          combined.set(chunk, offset)
          offset += chunk.length
        }
        batchedBody = combined
      } else if (hasString && !hasUint8Array) {
        // All strings: concatenate as string
        batchedBody = batch.map((m) => m.data as string).join(``)
      } else {
        // Mixed types: convert strings to binary and concatenate
        // This preserves binary data integrity
        const encoder = new TextEncoder()
        const chunks = batch.map((m) =>
          typeof m.data === `string` ? encoder.encode(m.data) : m.data
        )
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
        const combined = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          combined.set(chunk, offset)
          offset += chunk.length
        }
        batchedBody = combined
      }
    }

    // Combine signals: stream-level signal + any per-message signals
    const signals: Array<AbortSignal> = []
    if (this.#options.signal) {
      signals.push(this.#options.signal)
    }
    for (const msg of batch) {
      if (msg.signal) {
        signals.push(msg.signal)
      }
    }
    const combinedSignal =
      signals.length > 0 ? AbortSignal.any(signals) : undefined

    const response = await this.#fetchClient(fetchUrl.toString(), {
      method: `POST`,
      headers: requestHeaders,
      body: batchedBody,
      signal: combinedSignal,
    })

    if (!response.ok) {
      await handleErrorResponse(response, this.url)
    }
  }

  /**
   * Append a streaming body to the stream.
   *
   * Supports piping from any ReadableStream or async iterable:
   * - `source` yields Uint8Array or string chunks.
   * - Strings are encoded as UTF-8; no delimiters are added.
   * - Internally uses chunked transfer or HTTP/2 streaming.
   *
   * @example
   * ```typescript
   * // Pipe from a ReadableStream
   * const readable = new ReadableStream({
   *   start(controller) {
   *     controller.enqueue("chunk 1");
   *     controller.enqueue("chunk 2");
   *     controller.close();
   *   }
   * });
   * await stream.appendStream(readable);
   *
   * // Pipe from an async generator
   * async function* generate() {
   *   yield "line 1\n";
   *   yield "line 2\n";
   * }
   * await stream.appendStream(generate());
   *
   * // Pipe from fetch response body
   * const response = await fetch("https://example.com/data");
   * await stream.appendStream(response.body!);
   * ```
   */
  async appendStream(
    source:
      | ReadableStream<Uint8Array | string>
      | AsyncIterable<Uint8Array | string>,
    opts?: AppendOptions
  ): Promise<void> {
    const { requestHeaders, fetchUrl } = await this.#buildRequest()

    const contentType =
      opts?.contentType ?? this.#options.contentType ?? this.contentType
    if (contentType) {
      requestHeaders[`content-type`] = contentType
    }

    if (opts?.seq) {
      requestHeaders[STREAM_SEQ_HEADER] = opts.seq
    }

    // Convert to ReadableStream<Uint8Array> for the body
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

  /**
   * Create a writable stream that pipes data to this durable stream.
   *
   * Returns a WritableStream that can be used with `pipeTo()` or
   * `pipeThrough()` from any ReadableStream source.
   *
   * Uses IdempotentProducer internally for:
   * - Automatic batching (controlled by lingerMs, maxBatchBytes)
   * - Exactly-once delivery semantics
   * - Streaming writes (doesn't buffer entire content in memory)
   *
   * @example
   * ```typescript
   * // Pipe from fetch response
   * const response = await fetch("https://example.com/data");
   * await response.body!.pipeTo(stream.writable());
   *
   * // Pipe through a transform
   * const readable = someStream.pipeThrough(new TextEncoderStream());
   * await readable.pipeTo(stream.writable());
   *
   * // With custom producer options
   * await source.pipeTo(stream.writable({
   *   producerId: "my-producer",
   *   lingerMs: 10,
   *   maxBatchBytes: 64 * 1024,
   * }));
   * ```
   */
  writable(
    opts?: Pick<
      IdempotentProducerOptions,
      `lingerMs` | `maxBatchBytes` | `onError`
    > & {
      producerId?: string
      signal?: AbortSignal
    }
  ): WritableStream<Uint8Array | string> {
    // Generate a random producer ID if not provided
    const producerId =
      opts?.producerId ?? `writable-${crypto.randomUUID().slice(0, 8)}`

    // Track async errors to surface in close() so pipeTo() rejects on failure
    let writeError: Error | null = null

    const producer = new IdempotentProducer(this, producerId, {
      autoClaim: true, // Ephemeral producer, auto-claim epoch
      lingerMs: opts?.lingerMs,
      maxBatchBytes: opts?.maxBatchBytes,
      onError: (error) => {
        if (!writeError) writeError = error // Capture first error
        opts?.onError?.(error) // Still call user's handler
      },
      signal: opts?.signal ?? this.#options.signal,
    })

    return new WritableStream<Uint8Array | string>({
      write(chunk) {
        producer.append(chunk)
      },
      async close() {
        // close() flushes pending and closes the stream (EOF)
        await producer.close()
        if (writeError) throw writeError // Causes pipeTo() to reject
      },
      abort(_reason) {
        // detach() stops the producer without closing the stream
        producer.detach().catch((err) => {
          opts?.onError?.(err) // Report instead of swallowing
        })
      },
    })
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
      fetch: this.#options.fetch,
      backoffOptions: this.#options.backoffOptions,
      offset: options?.offset,
      live: options?.live,
      json: options?.json,
      onError: options?.onError ?? this.#onError,
      warnOnHttp: options?.warnOnHttp ?? this.#options.warnOnHttp,
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
 * Objects are JSON-serialized.
 */
function encodeBody(
  body: BodyInit | Uint8Array | string | unknown | undefined
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
  // Check for BodyInit types (Blob, FormData, ReadableStream, ArrayBuffer, etc.)
  if (
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof ReadableStream ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  ) {
    return body as BodyInit
  }
  // For other types (objects, arrays, numbers, etc.), JSON-serialize
  return new TextEncoder().encode(JSON.stringify(body))
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
  warnIfUsingHttpInBrowser(options.url, options.warnOnHttp)
}
