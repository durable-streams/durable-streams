import { stream } from "@durable-streams/client"
import type { StreamResponse } from "@durable-streams/client"
import type {
  CustomChunkHandler,
  DurableSessionConnection,
  DurableStreamConnection,
  DurableStreamConnectionOptions,
  TanStackChunk,
} from "./types"

function mergeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries())
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return { ...headers }
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  const contentType = response.headers.get(`content-type`) ?? ``
  if (!contentType.includes(`application/json`)) return undefined

  try {
    return (await response.json()) as unknown
  } catch {
    return undefined
  }
}

function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url)
}

function resolveUrl(streamUrl: string, baseUrl: string): string {
  if (isAbsoluteUrl(streamUrl)) return streamUrl

  const candidateBaseUrls: Array<string> = []
  if (typeof window !== `undefined`) {
    candidateBaseUrls.push(window.location.href)
  }
  candidateBaseUrls.push(baseUrl)

  for (const candidateBaseUrl of candidateBaseUrls) {
    if (!candidateBaseUrl) continue
    try {
      return new URL(streamUrl, candidateBaseUrl).toString()
    } catch {
      // Try the next fallback.
    }
  }

  // Keep unresolved relative URLs only as a last resort (SSR construction path).
  return streamUrl
}

export function durableStreamConnection(
  options: DurableStreamConnectionOptions
): DurableStreamConnection {
  const sendUrl = options.sendUrl
  const state = {
    streamUrl: options.readUrl
      ? resolveUrl(options.readUrl, sendUrl)
      : resolveUrl(sendUrl, sendUrl),
    offset: options.initialOffset,
  }

  return {
    async *subscribe(abortSignal?: AbortSignal): AsyncIterable<TanStackChunk> {
      const streamResponse = await stream<TanStackChunk>({
        url: state.streamUrl,
        live: `sse`,
        json: true,
        offset: state.offset,
        headers: mergeHeaders(options.headers),
        signal: abortSignal,
      })

      const emitSnapshot = options.emitSnapshotOnSubscribe !== false
      const shouldEmitSnapshot = emitSnapshot && state.offset === undefined
      let hasEmittedSnapshot = !shouldEmitSnapshot
      let snapshotMessages: Array<any> = []

      for await (const batch of readJsonBatchesFromStream(
        streamResponse,
        abortSignal
      )) {
        state.offset = batch.offset
        if (abortSignal?.aborted) break

        if (!hasEmittedSnapshot) {
          snapshotMessages = applyChunksToMessages(
            snapshotMessages,
            batch.items,
            options.onCustomChunk
          )

          if (!batch.upToDate) {
            continue
          }

          hasEmittedSnapshot = true
          yield {
            type: `MESSAGES_SNAPSHOT`,
            messages: snapshotMessages,
          }
          continue
        }

        for (const chunk of batch.items) {
          if (abortSignal?.aborted) break
          yield chunk
        }
      }
    },

    async send(
      messages: Array<unknown>,
      data?: unknown,
      abortSignal?: AbortSignal
    ): Promise<void> {
      const fetchClient = options.fetchClient ?? fetch
      const response = await fetchClient(sendUrl, {
        method: `POST`,
        headers: {
          "Content-Type": `application/json`,
          ...mergeHeaders(options.headers),
        },
        body: JSON.stringify({ messages, data }),
        signal: abortSignal,
      })

      if (!response.ok) {
        const body = await parseJsonSafely(response)
        if (body && typeof body === `object` && `error` in body) {
          throw new Error(String((body as { error: unknown }).error))
        }
        throw new Error(
          `HTTP error! status: ${response.status} ${response.statusText}`
        )
      }
    },
  }
}

async function* readJsonBatchesFromStream(
  streamResponse: StreamResponse<TanStackChunk>,
  abortSignal?: AbortSignal
): AsyncIterable<{
  items: ReadonlyArray<TanStackChunk>
  offset: string
  upToDate: boolean
}> {
  const queue: Array<{
    items: ReadonlyArray<TanStackChunk>
    offset: string
    upToDate: boolean
  }> = []
  const waiters: Array<() => void> = []

  let doneState = 0
  let error: unknown

  const push = (batch: {
    items: ReadonlyArray<TanStackChunk>
    offset: string
    upToDate: boolean
  }) => {
    const waiter = waiters.shift()
    if (waiter) {
      queue.push(batch)
      waiter()
      return
    }
    queue.push(batch)
  }

  const resolveDone = () => {
    doneState = 1
    while (waiters.length > 0) {
      const waiter = waiters.shift()
      if (waiter) waiter()
    }
  }

  const unsubscribe = streamResponse.subscribeJson<TanStackChunk>((batch) => {
    push({
      items: batch.items,
      offset: batch.offset,
      upToDate: batch.upToDate,
    })
  })

  streamResponse.closed
    .then(() => resolveDone())
    .catch((streamError) => {
      error = streamError
      resolveDone()
    })

  try {
    while (!abortSignal?.aborted) {
      if (queue.length > 0) {
        const batch = queue.shift()!
        yield batch
        continue
      }

      if (doneState === 1) break

      await new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    }
  } finally {
    unsubscribe()
  }

  if (error !== undefined && !abortSignal?.aborted) {
    throw error
  }
}

