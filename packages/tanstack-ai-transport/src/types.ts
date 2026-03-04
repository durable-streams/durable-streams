import type { HeadersRecord } from "@durable-streams/client"

export type TanStackChunk = any

export type DurableSessionConnection = {
  subscribe: (abortSignal?: AbortSignal) => AsyncIterable<TanStackChunk>
  send: (
    messages: Array<unknown>,
    data?: unknown,
    abortSignal?: AbortSignal
  ) => Promise<void>
}

export type DurableStreamConnection = DurableSessionConnection

export type DurableStreamConnectionOptions = {
  postUrl: string
  readUrl?: string
  initialOffset?: string
  emitSnapshotOnSubscribe?: boolean
  headers?: HeadersInit
  fetchClient?: typeof fetch
}

export type DurableStreamTarget = {
  writeUrl: string | URL
  readUrl?: string | URL
  headers?: HeadersRecord
  contentType?: string
  createIfMissing?: boolean
}

export type ToDurableStreamResponseMode = `immediate` | `await`

export type WaitUntil = (promise: Promise<unknown>) => void

export type ToDurableStreamResponseOptions = {
  stream: DurableStreamTarget
  mode?: ToDurableStreamResponseMode
  waitUntil?: WaitUntil
  exposeLocationHeader?: boolean
}

export type DurableSessionMessagePart = {
  type?: string
  content?: string
  text?: string
}

export type DurableSessionMessage = {
  id?: string
  role?: string
  parts?: Array<DurableSessionMessagePart>
}

export type ToDurableChatSessionResponseOptions = {
  stream: DurableStreamTarget
  newMessages: Array<DurableSessionMessage>
  responseStream: AsyncIterable<TanStackChunk>
  mode?: ToDurableStreamResponseMode
  waitUntil?: WaitUntil
  exposeLocationHeader?: boolean
}
