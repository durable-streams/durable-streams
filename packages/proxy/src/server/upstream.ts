/**
 * Upstream connection management and framed body piping.
 */

import { randomUUID } from "node:crypto"
import type { UpstreamConnection } from "./types"

const FRAME_HEADER_SIZE = 9

const FRAME_TYPE = {
  START: 0x53, // S
  DATA: 0x44, // D
  COMPLETE: 0x43, // C
  ABORT: 0x41, // A
  ERROR: 0x45, // E
} as const

const activeConnections = new Map<string, Map<string, UpstreamConnection>>()
const streamResponseCounters = new Map<string, number>()
const responseIdLocks = new Map<string, Promise<void>>()

export interface StartFramePayload {
  status: number
  headers: Record<string, string>
}

export interface ErrorFramePayload {
  code: string
  message: string
}

async function withStreamLock<T>(
  streamId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = responseIdLocks.get(streamId) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  responseIdLocks.set(
    streamId,
    prev.then(() => current)
  )

  await prev
  try {
    return await fn()
  } finally {
    release()
    if (responseIdLocks.get(streamId) === current) {
      responseIdLocks.delete(streamId)
    }
  }
}

async function bootstrapResponseCounter(
  durableStreamsUrl: string,
  streamId: string
): Promise<number> {
  const url = new URL(`/v1/streams/${streamId}`, durableStreamsUrl)
  url.searchParams.set(`offset`, `-1`)

  const response = await fetch(url.toString(), { method: `GET` })
  if (!response.ok) {
    return 0
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  let maxResponseId = 0
  let offset = 0

  while (offset + FRAME_HEADER_SIZE <= bytes.length) {
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      FRAME_HEADER_SIZE
    )
    const responseId = view.getUint32(1, false)
    const payloadLength = view.getUint32(5, false)
    if (offset + FRAME_HEADER_SIZE + payloadLength > bytes.length) {
      break
    }
    if (responseId > maxResponseId) {
      maxResponseId = responseId
    }
    offset += FRAME_HEADER_SIZE + payloadLength
  }

  return maxResponseId
}

export async function nextResponseId(
  durableStreamsUrl: string,
  streamId: string
): Promise<number> {
  return withStreamLock(streamId, async () => {
    if (!streamResponseCounters.has(streamId)) {
      try {
        const previousMax = await bootstrapResponseCounter(
          durableStreamsUrl,
          streamId
        )
        streamResponseCounters.set(streamId, previousMax)
      } catch {
        streamResponseCounters.set(streamId, 0)
      }
    }

    const next = (streamResponseCounters.get(streamId) ?? 0) + 1
    streamResponseCounters.set(streamId, next)
    return next
  })
}

export function clearStreamState(streamId: string): void {
  streamResponseCounters.delete(streamId)
  activeConnections.delete(streamId)
}

export function registerConnection(connection: UpstreamConnection): void {
  let streamConnections = activeConnections.get(connection.streamId)
  if (!streamConnections) {
    streamConnections = new Map<string, UpstreamConnection>()
    activeConnections.set(connection.streamId, streamConnections)
  }
  streamConnections.set(connection.connectionId, connection)
}

export function unregisterConnection(
  streamId: string,
  connectionId: string
): void {
  const streamConnections = activeConnections.get(streamId)
  if (!streamConnections) return
  streamConnections.delete(connectionId)
  if (streamConnections.size === 0) {
    activeConnections.delete(streamId)
  }
}

export function abortConnections(streamId: string): void {
  const streamConnections = activeConnections.get(streamId)
  if (!streamConnections) return

  for (const connection of streamConnections.values()) {
    connection.abortController.abort()
  }
}

export function abortConnectionByResponseId(
  streamId: string,
  responseId: number
): void {
  const streamConnections = activeConnections.get(streamId)
  if (!streamConnections) return
  for (const connection of streamConnections.values()) {
    if (connection.responseId === responseId) {
      connection.abortController.abort()
    }
  }
}

export function createConnection(
  streamId: string,
  responseId: number,
  abortController?: AbortController
): UpstreamConnection {
  return {
    connectionId: randomUUID(),
    abortController: abortController ?? new AbortController(),
    streamId,
    responseId,
    startedAt: Date.now(),
  }
}

function concatUint8Arrays(arrays: Array<Uint8Array>): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

