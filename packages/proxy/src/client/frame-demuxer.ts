import type { ProxyResponse } from "./types"

interface Frame {
  type: string
  responseId: number
  payload: Uint8Array
}

interface ResponseState {
  response: ProxyResponse
  controller: ReadableStreamDefaultController<Uint8Array>
}

interface StartPayload {
  status: number
  headers: Record<string, string>
}

interface FrameDemuxerOptions {
  onAbortResponse?: (responseId: number) => Promise<void>
}

const MAX_FRAME_BUFFER_BYTES = 4 * 1024 * 1024

class AsyncQueue<T> {
  private items: Array<T> = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ value, done: false })
    } else {
      this.items.push(value)
    }
  }

  close(): void {
    this.closed = true
    for (const resolver of this.resolvers) {
      resolver({ value: undefined, done: true })
    }
    this.resolvers = []
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift() as T, done: false }
    }
    if (this.closed) {
      return { value: undefined, done: true }
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.resolvers.push(resolve)
    })
  }
}

function decodeFrame(buffer: Uint8Array, offset: number): Frame | null {
  if (offset + 9 > buffer.length) return null
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 9)
  const type = String.fromCharCode(buffer[offset] as number)
  const responseId = view.getUint32(1, false)
  const payloadLength = view.getUint32(5, false)
  if (offset + 9 + payloadLength > buffer.length) return null
  const payload = buffer.slice(offset + 9, offset + 9 + payloadLength)
  return { type, responseId, payload }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export class FrameDemuxer {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private closed = false
  private terminalError: unknown = null
  private readonly responsesById = new Map<number, ResponseState>()
  private readonly completedById = new Map<number, ProxyResponse>()
  private readonly pendingById = new Map<
    number,
    { resolve: (r: ProxyResponse) => void; reject: (e: unknown) => void }
  >()
  private readonly queue = new AsyncQueue<ProxyResponse>()
  private readonly textDecoder = new TextDecoder()
  private readonly onAbortResponse?: (responseId: number) => Promise<void>

  constructor(options?: FrameDemuxerOptions) {
    this.onAbortResponse = options?.onAbortResponse
  }

  async consume(chunks: AsyncIterable<Uint8Array>): Promise<void> {
    for await (const chunk of chunks) {
      this.pushChunk(chunk)
    }
  }

  pushChunk(chunk: Uint8Array): void {
    if (this.buffer.length + chunk.length > MAX_FRAME_BUFFER_BYTES) {
      this.error(
        new Error(
          `Frame buffer exceeded ${MAX_FRAME_BUFFER_BYTES} bytes while parsing stream`
        )
      )
      return
    }
    this.buffer = concatBytes(this.buffer, chunk)
    let offset = 0
    for (;;) {
      const frame = decodeFrame(this.buffer, offset)
      if (!frame) break
      this.handleFrame(frame)
      offset += 9 + frame.payload.length
    }
    if (offset > 0) {
      this.buffer = this.buffer.slice(offset)
    }
  }

  waitForResponse(responseId: number): Promise<ProxyResponse> {
    if (this.terminalError !== null) {
      return Promise.reject(this.terminalError)
    }
    const existing = this.responsesById.get(responseId)
    if (existing) {
      return Promise.resolve(existing.response)
    }
    const completed = this.completedById.get(responseId)
    if (completed) {
      this.completedById.delete(responseId)
      return Promise.resolve(completed)
    }
    return new Promise<ProxyResponse>((resolve, reject) => {
      this.pendingById.set(responseId, { resolve, reject })
    })
  }

  async *responses(): AsyncIterable<ProxyResponse> {
    for (;;) {
      const next = await this.queue.next()
      if (next.done) return
      yield next.value
    }
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.terminalError === null) {
      this.terminalError = new Error(`Frame stream closed`)
    }
    for (const state of this.responsesById.values()) {
      try {
        state.controller.close()
      } catch {
        // Controller may already be closed by terminal frame.
      }
    }
    this.responsesById.clear()
    this.completedById.clear()
    for (const pending of this.pendingById.values()) {
      pending.reject(this.terminalError)
    }
    this.pendingById.clear()
    this.queue.close()
  }

  error(error: unknown): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.terminalError = error
    for (const state of this.responsesById.values()) {
      try {
        state.controller.error(error)
      } catch {
        // Controller may already be closed.
      }
    }
    for (const pending of this.pendingById.values()) {
      pending.reject(error)
    }
    this.pendingById.clear()
    this.responsesById.clear()
    this.completedById.clear()
    this.queue.close()
  }

  private handleFrame(frame: Frame): void {
    switch (frame.type) {
      case `S`: {
        const payload = JSON.parse(
          this.textDecoder.decode(frame.payload)
        ) as StartPayload
        let controllerRef!: ReadableStreamDefaultController<Uint8Array>
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller
          },
        })
        const response = new Response(body, {
          status: payload.status,
          headers: payload.headers,
        }) as ProxyResponse
        response.responseId = frame.responseId
        response.abort = async () => {
          if (!this.onAbortResponse) {
            throw new Error(`Response abort is not supported in this context`)
          }
          await this.onAbortResponse(frame.responseId)
        }
        const state: ResponseState = {
          response,
          controller: controllerRef,
        }
        this.responsesById.set(frame.responseId, state)
        this.queue.push(response)
        const pending = this.pendingById.get(frame.responseId)
        if (pending) {
          this.pendingById.delete(frame.responseId)
          pending.resolve(response)
        }
        break
      }
      case `D`: {
        const state = this.responsesById.get(frame.responseId)
        state?.controller.enqueue(frame.payload)
        break
      }
      case `C`: {
        const state = this.responsesById.get(frame.responseId)
        state?.controller.close()
        if (state?.response) {
          this.completedById.set(frame.responseId, state.response)
        }
        this.responsesById.delete(frame.responseId)
        break
      }
      case `A`: {
        const state = this.responsesById.get(frame.responseId)
        state?.controller.error(new Error(`Response aborted by server`))
        if (state?.response) {
          this.completedById.set(frame.responseId, state.response)
        }
        this.responsesById.delete(frame.responseId)
        break
      }
      case `E`: {
        const state = this.responsesById.get(frame.responseId)
        const raw = this.textDecoder.decode(frame.payload)
        let message = raw
        try {
          const payload = JSON.parse(raw) as { message?: string; code?: string }
          message = payload.message ?? payload.code ?? raw
        } catch {
          // Keep raw message.
        }
        state?.controller.error(new Error(message))
        if (state?.response) {
          this.completedById.set(frame.responseId, state.response)
        }
        this.responsesById.delete(frame.responseId)
        break
      }
      default:
        this.error(
          new Error(
            `Unknown frame type "${frame.type}" for response ${frame.responseId}`
          )
        )
    }
  }
}
