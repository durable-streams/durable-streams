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
  sendUrl: string
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

export type DurableChatSessionStreamTarget = Pick<
  DurableStreamTarget,
  `writeUrl` | `headers` | `createIfMissing`
>

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

export type ForkPointOptions =
  | boolean
  | {
      enabled?: boolean
      markerName?: string
    }

export type ToDurableChatSessionResponseOptions = {
  stream: DurableChatSessionStreamTarget
  newMessages: Array<DurableSessionMessage>
  responseStream: AsyncIterable<TanStackChunk>
  mode?: ToDurableStreamResponseMode
  waitUntil?: WaitUntil
  includeForkPoints?: ForkPointOptions
}

export type DurableMessageMetadata = {
  endOffset?: string
  forkPoint?: boolean
  inheritedForkPoint?: boolean
  sourceStreamPath?: string
}

export type DurableMessageOffsetMarkerValue = {
  version: 1
  messageId: string
  endOffset: string
  inherited?: boolean
  sourceStreamPath?: string
}

export type DurableMessageOffsetMarker = {
  type: `CUSTOM`
  timestamp: number
  name: string
  value: DurableMessageOffsetMarkerValue
}

export const DEFAULT_FORK_POINT_MARKER_NAME = `durable-message-offset`
