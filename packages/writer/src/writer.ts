/**
 * Writer for Durable Streams with intelligent batching.
 *
 * Extends @durable-streams/client (read-only) with write operations.
 */

import {
  DurableStream as BaseStream,
  FetchError,
  STREAM_EXPIRES_AT_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_TTL_HEADER,
} from "@durable-streams/client"
import fastq from "fastq"
import type { Auth, HeadersRecord, ParamsRecord } from "@durable-streams/client"
import type { queueAsPromised } from "fastq"

/**
 * Normalize content-type by extracting the media type (before any semicolon).
 * Handles cases like "application/json; charset=utf-8".
 */
function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return ``
  return contentType.split(`;`)[0]!.trim().toLowerCase()
}

/**
 * Options for creating a stream.
 */
export interface CreateOptions {
  url: string
  contentType?: string
  ttlSeconds?: number
  expiresAt?: string
  body?: BodyInit | Uint8Array | string
  auth?: Auth
  params?: ParamsRecord
  headers?: HeadersRecord
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
}

/**
 * Options for appending to a stream.
 */
export interface AppendOptions {
  seq?: string
  contentType?: string
}

interface QueuedMessage {
  data: unknown
  seq?: string
  resolve: () => void
  reject: (error: Error) => void
}

/**
 * DurableStream - Full read/write client with batching.
 *
 * Includes read operations from @durable-streams/client plus:
 * - create() - Create a new stream
 * - append() - Append data with automatic batching
 * - delete() - Delete a stream
 *
 * @example
 * ```typescript
 * import { DurableStream } from "@durable-streams/writer"
 *
 * const stream = await DurableStream.create({
 *   url: "https://streams.example.com/my-stream",
 *   contentType: "application/json",
 * })
 *
 * // Batching happens automatically
 * await stream.append({ event: "msg1" }, { seq: "100" })
 * await stream.append({ event: "msg2" }, { seq: "101" })
 * ```
 */
export class DurableStream extends BaseStream {
  private queue: queueAsPromised<Array<QueuedMessage>>
  private buffer: Array<QueuedMessage> = []
  private options: CreateOptions

  constructor(opts: CreateOptions) {
    super(opts)
    this.options = opts
    this.queue = fastq.promise(this.worker.bind(this), 1)
  }

  /**
   * Create a new stream and return a handle.
   */
  static async create(opts: CreateOptions): Promise<DurableStream> {
    const stream = new DurableStream(opts)

    const headers: Record<string, string> = {}
    if (opts.contentType) {
      headers[`content-type`] = opts.contentType
    }
    if (opts.ttlSeconds !== undefined) {
      headers[STREAM_TTL_HEADER] = String(opts.ttlSeconds)
    }
    if (opts.expiresAt) {
      headers[STREAM_EXPIRES_AT_HEADER] = opts.expiresAt
    }

    const body: BodyInit | undefined = opts.body
      ? typeof opts.body === `string`
        ? new TextEncoder().encode(opts.body)
        : (opts.body as BodyInit)
      : undefined

    const response = await stream.fetch({
      method: `PUT`,
      headers,
      body,
    })

    if (!response.ok) {
      const text = await response.text()
      const headers: Record<string, string> = {}
      response.headers.forEach((v, k) => {
        headers[k] = v
      })
      throw new FetchError(
        response.status,
        text,
        undefined,
        headers,
        opts.url,
        response.status === 409
          ? `Stream already exists`
          : `Failed to create stream`
      )
    }

    // Update content type from response
    const responseContentType = response.headers.get(`content-type`)
    if (responseContentType) {
      stream.contentType = responseContentType
    } else if (opts.contentType) {
      stream.contentType = opts.contentType
    }

    return stream
  }

  /**
   * Delete a stream.
   */
  static async delete(opts: { url: string }): Promise<void> {
    const stream = new DurableStream(opts)
    await stream.delete()
  }

  /**
   * Delete this stream.
   */
  async delete(): Promise<void> {
    const response = await this.fetch({
      method: `DELETE`,
    })

    if (!response.ok && response.status !== 404) {
      const text = await response.text()
      const headers: Record<string, string> = {}
      response.headers.forEach((v, k) => {
        headers[k] = v
      })
      throw new FetchError(
        response.status,
        text,
        undefined,
        headers,
        this.url,
        `Failed to delete stream`
      )
    }
  }

  /**
   * Append data with automatic batching.
   *
   * For JSON mode: Pass any JavaScript value.
   * For byte mode: Pass Uint8Array or string.
   *
   * Batches messages while POST is in-flight.
   */
  async append(body: unknown, opts?: AppendOptions): Promise<void> {
    // Add to buffer
    return new Promise<void>((resolve, reject) => {
      this.buffer.push({
        data: body,
        seq: opts?.seq,
        resolve,
        reject,
      })

      // If no POST in flight, send immediately
      if (this.queue.idle()) {
        const batch = this.buffer.splice(0)
        this.queue.push(batch).catch((err) => {
          for (const msg of batch) msg.reject(err)
        })
      }
    })
  }

