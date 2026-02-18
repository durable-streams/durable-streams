import {
  getDefaultStorage,
  loadRequestIdMapping,
  saveRequestIdMapping,
} from "./storage"
import { FrameDemuxer } from "./frame-demuxer"
import type {
  DurableProxySession,
  ProxyFetchOptions,
  ProxyResponse,
  ProxySessionOptions,
} from "./types"

const DEFAULT_PREFIX = `durable-streams:`

interface RenewableErrorResponse {
  error?: {
    code?: string
    streamId?: string
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRenewableReadError(error: unknown, streamId: string): boolean {
  if (!(error instanceof Error)) return false
  const err = error as Error & {
    status?: number
    details?: RenewableErrorResponse
  }
  if (err.status !== 401) return false
  const readError = err.details?.error
  return (
    readError?.code === `SIGNATURE_EXPIRED` && readError.streamId === streamId
  )
}

async function errorFromResponse(response: Response): Promise<Error> {
  const error = new Error(
    `Read request failed: ${response.status}`
  ) as Error & {
    status?: number
    details?: RenewableErrorResponse
  }
  error.status = response.status
  try {
    error.details = (await response.json()) as RenewableErrorResponse
  } catch {
    // Ignore JSON parse failures.
  }
  return error
}

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

async function waitForResponseWithSignal(
  demuxer: FrameDemuxer,
  responseId: number,
  signal: AbortSignal | null | undefined
): Promise<ProxyResponse> {
  if (!signal) {
    return demuxer.waitForResponse(responseId)
  }
  if (signal.aborted) {
    throw new DOMException(`The operation was aborted`, `AbortError`)
  }

  return new Promise<ProxyResponse>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException(`The operation was aborted`, `AbortError`))
    }
    signal.addEventListener(`abort`, onAbort, { once: true })
    demuxer
      .waitForResponse(responseId)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener(`abort`, onAbort)
      })
  })
}

