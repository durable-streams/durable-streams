/**
 * Writer for Durable Streams with intelligent batching.
 *
 * Extends @durable-streams/client (read-only) with write operations.
 */

import {
  DurableStream as BaseStream,
  STREAM_EXPIRES_AT_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_TTL_HEADER,
} from "@durable-streams/client"
import fastq from "fastq"
import type { queueAsPromised } from "fastq"

/**
 * Options for creating a stream.
 */
export interface CreateOptions {
  url: string
  contentType?: string
  ttlSeconds?: number
  expiresAt?: string
  body?: BodyInit | Uint8Array | string
  auth?: { token: string } | { getToken: () => Promise<string> | string }
  params?: Record<string, string>
  headers?: Record<string, string>
  signal?: AbortSignal
  maxQueueSize?: number
}

/**
 * Options for appending to a stream.
 */
export interface AppendOptions {
  seq?: string
  contentType?: string
  signal?: AbortSignal
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
  private maxQueueSize: number

  constructor(opts: CreateOptions) {
    super(opts)
    this.maxQueueSize = opts.maxQueueSize ?? 1000
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

    const body = opts.body
      ? typeof opts.body === `string`
        ? new TextEncoder().encode(opts.body)
        : opts.body
      : undefined

    const response = await stream.fetch({
      method: `PUT`,
      headers,
      body,
    })

    if (!response.ok) {
      if (response.status === 409) {
        throw new Error(`Stream already exists: ${opts.url}`)
      }
      throw new Error(`Failed to create stream: ${response.statusText}`)
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
    const stream = new DurableStream({ ...opts, maxQueueSize: 0 })
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
      throw new Error(`Failed to delete stream: ${response.statusText}`)
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
    // Backpressure
    while (this.buffer.length + this.queue.length() >= this.maxQueueSize) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

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
      // Reject all
      for (const msg of batch) {
        msg.reject(error as Error)
      }
      throw error
    }
  }

  private async sendBatch(batch: Array<QueuedMessage>): Promise<void> {
    if (batch.length === 0) return

    // Highest seq
    const highestSeq = batch
      .map((m) => m.seq)
      .filter((s): s is string => s !== undefined)
      .sort()
      .pop()

    const isJson = this.contentType?.toLowerCase() === `application/json`

    // Batch data
    let batchedBody: BodyInit
    if (isJson) {
      const values = batch.map((m) => m.data)
      batchedBody = JSON.stringify(values)
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
      if (response.status === 404) {
        throw new Error(`Stream not found: ${this.url}`)
      }
      if (response.status === 409) {
        throw new Error(`Sequence conflict`)
      }
      if (response.status === 400) {
        throw new Error(`Bad request (possibly content-type mismatch)`)
      }
      throw new Error(`Failed to append: ${response.statusText}`)
    }
  }

  /**
   * Helper to make authenticated requests.
   */
  private async fetch(opts: {
    method: string
    headers?: Record<string, string>
    body?: BodyInit
  }): Promise<Response> {
    const headers: Record<string, string> = {
      ...opts.headers,
    }

    // Handle auth if present
    const auth = (this as any).options?.auth
    if (auth) {
      if (`token` in auth) {
        headers[`authorization`] = `Bearer ${auth.token}`
      } else if (`getToken` in auth) {
        const token = await auth.getToken()
        headers[`authorization`] = `Bearer ${token}`
      }
    }

    return fetch(this.url, {
      method: opts.method,
      headers,
      body: opts.body,
    })
  }
}
