import { getRuntime } from "../runtime.js"

export interface CreateProxyResult {
  status: number
  headers: Headers
  body: unknown
  streamUrl?: string
  streamId?: string
}

export async function createProxyStream(input: {
  upstreamUrl: string
  method?: string
  body?: unknown
  headers?: Record<string, string>
  streamId?: string
  action?: string
}): Promise<CreateProxyResult> {
  const runtime = getRuntime()
  const baseUrl = runtime.getBaseUrl()
  const headers = new Headers(input.headers ?? {})
  // Mirror existing proxy test-client behavior.
  if (headers.has(`Authorization`) && !headers.has(`Upstream-Authorization`)) {
    headers.set(`Upstream-Authorization`, headers.get(`Authorization`)!)
    headers.delete(`Authorization`)
  }
  headers.set(`Upstream-URL`, input.upstreamUrl)
  headers.set(`Upstream-Method`, input.method ?? `POST`)
  if (input.body !== undefined && !headers.has(`Content-Type`)) {
    headers.set(`Content-Type`, `application/json`)
  }

  const url =
    input.streamId !== undefined
      ? runtime.adapter.streamUrl(baseUrl, input.streamId)
      : runtime.adapter.createUrl(baseUrl)
  if (input.action) {
    url.searchParams.set(`action`, input.action)
  }
  await runtime.adapter.applyServiceAuth(url, headers)

  const response = await fetch(url.toString(), {
    method: `POST`,
    headers,
    body:
      input.body === undefined
        ? undefined
        : typeof input.body === `string`
          ? input.body
          : JSON.stringify(input.body),
  })
  const body = await parseResponseBody(response)
  const streamUrl = readLocation(response.headers)
    ? runtime.adapter.normalizeLocation(
        readLocation(response.headers)!,
        baseUrl
      )
    : undefined
  const streamId = streamUrl
    ? decodeURIComponent(new URL(streamUrl).pathname.split(`/`).at(-1) ?? ``)
    : undefined
  return {
    status: response.status,
    headers: response.headers,
    body,
    streamUrl,
    streamId,
  }
}

export async function connectProxyStream(input: {
  streamId: string
  upstreamUrl?: string
  headers?: Record<string, string>
  body?: unknown
}): Promise<Response> {
  const runtime = getRuntime()
  const baseUrl = runtime.getBaseUrl()
  const headers = new Headers(input.headers ?? {})
  if (input.upstreamUrl) {
    headers.set(`Upstream-URL`, input.upstreamUrl)
  }
  const url = runtime.adapter.connectUrl(baseUrl, input.streamId)
  await runtime.adapter.applyServiceAuth(url, headers)
  return fetch(url.toString(), {
    method: `POST`,
    headers,
    body:
      input.body === undefined
        ? undefined
        : typeof input.body === `string`
          ? input.body
          : JSON.stringify(input.body),
  })
}

export async function readProxyStream(input: {
  streamUrl: string
  offset?: string
  live?: `sse` | `long-poll`
  accept?: string
}): Promise<Response> {
  const url = new URL(input.streamUrl)
  if (input.offset) {
    url.searchParams.set(`offset`, input.offset)
  }
  if (input.live) {
    url.searchParams.set(`live`, input.live)
  }
  return fetch(url.toString(), {
    method: `GET`,
    headers: input.accept ? { Accept: input.accept } : undefined,
  })
}

export async function abortProxyStream(input: {
  streamUrl: string
  responseId?: string
}): Promise<Response> {
  const url = new URL(input.streamUrl)
  url.searchParams.set(`action`, `abort`)
  if (input.responseId) {
    url.searchParams.set(`response`, input.responseId)
  }
  return fetch(url.toString(), { method: `PATCH` })
}

export async function headProxyStream(streamId: string): Promise<Response> {
  const runtime = getRuntime()
  const headers = new Headers()
  const url = runtime.adapter.streamUrl(runtime.getBaseUrl(), streamId)
  await runtime.adapter.applyServiceAuth(url, headers)
  return fetch(url.toString(), { method: `HEAD`, headers })
}

export async function deleteProxyStream(streamId: string): Promise<Response> {
  const runtime = getRuntime()
  const headers = new Headers()
  const url = runtime.adapter.streamUrl(runtime.getBaseUrl(), streamId)
  await runtime.adapter.applyServiceAuth(url, headers)
  return fetch(url.toString(), { method: `DELETE`, headers })
}

export async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timeout waiting for condition`)
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null
  const contentType = response.headers.get(`content-type`) ?? ``
  if (contentType.includes(`application/json`)) {
    return response.json()
  }
  return response.text()
}

function readLocation(headers: Headers): string | null {
  return headers.get(`Location`) ?? headers.get(`location`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