export function createDurableSession(
  options: ProxySessionOptions
): DurableProxySession {
  const {
    proxyUrl,
    proxyAuthorization,
    streamId,
    connectUrl,
    streamSignedUrlTtl,
    storage = getDefaultStorage(),
    storagePrefix = DEFAULT_PREFIX,
    fetch: fetchFn = fetch,
  } = options

  const normalizedProxyUrl = proxyUrl.replace(/\/+$/, ``)
  const demuxer = new FrameDemuxer()

  const state = {
    streamUrl: null as string | null,
    streamId,
    closed: false,
    readerTask: null as Promise<void> | null,
    connectTask: null as Promise<void> | null,
  }

  function parseStreamIdFromLocation(location: string): string {
    const url = new URL(location, normalizedProxyUrl)
    const parts = url.pathname.split(`/`).filter(Boolean)
    const parsedStreamId = parts.at(-1)
    if (!parsedStreamId) {
      throw new Error(`Unable to extract stream ID from location`)
    }
    return decodeURIComponent(parsedStreamId)
  }

  async function connect(): Promise<void> {
    if (state.connectTask) {
      await state.connectTask
      return
    }

    state.connectTask = (async () => {
      const url = new URL(normalizedProxyUrl)
      url.pathname = `${url.pathname.replace(/\/+$/, ``)}/${encodeURIComponent(streamId)}`
      url.searchParams.set(`secret`, proxyAuthorization)
      url.searchParams.set(`action`, `connect`)
      const headers: Record<string, string> = {}
      if (connectUrl) {
        headers[`Upstream-URL`] = connectUrl
      }
      if (streamSignedUrlTtl !== undefined) {
        headers[`Stream-Signed-URL-TTL`] = String(streamSignedUrlTtl)
      }

      const response = await fetchFn(url.toString(), {
        method: `POST`,
        headers,
      })
      if (!response.ok) {
        throw new Error(`Session connect failed: ${response.status}`)
      }

      const location = response.headers.get(`Location`)
      if (!location) {
        throw new Error(`Connect response missing Location`)
      }

      state.streamUrl = new URL(location, normalizedProxyUrl).toString()
      state.streamId = parseStreamIdFromLocation(location)
    })()

    try {
      await state.connectTask
      ensureReader()
    } finally {
      state.connectTask = null
    }
  }

  function ensureReader(): void {
    if (state.readerTask || !state.streamUrl || state.closed) {
      return
    }

    state.readerTask = (async () => {
      let offset = `-1`
      while (!state.closed && state.streamUrl) {
        try {
          const readUrl = new URL(state.streamUrl)
          readUrl.searchParams.set(`offset`, offset)
          readUrl.searchParams.set(`live`, `long-poll`)

          const response = await fetchFn(readUrl.toString())
          if (!response.ok) {
            throw await errorFromResponse(response)
          }

          const nextOffset = response.headers.get(`Stream-Next-Offset`)
          if (nextOffset) {
            offset = nextOffset
          }

          const bytes = new Uint8Array(await response.arrayBuffer())
          if (bytes.length > 0) {
            demuxer.pushChunk(bytes)
          }

          if (response.headers.get(`Stream-Up-To-Date`) === `true`) {
            await delay(75)
          }
        } catch (error) {
          if (isRenewableReadError(error, state.streamId)) {
            await connect()
            continue
          }
          demuxer.error(error)
          break
        }
      }
    })().finally(() => {
      state.readerTask = null
    })
  }

  async function fetchThroughSession(
    upstreamUrl: string | URL,
    requestOptions?: ProxyFetchOptions
  ): Promise<ProxyResponse> {
    await connect()

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
        requestId,
        streamId
      )
      if (existing) {
        ensureReader()
        return waitForResponseWithSignal(demuxer, existing.responseId, signal)
      }
    }

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
    if (streamSignedUrlTtl !== undefined) {
      requestHeaders[`Stream-Signed-URL-TTL`] = String(streamSignedUrlTtl)
    }

    const url = new URL(normalizedProxyUrl)
    url.pathname = `${url.pathname.replace(/\/+$/, ``)}/${encodeURIComponent(streamId)}`
    url.searchParams.set(`secret`, proxyAuthorization)
    const response = await fetchFn(url.toString(), {
      method: `POST`,
      headers: requestHeaders,
      body,
      signal,
    })
    if (!response.ok) {
      throw new Error(`Session append failed: ${response.status}`)
    }

    const responseIdHeader = response.headers.get(`Stream-Response-Id`)
    if (!responseIdHeader) {
      throw new Error(`Append response missing Stream-Response-Id`)
    }
    const responseId = parseInt(responseIdHeader, 10)

    const location = response.headers.get(`Location`)
    if (location) {
      state.streamUrl = new URL(location, normalizedProxyUrl).toString()
      state.streamId = parseStreamIdFromLocation(location)
    }

    if (requestId) {
      saveRequestIdMapping(
        storage,
        storagePrefix,
        normalizedProxyUrl,
        requestId,
        { responseId },
        streamId
      )
    }

    ensureReader()
    return waitForResponseWithSignal(demuxer, responseId, signal)
  }

  async function abort(): Promise<void> {
    if (!state.streamUrl) return
    const url = new URL(state.streamUrl)
    url.searchParams.set(`action`, `abort`)
    const response = await fetchFn(url.toString(), { method: `PATCH` })
    if (!response.ok) {
      throw new Error(`Abort failed: ${response.status}`)
    }
  }

  async function* responses(): AsyncIterable<ProxyResponse> {
    await connect()
    ensureReader()
    for await (const response of demuxer.responses()) {
      yield response
    }
  }

  function close(): void {
    state.closed = true
    demuxer.close()
  }

  return {
    get streamUrl() {
      return state.streamUrl
    },
    get streamId() {
      return state.streamId
    },
    fetch: fetchThroughSession,
    responses,
    connect,
    abort,
    close,
  }
}
