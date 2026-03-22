import { stream } from "@durable-streams/client"
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai"
import type { DurableChatTransportOptions } from "./types"

function mergeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

function parseBodyStreamUrl(body: unknown): string | undefined {
  if (body && typeof body === `object` && `streamUrl` in body) {
    const streamUrl = (body as { streamUrl?: unknown }).streamUrl
    if (typeof streamUrl === `string` && streamUrl.length > 0) {
      return streamUrl
    }
  }
  return undefined
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  const contentType = response.headers.get(`content-type`) ?? ``
  if (!contentType.includes(`application/json`)) return undefined
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url)
}

function resolveStreamUrl(
  streamUrl: string,
  responseUrl: string,
  postUrl: string
): string {
  if (isAbsoluteUrl(streamUrl)) return streamUrl

  const candidateBaseUrls = [responseUrl, postUrl]
  if (typeof window !== `undefined`) {
    candidateBaseUrls.push(window.location.href)
  }

  for (const baseUrl of candidateBaseUrls) {
    if (!baseUrl) continue
    try {
      return new URL(streamUrl, baseUrl).toString()
    } catch {
      // Try the next fallback.
    }
  }

  throw new Error(
    `Failed to resolve durable stream URL from relative path "${streamUrl}".`
  )
}

function toReadableStream<T>(iterable: AsyncIterable<T>): ReadableStream<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  return new ReadableStream<T>({
    async pull(controller) {
      const result = await iterator.next()
      if (result.done) {
        controller.close()
        return
      }
      controller.enqueue(result.value)
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

async function readUiMessageChunksFromDurableStream(
  streamUrl: string,
  abortSignal?: AbortSignal
): Promise<ReadableStream<UIMessageChunk>> {
  const streamResponse = await stream<UIMessageChunk>({
    url: streamUrl,
    live: `sse`,
    json: true,
    signal: abortSignal,
  })

  return toReadableStream(streamResponse.jsonStream())
}

export function createDurableChatTransport<
  UIMessageT extends UIMessage = UIMessage,
>({
  api,
  reconnectApi,
  headers,
  fetchClient,
}: DurableChatTransportOptions): ChatTransport<UIMessageT> {
  return {
    async sendMessages({
      trigger,
      chatId,
      messageId,
      messages,
      abortSignal,
      body,
      headers: requestHeaders,
    }) {
      const response = await (fetchClient ?? fetch)(api, {
        method: `POST`,
        headers: {
          "Content-Type": `application/json`,
          ...mergeHeaders(headers),
          ...mergeHeaders(requestHeaders),
        },
        body: JSON.stringify({
          ...(body ?? {}),
          id: chatId,
          messages,
          trigger,
          messageId,
        }),
        signal: abortSignal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          errorText.length > 0
            ? errorText
            : `HTTP error! status: ${response.status} ${response.statusText}`
        )
      }

      const headerUrl = response.headers.get(`Location`)
      if (headerUrl) {
        // Prefer Location so the client can attach to the stream immediately.
        return readUiMessageChunksFromDurableStream(
          resolveStreamUrl(headerUrl, response.url, api),
          abortSignal
        )
      }

      const streamUrl = parseBodyStreamUrl(await parseJsonSafely(response))
      if (!streamUrl) {
        throw new Error(
          `Missing durable stream URL. Expected Location header or JSON body with streamUrl.`
        )
      }

      return readUiMessageChunksFromDurableStream(
        resolveStreamUrl(streamUrl, response.url, api),
        abortSignal
      )
    },

    async reconnectToStream({ chatId, body: _body, headers: requestHeaders }) {
      const endpoint =
        reconnectApi ?? `${api.replace(/\/$/, ``)}/${chatId}/stream`
      const response = await (fetchClient ?? fetch)(endpoint, {
        method: `GET`,
        headers: {
          ...mergeHeaders(headers),
          ...mergeHeaders(requestHeaders),
        },
      })

      if (response.status === 204) return null
      // 204 means there is no in-flight generation to resume.

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          errorText.length > 0
            ? errorText
            : `HTTP error! status: ${response.status} ${response.statusText}`
        )
      }

      const streamUrl =
        response.headers.get(`Location`) ??
        parseBodyStreamUrl(await parseJsonSafely(response))

      if (!streamUrl) {
        throw new Error(
          `Missing durable stream URL. Expected Location header or JSON body with streamUrl.`
        )
      }

      return readUiMessageChunksFromDurableStream(
        resolveStreamUrl(streamUrl, response.url, endpoint)
      )
    },
  }
}
