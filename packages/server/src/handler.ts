/**
 * Runtime-agnostic HTTP handler for durable streams.
 * Uses Web Standard APIs (Request/Response/ReadableStream) so it works
 * on Node.js, Cloudflare Workers, Deno, Bun, and other runtimes.
 *
 * No `node:*` imports allowed in this file.
 */

import {
  CURSOR_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  OFFSET_QUERY_PARAM,
  PRODUCER_EPOCH_HEADER,
  PRODUCER_EXPECTED_SEQ_HEADER,
  PRODUCER_ID_HEADER,
  PRODUCER_RECEIVED_SEQ_HEADER,
  PRODUCER_SEQ_HEADER,
  SSE_CLOSED_FIELD,
  SSE_CURSOR_FIELD,
  SSE_OFFSET_FIELD,
  SSE_UP_TO_DATE_FIELD,
  STREAM_CLOSED_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_EXPIRES_AT_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_SSE_DATA_ENCODING_HEADER,
  STREAM_TTL_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "./constants"
import { generateResponseCursor } from "./cursor"
import {
  ContentTypeMismatchError,
  InvalidJsonError,
  PayloadTooLargeError,
  SequenceConflictError,
  StreamConflictError,
  StreamNotFoundError,
} from "./errors"
import type { CursorOptions } from "./cursor"
import type {
  AppendOptions,
  DurableStreamStore,
  StreamLifecycleEvent,
} from "./types"

function encodeSSEData(payload: string): string {
  const lines = payload.split(/\r\n|\r|\n/)
  return lines.map((line) => `data:${line}`).join(`\n`) + `\n\n`
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ``
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function stringToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  return uint8ArrayToBase64(bytes)
}

export interface InjectedFault {
  status?: number
  count: number
  retryAfter?: number
  delayMs?: number
  dropConnection?: boolean
  truncateBodyBytes?: number
  probability?: number
  method?: string
  corruptBody?: boolean
  jitterMs?: number
  injectSseEvent?: {
    eventType: string
    data: string
  }
}

export interface FetchHandlerOptions {
  store: DurableStreamStore
  longPollTimeout?: number
  baseUrl?: string
  onStreamCreated?: (event: StreamLifecycleEvent) => void | Promise<void>
  onStreamDeleted?: (event: StreamLifecycleEvent) => void | Promise<void>
  cursorOptions?: CursorOptions
}

export class DurableStreamHandler {
  readonly store: DurableStreamStore
  options: {
    longPollTimeout: number
    baseUrl: string
    onStreamCreated?: (event: StreamLifecycleEvent) => void | Promise<void>
    onStreamDeleted?: (event: StreamLifecycleEvent) => void | Promise<void>
    cursorOptions: CursorOptions
  }
  private injectedFaults = new Map<string, InjectedFault>()
  private _isShuttingDown = false

  private get isShuttingDown(): boolean {
    return this._isShuttingDown
  }

  constructor(options: FetchHandlerOptions) {
    this.store = options.store
    this.options = {
      longPollTimeout: options.longPollTimeout ?? 30_000,
      baseUrl: options.baseUrl ?? ``,
      onStreamCreated: options.onStreamCreated,
      onStreamDeleted: options.onStreamDeleted,
      cursorOptions: options.cursorOptions ?? {},
    }
  }

  async shutdown(): Promise<void> {
    this._isShuttingDown = true
    if (`cancelAllWaits` in this.store) {
      await this.store.cancelAllWaits()
    }
  }

  resetShutdown(): void {
    this._isShuttingDown = false
  }

  injectFault(
    path: string,
    fault: Omit<InjectedFault, `count`> & { count?: number }
  ): void {
    this.injectedFaults.set(path, { count: 1, ...fault })
  }

  clearInjectedFaults(): void {
    this.injectedFaults.clear()
  }

  private consumeInjectedFault(
    path: string,
    method: string
  ): InjectedFault | null {
    const fault = this.injectedFaults.get(path)
    if (!fault) return null

    if (fault.method && fault.method.toUpperCase() !== method.toUpperCase()) {
      return null
    }

    if (fault.probability !== undefined && Math.random() > fault.probability) {
      return null
    }

    fault.count--
    if (fault.count <= 0) {
      this.injectedFaults.delete(path)
    }

    return fault
  }

  private async applyFaultDelay(fault: InjectedFault): Promise<void> {
    if (fault.delayMs !== undefined && fault.delayMs > 0) {
      const jitter = fault.jitterMs ? Math.random() * fault.jitterMs : 0
      await new Promise((resolve) =>
        setTimeout(resolve, fault.delayMs! + jitter)
      )
    }
  }

  private applyFaultBodyModification(
    body: Uint8Array,
    fault: InjectedFault | null
  ): Uint8Array {
    if (!fault) return body

    let modified = body

    if (
      fault.truncateBodyBytes !== undefined &&
      modified.length > fault.truncateBodyBytes
    ) {
      modified = modified.slice(0, fault.truncateBodyBytes)
    }

    if (fault.corruptBody && modified.length > 0) {
      modified = new Uint8Array(modified)
      modified[0] = 0x58
      if (modified.length > 1) {
        modified[1] = 0x59
      }
      const numCorrupt = Math.max(1, Math.floor(modified.length * 0.1))
      for (let i = 0; i < numCorrupt; i++) {
        const pos = Math.floor(Math.random() * modified.length)
        modified[pos] = 0x5a
      }
    }

    return modified
  }

  private corsHeaders(): Record<string, string> {
    return {
      "access-control-allow-origin": `*`,
      "access-control-allow-methods": `GET, POST, PUT, DELETE, HEAD, OPTIONS`,
      "access-control-allow-headers": `content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq`,
      "access-control-expose-headers": `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary`,
      "x-content-type-options": `nosniff`,
      "cross-origin-resource-policy": `cross-origin`,
    }
  }

  private response(
    body: BodyInit | null,
    status: number,
    headers: Record<string, string> = {}
  ): Response {
    return new Response(body, {
      status,
      headers: { ...this.corsHeaders(), ...headers },
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method.toUpperCase()

    if (method === `OPTIONS`) {
      return this.response(null, 204)
    }

    if (path === `/_test/inject-error`) {
      return this.handleTestInjectError(method, request)
    }

    const fault = this.consumeInjectedFault(path, method)
    if (fault) {
      await this.applyFaultDelay(fault)

      if (fault.dropConnection) {
        return this.response(null, 502, {
          "content-type": `text/plain`,
          "x-drop-connection": `true`,
        })
      }

      if (fault.status !== undefined) {
        const headers: Record<string, string> = {
          "content-type": `text/plain`,
        }
        if (fault.retryAfter !== undefined) {
          headers[`retry-after`] = fault.retryAfter.toString()
        }
        return this.response(
          `Injected error for testing`,
          fault.status,
          headers
        )
      }
    }

    const activeFault =
      fault &&
      (fault.truncateBodyBytes !== undefined ||
        fault.corruptBody ||
        fault.injectSseEvent)
        ? fault
        : null

    try {
      switch (method) {
        case `PUT`:
          return await this.handleCreate(path, request)
        case `HEAD`:
          return this.handleHead(path)
        case `GET`:
          return await this.handleRead(path, url, request, activeFault)
        case `POST`:
          return await this.handleAppend(path, request)
        case `DELETE`:
          return await this.handleDelete(path)
        default:
          return this.response(`Method not allowed`, 405, {
            "content-type": `text/plain`,
          })
      }
    } catch (err) {
      if (err instanceof StreamNotFoundError) {
        return this.response(`Stream not found`, 404, {
          "content-type": `text/plain`,
        })
      } else if (err instanceof StreamConflictError) {
        return this.response(err.message, 409, {
          "content-type": `text/plain`,
        })
      } else if (err instanceof SequenceConflictError) {
        return this.response(`Sequence conflict`, 409, {
          "content-type": `text/plain`,
        })
      } else if (err instanceof ContentTypeMismatchError) {
        return this.response(`Content-type mismatch`, 409, {
          "content-type": `text/plain`,
        })
      } else if (err instanceof InvalidJsonError) {
        return this.response(err.message, 400, {
          "content-type": `text/plain`,
        })
      } else if (err instanceof PayloadTooLargeError) {
        return this.response(err.message, 413, {
          "content-type": `text/plain`,
        })
      }
      if (err instanceof Error) {
        const msg = err.message.toLowerCase()
        if (msg.includes(`not found`)) {
          return this.response(`Stream not found`, 404, {
            "content-type": `text/plain`,
          })
        } else if (
          msg.includes(`already exists with different configuration`)
        ) {
          return this.response(
            `Stream already exists with different configuration`,
            409,
            { "content-type": `text/plain` }
          )
        } else if (msg.includes(`sequence conflict`)) {
          return this.response(`Sequence conflict`, 409, {
            "content-type": `text/plain`,
          })
        } else if (msg.includes(`content-type mismatch`)) {
          return this.response(`Content-type mismatch`, 409, {
            "content-type": `text/plain`,
          })
        } else if (msg.includes(`invalid json`)) {
          return this.response(`Invalid JSON`, 400, {
            "content-type": `text/plain`,
          })
        } else if (
          msg.includes(`empty arrays are not allowed`) ||
          msg.includes(`empty array`)
        ) {
          return this.response(`Empty arrays are not allowed`, 400, {
            "content-type": `text/plain`,
          })
        } else if (msg.includes(`payload too large`)) {
          return this.response(err.message, 413, {
            "content-type": `text/plain`,
          })
        }
      }
      throw err
    }
  }

  // ============================================================================
  // PUT - create stream
  // ============================================================================

  private async handleCreate(
    path: string,
    request: Request
  ): Promise<Response> {
    let contentType = request.headers.get(`content-type`)

    if (
      !contentType ||
      contentType.trim() === `` ||
      !/^[\w-]+\/[\w-]+/.test(contentType)
    ) {
      contentType = `application/octet-stream`
    }

    const ttlHeader = request.headers.get(STREAM_TTL_HEADER)
    const expiresAtHeader = request.headers.get(STREAM_EXPIRES_AT_HEADER)

    const closedHeader = request.headers.get(STREAM_CLOSED_HEADER)
    const createClosed = closedHeader === `true`

    if (ttlHeader && expiresAtHeader) {
      return this.response(
        `Cannot specify both Stream-TTL and Stream-Expires-At`,
        400,
        { "content-type": `text/plain` }
      )
    }

    let ttlSeconds: number | undefined
    if (ttlHeader) {
      const ttlPattern = /^(0|[1-9]\d*)$/
      if (!ttlPattern.test(ttlHeader)) {
        return this.response(`Invalid Stream-TTL value`, 400, {
          "content-type": `text/plain`,
        })
      }

      ttlSeconds = parseInt(ttlHeader, 10)
      if (isNaN(ttlSeconds) || ttlSeconds < 0) {
        return this.response(`Invalid Stream-TTL value`, 400, {
          "content-type": `text/plain`,
        })
      }
    }

    if (expiresAtHeader) {
      const timestamp = new Date(expiresAtHeader)
      if (isNaN(timestamp.getTime())) {
        return this.response(`Invalid Stream-Expires-At timestamp`, 400, {
          "content-type": `text/plain`,
        })
      }
    }

    const body = new Uint8Array(await request.arrayBuffer())

    const isNew = !(await this.store.has(path))

    await this.store.create(path, {
      contentType,
      ttlSeconds,
      expiresAt: expiresAtHeader ?? undefined,
      initialData: body.length > 0 ? body : undefined,
      closed: createClosed,
    })

    const stream = (await this.store.get(path))!

    if (isNew && this.options.onStreamCreated) {
      await Promise.resolve(
        this.options.onStreamCreated({
          type: `created`,
          path,
          contentType,
          timestamp: Date.now(),
        })
      )
    }

    const headers: Record<string, string> = {
      "content-type": contentType,
      [STREAM_OFFSET_HEADER]: stream.currentOffset,
    }

    if (isNew) {
      headers[`location`] = `${this.options.baseUrl}${path}`
    }

    if (stream.closed) {
      headers[STREAM_CLOSED_HEADER] = `true`
    }

    return this.response(null, isNew ? 201 : 200, headers)
  }

  // ============================================================================
  // HEAD - get metadata
  // ============================================================================

  private async handleHead(path: string): Promise<Response> {
    const stream = await this.store.get(path)
    if (!stream) {
      return this.response(null, 404, { "content-type": `text/plain` })
    }

    const headers: Record<string, string> = {
      [STREAM_OFFSET_HEADER]: stream.currentOffset,
      "cache-control": `no-store`,
    }

    if (stream.contentType) {
      headers[`content-type`] = stream.contentType
    }

    if (stream.closed) {
      headers[STREAM_CLOSED_HEADER] = `true`
    }

    const closedSuffix = stream.closed ? `:c` : ``
    headers[`etag`] =
      `"${stringToBase64(path)}:-1:${stream.currentOffset}${closedSuffix}"`

    return this.response(null, 200, headers)
  }

  // ============================================================================
  // GET - read data
  // ============================================================================

  private async handleRead(
    path: string,
    url: URL,
    request: Request,
    fault: InjectedFault | null
  ): Promise<Response> {
    const stream = await this.store.get(path)
    if (!stream) {
      return this.response(`Stream not found`, 404, {
        "content-type": `text/plain`,
      })
    }

    const offset = url.searchParams.get(OFFSET_QUERY_PARAM) ?? undefined
    const live = url.searchParams.get(LIVE_QUERY_PARAM)
    const cursor = url.searchParams.get(CURSOR_QUERY_PARAM) ?? undefined

    if (offset !== undefined) {
      if (offset === ``) {
        return this.response(`Empty offset parameter`, 400, {
          "content-type": `text/plain`,
        })
      }

      const allOffsets = url.searchParams.getAll(OFFSET_QUERY_PARAM)
      if (allOffsets.length > 1) {
        return this.response(`Multiple offset parameters not allowed`, 400, {
          "content-type": `text/plain`,
        })
      }

      const validOffsetPattern = /^(-1|now|[0-9a-fA-F]+_[0-9a-fA-F]+)$/
      if (!validOffsetPattern.test(offset)) {
        return this.response(`Invalid offset format`, 400, {
          "content-type": `text/plain`,
        })
      }
    }

    if ((live === `long-poll` || live === `sse`) && !offset) {
      return this.response(
        `${live === `sse` ? `SSE` : `Long-poll`} requires offset parameter`,
        400,
        { "content-type": `text/plain` }
      )
    }

    let useBase64 = false
    if (live === `sse`) {
      const ct = stream.contentType?.toLowerCase().split(`;`)[0]?.trim() ?? ``
      const isTextCompatible =
        ct.startsWith(`text/`) || ct === `application/json`
      useBase64 = !isTextCompatible
    }

    if (live === `sse`) {
      const sseOffset = offset === `now` ? stream.currentOffset : offset!
      return this.handleSSE(
        path,
        stream,
        sseOffset,
        cursor,
        useBase64,
        request,
        fault
      )
    }

    const effectiveOffset = offset === `now` ? stream.currentOffset : offset

    if (offset === `now` && live !== `long-poll`) {
      const headers: Record<string, string> = {
        [STREAM_OFFSET_HEADER]: stream.currentOffset,
        [STREAM_UP_TO_DATE_HEADER]: `true`,
        "cache-control": `no-store`,
      }

      if (stream.contentType) {
        headers[`content-type`] = stream.contentType
      }

      if (stream.closed) {
        headers[STREAM_CLOSED_HEADER] = `true`
      }

      const isJsonMode = stream.contentType?.includes(`application/json`)
      const responseBody = isJsonMode ? `[]` : ``

      return this.response(responseBody, 200, headers)
    }

    let { messages, upToDate } = await this.store.read(path, effectiveOffset)

    const clientIsCaughtUp =
      (effectiveOffset && effectiveOffset === stream.currentOffset) ||
      offset === `now`
    if (live === `long-poll` && clientIsCaughtUp && messages.length === 0) {
      if (stream.closed) {
        return this.response(null, 204, {
          [STREAM_OFFSET_HEADER]: stream.currentOffset,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
          [STREAM_CLOSED_HEADER]: `true`,
        })
      }

      const result = await this.store.waitForMessages(
        path,
        effectiveOffset ?? stream.currentOffset,
        this.options.longPollTimeout
      )

      if (result.streamClosed) {
        const responseCursor = generateResponseCursor(
          cursor,
          this.options.cursorOptions
        )
        return this.response(null, 204, {
          [STREAM_OFFSET_HEADER]: effectiveOffset ?? stream.currentOffset,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
          [STREAM_CURSOR_HEADER]: responseCursor,
          [STREAM_CLOSED_HEADER]: `true`,
        })
      }

      if (result.timedOut) {
        const responseCursor = generateResponseCursor(
          cursor,
          this.options.cursorOptions
        )
        const currentStream = await this.store.get(path)
        const timeoutHeaders: Record<string, string> = {
          [STREAM_OFFSET_HEADER]: effectiveOffset ?? stream.currentOffset,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
          [STREAM_CURSOR_HEADER]: responseCursor,
        }
        if (currentStream?.closed) {
          timeoutHeaders[STREAM_CLOSED_HEADER] = `true`
        }
        return this.response(null, 204, timeoutHeaders)
      }

      messages = result.messages
      upToDate = true
    }

    const headers: Record<string, string> = {}

    if (stream.contentType) {
      headers[`content-type`] = stream.contentType
    }

    const lastMessage = messages[messages.length - 1]
    const responseOffset = lastMessage?.offset ?? stream.currentOffset
    headers[STREAM_OFFSET_HEADER] = responseOffset

    if (live === `long-poll`) {
      headers[STREAM_CURSOR_HEADER] = generateResponseCursor(
        cursor,
        this.options.cursorOptions
      )
    }

    if (upToDate) {
      headers[STREAM_UP_TO_DATE_HEADER] = `true`
    }

    const currentStream = await this.store.get(path)
    const clientAtTail = responseOffset === currentStream?.currentOffset
    if (currentStream?.closed && clientAtTail && upToDate) {
      headers[STREAM_CLOSED_HEADER] = `true`
    }

    const startOffset = offset ?? `-1`
    const closedSuffix =
      currentStream?.closed && clientAtTail && upToDate ? `:c` : ``
    const etag = `"${stringToBase64(path)}:${startOffset}:${responseOffset}${closedSuffix}"`
    headers[`etag`] = etag

    const ifNoneMatch = request.headers.get(`if-none-match`)
    if (ifNoneMatch && ifNoneMatch === etag) {
      return this.response(null, 304, { etag })
    }

    let responseData = await this.store.formatResponse(path, messages)

    responseData = this.applyFaultBodyModification(responseData, fault)

    return this.response(responseData, 200, headers)
  }

  // ============================================================================
  // SSE - Server-Sent Events
  // ============================================================================

  private handleSSE(
    path: string,
    stream: Awaited<ReturnType<DurableStreamStore[`get`]>>,
    initialOffset: string,
    cursor: string | undefined,
    useBase64: boolean,
    request: Request,
    fault: InjectedFault | null
  ): Response {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const isJsonStream = stream?.contentType?.includes(`application/json`)

    let isConnected = true
    const abortHandler = (): void => {
      isConnected = false
    }
    request.signal.addEventListener(`abort`, abortHandler)

    const readable = new ReadableStream({
      start: async (controller) => {
        try {
          await this.runSSELoop(
            controller,
            encoder,
            decoder,
            path,
            initialOffset,
            cursor,
            useBase64,
            isJsonStream ?? false,
            fault,
            () => isConnected
          )
        } catch {
          // Connection closed or error
        } finally {
          request.signal.removeEventListener(`abort`, abortHandler)
          try {
            controller.close()
          } catch {
            // Already closed
          }
        }
      },
    })

    const sseHeaders: Record<string, string> = {
      "content-type": `text/event-stream`,
      "cache-control": `no-cache`,
      connection: `keep-alive`,
    }

    if (useBase64) {
      sseHeaders[STREAM_SSE_DATA_ENCODING_HEADER] = `base64`
    }

    return this.response(readable, 200, sseHeaders)
  }

  private async runSSELoop(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    decoder: TextDecoder,
    path: string,
    initialOffset: string,
    cursor: string | undefined,
    useBase64: boolean,
    isJsonStream: boolean,
    fault: InjectedFault | null,
    isConnected: () => boolean
  ): Promise<void> {
    let currentOffset = initialOffset

    if (fault?.injectSseEvent) {
      controller.enqueue(
        encoder.encode(
          `event: ${fault.injectSseEvent.eventType}\n` +
            `data: ${fault.injectSseEvent.data}\n\n`
        )
      )
    }

    while (isConnected() && !this.isShuttingDown) {
      const { messages, upToDate } = await this.store.read(path, currentOffset)

      let sseBatch = ``

      for (const message of messages) {
        let dataPayload: string
        if (useBase64) {
          dataPayload = uint8ArrayToBase64(message.data)
        } else if (isJsonStream) {
          const jsonBytes = await this.store.formatResponse(path, [message])
          dataPayload = decoder.decode(jsonBytes)
        } else {
          dataPayload = decoder.decode(message.data)
        }

        sseBatch += `event: data\n` + encodeSSEData(dataPayload)

        currentOffset = message.offset
      }

      const currentStream = await this.store.get(path)
      const controlOffset =
        messages[messages.length - 1]?.offset ?? currentStream!.currentOffset

      const streamIsClosed = currentStream?.closed ?? false
      const clientAtTail = controlOffset === currentStream!.currentOffset

      const responseCursor = generateResponseCursor(
        cursor,
        this.options.cursorOptions
      )
      const controlData: Record<string, string | boolean> = {
        [SSE_OFFSET_FIELD]: controlOffset,
      }

      if (streamIsClosed && clientAtTail) {
        controlData[SSE_CLOSED_FIELD] = true
      } else {
        controlData[SSE_CURSOR_FIELD] = responseCursor
        if (upToDate) {
          controlData[SSE_UP_TO_DATE_FIELD] = true
        }
      }

      sseBatch +=
        `event: control\n` + encodeSSEData(JSON.stringify(controlData))

      controller.enqueue(encoder.encode(sseBatch))

      if (streamIsClosed && clientAtTail) {
        break
      }

      currentOffset = controlOffset

      if (upToDate) {
        if (currentStream?.closed) {
          const finalControlData: Record<string, string | boolean> = {
            [SSE_OFFSET_FIELD]: currentOffset,
            [SSE_CLOSED_FIELD]: true,
          }
          controller.enqueue(
            encoder.encode(
              `event: control\n` +
                encodeSSEData(JSON.stringify(finalControlData))
            )
          )
          break
        }

        const result = await this.store.waitForMessages(
          path,
          currentOffset,
          this.options.longPollTimeout
        )

        if (!isConnected()) break

        if (result.streamClosed) {
          const finalControlData: Record<string, string | boolean> = {
            [SSE_OFFSET_FIELD]: currentOffset,
            [SSE_CLOSED_FIELD]: true,
          }
          controller.enqueue(
            encoder.encode(
              `event: control\n` +
                encodeSSEData(JSON.stringify(finalControlData))
            )
          )
          break
        }

        if (result.timedOut) {
          const keepAliveCursor = generateResponseCursor(
            cursor,
            this.options.cursorOptions
          )

          const streamAfterWait = await this.store.get(path)
          if (streamAfterWait?.closed) {
            const closedControlData: Record<string, string | boolean> = {
              [SSE_OFFSET_FIELD]: currentOffset,
              [SSE_CLOSED_FIELD]: true,
            }
            controller.enqueue(
              encoder.encode(
                `event: control\n` +
                  encodeSSEData(JSON.stringify(closedControlData))
              )
            )
            break
          }

          const keepAliveData: Record<string, string | boolean> = {
            [SSE_OFFSET_FIELD]: currentOffset,
            [SSE_CURSOR_FIELD]: keepAliveCursor,
            [SSE_UP_TO_DATE_FIELD]: true,
          }
          controller.enqueue(
            encoder.encode(
              `event: control\n` + encodeSSEData(JSON.stringify(keepAliveData))
            )
          )
        }
      }
    }
  }

  // ============================================================================
  // POST - append data
  // ============================================================================

  private async handleAppend(
    path: string,
    request: Request
  ): Promise<Response> {
    const contentType = request.headers.get(`content-type`)
    const seq = request.headers.get(STREAM_SEQ_HEADER) ?? undefined

    const closedHeader = request.headers.get(STREAM_CLOSED_HEADER)
    const closeStream = closedHeader === `true`

    const producerId = request.headers.get(PRODUCER_ID_HEADER) ?? undefined
    const producerEpochStr =
      request.headers.get(PRODUCER_EPOCH_HEADER) ?? undefined
    const producerSeqStr = request.headers.get(PRODUCER_SEQ_HEADER) ?? undefined

    const hasProducerHeaders =
      producerId !== undefined ||
      producerEpochStr !== undefined ||
      producerSeqStr !== undefined
    const hasAllProducerHeaders =
      producerId !== undefined &&
      producerEpochStr !== undefined &&
      producerSeqStr !== undefined

    const body = new Uint8Array(await request.arrayBuffer())

    if (hasProducerHeaders && !hasAllProducerHeaders) {
      return this.response(
        `All producer headers (Producer-Id, Producer-Epoch, Producer-Seq) must be provided together`,
        400,
        { "content-type": `text/plain` }
      )
    }

    if (hasAllProducerHeaders && producerId === ``) {
      return this.response(`Invalid Producer-Id: must not be empty`, 400, {
        "content-type": `text/plain`,
      })
    }

    const STRICT_INTEGER_REGEX = /^\d+$/
    let producerEpoch: number | undefined
    let producerSeq: number | undefined
    if (hasAllProducerHeaders) {
      if (!STRICT_INTEGER_REGEX.test(producerEpochStr)) {
        return this.response(
          `Invalid Producer-Epoch: must be a non-negative integer`,
          400,
          { "content-type": `text/plain` }
        )
      }
      producerEpoch = Number(producerEpochStr)
      if (!Number.isSafeInteger(producerEpoch)) {
        return this.response(
          `Invalid Producer-Epoch: must be a non-negative integer`,
          400,
          { "content-type": `text/plain` }
        )
      }

      if (!STRICT_INTEGER_REGEX.test(producerSeqStr)) {
        return this.response(
          `Invalid Producer-Seq: must be a non-negative integer`,
          400,
          { "content-type": `text/plain` }
        )
      }
      producerSeq = Number(producerSeqStr)
      if (!Number.isSafeInteger(producerSeq)) {
        return this.response(
          `Invalid Producer-Seq: must be a non-negative integer`,
          400,
          { "content-type": `text/plain` }
        )
      }
    }

    if (body.length === 0 && closeStream) {
      if (hasAllProducerHeaders) {
        const closeResult = await this.store.closeStreamWithProducer(path, {
          producerId: producerId,
          producerEpoch: producerEpoch!,
          producerSeq: producerSeq!,
        })

        if (!closeResult) {
          return this.response(`Stream not found`, 404, {
            "content-type": `text/plain`,
          })
        }

        if (closeResult.producerResult?.status === `duplicate`) {
          return this.response(null, 204, {
            [STREAM_OFFSET_HEADER]: closeResult.finalOffset,
            [STREAM_CLOSED_HEADER]: `true`,
            [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
            [PRODUCER_SEQ_HEADER]:
              closeResult.producerResult.lastSeq.toString(),
          })
        }

        if (closeResult.producerResult?.status === `stale_epoch`) {
          return this.response(`Stale producer epoch`, 403, {
            "content-type": `text/plain`,
            [PRODUCER_EPOCH_HEADER]:
              closeResult.producerResult.currentEpoch.toString(),
          })
        }

        if (closeResult.producerResult?.status === `invalid_epoch_seq`) {
          return this.response(`New epoch must start with sequence 0`, 400, {
            "content-type": `text/plain`,
          })
        }

        if (closeResult.producerResult?.status === `sequence_gap`) {
          return this.response(`Producer sequence gap`, 409, {
            "content-type": `text/plain`,
            [PRODUCER_EXPECTED_SEQ_HEADER]:
              closeResult.producerResult.expectedSeq.toString(),
            [PRODUCER_RECEIVED_SEQ_HEADER]:
              closeResult.producerResult.receivedSeq.toString(),
          })
        }

        if (closeResult.producerResult?.status === `stream_closed`) {
          const stream = await this.store.get(path)
          return this.response(`Stream is closed`, 409, {
            "content-type": `text/plain`,
            [STREAM_CLOSED_HEADER]: `true`,
            [STREAM_OFFSET_HEADER]: stream?.currentOffset ?? ``,
          })
        }

        return this.response(null, 204, {
          [STREAM_OFFSET_HEADER]: closeResult.finalOffset,
          [STREAM_CLOSED_HEADER]: `true`,
          [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
          [PRODUCER_SEQ_HEADER]: producerSeq!.toString(),
        })
      }

      const closeResult = await this.store.closeStream(path)
      if (!closeResult) {
        return this.response(`Stream not found`, 404, {
          "content-type": `text/plain`,
        })
      }

      return this.response(null, 204, {
        [STREAM_OFFSET_HEADER]: closeResult.finalOffset,
        [STREAM_CLOSED_HEADER]: `true`,
      })
    }

    if (body.length === 0) {
      return this.response(`Empty body`, 400, {
        "content-type": `text/plain`,
      })
    }

    if (!contentType) {
      return this.response(`Content-Type header is required`, 400, {
        "content-type": `text/plain`,
      })
    }

    const appendOptions: AppendOptions = {
      seq,
      contentType,
      producerId,
      producerEpoch,
      producerSeq,
      close: closeStream,
    }

    let result
    if (producerId !== undefined) {
      result = await this.store.appendWithProducer(path, body, appendOptions)
    } else {
      result = await this.store.append(path, body, appendOptions)
    }

    if (typeof result === `object` && `message` in result) {
      const { message, producerResult, streamClosed } = result as {
        message: { offset: string } | null
        producerResult?: {
          status: string
          lastSeq?: number
          currentEpoch?: number
          expectedSeq?: number
          receivedSeq?: number
        }
        streamClosed?: boolean
      }

      if (streamClosed && !message) {
        if (producerResult?.status === `duplicate`) {
          const stream = await this.store.get(path)
          return this.response(null, 204, {
            [STREAM_OFFSET_HEADER]: stream?.currentOffset ?? ``,
            [STREAM_CLOSED_HEADER]: `true`,
            [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
            [PRODUCER_SEQ_HEADER]: producerResult.lastSeq!.toString(),
          })
        }

        const closedStream = await this.store.get(path)
        return this.response(`Stream is closed`, 409, {
          "content-type": `text/plain`,
          [STREAM_CLOSED_HEADER]: `true`,
          [STREAM_OFFSET_HEADER]: closedStream?.currentOffset ?? ``,
        })
      }

      if (!producerResult || producerResult.status === `accepted`) {
        const responseHeaders: Record<string, string> = {
          [STREAM_OFFSET_HEADER]: message!.offset,
        }
        if (producerEpoch !== undefined) {
          responseHeaders[PRODUCER_EPOCH_HEADER] = producerEpoch.toString()
        }
        if (producerSeq !== undefined) {
          responseHeaders[PRODUCER_SEQ_HEADER] = producerSeq.toString()
        }
        if (streamClosed) {
          responseHeaders[STREAM_CLOSED_HEADER] = `true`
        }
        const statusCode = producerId !== undefined ? 200 : 204
        return this.response(null, statusCode, responseHeaders)
      }

      switch (producerResult.status) {
        case `duplicate`: {
          const dupHeaders: Record<string, string> = {
            [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
            [PRODUCER_SEQ_HEADER]: producerResult.lastSeq!.toString(),
          }
          if (streamClosed) {
            dupHeaders[STREAM_CLOSED_HEADER] = `true`
          }
          return this.response(null, 204, dupHeaders)
        }

        case `stale_epoch`:
          return this.response(`Stale producer epoch`, 403, {
            "content-type": `text/plain`,
            [PRODUCER_EPOCH_HEADER]: producerResult.currentEpoch!.toString(),
          })

        case `invalid_epoch_seq`:
          return this.response(`New epoch must start with sequence 0`, 400, {
            "content-type": `text/plain`,
          })

        case `sequence_gap`:
          return this.response(`Producer sequence gap`, 409, {
            "content-type": `text/plain`,
            [PRODUCER_EXPECTED_SEQ_HEADER]:
              producerResult.expectedSeq!.toString(),
            [PRODUCER_RECEIVED_SEQ_HEADER]:
              producerResult.receivedSeq!.toString(),
          })
      }
    }

    const message = result as { offset: string }
    const responseHeaders: Record<string, string> = {
      [STREAM_OFFSET_HEADER]: message.offset,
    }
    if (closeStream) {
      responseHeaders[STREAM_CLOSED_HEADER] = `true`
    }
    return this.response(null, 204, responseHeaders)
  }

  // ============================================================================
  // DELETE - delete stream
  // ============================================================================

  private async handleDelete(path: string): Promise<Response> {
    const exists = await this.store.has(path)
    if (!exists) {
      return this.response(`Stream not found`, 404, {
        "content-type": `text/plain`,
      })
    }

    await this.store.delete(path)

    if (this.options.onStreamDeleted) {
      await Promise.resolve(
        this.options.onStreamDeleted({
          type: `deleted`,
          path,
          timestamp: Date.now(),
        })
      )
    }

    return this.response(null, 204)
  }

  // ============================================================================
  // Test control endpoints
  // ============================================================================

  private async handleTestInjectError(
    method: string,
    request: Request
  ): Promise<Response> {
    if (method === `POST`) {
      const body = new Uint8Array(await request.arrayBuffer())
      try {
        const config = JSON.parse(new TextDecoder().decode(body)) as {
          path: string
          status?: number
          count?: number
          retryAfter?: number
          delayMs?: number
          dropConnection?: boolean
          truncateBodyBytes?: number
          probability?: number
          method?: string
          corruptBody?: boolean
          jitterMs?: number
          injectSseEvent?: {
            eventType: string
            data: string
          }
        }

        if (!config.path) {
          return this.response(`Missing required field: path`, 400, {
            "content-type": `text/plain`,
          })
        }

        const hasFaultType =
          config.status !== undefined ||
          config.delayMs !== undefined ||
          config.dropConnection ||
          config.truncateBodyBytes !== undefined ||
          config.corruptBody ||
          config.injectSseEvent !== undefined
        if (!hasFaultType) {
          return this.response(
            `Must specify at least one fault type: status, delayMs, dropConnection, truncateBodyBytes, corruptBody, or injectSseEvent`,
            400,
            { "content-type": `text/plain` }
          )
        }

        this.injectFault(config.path, {
          status: config.status,
          count: config.count ?? 1,
          retryAfter: config.retryAfter,
          delayMs: config.delayMs,
          dropConnection: config.dropConnection,
          truncateBodyBytes: config.truncateBodyBytes,
          probability: config.probability,
          method: config.method,
          corruptBody: config.corruptBody,
          jitterMs: config.jitterMs,
          injectSseEvent: config.injectSseEvent,
        })

        return this.response(JSON.stringify({ ok: true }), 200, {
          "content-type": `application/json`,
        })
      } catch {
        return this.response(`Invalid JSON body`, 400, {
          "content-type": `text/plain`,
        })
      }
    } else if (method === `DELETE`) {
      this.clearInjectedFaults()
      return this.response(JSON.stringify({ ok: true }), 200, {
        "content-type": `application/json`,
      })
    } else {
      return this.response(`Method not allowed`, 405, {
        "content-type": `text/plain`,
      })
    }
  }
}

export function createFetchHandler(options: FetchHandlerOptions): {
  handler: DurableStreamHandler
  fetch: (request: Request) => Promise<Response>
} {
  const handler = new DurableStreamHandler(options)
  return {
    handler,
    fetch: (request: Request) => handler.fetch(request),
  }
}
