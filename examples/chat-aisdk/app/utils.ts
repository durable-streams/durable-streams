export function assertOpenAiApiKeyConfigured(): void {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(`OPENAI_API_KEY is not configured`)
  }
}

function resolveWriteBaseUrl(): string {
  const baseUrl =
    process.env.DURABLE_STREAMS_WRITE_URL ?? process.env.DURABLE_STREAMS_URL
  if (!baseUrl) {
    throw new Error(
      `DURABLE_STREAMS_WRITE_URL or DURABLE_STREAMS_URL is not configured`
    )
  }
  return baseUrl
}

function resolveReadBaseUrl(): string {
  const baseUrl =
    process.env.DURABLE_STREAMS_READ_URL ?? process.env.DURABLE_STREAMS_URL
  if (!baseUrl) {
    throw new Error(
      `DURABLE_STREAMS_READ_URL or DURABLE_STREAMS_URL is not configured`
    )
  }
  return baseUrl
}

export const DURABLE_STREAMS_WRITE_HEADERS = process.env
  .DURABLE_STREAMS_WRITE_BEARER_TOKEN
  ? {
      Authorization: `Bearer ${process.env.DURABLE_STREAMS_WRITE_BEARER_TOKEN}`,
    }
  : undefined

export const DURABLE_STREAMS_READ_HEADERS = process.env
  .DURABLE_STREAMS_READ_BEARER_TOKEN
  ? {
      Authorization: `Bearer ${process.env.DURABLE_STREAMS_READ_BEARER_TOKEN}`,
    }
  : process.env.DURABLE_STREAMS_WRITE_BEARER_TOKEN
    ? {
        Authorization: `Bearer ${process.env.DURABLE_STREAMS_WRITE_BEARER_TOKEN}`,
      }
    : undefined

function toAbsoluteBaseUrl(baseUrl: string): URL {
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(baseUrl)
    ? baseUrl
    : `http://${baseUrl}`
  return new URL(withProtocol)
}

export function buildDurableStreamUrl(
  baseUrl: string,
  streamPath: string
): string {
  return new URL(streamPath, toAbsoluteBaseUrl(baseUrl)).toString()
}

export function buildWriteStreamUrl(streamPath: string): string {
  return buildDurableStreamUrl(resolveWriteBaseUrl(), streamPath)
}

export function buildReadStreamUrl(streamPath: string): string {
  return buildDurableStreamUrl(resolveReadBaseUrl(), streamPath)
}

export function parseRequestUrl(request: Request): URL {
  const host =
    request.headers.get(`x-forwarded-host`) ?? request.headers.get(`host`)
  const proto = request.headers.get(`x-forwarded-proto`) ?? `http`
  const fallbackBase = `${proto}://${host ?? `localhost:3000`}`
  return new URL(request.url, fallbackBase)
}

export function buildReadProxyUrl(
  request: Request,
  streamPath: string
): string {
  const url = new URL(`/api/chat-stream`, parseRequestUrl(request))
  url.searchParams.set(`path`, streamPath)
  return url.toString()
}
