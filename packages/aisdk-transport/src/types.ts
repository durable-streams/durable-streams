import type { HeadersRecord } from "@durable-streams/client"
import type { ChatTransport, UIMessage } from "ai"

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

export type DurableChatTransportOptions = {
  api: string
  reconnectApi?: string
  headers?: HeadersInit
  fetchClient?: typeof fetch
}

export type DurableChatTransport<UIMessageT extends UIMessage = UIMessage> =
  ChatTransport<UIMessageT>