  /**
   * Worker processes batches.
   */
  private async worker(batch: Array<QueuedMessage>): Promise<void> {
    try {
      await this.sendBatch(batch)

      // Resolve all
      for (const msg of batch) {
        msg.resolve()
      }

      // Send accumulated batch if any
      if (this.buffer.length > 0) {
        const nextBatch = this.buffer.splice(0)
        this.queue.push(nextBatch).catch((err) => {
          for (const msg of nextBatch) msg.reject(err)
        })
      }
    } catch (error) {
      // Reject current batch
      for (const msg of batch) {
        msg.reject(error as Error)
      }
      // Also reject buffered messages (don't leave promises hanging)
      for (const msg of this.buffer) {
        msg.reject(error as Error)
      }
      this.buffer = []
      throw error
    }
  }

  private async sendBatch(batch: Array<QueuedMessage>): Promise<void> {
    if (batch.length === 0) return

    // Get last non-undefined seq (queue preserves append order)
    let highestSeq: string | undefined
    for (let i = batch.length - 1; i >= 0; i--) {
      if (batch[i]!.seq !== undefined) {
        highestSeq = batch[i]!.seq
        break
      }
    }

    const isJson = normalizeContentType(this.contentType) === `application/json`

    // Batch data
    let batchedBody: BodyInit
    if (isJson) {
      // For JSON mode: flatten arrays (arrays are semantic batches)
      // If msg.data is an array, spread its elements; otherwise push the value
      const values: Array<unknown> = []
      for (const msg of batch) {
        if (Array.isArray(msg.data)) {
          values.push(...msg.data)
        } else {
          values.push(msg.data)
        }
      }
      batchedBody = JSON.stringify(
        batch.length === 1 && !Array.isArray(batch[0]!.data)
          ? values[0]
          : values
      )
    } else {
      const totalSize = batch.reduce((sum, m) => {
        const size =
          typeof m.data === `string`
            ? new TextEncoder().encode(m.data).length
            : (m.data as Uint8Array).length
        return sum + size
      }, 0)

      const concatenated = new Uint8Array(totalSize)
      let offset = 0
      for (const msg of batch) {
        const bytes =
          typeof msg.data === `string`
            ? new TextEncoder().encode(msg.data)
            : (msg.data as Uint8Array)
        concatenated.set(bytes, offset)
        offset += bytes.length
      }
      batchedBody = concatenated
    }

    // Send
    const headers: Record<string, string> = {}
    if (this.contentType) {
      headers[`content-type`] = this.contentType
    }
    if (highestSeq) {
      headers[STREAM_SEQ_HEADER] = highestSeq
    }

    const response = await this.fetch({
      method: `POST`,
      headers,
      body: batchedBody,
    })

    if (!response.ok) {
      const text = await response.text()
      const headers: Record<string, string> = {}
      response.headers.forEach((v, k) => {
        headers[k] = v
      })

      let message: string
      if (response.status === 404) {
        message = `Stream not found`
      } else if (response.status === 409) {
        message = `Sequence conflict`
      } else if (response.status === 400) {
        message = `Bad request (possibly content-type mismatch)`
      } else {
        message = `Failed to append`
      }

      throw new FetchError(
        response.status,
        text,
        undefined,
        headers,
        this.url,
        message
      )
    }
  }

  /**
   * Helper to make authenticated requests with proper params, headers, and signal support.
   */
  private async fetch(opts: {
    method: string
    headers?: Record<string, string>
    body?: BodyInit
    signal?: AbortSignal
  }): Promise<Response> {
    // Build URL with params
    const fetchUrl = new URL(this.url)
    if (this.options.params) {
      for (const [key, value] of Object.entries(this.options.params)) {
        if (value !== undefined) {
          const resolvedValue =
            typeof value === `function` ? await value() : value
          fetchUrl.searchParams.set(key, resolvedValue)
        }
      }
    }

    // Build headers
    const headers: Record<string, string> = {}

    // Handle auth
    if (this.options.auth) {
      if (`token` in this.options.auth) {
        const headerName = this.options.auth.headerName ?? `authorization`
        headers[headerName] = `Bearer ${this.options.auth.token}`
      } else if (`headers` in this.options.auth) {
        Object.assign(headers, this.options.auth.headers)
      } else if (`getHeaders` in this.options.auth) {
        const authHeaders = await this.options.auth.getHeaders()
        Object.assign(headers, authHeaders)
      }
    }

    // Merge constructor headers
    if (this.options.headers) {
      for (const [key, value] of Object.entries(this.options.headers)) {
        headers[key] = typeof value === `function` ? await value() : value
      }
    }

    // Merge request-specific headers (these override constructor headers)
    if (opts.headers) {
      Object.assign(headers, opts.headers)
    }

    // Use custom fetch if provided, otherwise use global
    const fetchImpl = this.options.fetch ?? fetch

    return fetchImpl(fetchUrl.toString(), {
      method: opts.method,
      headers,
      body: opts.body,
      signal: opts.signal ?? this.options.signal,
    })
  }
}