function textContentFromMessage(message: any): string {
  if (!message || typeof message !== `object`) return ``
  if (!Array.isArray(message.parts)) return ``
  return message.parts
    .filter((part: any) => part?.type === `text`)
    .map((part: any) =>
      typeof part?.content === `string`
        ? part.content
        : typeof part?.text === `string`
          ? part.text
          : ``
    )
    .join(``)
}

function findLastTextPartIndex(parts: Array<any>): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === `text`) {
      return index
    }
  }
  return -1
}

function applyChunksToMessages(
  currentMessages: Array<any>,
  chunks: ReadonlyArray<TanStackChunk>,
  onCustomChunk?: CustomChunkHandler
): Array<any> {
  let messages = [...currentMessages]

  const getOrCreateMessage = (messageId: string, role: string) => {
    const index = messages.findIndex((message) => message?.id === messageId)
    if (index >= 0) {
      return index
    }
    messages = [
      ...messages,
      {
        id: messageId,
        role: role === `tool` ? `assistant` : role,
        parts: [],
      },
    ]
    return messages.length - 1
  }

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== `object` || typeof chunk.type !== `string`) {
      continue
    }

    if (chunk.type === `MESSAGES_SNAPSHOT`) {
      const snapshotMessages = (chunk as { messages?: Array<any> }).messages
      messages = Array.isArray(snapshotMessages)
        ? snapshotMessages.map((message) => ({
            ...message,
            parts: Array.isArray(message?.parts) ? [...message.parts] : [],
          }))
        : []
      continue
    }

    if (chunk.type === `TEXT_MESSAGE_START`) {
      const messageId = (chunk as { messageId?: unknown }).messageId
      const role = (chunk as { role?: unknown }).role
      if (typeof messageId !== `string` || typeof role !== `string`) continue
      getOrCreateMessage(messageId, role)
      continue
    }

    if (chunk.type === `TEXT_MESSAGE_CONTENT`) {
      const messageId = (chunk as { messageId?: unknown }).messageId
      if (typeof messageId !== `string`) continue
      const index = getOrCreateMessage(messageId, `assistant`)
      const message = messages[index]
      const parts = Array.isArray(message.parts) ? [...message.parts] : []
      const previousText = textContentFromMessage(message)
      const delta =
        typeof (chunk as { delta?: unknown }).delta === `string`
          ? (chunk as { delta: string }).delta
          : typeof (chunk as { content?: unknown }).content === `string`
            ? (chunk as { content: string }).content
            : ``
      const nextText = previousText + delta
      const textPartIndex = findLastTextPartIndex(parts)
      if (textPartIndex >= 0) {
        parts[textPartIndex] = { ...parts[textPartIndex], content: nextText }
      } else {
        parts.push({ type: `text`, content: nextText })
      }
      messages[index] = {
        ...message,
        parts,
      }
      continue
    }

    if (chunk.type === `CUSTOM` && onCustomChunk) {
      const result = onCustomChunk(chunk, messages)
      if (result) {
        messages = result
      }
      continue
    }
  }

  return messages
}

export function sanitizeChunkForStorage<TChunk extends TanStackChunk>(
  chunk: TChunk
): TChunk {
  if (
    chunk &&
    typeof chunk === `object` &&
    (chunk as { type?: string }).type === `TEXT_MESSAGE_CONTENT`
  ) {
    const nextChunk = { ...(chunk as Record<string, unknown>) }
    delete nextChunk.content
    return nextChunk as TChunk
  }
  return chunk
}

export async function materializeSnapshotFromDurableStream(options: {
  readUrl: string
  headers?: HeadersInit
  offset?: string
  onCustomChunk?: CustomChunkHandler
}): Promise<{ messages: Array<any>; offset?: string }> {
  const streamResponse = await stream<TanStackChunk>({
    url: options.readUrl,
    json: true,
    live: false,
    offset: options.offset,
    headers: mergeHeaders(options.headers),
  })
  const chunks = await streamResponse.json<TanStackChunk>()
  return {
    messages: applyChunksToMessages([], chunks, options.onCustomChunk),
    offset: streamResponse.offset,
  }
}

export type { DurableSessionConnection }