function toUtf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function buildFrame(
  type: number,
  responseId: number,
  payload?: Uint8Array
): Uint8Array {
  const data = payload ?? new Uint8Array(0)
  const frame = new Uint8Array(FRAME_HEADER_SIZE + data.length)
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  frame[0] = type
  view.setUint32(1, responseId, false)
  view.setUint32(5, data.length, false)
  if (data.length > 0) {
    frame.set(data, FRAME_HEADER_SIZE)
  }
  return frame
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

async function postFrame(
  durableStreamsUrl: string,
  streamId: string,
  frame: Uint8Array
): Promise<void> {
  const url = new URL(`/v1/streams/${streamId}`, durableStreamsUrl)
  const response = await fetch(url.toString(), {
    method: `POST`,
    headers: { "Content-Type": `application/octet-stream` },
    body: frame as unknown as BodyInit,
  })
  if (!response.ok) {
    throw new Error(
      `Failed to write frame to stream ${streamId}: ${response.status}`
    )
  }
}

export interface PipeUpstreamOptions {
  durableStreamsUrl: string
  streamId: string
  responseId: number
  signal: AbortSignal
  upstreamStatus: number
  upstreamHeaders: Headers
  batchSizeThreshold?: number
  batchTimeThreshold?: number
  inactivityTimeout?: number
}

export async function pipeUpstreamBody(
  body: ReadableStream<Uint8Array> | null,
  options: PipeUpstreamOptions
): Promise<void> {
  const {
    durableStreamsUrl,
    streamId,
    responseId,
    signal,
    upstreamStatus,
    upstreamHeaders,
    batchSizeThreshold = 4096,
    batchTimeThreshold = 50,
    inactivityTimeout = 600000,
  } = options

  const startPayload = toUtf8Bytes(
    JSON.stringify({
      status: upstreamStatus,
      headers: normalizeHeaders(upstreamHeaders),
    } satisfies StartFramePayload)
  )
  await postFrame(
    durableStreamsUrl,
    streamId,
    buildFrame(FRAME_TYPE.START, responseId, startPayload)
  )

  if (!body) {
    await postFrame(
      durableStreamsUrl,
      streamId,
      buildFrame(FRAME_TYPE.COMPLETE, responseId)
    )
    return
  }

  let terminalWritten = false
  const reader = body.getReader()
  let buffer: Array<Uint8Array> = []
  let bufferSize = 0
  let batchStartTime: number | null = null
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null
  let terminalReason = `complete`

  const writeTerminalFrame = async (
    type: number,
    payload?: Uint8Array
  ): Promise<void> => {
    if (terminalWritten) return
    terminalWritten = true
    await postFrame(
      durableStreamsUrl,
      streamId,
      buildFrame(type, responseId, payload)
    )
  }

  const clearInactivityTimer = () => {
    if (!inactivityTimer) return
    clearTimeout(inactivityTimer)
    inactivityTimer = null
  }

  const resetInactivityTimer = () => {
    clearInactivityTimer()
    inactivityTimer = setTimeout(() => {
      terminalReason = `timeout`
      reader.cancel(`Inactivity timeout`).catch(() => {
        // Ignore cancellation errors.
      })
    }, inactivityTimeout)
  }

  const flushData = async (): Promise<void> => {
    if (bufferSize === 0) return
    const payload = concatUint8Arrays(buffer)
    buffer = []
    bufferSize = 0
    batchStartTime = null
    await postFrame(
      durableStreamsUrl,
      streamId,
      buildFrame(FRAME_TYPE.DATA, responseId, payload)
    )
  }

  try {
    resetInactivityTimer()

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        clearInactivityTimer()
        await flushData()
        if (signal.aborted) {
          terminalReason = `abort`
        }
        if (terminalReason === `abort`) {
          await writeTerminalFrame(FRAME_TYPE.ABORT)
        } else if (terminalReason === `timeout`) {
          await writeTerminalFrame(
            FRAME_TYPE.ERROR,
            toUtf8Bytes(
              JSON.stringify({
                code: `INACTIVITY_TIMEOUT`,
                message: `Upstream response timed out due to inactivity`,
              } satisfies ErrorFramePayload)
            )
          )
        } else {
          await writeTerminalFrame(FRAME_TYPE.COMPLETE)
        }
        break
      }

      if (signal.aborted) {
        clearInactivityTimer()
        await flushData()
        terminalReason = `abort`
        await writeTerminalFrame(FRAME_TYPE.ABORT)
        break
      }

      if (terminalReason === `timeout`) {
        clearInactivityTimer()
        await flushData()
        await writeTerminalFrame(
          FRAME_TYPE.ERROR,
          toUtf8Bytes(
            JSON.stringify({
              code: `INACTIVITY_TIMEOUT`,
              message: `Upstream response timed out due to inactivity`,
            } satisfies ErrorFramePayload)
          )
        )
        break
      }

      buffer.push(value)
      bufferSize += value.length
      if (!batchStartTime) {
        batchStartTime = Date.now()
      }
      resetInactivityTimer()

      if (
        bufferSize >= batchSizeThreshold ||
        Date.now() - batchStartTime >= batchTimeThreshold
      ) {
        await flushData()
      }
    }
  } catch (error) {
    clearInactivityTimer()
    try {
      await flushData()
    } catch {
      // Ignore flush errors while handling error terminal frame.
    }
    try {
      if (!signal.aborted) {
        await writeTerminalFrame(
          FRAME_TYPE.ERROR,
          toUtf8Bytes(
            JSON.stringify({
              code: `UPSTREAM_PIPE_ERROR`,
              message: error instanceof Error ? error.message : `Unknown error`,
            } satisfies ErrorFramePayload)
          )
        )
      } else {
        await writeTerminalFrame(FRAME_TYPE.ABORT)
      }
    } catch {
      // Best-effort terminal frame.
    }
    throw error
  } finally {
    clearInactivityTimer()
    reader.releaseLock()
  }
}
