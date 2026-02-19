import { FrameDemuxer } from "./frame-demuxer"
import {
  getDefaultStorage,
  loadRequestIdMapping,
  removeRequestIdMapping,
  saveRequestIdMapping,
} from "./storage"
import type {
  DurableFetch,
  DurableFetchOptions,
  DurableResponse,
  ProxyFetchOptions,
  ProxyResponse,
} from "./types"

const DEFAULT_PREFIX = `durable-streams:`

function normalizeHeaders(
  headers: HeadersInit | undefined
): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const out: Record<string, string> = {}
    headers.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {}
    for (const [k, v] of headers) out[k] = v
    return out
  }
  return { ...headers }
}

async function readResponseFromStream(
  fetchFn: typeof fetch,
  streamUrl: string,
  responseId: number
): Promise<ProxyResponse> {
  const demuxer = new FrameDemuxer({
    onAbortResponse: async (targetResponseId) => {
      await createAbortFn(streamUrl, fetchFn, targetResponseId)()
    },
  })
  const responsePromise = demuxer.waitForResponse(responseId)

  for (let attempt = 0; attempt < 80; attempt++) {
    const readUrl = new URL(streamUrl)
    readUrl.searchParams.set(`offset`, `-1`)
    const readResponse = await fetchFn(readUrl.toString())
    if (!readResponse.ok) {
      throw new Error(`Read request failed: ${readResponse.status}`)
    }
    const bytes = new Uint8Array(await readResponse.arrayBuffer())
    demuxer.pushChunk(bytes)
    const resolved = await Promise.race([
      responsePromise.then((value) => value),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
    ])
    if (resolved) {
      return resolved
    }
    await new Promise((r) => setTimeout(r, 50))
  }

  throw new Error(`Timed out waiting for response ${responseId}`)
}

export function createDurableFetch(options: DurableFetchOptions): DurableFetch {
  const {
    proxyUrl,
    proxyAuthorization,
    storage = getDefaultStorage(),
    storagePrefix = DEFAULT_PREFIX,
    fetch: fetchFn = fetch,
  } = options
  const normalizedProxyUrl = proxyUrl.replace(/\/+$/, ``)

  return async (
    upstreamUrl: string | URL,
    requestOptions?: ProxyFetchOptions
  ): Promise<DurableResponse> => {
    const {
      method = `POST`,
      requestId,
      headers,
      body,
      signal,
    } = requestOptions ?? {}

    if (requestId) {
      const existing = loadRequestIdMapping(
        storage,
        storagePrefix,
        normalizedProxyUrl,
        requestId
      )
      if (existing?.streamUrl) {
        try {
          const resumed = (await readResponseFromStream(
            fetchFn,
            existing.streamUrl,
            existing.responseId
          )) as DurableResponse
          resumed.streamUrl = existing.streamUrl
          resumed.streamId = new URL(existing.streamUrl).pathname
            .split(`/`)
            .filter(Boolean)
            .at(-1)
          resumed.wasResumed = true
          return resumed
        } catch {
          removeRequestIdMapping(
            storage,
            storagePrefix,
            normalizedProxyUrl,
            requestId
          )
        }
      }
    }

    const url = new URL(normalizedProxyUrl)
    url.searchParams.set(`secret`, proxyAuthorization)
    const requestHeaders: Record<string, string> = {
      "Upstream-URL": String(upstreamUrl),
      "Upstream-Method": method,
      ...normalizeHeaders(headers),
    }
    const auth = requestHeaders.Authorization ?? requestHeaders.authorization
    if (auth) {
      requestHeaders[`Upstream-Authorization`] = auth
      delete requestHeaders.Authorization
      delete requestHeaders.authorization
    }

    const createResponse = await fetchFn(url.toString(), {
      method: `POST`,
      headers: requestHeaders,
      body,
      signal,
    })
    if (!createResponse.ok) {
      throw new Error(`Create request failed: ${createResponse.status}`)
    }
    const location = createResponse.headers.get(`Location`)
    const responseIdHeader = createResponse.headers.get(`Stream-Response-Id`)
    if (!location || !responseIdHeader) {
      throw new Error(`Create response missing required headers`)
    }

    const streamUrl = new URL(location, normalizedProxyUrl).toString()
    const responseId = parseInt(responseIdHeader, 10)
    if (requestId) {
      saveRequestIdMapping(
        storage,
        storagePrefix,
        normalizedProxyUrl,
        requestId,
        { responseId, streamUrl }
      )
    }
    const fresh = (await readResponseFromStream(
      fetchFn,
      streamUrl,
      responseId
    )) as DurableResponse
    fresh.streamUrl = streamUrl
    fresh.streamId = new URL(streamUrl).pathname
      .split(`/`)
      .filter(Boolean)
      .at(-1)
    fresh.wasResumed = false
    return fresh
  }
}

export function createAbortFn(
  streamUrl: string,
  fetchFn: typeof fetch = fetch,
  responseId?: number
): () => Promise<void> {
  return async () => {
    const abortUrl = new URL(streamUrl)
    abortUrl.searchParams.set(`action`, `abort`)
    if (responseId !== undefined) {
      abortUrl.searchParams.set(`response`, String(responseId))
    }
    const response = await fetchFn(abortUrl.toString(), { method: `PATCH` })
    if (!response.ok) {
      throw new Error(`Abort request failed: ${response.status}`)
    }
  }
}
